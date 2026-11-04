"""Tiled compact-list attention kernel for the optional candidate paths.

The launch contract is H3's 64-token blocks and head dimension 128. Each
program owns one ``[64, D]`` query tile for one head and walks the compact
route as ``[64, D]`` K/V tiles. QK and PV are matrix products; the two passes
are intentional because Anemoi quantizes probabilities relative to the final
row maximum.
"""
from __future__ import annotations

import torch

try:  # Triton is already an existing deployment dependency for fused MLP.
    import triton
    import triton.language as tl

    TRITON_AVAILABLE = True
    TRITON_IMPORT_ERROR = None
except (ImportError, OSError, RuntimeError) as exc:  # pragma: no cover - runtime dependent
    triton = None
    tl = None
    TRITON_AVAILABLE = False
    TRITON_IMPORT_ERROR = exc


BLOCK_SIZE = 64
HEAD_DIM = 128


if TRITON_AVAILABLE:

    @triton.jit
    def _compact_attention_kernel(
        q_ptr,
        k_ptr,
        v_ptr,
        out_ptr,
        selected_ptr,
        block_len_ptr,
        residual_code_ptr,
        residual_scale_ptr,
        residual_mean_ptr,
        original_v_ptr,
        high_ptr,
        lse_ptr,
        n_tokens,
        n_heads,
        n_blocks,
        selected_width: tl.constexpr,
        use_residual: tl.constexpr,
        residual_rowwise: tl.constexpr,
        use_high_precision: tl.constexpr,
        use_anemoi_probability: tl.constexpr,
        q_stride_t,
        q_stride_h,
        k_stride_t,
        k_stride_h,
        v_stride_t,
        v_stride_h,
        out_stride_t,
        out_stride_h,
        BLOCK_SIZE: tl.constexpr,
        HEAD_DIM: tl.constexpr,
        BLOCK_D: tl.constexpr,
    ):
        query_block = tl.program_id(0)
        head = tl.program_id(1)
        rows = tl.arange(0, BLOCK_SIZE)
        dim = tl.arange(0, BLOCK_D)
        dim_mask = dim < HEAD_DIM
        query_base = query_block * BLOCK_SIZE
        query_len = tl.load(block_len_ptr + query_block)
        query_live = (rows < query_len) & (query_base + rows < n_tokens)

        # Loading Q as a matrix makes the following products use Triton's
        # tiled dot path. The explicit FP32 conversion is important for mixed
        # BF16/FP32 carriers and for the online softmax state.
        q_ptrs = (
            q_ptr
            + (query_base + rows[:, None]) * q_stride_t
            + head * q_stride_h
            + dim[None, :]
        )
        q = tl.load(q_ptrs, mask=query_live[:, None] & dim_mask[None, :], other=0.0).to(tl.float32)

        # The first pass computes the exact FP32 online normalization state.
        # It also handles invalid route slots without ever forming an invalid
        # pointer: safe_block is only used for address arithmetic, while
        # key_live carries the semantic validity mask.
        running_max = tl.full((BLOCK_SIZE,), -float("inf"), tl.float32)
        running_sum = tl.zeros((BLOCK_SIZE,), tl.float32)
        for slot in range(selected_width):
            route_offset = (
                (head * n_blocks + query_block) * selected_width + slot
            )
            block_id = tl.load(selected_ptr + route_offset).to(tl.int32)
            valid_block = (block_id >= 0) & (block_id < n_blocks)
            safe_block = tl.where(valid_block, block_id, 0)
            key_rows = tl.arange(0, BLOCK_SIZE)
            key_token = safe_block * BLOCK_SIZE + key_rows
            key_live = (
                valid_block
                & (key_rows < tl.load(block_len_ptr + safe_block))
                & (key_token < n_tokens)
            )
            k_ptrs = (
                k_ptr
                + key_token[:, None] * k_stride_t
                + head * k_stride_h
                + dim[None, :]
            )
            k = tl.load(k_ptrs, mask=key_live[:, None] & dim_mask[None, :], other=0.0).to(tl.float32)
            scores = tl.dot(
                q, tl.trans(k), input_precision="ieee", out_dtype=tl.float32
            ) * 0.08838834764831845
            scores = tl.where(key_live[None, :], scores, -float("inf"))

            block_max = tl.max(scores, axis=1)
            block_has_key = tl.sum(key_live.to(tl.int32), axis=0) > 0
            new_max = tl.maximum(running_max, block_max)
            running_valid = running_sum > 0.0
            alpha = tl.where(running_valid, tl.exp(running_max - new_max), 0.0)
            safe_new_max = tl.where(running_valid | block_has_key, new_max, 0.0)
            probability = tl.exp(scores - safe_new_max[:, None])
            probability = tl.where(key_live[None, :], probability, 0.0)
            running_sum = running_sum * alpha + tl.sum(probability, axis=1)
            running_max = new_max

        # The second pass reuses the same [64, 128] Q/K tile shape and performs
        # one [64, 64] probability-by-[64,D] PV dot per route slot. Anemoi's
        # E4M3 probability representation is applied after the final maximum
        # is known, matching the reference denominator convention.
        accumulator = tl.zeros((BLOCK_SIZE, BLOCK_D), tl.float32)
        final_max = tl.where(running_sum > 0.0, running_max, 0.0)
        for slot in range(selected_width):
            route_offset = (
                (head * n_blocks + query_block) * selected_width + slot
            )
            block_id = tl.load(selected_ptr + route_offset).to(tl.int32)
            valid_block = (block_id >= 0) & (block_id < n_blocks)
            safe_block = tl.where(valid_block, block_id, 0)
            key_rows = tl.arange(0, BLOCK_SIZE)
            key_token = safe_block * BLOCK_SIZE + key_rows
            key_live = (
                valid_block
                & (key_rows < tl.load(block_len_ptr + safe_block))
                & (key_token < n_tokens)
            )
            k_ptrs = (
                k_ptr
                + key_token[:, None] * k_stride_t
                + head * k_stride_h
                + dim[None, :]
            )
            k = tl.load(k_ptrs, mask=key_live[:, None] & dim_mask[None, :], other=0.0).to(tl.float32)
            scores = tl.dot(
                q, tl.trans(k), input_precision="ieee", out_dtype=tl.float32
            ) * 0.08838834764831845
            scores = tl.where(key_live[None, :], scores, -float("inf"))
            probability = tl.exp(scores - final_max[:, None])
            probability = tl.where(key_live[None, :], probability, 0.0)
            if use_anemoi_probability:
                beta = 0.0022326917
                represented_probability = (
                    (probability / beta).to(tl.float8e4nv).to(tl.float32) * beta
                )
            else:
                represented_probability = probability

            v_ptrs = (
                v_ptr
                + key_token[:, None] * v_stride_t
                + head * v_stride_h
                + dim[None, :]
            )
            value = tl.load(
                v_ptrs, mask=key_live[:, None] & dim_mask[None, :], other=0.0
            ).to(tl.float32)
            if use_residual:
                code_ptrs = (
                    residual_code_ptr
                    + key_token[:, None] * n_heads * HEAD_DIM
                    + head * HEAD_DIM
                    + dim[None, :]
                )
                code = tl.load(
                    code_ptrs, mask=key_live[:, None] & dim_mask[None, :], other=0.0
                ).to(tl.float32)
                if residual_rowwise:
                    metadata_base = key_token[:, None] * n_heads * HEAD_DIM
                else:
                    metadata_base = safe_block * n_heads * HEAD_DIM
                metadata_offset = (
                    metadata_base
                    + head * HEAD_DIM
                    + dim[None, :]
                )
                scale_ptrs = residual_scale_ptr + metadata_offset
                mean_ptrs = residual_mean_ptr + metadata_offset
                scale = tl.load(scale_ptrs, mask=dim_mask[None, :], other=0.0).to(tl.float32)
                mean = tl.load(
                    mean_ptrs,
                    mask=dim_mask[None, :],
                    other=0.0,
                ).to(tl.float32)
                value = code * scale + mean
            if use_high_precision:
                is_high = tl.load(high_ptr + route_offset).to(tl.int32) != 0
                original = tl.load(
                    original_v_ptr + key_token[:, None] * v_stride_t
                    + head * v_stride_h
                    + dim[None, :],
                    mask=key_live[:, None] & dim_mask[None, :],
                    other=0.0,
                ).to(tl.float32)
                value = tl.where(is_high, original, value)
            accumulator += tl.dot(
                represented_probability, value,
                input_precision="ieee", out_dtype=tl.float32,
            )

        finite = running_sum > 0.0
        output = accumulator / tl.maximum(running_sum, 1.0e-12)[:, None]
        output = tl.where(query_live[:, None] & finite[:, None], output, 0.0)
        out_ptrs = (
            out_ptr
            + (query_base + rows[:, None]) * out_stride_t
            + head * out_stride_h
            + dim[None, :]
        )
        tl.store(out_ptrs, output, mask=dim_mask[None, :])
        lse = running_max + tl.log(tl.maximum(running_sum, 1.0e-12))
        lse = tl.where(query_live & finite, lse, -float("inf"))
        tl.store(lse_ptr + (query_base + rows) * n_heads + head, lse)


def available(device=None) -> bool:
    """Whether the SM120-targeted fused candidate kernel can be launched."""
    if device is not None and torch.device(device).type != "cuda":
        return False
    if not (TRITON_AVAILABLE and torch.cuda.is_available()):
        return False
    try:
        major, minor = torch.cuda.get_device_capability(device)
    except RuntimeError:
        return False
    return (major, minor) == (12, 0)


def compact_precision_flags(selected: torch.Tensor, high_precision: torch.Tensor) -> torch.Tensor:
    """Map logical KV precision flags to the compact route-slot order."""
    heads, blocks, _width = selected.shape
    if high_precision.shape != (heads, blocks, blocks) or high_precision.device != selected.device or high_precision.dtype != torch.bool:
        raise ValueError("high_precision must be a boolean [H,Qblock,Kblock] map")
    if bool(((selected < -1) | (selected >= blocks)).any()):
        raise ValueError("selected contains an out-of-range block ID")
    return torch.gather(high_precision, 2, selected.clamp_min(0).long()) & (selected >= 0)


def run_compact_attention(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    selected: torch.Tensor,
    block_len: torch.Tensor,
    *,
    residual: tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None = None,
    original_v: torch.Tensor | None = None,
    high_precision: torch.Tensor | None = None,
    anemoi_probability: bool = False,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Launch experimental compact attention on BF16/FP32 CUDA tensors."""
    if not available(q.device):
        raise RuntimeError(f"Triton candidate kernel unavailable: {TRITON_IMPORT_ERROR}")
    if q.device.type != "cuda" or q.dtype not in (torch.bfloat16, torch.float32):
        raise ValueError("Triton candidate kernel requires BF16/FP32 CUDA q/k/v")
    if q.shape != k.shape or q.shape != v.shape or q.dim() != 3:
        raise ValueError("Triton candidate kernel requires matching [T,H,D] tensors")
    if q.shape[-1] != HEAD_DIM or not q.shape[0] or not q.shape[1] or q.shape[0] % BLOCK_SIZE:
        raise ValueError("Triton candidate kernel requires head_dim=128 and 64-token blocks")
    n_tokens, n_heads, _ = q.shape
    n_blocks = n_tokens // BLOCK_SIZE
    if selected.dim() != 3 or tuple(selected.shape[:2]) != (n_heads, n_blocks):
        raise ValueError("selected route shape does not match q and block_len")
    if block_len.shape != (n_blocks,) or block_len.device != q.device:
        raise ValueError("block_len must be one CUDA entry per attention block")
    if any(x.device != q.device or x.dtype not in (torch.bfloat16, torch.float32) for x in (k, v)):
        raise ValueError("q/k/v must share a device and use BF16/FP32 operands")
    if selected.device != q.device or selected.dtype not in (torch.int32, torch.int64):
        raise ValueError("selected must be integer routes on the input device")
    if block_len.dtype not in (torch.int32, torch.int64):
        raise ValueError("block_len must have integer dtype")
    if bool(((selected < -1) | (selected >= n_blocks)).any()):
        raise ValueError("selected contains an out-of-range block ID")
    if bool(((block_len < 0) | (block_len > BLOCK_SIZE)).any()):
        raise ValueError("block_len contains an out-of-range length")
    # Every pointer uses contiguous THD axes, including original V. Sharing
    # strides from a strided carrier with a contiguous original caused wrong
    # address arithmetic in the high-precision branch.
    q, k, v = (x.contiguous() for x in (q, k, v))
    residual_rowwise = residual is not None and residual[1].dim() == 4
    if residual is not None:
        residual_codes, residual_scale, residual_mean = residual
        code_shape = (n_blocks, BLOCK_SIZE, n_heads, HEAD_DIM)
        meta_shape = code_shape if residual_rowwise else (n_blocks, n_heads, HEAD_DIM)
        if tuple(residual_codes.shape) != code_shape or any(
            tuple(x.shape) != meta_shape for x in (residual_scale, residual_mean)
        ) or any(x.device != q.device for x in residual):
            raise ValueError("residual metadata shape/device mismatch")
        residual_codes = residual_codes.contiguous()
        residual_scale = residual_scale.contiguous()
        residual_mean = residual_mean.contiguous()
    else:
        residual_codes = residual_scale = residual_mean = q
    use_high_precision = high_precision is not None
    if original_v is None:
        original_v = v
    if original_v.shape != v.shape or original_v.device != q.device:
        raise ValueError("original_v shape/device mismatch")
    if high_precision is None:
        high_precision = torch.zeros_like(selected, dtype=torch.bool)
    else:
        # The kernel indexes route slots, whereas the caller indexes KV IDs.
        high_precision = compact_precision_flags(selected, high_precision)
    out = torch.empty_like(q)
    lse = torch.empty((n_tokens, n_heads), device=q.device, dtype=torch.float32)
    # One program owns one query block and one head: all 64 query rows share
    # the loaded Q tile and the route's K/V tiles.
    grid = (n_blocks, n_heads)
    _compact_attention_kernel[grid](
        q, k, v, out, selected.contiguous(), block_len.contiguous(),
        residual_codes, residual_scale, residual_mean,
        original_v.contiguous(), high_precision.contiguous(), lse,
        n_tokens, n_heads, n_blocks, selected.shape[-1],
        residual is not None, residual_rowwise, use_high_precision,
        anemoi_probability,
        q.stride(0), q.stride(1), k.stride(0), k.stride(1),
        v.stride(0), v.stride(1), out.stride(0), out.stride(1),
        BLOCK_SIZE=BLOCK_SIZE, HEAD_DIM=HEAD_DIM,
        BLOCK_D=triton.next_power_of_2(q.shape[-1]),
        # SM120's Triton matmul lowering otherwise stages too many tiles for
        # the 101 KiB shared-memory limit. One stage and two warps keep the
        # Q/K/PV tiles within that limit while preserving the tiled ABI.
        num_warps=2,
        num_stages=1,
    )
    return out, lse


__all__ = ["BLOCK_SIZE", "HEAD_DIM", "TRITON_AVAILABLE", "available", "run_compact_attention"]
