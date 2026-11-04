"""Opt-in compilation helpers for the native MiniMax-H3 ViT3D decoder.

The H3 VAE decoder has a regular repeated ``TransformerBlock`` trunk followed
by shape-sensitive token trimming and 3-D patch reconstruction.  Only the
repeated blocks are eligible here.  The decoder and VAE objects are otherwise
left untouched, and the installed wrappers are owned by the decoder instance
so unrelated models cannot be affected.
"""

from __future__ import annotations

import inspect
import threading
import types
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager, nullcontext
from dataclasses import asdict, dataclass, field
from functools import wraps
from typing import Any, cast

import torch
from torch import nn

try:
    from .nvtx import nvtx_range
except ImportError:
    nvtx_range = cast(Any, nullcontext)


_STATE_ATTR = "_fasth3_decoder_optimization"
_TILE_BATCH_ATTR = "_fasth3_tile_batch"
_SUPPORTED_MODES = ("reference", "fused_ff", "fused_ff_qk_rope", "scale_cache", "native_v036")
_DISPATCH_DIAGNOSTIC_LOCK = threading.Lock()

# The OMEGA runner consumes this small, JSON-safe registry when it builds a
# decoder flag matrix.  Keep these flags separate from the sampler/memory
# feature registry: they are decoder-local and must be safe to toggle around
# one captured decode.  A flag is never considered promoted merely because
# its counter is non-zero; the counter only proves that the requested path
# engaged.
OMEGA_DECODER_REGISTRY_SCHEMA = "fasth3-omega-decoder/1"
OMEGA_DECODER_FLAGS = {
    "decoder_qk_inplace": {
        "default": True,
        "safe": True,
        "scope": "decoder_attention",
        "counter": "inplace_calls",
        "work_counters": ("qk_output_buffers_avoided", "qk_output_bytes_avoided"),
        "gpu_ready": True,
    },
    "reuse_staging": {
        "default": False,
        "safe": True,
        "scope": "decoder_tiles",
        "counter": "staged_groups",
        "work_counters": ("staging_allocations", "staging_reuses", "staging_copy_bytes"),
        "gpu_ready": False,
    },
    "elide_owned_clone": {
        "default": False,
        "safe": True,
        "scope": "decoder_tiles",
        "counter": "output_clones_avoided",
        "work_counters": ("output_clone_bytes_avoided", "output_clone_calls"),
        "gpu_ready": False,
    },
    "cache_scale_casts": {
        "default": True,
        "safe": True,
        "scope": "decoder_adaln",
        "counter": "scale_cast_cache_hits",
        "work_counters": ("scale_cast_calls", "scale_cast_result_bytes",
                           "scale_cast_avoided_result_bytes"),
        "gpu_ready": False,
    },
}


def omega_decoder_flag_registry() -> dict:
    """Return a detached registry suitable for a JSON benchmark manifest.

    Do not expose the module-level mapping itself: benchmark runners commonly
    annotate the returned dictionaries with trial status and must not mutate
    the contract seen by a later request in the same worker.
    """
    return {
        "schema": OMEGA_DECODER_REGISTRY_SCHEMA,
        "flags": {
            name: {key: list(value) if isinstance(value, tuple) else value
                   for key, value in spec.items()}
            for name, spec in OMEGA_DECODER_FLAGS.items()
        },
    }


def ensure_omega_decoder_counters(report: dict | None) -> dict:
    """Populate stable zero-valued decoder work counters in ``report``.

    OMEGA result readers need to distinguish ``0`` (the flag ran and did no
    work) from a missing counter (the old runner did not know about the flag).
    This helper deliberately mutates only the caller-owned report and returns
    it for convenient use at ABI boundaries.
    """
    if report is None:
        report = {}
    for spec in OMEGA_DECODER_FLAGS.values():
        work_counters = spec["work_counters"]
        if not isinstance(work_counters, (list, tuple)):
            raise TypeError("Omega decoder work_counters must be a list or tuple")
        for name in work_counters:
            report.setdefault(name, 0)
        report.setdefault(spec["counter"], 0)
    for name in ("staging_stream_invalidations", "staging_evictions",
                 "staging_peak_buffers", "staging_copy_calls", "staging_copy_bytes",
                 "output_clone_calls", "output_clone_bytes"):
        report.setdefault(name, 0)
    return report


class DecoderOptimizationError(ValueError):
    """Raised when a decoder is outside the narrow H3 optimization contract."""


@dataclass(frozen=True)
class DecoderCapability:
    available: bool
    reason: str
    cuda_available: bool
    actual_h3: bool
    torch_compile: bool


@dataclass(frozen=True)
class DecoderModeProfile:
    mode: str
    enabled: bool
    applied_blocks: int
    capability: DecoderCapability
    restored: bool = False
    module_blocks: int = 0
    execution: dict[str, Any] = field(default_factory=dict)
    upstream_dispatch: dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)


def _decoder_of(vae):
    decoder = getattr(vae, "decoder", None)
    if decoder is None:
        raise DecoderOptimizationError("expected an H3 VAE exposing decoder")
    return decoder


@contextmanager
def decoder_execution(vae) -> Iterator[dict[str, Any]]:
    """Count successful module calls; signatures and installed patches do not count.

    Forward hooks leave the native methods and arithmetic intact. A direct call
    to ``module.forward`` bypasses PyTorch hooks and supplies no evidence. This
    is request-local instrumentation, never proof of a specific CUDA kernel.
    """
    decoder = _decoder_of(vae)
    blocks = tuple(getattr(decoder, "transformer_blocks", ()))
    evidence: dict[str, Any] = {
        "schema": "fasth3-decoder-execution/1",
        "instrumentation": "forward_completion_hooks",
        "module_blocks": len(blocks),
        "block_calls": 0, "attention_calls": 0, "feedforward_calls": 0,
        "completed_blocks": 0, "restored": False,
        "kernel_evidence": "not_collected",
    }
    handles = []
    completed = set()

    def hook_for(counter, block_index=None):
        def completed_forward(_module, _inputs, _output):
            evidence[counter] += 1
            if block_index is not None:
                completed.add(block_index)
                evidence["completed_blocks"] = len(completed)
        return completed_forward

    try:
        for index, block in enumerate(blocks):
            for module, counter, block_index in (
                (block, "block_calls", index),
                (block.attn, "attention_calls", None),
                (block.ff, "feedforward_calls", None),
            ):
                if not callable(getattr(module, "register_forward_hook", None)):
                    raise DecoderOptimizationError("decoder execution requires module forward hooks")
                handles.append(module.register_forward_hook(hook_for(counter, block_index)))
        yield evidence
    finally:
        for handle in reversed(handles):
            handle.remove()
        evidence["restored"] = True


@contextmanager
def decoder_upstream_dispatch() -> Iterator[dict[str, Any]]:
    """Diagnostic-only successful upstream op calls, with transparent restoration.

    These counters prove dispatch through the named upstream functions, not
    which CUDA backend their internals selected. Optional INT8 availability is
    reported separately. Global op wrapping is serialized and request-scoped.
    """
    import comfy.ops
    import comfy.quant_ops

    if not _DISPATCH_DIAGNOSTIC_LOCK.acquire(blocking=False):
        raise DecoderOptimizationError("upstream decoder dispatch diagnostic is already active")
    ck = getattr(comfy.quant_ops, "ck", None)
    operations = [(comfy.ops, "linear_input_act"),
                  (ck, "rms_rope_split_half"), (ck, "rms_rope_split_half_"),
                  (ck, "int8_attention"), (ck, "int8_linear"), (ck, "fp16_linear")]
    evidence: dict[str, Any] = {
        "schema": "fasth3-upstream-decoder-dispatch/1",
        "scope": "diagnostic_only; successful upstream calls; backend kernels unverified",
        "calls": {name: 0 for name in ("linear_input_act", "rms_norm", "swiglu", "residual",
                                       "rms_rope_split_half", "rms_rope_split_half_", "int8_attention",
                                       "int8_linear", "fp16_linear", "optimized_linear_calls",
                                       "eager_fallback_calls", "unfused_input_act_calls",
                                       "int8_linear_rms_norm", "int8_linear_swiglu", "int8_linear_residual")},
        "available_operations": {}, "restored": False,
    }
    originals = []
    diagnostic_thread = threading.get_ident()

    def wrapper_for(original, name):
        signature = inspect.signature(original) if name == "linear_input_act" else None
        @wraps(original)
        def counted(*args, **kwargs):
            if threading.get_ident() != diagnostic_thread:
                return original(*args, **kwargs)
            before = dict(evidence["calls"]) if signature is not None else None
            result = original(*args, **kwargs)
            evidence["calls"][name] += 1
            if name == "int8_linear":
                activation = kwargs.get("input_act")
                if activation in ("rms_norm", "swiglu"):
                    evidence["calls"][f"int8_linear_{activation}"] += 1
                if kwargs.get("residual") is not None and kwargs.get("residual_scale") is not None:
                    evidence["calls"]["int8_linear_residual"] += 1
            if signature is not None:
                assert before is not None
                bound = signature.bind_partial(*args, **kwargs).arguments
                activation = bound.get("input_act")
                if activation in ("rms_norm", "swiglu"):
                    evidence["calls"][activation] += 1
                if bound.get("residual") is not None and bound.get("residual_scale") is not None:
                    evidence["calls"]["residual"] += 1
                optimized = any(evidence["calls"][op] > before[op]
                                for op in ("int8_linear", "fp16_linear"))
                evidence["calls"]["optimized_linear_calls" if optimized else "eager_fallback_calls"] += 1
                if (activation in ("rms_norm", "swiglu")
                        and evidence["calls"][f"int8_linear_{activation}"] == before[f"int8_linear_{activation}"]):
                    evidence["calls"]["unfused_input_act_calls"] += 1
            return result
        return counted

    try:
        for owner, name in operations:
            original = getattr(owner, name, None)
            evidence["available_operations"][name] = callable(original)
            if callable(original):
                wrapper = wrapper_for(original, name)
                originals.append((owner, name, original, wrapper))
                setattr(owner, name, wrapper)
        if not evidence["available_operations"]["linear_input_act"]:
            raise DecoderOptimizationError("upstream linear_input_act unavailable for diagnostic")
        yield evidence
    finally:
        changed = False
        for owner, name, original, wrapper in reversed(originals):
            changed = changed or getattr(owner, name) is not wrapper
            setattr(owner, name, original)
        evidence["restored"] = True
        _DISPATCH_DIAGNOSTIC_LOCK.release()
        if changed:
            raise DecoderOptimizationError("upstream op diagnostic ownership changed during request")


def _is_actual_h3_decoder(decoder) -> bool:
    """Use the shipped class identity/protocol, never a broad decoder match."""
    cls = type(decoder)
    if cls.__name__ != "ViT3DDecoder" or cls.__module__ != "comfy.ldm.minimax.vae":
        return False
    blocks = getattr(decoder, "transformer_blocks", None)
    if not isinstance(blocks, nn.ModuleList) or not blocks:
        return False
    return all(
        type(block).__name__ == "TransformerBlock"
        and type(block).__module__ == "comfy.ldm.minimax.vae"
        for block in blocks
    )


def probe_decoder_capability(vae) -> DecoderCapability:
    """Report capability without compiling or running a GPU workload."""
    try:
        decoder = _decoder_of(vae)
    except DecoderOptimizationError as exc:
        return DecoderCapability(False, str(exc), bool(torch.cuda.is_available()), False, hasattr(torch, "compile"))
    actual = _is_actual_h3_decoder(decoder)
    cuda = bool(torch.cuda.is_available())
    compile_available = callable(getattr(torch, "compile", None))
    if not actual:
        reason = "decoder is not the native comfy.ldm.minimax.vae.ViT3DDecoder"
    elif not cuda:
        reason = "CUDA is unavailable"
    elif not compile_available:
        reason = "this PyTorch build has no torch.compile"
    else:
        reason = "native H3 repeated TransformerBlock trunk is eligible"
    return DecoderCapability(
        available=actual and cuda and compile_available,
        reason=reason,
        cuda_available=cuda,
        actual_h3=actual,
        torch_compile=compile_available,
    )


def _fused_ff_forward(ff):
    """Bind the native Comfy INT8 SwiGLU input-activation dispatch."""
    from comfy.ops import linear_input_act
    def forward(self, x):
        with nvtx_range("decode_ff"):
            return linear_input_act(self.w2, self.w1(x), "swiglu")
    cast(Any, forward)._fasth3_stage_name = "decode_ff"
    return types.MethodType(forward, ff)


def qk_rope_contract(attn) -> tuple[int, float]:
    """Return ``(dim_head, eps)`` or raise if this attention cannot be fused.

    The native decoder normalizes the full ``dim_head`` and then rotates only a
    prefix (``head_dim`` 64, ``rot_dim`` 48 on the shipped H3 decoder), with
    non-affine ``norm_q``/``norm_k``. The kitchen fused op expresses exactly
    that: the norm always spans the full head dim and ``rot_dim`` restricts the
    rotation. Anything outside those assumptions is refused here rather than
    silently fused into a different arithmetic.
    """
    for name in ("norm_q", "norm_k", "to_qkv", "to_out", "dim_head", "heads"):
        if not hasattr(attn, name):
            raise DecoderOptimizationError(
                f"native H3 attention does not expose {name}; refusing to fuse QK norm+rope"
            )
    if getattr(attn.norm_q, "weight", None) is not None or getattr(attn.norm_k, "weight", None) is not None:
        raise DecoderOptimizationError(
            "fused QK norm+rope replaces non-affine RMSNorm only; this decoder has learned QK norm weights"
        )
    q_eps, k_eps = getattr(attn.norm_q, "eps", None), getattr(attn.norm_k, "eps", None)
    if q_eps is None or k_eps is None:
        raise DecoderOptimizationError("QK RMSNorm eps must be explicit to fuse into one op")
    if float(q_eps) != float(k_eps):
        raise DecoderOptimizationError(
            f"norm_q eps {float(q_eps)!r} != norm_k eps {float(k_eps)!r}; one fused op cannot serve both"
        )
    dim_head = int(attn.dim_head)
    if dim_head <= 0 or dim_head % 2:
        raise DecoderOptimizationError(f"fused QK norm+rope needs an even dim_head, got {dim_head}")
    return dim_head, float(q_eps)


def reference_qk_norm_rope(attn, query, key, rotary_pos_emb):
    """ComfyUI reference arithmetic: two RMSNorms, then prefix split-half RoPE.

    Parity checks use these ComfyUI operations to validate the fused output.
    """
    import comfy.quant_ops
    import comfy.rmsnorm

    query = comfy.rmsnorm.rms_norm(query, attn.norm_q.weight, attn.norm_q.eps)
    key = comfy.rmsnorm.rms_norm(key, attn.norm_k.weight, attn.norm_k.eps)
    if rotary_pos_emb is not None:
        rot = rotary_pos_emb.shape[-3] * 2
        query[..., :rot], key[..., :rot] = comfy.quant_ops.ck.apply_rope_split_half(
            query[..., :rot], key[..., :rot], rotary_pos_emb)
    return query, key


def _record_qk_rope_parity(parity: dict, attn, qkv_view, fused_q, fused_k, rotary_pos_emb) -> None:
    """Compare fused output with the unfused ComfyUI reference arithmetic.

    Diagnostic only: the caller installs the comparing forward, so a normal run
    never reaches this function and never pays for it.
    """
    query, key, _ = torch.chunk(qkv_view, 3, dim=-1)
    reference_q, reference_k = reference_qk_norm_rope(attn, query.clone(), key.clone(), rotary_pos_emb)
    exact = bool(torch.equal(reference_q, fused_q) and torch.equal(reference_k, fused_k))
    diff = max(
        (reference_q.float() - fused_q.float()).abs().max().item(),
        (reference_k.float() - fused_k.float()).abs().max().item(),
    )
    parity["calls"] = parity.get("calls", 0) + 1
    parity["bit_exact_calls"] = parity.get("bit_exact_calls", 0) + int(exact)
    parity["bit_exact"] = bool(parity.get("bit_exact", True) and exact)
    parity["max_abs_diff"] = max(float(parity.get("max_abs_diff", 0.0)), diff)
    parity.setdefault("dtype", str(fused_q.dtype))
    parity.setdefault("head_dim", int(fused_q.shape[-1]))
    parity.setdefault(
        "rot_dim", int(rotary_pos_emb.shape[-3] * 2) if rotary_pos_emb is not None else 0)


def _execution_stream(tensor):
    """Return a stable stream identity without synchronizing the device."""
    if tensor.device.type != "cuda":
        return None
    return torch.cuda.current_stream(tensor.device).cuda_stream


def _fused_qk_rope_forward(attn, parity: dict | None = None, *, inplace=False, counters=None):
    """One fused kitchen op for QK RMSNorm plus split-half RoPE.

    Native ``Attention.forward`` spends three elementwise passes over Q and K
    (norm_q, norm_k, then a rope that reads and writes a 48-wide prefix). The
    kitchen exposes ``rms_rope_split_half`` with a ``rot_dim`` prefix, which is
    the same arithmetic in one pass. Non-affine norms become an all-ones scale
    vector, cached per (dtype, device); multiplying by exactly 1.0 is exact in
    every float format, so the eager backend is bit-identical to the two-op
    path (proven offline in ``test_decoder_qk_rope.py``).
    """
    import comfy.quant_ops
    import comfy.rmsnorm
    from comfy.ldm.minimax import vae as vae_module

    dim_head, eps = qk_rope_contract(attn)
    ck = comfy.quant_ops.ck
    if not callable(getattr(ck, "rms_rope_split_half", None)):
        raise DecoderOptimizationError("comfy_kitchen has no rms_rope_split_half")
    if inplace and not callable(getattr(ck, "rms_rope_split_half_", None)):
        raise DecoderOptimizationError("comfy_kitchen has no inference in-place QK/RoPE API")
    scale = None
    scale_key = None

    def forward(self, x, rotary_pos_emb=None):
        nonlocal scale, scale_key
        with nvtx_range("decode_attn"):
            batch_size, seq_len, _ = x.shape
            qkv = self.to_qkv(x).view(batch_size, seq_len, -1, 3 * dim_head)
            query, key, value = torch.chunk(qkv, 3, dim=-1)

            rot = rotary_pos_emb.shape[-3] * 2 if rotary_pos_emb is not None else 0
            if rot and rot <= dim_head and not rot % 2:
                # The temporary all-ones scale is produced on the current
                # stream.  Reusing it on another stream without an event edge
                # is a real race, so stream identity is part of the cache key.
                stream = _execution_stream(x)
                key_id = (x.dtype, x.device, stream)
                if scale_key != key_id:
                    if counters is not None and scale_key is not None:
                        counters["qk_scale_cache_invalidations"] = counters.get(
                            "qk_scale_cache_invalidations", 0) + 1
                    scale = torch.ones(dim_head, dtype=x.dtype, device=x.device)
                    scale_key = key_id
                    if counters is not None:
                        counters["qk_scale_cache_misses"] = counters.get(
                            "qk_scale_cache_misses", 0) + 1
                elif counters is not None:
                    counters["qk_scale_cache_hits"] = counters.get(
                        "qk_scale_cache_hits", 0) + 1
                with nvtx_range("decode_qk"):
                    original_qkv = qkv.clone() if inplace and parity is not None else qkv
                    operation = ck.rms_rope_split_half_ if inplace else ck.rms_rope_split_half
                    result = operation(
                        query, key, rotary_pos_emb, scale, scale, eps, rot)
                    if result is None:
                        result = (query, key)
                    if inplace:
                        before_q, before_k = query.data_ptr(), key.data_ptr()
                        if (not isinstance(result, (tuple, list)) or len(result) != 2
                                or not all(isinstance(value, torch.Tensor) for value in result)
                                or result[0].data_ptr() != before_q
                                or result[1].data_ptr() != before_k
                                or result[0].shape != query.shape
                                or result[1].shape != key.shape
                                or result[0].stride() != query.stride()
                                or result[1].stride() != key.stride()):
                            raise DecoderOptimizationError(
                                "in-place QK/RoPE API returned new or invalid buffers")
                    elif (not isinstance(result, (tuple, list)) or len(result) != 2
                         or not all(isinstance(value, torch.Tensor) for value in result)):
                        raise DecoderOptimizationError(
                            "QK/RoPE API returned an invalid result")
                    query, key = result
                if counters is not None:
                    name = "inplace_calls" if inplace else "out_of_place_calls"
                    counters[name] = counters.get(name, 0) + 1
                    if inplace:
                        counters["qk_output_buffers_avoided"] += 2
                        counters["qk_output_bytes_avoided"] += (query.numel() + key.numel()) * query.element_size()
                if parity is not None:
                    _record_qk_rope_parity(parity, self, original_qkv, query, key, rotary_pos_emb)
            else:
                query, key = reference_qk_norm_rope(self, query, key, rotary_pos_emb)
                if counters is not None:
                    counters["reference_calls"] = counters.get("reference_calls", 0) + 1

            with nvtx_range("decode_attention_core"):
                out = vae_module.optimized_attention(
                    query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2),
                    self.heads, skip_reshape=True).nan_to_num_(0.0)
            return self.to_out(out)

    cast(Any, forward)._fasth3_stage_name = "decode_attn"
    return types.MethodType(forward, attn)


@contextmanager
def decoder_qk_inplace(vae, *, enabled=False, parity=None):
    """Baseline seam eliminating two QK output buffers per rotated attention.

    Uses Kitchen's existing fused arithmetic on fresh, disjoint packed-QKV
    views; V is read-only. No new fused-kernel/latency claim. Enter inside the
    legacy decoder_mode scope. Native v0.36 pre-norm/residual signatures are
    intentionally rejected so this seam cannot erase upstream fusion.
    """
    report = {"enabled": bool(enabled), "inplace_calls": 0, "out_of_place_calls": 0,
              "reference_calls": 0, "qk_output_buffers_avoided": 0,
              "qk_output_bytes_avoided": 0, "qk_scale_cache_hits": 0,
              "qk_scale_cache_misses": 0, "qk_scale_cache_invalidations": 0,
              "restored": False,
              "counter_scope": "successful Kitchen API calls and logical QK output buffers; GPU fusion unverified"}
    ensure_omega_decoder_counters(report)
    if not enabled:
        report["restored"] = True
        yield report
        return
    if torch.is_grad_enabled():
        raise DecoderOptimizationError("in-place decoder QK requires inference/no-grad")
    import inspect

    decoder = _decoder_of(vae)
    if not _is_actual_h3_decoder(decoder):
        raise DecoderOptimizationError("in-place decoder QK requires native H3 decoder")
    if getattr(decoder, "_fasth3_qk_inplace_owner", False):
        raise DecoderOptimizationError("in-place decoder QK scope already active")
    for block in decoder.transformer_blocks:
        attn = block.attn
        params = inspect.signature(attn.forward).parameters
        if {"pre_norm", "residual", "residual_scale"}.intersection(params):
            raise DecoderOptimizationError("preserve native v0.36 decoder fusion")
        old = attn.__dict__.get("forward")
        if (attn._forward_hooks or attn._forward_pre_hooks or attn._backward_hooks
                or (old is not None and getattr(old, "_fasth3_stage_name", None) != "decode_attn")):
            raise DecoderOptimizationError("foreign attention wrapper/hooks prevent in-place QK ownership")
        qk_rope_contract(attn)
    decoder._fasth3_qk_inplace_owner = True
    saved = []
    try:
        for block in decoder.transformer_blocks:
            attn = block.attn
            old = attn.__dict__.get("forward")
            installed = _fused_qk_rope_forward(attn, parity, inplace=True, counters=report)
            saved.append((attn, old, installed))
            attn.forward = installed
        yield report
    finally:
        conflicts = 0
        for attn, old, installed in reversed(saved):
            if attn.__dict__.get("forward") is not installed:
                conflicts += 1
            elif old is None:
                del attn.forward
            else:
                attn.forward = old
        del decoder._fasth3_qk_inplace_owner
        report["ownership_conflicts"] = conflicts
        report["restored"] = conflicts == 0


def _fused_block_forward(block, counters=None):
    """Same AdaLN body as native TransformerBlock, with scale casts reused."""
    from comfy.ops import cast_to_input
    from comfy.rmsnorm import rms_norm
    scale1_c = scale2_c = None
    scale_key = None

    def source_key(value, x):
        if not isinstance(value, torch.Tensor):
            return None
        try:
            version = value._version
        except RuntimeError:
            return None
        return (id(value), version, value.data_ptr(), tuple(value.shape),
                tuple(value.stride()), value.dtype, value.device, x.dtype,
                x.device, _execution_stream(x))

    def forward(self, x, rotary_pos_emb=None):
        nonlocal scale1_c, scale2_c, scale_key
        key = (source_key(self.scale1, x), source_key(self.scale2, x))
        if key[0] is not None and key[1] is not None and scale_key == key:
            if counters is not None:
                counters["scale_cast_cache_hits"] = counters.get("scale_cast_cache_hits", 0) + 2
                counters["scale_cast_avoided_result_bytes"] = counters.get(
                    "scale_cast_avoided_result_bytes", 0
                ) + scale1_c.numel() * scale1_c.element_size() + scale2_c.numel() * scale2_c.element_size()
        else:
            if counters is not None:
                if scale_key is not None:
                    counters["scale_cast_cache_invalidations"] = counters.get(
                        "scale_cast_cache_invalidations", 0) + 1
                counters["scale_cast_cache_misses"] = counters.get("scale_cast_cache_misses", 0) + 2
            scale1_c = cast_to_input(self.scale1, x)
            scale2_c = cast_to_input(self.scale2, x)
            if counters is not None:
                counters["scale_cast_calls"] = counters.get("scale_cast_calls", 0) + 2
                counters["scale_cast_result_bytes"] = counters.get(
                    "scale_cast_result_bytes", 0
                ) + scale1_c.numel() * scale1_c.element_size() + scale2_c.numel() * scale2_c.element_size()
            scale_key = key if key[0] is not None and key[1] is not None else None
        attn_out = self.attn(rms_norm(x, self.norm1.weight, self.norm1.eps), rotary_pos_emb)
        with nvtx_range("decode_mod"):
            x = x.addcmul_(attn_out, scale1_c)
        ff_out = self.ff(rms_norm(x, self.norm2.weight, self.norm2.eps))
        with nvtx_range("decode_mod"):
            return x.addcmul_(ff_out, scale2_c)

    # Recognized by the scoped Kitchen VAE adapter; other wrappers remain opaque.
    cast(Any, forward)._fasth3_decoder_block = True
    return types.MethodType(forward, block)


def _state(decoder):
    return getattr(decoder, _STATE_ATTR, None)


def restore_decoder_mode(vae) -> bool:
    """Restore the decoder blocks saved by :func:`apply_decoder_mode`."""
    if hasattr(vae, "_fasth3_kitchen_vae_owner"):
        raise DecoderOptimizationError("exit kitchen_vae before restoring decoder_mode")
    decoder = _decoder_of(vae)
    state = _state(decoder)
    if state is None:
        return False
    blocks = decoder.transformer_blocks
    for index, original in enumerate(state["originals"]):
        blocks[index] = original
        if index < len(state.get("ff_originals", ())):
            state["originals"][index].ff.forward = state["ff_originals"][index]
        if index < len(state.get("block_originals", ())):
            state["originals"][index].forward = state["block_originals"][index]
        if index < len(state.get("forward_originals", ())):
            original.forward = state["forward_originals"][index]
        if index < len(state.get("attn_originals", ())):
            state["originals"][index].attn.forward = state["attn_originals"][index]
    delattr(decoder, _STATE_ATTR)
    return True


def _install_qk_rope(originals, parity: dict | None):
    """Patch every block's ``attn.forward``; restore all of them on any failure."""
    attn_originals = tuple(block.attn.forward for block in originals)
    try:
        for block in originals:
            if not hasattr(block, "attn"):
                raise DecoderOptimizationError("native H3 blocks do not expose attn")
            block.attn.forward = _fused_qk_rope_forward(block.attn, parity)
    except Exception:
        for block, original_attn in zip(originals, attn_originals):
            block.attn.forward = original_attn
        raise
    return attn_originals


def _qk_rope_capability(capability: DecoderCapability) -> tuple[bool, DecoderCapability]:
    """Refuse the QK fusion unless the kitchen op it needs is actually present.

    ``capability.available`` is leftover compile eligibility; fused_ff / QK
    paths do not require torch.compile.
    """
    try:
        import comfy.quant_ops
        if not callable(getattr(comfy.quant_ops.ck, "rms_rope_split_half", None)):
            raise RuntimeError("comfy_kitchen has no rms_rope_split_half")  # noqa: TRY004
    except Exception as exc:  # noqa: BLE001 - capability probe must fail closed
        return False, DecoderCapability(
            False, f"fused QK RMSNorm+RoPE op unavailable: {exc}",
            capability.cuda_available, capability.actual_h3, capability.torch_compile,
        )
    return True, capability


def apply_decoder_mode(vae, mode: str = "reference", *,
                       qk_rope_parity: dict | None = None) -> DecoderModeProfile:
    """Install an H3 decoder mode and return an auditable capability profile.

    ``reference`` is a strict no-op.

    ``qk_rope_parity`` is a diagnostic sink: pass a dict and the QK-fusion modes
    install a forward that also runs the unfused reference path and records the
    difference into it. Leave it ``None`` for any timed run — the comparison
    doubles the QK work and belongs nowhere near a latency measurement.
    """
    if hasattr(vae, "_fasth3_kitchen_vae_owner"):
        raise DecoderOptimizationError("enter decoder_mode before kitchen_vae, not inside it")
    if mode not in _SUPPORTED_MODES:
        raise DecoderOptimizationError(f"unknown decoder mode {mode!r}; expected one of {_SUPPORTED_MODES}")
    decoder = _decoder_of(vae)
    capability = probe_decoder_capability(vae)
    if mode == "native_v036":
        # ComfyUI v0.36 owns the decoder block fusion. Do not monkey-patch its
        # Attention/FeedForward methods: their signatures carry pre-norm and
        # residual operands that the v0.35 adapters do not understand.
        import inspect

        if not capability.actual_h3:
            return DecoderModeProfile(mode, False, 0, capability)
        if not decoder.transformer_blocks:
            return DecoderModeProfile(
                mode, False, 0,
                DecoderCapability(False, "native H3 decoder has no transformer blocks",
                                  capability.cuda_available, capability.actual_h3,
                                  capability.torch_compile),
            )
        required = {"pre_norm", "residual", "residual_scale"}
        if any(
            not required.issubset(inspect.signature(operation.forward).parameters)
            for block in decoder.transformer_blocks for operation in (block.attn, block.ff)
        ):
            return DecoderModeProfile(
                mode, False, 0,
                DecoderCapability(
                    False,
                    "native_v036 requires ComfyUI H3 VAE block signatures",
                    capability.cuda_available, capability.actual_h3, capability.torch_compile,
                ),
            )
        return DecoderModeProfile(
            mode, True, 0,
            DecoderCapability(
                True,
                "using native ComfyUI v0.36 H3 VAE fusion path",
                capability.cuda_available, capability.actual_h3, capability.torch_compile,
            ), module_blocks=len(decoder.transformer_blocks),
        )
    if mode == "reference":
        if _state(decoder) is not None:
            restore_decoder_mode(vae)
        return DecoderModeProfile(mode, False, 0, capability)
    existing = _state(decoder)
    if existing is not None and existing.get("mode") != mode:
        restore_decoder_mode(vae)
    if mode in ("fused_ff", "fused_ff_qk_rope"):
        if not capability.actual_h3:
            return DecoderModeProfile(mode, False, 0, capability)
        if mode == "fused_ff_qk_rope":
            usable, capability = _qk_rope_capability(capability)
            if not usable:
                return DecoderModeProfile(mode, False, 0, capability)
        try:
            import comfy.ops
            if not callable(getattr(comfy.ops, "linear_input_act", None)):
                raise RuntimeError("comfy.ops.linear_input_act is unavailable")  # noqa: TRY004
        except Exception as exc:  # noqa: BLE001 - capability probe must fail closed
            return DecoderModeProfile(
                mode, False, 0,
                DecoderCapability(False, f"native H3 SwiGLU dispatch unavailable: {exc}",
                                  capability.cuda_available, capability.actual_h3, capability.torch_compile),
            )
        if _state(decoder) is not None:
            return DecoderModeProfile(mode, True, len(decoder.transformer_blocks), capability)
        originals = tuple(decoder.transformer_blocks)
        ff_originals = tuple(block.ff.forward for block in originals)
        block_originals = tuple(block.forward for block in originals)
        try:
            for block in originals:
                if not hasattr(block, "ff") or not hasattr(block.ff, "w1") or not hasattr(block.ff, "w2"):
                    raise DecoderOptimizationError("native H3 blocks do not expose FeedForward w1/w2")
                block.ff.forward = _fused_ff_forward(block.ff)
                block.forward = _fused_block_forward(block)
        except Exception:
            for block, original_ff, original_fwd in zip(originals, ff_originals, block_originals):
                block.ff.forward = original_ff
                block.forward = original_fwd
            raise
        state = {
            "mode": mode, "originals": originals, "ff_originals": ff_originals,
            "block_originals": block_originals,
        }
        if mode == "fused_ff_qk_rope":
            try:
                state["attn_originals"] = _install_qk_rope(originals, qk_rope_parity)
            except Exception:
                for block, original_ff, original_fwd in zip(originals, ff_originals, block_originals):
                    block.ff.forward = original_ff
                    block.forward = original_fwd
                raise
        decoder._fasth3_decoder_optimization = state
        return DecoderModeProfile(mode, True, len(originals), capability)
    if mode == "scale_cache":
        # R069: reuse AdaLN scale casts without requiring CUDA INT8 FF fusion.
        if not capability.actual_h3:
            return DecoderModeProfile(mode, False, 0, capability)
        if _state(decoder) is not None:
            return DecoderModeProfile(mode, True, len(decoder.transformer_blocks), capability)
        originals = tuple(decoder.transformer_blocks)
        block_originals = tuple(block.forward for block in originals)
        try:
            for block in originals:
                if not hasattr(block, "scale1") or not hasattr(block, "scale2"):
                    raise DecoderOptimizationError("native H3 blocks do not expose AdaLN scales")
                block.forward = _fused_block_forward(block)
        except Exception:
            for block, original_fwd in zip(originals, block_originals):
                block.forward = original_fwd
            raise
        decoder._fasth3_decoder_optimization = {
            "mode": mode, "originals": originals, "block_originals": block_originals,
        }
        return DecoderModeProfile(mode, True, len(originals), capability)
    raise DecoderOptimizationError(f"unknown decoder mode {mode!r}")


@contextmanager
def decoder_mode(vae, mode: str = "reference", *,
                 qk_rope_parity: dict | None = None,
                 record_execution: bool = False,
                 record_upstream_dispatch: bool = False) -> Iterator[DecoderModeProfile]:
    """Temporarily install a mode and always restore the decoder afterwards."""
    decoder = _decoder_of(vae)
    original_forwards = tuple((module, module.forward) for module in decoder.modules())
    profile = apply_decoder_mode(vae, mode, qk_rope_parity=qk_rope_parity)
    try:
        if profile.enabled and (record_execution or record_upstream_dispatch):
            evidence = None
            dispatch_evidence = None
            try:
                with ExitStack() as stack:
                    evidence = stack.enter_context(decoder_execution(vae))
                    profile.execution.update(evidence)
                    if record_upstream_dispatch:
                        dispatch_evidence = stack.enter_context(decoder_upstream_dispatch())
                        profile.upstream_dispatch.update(dispatch_evidence)
                    yield profile
            finally:
                if evidence is not None:
                    profile.execution.update(evidence)
                if dispatch_evidence is not None:
                    profile.upstream_dispatch.update(dispatch_evidence)
        else:
            yield profile
    finally:
        restore_decoder_mode(vae)
        current_modules = tuple(decoder.modules())
        restored = (
            _state(decoder) is None
            and len(current_modules) == len(original_forwards)
            and all(module is expected_module and module.forward == original_forward
                    for module, (expected_module, original_forward)
                    in zip(current_modules, original_forwards))
            and (not profile.execution or profile.execution.get("restored") is True)
            and (not profile.upstream_dispatch or profile.upstream_dispatch.get("restored") is True)
        )
        # Finalize only the lifetime status after actual methods/hooks are
        # restored; the frozen installation/capability description stays intact.
        object.__setattr__(profile, "restored", restored)


__all__ = [
    "OMEGA_DECODER_FLAGS",
    "OMEGA_DECODER_REGISTRY_SCHEMA",
    "_TILE_BATCH_ATTR",
    "DecoderCapability",
    "DecoderModeProfile",
    "DecoderOptimizationError",
    "_CudaGraphDecode",
    "_independently_owned_decode_output",
    "_tiled_decode_batched",
    "apply_decoder_mode",
    "apply_tile_batch",
    "decode_tiles_batched",
    "decoder_cuda_graph",
    "decoder_execution",
    "decoder_mode",
    "decoder_qk_inplace",
    "decoder_stage_timing",
    "decoder_upstream_dispatch",
    "ensure_omega_decoder_counters",
    "iter_decode_tile_groups",
    "omega_decoder_flag_registry",
    "probe_decoder_capability",
    "qk_rope_contract",
    "reference_qk_norm_rope",
    "restore_decoder_mode",
    "restore_tile_batch",
    "tile_batch",
    "tile_timing",
]

# Compatibility exports; decoder patching and its public optimization flags stay here.
from .decoder_diagnostics import (
    decoder_stage_timing,
)
from .decoder_graph import _CudaGraphDecode, decoder_cuda_graph
from .decoder_tiles import (
    _TILE_BATCH_ATTR,
    _independently_owned_decode_output,
    _tiled_decode_batched,
    apply_tile_batch,
    decode_tiles_batched,
    iter_decode_tile_groups,
    restore_tile_batch,
    tile_batch,
    tile_timing,
)
