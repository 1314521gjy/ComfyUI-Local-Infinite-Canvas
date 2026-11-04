"""Triton preprocessing kernels for MiniMax H3 NVFP4 MLPs.

The quantization layout and FP4 packing follow comfy_kitchen's Apache-2.0
Triton NVFP4 quantizer.  This variant reads the two FC1 halves directly and
applies SwiGLU while producing FC2's packed NVFP4 input, avoiding the large
BF16 SwiGLU intermediate.
"""

from __future__ import annotations

import math

import torch


try:
    import triton
    import triton.language as tl
    from triton.language.extra import libdevice

    TRITON_AVAILABLE = True
    TRITON_IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - runtime dependent
    triton = None
    tl = None
    TRITON_AVAILABLE = False
    TRITON_IMPORT_ERROR = exc


F4_E2M1_MAX = 6.0
F8_E4M3_MAX = 448.0
NVFP4_GLOBAL_DENOMINATOR = F4_E2M1_MAX * F8_E4M3_MAX
PINNED_BLOCKS_PER_PROGRAM = (8, 16, 32, 64)


def roundup(value: int, multiple: int) -> int:
    return (value + multiple - 1) // multiple * multiple


def choose_blocks_per_program(total_blocks: int, pinned: int | None = None) -> int:
    """Auto occupancy is 1/2/8 from launch size; pinned values are 8/16/32/64. ``0``/None is auto."""
    if pinned is None or pinned == 0:
        return 1 if total_blocks < 1024 else (2 if total_blocks < 4096 else 8)
    if pinned not in PINNED_BLOCKS_PER_PROGRAM:
        raise ValueError(
            f"blocks_per_program must be 0 (auto) or one of {PINNED_BLOCKS_PER_PROGRAM}, got {pinned}"
        )
    return pinned


if TRITON_AVAILABLE:

    @triton.jit
    def _swiglu_value(gate, up, input_is_bf16: tl.constexpr, native_rounding: tl.constexpr):
        gate_f32 = gate.to(tl.float32)
        up_f32 = up.to(tl.float32)
        # PyTorch's CUDA SiLU uses the libdevice expf path. Triton's tl.sigmoid
        # uses a faster exp2 approximation that changes a small number of FP4
        # threshold decisions, so use libdevice here for the accurate mode.
        if native_rounding:
            activated = gate_f32 / (1.0 + libdevice.exp(-gate_f32))
        else:
            activated = gate_f32 * tl.sigmoid(gate_f32)
        if native_rounding:
            if input_is_bf16:
                activated = activated.to(tl.bfloat16).to(tl.float32)
                value = (activated * up_f32).to(tl.bfloat16).to(tl.float32)
            else:
                activated = activated.to(tl.float16).to(tl.float32)
                value = (activated * up_f32).to(tl.float16).to(tl.float32)
        else:
            value = activated * up_f32
        return value


    @triton.jit
    def _swiglu_amax_kernel(
        x_ptr,
        scale_ptr,
        element_count,
        output_width: tl.constexpr,
        input_stride_row: tl.constexpr,
        input_stride_col: tl.constexpr,
        input_is_bf16: tl.constexpr,
        native_rounding: tl.constexpr,
        BLOCK_SIZE: tl.constexpr,
    ):
        offsets = tl.program_id(0) * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)
        mask = offsets < element_count
        row = offsets // output_width
        col = offsets - row * output_width
        gate_offsets = row * input_stride_row + col * input_stride_col
        up_offsets = gate_offsets + output_width * input_stride_col
        gate = tl.load(x_ptr + gate_offsets, mask=mask, other=0.0)
        up = tl.load(x_ptr + up_offsets, mask=mask, other=0.0)
        value = _swiglu_value(gate, up, input_is_bf16, native_rounding)
        local_max = tl.max(tl.abs(value), axis=0)
        # Scale conversion is monotonic for non-negative values, therefore
        # max(round(local_max / 2688)) is bit-identical to
        # round(global_max / 2688). Folding it into this reduction removes a
        # tiny allocation and a second one-program kernel launch.
        local_scale = local_max / 2688.0
        if native_rounding:
            if input_is_bf16:
                local_scale = local_scale.to(tl.bfloat16).to(tl.float32)
            else:
                local_scale = local_scale.to(tl.float16).to(tl.float32)
        tl.atomic_max(scale_ptr, local_scale)


    @triton.jit
    def _compute_swizzled_scale_offset(in_row, in_col, n_col_blocks, padded_scale_cols):
        # cuBLAS 128x4 block-scale layout, matching comfy_kitchen.
        row_block = in_row // 128
        col_block = in_col // 4
        in_block_row = in_row % 128
        in_block_col = in_col % 4
        sub_block = in_block_row // 32
        fine_row = in_block_row % 32
        combined_block = row_block * n_col_blocks + col_block
        intermediate_col = sub_block * 4 + in_block_col
        linear_idx = combined_block * 512 + fine_row * 16 + intermediate_col
        out_row = linear_idx // padded_scale_cols
        out_col = linear_idx % padded_scale_cols
        return out_row * padded_scale_cols + out_col


    @triton.jit
    def _swiglu_quantize_nvfp4_kernel(
        x_ptr,
        packed_output_ptr,
        swizzled_scales_ptr,
        per_tensor_scale_ptr,
        real_rows,
        output_width: tl.constexpr,
        num_blocks: tl.constexpr,
        padded_scale_cols: tl.constexpr,
        input_stride_row: tl.constexpr,
        input_stride_col: tl.constexpr,
        input_is_bf16: tl.constexpr,
        native_rounding: tl.constexpr,
        blocks_per_program: tl.constexpr,
        hi_first: tl.constexpr,
    ):
        row = tl.program_id(axis=0)
        block_base = tl.program_id(axis=1) * blocks_per_program
        per_tensor_scale = tl.load(per_tensor_scale_ptr)
        pair_idx = tl.arange(0, 8)

        for block_offset in range(blocks_per_program):
            block = block_base + block_offset
            if block < num_blocks:
                even_col = block * 16 + pair_idx * 2
                odd_col = even_col + 1
                row_valid = row < real_rows
                even_valid = row_valid & (even_col < output_width)
                odd_valid = row_valid & (odd_col < output_width)
                base = row * input_stride_row

                gate_even = tl.load(
                    x_ptr + base + even_col * input_stride_col,
                    mask=even_valid,
                    other=0.0,
                )
                gate_odd = tl.load(
                    x_ptr + base + odd_col * input_stride_col,
                    mask=odd_valid,
                    other=0.0,
                )
                up_base = base + output_width * input_stride_col
                up_even = tl.load(
                    x_ptr + up_base + even_col * input_stride_col,
                    mask=even_valid,
                    other=0.0,
                )
                up_odd = tl.load(
                    x_ptr + up_base + odd_col * input_stride_col,
                    mask=odd_valid,
                    other=0.0,
                )

                value_even = _swiglu_value(
                    gate_even, up_even, input_is_bf16, native_rounding
                )
                value_odd = _swiglu_value(
                    gate_odd, up_odd, input_is_bf16, native_rounding
                )
                max_abs = tl.maximum(
                    tl.max(tl.abs(value_even), axis=0),
                    tl.max(tl.abs(value_odd), axis=0),
                )

                block_scale = max_abs / 6.0
                scaled_block_scale = tl.minimum(
                    block_scale / per_tensor_scale, 448.0
                )
                # Keep all-zero inputs well-defined (native quantizer also emits zero).
                scaled_block_scale = tl.where(
                    per_tensor_scale > 0.0, scaled_block_scale, 0.0
                )
                scaled_block_scale_fp8 = scaled_block_scale.to(tl.float8e4nv)

                n_col_blocks = tl.cdiv(num_blocks, 4)
                swizzled_offset = _compute_swizzled_scale_offset(
                    row, block, n_col_blocks, padded_scale_cols
                )
                tl.store(
                    swizzled_scales_ptr + swizzled_offset,
                    scaled_block_scale_fp8,
                    mask=(row < real_rows),
                )

                rounded_scale = scaled_block_scale_fp8.to(tl.float32)
                total_scale = per_tensor_scale * rounded_scale
                nonzero = total_scale >= 1.0e-10
                safe_scale = tl.where(nonzero, total_scale, 1.0)
                scaled_even = tl.where(nonzero, value_even / safe_scale, 0.0)
                scaled_odd = tl.where(nonzero, value_odd / safe_scale, 0.0)

                if hi_first:
                    asm_hi, asm_lo = scaled_even, scaled_odd
                else:
                    asm_hi, asm_lo = scaled_odd, scaled_even

                packed_u16 = tl.inline_asm_elementwise(
                    asm="""
                    {
                        .reg .b8 fp4_byte;
                        .reg .b16 result;
                        cvt.rn.satfinite.e2m1x2.f32 fp4_byte, $1, $2;
                        mov.b16 result, {fp4_byte, 0};
                        mov.u16 $0, result;
                    }
                    """,
                    constraints="=h,f,f",
                    args=[asm_hi, asm_lo],
                    dtype=tl.uint16,
                    is_pure=True,
                    pack=1,
                )
                packed = (packed_u16 & 0xFF).to(tl.uint8)
                output_offsets = (
                    row * (output_width // 2) + block * 8 + pair_idx
                )
                tl.store(
                    packed_output_ptr + output_offsets,
                    packed,
                    # Padded rows must be explicitly zero, not left as allocator
                    # garbage; the cuBLAS GEMM consumes all padded rows.
                    mask=(even_col < output_width),
                )


    @triton.jit
    def _swiglu_quantize_nvfp4_vector_kernel(
        x_ptr,
        packed_output_ptr,
        swizzled_scales_ptr,
        per_tensor_scale_ptr,
        real_rows,
        packed_rows: tl.constexpr,
        output_width: tl.constexpr,
        num_blocks: tl.constexpr,
        padded_scale_cols: tl.constexpr,
        input_stride_row: tl.constexpr,
        input_stride_col: tl.constexpr,
        input_is_bf16: tl.constexpr,
        native_rounding: tl.constexpr,
        blocks_per_program: tl.constexpr,
        hi_first: tl.constexpr,
    ):
        """Vectorized row/block quantizer.

        The original implementation looped over four 16-value blocks while
        each loop iteration occupied only eight lanes.  Keeping the block and
        pair dimensions explicit lets one warp process all four blocks at once
        and removes the serial loop from this very large launch grid.
        """
        row = tl.program_id(axis=0)
        block = (
            tl.program_id(axis=1) * blocks_per_program
            + tl.arange(0, blocks_per_program)
        )
        pair = tl.arange(0, 8)
        even_col = block[:, None] * 16 + pair[None, :] * 2
        odd_col = even_col + 1
        block_valid = block < num_blocks
        row_valid = row < real_rows
        value_valid = row_valid & block_valid[:, None]
        base = row * input_stride_row
        up_base = base + output_width * input_stride_col
        gate_even = tl.load(
            x_ptr + base + even_col * input_stride_col,
            mask=value_valid,
            other=0.0,
        )
        gate_odd = tl.load(
            x_ptr + base + odd_col * input_stride_col,
            mask=value_valid,
            other=0.0,
        )
        up_even = tl.load(
            x_ptr + up_base + even_col * input_stride_col,
            mask=value_valid,
            other=0.0,
        )
        up_odd = tl.load(
            x_ptr + up_base + odd_col * input_stride_col,
            mask=value_valid,
            other=0.0,
        )
        value_even = _swiglu_value(
            gate_even, up_even, input_is_bf16, native_rounding
        )
        value_odd = _swiglu_value(
            gate_odd, up_odd, input_is_bf16, native_rounding
        )

        max_abs = tl.maximum(
            tl.max(tl.abs(value_even), axis=1),
            tl.max(tl.abs(value_odd), axis=1),
        )
        per_tensor_scale = tl.load(per_tensor_scale_ptr)
        block_scale = max_abs / 6.0
        scaled_block_scale = tl.minimum(block_scale / per_tensor_scale, 448.0)
        scaled_block_scale = tl.where(
            per_tensor_scale > 0.0, scaled_block_scale, 0.0
        )
        scaled_block_scale_fp8 = scaled_block_scale.to(tl.float8e4nv)

        n_col_blocks = tl.cdiv(num_blocks, 4)
        swizzled_offset = _compute_swizzled_scale_offset(
            row, block, n_col_blocks, padded_scale_cols
        )
        tl.store(
            swizzled_scales_ptr + swizzled_offset,
            scaled_block_scale_fp8,
            mask=block_valid,
        )

        total_scale = per_tensor_scale * scaled_block_scale_fp8.to(tl.float32)
        nonzero = total_scale >= 1.0e-10
        safe_scale = tl.where(nonzero, total_scale, 1.0)
        scaled_even = tl.where(
            nonzero[:, None], value_even / safe_scale[:, None], 0.0
        )
        scaled_odd = tl.where(
            nonzero[:, None], value_odd / safe_scale[:, None], 0.0
        )
        if hi_first:
            asm_hi, asm_lo = scaled_even, scaled_odd
        else:
            asm_hi, asm_lo = scaled_odd, scaled_even
        packed_u16 = tl.inline_asm_elementwise(
            asm="""
            {
                .reg .b8 fp4_byte;
                .reg .b16 result;
                cvt.rn.satfinite.e2m1x2.f32 fp4_byte, $1, $2;
                mov.b16 result, {fp4_byte, 0};
                mov.u16 $0, result;
            }
            """,
            constraints="=h,f,f",
            args=[asm_hi, asm_lo],
            dtype=tl.uint16,
            is_pure=True,
            pack=1,
        )
        packed = (packed_u16 & 0xFF).to(tl.uint8)
        output_offsets = row * (output_width // 2) + block[:, None] * 8 + pair[None, :]
        # Padded rows must be explicitly zero: cuBLAS consumes all of them.
        tl.store(
            packed_output_ptr + output_offsets,
            packed,
            mask=(row < packed_rows) & block_valid[:, None],
        )


    @triton.jit
    def _zero_swizzled_scale_rows_kernel(
        swizzled_scales_ptr,
        first_row,
        row_count,
        num_blocks: tl.constexpr,
        padded_scale_cols: tl.constexpr,
        BLOCKS: tl.constexpr,
    ):
        row_offset = tl.program_id(0)
        block = tl.program_id(1) * BLOCKS + tl.arange(0, BLOCKS)
        row = first_row + row_offset
        block_valid = block < num_blocks
        n_col_blocks = tl.cdiv(num_blocks, 4)
        swizzled_offset = _compute_swizzled_scale_offset(
            row, block, n_col_blocks, padded_scale_cols
        )
        tl.store(
            swizzled_scales_ptr + swizzled_offset,
            0.0,
            mask=(row_offset < row_count) & block_valid,
        )


def fused_swiglu_quantize_nvfp4(
    x: torch.Tensor,
    *,
    precision: str = "native_rounding",
    tensor_scale: torch.Tensor | None = None,
    blocks_per_program: int | None = None,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, tuple[int, int]]:
    """Apply SwiGLU and emit cuBLAS-compatible NVFP4 data and scales.

    Returns ``(packed, tensor_scale, block_scales, original_shape)``.
    ``x`` is FC1 output with shape ``[M, 2*K]``; the logical quantized shape is
    ``[M, K]``. Rows are padded to 16 for the NVFP4 GEMM as needed.

    ``blocks_per_program`` of ``None``/``0`` keeps the historical auto 1/2/8
    occupancy. Amax is a per-program atomic (B1 hierarchical / B5 materialize
    were measured and removed).
    """
    if not TRITON_AVAILABLE:
        raise RuntimeError(f"Triton is unavailable: {TRITON_IMPORT_ERROR}")
    if not x.is_cuda:
        raise ValueError("fused NVFP4 preprocessing requires a CUDA tensor")
    if x.ndim != 2 or x.shape[1] % 2:
        raise ValueError(f"expected a 2D [M, 2*K] tensor, got {tuple(x.shape)}")
    if x.dtype not in (torch.bfloat16, torch.float16):
        raise ValueError(f"expected BF16 or FP16 input, got {x.dtype}")
    if precision not in ("native_rounding", "fast_fp32"):
        raise ValueError(f"unknown precision mode: {precision}")

    x = x if x.stride(-1) == 1 else x.contiguous()
    rows = x.shape[0]
    output_width = x.shape[1] // 2
    if output_width % 16:
        raise ValueError(
            f"activated width must be divisible by 16, got {output_width}"
        )

    padded_rows = roundup(rows, 16)
    scale_rows = roundup(padded_rows, 128)
    scale_cols = roundup(output_width // 16, 4)
    packed = torch.empty(
        (padded_rows, output_width // 2), dtype=torch.uint8, device=x.device
    )
    block_scales = torch.empty(
        (scale_rows, scale_cols), dtype=torch.float8_e4m3fn, device=x.device
    )
    native_rounding = precision == "native_rounding"
    input_is_bf16 = x.dtype == torch.bfloat16
    try:
        from ...nvtx import nvtx_range
    except ImportError:
        from contextlib import nullcontext as nvtx_range
    if tensor_scale is None:
        tensor_scale = torch.zeros((1,), dtype=torch.float32, device=x.device)
        elements = rows * output_width
        amax_block = 1024
        n_programs = triton.cdiv(elements, amax_block)
        with nvtx_range("mlp_amax"):
            _swiglu_amax_kernel[(n_programs,)](
                x,
                tensor_scale,
                elements,
                output_width=output_width,
                input_stride_row=x.stride(0),
                input_stride_col=x.stride(1),
                input_is_bf16=input_is_bf16,
                native_rounding=native_rounding,
                BLOCK_SIZE=amax_block,
                num_warps=4,
            )
    else:
        if tensor_scale.device != x.device or tensor_scale.dtype != torch.float32:
            raise ValueError("cached tensor_scale must be FP32 on the input CUDA device")
        if tensor_scale.numel() != 1:
            raise ValueError("cached tensor_scale must contain exactly one value")
        tensor_scale = tensor_scale.reshape(1)

    num_blocks = output_width // 16
    total_blocks = padded_rows * num_blocks
    blocks_per_program = choose_blocks_per_program(total_blocks, blocks_per_program)
    grid = (padded_rows, triton.cdiv(num_blocks, blocks_per_program))
    with nvtx_range("mlp_pack"):
        _swiglu_quantize_nvfp4_vector_kernel[grid](
            x,
            packed,
            block_scales,
            tensor_scale,
            rows,
            packed_rows=padded_rows,
            output_width=output_width,
            num_blocks=num_blocks,
            padded_scale_cols=scale_cols,
            input_stride_row=x.stride(0),
            input_stride_col=x.stride(1),
            input_is_bf16=input_is_bf16,
            native_rounding=native_rounding,
            blocks_per_program=blocks_per_program,
            hi_first=True,
            num_warps=2,
        )
    if scale_rows > padded_rows:
        zero_blocks = 256
        _zero_swizzled_scale_rows_kernel[
            (scale_rows - padded_rows, triton.cdiv(num_blocks, zero_blocks))
        ](
            block_scales,
            padded_rows,
            scale_rows - padded_rows,
            num_blocks=num_blocks,
            padded_scale_cols=scale_cols,
            BLOCKS=zero_blocks,
            num_warps=4,
        )
    return packed, tensor_scale, block_scales, (rows, output_width)


def runtime_description() -> str:
    if not TRITON_AVAILABLE:
        return f"Triton unavailable ({TRITON_IMPORT_ERROR})"
    return f"Triton {getattr(triton, '__version__', 'unknown')}"
