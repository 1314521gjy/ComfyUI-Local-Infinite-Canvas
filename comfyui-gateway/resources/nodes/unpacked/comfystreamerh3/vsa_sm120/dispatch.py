"""Kitchen vs local SM120 VSA. Unknown backends fail closed."""
from __future__ import annotations

import inspect
import os
from collections.abc import Callable, Iterable
from contextlib import nullcontext
from functools import lru_cache
from itertools import chain, pairwise
from typing import Any, cast

import torch

try:
    from ..nvtx import nvtx_range
except ImportError:
    try:
        from nvtx import nvtx_range  # type: ignore[import-not-found, no-redef]
    except ImportError:
        nvtx_range = cast(Any, nullcontext)

from ..attention_execution import record_attention
from .config import PRODUCT_KITCHEN_PIN, kitchen_version, vsa_options

_MASK_CACHE: Any | None = None


def mask_cache() -> Any:
    global _MASK_CACHE
    from .unsafe import MaskCache
    opts = vsa_options()
    if _MASK_CACHE is None or _MASK_CACHE.mode != opts.mask_reuse:
        _MASK_CACHE = MaskCache(mode=opts.mask_reuse)
    return _MASK_CACHE


def reset_mask_cache() -> None:
    global _MASK_CACHE
    _MASK_CACHE = None


def kitchen_control_note() -> dict[str, Any]:
    installed = kitchen_version()
    return {
        "product_pin": PRODUCT_KITCHEN_PIN,
        "installed": installed,
        "token_aug": vsa_options().token_aug,
        "note": (
            "Do not bump the product comfy-kitchen pin without an approved "
            "0.2.32 vs 0.2.33 (token_aug=0) measurement."
        ),
    }


def _maybe_token_aug(fn, extra: dict[str, Any]) -> dict[str, Any]:
    opts = vsa_options()
    if opts.token_aug is None:
        return extra
    if "token_aug" not in _keyword_params(fn):
        return extra
    out = dict(extra)
    out["token_aug"] = opts.token_aug
    return out


@lru_cache(maxsize=64)
def _keyword_params(fn) -> frozenset[str]:
    """Cache signature inspection for the hot baseline dispatch path."""
    try:
        return frozenset(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return frozenset()


def _accepts_keyword(fn, name: str) -> bool:
    """Return whether a Kitchen callable can receive an optional keyword."""
    return name in _keyword_params(fn)


def _resolve_native_stage_timings(diagnostics: dict[str, Any]) -> None:
    """Materialize opt-in GPU event timings after the native call completes."""
    events = diagnostics.pop("stage_timing_events", None)
    if not events:
        return
    # The final event is recorded after the native output/merge work. Waiting
    # here keeps synchronization out of normal inference and makes every
    # interval below attributable to the same producer stream.
    events[-1][1].synchronize()
    timings = {}
    for (start_name, start), (end_name, end) in pairwise(events):
        timings[f"{start_name}->{end_name}"] = float(start.elapsed_time(end))
    diagnostics["stage_timings_ms"] = timings


def _resolved_omega_config(policy: dict[str, Any] | None) -> dict[str, Any] | None:
    """Validate the request-local OMEGA identity at the dispatch seam."""
    if not policy or policy.get("omega_config") is None:
        return None
    from ..omega_config import ensure_omega_config
    return ensure_omega_config(policy["omega_config"])


def _qkv_from_chunks(chunks: Iterable[torch.Tensor], n: int, heads: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    iterator = iter(chunks)
    try:
        first = next(iterator)
    except StopIteration as error:
        raise RuntimeError("local VSA: qkv chunk stream is empty") from error
    if first.ndim != 2 or first.shape[0] == 0:
        raise RuntimeError("local VSA: qkv chunks must be nonempty [rows, hidden] tensors")
    if first.shape[0] > n:
        raise RuntimeError(f"local VSA: first qkv chunk exceeds expected {n} rows")
    qkv = first.new_empty((n, first.shape[-1]))
    cursor = 0
    for piece in chain((first,), iterator):
        if piece.ndim != 2 or piece.shape[1] != qkv.shape[1]:
            raise RuntimeError("local VSA: qkv chunks must share [rows, hidden] shape")
        end = cursor + piece.shape[0]
        if end > n:
            raise RuntimeError(f"local VSA: qkv chunks exceed expected {n} rows")
        qkv[cursor:end].copy_(piece)
        cursor = end
    if cursor != n:
        raise RuntimeError(f"local VSA: expected {n} qkv rows, got {cursor}")
    hidden = qkv.shape[-1] // 3
    q, k, v = qkv.split(hidden, dim=-1)
    hd = hidden // heads
    return q.view(n, heads, hd), k.view(n, heads, hd), v.view(n, heads, hd)


def _apply_qknorm_rope(q, k, freqs, q_weight, k_weight, eps: float):
    """H3 per-head RMSNorm and partial split-half RoPE (native matrix table)."""
    if q.ndim != 3 or k.shape != q.shape or any(size <= 0 for size in q.shape):
        raise ValueError("local VSA: q and k must have matching nonempty [S, H, D] shapes")
    if q.device != k.device or q.dtype != k.dtype or not q.is_floating_point():
        raise ValueError("local VSA: q and k must share a floating dtype and device")
    for name, weight in (("q", q_weight), ("k", k_weight)):
        if weight.shape != (q.shape[-1],) or not weight.is_floating_point():
            raise ValueError(f"local VSA: {name} norm weight must be a floating [D] tensor")
    if freqs is not None:
        # rope_rotation_table in comfy.ldm.minimax.model emits exactly this
        # layout. Never squeeze in a loop: the pair axis need not be singleton.
        if (freqs.ndim != 6 or freqs.shape[:3] != (1, q.shape[0], 1)
                or freqs.shape[-2:] != (2, 2) or not freqs.is_floating_point()):
            raise ValueError("local VSA: RoPE table must be floating [1, S, 1, R/2, 2, 2]")
        rotary = freqs.shape[-3] * 2
        if not 0 < rotary <= q.shape[-1]:
            raise ValueError("local VSA: RoPE rotary width must be in (0, D]")

    def _rms(x, weight):
        # Match Attention's RMSNorm / Kitchen eager rms_rope_split_half.
        return torch.nn.functional.rms_norm(
            x, (x.shape[-1],), weight=weight.to(device=x.device), eps=eps,
        )

    q = _rms(q, q_weight)
    k = _rms(k, k_weight)
    if freqs is None:
        return q, k
    table = freqs[0].to(device=q.device)

    def _rotate(x):
        half = rotary // 2
        left = x[..., :half].to(table.dtype)
        right = x[..., half:rotary].to(table.dtype)
        # Pair channel i with i + R/2, not adjacent even/odd channels.
        first = table[..., 0, 0] * left + table[..., 0, 1] * right
        second = table[..., 1, 0] * left + table[..., 1, 1] * right
        rotated = torch.cat((first, second), dim=-1).to(x.dtype)
        return torch.cat((rotated, x[..., rotary:]), dim=-1)

    return _rotate(q), _rotate(k)


def run_local_core(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    *,
    block_len: torch.Tensor,
    n_prefix: int,
    coarse_gate: torch.Tensor | None,
    layer: int = 0,
    step: int = 0,
) -> dict[str, Any]:
    from .reference import sparse_attn

    with nvtx_range("vsa_layout"):
        opts = vsa_options()
    with nvtx_range("vsa_route"):
        result = sparse_attn(
            q, k, v,
            block_len=block_len,
            n_prefix=n_prefix,
            topk_ratio=opts.topk_ratio,
            block_size=opts.block_size,
            coarse_gate=coarse_gate,
            kv_quant=opts.kv_quant,
            mask_cache=mask_cache() if opts.mask_reuse != "off" else None,
            layer=layer,
            step=step,
        )
    result["backend"] = "local_sm120"
    result["same_math"] = opts.same_math
    result["quality_class"] = opts.quality_class
    result["kitchen"] = kitchen_control_note()
    return result


def run_vsa_chunked(
    chunks: Callable[[], Iterable[torch.Tensor]] | Iterable[torch.Tensor],
    n: int,
    heads: int,
    freqs,
    qk_weights,
    *,
    tau: float,
    topk_ratio: float,
    sink_blocks: list[int],
    sink_q: list[int],
    rope_eps: float,
    extra: dict[str, Any],
    kitchen_fn=None,
    kmean=None,
    vscale=None,
    attention_option: str | None = None,
    backend: str | None = None,
    block_size: int | None = None,
    token_aug: int | None = None,
    attention_policy: dict | None = None,
    native_state: dict | None = None,
    evaluation_index: int | None = None,
    omega_config: dict[str, Any] | None = None,
) -> tuple[torch.Tensor, Any, Any]:
    """Dispatch. Kitchen is called with the same callable the producer used."""
    opts = vsa_options()
    selected_option = opts.attention_option if attention_option is None else attention_option
    selected_backend = (opts.backend if backend is None else backend)
    policy = attention_policy or {}
    resolved_omega = omega_config or _resolved_omega_config(policy)
    if (resolved_omega is not None
            and (resolved_omega.get("attention_option") != selected_option
                 or resolved_omega.get("backend") != selected_backend)):
        raise ValueError(
            "OMEGA config identity is incompatible with dispatch: "
            f"config={resolved_omega.get('attention_option')}/"
            f"{resolved_omega.get('backend')}, "
            f"dispatch={selected_option}/{selected_backend}"
        )
    if selected_option != "vsa" and selected_backend != "native":
        selected_backend = "local_sm120"
    if token_aug is not None and token_aug not in (0, 64, 128, 256):
        raise ValueError("token_aug must be 0, 64, 128 or 256")
    if selected_backend == "native":
        if selected_option not in ("vc", "anemoi", "combined"):
            raise ValueError("native candidate dispatch requires vc, anemoi or combined")
        from ..native_attention import ValidationContext, run_chunked

        diagnostics: dict[str, Any] = {
            "record_stage_timings": os.getenv("FASTH3_RECORD_STAGE_TIMINGS") == "1",
        }
        if resolved_omega is not None:
            diagnostics["omega_config"] = resolved_omega
        state = {} if native_state is None else native_state
        candidate_kwargs = {"validation_context": state.setdefault(
            "_layout_validation", ValidationContext())}
        direct_prefix_output = (
            os.getenv("FASTH3_DIRECT_PREFIX_OUTPUT") == "1"
            and selected_option in ("anemoi", "combined")
            and policy.get("variant", "control") == "control"
        )
        if direct_prefix_output:
            candidate_kwargs["direct_prefix_output"] = True
            diagnostics["direct_prefix_output_requested"] = True
        if policy.get("variant", "control") != "control":
            state.setdefault("scope", ("request_layer", id(state)))
            candidate_kwargs.update(
                grouping_policy=policy["grouping_policy"],
                grouping_schedule=policy["grouping_schedule"],
                grouping_state=state, evaluation_index=evaluation_index,
            )
            if selected_option == "vc":
                candidate_kwargs["pv_precision"] = policy["pv_precision"]
            else:
                candidate_kwargs.update(attention_kernel_policy=policy["attention_kernel_policy"],
                                        native_state=state,
                                        nvfp4_range_margin=policy["nvfp4_range_margin"])
        scratch_pool = policy.get("scratch_pool", state.get("_scratch_pool"))
        if policy.get("fusion_scratch_pool") and scratch_pool is None:
            from ..native_attention.scratch import ScratchPool
            # Native workspaces are hundreds of MB to several GB and H3 has
            # roughly 50 layer/geometry keys. The generic 1 GB/four-entry cap
            # causes repeated overflow allocations, erasing the reuse win.
            # Keep a bounded 32 GB pool for the 96 GB SM120 worker.
            scratch_pool = state.setdefault(
                "_scratch_pool", ScratchPool(max_bytes=32 * 1024**3, max_entries=64)
            )
        if scratch_pool is not None:
            candidate_kwargs["scratch_pool"] = scratch_pool
        retained_operand_bytes = policy.get(
            "retained_operand_bytes", policy.get("fusion_retained_operand_bytes", 0))
        # VC keeps the same H3 geometry across its request-local layers.  Its
        # host-side plan is immutable and device-independent, so cache it by
        # default; Anemoi/combined remain opt-in until their richer geometry
        # and grouping contracts are separately qualified.
        reuse_geometry = policy.get(
            "reuse_geometry", policy.get("fusion_reuse_geometry", False))
        if selected_option == "vc" and not reuse_geometry:
            reuse_geometry = True
            diagnostics["vc_geometry_reuse_defaulted"] = True
        if retained_operand_bytes:
            candidate_kwargs["retained_operand_bytes"] = retained_operand_bytes
        if reuse_geometry:
            candidate_kwargs["reuse_geometry"] = True
        if selected_option in ("anemoi", "combined"):
            for name in ("share_phase_validity", "native_preparation", "native_ragged_preparation",
                         "optimize_phase_metadata"):
                if policy.get(name, False):
                    candidate_kwargs[name] = True
            if policy.get("fused_route_metadata", False):
                candidate_kwargs["fused_route_metadata"] = True
        output = run_chunked(
            selected_option, chunks, n, heads, freqs, qk_weights,
            kmean=kmean, vscale=vscale, tau=tau, topk_ratio=topk_ratio,
            sink_blocks=list(sink_blocks), sink_q=list(sink_q), rope_eps=rope_eps,
            block_len=extra.get("block_len"), coarse_gate=extra.get("coarse_gate"),
            token_aug=0 if token_aug is None else token_aug, tail=extra.get("tail", False),
            diagnostics=diagnostics,
            **candidate_kwargs,
        )
        _resolve_native_stage_timings(diagnostics)
        record_attention(f"native_{selected_option}", selected_option, diagnostics)
        return output
    if selected_backend == "kitchen":
        if kitchen_fn is None:
            import comfy_kitchen
            kitchen_fn = comfy_kitchen.sol_attn_chunked
        kitchen_extra = {k: v for k, v in extra.items() if k != "n_prefix"}
        call_extra = _maybe_token_aug(kitchen_fn, kitchen_extra)
        if token_aug is not None and _accepts_keyword(kitchen_fn, "token_aug"):
            call_extra["token_aug"] = token_aug
        output = kitchen_fn(
            chunks, n, heads, freqs, qk_weights,
            kmean=kmean, vscale=vscale,
            tau=tau, topk_ratio=topk_ratio,
            sink_blocks=list(sink_blocks), sink_q=list(sink_q),
            rope_eps=rope_eps, **call_extra,
        )
        kitchen_diagnostics: dict[str, Any] | None = (
            None if resolved_omega is None else {"omega_config": resolved_omega}
        )
        record_attention("kitchen", "vsa", kitchen_diagnostics)
        return output
    if selected_backend != "local_sm120":
        raise RuntimeError(
            f"FastH3 VSA backend {selected_backend!r} is not implemented; dense fallback is disabled"
        )
    sequence = chunks() if callable(chunks) else chunks
    q, k, v = _qkv_from_chunks(sequence, n, heads)
    qw, kw = qk_weights
    q, k = _apply_qknorm_rope(q, k, freqs, qw, kw, rope_eps)
    gate = extra.get("coarse_gate")
    if gate is not None and gate.dim() == 4:
        gate = gate[0]
    block_len = extra["block_len"]
    n_prefix = extra.get("n_prefix", sink_blocks[1] if sink_blocks else 0)
    if selected_option == "vsa":
        result = run_local_core(
            q, k, v, block_len=block_len, n_prefix=n_prefix, coarse_gate=gate,
        )
    else:
        from .attention_candidates import run_attention_option

        result = run_attention_option(
            selected_option,
            q,
            k,
            v,
            block_len=block_len,
            n_prefix=n_prefix,
            topk_ratio=topk_ratio,
            block_size=opts.block_size if block_size is None else block_size,
            coarse_gate=gate,
        )
    # Candidate references accumulate in FP32, but H3's projection weights
    # are BF16.  Match the producer dtype at this ABI boundary.
    out = result["out"].to(dtype=q.dtype).reshape(n, heads * q.shape[-1])
    record_attention(result.get("backend", "local_reference"), selected_option)
    # The tensor reference does not own Kitchen's rolling calibration cache.
    # Preserve the caller's statistics so a candidate evaluation cannot erase
    # the original producer state for a later VSA/control comparison.
    return out, kmean, vscale
