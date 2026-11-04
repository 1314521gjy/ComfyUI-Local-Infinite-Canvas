"""Reference implementations for the optional FastH3 attention candidates.

The production VSA path is still dispatched to Kitchen.  These implementations
are deliberately tensor-only and use the same padded H3 layout, sink policy,
and coarse branch as VSA.  They are useful on CUDA immediately, but are a
reference/bring-up path rather than a claim of native-kernel performance.
"""
from __future__ import annotations

import math
from typing import Any

import torch

from .layout import token_mask
from .reference import block_means, dequant_int8, quantize_int8_carriers, route_blocks


def _round_away(x: torch.Tensor) -> torch.Tensor:
    """Round half values away from zero, as Anemoi's integer preparation does."""
    return torch.sign(x) * torch.floor(x.abs() + 0.5)


def _blockwise_int8(x: torch.Tensor, live: torch.Tensor) -> torch.Tensor:
    """Return INT8-dequantized values with one scale per block/head."""
    x = x.float().masked_fill(~live[:, :, None, None], 0)
    amax = x.abs().amax(dim=(1, 3), keepdim=True)
    scale = (amax / 127.0).clamp_min(1e-7)
    q = _round_away(x.float() / scale).clamp(-128, 127)
    return q * scale


def _anemoi_v_carrier(v: torch.Tensor, live: torch.Tensor) -> torch.Tensor:
    """Approximate Anemoi's per-head/channel E4M3 V carrier.

    The native kernel uses an E4M3 carrier with one scale per head/channel.
    Keeping the conversion here explicit makes the reference useful on both
    CPU and CUDA, including installations whose torch build has no float8.
    """
    mask = live.to(v.dtype).view(v.shape[0], v.shape[1], 1, 1)
    amax = (v.float().abs() * mask).amax(dim=(0, 1), keepdim=True)
    scale = (amax / 2.25).clamp_min(1e-7)
    normalized = v.float() / scale
    if hasattr(torch, "float8_e4m3fn"):
        carrier = normalized.to(torch.float8_e4m3fn).to(torch.float32)
    else:
        carrier = _round_away(normalized).clamp(-448, 448)
    return carrier * scale * mask


def _residual_carrier(v: torch.Tensor, live: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """VC cube residual representation: ``v ~= residual * scale + mean``."""
    mask = live.to(v.dtype).view(v.shape[0], v.shape[1], 1, 1)
    denom = live.sum(dim=1).clamp_min(1).to(v.dtype).view(v.shape[0], 1, 1)
    mean = (v.float() * mask).sum(dim=1) / denom
    represented_mean = mean.to(torch.bfloat16).to(torch.float32)
    residual = (v.float() - represented_mean[:, None]).masked_fill(~live[:, :, None, None], 0)
    scale = (residual.abs().amax(dim=1) / 127.0).clamp_min(1e-8)
    # VC residuals use round-to-nearest-even; Anemoi's integer operand prep
    # remains explicitly round-away in _blockwise_int8.
    codes = torch.round(residual / scale[:, None]).clamp(-127, 127)
    codes = codes.masked_fill(~live[:, :, None, None], 0)
    return codes, scale, represented_mean


def _vc_smooth_carrier(
    k_blocks: torch.Tensor,
    v_blocks: torch.Tensor,
    live: torch.Tensor,
    *,
    clusters: int = 4,
    group_size: int = 16,
    iterations: int = 2,
) -> tuple[torch.Tensor, torch.Tensor, tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
    """Apply the constrained VC V-Smooth policy within each H3 cube.

    Clustering never crosses an existing VSA cube, so its stable K/V
    permutation cannot invalidate the sparse block route.  The fixed two-step
    Lloyd policy and smallest-label ties are intentionally deterministic.
    """
    _n_blocks, block_size, heads, dim = v_blocks.shape
    if clusters <= 0 or group_size <= 0 or iterations < 0:
        raise ValueError("VC clustering parameters must be positive")
    x = v_blocks.float().permute(0, 2, 1, 3).contiguous()
    valid = live[:, None, :]
    counts = live.sum(dim=1).to(torch.long)
    n_clusters = min(clusters, block_size)
    centroid_slot = (
        counts[:, None] * torch.arange(n_clusters, device=v_blocks.device)[None, :]
        // n_clusters
    ).clamp_max(block_size - 1)
    gather_centroid = centroid_slot[:, None, :, None].expand(-1, heads, -1, dim)
    centroids = torch.gather(x, 2, gather_centroid)
    labels = torch.zeros(
        (x.shape[0], x.shape[1], x.shape[2]), dtype=torch.long, device=x.device
    )
    for _ in range(iterations):
        distance = (x[:, :, :, None, :] - centroids[:, :, None, :, :]).square().sum(dim=-1)
        distance = distance.masked_fill(~valid[:, :, :, None], float("inf"))
        labels = distance.argmin(dim=-1)
        one_hot = torch.nn.functional.one_hot(labels, num_classes=n_clusters).to(x.dtype)
        one_hot = one_hot * valid[:, :, :, None].to(x.dtype)
        sums = torch.einsum("bhng,bhnd->bhgd", one_hot, x)
        label_counts = one_hot.sum(dim=2)
        updated = sums / label_counts.clamp_min(1).unsqueeze(-1)
        centroids = torch.where(label_counts.unsqueeze(-1) > 0, updated, centroids)
    if iterations == 0:
        distance = (x[:, :, :, None, :] - centroids[:, :, None, :, :]).square().sum(dim=-1)
        distance = distance.masked_fill(~valid[:, :, :, None], float("inf"))
        labels = distance.argmin(dim=-1)

    position = torch.arange(block_size, device=v_blocks.device).view(1, 1, block_size)
    sort_key = torch.where(valid, labels * block_size + position,
                           n_clusters * block_size + position)
    order = torch.argsort(sort_key, dim=-1, stable=True)
    sorted_x = torch.gather(x, 2, order.unsqueeze(-1).expand(-1, -1, -1, dim))
    k_heads = k_blocks.float().permute(0, 2, 1, 3)
    sorted_k = torch.gather(k_heads, 2, order.unsqueeze(-1).expand(-1, -1, -1, dim))
    sorted_live = torch.arange(block_size, device=v_blocks.device)[None, :] < counts[:, None]
    sorted_x = sorted_x.masked_fill(~sorted_live[:, None, :, None], 0)
    sorted_k = sorted_k.masked_fill(~sorted_live[:, None, :, None], 0)

    group_count = (block_size + group_size - 1) // group_size
    group_ids = (torch.arange(block_size, device=v_blocks.device) // group_size).clamp_max(group_count - 1)
    group_mask = sorted_live[:, None, :, None] & (group_ids[None, None, :, None] == torch.arange(group_count, device=v_blocks.device)[None, None, None, :])
    group_mask = group_mask.expand(-1, heads, -1, -1)
    grouped = sorted_x[:, :, :, None, :] * group_mask.to(x.dtype)[..., None]
    group_mean = grouped.sum(dim=2) / group_mask.sum(dim=2).clamp_min(1).to(x.dtype).unsqueeze(-1)
    group_mean = group_mean.to(torch.bfloat16).to(torch.float32)
    row_mean = group_mean[:, :, group_ids, :]
    residual = (sorted_x - row_mean).masked_fill(~sorted_live[:, None, :, None], 0)
    grouped_abs = residual.abs()[:, :, :, None, :] * group_mask.to(x.dtype)[..., None]
    group_scale = (grouped_abs.amax(dim=2) / 127.0).clamp_min(1e-8)
    row_scale = group_scale[:, :, group_ids, :]
    codes = torch.round(residual / row_scale).clamp(-127, 127)
    codes = codes.masked_fill(~sorted_live[:, None, :, None], 0)
    return (
        sorted_k.permute(0, 2, 1, 3).to(k_blocks.dtype),
        sorted_x.permute(0, 2, 1, 3).to(v_blocks.dtype),
        (
            codes.permute(0, 2, 1, 3),
            row_scale.permute(0, 2, 1, 3),
            row_mean.permute(0, 2, 1, 3),
        ),
    )


def _anemoi_draft_scores(
    q_mean: torch.Tensor,
    k_mean: torch.Tensor,
    q_max: torch.Tensor,
    k_max: torch.Tensor,
    *,
    n_prefix: int,
    max_pool_weight: float,
) -> torch.Tensor:
    """Return the video-only Anemoi draft map used by route and HP metadata."""
    scale = q_mean.shape[-1] ** -0.5
    q_video = q_mean[n_prefix:]
    k_video = k_mean[n_prefix:]
    q_max_video = q_max[n_prefix:]
    k_max_video = k_max[n_prefix:]
    mean_logits = torch.einsum("qhd,khd->hqk", q_video, k_video) * scale
    max_logits = torch.einsum("qhd,khd->hqk", q_max_video, k_max_video) * scale
    return (1.0 - max_pool_weight) * torch.softmax(mean_logits, dim=-1) + (
        max_pool_weight * torch.softmax(max_logits, dim=-1)
    )


def _anemoi_route(
    q_mean: torch.Tensor,
    k_mean: torch.Tensor,
    q_max: torch.Tensor,
    k_max: torch.Tensor,
    *,
    n_prefix: int,
    sparsity: float = 0.80,
    max_pool_weight: float = 0.20,
    draft_scores: torch.Tensor | None = None,
) -> torch.Tensor:
    """Build Anemoi's global per-head draft-map route on the VSA blocks.

    Prefix blocks are always included. Video pairs are selected from one global budget
    per head, then each query receives at least one video block.  This is the
    public algorithm's route shape, adapted to the already-packed H3 blocks.
    It does not implement native Anemoi's 2-D ragged partition.
    """
    n_blocks, heads, _dim = q_mean.shape
    video = max(0, n_blocks - n_prefix)
    # Every video query needs at least one retained video pair.  Reserve those
    # rows first, then spend the remaining global budget by draft score.
    selected_count = max(video, round((1.0 - sparsity) * video * video)) if video else 0
    selected_count = min(selected_count, video * video)
    draft = draft_scores
    if draft is None:
        draft = _anemoi_draft_scores(
            q_mean, k_mean, q_max, k_max,
            n_prefix=n_prefix, max_pool_weight=max_pool_weight,
        )

    # Prefix keys are always included.  Keep a fixed-width tensor for the
    # existing gather code and use -1 for per-query padding.
    width = n_prefix + (min(video, max(1, selected_count)) if video else 0)
    selected = torch.full(
        (heads, n_blocks, width), -1, dtype=torch.long, device=q_mean.device
    )
    if n_prefix:
        selected[:, :, :n_prefix] = torch.arange(n_prefix, device=q_mean.device)
    if video:
        # Keep the first slot as the per-query seed.  The remaining slots are
        # the exact highest-scoring non-seed pairs from one global budget per
        # head.  Stable argsort preserves row-major tie order without
        # Python lists, sets, or per-pair scalar conversions.
        seed_keys = draft.argmax(dim=-1)
        seed_flat = (
            torch.arange(video, device=q_mean.device).view(1, video) * video
            + seed_keys
        )
        seed_pairs = torch.zeros(
            (heads, video * video), dtype=torch.bool, device=q_mean.device
        ).scatter(1, seed_flat, True)
        remaining = selected_count - video
        video_width = selected.shape[-1] - n_prefix
        selected_video = selected[:, n_prefix:, n_prefix:]
        selected_video[:, :, 0] = seed_keys + n_prefix
        if remaining:
            masked_draft = draft.masked_fill(seed_pairs.view(heads, video, video), -float("inf"))
            global_order = torch.argsort(
                masked_draft.reshape(heads, -1), dim=-1, descending=True, stable=True
            )
            extra_pairs = torch.zeros_like(seed_pairs).scatter(
                1, global_order[:, :remaining], True
            ).view(heads, video, video)
            # The global cutoff determines which pairs survive; sorting each
            # query's survivors restores the former per-row score order.
            row_order = torch.argsort(masked_draft, dim=-1, descending=True, stable=True)
            extra_width = video_width - 1
            row_order = row_order[:, :, :extra_width]
            extra = torch.gather(extra_pairs, 2, row_order)
            slots = extra.cumsum(dim=-1) - 1
            slot_ids = torch.arange(extra_width, device=q_mean.device)
            one_hot = (slots[..., None] == slot_ids).to(row_order.dtype)
            one_hot = one_hot * extra[..., None].to(one_hot.dtype)
            extra_ids = torch.where(extra, row_order, torch.zeros_like(row_order))
            extra_ids = (one_hot * extra_ids[..., None]).sum(dim=-2)
            selected_video[:, :, 1:] = torch.where(
                extra, extra_ids + n_prefix, torch.full_like(extra_ids, -1)
            )
    # Conditioning queries keep the full route, matching the existing H3
    # quality protection and avoiding an accidental prompt regression.
    if n_prefix:
        all_blocks = torch.arange(n_blocks, device=q_mean.device)
        if width < n_blocks:
            # This can only occur when the candidate budget is unusually small;
            # grow the width rather than dropping exact prefix-query visibility.
            expanded = torch.full((heads, n_blocks, n_blocks), -1,
                                   dtype=torch.long, device=q_mean.device)
            expanded[:, :, :width] = selected
            selected = expanded
        selected[:, :n_prefix, :n_blocks] = all_blocks
    return selected


def _attend_selected(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    live: torch.Tensor,
    selected: torch.Tensor,
    *,
    high_precision: torch.Tensor | None = None,
    residual: tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None = None,
    original_v: torch.Tensor | None = None,
    anemoi_probability: bool = False,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Reference online attention over compact selected block lists."""
    q_blocks = q.view(live.shape[0], live.shape[1], q.shape[1], q.shape[2])
    k_blocks = k.view(live.shape[0], live.shape[1], k.shape[1], k.shape[2])
    v_blocks = v.view(live.shape[0], live.shape[1], v.shape[1], v.shape[2])
    original_v_blocks = (
        original_v.view(live.shape[0], live.shape[1], original_v.shape[1], original_v.shape[2])
        if original_v is not None else v_blocks
    )
    scale = q.shape[-1] ** -0.5
    out = torch.zeros_like(q, dtype=torch.float32)
    lse = torch.full((q.shape[0], q.shape[1]), -float("inf"), dtype=torch.float32, device=q.device)
    residual_codes = residual_scale = residual_mean = None
    if residual is not None:
        residual_codes, residual_scale, residual_mean = residual
    out_blocks = out.view(live.shape[0], live.shape[1], q.shape[1], q.shape[2])
    lse_blocks = lse.view(live.shape[0], live.shape[1], q.shape[1])
    k_heads = k_blocks.permute(2, 0, 1, 3)
    v_heads = v_blocks.permute(2, 0, 1, 3)
    original_heads = original_v_blocks.permute(2, 0, 1, 3)
    for qb in range(live.shape[0]):
        q_live = live[qb]
        ids = selected[:, qb]
        valid_ids = ids >= 0
        safe_ids = ids.clamp_min(0)
        key = torch.gather(
            k_heads, 1, safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1])
        )
        key_live = live[safe_ids] & valid_ids[:, :, None]
        q_heads = q_blocks[qb].permute(1, 0, 2).float()
        key = key.reshape(q.shape[1], -1, q.shape[-1]).float()
        scores = torch.bmm(q_heads, key.transpose(1, 2)) * scale
        key_live_flat = key_live.reshape(q.shape[1], 1, -1)
        scores = scores.masked_fill(~key_live_flat, -float("inf"))
        if anemoi_probability:
            finite = torch.isfinite(scores).any(dim=-1, keepdim=True)
            row_max = scores.amax(dim=-1, keepdim=True)
            row_max = torch.where(finite, row_max, torch.zeros_like(row_max))
            probability = torch.exp2((scores - row_max) * math.log2(math.e))
            probability = probability.masked_fill(~key_live_flat, 0)
            if hasattr(torch, "float8_e4m3fn"):
                # beta is 2**-8.807 in the pinned Anemoi INT8 phase.
                beta = 0.0022326917
                represented = (probability / beta).to(torch.float8_e4m3fn).to(torch.float32) * beta
            else:
                represented = probability
            denominator = probability.sum(dim=-1, keepdim=True).clamp_min(1e-12)
            weights = represented / denominator
        else:
            weights = torch.softmax(scores, dim=-1)
            weights = weights.masked_fill(~key_live_flat, 0)
        values = torch.gather(
            v_heads, 1, safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1])
        )
        if residual_codes is not None and residual_scale is not None and residual_mean is not None:
            code = torch.gather(
                residual_codes.permute(2, 0, 1, 3), 1,
                safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1]),
            ).float()
            if residual_scale.dim() == 4:
                scale_rows = torch.gather(
                    residual_scale.permute(2, 0, 1, 3), 1,
                    safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1]),
                ).float()
                mean_rows = torch.gather(
                    residual_mean.permute(2, 0, 1, 3), 1,
                    safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1]),
                ).float()
            else:
                scale_rows = torch.gather(
                    residual_scale.permute(1, 0, 2), 1,
                    safe_ids[:, :, None].expand(-1, -1, q.shape[-1]),
                )[:, :, None].expand(-1, -1, live.shape[1], -1).float()
                mean_rows = torch.gather(
                    residual_mean.permute(1, 0, 2), 1,
                    safe_ids[:, :, None].expand(-1, -1, q.shape[-1]),
                )[:, :, None].expand(-1, -1, live.shape[1], -1).float()
            values = code * scale_rows + mean_rows
        values = values.float()
        if high_precision is not None:
            hp = torch.gather(high_precision[:, qb], 1, safe_ids) & valid_ids
            original = torch.gather(
                original_heads, 1,
                safe_ids[:, :, None, None].expand(-1, -1, live.shape[1], q.shape[-1]),
            ).float()
            values = torch.where(hp[:, :, None, None], original, values)
        result = torch.bmm(weights, values.reshape(q.shape[1], -1, q.shape[-1]))
        result = result.masked_fill(~q_live[None, :, None], 0)
        out_blocks[qb] = result.permute(1, 0, 2)
        finite = torch.isfinite(scores).any(dim=-1) & q_live[None, :]
        lse_blocks[qb] = torch.where(
            finite.transpose(0, 1),
            torch.logsumexp(scores, dim=-1).transpose(0, 1),
            torch.full_like(lse_blocks[qb], -float("inf")),
        )
    return out, lse


def _coarse_branch(
    out: torch.Tensor,
    gate: torch.Tensor | None,
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    live: torch.Tensor,
) -> torch.Tensor:
    if gate is None:
        return out
    scale = q.shape[-1] ** -0.5
    q_mean = block_means(q.view(live.shape[0], live.shape[1], q.shape[1], q.shape[2]).float(), live)
    k_mean = block_means(k.view(live.shape[0], live.shape[1], k.shape[1], k.shape[2]).float(), live)
    v_mean = block_means(v.view(live.shape[0], live.shape[1], v.shape[1], v.shape[2]).float(), live)
    coarse = torch.softmax(torch.einsum("qhd,khd->hqk", q_mean, k_mean) * scale, dim=-1)
    coarse = torch.einsum("hqk,khd->qhd", coarse, v_mean)
    gate_blocks = gate.view(live.shape[0], live.shape[1], gate.shape[1], gate.shape[2]).float()
    gate_blocks = gate_blocks.masked_fill(~live[:, :, None, None], 0)
    return out + (gate_blocks * coarse[:, None]).reshape_as(out).to(out.dtype)


def run_attention_option(
    option: str,
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    *,
    block_len: torch.Tensor,
    n_prefix: int,
    topk_ratio: float,
    block_size: int,
    coarse_gate: torch.Tensor | None = None,
    anemoi_sparsity: float = 0.80,
    anemoi_max_pool_weight: float = 0.20,
    anemoi_high_precision_ratio: float = 0.10,
    use_native: bool | None = None,
) -> dict[str, Any]:
    """Run ``vc``, ``anemoi``, or ``combined`` on a packed H3 sequence."""
    if option not in {"vc", "anemoi", "combined"}:
        raise ValueError(f"candidate reference does not implement {option!r}")
    if q.shape != k.shape or q.shape != v.shape:
        raise ValueError("candidate attention requires matching q/k/v shapes")
    if q.dim() != 3:
        raise ValueError("candidate attention expects q/k/v shaped [tokens, heads, dim]")
    if block_size <= 0:
        raise ValueError("candidate attention block_size must be positive")
    if q.shape[0] % block_size:
        raise ValueError("candidate attention sequence must be block padded")
    n_blocks, heads, dim = q.shape[0] // block_size, q.shape[1], q.shape[2]
    if block_len.dim() != 1 or block_len.numel() != n_blocks:
        raise ValueError("block_len must contain one entry per padded attention block")
    if block_len.device != q.device:
        raise ValueError("block_len must be on the same device as q/k/v")
    if n_prefix < 0 or n_prefix > n_blocks:
        raise ValueError("n_prefix must be within the padded block range")
    if bool((block_len < 0).any()) or bool((block_len > block_size).any()):
        raise ValueError("block_len contains an invalid live-token count")
    if bool((block_len == 0).any()):
        raise ValueError("candidate attention does not accept empty logical blocks")
    live = token_mask(block_len, block_size)
    padding = ~live.reshape(-1, 1, 1)
    # Padding is storage, not an operand: erase it before reductions, casts,
    # or clustering (multiplication by zero does not remove NaN/Inf).
    q, k, v = (x.masked_fill(padding, 0) for x in (q, k, v))
    if not bool(torch.isfinite(q).all() and torch.isfinite(k).all() and torch.isfinite(v).all()):
        raise ValueError("candidate attention inputs must be finite")
    original_q, original_k, original_v = q, k, v
    if use_native is None:
        from .attention_triton import available as native_available

        use_native = q.device.type == "cuda" and native_available(q.device)
    q_blocks = q.view(n_blocks, block_size, heads, dim)
    k_blocks = k.view(n_blocks, block_size, heads, dim)
    v_blocks = v.view(n_blocks, block_size, heads, dim)
    original_v_blocks = v_blocks
    if option == "vc":
        k_prepared, v_prepared, residual = _vc_smooth_carrier(k_blocks, v_blocks, live)
        k = k_prepared.reshape_as(k)
        v = v_prepared.reshape_as(v)
        q8, qs = quantize_int8_carriers(q)
        k8, ks = quantize_int8_carriers(k)
        selected = route_blocks(
            block_means(dequant_int8(q8, qs).view_as(q_blocks), live),
            block_means(dequant_int8(k8, ks).view_as(k_blocks), live),
            n_prefix=n_prefix, topk_ratio=topk_ratio,
        )
        if use_native:
            from .attention_triton import run_compact_attention

            out, lse = run_compact_attention(
                q, k, v, selected, block_len, residual=residual,
            )
            backend = "triton_compact"
        else:
            out, lse = _attend_selected(q, k, v, live, selected, residual=residual)
            backend = "local_reference"
        carrier = "vc_vsmooth_residual_int8"
    else:
        if option == "combined":
            k_blocks, v_blocks, residual = _vc_smooth_carrier(k_blocks, v_blocks, live)
        else:
            residual = None
        q_anemoi = _blockwise_int8(q_blocks, live)
        k_anemoi = _blockwise_int8(k_blocks, live)
        q_mean = block_means(q_anemoi, live)
        k_mean = block_means(k_anemoi, live)
        q_max = q_anemoi.masked_fill(~live[:, :, None, None], -float("inf")).amax(dim=1)
        k_max = k_anemoi.masked_fill(~live[:, :, None, None], -float("inf")).amax(dim=1)
        draft_scores = _anemoi_draft_scores(
            q_mean, k_mean, q_max, k_max,
            n_prefix=n_prefix, max_pool_weight=anemoi_max_pool_weight,
        )
        selected = _anemoi_route(
            q_mean, k_mean, q_max, k_max, n_prefix=n_prefix,
            sparsity=anemoi_sparsity, max_pool_weight=anemoi_max_pool_weight,
            draft_scores=draft_scores,
        )
        # High-score pairs retain original values.  The uncombined candidate
        # uses Anemoi's E4M3 V carrier for the remaining pairs; combined uses
        # residual values instead and must not build an unused carrier.
        v_anemoi = _anemoi_v_carrier(v_blocks, live) if option == "anemoi" else v_blocks
        high_precision = torch.zeros(
            (heads, n_blocks, n_blocks), dtype=torch.bool, device=q.device
        )
        if n_prefix:
            prefix_ids = selected[:, :n_prefix].clamp_min(0)
            high_precision[:, :n_prefix].scatter_(
                2, prefix_ids, selected[:, :n_prefix] >= 0
            )
        video_selected = selected[:, n_prefix:, n_prefix:]
        video_valid = video_selected >= n_prefix
        if n_prefix:
            prefix_selected = selected[:, n_prefix:, :n_prefix]
            high_precision[:, n_prefix:].scatter_(
                2, prefix_selected.clamp_min(0), prefix_selected >= 0,
            )
        candidates_per_head = video_valid.sum(dim=(1, 2))
        high_counts = torch.round(
            candidates_per_head.float() * anemoi_high_precision_ratio
        ).to(torch.long)
        if bool(high_counts.any()) and video_valid.numel():
            # Stable argsort orders by score, query, then key for each head.
            # Mask padded slots so they cannot spend high-precision quota.
            video_ids = video_selected.clamp_min(n_prefix) - n_prefix
            scores = torch.gather(draft_scores, 2, video_ids)
            scores = scores.masked_fill(~video_valid, -float("inf"))
            order = torch.argsort(
                scores.reshape(heads, -1), dim=-1, descending=True, stable=True
            )
            ranks = torch.arange(order.shape[-1], device=q.device)
            keep_rank = ranks[None, :] < high_counts[:, None]
            hp_flat = torch.zeros_like(video_valid.reshape(heads, -1))
            hp_flat.scatter_(
                1, order, keep_rank & video_valid.reshape(heads, -1).gather(1, order)
            )
            # Padded route slots clamp to block zero for safe indexing.  A
            # normal scatter would let a false padded source erase a true
            # block-zero flag, so reduce with boolean max instead.
            high_precision[:, n_prefix:].scatter_reduce_(
                2, video_selected.clamp_min(0), hp_flat.view_as(video_selected),
                reduce="amax", include_self=True,
            )
        if use_native:
            from .attention_triton import run_compact_attention

            out, lse = run_compact_attention(
                q_anemoi.reshape_as(q),
                k_anemoi.reshape_as(k),
                v_anemoi.reshape_as(v),
                selected,
                block_len,
                residual=residual,
                original_v=original_v_blocks.reshape_as(v),
                high_precision=high_precision,
                anemoi_probability=True,
            )
            backend = "triton_compact"
        else:
            out, lse = _attend_selected(
                q_anemoi.reshape_as(q), k_anemoi.reshape_as(k), v_anemoi.reshape_as(v),
                live, selected, high_precision=high_precision, residual=residual,
                original_v=original_v_blocks.reshape_as(v),
                anemoi_probability=True,
            )
            backend = "local_reference"
        carrier = "anemoi_int8_e4m3_v" if residual is None else "anemoi_vc_residual_int8"
    gate = coarse_gate
    if gate is not None and gate.dim() == 4:
        gate = gate[0]
    if gate is not None and tuple(gate.shape) != tuple(q.shape):
        raise ValueError("coarse_gate must match q/k/v shape after batch squeeze")
    out = _coarse_branch(out, gate, original_q, original_k, original_v, live)
    video_ids = selected[:, n_prefix:] if n_prefix < n_blocks else selected[:, :0]
    selected_video_pairs = int((video_ids >= n_prefix).sum().item())
    return {
        "out": out,
        "lse": lse,
        "selected": selected,
        "n_keep_video": (int((video_ids >= n_prefix).sum(dim=-1).max().item())
                         if video_ids.numel() else 0),
        "n_selected_video_pairs": selected_video_pairs,
        "backend": backend,
        "attention_option": option,
        "carrier": carrier,
        "high_precision": high_precision if option != "vc" else None,
        "quality_class": "experimental-reference",
    }


__all__ = ["run_attention_option"]
