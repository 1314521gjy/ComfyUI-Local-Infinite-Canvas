"""Versioned packed ABI. Prefix/coarse ownership stays with Kitchen.

Only post-norm/RoPE bounded chunks are accepted by prepare_chunk. Device work
uses the caller's current PyTorch stream. Prepared storage is request-owned;
drop/reset it on cancellation or shape changes. There is no global tensor cache.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from importlib import import_module
from typing import Any

import torch

from .artifact import artifact_report

ABI_VERSION = 4
SOURCE_REVISION = "native-phase-output-v1"


@lru_cache(maxsize=1)
def _extension():
    # Importing torch above preloads its shared libraries from the worker's
    # actual installation, without relying on the builder's venv location.
    artifact_report()
    try:
        module = import_module(f"{__package__}._anemoi_sm120")
    except ImportError as exc:
        raise RuntimeError(
            "Native Anemoi extension unavailable: build anemoi_native/build.py "
            "on the CUDA builder and package its artifact; runtime compilation "
            "and reference fallback are disabled"
        ) from exc
    if module.abi_version != ABI_VERSION or module.source_revision != SOURCE_REVISION:
        raise RuntimeError("Native Anemoi loaded extension ABI/revision mismatch")
    return module


def available() -> bool:
    try:
        _extension()
    except RuntimeError:
        return False
    return True


def native_phase_assign(route_ids, counts, scores, ratios):
    """Run score ranking, Hamilton quotas, and phase compaction in CUDA."""
    phase_assign = getattr(_extension(), "phase_assign", None)
    if phase_assign is None:
        raise RuntimeError("native Anemoi extension lacks phase assignment kernel")
    return phase_assign(route_ids, counts, scores, [float(value) for value in ratios])


def output_epilogue(fine, *, coarse=None, coarse_gate=None, tokens=None,
                    stock_prefix_output=None, prefix_blocks=(0, 0)):
    """Write final BSHD BF16 output in native CUDA when the artifact supports it.

    ``fine`` is the native kernel's contiguous BHSD FP16 result.  ``coarse`` is
    Kitchen's already-computed FP32 ``[B,H,blocks,128]`` correction and the
    gate is the original contiguous ``[B,T,H,128]`` tensor.  The fallback is
    intentionally the old transpose/cast/addcmul order for compatibility.
    """
    coarse = fine.new_empty((0,)) if coarse is None else coarse
    coarse_gate = fine.new_empty((0,)) if coarse_gate is None else coarse_gate
    tokens = fine.shape[2] if tokens is None else tokens
    if type(tokens) is not int or not 0 < tokens <= fine.shape[2]:
        raise ValueError("output token count must be a positive prefix of fine output")
    native = _extension()
    function = getattr(native, "output_epilogue", None)
    start, end = prefix_blocks
    if type(start) is not int or type(end) is not int or not 0 <= start <= end <= (tokens + 63) // 64:
        raise ValueError("prefix interval outside output")
    if start != end and stock_prefix_output is None:
        raise ValueError("protected interval requires original BF16 stock output")
    if stock_prefix_output is not None:
        if (stock_prefix_output.shape != (fine.shape[0], tokens, fine.shape[1], 128)
                or stock_prefix_output.dtype != torch.bfloat16
                or stock_prefix_output.device != fine.device
                or not stock_prefix_output.is_contiguous()):
            raise ValueError("direct stock prefix must be contiguous BSHD BF16")
        direct = getattr(native, "output_epilogue_prefix", None)
        if (fine.is_cuda and callable(direct)
                and getattr(native, "supports_direct_prefix_output", False) is True
                and fine.is_contiguous()
                and (not coarse.numel() or coarse.is_contiguous())
                and (not coarse_gate.numel() or coarse_gate.is_contiguous())):
            return direct(fine, coarse, coarse_gate, tokens, stock_prefix_output, start, end)
    native_layout_inputs = (
        fine.is_cuda
        and fine.is_contiguous()
        and (not coarse.numel() or coarse.is_contiguous())
        and (not coarse_gate.numel() or coarse_gate.is_contiguous())
    )
    if (
        callable(function)
        and stock_prefix_output is None
        and getattr(native, "supports_output_layout_epilogue", False) is True
        and native_layout_inputs
    ):
        return function(fine, coarse, coarse_gate, tokens)
    out = fine[:, :, :tokens].permute(0, 2, 1, 3).to(torch.bfloat16).contiguous()
    if stock_prefix_output is not None:
        # Compatibility path for artifacts without the additive prefix export:
        # never feed protected BF16 values through the FP16 intermediate. Restore
        # before the ONE coarse add, including a partial final protected cube.
        out[:, start*64:min(end*64, tokens)].copy_(
            stock_prefix_output[:, start*64:min(end*64, tokens)])
    if coarse.numel():
        correction = coarse.view(out.shape[0], out.shape[2], -1, 128).permute(0, 2, 1, 3)
        correction = correction.repeat_interleave(64, dim=1)[:, :tokens]
        out.addcmul_(coarse_gate, correction)
    return out


@lru_cache(maxsize=64)
def kernel_resources(name, device_index, fp16=None):
    """Cache immutable function attributes; no repeated driver query per layer."""
    function = getattr(_extension(), name)
    return tuple(function() if fp16 is None else function(fp16))


def v_physical_row(row: int) -> int:
    """INT8-phase E4M3 V token permutation (not Kitchen perm_d)."""
    local = row % 16
    return (row // 16) * 16 + (local // 8) * 2 + ((local // 2) % 4) * 4 + local % 2


@dataclass
class Prepared:
    q: torch.Tensor
    k: torch.Tensor
    v: torch.Tensor
    q_scale: torch.Tensor
    k_scale: torch.Tensor
    v_scale: torch.Tensor
    means: torch.Tensor
    valid: torch.Tensor
    phase: str
    centered: bool
    prefix_blocks: int
    global_vscale: torch.Tensor | None = None
    global_scales: tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None = None
    calibration: str = "unset"
    ready: set[int] = field(default_factory=set)
    prepare_calls: int = 0
    fine_calls: int = 0
    prefix_start: int = 0
    stream: int | None = None
    trusted: bool = False
    clipping_counts: torch.Tensor | None = None
    observed_amax: torch.Tensor | None = None
    preparation_savings: dict[str, int] = field(default_factory=lambda: {
        "ragged_padding_allocations_eliminated": 0,
        "ragged_padding_copy_bytes_eliminated": 0,
    })

    @property
    def blocks(self) -> int:
        return self.valid.shape[1]

    @property
    def descriptor(self) -> dict[str, Any]:
        return {
            "abi": ABI_VERSION,
            "phase": self.phase,
            "centered": self.centered,
            "tile": (64, 64, 128),
            "qk_layout": "BHSD",
            "v_layout": "BHDS; E4M3 bytes with v_physical_row per K16"
            if self.phase == "int8"
            else (
                "BHDS/2; E2M1 consecutive token nibbles" if self.phase == "nvfp4" else "BHSD FP16"
            ),
            "value_metadata": f"B,H,Kblocks,G={self.means.shape[3]},D=128",
            "stream": "current torch CUDA stream; same stream across prepare/fine",
            "calibration": self.calibration,
            "preparation_savings": dict(self.preparation_savings),
        }


@dataclass(frozen=True)
class ExecutionResult:
    output: torch.Tensor
    lse: torch.Tensor
    original_metadata: Any
    execution: dict[str, Any]


def route_lut(route_ids, blocks):
    """Meet native LUT stride without cloning an already full-capacity table.

    Zero-width F.pad still allocates/copies on the reference PyTorch path.
    Non-contiguous input still needs contiguous(); report no allocation saving
    for that case, since its reference clone layout depends on input strides.
    No route values/counts are inspected on host.
    """
    missing = blocks - route_ids.shape[-1]
    if missing < 0:
        raise ValueError("route capacity exceeds physical key blocks")
    saved = int(missing == 0 and route_ids.is_contiguous())
    savings = {
        "no_op_pad_calls_eliminated": int(missing == 0),
        "copy_allocations_eliminated": saved,
        "copy_bytes_eliminated": saved * route_ids.numel() * route_ids.element_size(),
    }
    if missing:
        return torch.nn.functional.pad(route_ids, (0, missing), value=-1).contiguous(), savings
    return route_ids.contiguous(), savings


def same_tensor_view(left, right):
    """Exact alias, not merely overlapping storage; metadata-only check."""
    return (left.device == right.device and left.dtype == right.dtype
            and left.shape == right.shape and left.stride() == right.stride()
            and left.data_ptr() == right.data_ptr())


def grouped_chunk_inputs(q, k, v, permutation, *, use_native=False):
    """Exact byte gather/pad; Q is never permuted. Native path is opt-in.

    The kernel accepts strided uint8 metadata and a ragged last chunk. Report
    removed Python tensor operations/allocations, not inferred latency or
    unprofiled ATen kernel counts. Old artifacts retain the reference path.
    """
    b, h, rows, d = q.shape
    blocks = (rows + 63) // 64
    if (q.shape != k.shape or q.shape != v.shape or d != 128
            or q.dtype not in (torch.float16, torch.bfloat16)
            or k.dtype != q.dtype or v.dtype != q.dtype):
        raise ValueError("grouped inputs require matching FP16/BF16 BHMD D128")
    if (permutation.shape != (b, h, blocks, 64) or permutation.dtype != torch.uint8
            or any(x.device != q.device for x in (k, v, permutation))):
        raise ValueError("shared permutation must be uint8 [B,H,chunk_blocks,64] on input device")
    savings = {
        "native_gather_launches": 0, "padding_allocations_eliminated": 0,
        "padding_allocation_bytes_eliminated": 0, "int64_index_allocations_eliminated": 0,
        "int64_index_bytes_eliminated": 0, "reference_tensor_ops_eliminated": 0,
    }
    extension = _extension() if use_native and q.is_cuda else None
    function = getattr(extension, "gather_grouped_chunk", None)
    if (getattr(extension, "supports_prepare_fusion", False) is True and callable(function)
            and all(x.is_contiguous() for x in (q, k, v))):
        result = function(q, k, v, permutation)
        savings["native_gather_launches"] = 1
        savings["int64_index_allocations_eliminated"] = 1
        savings["int64_index_bytes_eliminated"] = permutation.numel() * 8
        savings["reference_tensor_ops_eliminated"] = 3 + (3 if rows % 64 else 0)
        if rows % 64:
            # Q still needs one padded output; K/V pad and gather share their
            # final outputs, avoiding two separate padded input allocations.
            savings["padding_allocations_eliminated"] = 2
            savings["padding_allocation_bytes_eliminated"] = 2*b*h*blocks*64*d*q.element_size()
        return (*result, savings)
    if rows % 64:
        q, k, v = (torch.nn.functional.pad(x, (0, 0, 0, blocks*64-rows)) for x in (q, k, v))
    order = permutation.to(torch.int64)[..., None].expand(b, h, blocks, 64, 128)
    k = k.reshape(b, h, blocks, 64, 128).gather(3, order).reshape_as(k)
    v = v.reshape(b, h, blocks, 64, 128).gather(3, order).reshape_as(v)
    return q, k, v, savings


def allocate(
    batch: int,
    heads: int,
    blocks: int,
    device,
    *,
    phase="int8",
    centered=False,
    prefix_blocks=0,
    prefix_start=0,
    groups=1,
    global_scales=None,
    _trusted=False,
    _shared_valid=None,
) -> Prepared:
    if min(batch, heads, blocks) <= 0 or not 0 <= prefix_start <= prefix_blocks <= blocks:
        raise ValueError("positive geometry and valid prefix_blocks required")
    if groups not in (1, 4):
        raise ValueError("value groups must be 1 or 4")
    if groups == 4 and not centered:
        raise ValueError("G4 requires explicit combined value policy")
    if phase not in ("int8", "fp16", "nvfp4"):
        raise ValueError("phase must be int8, fp16, or nvfp4")
    if centered and phase != "int8":
        raise NotImplementedError("combined FP16/NVFP4 correction is not implemented")
    if _shared_valid is not None and (
        _shared_valid.shape != (batch, blocks) or _shared_valid.dtype != torch.int32
        or not _shared_valid.is_contiguous() or _shared_valid.device != torch.device(device)
    ):
        raise ValueError("shared validity must be contiguous int32 [B,blocks] on operand device")

    def empty(shape, dtype):
        return torch.empty(shape, dtype=dtype, device=device)

    tokens = blocks * 64
    if phase == "int8":
        q, k = (empty((batch, heads, tokens, 128), torch.int8) for _ in range(2))
        v = empty((batch, heads, 128, tokens), torch.uint8)
        qs, ks = (empty((batch, heads, blocks), torch.float32) for _ in range(2))
        vs = empty((batch, heads, blocks, groups, 128), torch.float32)
    elif phase == "nvfp4":
        if global_scales is None or len(global_scales) != 3:
            raise ValueError("NVFP4 requires calibrated Q/K/V global scales")
        q, k = (empty((batch, heads, tokens, 64), torch.uint8) for _ in range(2))
        v = empty((batch, heads, 128, tokens // 2), torch.uint8)
        qs, ks = (empty((batch, heads, tokens, 8), torch.uint8) for _ in range(2))
        vs = empty((batch, heads, blocks, 128, 4), torch.uint8)
    else:
        q, k, v = (empty((batch, heads, tokens, 128), torch.float16) for _ in range(3))
        qs, ks, vs = (empty((0,), torch.float32) for _ in range(3))
    return Prepared(
        q,
        k,
        v,
        qs,
        ks,
        vs,
        empty((batch, heads, blocks, groups, 128), torch.bfloat16),
        empty((batch, blocks), torch.int32) if _shared_valid is None else _shared_valid,
        phase,
        centered,
        prefix_blocks,
        global_scales=global_scales,
        prefix_start=prefix_start,
        stream=torch.cuda.current_stream(device).cuda_stream
        if torch.device(device).type == "cuda"
        else None,
        trusted=_trusted,
        clipping_counts=torch.zeros(3, dtype=torch.int64, device=device)
        if phase == "nvfp4"
        else None,
        observed_amax=torch.zeros(3, dtype=torch.float32, device=device)
        if phase == "nvfp4"
        else None,
    )


def _check_stream(prepared):
    if (
        prepared.stream is not None
        and torch.cuda.current_stream(prepared.q.device).cuda_stream != prepared.stream
    ):
        raise RuntimeError("Anemoi prepare/fine must use the workspace's original CUDA stream")


def set_global_vscale(prepared: Prepared, original_vamax: torch.Tensor, *, measured: bool):
    """Use original pre-centering absmax, never residual or reconstructed V."""
    shape = (prepared.q.shape[0], prepared.q.shape[1], 128)
    if tuple(original_vamax.shape) != shape:
        raise ValueError(f"original_vamax must have shape {shape}")
    if original_vamax.device != prepared.q.device:
        raise ValueError("calibration device mismatch")
    if prepared.ready:
        raise ValueError("calibration cannot change after packing has started")
    if not prepared.trusted and (
        not torch.isfinite(original_vamax).all() or (original_vamax < 0).any()
    ):
        raise ValueError("original absmax must be finite and nonnegative")
    scale = original_vamax.float() / 2.25
    prepared.global_vscale = torch.where(scale == 0, 1.0, scale).contiguous()
    prepared.calibration = (
        "current-original-absmax" if measured else "rolling-stale-original-absmax"
    )


def prepare_chunk(
    prepared: Prepared,
    q,
    k,
    v,
    valid_counts,
    block_offset: int,
    *,
    represented_means=None,
    use_native_ragged: bool = False,
):
    """Pack one chunk; final partial M is padded only within this bounded chunk.

    q/k/v: [B,H,M,128] FP16/BF16 in Kitchen physical cube order, post-norm/RoPE.
    valid_counts: int32 [B,ceil(M/64)] (shared 1-D counts are broadcast).
    Prefix KV interval [prefix_start,prefix_blocks) stays uncentered.
    """
    _check_stream(prepared)
    if q.ndim != 4 or q.shape != k.shape or q.shape != v.shape or q.shape[-1] != 128:
        raise ValueError("q/k/v must have identical [B,H,M,128] shape")
    if q.shape[:2] != prepared.q.shape[:2] or q.shape[2] <= 0:
        raise ValueError("chunk batch/head/length mismatch")
    if q.dtype not in (torch.float16, torch.bfloat16) or k.dtype != q.dtype or v.dtype != q.dtype:
        raise ValueError("chunks must have matching FP16/BF16 dtype")
    if any(x.device != prepared.q.device for x in (q, k, v, valid_counts)):
        raise ValueError("chunk device mismatch")
    n = (q.shape[2] + 63) // 64
    if block_offset < 0 or block_offset + n > prepared.blocks:
        raise ValueError("chunk exceeds prepared capacity")
    if prepared.ready.intersection(range(block_offset, block_offset + n)):
        raise ValueError("overlapping chunk preparation; allocate a new request workspace")
    if valid_counts.ndim == 1:
        valid_counts = valid_counts.unsqueeze(0).expand(q.shape[0], -1)
    if valid_counts.dtype != torch.int32 or valid_counts.shape != (q.shape[0], n):
        raise ValueError("valid_counts must be int32 [B,chunk_blocks]")
    if not prepared.trusted and ((valid_counts < 0) | (valid_counts > 64)).any():
        raise ValueError("valid_counts must lie in [0,64]")
    tail = q.shape[2] % 64
    native_ragged = False
    native = None
    if use_native_ragged and tail and q.is_cuda and all(x.is_contiguous() for x in (q, k, v)):
        native = _extension()
        native_name = {
            "int8": "prepare_int8_chunk_ragged",
            "nvfp4": "prepare_nvfp4_chunk_ragged",
        }.get(prepared.phase)
        native_ragged = (
            getattr(native, "supports_ragged_prepare", False) is True
            and native_name is not None
            and callable(getattr(native, native_name, None))
        )
    if not prepared.trusted and tail and (valid_counts[:, -1] > tail).any():
        raise ValueError("valid tail exceeds supplied chunk rows")
    if prepared.phase == "int8" and not prepared.centered and prepared.global_vscale is None:
        raise ValueError("plain Anemoi requires original global V calibration before packing")
    if tail and not native_ragged:
        q, k, v = (torch.nn.functional.pad(x, (0, 0, 0, 64 - tail)) for x in (q, k, v))
    q, k, v = (x.contiguous() for x in (q, k, v))
    if prepared.phase != "fp16":
        valid_counts = valid_counts.contiguous()
    if prepared.phase == "int8":
        if native_ragged and native is not None:
            function = native.prepare_int8_chunk_ragged
        else:
            function = _extension().prepare_int8_chunk
        args = [
            q,
            k,
            v,
            valid_counts,
            prepared.q,
            prepared.k,
            prepared.v,
            prepared.q_scale,
            prepared.k_scale,
            prepared.v_scale,
            prepared.means,
            block_offset,
            prepared.centered,
            prepared.prefix_blocks,
            prepared.global_vscale if prepared.global_vscale is not None else q.new_empty(0),
            prepared.prefix_start,
            represented_means.contiguous() if represented_means is not None else q.new_empty(0),
        ]
        if native_ragged:
            function(*args)
        else:
            function(*args)
    elif prepared.phase == "nvfp4":
        if prepared.global_scales is None:
            raise ValueError("NVFP4 global scales missing")
        if native_ragged and native is not None:
            function = native.prepare_nvfp4_chunk_ragged
        else:
            function = _extension().prepare_nvfp4_chunk
        args = [
            q,
            k,
            v,
            valid_counts,
            prepared.q,
            prepared.k,
            prepared.v,
            prepared.q_scale,
            prepared.k_scale,
            prepared.v_scale,
            *prepared.global_scales,
            block_offset,
            prepared.clipping_counts,
            prepared.observed_amax,
        ]
        function(*args)
    else:
        live = torch.arange(64, device=q.device)[None, None, :] < valid_counts.unsqueeze(-1)
        live = live.reshape(q.shape[0], 1, n * 64, 1)
        sl = slice(block_offset * 64, (block_offset + n) * 64)
        for dst, src in zip((prepared.q, prepared.k, prepared.v), (q, k, v)):
            dst[:, :, sl].copy_(torch.where(live, src, 0).to(torch.float16))
    if tail and native_ragged:
        padded_bytes = q.shape[0] * q.shape[1] * n * 64 * 128 * q.element_size()
        prepared.preparation_savings["ragged_padding_allocations_eliminated"] += 3
        prepared.preparation_savings["ragged_padding_copy_bytes_eliminated"] += 3 * padded_bytes
    destination = prepared.valid[:, block_offset : block_offset + n]
    if not same_tensor_view(destination, valid_counts):
        destination.copy_(valid_counts)
    prepared.ready.update(range(block_offset, block_offset + n))
    prepared.prepare_calls += 1


def fine_attention(
    prepared: Prepared,
    route_ids,
    phase_counts,
    valid_k_counts=None,
    *,
    valid_q_counts=None,
    original_metadata=None,
    prefix_query_mask=None,
    stock_prefix_output=None,
    softmax_scale=128**-0.5,
    _defer_prefix_output=False,
) -> ExecutionResult:
    """Run one homogeneous phase on caller-selected routes; no routing/quota policy.

    phase_counts is {phase: int32 [B,H,Qblocks]}. Mixed quotas are rejected.
    IDs are absolute int32 [B,H,Qblocks,capacity], active prefix of each row.
    Prefix query mask is bool [B,Qblocks]; exact Kitchen outputs replace those
    rows. Original coarse metadata is returned by identity, never recomputed.
    """
    _check_stream(prepared)
    if prepared.ready != set(range(prepared.blocks)):
        raise ValueError("not every physical block has been prepared")
    if set(phase_counts) != {prepared.phase}:
        raise NotImplementedError("mixed phase transitions/quotas are not enabled")
    b, h = prepared.q.shape[:2]
    qb = kb = prepared.blocks
    if route_ids.dtype != torch.int32 or route_ids.ndim != 4 or route_ids.shape[:3] != (b, h, qb):
        raise ValueError("route_ids must be int32 [B,H,Qblocks,capacity]")
    capacity = route_ids.shape[-1]
    if not 0 <= capacity <= kb:
        raise ValueError("route capacity must be at most Kblocks")
    counts = phase_counts[prepared.phase]
    if counts.dtype != torch.int32 or counts.shape != (b, h, qb):
        raise ValueError("phase counts must be int32 [B,H,Qblocks]")
    if not prepared.trusted and ((counts < 0) | (counts > capacity)).any():
        raise ValueError("phase counts exceed route capacity")

    def lengths(value):
        value = prepared.valid if value is None else value
        if value.ndim == 1:
            value = value.unsqueeze(0).expand(b, -1)
        if value.dtype != torch.int32 or value.shape != (b, kb):
            raise ValueError("valid lengths must be int32 [B,blocks] or [blocks]")
        if not prepared.trusted and ((value < 0) | (value > 64)).any():
            raise ValueError("valid lengths must lie in [0,64]")
        return value.contiguous()

    kval, qval = lengths(valid_k_counts), lengths(valid_q_counts)
    if not prepared.trusted and (
        not torch.equal(kval, prepared.valid) or not torch.equal(qval, prepared.valid)
    ):
        raise ValueError("valid lengths must match the original packed operand validity")
    if any(x.device != prepared.q.device for x in (route_ids, counts, kval, qval)):
        raise ValueError("route/valid device mismatch")
    if prepared.prefix_blocks and prefix_query_mask is None:
        raise ValueError("prefix configuration requires explicit stock query protection")
    if prefix_query_mask is not None:
        if prefix_query_mask.dtype != torch.bool or prefix_query_mask.shape != (b, qb):
            raise ValueError("prefix_query_mask must be bool [B,Qblocks]")
        if not _defer_prefix_output and (
                stock_prefix_output is None or stock_prefix_output.shape != (b, h, qb * 64, 128)):
            raise ValueError("stock Kitchen prefix output must be [B,H,Q,128]")
        if (
            prefix_query_mask.device != prepared.q.device
            or (not _defer_prefix_output and stock_prefix_output.device != prepared.q.device)
        ):
            raise ValueError("prefix device mismatch")
        counts = counts.masked_fill(prefix_query_mask[:, None, :], 0)
    if _defer_prefix_output and prepared.phase != "int8":
        raise NotImplementedError("deferred prefix supports INT8 control only")
    # Upstream uses Kblocks as physical LUT row stride. Pad only inactive slots;
    # active IDs and their order remain unchanged. No public router is called.
    ids, route_copy_savings = route_lut(route_ids, kb)
    extension = _extension()
    native_output_epilogue = getattr(extension, "supports_output_epilogue", False) is True
    if _defer_prefix_output and not native_output_epilogue:
        raise RuntimeError("deferred prefix requires native invalid-row masking")
    if prepared.phase == "int8":
        operation = (
            (
                extension.combined_g4_attention
                if prepared.means.shape[3] == 4
                else extension.combined_attention
            )
            if prepared.centered
            else extension.int8_attention
        )
        scale = prepared.v_scale if prepared.centered else prepared.global_vscale
        out, lse = operation(
            prepared.q,
            prepared.k,
            prepared.v,
            prepared.q_scale,
            prepared.k_scale,
            scale,
            prepared.means,
            ids,
            counts.contiguous(),
            kval,
            softmax_scale,
            prepared.trusted,
            prefix_query_mask if prefix_query_mask is not None and not _defer_prefix_output
            else prepared.q.new_empty((0,), dtype=torch.bool),
            stock_prefix_output if stock_prefix_output is not None and not _defer_prefix_output
            else prepared.q.new_empty((0,), dtype=torch.bfloat16),
        )
        resource_name = (
            ("combined_g4_resources" if prepared.means.shape[3] == 4 else "combined_resources")
            if prepared.centered
            else "int8_resources"
        )
        resources = kernel_resources(resource_name, prepared.q.device.index)
    elif prepared.phase == "nvfp4":
        if prepared.global_scales is None:
            raise ValueError("NVFP4 global scales missing")
        out, lse = extension.nvfp4_attention(
            prepared.q,
            prepared.k,
            prepared.v,
            prepared.q_scale,
            prepared.k_scale,
            prepared.v_scale,
            ids,
            counts.contiguous(),
            kval,
            *prepared.global_scales,
            softmax_scale,
            prepared.trusted,
        )
        resources = kernel_resources("nvfp4_resources", prepared.q.device.index)
    else:
        out, lse = extension.fp16_attention(
            prepared.q,
            prepared.k,
            prepared.v,
            ids,
            counts.contiguous(),
            kval,
            softmax_scale,
            prepared.trusted,
        )
        resources = kernel_resources("fp16_resources", prepared.q.device.index)
    if prepared.phase != "int8" or not native_output_epilogue:
        live = torch.arange(64, device=out.device)[None, None, :] < qval[:, :, None]
        out.masked_fill_(~live.reshape(b, 1, qb * 64, 1), 0)
        lse.masked_fill_(~live.reshape(b, 1, qb * 64), -float("inf"))
    if prefix_query_mask is not None and not _defer_prefix_output and (
        prepared.phase != "int8" or not native_output_epilogue
    ):
        mask = prefix_query_mask.repeat_interleave(64, dim=1)[:, None, :, None]
        # Preserve Kitchen BF16 rounding for protected rows, before parent merge.
        out = torch.where(mask, stock_prefix_output, out.to(stock_prefix_output.dtype))
    prepared.fine_calls += 1
    return ExecutionResult(
        out,
        lse,
        original_metadata,
        {
            "requested_backend": "combined" if prepared.centered else "anemoi",
            "executed_backend": "native_sm120",
            "source_revision": SOURCE_REVISION,
            "phase": prepared.phase,
            "phase_calls": {prepared.phase: counts.any().to(torch.int32)},
            "phase_pairs": counts.sum(),
            "prepare_calls": prepared.prepare_calls,
            "fine_calls": prepared.fine_calls,
            "resources": resources,
            "descriptor": prepared.descriptor,
            "fallback": None,
            "trusted_producer": prepared.trusted,
            "route_copy_savings": route_copy_savings,
            "validation": "source-only until GPU numerical/resource gates pass",
        },
    )
