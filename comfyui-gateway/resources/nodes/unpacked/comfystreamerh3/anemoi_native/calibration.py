"""Actual-data NVFP4 calibration on the existing Kitchen measurement traversal."""

import math
from dataclasses import dataclass, field

import torch


def scales_from_amax(maxima: torch.Tensor, *, range_margin=1.0, _trusted=False):
    """NVFP4 tensor scale = observed absmax / (E2M1max * E4M3max)."""
    if maxima.shape != (3,) or maxima.dtype != torch.float32:
        raise ValueError("NV calibration maxima must be FP32 [Q,K,V]")
    if not math.isfinite(range_margin) or range_margin < 1:
        raise ValueError("range_margin must be finite and at least 1")
    if not _trusted and (not torch.isfinite(maxima).all() or (maxima < 0).any()):
        raise ValueError("NV calibration maxima must be finite nonnegative")
    target = maxima * range_margin
    if not _trusted and not torch.isfinite(target).all():
        raise ValueError("range_margin overflows measured FP32 range")
    scales = target / 2688.0
    # At most one ULP upward prevents a freshly calibrated observed maximum
    # from falsely exceeding its range due to division/multiply rounding.
    scales = torch.where(
        scales * 2688.0 < target,
        torch.nextafter(scales, torch.full_like(scales, float("inf"))),
        scales,
    )
    return tuple(
        torch.where(
            scales[i : i + 1] > 0, scales[i : i + 1], torch.ones_like(scales[i : i + 1])
        ).contiguous()
        for i in range(3)
    )


@dataclass
class CalibrationCollector:
    maxima: torch.Tensor
    centered: bool
    chunks: int = 0
    represented_means: dict = field(default_factory=dict)
    use_native: bool = False
    work_savings: dict = field(default_factory=lambda: {
        "native_measurement_launches": 0, "native_measurement_fallback_chunks": 0,
        "dtype_copy_calls_eliminated": 0, "dtype_copy_bytes_eliminated": 0,
        "padding_calls_eliminated": 0, "padding_bytes_eliminated": 0,
        "value_gather_calls_eliminated": 0, "value_gather_bytes_eliminated": 0,
        "int64_index_allocations_eliminated": 0, "int64_index_bytes_eliminated": 0,
    })

    @classmethod
    def create(cls, device, *, centered, use_native=False):
        return cls(torch.zeros(3, dtype=torch.float32, device=device), centered, use_native=use_native)

    def measure(self, t0, q, k, v, valid, permutation, means):
        """Original bounded BHMD; optional shared permutation and BF16 means.

        Q/K follow the donor half-narrowing boundary. Mean subtraction uses
        the exact shared represented BF16 value, not a freshly recomputed mean.
        """
        blocks = (q.shape[2] + 63) // 64
        length = q.shape[2]
        if self.use_native:
            from .adapter import _extension
            extension = _extension() if q.is_cuda else None
            function = getattr(extension, "measure_chunk", None)
            if (getattr(extension, "supports_prepare_fusion", False) is True
                    and callable(function) and all(x.is_contiguous() for x in (q, k, v))):
                b, h = q.shape[:2]
                valid_chunk = valid[:, t0 // 64:t0 // 64 + blocks]
                metadata_copies = 0
                metadata_bytes = 0
                if not valid_chunk.is_contiguous():
                    metadata_copies += 1
                    metadata_bytes += valid_chunk.numel() * valid_chunk.element_size()
                    valid_chunk = valid_chunk.contiguous()
                permutation_chunk = permutation
                if permutation_chunk is not None and not permutation_chunk.is_contiguous():
                    metadata_copies += 1
                    metadata_bytes += permutation_chunk.numel() * permutation_chunk.element_size()
                    permutation_chunk = permutation_chunk.contiguous()
                means_chunk = means
                if means_chunk is not None and not means_chunk.is_contiguous():
                    metadata_copies += 1
                    metadata_bytes += means_chunk.numel() * means_chunk.element_size()
                    means_chunk = means_chunk.contiguous()
                if self.centered:
                    if (means is None or means.dtype != torch.bfloat16
                            or means.shape[:3] != (b, h, blocks) or means.shape[3] not in (1, 4)):
                        raise ValueError("combined calibration requires shared represented G1/G4 means")
                    self.represented_means[t0] = means.detach().clone()
                function(
                    q, k, v, valid_chunk,
                    permutation_chunk if self.centered and permutation_chunk is not None
                    else q.new_empty((0,), dtype=torch.uint8),
                    means_chunk if self.centered and means_chunk is not None
                    else q.new_empty((0,), dtype=torch.bfloat16),
                    self.maxima,
                )
                size = b * h * blocks * 64 * 128
                savings = self.work_savings
                savings["native_measurement_launches"] += 1
                # Conservative inventory of specific reference temporaries only:
                # excludes where/abs/mask/reduction/mean-expansion allocations.
                half_copies = 3 if q.dtype != torch.float16 else 0
                savings["dtype_copy_calls_eliminated"] += 3 + half_copies
                savings["dtype_copy_bytes_eliminated"] += size * (3*4 + half_copies*2)
                savings["metadata_copy_calls"] = savings.get("metadata_copy_calls", 0) + metadata_copies
                savings["metadata_copy_bytes"] = savings.get("metadata_copy_bytes", 0) + metadata_bytes
                if length % 64:
                    savings["padding_calls_eliminated"] += 3
                    savings["padding_bytes_eliminated"] += 3 * size * q.element_size()
                if self.centered and permutation is not None:
                    savings["value_gather_calls_eliminated"] += 1
                    savings["value_gather_bytes_eliminated"] += size * 4
                    savings["int64_index_allocations_eliminated"] += 1
                    savings["int64_index_bytes_eliminated"] += permutation.numel() * 8
                self.chunks += 1
                return
            self.work_savings["native_measurement_fallback_chunks"] += 1
        if length % 64:
            q, k, v = (
                torch.nn.functional.pad(x, (0, 0, 0, blocks * 64 - length)) for x in (q, k, v)
            )
        b, h = q.shape[:2]
        valid = valid[:, t0 // 64 : t0 // 64 + blocks]
        live = (torch.arange(64, device=q.device)[None, None, :] < valid[:, :, None])[
            :, None, :, :, None
        ]
        q, k, v = (x.half().float().reshape(b, h, blocks, 64, 128) for x in (q, k, v))
        qa = torch.where(live, q, 0).abs().amax()
        ka = torch.where(live, k, 0).abs().amax()
        if self.centered:
            if means is None or means.dtype != torch.bfloat16 or means.shape[:3] != (b, h, blocks):
                raise ValueError(
                    "combined calibration requires represented means from shared producer"
                )
            self.represented_means[t0] = means.detach().clone()
            if permutation is not None:
                order = permutation.to(torch.int64)[..., None].expand_as(v)
                v = v.gather(3, order)
            groups = means.shape[3]
            if groups not in (1, 4):
                raise ValueError("combined calibration means require G1/G4")
            v = v - means.float().repeat_interleave(64 // groups, dim=3)
        va = torch.where(live, v, 0).abs().amax()
        measured = torch.stack((qa, ka, va))
        torch.maximum(self.maxima, measured, out=self.maxima)
        self.chunks += 1


def previous_calibration(state, identity):
    if state is None:
        return None
    if "scope" not in state:
        raise ValueError("calibration_state requires caller-owned scope=(request_id,layer_id)")
    cached = state.get("_anemoi_nv_calibration")
    return (
        cached if cached is not None and cached["identity"] == (state["scope"], identity) else None
    )


def retain_calibration(
    state, identity, maxima, clipping_counts, *, original_vamax=None, centered=None
):
    if state is not None:
        state["_anemoi_nv_calibration"] = {
            "identity": (state["scope"], identity),
            "maxima": maxima.detach(),
            "clipping_counts": clipping_counts.detach(),
            "original_vamax": None if original_vamax is None else original_vamax.detach(),
            "centered": centered,
        }
