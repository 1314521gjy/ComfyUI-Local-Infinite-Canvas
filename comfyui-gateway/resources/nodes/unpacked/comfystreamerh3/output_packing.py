"""GPU-side final-video packing for the streamed VAE output.

The normal path deliberately remains Torch reference code.  The Triton path is
opt-in and fuses the BCTHW -> NHWC layout conversion with the existing
multiply/clamp/uint8 conversion so the intermediate floating-point NHWC
buffer is not materialized.
"""

from __future__ import annotations

from typing import Any

import torch

_TRITON_PACK_KERNEL = None


def _reference_pack(part: torch.Tensor) -> torch.Tensor:
    if part.ndim != 5 or part.shape[1] < 3:
        raise ValueError("part must have shape (batch, channels>=3, time, height, width)")
    batch, _channels, time, height, width = part.shape
    nhwc = part[:, :3].permute(0, 2, 3, 4, 1).reshape(batch * time, height, width, 3)
    return (nhwc * 255).clamp(0, 255).to(torch.uint8).contiguous()


def triton_pack_available() -> tuple[bool, str]:
    if not torch.cuda.is_available():
        return False, "CUDA is unavailable"
    try:
        import triton
        import triton.language  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - optional Triton must fail closed
        return False, f"Triton import failed: {type(exc).__name__}: {exc}"
    return True, "available"


def _triton_pack(part: torch.Tensor) -> torch.Tensor:
    import triton
    import triton.language as tl

    if part.ndim != 5 or part.shape[1] < 3:
        raise ValueError("part must have shape (batch, channels>=3, time, height, width)")
    if part.device.type != "cuda":
        raise ValueError("Triton output packing requires a CUDA tensor")
    if not part.is_floating_point():
        raise TypeError("part must be floating point")

    batch, _channels, time, height, width = (int(value) for value in part.shape)
    output = torch.empty((batch * time, height, width, 3), dtype=torch.uint8, device=part.device)
    n_elements = output.numel()

    global _TRITON_PACK_KERNEL
    if _TRITON_PACK_KERNEL is None:
        @triton.jit
        def pack_kernel(
            input_ptr, output_ptr, n_elements,
            stride_batch: tl.constexpr, stride_channel: tl.constexpr,
            stride_time: tl.constexpr, stride_height: tl.constexpr,
            stride_width: tl.constexpr, time: tl.constexpr,
            height: tl.constexpr, width: tl.constexpr,
            BLOCK: tl.constexpr,
        ):
            offsets = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
            mask = offsets < n_elements
            channel = offsets % 3
            pixel = offsets // 3
            x = pixel % width
            pixel = pixel // width
            y = pixel % height
            frame = pixel // height
            batch_index = frame // time
            time_index = frame % time
            input_offsets = (
                batch_index * stride_batch
                + channel * stride_channel
                + time_index * stride_time
                + y * stride_height
                + x * stride_width
            )
            values = tl.load(input_ptr + input_offsets, mask=mask, other=0.0)
            values = tl.maximum(tl.minimum(values * 255.0, 255.0), 0.0)
            tl.store(output_ptr + offsets, values.to(tl.uint8), mask=mask)
        _TRITON_PACK_KERNEL = pack_kernel

    block = 256
    _TRITON_PACK_KERNEL[(triton.cdiv(n_elements, block),)](
        part, output, n_elements,
        stride_batch=int(part.stride(0)),
        stride_channel=int(part.stride(1)),
        stride_time=int(part.stride(2)),
        stride_height=int(part.stride(3)),
        stride_width=int(part.stride(4)),
        time=time, height=height, width=width, BLOCK=block,
    )
    return output


def pack_finalized_rgb24(
    part: torch.Tensor,
    *,
    backend: str = "reference",
    report: dict[str, Any] | None = None,
) -> torch.Tensor:
    """Pack finalized floating BCTHW pixels into contiguous RGB24 uint8.

    ``backend='triton'`` is strict: callers asking for the experiment receive
    an error instead of silently falling back.  The stream integration catches
    that error only when the caller explicitly requested production fallback.
    """
    if not isinstance(part, torch.Tensor):
        raise TypeError("part must be a torch.Tensor")
    if not part.is_floating_point():
        raise TypeError("part must be floating point")
    if backend not in ("reference", "triton"):
        raise ValueError("backend must be reference or triton")
    if backend == "reference":
        result = _reference_pack(part)
        actual = "reference"
    else:
        available, reason = triton_pack_available()
        if not available:
            raise RuntimeError(f"fused_output_pack unavailable: {reason}")
        result = _triton_pack(part)
        actual = "triton"
    if report is not None:
        report.update(
            requested=backend,
            backend=actual,
            input_shape=list(part.shape),
            output_shape=list(result.shape),
            last_eliminated_nhwc_float_bytes=(
                int(part.shape[0] * part.shape[2] * part.shape[3] * part.shape[4] * 3 * part.element_size())
                if actual == "triton" else 0
            ),
        )
    return result


__all__ = ["pack_finalized_rgb24", "triton_pack_available"]
