"""Opt-in timing and tensor traces for one decoder call."""
from __future__ import annotations

import functools
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from typing import Any, cast

import torch

try:
    from .nvtx import nvtx_range
except ImportError:
    nvtx_range = cast(Any, nullcontext)
def _tensor_trace(value: Any) -> dict[str, Any] | None:
    """Return small, JSON-safe tensor metadata for diagnostic reports."""
    if not isinstance(value, torch.Tensor):
        return None
    return {
        "shape": [int(dim) for dim in value.shape],
        "stride": [int(stride) for stride in value.stride()],
        "dtype": str(value.dtype),
        "device": str(value.device),
        "contiguous": bool(value.is_contiguous()),
    }

def _module_trace(module: Any) -> dict[str, Any]:
    """Capture stable module/weight facts without retaining runtime objects."""
    result: dict[str, Any] = {
        "module": type(module).__name__,
        "module_path": type(module).__module__,
    }
    weight = getattr(module, "weight", None)
    if isinstance(weight, torch.Tensor):
        result["weight"] = _tensor_trace(weight)
        layout = getattr(weight, "_layout_cls", None)
        if layout is not None:
            result["weight_layout"] = str(layout)
        params = getattr(weight, "_params", None)
        if params is not None:
            result["weight_params_type"] = type(params).__name__
    return result

def _wrap_stage_method(target, name: str, stage: str, label: str,
                       metadata: dict[str, Any], restores: list[tuple[Any, str, bool, Any]]) -> None:
    """Wrap one instance method with a reversible diagnostic stage range."""
    original = getattr(target, name)
    original_fn = getattr(original, "__func__", original)
    if getattr(original_fn, "_fasth3_stage_name", None) == stage:
        return
    instance_dict = getattr(target, "__dict__", {})
    had_instance = name in instance_dict
    old_instance = instance_dict.get(name)

    @functools.wraps(original_fn)
    def wrapped(*args, **kwargs):
        entry = metadata.setdefault(label, {
            "stage": stage,
            "target": label,
            **_module_trace(target),
            "calls": 0,
        })
        entry["calls"] += 1
        if "first_input" not in entry:
            for value in args:
                trace = _tensor_trace(value)
                if trace is not None:
                    entry["first_input"] = trace
                    break
        with nvtx_range(stage):
            return original(*args, **kwargs)

    cast(Any, wrapped)._fasth3_stage_name = stage
    setattr(target, name, wrapped)
    restores.append((target, name, had_instance, old_instance))

@contextmanager
def decoder_stage_timing(vae) -> Iterator[dict[str, Any]]:
    """Instrument real decoder operations for one diagnostic decode only.

    The wrappers add no ranges when diagnostics are disabled because this
    context is entered only by the benchmark's explicit diagnostic arm. Every
    instance attribute is restored even when a decoder call raises.
    """
    from .decoder_optimizations import DecoderOptimizationError, _decoder_of, _is_actual_h3_decoder
    decoder = _decoder_of(vae)
    if not _is_actual_h3_decoder(decoder):
        raise DecoderOptimizationError("decoder stage timing requires native H3 ViT3DDecoder")

    metadata: dict[str, Any] = {
        "targets": {},
        "restored": False,
        "scope": "one_decode",
    }
    restores: list[tuple[Any, str, bool, Any]] = []
    try:
        _wrap_stage_method(decoder.x_embedder, "forward", "decode_embed",
                           "decoder.x_embedder", metadata["targets"], restores)
        _wrap_stage_method(decoder.pos_embed, "forward", "decode_embed",
                           "decoder.pos_embed", metadata["targets"], restores)
        _wrap_stage_method(decoder.norm_out, "forward", "decode_norm",
                           "decoder.norm_out", metadata["targets"], restores)
        _wrap_stage_method(decoder.proj_out, "forward", "decode_proj_final",
                           "decoder.proj_out", metadata["targets"], restores)
        for index, block in enumerate(decoder.transformer_blocks):
            prefix = f"block[{index}]"
            _wrap_stage_method(block, "forward", "decode_block", prefix,
                               metadata["targets"], restores)
            _wrap_stage_method(block.norm1, "forward", "decode_norm",
                               f"{prefix}.norm1", metadata["targets"], restores)
            _wrap_stage_method(block.norm2, "forward", "decode_norm",
                               f"{prefix}.norm2", metadata["targets"], restores)
            _wrap_stage_method(block.attn, "forward", "decode_attn",
                               f"{prefix}.attn", metadata["targets"], restores)
            _wrap_stage_method(block.attn.to_qkv, "forward", "decode_proj_qkv",
                               f"{prefix}.attn.to_qkv", metadata["targets"], restores)
            _wrap_stage_method(block.attn.to_out, "forward", "decode_proj_attn_out",
                               f"{prefix}.attn.to_out", metadata["targets"], restores)
            _wrap_stage_method(block.ff, "forward", "decode_ff",
                               f"{prefix}.ff", metadata["targets"], restores)
            _wrap_stage_method(block.ff.w1, "forward", "decode_proj_ff_w1",
                               f"{prefix}.ff.w1", metadata["targets"], restores)
            _wrap_stage_method(block.ff.w2, "forward", "decode_proj_ff_w2",
                               f"{prefix}.ff.w2", metadata["targets"], restores)

        if callable(getattr(vae, "decode_temporal", None)):
            _wrap_stage_method(vae, "decode_temporal", "decode_assemble",
                               "vae.decode_temporal", metadata["targets"], restores)
        if callable(getattr(vae, "blend", None)):
            _wrap_stage_method(vae, "blend", "decode_blend",
                               "vae.blend", metadata["targets"], restores)
        yield metadata
    finally:
        for target, name, had_instance, old_instance in reversed(restores):
            if had_instance:
                setattr(target, name, old_instance)
            else:
                getattr(target, "__dict__", {}).pop(name, None)
        metadata["restored"] = True
