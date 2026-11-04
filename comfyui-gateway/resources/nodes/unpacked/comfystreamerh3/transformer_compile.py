"""Opt-in FastH3 transformer compilation probe for matched benchmarks."""

from __future__ import annotations

import importlib
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_KITCHEN_PATCH_LOCK = threading.RLock()
_MODULATION_TARGET: ContextVar[Any] = ContextVar("fasth3_modulation_target", default=None)


def disabled_transformer_compile_report(*, include_allocator_policy: bool = False) -> dict[str, object]:
    """Return the shared zero-execution compile receipt for opt-out profiles."""
    report: dict[str, object] = {
        "enabled": False,
        "scope": "diffusion_model.forward",
        "backend": "inductor",
        "mode": "default",
        "fullgraph": False,
        "compile_is_lazy": True,
    }
    if include_allocator_policy:
        report["comfy_allocator_graph_suppressed"] = False
    return report


def _prepare_modulation(transformer, torch_module, graphs):
    core = getattr(transformer, "_sol_core_forward", transformer._forward)
    owner = getattr(getattr(core, "__func__", core), "__globals__", {})
    original = owner.get("_mod_scale_shift")
    if not callable(original):
        raise TypeError("modulation compilation requires the native H3 math module")
    inductor = torch_module._dynamo.lookup_backend("inductor")

    def backend(graph, inputs, **kwargs):
        graphs.append({"region": "modulation", "operators": [str(node.target)
                       for node in graph.graph.nodes if node.op.startswith("call_")]})
        return inductor(graph, inputs, config_patches=kwargs.get("options", {}))

    compiled = torch_module.compile(original, backend=backend, fullgraph=False,
                                    options={"emulate_precision_casts": True})

    def dispatch(*args, **kwargs):
        target = _MODULATION_TARGET.get()
        return (original if target is None else target)(*args, **kwargs)

    return owner, original, dispatch, compiled


@contextmanager
def _modulation_region(patch):
    if patch is None:
        yield
        return
    owner, _original, dispatch, compiled = patch
    with _KITCHEN_PATCH_LOCK:
        previous = owner["_mod_scale_shift"]
        owner["_mod_scale_shift"] = dispatch
        token = _MODULATION_TARGET.set(compiled)
        try:
            yield
        finally:
            _MODULATION_TARGET.reset(token)
            owner["_mod_scale_shift"] = previous


@contextmanager
def _comfy_allocator_graph_disabled():
    """Avoid nesting AIMDO's allocator graph inside a Dynamo-compiled forward."""
    import comfy.cli_args

    args = comfy.cli_args.args
    if not hasattr(args, "disable_comfy_compiler"):
        raise TypeError("Comfy CLI args do not expose disable_comfy_compiler")
    with _KITCHEN_PATCH_LOCK:
        previous = args.disable_comfy_compiler
        args.disable_comfy_compiler = True
        try:
            yield
        finally:
            args.disable_comfy_compiler = previous


def _dynamo_counter_snapshot(torch_module: Any) -> dict[str, dict[str, int]] | None:
    try:
        counters = torch_module._dynamo.utils.counters
    except (AttributeError, ImportError):
        return None
    result: dict[str, dict[str, int]] = {}
    for group in ("stats", "frames"):
        values = counters.get(group)
        if values is not None:
            result[group] = {str(name): int(value) for name, value in values.items()}
    return result


def _compile_safe_attention(kitchen_cuda: Any, torch_module: Any) -> Any:
    from .compile_vsa import compile_safe_sol_attn_chunked

    return compile_safe_sol_attn_chunked(kitchen_cuda, torch_module)


def _kitchen_dynamo_patch(torch_module: Any) -> tuple[Any, Any, Any] | None:
    """Prepare a scoped Dynamo eager region for Kitchen's DLPack VSA kernel.

    The outer shell keeps stream handles and workspace planning eager. Its
    tensor-valued launch adapters supply FakeTensor metadata, while the
    nonrecursive boundary allows explicitly compiled QKV callbacks to run.
    """
    try:
        kitchen_cuda = importlib.import_module("comfy_kitchen.backends.cuda")
    except ImportError:
        return None
    dynamo_disable = getattr(getattr(torch_module, "_dynamo", None), "disable", None)
    if not callable(dynamo_disable):
        raise TypeError("FastH3 compile requires torch._dynamo.disable for Kitchen VSA")
    attention = getattr(kitchen_cuda, "sol_attn_chunked", None)
    if not callable(attention):
        raise TypeError("Comfy Kitchen CUDA backend has no callable sol_attn_chunked")
    if getattr(attention, "_comfystreamerh3_dynamo_disabled", False):
        original_attention = getattr(attention, "_comfystreamerh3_original", None)
        if callable(original_attention):
            return kitchen_cuda, original_attention, attention
        return None
    safe_attention = _compile_safe_attention(kitchen_cuda, torch_module)
    eager_attention = dynamo_disable(safe_attention, recursive=False)
    eager_attention._comfystreamerh3_dynamo_disabled = True
    eager_attention._comfystreamerh3_original = attention
    return kitchen_cuda, attention, eager_attention


def _compile_qkv_regions(transformer: Any, torch_module: Any, graphs: list) -> list[str]:
    projections: list[tuple[str, Any]] = [
        (f"blocks.{index}.attn.qkv_proj", getattr(getattr(block, "attn", None), "qkv_proj", None))
        for index, block in enumerate(getattr(transformer, "blocks", ()))
    ]
    projections = [(name, module) for name, module in projections
                   if callable(getattr(module, "forward", None))]
    if not projections:
        return []
    inductor = torch_module._dynamo.lookup_backend("inductor")

    def capture_backend(graph, inputs, **kwargs):
        graphs.append({
            "region": "qkv_projection",
            "operators": [str(node.target) for node in graph.graph.nodes
                          if node.op.startswith("call_")],
        })
        return inductor(graph, inputs, **kwargs)

    for _name, module in projections:
        module.forward = torch_module.compile(
            module.forward, backend=capture_backend, mode="default", fullgraph=False,
        )
    return [name for name, _module in projections]



@contextmanager
def _kitchen_attention_eager(kitchen_patch):
    if kitchen_patch is None:
        yield
        return
    kitchen_cuda, original_attention, eager_attention = kitchen_patch
    with _KITCHEN_PATCH_LOCK:
        kitchen_cuda.sol_attn_chunked = eager_attention  # type: ignore[attr-defined]
        try:
            yield
        finally:
            kitchen_cuda.sol_attn_chunked = original_attention  # type: ignore[attr-defined]


def compile_fast_h3_transformer_forward(
    model_patcher: Any,
    *,
    torch_module: Any | None = None,
    target_method: str = "forward",
    disable_comfy_allocator_graph: bool = False,
    compile_transformer_body: bool = True,
    compile_modulation: bool = False,
    emulate_precision_casts: bool = False,
) -> dict[str, object]:
    """Compile one FastH3 diffusion-model method without wrapping its patcher.

    This is deliberately opt-in. PyTorch compiles lazily on first execution, so
    callers must report cold and warmed timings separately. Keeping the original
    module object preserves Comfy's ModelPatcher ownership and parameter map.
    """
    torch_api: Any
    if torch_module is None:
        import torch
        torch_api = torch
    else:
        torch_api = torch_module

    if not torch_api.cuda.is_available():
        raise RuntimeError("FastH3 transformer compilation requires a CUDA GPU")
    compiler = getattr(torch_api, "compile", None)
    if not callable(compiler):
        raise TypeError("this PyTorch build has no torch.compile")
    get_model_object = getattr(model_patcher, "get_model_object", None)
    if not callable(get_model_object):
        raise TypeError("FastH3 compilation requires a Comfy ModelPatcher")
    if target_method not in {"forward", "_forward"}:
        raise ValueError("FastH3 compile target must be forward or _forward")
    if not compile_transformer_body and target_method != "_forward":
        raise ValueError("QKV-only compilation requires the _forward target")
    if compile_modulation and (target_method != "_forward" or compile_transformer_body):
        raise ValueError("modulation compilation requires an eager H3 body")
    transformer = get_model_object("diffusion_model")
    original_forward = getattr(transformer, target_method, None)
    if not callable(original_forward):
        raise TypeError(f"FastH3 diffusion model has no callable {target_method}")
    context_shell = target_method == "_forward" and callable(getattr(transformer, "_sol_core_forward", None))
    compiled_target = "_sol_core_forward" if context_shell and compile_transformer_body else target_method
    if compiled_target != target_method:
        original_forward = transformer._sol_core_forward
    compile_scope = ("diffusion_model.modulation" if compile_modulation else
                     f"diffusion_model.{target_method}" if compile_transformer_body else
                     "diffusion_model.qkv_projections")
    compiled_method = getattr(transformer, "_comfystreamerh3_compile_method", None)
    if getattr(transformer, "_comfystreamerh3_compile_forward", False):
        if compiled_method not in (None, target_method):
            raise RuntimeError("FastH3 diffusion model was compiled with a different method")
        if getattr(transformer, "_comfystreamerh3_allocator_graph_disabled", False) is not disable_comfy_allocator_graph:
            raise RuntimeError("FastH3 diffusion model was compiled with a different allocator-graph policy")
        if getattr(transformer, "_comfystreamerh3_compile_body", True) is not compile_transformer_body:
            raise RuntimeError("FastH3 diffusion model was compiled with a different body policy")
        if getattr(transformer, "_comfystreamerh3_compile_modulation", False) is not compile_modulation:
            raise RuntimeError("FastH3 diffusion model was compiled with a different region policy")
        if getattr(transformer, "_comfystreamerh3_emulate_precision_casts", False) is not emulate_precision_casts:
            raise RuntimeError("FastH3 diffusion model was compiled with a different precision-cast policy")
        live_report = getattr(transformer, "_comfystreamerh3_compile_report", None)
        if not isinstance(live_report, dict):
            raise RuntimeError("compiled FastH3 model has no live Dynamo receipt")
        live_report["reused"] = True
        return live_report

    counters_before = _dynamo_counter_snapshot(torch_api)
    kitchen_patch = (
        _kitchen_dynamo_patch(torch_api)
        if not compile_modulation and (target_method == "_forward" or disable_comfy_allocator_graph) else None
    )
    dynamo_disabled_ops = (
        ["comfy_kitchen.backends.cuda.sol_attn_chunked"]
        if kitchen_patch is not None else []
    )
    qkv_region_graphs: list[dict[str, object]] = []
    qkv_modules = (
        _compile_qkv_regions(transformer, torch_api, qkv_region_graphs)
        if target_method == "_forward" and not compile_modulation else []
    )
    modulation_graphs: list[dict[str, object]] = []
    modulation_patch = _prepare_modulation(transformer, torch_api, modulation_graphs) if compile_modulation else None
    rope_freqs = getattr(transformer, "rope_freqs", None)
    if target_method == "_forward" and callable(rope_freqs):
        # The span-registration wrapper keys Python metadata by tensor id.
        # Keep that lookup eager without excluding the tensor-only rope math.
        transformer.rope_freqs = torch_api._dynamo.disable(rope_freqs, recursive=compile_transformer_body)
        dynamo_disabled_ops.append("diffusion_model.rope_freqs.metadata")
    compiler_options = (
        {"emulate_precision_casts": True}
        if emulate_precision_casts or (
            target_method == "_forward" and (compile_transformer_body or compile_modulation)
        ) else {}
    )
    if not compile_transformer_body:
        compiled_forward = original_forward
    elif compiler_options:
        # Native BF16 modulation rounds after each operation. Inductor's
        # default pointwise fusion removes those boundaries and changes H3
        # output. Options and mode are mutually exclusive in torch.compile.
        compiled_forward = compiler(original_forward, fullgraph=False, options=compiler_options)
    else:
        compiled_forward = compiler(original_forward, mode="default", fullgraph=False)
    compile_report: dict[str, object] = {
        "enabled": True,
        "scope": compile_scope,
        "transformer_body_compiled": compile_transformer_body,
        "context_shell_eager": context_shell,
        "compiler_options": compiler_options,
        "backend": "inductor",
        "mode": "default",
        "fullgraph": False,
        "compile_is_lazy": True,
        "comfy_allocator_graph_suppressed": disable_comfy_allocator_graph,
        "reused": False,
        "dynamo_disabled_ops": dynamo_disabled_ops,
        "kitchen_boundary_policy": "nonrecursive-shell+opaque-launches-v11",
        "qkv_projection_modules": qkv_modules,
        "qkv_region_graphs": qkv_region_graphs,
        "modulation_region_graphs": modulation_graphs,
        "dynamo_counters_before": counters_before,
        "dynamo_counters_after": counters_before,
        "compiled_graphs_added": 0,
        "captured_calls_added": 0,
    }

    def tracked_forward(*args: Any, **kwargs: Any) -> Any:
        try:
            if disable_comfy_allocator_graph:
                with _comfy_allocator_graph_disabled(), _kitchen_attention_eager(kitchen_patch), _modulation_region(modulation_patch):
                    return compiled_forward(*args, **kwargs)
            with _kitchen_attention_eager(kitchen_patch), _modulation_region(modulation_patch):
                return compiled_forward(*args, **kwargs)
        finally:
            counters_after = _dynamo_counter_snapshot(torch_api)
            compile_report["dynamo_counters_after"] = counters_after
            if counters_before is not None and counters_after is not None:
                compile_report["compiled_graphs_added"] = (
                    counters_after.get("stats", {}).get("unique_graphs", 0)
                    - counters_before.get("stats", {}).get("unique_graphs", 0)
                )
                compile_report["captured_calls_added"] = (
                    counters_after.get("stats", {}).get("calls_captured", 0)
                    - counters_before.get("stats", {}).get("calls_captured", 0)
                )

    setattr(transformer, compiled_target, tracked_forward)
    if disable_comfy_allocator_graph and target_method == "_forward":
        outer_forward = transformer.forward

        def allocator_safe_forward(*args: Any, **kwargs: Any) -> Any:
            # MiniMax starts allocation capture before entering _forward.
            # Suppressing it inside tracked_forward would be too late.
            with _comfy_allocator_graph_disabled():
                return outer_forward(*args, **kwargs)

        transformer.forward = allocator_safe_forward
    transformer._comfystreamerh3_compile_forward = True
    transformer._comfystreamerh3_compile_method = target_method
    transformer._comfystreamerh3_compile_body = compile_transformer_body
    transformer._comfystreamerh3_compile_modulation = compile_modulation
    transformer._comfystreamerh3_emulate_precision_casts = emulate_precision_casts
    transformer._comfystreamerh3_dynamo_disabled_ops = dynamo_disabled_ops
    transformer._comfystreamerh3_kitchen_patch = kitchen_patch
    transformer._comfystreamerh3_allocator_graph_disabled = disable_comfy_allocator_graph
    transformer._comfystreamerh3_compile_report = compile_report
    return compile_report
