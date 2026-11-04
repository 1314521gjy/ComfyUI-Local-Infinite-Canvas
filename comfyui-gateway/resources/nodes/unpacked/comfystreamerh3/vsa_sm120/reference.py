"""Inspectable same-math VSA: 64-token blocks, INT8 routing, prefix sinks, no tail.

This is the Track A oracle. It is not a kitchen bit-clone; kitchen parity is a
GPU gate. Offline it must match dense attention when every block is selected,
keep prefix sinks exact, honor block_len pads, and apply coarse_gate.
"""
from __future__ import annotations

from typing import Any

import torch

from .layout import n_video_keep, token_mask
from .unsafe import MaskCache, quantize_kv, selection_hash

HEAD_DIM = 128


def quantize_int8_carriers(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    amax = x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-6)
    scale = amax / 127.0
    q = (x / scale).round().clamp(-128, 127).to(torch.int8)
    return q, scale


def dequant_int8(q: torch.Tensor, scale: torch.Tensor) -> torch.Tensor:
    return q.to(torch.float32) * scale.to(torch.float32)


def block_means(x: torch.Tensor, live: torch.Tensor) -> torch.Tensor:
    """x: [B, S, H, D], live: [B, S] → [B, H, D] mean over live tokens."""
    w = live.to(x.dtype).unsqueeze(-1).unsqueeze(-1)
    denom = live.sum(dim=1).clamp_min(1).to(x.dtype).view(-1, 1, 1)
    return (x * w).sum(dim=1) / denom


def dense_masked_attn(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    live: torch.Tensor,
    *,
    scale: float,
) -> torch.Tensor:
    """Full softmax attention with padded keys at -inf. q/k/v: [T, H, D]."""
    t, _h, _d = q.shape
    scores = torch.einsum("thd,shd->hts", q, k) * scale
    key_live = live.view(1, 1, t)
    scores = scores.masked_fill(~key_live, torch.finfo(scores.dtype).min)
    weights = torch.softmax(scores, dim=-1)
    weights = weights.masked_fill(~key_live, 0)
    return torch.einsum("hts,shd->thd", weights, v)


def route_blocks(
    q_mean: torch.Tensor,
    k_mean: torch.Tensor,
    *,
    n_prefix: int,
    topk_ratio: float,
    prefix_queries_dense: bool = True,
) -> torch.Tensor:
    """Per-head selected KV block ids. Prefix KV is always included.

    q_mean/k_mean: [n_blocks, H, D] → indices [H, n_q, n_keep]
    """
    n_blocks, heads, dim = q_mean.shape
    scale = dim ** -0.5
    scores = torch.einsum("qhd,khd->hqk", q_mean, k_mean) * scale
    n_keep_video = n_video_keep(n_blocks, n_prefix, topk_ratio)
    n_video = n_blocks - n_prefix
    kmax = n_blocks if prefix_queries_dense else (n_prefix + n_keep_video)
    selected = torch.full((heads, n_blocks, kmax), -1, dtype=torch.int64, device=q_mean.device)
    video_idx = None
    if n_video > 0 and n_keep_video > 0:
        _, video_idx = scores[:, :, n_prefix:].topk(min(n_keep_video, n_video), dim=-1)
        video_idx = video_idx + n_prefix
    if prefix_queries_dense and n_prefix:
        selected[:, :n_prefix, :n_blocks] = torch.arange(n_blocks, device=q_mean.device)
    video_q = slice(n_prefix, n_blocks) if prefix_queries_dense else slice(n_blocks)
    if n_prefix:
        selected[:, video_q, :n_prefix] = torch.arange(n_prefix, device=q_mean.device)
    if video_idx is not None:
        keep = video_idx.shape[-1]
        src = video_idx[:, n_prefix:] if prefix_queries_dense else video_idx
        selected[:, video_q, n_prefix:n_prefix + keep] = src
    return selected


def online_block_attend(
    q_block: torch.Tensor,
    k_blocks: torch.Tensor,
    v_blocks: torch.Tensor,
    k_live: torch.Tensor,
    q_live: torch.Tensor,
    *,
    scale: float,
) -> tuple[torch.Tensor, torch.Tensor]:
    """FP32 online softmax over a list of KV blocks for one query block.

    q_block: [S, H, D]; k/v_blocks: [K, S, H, D]; *_live: [S] / [K, S]
    Returns out [S, H, D] and LSE [S, H].
    """
    s, h, d = q_block.shape
    k_sel = k_blocks.shape[0]
    if k_sel == 0:
        zeros = torch.zeros((s, h, d), dtype=torch.float32, device=q_block.device)
        return zeros, torch.full((s, h), -float("inf"), dtype=torch.float32, device=q_block.device)
    m = torch.full((s, h), -float("inf"), dtype=torch.float32, device=q_block.device)
    lse_acc = torch.zeros((s, h), dtype=torch.float32, device=q_block.device)
    acc = torch.zeros((s, h, d), dtype=torch.float32, device=q_block.device)
    qf = q_block.float()
    for i in range(k_sel):
        k = k_blocks[i].float()
        v = v_blocks[i].float()
        scores = torch.einsum("shd,thd->sht", qf, k) * scale
        live = k_live[i].view(1, 1, s)
        scores = scores.masked_fill(~live, -float("inf"))
        block_max = scores.amax(dim=-1)
        m_new = torch.maximum(m, block_max)
        alpha = torch.exp(m - m_new)
        alpha = torch.where(torch.isfinite(alpha), alpha, torch.zeros_like(alpha))
        p = torch.exp(scores - m_new.unsqueeze(-1))
        p = torch.where(torch.isfinite(p), p, torch.zeros_like(p))
        p = p.masked_fill(~live, 0)
        acc = acc * alpha.unsqueeze(-1) + torch.einsum("sht,thd->shd", p, v)
        lse_acc = lse_acc * alpha + p.sum(dim=-1)
        m = m_new
    out = acc / lse_acc.clamp_min(1e-12).unsqueeze(-1)
    out = out * q_live.view(s, 1, 1).to(out.dtype)
    lse = m + torch.log(lse_acc.clamp_min(1e-12))
    return out, lse


def batched_block_attend(
    q_block: torch.Tensor,
    k_blocks: torch.Tensor,
    v_blocks: torch.Tensor,
    live: torch.Tensor,
    ids: torch.Tensor,
    q_live: torch.Tensor,
    *,
    scale: float,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Same softmax as ``online_block_attend``, all heads in one bmm.

    q_block: [S, H, D]; k/v_blocks: [n_blocks, S, H, D]; live: [n_blocks, S];
    ids: [H, kmax] with -1 pads; q_live: [S].
    """
    s, heads, dim = q_block.shape
    kmax = int(ids.shape[-1])
    if kmax == 0:
        zeros = torch.zeros((s, heads, dim), dtype=torch.float32, device=q_block.device)
        neginf = torch.full((s, heads), -float("inf"), dtype=torch.float32, device=q_block.device)
        return zeros, neginf
    valid = ids >= 0
    safe_ids = ids.clamp_min(0)
    k_h = k_blocks.permute(2, 0, 1, 3)
    v_h = v_blocks.permute(2, 0, 1, 3)
    gather_idx = safe_ids.view(heads, kmax, 1, 1).expand(heads, kmax, s, dim)
    k_sel = torch.gather(k_h, 1, gather_idx)
    v_sel = torch.gather(v_h, 1, gather_idx)
    key_live = live[safe_ids] & valid.unsqueeze(-1)
    qf = q_block.permute(1, 0, 2).float()
    kf = k_sel.reshape(heads, kmax * s, dim).float()
    vf = v_sel.reshape(heads, kmax * s, dim).float()
    scores = torch.bmm(qf, kf.transpose(1, 2)) * scale
    live_flat = key_live.reshape(heads, 1, kmax * s)
    scores = scores.masked_fill(~live_flat, -float("inf"))
    finite = torch.isfinite(scores).any(dim=-1, keepdim=True)
    weights = torch.softmax(scores, dim=-1)
    weights = torch.where(finite, weights, torch.zeros_like(weights))
    weights = weights.masked_fill(~live_flat, 0)
    out = torch.bmm(weights, vf).permute(1, 0, 2)
    out = out * q_live.view(s, 1, 1).to(out.dtype)
    lse = torch.logsumexp(scores, dim=-1)
    lse = torch.where(finite.squeeze(-1), lse, torch.full_like(lse, -float("inf")))
    return out, lse.permute(1, 0)


def sparse_attn(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    *,
    block_len: torch.Tensor,
    n_prefix: int,
    topk_ratio: float = 0.10,
    block_size: int = 64,
    coarse_gate: torch.Tensor | None = None,
    kv_quant: str = "bf16",
    mask_cache: MaskCache | None = None,
    layer: int = 0,
    step: int = 0,
    prefix_queries_dense: bool = True,
) -> dict[str, Any]:
    """Same-math sparse attention. q/k/v: [T, H, D] in padded VSA order."""
    t, heads, dim = q.shape
    if t % block_size:
        raise ValueError(f"sequence {t} is not a multiple of block_size {block_size}")
    n_blocks = t // block_size
    live = token_mask(block_len, block_size)
    qv = q.view(n_blocks, block_size, heads, dim)
    kv = k.view(n_blocks, block_size, heads, dim)
    vv = v.view(n_blocks, block_size, heads, dim)

    q8, qs = quantize_int8_carriers(q)
    k8, ks = quantize_int8_carriers(k)
    qd = dequant_int8(q8, qs).view(n_blocks, block_size, heads, dim)
    kd = dequant_int8(k8, ks).view(n_blocks, block_size, heads, dim)
    q_mean = block_means(qd, live)
    k_mean = block_means(kd, live)

    selected = route_blocks(
        q_mean, k_mean, n_prefix=n_prefix, topk_ratio=topk_ratio,
        prefix_queries_dense=prefix_queries_dense,
    )
    if mask_cache is not None:
        selected = mask_cache.lookup(layer=layer, step=step, fresh=selected)

    scale = dim ** -0.5
    out = q.new_zeros((t, heads, dim))
    lse = q.new_zeros((t, heads))
    k_use, v_use = quantize_kv(k, v, kv_quant)
    k_use = k_use.view(n_blocks, block_size, heads, dim)
    v_use = v_use.view(n_blocks, block_size, heads, dim)

    for qb in range(n_blocks):
        block_out, block_lse = batched_block_attend(
            qv[qb], k_use, v_use, live, selected[:, qb], live[qb], scale=scale,
        )
        out[qb * block_size:(qb + 1) * block_size] = block_out.to(out.dtype)
        lse[qb * block_size:(qb + 1) * block_size] = block_lse.to(lse.dtype)

    if coarse_gate is not None:
        g = coarse_gate.view(n_blocks, block_size, heads, dim).float()
        g_mean = block_means(g, live)
        v_mean = block_means(vv.float(), live)
        k_mean_f = block_means(kv.float(), live)
        coarse_scores = torch.einsum("qhd,khd->hqk", g_mean, k_mean_f) * scale
        coarse_w = torch.softmax(coarse_scores, dim=-1)
        coarse = torch.einsum("hqk,khd->qhd", coarse_w, v_mean)
        coarse_tok = coarse.unsqueeze(1).expand(-1, block_size, -1, -1)
        gated = coarse_gate.view(n_blocks, block_size, heads, dim).float() * coarse_tok
        gated = gated * live.to(gated.dtype).unsqueeze(-1).unsqueeze(-1)
        out = out + gated.reshape(t, heads, dim).to(out.dtype)

    return {
        "out": out,
        "lse": lse,
        "selected": selected,
        "selection_hash": selection_hash(selected),
        "n_keep_video": n_video_keep(n_blocks, n_prefix, topk_ratio),
        "carriers": {"q": q8, "k": k8},
    }


def gather_padded(x: torch.Tensor, plan: dict) -> torch.Tensor:
    """Source-order activations → padded VSA order. x: [n_orig, ...]."""
    src = plan["src"]
    pad = x.new_zeros((1,) + tuple(x.shape[1:]))
    rows = torch.cat([x, pad], dim=0)
    idx = src.clamp_min(0)
    idx = torch.where(src >= 0, idx, torch.full_like(idx, x.shape[0]))
    return rows[idx]


def unpermute(out: torch.Tensor, plan: dict) -> torch.Tensor:
    return out[plan["inv"]]
