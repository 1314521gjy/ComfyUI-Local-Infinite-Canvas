"""Experimental native Kitchen 0.2.34 VC; no import-time CUDA/build side effects."""
from .instrumentation import StageTimings, request_stage_timings
from .runtime import (
    Prepared,
    ValidationContext,
    anemoi_routes,
    fine,
    merge_coarse,
    original_route_scores,
    prepare_chunked,
    route,
    sol_attn_chunked,
)

__all__ = [
    "Prepared",
    "StageTimings",
    "ValidationContext",
    "anemoi_routes",
    "fine",
    "invalidate_caches",
    "merge_coarse",
    "original_route_scores",
    "prepare_chunked",
    "request_stage_timings",
    "require_backend",
    "resource_report",
    "route",
    "run_chunked",
    "sol_attn_chunked",
]


def require_backend(option, device=None):
    """Fail before projection on missing prebuilt artifact or unsupported device."""
    if option in ("anemoi", "combined"):
        from .. import anemoi_native
        return anemoi_native.require_backend(option)
    if option != "vc":
        raise NotImplementedError(f"native {option!r} backend is not installed in this adapter")
    from ._abi import get_native_library
    from .runtime import _dependencies
    native = get_native_library()
    torch, _ = _dependencies()
    if not torch.cuda.is_available():
        raise RuntimeError("native VC requires a CUDA device; CPU/diagnostic fallback is disabled")
    capability = torch.cuda.get_device_capability(device)
    arch = f"{capability[0]}{capability[1]}"
    if arch not in native.report["architectures"]:
        raise RuntimeError(f"native VC has no sm_{arch} artifact; rebuild on the CUDA builder")
    with torch.cuda.device(device if device is not None else torch.cuda.current_device()):
        native.check_resources(torch.cuda.current_device())
    return native


def resource_report():
    """Return verified artifact/source hashes and raw compiler resource evidence; no GPU launch."""
    from ._abi import artifact_report
    return artifact_report()[1]


def invalidate_caches():
    """Revalidate metadata after explicit changes; restart for same-path binary replacement."""
    from ._abi import clear_validation_cache
    from .runtime import _dependencies
    clear_validation_cache()
    _dependencies.cache_clear()


def run_chunked(
    option, chunks, n, heads, freqs, qk_weights, *, kmean=None, vscale=None,
    tau=1.0, topk_ratio=0.0, scale=None, sink_blocks=None, sink_q=None,
    rope_eps=1e-6, block_len=None, coarse_gate=None, token_aug=0, tail=False,
    diagnostics=None, grouping_policy="none", pv_precision="int8",
    grouping_schedule="all_steps", evaluation_index=None, grouping_state=None,
    validation_context=None, center_values=None, **backend_options,
):
    """Parent dispatcher entry; sol_attn_chunked retains Kitchen's original ABI."""
    if option in ("anemoi", "combined"):
        from .. import anemoi_native
        if pv_precision != "int8":
            raise ValueError("use Anemoi precision_policy for its phase selection; pv_precision is VC-only")
        if validation_context is not None:
            backend_options["validation_context"] = validation_context
        if center_values is not None:
            backend_options["center_values"] = center_values
        return anemoi_native.run_chunked(
            option, chunks, n, heads, freqs, qk_weights, kmean=kmean, vscale=vscale,
            tau=tau, topk_ratio=topk_ratio, scale=scale, sink_blocks=sink_blocks,
            sink_q=sink_q, rope_eps=rope_eps, block_len=block_len,
            coarse_gate=coarse_gate, token_aug=token_aug, tail=tail, diagnostics=diagnostics,
            grouping_policy=grouping_policy,
            grouping_schedule=grouping_schedule, evaluation_index=evaluation_index,
            grouping_state=grouping_state, **backend_options,
        )
    return sol_attn_chunked(
        chunks, n, heads, freqs, qk_weights, kmean, vscale, tau, topk_ratio,
        scale, sink_blocks, sink_q, rope_eps, tail, block_len, coarse_gate,
        token_aug, option=option, diagnostics=diagnostics,
        grouping_policy=grouping_policy, pv_precision=pv_precision,
        grouping_schedule=grouping_schedule, evaluation_index=evaluation_index,
        grouping_state=grouping_state, validation_context=validation_context,
        center_values=center_values,
        **backend_options,
    )
