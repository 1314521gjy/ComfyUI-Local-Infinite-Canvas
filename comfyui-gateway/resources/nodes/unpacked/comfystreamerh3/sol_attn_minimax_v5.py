"""Sol-Attn (arXiv 2607.24027) for MiniMax-H3, via comfy-kitchen's CUDA kernels.

Single-file node: installs an ``optimized_attention_override`` on the model
(per-model patch, sigma-scheduled dense warm-up), with H3's conditioning sink
and override chaining. Requires comfy_kitchen with ``sol_attn`` (bf16, head_dim
128, sm_80+); everything else falls back to the existing attention backend.
"""

import logging
import sys
from contextlib import nullcontext
from functools import partial
from typing import Any, cast

import torch
from comfy_api.latest import ComfyExtension, io

from .attention_execution import (
    current_evaluation,
    native_layer_state,
    record_attention,
    record_producer_chunk,
)

try:
    from .nvtx import nvtx_range
except ImportError:
    nvtx_range = cast(Any, nullcontext)

try:
    import comfy_kitchen as _ck
    _CK_IMPORT_ERROR = None
except Exception as exc:  # noqa: BLE001 - optional dependency import must fail closed
    _ck = None
    _CK_IMPORT_ERROR = exc

logger = logging.getLogger(__name__)

HEAD_DIM = 128
BLOCK_SIZE = 64

# OMEGA producer controls are deliberately local to the baseline producer.  A
# missing mapping means *all* OMEGA bits are off; this is important because the
# candidate/native flags belong to the VC/Anemoi dispatch and must never leak
# into the Kitchen VSA control.
OMEGA_PRODUCER_FLAGS = (
    "omega_skip_measure_gate",
    "omega_masked_retile",
    "omega_native_masked_retile",
    "omega_fusion_scratch_pool",
    "omega_measure_only",
    "omega_producer_direct_carriers",
)

_stats = {"sparse": 0, "producer": 0, "dense_fallback": 0, "outside_range": 0,
          "errors": 0, "omega_flags_applied": 0,
          "omega_skip_measure_gate_applied": 0,
          "omega_masked_retile_applied": 0,
          "omega_native_masked_retile_applied": 0,
          "omega_fusion_scratch_pool_applied": 0,
          "omega_scratch_pool_allocations": 0,
          "omega_scratch_pool_reuses": 0,
          "omega_measure_only_applied": 0,
          "omega_direct_carriers_applied": 0,
          "omega_python_hook_allocations_removed": 0,
          "omega_python_hook_copy_bytes_removed": 0,
          "producer_metadata_cache_hits": 0,
          "producer_metadata_cache_misses": 0,
          "producer_contiguous_reuses": 0}
_seen: set[tuple[Any, ...]] = set()




def sol_attn_stats():
    """Dispatch counters since process start (or last reset)."""
    return dict(_stats)


def reset_sol_attn_stats():
    for key in _stats:
        _stats[key] = 0
    _seen.clear()
    _PRODUCER_STATS.clear()
    _PRODUCER_CHUNK_RANGES.clear()


def resolve_omega_producer_flags(flags=None):
    """Resolve the baseline producer experiment bits with an all-off default.

    The resolver intentionally accepts only the producer flags owned by this
    module.  Native candidate flags are rejected at the caller boundary rather
    than silently changing the VSA/Kitchen control.  ``all_off`` is a control
    convenience for benchmark runners and is not itself an experiment bit.
    Legacy producer names are mapped by ``_apply_patch`` so existing workflows
    remain source-compatible while OMEGA reports the effective bits explicitly.
    """
    if flags is None:
        return {name: False for name in OMEGA_PRODUCER_FLAGS}
    if not isinstance(flags, dict):
        raise TypeError("omega producer flags must be a mapping or None")
    unknown = set(flags) - set(OMEGA_PRODUCER_FLAGS) - {"all_off"}
    if unknown:
        raise ValueError(f"unknown OMEGA producer flags: {sorted(unknown)}")
    if flags.get("all_off", False):
        return {name: False for name in OMEGA_PRODUCER_FLAGS}
    resolved = {name: bool(flags.get(name, False)) for name in OMEGA_PRODUCER_FLAGS}
    if resolved["omega_native_masked_retile"] and resolved["omega_masked_retile"]:
        raise ValueError("OMEGA reference and native masked retile are mutually exclusive")
    if resolved["omega_measure_only"] and not resolved["omega_skip_measure_gate"]:
        # Measure-only is the native name for the existing bootstrap-gate
        # elision. Requiring the explicit bit prevents a hidden second mode.
        raise ValueError("omega_measure_only requires omega_skip_measure_gate")
    return resolved


def _log_once(key, message):
    if key not in _seen:
        _seen.add(key)
        logger.info("[sol_attn] %s", message)


def _log_kernel_failure(exc):
    # Full traceback on the first distinct failure, short line on repeats.
    key = ("kernel_failure", type(exc).__name__, str(exc))
    first = key not in _seen
    _seen.add(key)
    logger.error("[sol_attn] kernel failed (%s); falling back", exc, exc_info=first)


# ---------------------------------------------------------------------------
# H3 segment layout: publish the packed video / target-audio spans of the
# current call so the attention override can keep the conditioning rows exact.
# ---------------------------------------------------------------------------

def _h3_log_once(message):
    _log_once(("h3", message), f"H3 layout: {message}")


_INSTALLED = set()
_PATCHED_LAYOUTS = set()
# id(position_ids) -> (layout, video bounds, audio bounds). The layout is kept
# alive deliberately so the id cannot be recycled underneath us; there is one
# entry per distinct shape.
_SPANS = {}


def _patch_packed_layout(module):
    """Register the segment bounds of every PackedLayout built, without mutating it."""
    layout_cls = getattr(module, "PackedLayout", None)
    if layout_cls is None:
        raise RuntimeError(f"{module.__name__} has no PackedLayout")
    if id(layout_cls) in _PATCHED_LAYOUTS:
        return
    original_init = layout_cls.__init__

    def __init__(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        segs = getattr(self, "segments", []) or []
        video = next(((a, b) for a, b, kind in segs if kind == "video"), None)
        # Target audio is the segment immediately before video; sink_q only
        # needs THOSE query rows dense, not the (possibly huge) reference rows.
        audio = next(((a, b) for a, b, kind in segs if kind == "audio"), None)
        if torch.is_tensor(getattr(self, "position_ids", None)) and video is not None:
            _SPANS[id(self.position_ids)] = (self, video, audio)

    layout_cls.__init__ = __init__
    _PATCHED_LAYOUTS.add(id(layout_cls))


def install_h3_layout(model):
    """Idempotently hook the model so each forward publishes its segment spans
    into transformer_options (read by the override's sink logic)."""
    if id(model) in _INSTALLED:
        return
    for attr in ("rope_freqs", "_forward"):
        if not hasattr(model, attr):
            raise RuntimeError(f"MiniMax-H3 layout hook needs .{attr} on the diffusion model")

    # The stock MiniMax module owns PackedLayout. Walk the MRO to preserve
    # compatible external subclasses without duplicating that layout factory.
    layout_module = next(
        (sys.modules[cls.__module__] for cls in type(model).__mro__
         if hasattr(sys.modules[cls.__module__], "PackedLayout")),
        None,
    )
    if layout_module is None:
        raise RuntimeError("MiniMax-H3 module exposes no PackedLayout")
    _patch_packed_layout(layout_module)

    original_forward = model._forward
    original_rope_freqs = model.rope_freqs

    def _forward(x, timestep, context, transformer_options=None, **kwargs):
        transformer_options = transformer_options or {}
        model._sol_transformer_options = transformer_options
        # Cache scalar extraction only inside this invocation. A sampler may
        # reuse and mutate the same sigma tensor on the next invocation.
        cache_key = "sol_h3_sigma_cache"
        missing = object()
        previous_cache = transformer_options.get(cache_key, missing)
        transformer_options[cache_key] = {}
        try:
            return model._sol_core_forward(x, timestep, context,
                                    transformer_options=transformer_options, **kwargs)
        finally:
            if previous_cache is missing:
                transformer_options.pop(cache_key, None)
            else:
                transformer_options[cache_key] = previous_cache
            model._sol_transformer_options = None
            transformer_options.pop("sol_h3_video_span", None)
            transformer_options.pop("sol_h3_audio_span", None)
            transformer_options.pop("sol_h3_layout", None)

    def rope_freqs(position_ids, device):
        entry = _SPANS.get(id(position_ids))
        if entry is None:
            _h3_log_once("no layout registered; the conditioning sink is inactive")
        else:
            layout, video, audio = entry
            options = getattr(model, "_sol_transformer_options", None)
            if options is not None:
                options["sol_h3_video_span"] = video
                options["sol_h3_audio_span"] = audio
                options["sol_h3_layout"] = layout
        return original_rope_freqs(position_ids, device)

    # Keep context setup/cleanup eager when the math core is compiled. These
    # Python mutations are observed by eager attention/rope callbacks.
    model._sol_core_forward = original_forward
    model._forward = _forward
    model.rope_freqs = rope_freqs
    _INSTALLED.add(id(model))


def _gate(transformer_options, tokens, min_tokens, sigma_start, sigma_end):
    """Why this call stays dense regardless of its tensors -- too short, or
    outside the sampling window (the paper's dense warm-up) -- as a
    (stats counter, reason) pair, or None."""
    if tokens < min_tokens:
        return "dense_fallback", f"seq {tokens} < {min_tokens}"
    sigmas = (transformer_options or {}).get("sigmas")
    if sigmas is not None:
        cache = (transformer_options or {}).get("sol_h3_sigma_cache")
        if cache is not None and cache.get("source") is sigmas:
            sigma = cache["value"]
        else:
            sigma = float(sigmas[0])
            if cache is not None:
                cache.update(source=sigmas, value=sigma)
        if (sigma_start is not None and sigma > sigma_start) or \
           (sigma_end is not None and sigma < sigma_end):
            return "outside_range", f"sigma {sigma:.3g} outside the sparse window"
    return None


def _ineligible(q, k, dim_head):
    """Why these tensors can't go through the kernel, or None. q/k are BTHD."""
    if q.device.type != "cuda":
        return "not cuda"
    if q.dtype != torch.bfloat16:
        return f"dtype {q.dtype} (kernel is bf16-only)"
    if dim_head != HEAD_DIM:
        return f"head_dim {dim_head} != 128"
    if q.shape[1] != k.shape[1]:
        return "cross-attention (kept dense)"
    if q.shape != k.shape:
        # GQA or any other q/k mismatch would silently index wrong.
        return f"q/k shape mismatch {tuple(q.shape)} vs {tuple(k.shape)}"
    return None


def _run(q, k, v, heads, skip_reshape, skip_output_reshape, scale,
         tau, verbose, sink_blocks=(0, 0), sink_q=(0, 0), topk_ratio=0.0,
         attention_backend="kitchen"):
    """Returns the attention output, or None if this call should stay dense."""
    if skip_reshape:
        b, _, _, dim_head = q.shape          # BHND
        qs, ks, vs = (t.transpose(1, 2) for t in (q, k, v))
    else:
        b, _, dim_head = q.shape             # B, N, heads*dim_head
        dim_head //= heads
        qs, ks, vs = (t.view(b, -1, heads, dim_head) for t in (q, k, v))

    reason = _ineligible(qs, ks, dim_head)
    if reason is not None:
        _stats["dense_fallback"] += 1
        if verbose:
            _log_once((tuple(qs.shape), reason), f"dense {tuple(qs.shape)}: {reason}")
        return None

    if attention_backend == "cute_sol":
        from .cute_sol import attention as cute_attention
        from .cute_sol import require as require_cute_sol
        capability = require_cute_sol(q.device)
        out = cute_attention(
            q if skip_reshape else qs,
            k if skip_reshape else ks,
            v if skip_reshape else vs,
            heads=heads,
            tau=tau,
            scale=scale,
            sink_blocks=tuple(sink_blocks),
            capability=capability,
        )
        record_attention(
            capability.backend or "cute_sm120",
            "cute_sol",
            {"executed_backend": capability.backend or "cute_sm120"},
        )
    else:
        out = _ck.sol_attn(
            qs, ks, vs, tau=tau, scale=scale,
            sink_blocks=list(sink_blocks), sink_q=list(sink_q),
            topk_ratio=topk_ratio,
        )  # BTHD
    _stats["sparse"] += 1
    if verbose:
        sel = f"topk={topk_ratio:.3f}" if topk_ratio else f"tau={tau}"
        _log_once((tuple(qs.shape), "sparse"),
                  f"sparse {tuple(qs.shape)} {sel} cuda-int8")

    if skip_output_reshape:
        return out.transpose(1, 2)           # BHND
    return out.reshape(b, -1, heads * dim_head)


_PRODUCER_STATS: dict[Any, Any] = {}
_PRODUCER_CHUNK = 8192
_PRODUCER_CHUNK_RANGES: dict[tuple[int, int], tuple[tuple[int, int], ...]] = {}
_PRODUCER_CHUNK_RANGES_MAX = 8


def _producer_chunk_ranges(n, chunk_size):
    """Return bounded immutable chunk metadata for repeated producer calls."""
    key = (int(n), int(chunk_size))
    ranges = _PRODUCER_CHUNK_RANGES.get(key)
    if ranges is not None:
        _stats["producer_metadata_cache_hits"] += 1
        return ranges
    _stats["producer_metadata_cache_misses"] += 1
    ranges = tuple((i, min(chunk_size, n - i))
                   for i in range(0, n, chunk_size))
    while len(_PRODUCER_CHUNK_RANGES) >= _PRODUCER_CHUNK_RANGES_MAX:
        del _PRODUCER_CHUNK_RANGES[next(iter(_PRODUCER_CHUNK_RANGES))]
    _PRODUCER_CHUNK_RANGES[key] = ranges
    return ranges


def _producer_stats_key(module_id, n, attention_option, policy_variant, evaluation):
    """Choose the rolling-stat scope without retaining tensors across models.

    Kitchen/VSA, Anemoi/combined, and explicit VC control all use the
    caller-returned rolling producer statistics across Euler evaluations. VC
    non-control policies retain their stricter per-evaluation calibration.
    """
    if attention_option == "vsa" or (
        attention_option in ("vc", "anemoi", "combined")
        and (attention_option != "vc" or policy_variant == "control")
    ):
        return (module_id, n, attention_option, policy_variant)
    return (module_id, n, attention_option, policy_variant, evaluation)

# ---------------------------------------------------------------------------
# VSA (FastVideo) mode: the H3 sequence re-tiled the way VSA-H3 trains --
# prefix segments in their own zero-padded 64-row tiles, the video span in
# 4x4x4 cubes (partial edge cubes zero-padded), prefix tiles always attended
# and prefix queries dense, top-k over video tiles, no pooled tail, plus the
# gated coarse branch from the checkpoint's to_gate_compress weights.
# ---------------------------------------------------------------------------
_VSA_PLANS: dict[Any, Any] = {}  # (signature, segments, device) -> plan; small LRU, no layout refs
_VSA_PLANS_MAX = 4
_VSA_CUBE = (4, 4, 4)


def _vsa_plan(layout, device):
    """Padded tile order for one PackedLayout: `src` maps each padded row to
    its source row (-1 = pad, live rows first within a tile), `inv` maps each
    source row to its padded position, `block_len` counts live rows per tile."""
    key = (tuple(layout.signature), tuple(layout.segments), str(device))
    plan = _VSA_PLANS.get(key)
    if plan is not None:
        return plan
    _text_len, latent_t, latent_h, latent_w, _audio_t = layout.signature
    grid = (int(latent_t), int(latent_h) // 2, int(latent_w) // 2)
    tiles, n_prefix = [], 0
    for a, b, kind in layout.segments:
        n = b - a
        if kind != "video":
            m = (n + BLOCK_SIZE - 1) // BLOCK_SIZE
            seg = torch.full((m * BLOCK_SIZE,), -1, dtype=torch.int64)
            seg[:n] = torch.arange(a, b)
            tiles.append(seg.view(m, BLOCK_SIZE))
            n_prefix += m
            continue
        if grid[0] * grid[1] * grid[2] != n:
            raise RuntimeError(f"VSA: video segment {n} rows does not match grid {grid}")
        ct, ch, cw = _VSA_CUBE
        pt, ph, pw = ((g + c - 1) // c * c for g, c in zip(grid, _VSA_CUBE))
        padded = torch.full((pt, ph, pw), -1, dtype=torch.int64)
        padded[:grid[0], :grid[1], :grid[2]] = torch.arange(a, b).view(*grid)
        cubes = (padded.view(pt // ct, ct, ph // ch, ch, pw // cw, cw)
                 .permute(0, 2, 4, 1, 3, 5).reshape(-1, BLOCK_SIZE))
        order = torch.argsort((cubes < 0).to(torch.int8), dim=1, stable=True)   # live first
        tiles.append(torch.gather(cubes, 1, order))
    tiles_tensor = torch.cat(tiles)
    src = tiles_tensor.reshape(-1)
    live = src >= 0
    inv = torch.empty(layout.seq_len, dtype=torch.int64)
    inv[src[live]] = torch.nonzero(live).flatten()
    plan = {"n": int(src.numel()), "n_orig": int(layout.seq_len), "n_prefix": n_prefix,
            "src": src.to(device), "inv": inv.to(device),
            "gather_idx": src.clamp_min(0).to(device=device, dtype=torch.int32),
            "sent_idx": torch.where(live, src, layout.seq_len).to(device=device, dtype=torch.int32),
            "live_mask": live.unsqueeze(1).to(device=device, dtype=torch.bfloat16),
            "block_len": (tiles_tensor >= 0).sum(1).to(torch.int32).to(device)}
    while len(_VSA_PLANS) >= _VSA_PLANS_MAX:
        del _VSA_PLANS[next(iter(_VSA_PLANS))]
    _VSA_PLANS[key] = plan
    return plan


def _vsa_rope(rope_freqs, plan):
    """Permute rope to padded VSA order. Layout positions are step-invariant, so
    the padded table lives on the plan (same dtype/device/shape) across Euler
    steps instead of rebuilding whenever ``id(rope_freqs)`` changes."""
    hit = plan.get("rope_padded")
    if (hit is not None
            and hit.dtype == rope_freqs.dtype
            and hit.device == rope_freqs.device
            and hit.shape == ((1, plan["n"]) + tuple(rope_freqs.shape[2:]))):
        return hit
    padded = rope_freqs.new_zeros((1, plan["n"]) + tuple(rope_freqs.shape[2:]))
    padded[0, plan["inv"]] = rope_freqs[0]
    plan["rope_padded"] = padded
    return padded


def _vsa_padded_rows(x, plan, *, scratch=None):
    """Activations plus a trailing zero row at index ``n_orig`` for pad gathers."""
    if x.shape[0] == plan["n_orig"] + 1:
        return x
    if x.shape[0] != plan["n_orig"]:
        raise RuntimeError(
            f"VSA: expected {plan['n_orig']} rows or a trailing pad row, got {x.shape[0]}")
    if scratch is not None:
        shape = (plan["n_orig"] + 1,) + tuple(x.shape[1:])
        buffer = scratch.get("padded_rows")
        if buffer is None or buffer.shape != shape or buffer.dtype != x.dtype or buffer.device != x.device:
            buffer = x.new_empty(shape)
            scratch["padded_rows"] = buffer
            _stats["omega_scratch_pool_allocations"] += 1
        else:
            _stats["omega_scratch_pool_reuses"] += 1
        buffer[:-1].copy_(x)
        buffer[-1].zero_()
        return buffer
    return torch.cat([x, x.new_zeros((1,) + tuple(x.shape[1:]))], dim=0)


def _vsa_chunk(x, plan, i, m, *, padded=False):
    """Padded rows [i, i+m): live source rows, pad rows from the trailing zero."""
    rows = x if padded else _vsa_padded_rows(x, plan)
    return torch.index_select(rows, 0, plan["sent_idx"][i:i + m])


def _vsa_unpermute(out, plan):
    """Source-order rows from padded VSA output."""
    return torch.index_select(out, 0, plan["inv"])


def _make_producer_forward(module, stock_forward, opts):
    """Chunked-producer replacement for H3 Attention.forward: projects qkv in
    4K-token slices straight into comfy_kitchen's int8 carriers (norm+rope
    fused, full bf16 Q/K/V never materialised), then runs the sparse core.
    Anything ineligible falls back to the stock forward, whose attention call
    still reaches the normal override."""
    import comfy.model_management
    _ck_cuda = None
    if opts.get("attention_option", "vsa") == "vsa":
        from comfy_kitchen.backends import cuda as _ck_cuda  # type: ignore[no-redef]
    from .vsa_sm120.dispatch import run_vsa_chunked
    from .vsa_sm120.producer import (
        KitchenTraversalFactory,
        RetileScratch,
        masked_retile_reference,
        native_masked_retile,
        project_chunks,
    )

    def forward(x, rope_freqs=None, transformer_options=None):
        transformer_options = transformer_options or {}
        def fallback():
            if opts.get("vsa"):
                raise RuntimeError("FastH3 VSA preconditions failed; dense fallback is disabled")
            # The stock forward's attention call still reaches the override,
            # which applies the same gates and falls through to dense.
            return stock_forward(x, rope_freqs=rope_freqs,
                                 transformer_options=transformer_options)

        try:
            if (rope_freqs is None or x.dtype != torch.bfloat16 or x.dim() != 2
                    or x.device.type != "cuda"):
                return fallback()
            with nvtx_range("vsa_producer"):
                s = x.shape[0]
                if _gate(transformer_options, s, opts["min_tokens"],
                         opts["sigma_start"], opts["sigma_end"]) is not None:
                    return fallback()   # the override counts and logs it
                tau = opts["tau"]
                topk = opts.get("topk_ratio", 0.0)
                h, hd = module.heads, module.head_dim
                qw = comfy.model_management.cast_to(module.q_norm.weight, device=x.device)
                kw = comfy.model_management.cast_to(module.k_norm.weight, device=x.device)
                extra = {}
                vsa = bool(opts.get("vsa"))
                omega_flags = opts.get("omega_producer_flags", {})
                padded_scratch = None
                if vsa:
                    if omega_flags.get("omega_skip_measure_gate", False):
                        _stats["omega_skip_measure_gate_applied"] += 1
                    if omega_flags.get("omega_masked_retile", False):
                        _stats["omega_masked_retile_applied"] += 1
                    if omega_flags.get("omega_native_masked_retile", False):
                        _stats["omega_native_masked_retile_applied"] += 1
                    if omega_flags.get("omega_fusion_scratch_pool", False):
                        _stats["omega_fusion_scratch_pool_applied"] += 1
                freqs, n = rope_freqs, s
                if vsa:
                    layout = (transformer_options or {}).get("sol_h3_layout")
                    if layout is None or layout.seq_len != s:
                        _h3_log_once("no layout for this call; VSA tiling inactive")
                        return fallback()
                    plan = _vsa_plan(layout, x.device)
                    n = plan["n"]
                    freqs = _vsa_rope(rope_freqs, plan)
                    sink, sink_q = (0, plan["n_prefix"]), (0, plan["n_prefix"])
                    extra = {"tail": False, "block_len": plan["block_len"],
                             "n_prefix": plan["n_prefix"]}
                    gate = getattr(module, "to_gate_compress", None)   # a normal model layer
                    if gate is not None:
                        extra["coarse_gate"] = x.new_empty(n, h * hd).view(1, n, h, hd)
                    use_masked_retile = (
                        opts.get("producer_masked_retile", False)
                        or opts.get("producer_native_masked_retile", False)
                        or omega_flags.get("omega_masked_retile", False)
                        or omega_flags.get("omega_native_masked_retile", False)
                    )
                    if omega_flags.get("omega_fusion_scratch_pool", False):
                        padded_scratch = native_layer_state(("vsa_padded_rows_scratch", str(x.device)))
                    x_rows = x if use_masked_retile else _vsa_padded_rows(
                        x, plan, scratch=padded_scratch,
                    )
                else:
                    sink, sink_q = _sink_blocks(transformer_options, s,
                                                opts["sink_conditioning"])
                attention_option = opts.get("attention_option", "vsa")
                if (omega_flags.get("omega_producer_direct_carriers", False)
                        and attention_option == "vsa"
                        and opts.get("backend") == "kitchen"):
                    # The Kitchen chunked ABI already consumes projected chunks
                    # directly; it does not expose Q/K/V hook tensors. Count
                    # application at this seam, while keeping removed Python
                    # hook allocations/copies at their exact observed value
                    # (zero: this path never allocates them).
                    _stats["omega_flags_applied"] += 1
                    _stats["omega_direct_carriers_applied"] += 1
                policy_variant = (opts.get("attention_policy") or {}).get("variant", "control")
                # Anemoi/Combined control and mixed policies retain rolling
                # producer statistics across Euler evaluations. Reusing them
                # avoids replaying the expensive measurement traversal on every
                # step. VC keeps the stricter per-evaluation scale contract.
                reuse_mixed_stats = (
                    attention_option in ("anemoi", "combined")
                    and policy_variant != "control"
                )
                stats_key = _producer_stats_key(
                    id(module), n, attention_option, policy_variant, current_evaluation()
                )
                stats = _PRODUCER_STATS.get(stats_key)
                retile_scratch = None
                if (opts.get("producer_native_masked_retile", False)
                        and omega_flags.get("omega_fusion_scratch_pool", False)):
                    # Shared across layers only within the current request.
                    # The pool separates streams/dtypes/widths internally.
                    retile_state = native_layer_state(("vsa_retile_scratch", str(x.device)))
                    retile_scratch = retile_state.setdefault("scratch", RetileScratch())

                def chunks(mode="emit"):
                    chunk_size = opts.get("chunk_size", _PRODUCER_CHUNK)
                    chunk_ranges = _producer_chunk_ranges(n, chunk_size)
                    if vsa:
                        def gather(start, count):
                            if opts.get("producer_native_masked_retile", False):
                                return native_masked_retile(
                                    x_rows, plan["src"], start, count,
                                    scratch=retile_scratch, counters=_stats,
                                )
                            if opts.get("producer_masked_retile", False):
                                return masked_retile_reference(x_rows, plan["src"], start, count)
                            # x_rows already contains the trailing pad row for
                            # the ordinary VSA path. Reusing it here avoids a
                            # full activation concat for every producer chunk.
                            return _vsa_chunk(x_rows, plan, start, count,
                                              padded=True)

                        skip_measure_gate = (
                            opts.get("producer_skip_bootstrap_gate", False)
                            or omega_flags.get("omega_skip_measure_gate", False)
                            or omega_flags.get("omega_measure_only", False)
                        )
                        if omega_flags.get("omega_measure_only", False):
                            _stats["omega_flags_applied"] += 1
                            _stats["omega_measure_only_applied"] += 1
                        experiment = skip_measure_gate or use_masked_retile
                        yield from project_chunks(
                            n=n, chunk_size=chunk_size, gather=gather, qkv=module.qkv_proj,
                            gate=gate, gate_output=None if gate is None else extra["coarse_gate"].view(n, h * hd),
                            mode=mode, skip_measure_gate=skip_measure_gate,
                            counters=_stats if experiment else None,
                            record_chunk=record_producer_chunk, stage=nvtx_range,
                        )
                        return
                    for i, count in chunk_ranges:
                        with nvtx_range("vsa_qkv"):
                            record_producer_chunk()
                            chunk = x[i:i + count]
                            if chunk.is_contiguous():
                                _stats["producer_contiguous_reuses"] += 1
                            yield module.qkv_proj(chunk)
                traversal = None
                omega_flags = opts.get("omega_producer_flags", {})
                skip_measure_gate = (
                    opts.get("producer_skip_bootstrap_gate", False)
                    or omega_flags.get("omega_skip_measure_gate", False)
                    or omega_flags.get("omega_measure_only", False)
                )
                if skip_measure_gate:
                    traversal = KitchenTraversalFactory(
                        chunks, bootstrap=stats is None or stats[0] is None or stats[1] is None,
                        skip_measure_gate=True,
                    )
                layer_state = native_layer_state((id(module), n))
                with nvtx_range("vsa_core"):
                    out, km, vs = run_vsa_chunked(
                        traversal if traversal is not None else chunks, n, h, freqs, (qw, kw),
                        tau=tau, topk_ratio=topk,
                        sink_blocks=list(sink), sink_q=list(sink_q),
                        rope_eps=module.q_norm.eps, extra=extra,
                        kitchen_fn=(None if _ck_cuda is None else _ck_cuda.sol_attn_chunked),
                        kmean=None if stats is None else stats[0],
                        vscale=None if stats is None else stats[1],
                        attention_option=attention_option,
                        backend=opts.get("backend"),
                        block_size=opts.get("block_size"),
                        token_aug=opts.get("token_aug", 0),
                        attention_policy=opts.get("attention_policy"),
                        native_state=layer_state,
                        evaluation_index=current_evaluation(),
                    )
                if traversal is not None:
                    traversal.validate_complete()
                if reuse_mixed_stats:
                    calibration = layer_state.get("_anemoi_nv_calibration")
                    clipped = None if calibration is None else calibration.get("clipping_counts")
                    if clipped is not None and hasattr(clipped, "device"):
                        # Keep the gate on the producer stream; a host bool
                        # here would add a synchronization to every layer.
                        torch._assert_async(
                            (clipped == 0).all(),
                            "mixed native calibration clipped; statistics invalidated",
                        )
                _PRODUCER_STATS[stats_key] = (km, vs)
                _stats["producer"] += 1
                if opts["verbose"]:
                    sel = f"topk={topk:.3f}" if topk else f"tau={tau}"
                    mode = f"VSA tiles ({n} padded rows, {sink[1]} prefix tiles)" if vsa else "chunked qkv"
                    _log_once(("producer", n), f"producer path: {s} tokens, {mode}, {sel}")
                out = out.view(n, h * hd)
                if vsa:
                    with nvtx_range("vsa_unpermute"):
                        out = _vsa_unpermute(out, plan)
                with nvtx_range("attn_out_proj"):
                    return module.out_proj(out)
        except Exception as exc:
            _stats["errors"] += 1
            _log_kernel_failure(exc)
            if opts.get("vsa"):
                raise
            return fallback()

    return forward


def _sink_blocks(transformer_options, tokens, mode):
    """(exact-KV blocks, dense-query blocks) for MiniMax-H3's conditioning rows.

    H3 packs [text][cond][ref][audio][video] into one sequence; sparsifying the
    conditioning rows costs sync and prompt adherence. exact_kv measures ~3%,
    exact_kv_and_rows ~17%, so exact-KV is the default and rows are opt-in.
    """
    if mode == "off":
        return (0, 0), (0, 0)
    span = (transformer_options or {}).get("sol_h3_video_span")
    if span is None:
        return (0, 0), (0, 0)
    video_start, video_stop = span
    if tokens < video_stop or video_start <= 0:
        return (0, 0), (0, 0)
    blocks = (0, (video_start + BLOCK_SIZE - 1) // BLOCK_SIZE)
    if mode != "exact_kv_and_rows":
        return blocks, (0, 0)
    # Dense-query protection exists for the TARGET AUDIO rows; reference rows
    # only need the exact-KV side. Fall back to the whole conditioning range
    # when the layout did not publish an audio span.
    audio = (transformer_options or {}).get("sol_h3_audio_span")
    if audio is None:
        return blocks, blocks
    audio_start, _audio_stop = audio
    return blocks, (audio_start // BLOCK_SIZE, blocks[1])


def make_override(tau=1.0, min_tokens=4096,
                  sigma_start=None, sigma_end=None, verbose=False,
                  sink_conditioning="exact_kv", previous=None, topk_ratio=0.0,
                  vsa=False, attention_backend="kitchen"):
    """Build an optimized_attention_override callable.

    ``previous`` chains any override already installed on the model: every path
    that declines hands off to it first, falling through to ``func`` only if
    there is none. In VSA mode the override is dense-only: a VSA-trained
    checkpoint must never run plain block-sparse attention, so anything the
    producer patch declines runs dense here.
    """

    def override(func, q, k, v, heads, mask=None, attn_precision=None,
                 skip_reshape=False, skip_output_reshape=False, **kwargs):

        def dense():
            target = func if previous is None else partial(previous, func)
            return target(q, k, v, heads, mask=mask, attn_precision=attn_precision,
                          skip_reshape=skip_reshape,
                          skip_output_reshape=skip_output_reshape, **kwargs)

        if vsa:
            _stats["dense_fallback"] += 1
            raise RuntimeError("VSA producer was bypassed; dense substitution is forbidden")
        if mask is not None:
            _stats["dense_fallback"] += 1
            return dense()
        tokens = q.shape[2] if skip_reshape else q.shape[1]
        gated = _gate(kwargs.get("transformer_options"), tokens, min_tokens,
                      sigma_start, sigma_end)
        if gated is not None:
            counter, reason = gated
            _stats[counter] += 1
            if verbose:
                _log_once((tokens, reason), f"dense {tokens} tokens: {reason}")
            return dense()
        sink, sink_q = _sink_blocks(kwargs.get("transformer_options"), tokens,
                                    sink_conditioning)
        if verbose and sink != (0, 0):
            _log_once((tokens, sink, sink_q),
                      f"conditioning sink: KV blocks {sink} exact, dense query blocks {sink_q}")

        try:
            out = _run(q, k, v, heads, skip_reshape, skip_output_reshape,
                       kwargs.get("scale", None), tau, verbose,
                       sink, sink_q, topk_ratio, attention_backend)
        except Exception as exc:
            _stats["errors"] += 1
            _log_kernel_failure(exc)
            if attention_backend == "cute_sol":
                raise
            return dense()
        return dense() if out is None else out

    return override




def _apply_patch(model, *, tau, start_percent, end_percent, min_tokens,
                 sink_conditioning, verbose, topk_ratio=0.0, vsa=False,
                 chunk_size=8192, attention_option="vsa", token_aug=0, attention_policy=None,
                 producer_skip_bootstrap_gate=False, producer_masked_retile=False,
                 producer_native_masked_retile=False, omega_flags=None):
    if chunk_size not in (2048, 4096, 8192):
        raise ValueError("Unsupported producer chunk size")
    omega_producer_flags = resolve_omega_producer_flags(omega_flags)
    if omega_producer_flags["omega_skip_measure_gate"]:
        producer_skip_bootstrap_gate = True
    if omega_producer_flags["omega_masked_retile"]:
        producer_masked_retile = True
    if omega_producer_flags["omega_native_masked_retile"]:
        producer_native_masked_retile = True
    if omega_producer_flags["omega_measure_only"] and not vsa:
        raise ValueError("omega_measure_only requires stock Kitchen VSA traversal")
    if omega_producer_flags["omega_producer_direct_carriers"] and not vsa:
        raise ValueError("omega_producer_direct_carriers requires stock Kitchen VSA traversal")
    if producer_skip_bootstrap_gate and (not vsa or attention_option != "vsa"):
        raise ValueError("bootstrap gate skipping requires stock Kitchen VSA traversal")
    if (producer_masked_retile or producer_native_masked_retile) and not vsa:
        raise ValueError("masked retile requires VSA tile layout")
    if producer_masked_retile and producer_native_masked_retile:
        raise ValueError("reference and native masked retile are mutually exclusive")
    diffusion_model = model.get_model_object("diffusion_model")
    is_h3 = hasattr(diffusion_model, "rope_freqs") and hasattr(diffusion_model, "_forward")

    if is_h3 and (sink_conditioning != "off" or vsa):
        install_h3_layout(diffusion_model)
    blocks = getattr(diffusion_model, "blocks", None)
    if vsa and not is_h3:
        logger.warning("[sol_attn] VSA tiling needs MiniMax-H3; running plain top-k")
    elif vsa and blocks and not hasattr(blocks[0].attn, "to_gate_compress"):
        logger.warning("[sol_attn] VSA: checkpoint has no to_gate_compress weights; "
                       "running the fine stage only (no coarse branch)")

    model_sampling = model.get_model_object("model_sampling")
    sigma_start = float(model_sampling.percent_to_sigma(start_percent))
    sigma_end = float(model_sampling.percent_to_sigma(end_percent))

    m = model.clone()
    previous = m.model_options["transformer_options"].get("optimized_attention_override")
    if previous is not None:
        logging.info("[sol_attn] chaining onto an existing attention override")  # noqa: LOG015 - AST smoke contract

    # Chunked-producer path: patch each H3 self-attention forward so qkv is
    # projected in 4K slices straight into the int8 carriers (the full bf16
    # Q/K/V never exists). Both selection modes: top-k derives its threshold
    # from the producer's own pooled outputs in the workspace.
    if is_h3 and blocks is not None and attention_option != "cute_sol":
        opts = {"tau": tau, "topk_ratio": topk_ratio,
                "min_tokens": min_tokens,
                "sigma_start": sigma_start, "sigma_end": sigma_end,
                "sink_conditioning": sink_conditioning, "verbose": verbose,
                "vsa": vsa, "chunk_size": chunk_size,
                "attention_option": attention_option,
                "backend": "kitchen" if attention_option == "vsa" else "native",
                "token_aug": token_aug,
                "attention_policy": attention_policy,
                "producer_skip_bootstrap_gate": bool(producer_skip_bootstrap_gate),
                "producer_masked_retile": bool(producer_masked_retile),
                "producer_native_masked_retile": bool(producer_native_masked_retile),
                "omega_producer_flags": omega_producer_flags,
                "block_size": 64}
        installed = 0
        for i, blk in enumerate(blocks):
            attn = getattr(blk, "attn", None)
            if attn is None or not hasattr(attn, "qkv_proj"):
                continue
            key = f"diffusion_model.blocks.{i}.attn.forward"
            if key in m.object_patches:
                if vsa:
                    raise RuntimeError(f"Conflicting attention patch: {key}")
                continue   # someone else patched it; the override handles it
            m.add_object_patch(
                key, _make_producer_forward(attn, attn.forward, opts))
            installed += 1
        if installed:
            _PRODUCER_STATS.clear()
            logging.info("[sol_attn] chunked qkv producer on %s blocks", installed)  # noqa: LOG015 - AST smoke contract

    m.model_options["transformer_options"]["optimized_attention_override"] = \
        make_override(tau=tau, min_tokens=min_tokens,
                      sigma_start=sigma_start, sigma_end=sigma_end,
                      verbose=verbose, sink_conditioning=sink_conditioning,
                      previous=previous, topk_ratio=topk_ratio, vsa=vsa,
                      attention_backend=("cute_sol" if attention_option == "cute_sol" else "kitchen"))
    reset_sol_attn_stats()
    return io.NodeOutput(m)


class SolAttnMiniMax(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SolAttnMiniMax",
            display_name="Patch Sol-Attn (MiniMax)",
            is_experimental=True,
            category="sol_attn",
            description="Training-free block-sparse attention (Sol-Attn, arXiv "
                        "2607.24027) for MiniMax-H3, using comfy_kitchen.sol_attn. "
                        "bf16 + head_dim 128 only; ineligible calls fall back to the "
                        "existing attention backend. The win grows with sequence "
                        "length; below ~12k tokens dense is usually faster, so leave "
                        "min_tokens high.",
            inputs=[
                io.Model.Input("model"),
                io.DynamicCombo.Input("selection", options=[
                    io.DynamicCombo.Option("adaptive tau", [
                        io.Float.Input("tau", default=1.3, min=0.0, max=4.0,
                                       step=0.05,
                                       tooltip="Threshold beta. Higher is sparser: "
                                               "1.0 ~ 16% of blocks kept exact, "
                                               "1.5 ~ 7%, 2.0 ~ 2.7%."),
                    ]),
                    io.DynamicCombo.Option("top-k (SLA)", [
                        io.Float.Input("keep_percent", default=10.0, min=0.5,
                                       max=95.0, step=0.5,
                                       tooltip="Percent of key blocks each query "
                                               "block keeps exactly (sinks and the "
                                               "diagonal ride on top). With the "
                                               "lightx2v SLA turbo LoRA: 15 is the "
                                               "value it was distilled against, 10 "
                                               "is community-validated and faster. "
                                               "Without the LoRA, higher = closer "
                                               "to dense."),
                    ]),
                    io.DynamicCombo.Option("VSA (FastVideo)", [
                        io.Float.Input("vsa_keep_percent", default=10.0, min=0.5,
                                       max=95.0, step=0.5,
                                       tooltip="Percent of VIDEO cubes each query cube "
                                               "keeps; the FastH3-VSA checkpoints are "
                                               "trained at 10 (90% sparsity). The coarse "
                                               "branch uses the checkpoint's "
                                               "to_gate_compress layers when present."),
                    ]),
                ], tooltip="How exact key blocks are chosen per query block. "
                           "'adaptive tau': threshold at tau sigmas of the score "
                           "distribution (density varies per head/block). "
                           "'top-k (SLA)': a fixed keep_percent everywhere -- the "
                           "selection the lightx2v SLA LoRAs were distilled "
                           "against. 'VSA (FastVideo)': the FastH3-VSA recipe -- "
                           "4x4x4 video cubes, conditioning always attended, no "
                           "pooled tail, gated coarse branch; for checkpoints "
                           "trained with VSA. sink_conditioning is implied, and "
                           "anything outside the start/end window runs DENSE "
                           "(set start 0 / end 1 for a few-step checkpoint)."),
                io.Float.Input("start_percent", default=0.2, min=0.0, max=1.0, step=0.01,
                               tooltip="Run dense before this point. The paper uses 0.2."),
                io.Float.Input("end_percent", default=0.9, min=0.0, max=1.0, step=0.01),
                io.Int.Input("min_tokens", default=12288, min=0, max=1 << 20, step=512,
                             tooltip="Sequences shorter than this stay dense."),
                io.Combo.Input("sink_conditioning",
                               options=["exact_kv", "exact_kv_and_rows", "off"],
                               default="exact_kv_and_rows",
                               tooltip="exact_kv: every query sees the packed "
                                       "text/audio/reference rows exactly (~3% cost). "
                                       "exact_kv_and_rows: additionally runs the TARGET "
                                       "AUDIO query rows dense (what keeps generated "
                                       "audio intact); reference rows stay sparse, so "
                                       "the cost is independent of reference size."),
                io.Boolean.Input("verbose", default=False),
            ],
            outputs=[io.Model.Output()],
        )

    @classmethod
    def execute(cls, model, selection, start_percent, end_percent, min_tokens,
                sink_conditioning, verbose) -> io.NodeOutput:
        if _ck is None:
            raise RuntimeError(f"comfy_kitchen unavailable: {_CK_IMPORT_ERROR}")
        if not hasattr(_ck, "sol_attn"):
            raise RuntimeError(
                "comfy_kitchen has no sol_attn; rebuild the extension "
                "(python setup.py build_ext --inplace)")
        mode = selection["selection"]
        vsa = mode == "VSA (FastVideo)"
        keep = selection.get("vsa_keep_percent" if vsa else "keep_percent")
        return _apply_patch(
            model, tau=selection.get("tau", 1.3),
            start_percent=start_percent, end_percent=end_percent,
            min_tokens=min_tokens, sink_conditioning=sink_conditioning,
            verbose=verbose,
            topk_ratio=keep / 100.0 if mode != "adaptive tau" else 0.0,
            vsa=vsa)


class SolAttnMiniMaxExtension(ComfyExtension):
    async def get_node_list(self):
        return [SolAttnMiniMax]


async def comfy_entrypoint() -> SolAttnMiniMaxExtension:
    return SolAttnMiniMaxExtension()
