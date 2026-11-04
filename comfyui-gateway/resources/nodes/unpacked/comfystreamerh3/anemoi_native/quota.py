"""Device-resident deterministic precision assignment; never selects new pairs."""

import math
from dataclasses import dataclass

import torch

SCORE_POLICY = "kitchen-score-head-hamilton-v1"
ORDER_POLICY = "kitchen-route-order-head-hamilton-v1"


def phase_metadata_savings(batch, heads, queries, capacity, *, enabled):
    """Exact reference allocations/copies omitted by optimized native metadata.

    Counts are geometry-only, not estimated latency or ATen kernel counts.
    Segment offsets share make_quotas, so no offset-generation launch is added.
    Planar counts are returned as views; original interleaved scalar/empty
    planes already need no contiguous copy and receive no allocation credit.
    """
    bh = batch * heads
    rows = bh * queries
    items = rows * capacity
    large = bool(enabled and items and queries * capacity > 256)
    small = bool(enabled and items and queries * capacity <= 256)
    copies = 3 if enabled and rows > 1 else 0
    # Large routes use three identical segmented scans. Native phase
    # assignment now scans all three planes in one launch, with separate CUB
    # state/carries and no change to the resulting positions.
    scan_before = 3 if large else 0
    scan_after = 1 if large else 0
    return {
        "enabled": enabled,
        "phase_count_copy_calls_eliminated": copies,
        "phase_count_allocations_eliminated": copies,
        "phase_count_copy_bytes_eliminated": copies * rows * 4,
        "host_offset_allocations_eliminated": 2 * int(large),
        "host_offset_allocation_bytes_eliminated": 8 * bh * int(large),
        "host_to_device_copy_calls_eliminated": 2 * int(large),
        "host_to_device_copy_bytes_eliminated": 8 * bh * int(large),
        "unused_quota_allocations_eliminated": int(small),
        "unused_quota_allocation_bytes_eliminated": 12 * bh * int(small),
        "offset_generation_kernel_launches_added": 0,
        "phase_scan_launches_before": scan_before,
        "phase_scan_launches_after": scan_after,
        "phase_scan_launches_eliminated": scan_before - scan_after,
    }


@dataclass(frozen=True)
class PrecisionPolicy:
    # Explicit ratios: no implicit mixed default or calibration constants.
    ratios: tuple[float, float, float]  # FP16, INT8, NVFP4
    name: str = SCORE_POLICY
    global_scales: tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None = None
    range_margin: float = 1.0

    def __post_init__(self):
        if self.name not in (SCORE_POLICY, ORDER_POLICY):
            raise ValueError("unknown versioned precision policy")
        if not math.isfinite(self.range_margin) or self.range_margin < 1:
            raise ValueError("NV measured range_margin must be finite and at least 1")
        if len(self.ratios) != 3 or any(not math.isfinite(x) or x < 0 for x in self.ratios):
            raise ValueError("three finite nonnegative ratios required in FP16/INT8/NVFP4 order")
        if not math.isclose(sum(self.ratios), 1.0, rel_tol=0.0, abs_tol=1e-12):
            raise ValueError("precision ratios must sum to one")


def assign_phases(
    route_ids, counts, policy: PrecisionPolicy, original_scores=None, *, _trusted=False
):
    """Hamilton per B/head over selected pairs, stable query/key tie breaking.

    Returns IDs compacted into NVFP4,INT8,FP16 segments and phase counts.
    Score policy consumes original raw Kitchen log2 block scores [B,H,Q,K].
    Route-order control consumes original query-major/slot-major order.
    This does not recompute scores, add pairs, remove neighbors, or use CPU lists.
    """
    if route_ids.dtype != torch.int32 or route_ids.ndim != 4:
        raise ValueError("route IDs must be int32 [B,H,Q,capacity]")
    if (
        counts.dtype != torch.int32
        or counts.shape != route_ids.shape[:3]
        or counts.device != route_ids.device
    ):
        raise ValueError("counts must be int32 [B,H,Q] on route device")
    b, h, q, cap = route_ids.shape
    if policy.name == SCORE_POLICY and (
        original_scores is None
        or original_scores.ndim != 4
        or original_scores.shape[:3] != (b, h, q)
        or original_scores.device != counts.device
    ):
        raise ValueError("score policy requires original Kitchen [B,H,Q,K] scores")
    if route_ids.is_cuda and policy.name == SCORE_POLICY:
        from .adapter import native_phase_assign

        compact, nvfp4, int8, fp16 = native_phase_assign(
            route_ids.contiguous(), counts.contiguous(), original_scores.contiguous(), policy.ratios
        )
        return compact, {"nvfp4": nvfp4, "int8": int8, "fp16": fp16}
    # Flatten batch/head dimensions while preserving per-row quotas and tie order;
    # this keeps assignment device-resident with one bounded sort per ordering stage.
    if not _trusted and ((counts < 0) | (counts > cap)).any():
        raise ValueError("counts outside route capacity")
    if cap == 0:
        return route_ids.clone(), {
            name: torch.zeros_like(counts) for name in ("nvfp4", "int8", "fp16")
        }
    active = torch.arange(cap, device=route_ids.device) < counts[..., None]
    safe = torch.where(active, route_ids, 0).to(torch.int64)
    if not _trusted and (safe < 0).any():
        raise ValueError("negative active key ID")
    flat_active = active.reshape(b, h, -1)
    total = counts.to(torch.int64).sum(-1)
    ratios = torch.tensor(policy.ratios, dtype=torch.float64, device=counts.device)
    exact = total[..., None] * ratios
    quota = exact.floor().to(torch.int64)
    remainder = total - quota.sum(-1)
    fraction_order = torch.argsort(exact - quota, dim=-1, descending=True, stable=True)
    extra = (torch.arange(3, device=counts.device) < remainder[..., None]).to(torch.int64)
    quota = quota.scatter_add(-1, fraction_order, extra)

    if policy.name == SCORE_POLICY:
        if not _trusted and (safe >= original_scores.shape[-1]).any():
            raise ValueError("active key ID exceeds score width")
        score = original_scores.gather(-1, safe)
        if not _trusted and not torch.isfinite(score[active]).all():
            raise ValueError("selected Kitchen scores must be finite")
        # First establish ascending (query,keyID), then stable score descending.
        # Query-major flattening already supplies the query tie break; only
        # sort keys inside each query before the stable score sort.
        order = torch.argsort(torch.where(active, safe, torch.iinfo(torch.int64).max),
                              dim=-1, stable=True)
        order = (order + torch.arange(q, device=counts.device)[None, None, :, None] * cap).reshape(b, h, -1)
        ordered_scores = (
            torch.where(active, score, -float("inf")).reshape(b, h, -1).gather(-1, order)
        )
        order = order.gather(
            -1, torch.argsort(ordered_scores, dim=-1, descending=True, stable=True)
        )
    else:
        # Push inactive gaps behind all active pairs, retaining route order.
        order = torch.argsort(flat_active.to(torch.int32), dim=-1, descending=True, stable=True)
    rank = torch.arange(q * cap, device=counts.device).expand(b, h, -1)
    # Precision index 0=FP16,1=INT8,2=NVFP4. Inactive entries sort last.
    label = torch.where(
        rank < quota[..., 0, None], 0, torch.where(rank < (quota[..., :2].sum(-1))[..., None], 1, 2)
    ).to(torch.int8)
    label = torch.empty_like(label).scatter(-1, order, label)
    del order, rank, safe
    label = torch.where(flat_active, label, 3).reshape(b, h, q, cap)
    phase_counts = {
        name: ((label == index) & active).sum(-1).to(torch.int32)
        for name, index in (("fp16", 0), ("int8", 1), ("nvfp4", 2))
    }
    execution_order = torch.where(active, 2 - label, 3)
    slots = torch.argsort(execution_order, dim=-1, stable=True)
    compact = route_ids.gather(-1, slots).contiguous()
    # Match the native phase ABI: inactive capacity is explicitly invalid,
    # rather than inheriting whatever sentinel happened to be in route_ids.
    compact = torch.where(active, compact, torch.full_like(compact, -1))
    return compact, phase_counts
