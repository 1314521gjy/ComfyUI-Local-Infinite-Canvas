"""One-layer VSA microbench shapes: padded H3, 56 heads, hd 128, 10% density."""
from __future__ import annotations

import time
from typing import Any

import torch

from .config import vsa_options
from .dispatch import kitchen_control_note, run_local_core
from .layout import build_plan, token_mask
from .reference import dense_masked_attn, gather_padded

HEADS = 56
HEAD_DIM = 128

# Small enough for CPU tests; the CUDA node uses the same geometries.
MICROBENCH_SHAPES = (
    {"label": "smoke", "text_len": 20, "video_grid": (4, 4, 4), "audio_len": 0},
    {"label": "partial-edge", "text_len": 70, "video_grid": (5, 5, 5), "audio_len": 0},
    {"label": "prefix-sinks", "text_len": 128, "video_grid": (4, 4, 8), "audio_len": 0},
)


def _time_cuda(fn, *, warmup: int = 1, reps: int = 3) -> float:
    if not torch.cuda.is_available():
        for _ in range(warmup):
            fn()
        started = time.perf_counter()
        for _ in range(reps):
            fn()
        return (time.perf_counter() - started) * 1000.0 / reps
    torch.cuda.synchronize()
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    start.record()
    for _ in range(reps):
        fn()
    end.record()
    end.synchronize()
    return float(start.elapsed_time(end) / reps)


def _kitchen_sol_attn(q, k, v, gate, plan, topk_ratio: float):
    from comfy_kitchen.backends import cuda as ck
    qb, kb, vb, gb = q.unsqueeze(0), k.unsqueeze(0), v.unsqueeze(0), gate.unsqueeze(0)
    kwargs = {
        "topk_ratio": topk_ratio, "tail": False, "coarse_gate": gb,
        "sink_blocks": [0, int(plan["n_prefix"])],
        "sink_q": [0, int(plan["n_prefix"])],
    }
    try:
        return ck.sol_attn(qb, kb, vb, block_len=plan["block_len"], **kwargs)
    except TypeError:
        return ck.sol_attn(qb, kb, vb, **kwargs)


def run_microbench(
    *,
    text_len: int,
    video_grid: tuple[int, int, int],
    audio_len: int = 0,
    heads: int = HEADS,
    head_dim: int = HEAD_DIM,
    topk_ratio: float | None = None,
    device: str = "cpu",
    seed: int = 0,
    compare_dense: bool = True,
    compare_kitchen: bool = False,
    aggressive_topk: float = 0.05,
) -> dict[str, Any]:
    opts = vsa_options()
    ratio = opts.topk_ratio if topk_ratio is None else topk_ratio
    plan = build_plan(
        text_len=text_len, video_grid=video_grid, audio_len=audio_len,
        block_size=opts.block_size, device=device,
    )
    torch.manual_seed(seed)
    n_orig = plan["n_orig"]
    q0 = torch.randn(n_orig, heads, head_dim, device=device, dtype=torch.bfloat16)
    k0 = torch.randn(n_orig, heads, head_dim, device=device, dtype=torch.bfloat16)
    v0 = torch.randn(n_orig, heads, head_dim, device=device, dtype=torch.bfloat16)
    gate0 = torch.randn(n_orig, heads, head_dim, device=device, dtype=torch.bfloat16)
    q = gather_padded(q0, plan)
    k = gather_padded(k0, plan)
    v = gather_padded(v0, plan)
    gate = gather_padded(gate0, plan)

    substages: dict[str, float] = {}
    holder: dict[str, Any] = {}

    def _run_local():
        holder["result"] = run_local_core(
            q, k, v,
            block_len=plan["block_len"],
            n_prefix=plan["n_prefix"],
            coarse_gate=gate,
        )

    substages["local_sm120_ms"] = _time_cuda(_run_local)
    result = holder["result"]
    kitchen_ms = None
    aggressive_ms = None
    kitchen_error = None
    if compare_kitchen and device != "cpu":
        try:
            def _run_kitchen():
                holder["kitchen_out"] = _kitchen_sol_attn(q, k, v, gate, plan, ratio)

            substages["kitchen_ms"] = _time_cuda(_run_kitchen)
            kitchen_ms = substages["kitchen_ms"]

            def _run_aggressive():
                holder["aggressive_out"] = _kitchen_sol_attn(
                    q, k, v, gate, plan, aggressive_topk)

            substages["kitchen_density_5_ms"] = _time_cuda(_run_aggressive)
            aggressive_ms = substages["kitchen_density_5_ms"]
        except Exception as exc:  # noqa: BLE001 - microbench records unavailable arms
            kitchen_error = f"{type(exc).__name__}: {exc}"
    local_ms = substages["local_sm120_ms"]
    gate_report = {
        "need_pct": 15.0,
        "status": "not_measured",
        "note": "Kitchen compare skipped (CPU or compare_kitchen=false).",
    }
    if kitchen_ms is not None:
        win_pct = (kitchen_ms - local_ms) / kitchen_ms * 100.0 if kitchen_ms else None
        gate_report = {
            "need_pct": 15.0,
            "status": "passed" if win_pct is not None and win_pct >= 15.0 else "failed",
            "win_pct": None if win_pct is None else round(win_pct, 3),
            "kitchen_ms": kitchen_ms,
            "local_ms": local_ms,
            "promote_to_clip": bool(win_pct is not None and win_pct >= 15.0),
        }
    report: dict[str, Any] = {
        "label": None,
        "backend": opts.backend,
        "same_math": opts.same_math,
        "quality_class": opts.quality_class,
        "tokens_padded": plan["n"],
        "tokens_orig": plan["n_orig"],
        "n_prefix_blocks": plan["n_prefix"],
        "n_blocks": int(plan["block_len"].numel()),
        "heads": heads,
        "head_dim": head_dim,
        "block_size": opts.block_size,
        "topk_ratio": ratio,
        "partial_cubes": any(int(x) % 4 for x in video_grid),
        "kernel_ms": local_ms,
        "local_ms": local_ms,
        "kitchen_ms": kitchen_ms,
        "kitchen_density_5_ms": aggressive_ms,
        "kitchen_error": kitchen_error,
        "substages_ms": substages,
        "selection_hash": result["selection_hash"],
        "n_keep_video": result["n_keep_video"],
        "finite": bool(torch.isfinite(result["out"]).all()),
        "kitchen": kitchen_control_note(),
        "isolated_kernel_gate": gate_report,
    }
    if compare_dense and abs(ratio - 1.0) < 1e-12:
        live = token_mask(plan["block_len"], opts.block_size).reshape(-1)
        dense = dense_masked_attn(
            q.float(), k.float(), v.float(), live, scale=head_dim ** -0.5,
        )
        # Fine-only: re-run without coarse gate for the dense check.
        fine = run_local_core(
            q, k, v, block_len=plan["block_len"], n_prefix=plan["n_prefix"],
            coarse_gate=None,
        )
        delta = (fine["out"].float() - dense).abs().max().item()
        report["dense_parity_max_abs"] = delta
        report["dense_parity_ok"] = delta < 5e-2
    return report
