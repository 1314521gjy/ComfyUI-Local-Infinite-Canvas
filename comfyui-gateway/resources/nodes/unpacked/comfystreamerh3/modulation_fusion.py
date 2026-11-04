"""Three-segment modulation experiment with exact-operation fallback."""
from __future__ import annotations

import torch

try:  # Triton is present on the CUDA worker but optional for offline tests.
    import triton
    import triton.language as tl
    TRITON_AVAILABLE = True
except ImportError:  # pragma: no cover - CPU-only contracts
    triton = tl = None
    TRITON_AVAILABLE = False


def _scalar_rows(segments):
    return len(segments) == 3 and all(type(row) is int for _, _, row in segments)


def scale_shift(h, shift, scale, segments, native):
    if not _scalar_rows(segments):
        return native(h, shift, scale, segments), False
    parts = [h[a:b] for a, b, _ in segments]
    scales = [1.0 + scale[row].to(h.dtype) for _, _, row in segments]
    shifts = [shift[row].to(h.dtype) for _, _, row in segments]
    try:
        torch._foreach_mul_(parts, scales)
        torch._foreach_add_(parts, shifts)
    except RuntimeError:
        return native(h, shift, scale, segments), False
    return h, True


def gate(x, values, other, segments, native):
    if not _scalar_rows(segments):
        return native(x, values, other, segments), False
    destinations = [x[a:b] for a, b, _ in segments]
    sources = [other[a:b] for a, b, _ in segments]
    gates = [values[row].to(x.dtype) for _, _, row in segments]
    try:
        torch._foreach_addcmul_(destinations, sources, gates)
    except RuntimeError:
        return native(x, values, other, segments), False
    return x, True


def _kernel_eligible(x, rows, *vectors):
    return (TRITON_AVAILABLE and x.is_cuda and x.dtype == torch.bfloat16
            and x.ndim == 2 and x.is_contiguous() and len(rows) == 3
            and rows[0][0] == 0 and rows[0][1] == rows[1][0]
            and rows[1][1] == rows[2][0] and rows[2][1] == x.shape[0]
            and all(type(row) is int for _, _, row in rows)
            and all(v.ndim == 2 and v.stride(1) == 1 and v.shape[1] == x.shape[1]
                    for v in vectors))


def _staged_kernel_eligible(x, rows, *vectors):
    if not _kernel_eligible(x, rows, *vectors):
        return False
    return (
        all(type(start) is int and type(stop) is int and 0 <= start <= stop
            for start, stop, _ in rows)
        and all(v.device == x.device for v in vectors)
        and all(0 <= row < v.shape[0] for _, _, row in rows for v in vectors)
    )


if TRITON_AVAILABLE:
    @triton.jit
    def _scale_shift_bf16(h, shift, scale, rows, width: tl.constexpr,
                          shift_stride0, scale_stride0,
                          stop0: tl.constexpr, stop1: tl.constexpr,
                          mod0: tl.constexpr, mod1: tl.constexpr, mod2: tl.constexpr,
                          elements: tl.constexpr, BLOCK: tl.constexpr):
        offsets = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        mask = offsets < elements
        token = offsets // width
        col = offsets % width
        mod = tl.where(token < stop0, mod0, tl.where(token < stop1, mod1, mod2))
        value = tl.load(h + offsets, mask=mask).to(tl.bfloat16)
        scale_v = tl.load(scale + mod * scale_stride0 + col, mask=mask).to(tl.bfloat16)
        shift_v = tl.load(shift + mod * shift_stride0 + col, mask=mask).to(tl.bfloat16)
        tl.store(h + offsets, value * (1.0 + scale_v) + shift_v, mask=mask)


    @triton.jit
    def _scale_shift_staged_bf16(h, shift, scale, width: tl.constexpr,
                                 shift_stride0, scale_stride0,
                                 stop0: tl.constexpr, stop1: tl.constexpr,
                                 mod0: tl.constexpr, mod1: tl.constexpr,
                                 mod2: tl.constexpr, elements: tl.constexpr,
                                 BLOCK: tl.constexpr):
        """Match native BF16 scale/shift rounding in one launch.

        Native H3 materializes the BF16 scale factor, stores the BF16 product,
        then launches the add.  Each explicit conversion below is therefore a
        semantic boundary, rather than a precision optimization.
        """
        offsets = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        mask = offsets < elements
        token = offsets // width
        col = offsets % width
        mod = tl.where(token < stop0, mod0, tl.where(token < stop1, mod1, mod2))
        value = tl.load(h + offsets, mask=mask).to(tl.bfloat16)
        scale_v = tl.load(scale + mod * scale_stride0 + col, mask=mask).to(tl.bfloat16)
        shift_v = tl.load(shift + mod * shift_stride0 + col, mask=mask).to(tl.bfloat16)
        factor = (1.0 + scale_v).to(tl.bfloat16)
        scaled = (value * factor).to(tl.bfloat16)
        result = (scaled + shift_v).to(tl.bfloat16)
        tl.store(h + offsets, result, mask=mask)


    @triton.jit
    def _gate_bf16(x, values, other, rows, width: tl.constexpr, values_stride0,
                   stop0: tl.constexpr, stop1: tl.constexpr,
                   mod0: tl.constexpr, mod1: tl.constexpr, mod2: tl.constexpr,
                   elements: tl.constexpr, BLOCK: tl.constexpr):
        offsets = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
        mask = offsets < elements
        token = offsets // width
        col = offsets % width
        mod = tl.where(token < stop0, mod0, tl.where(token < stop1, mod1, mod2))
        base = tl.load(x + offsets, mask=mask).to(tl.bfloat16)
        incoming = tl.load(other + offsets, mask=mask).to(tl.bfloat16)
        gate_v = tl.load(values + mod * values_stride0 + col, mask=mask).to(tl.bfloat16)
        tl.store(x + offsets, base + incoming * gate_v, mask=mask)


def scale_shift_kernel(h, shift, scale, segments, native):
    """One BF16 CUDA launch for all three contiguous modality segments.

    This is deliberately a numerical experiment: native code casts each row
    before two separate in-place operations, while this kernel performs the
    equivalent expression in one launch. Unsupported layouts use the exact
    native implementation.
    """
    if not _kernel_eligible(h, segments, shift, scale):
        return native(h, shift, scale, segments), False
    (_, stop0, row0), (_, stop1, row1), (_, _, row2) = segments
    elements = h.numel()
    _scale_shift_bf16[(triton.cdiv(elements, 256),)](
        h, shift, scale, h.shape[0], h.shape[1], shift.stride(0), scale.stride(0), stop0, stop1, row0, row1,
        row2, elements, BLOCK=256)
    return h, True


def scale_shift_staged_kernel(h, shift, scale, segments, native):
    """Fuse segment dispatch while preserving native BF16 rounding stages.

    This arm deliberately covers scale/shift only.  Gate residual accumulation
    remains on native ``addcmul_`` and the killed B15 kernel remains available
    only behind its separate flag.
    """
    if not _staged_kernel_eligible(h, segments, shift, scale):
        return native(h, shift, scale, segments), False
    (_, stop0, row0), (_, stop1, row1), (_, _, row2) = segments
    elements = h.numel()
    _scale_shift_staged_bf16[(triton.cdiv(elements, 256),)](
        h, shift, scale, h.shape[1], shift.stride(0), scale.stride(0),
        stop0, stop1, row0, row1, row2, elements, BLOCK=256)
    return h, True


def gate_kernel(x, values, other, segments, native):
    if not _kernel_eligible(x, segments, values, other):
        return native(x, values, other, segments), False
    (_, stop0, row0), (_, stop1, row1), (_, _, row2) = segments
    elements = x.numel()
    _gate_bf16[(triton.cdiv(elements, 256),)](
        x, values, other, x.shape[0], x.shape[1], values.stride(0), stop0, stop1, row0, row1,
        row2, elements, BLOCK=256)
    return x, True
