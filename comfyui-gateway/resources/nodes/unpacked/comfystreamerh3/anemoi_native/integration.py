"""Kitchen-owned producer/route/coarse orchestration, isolated Anemoi fine pass."""

from __future__ import annotations

from dataclasses import dataclass, replace

import torch

from ..native_attention.instrumentation import operand_tensors, storage_bytes, timed_native_call
from . import adapter as _adapter
from .adapter import (
    ABI_VERSION,
    _extension,
    allocate,
    fine_attention,
    grouped_chunk_inputs,
    output_epilogue,
    prepare_chunk,
    set_global_vscale,
)
from .calibration import (
    CalibrationCollector,
    previous_calibration,
    retain_calibration,
    scales_from_amax,
)
from .mixed import allocate_mixed, fine_mixed, prepare_mixed_chunk
from .quota import SCORE_POLICY, PrecisionPolicy


def require_backend(option):
    if option not in ("anemoi", "combined"):
        raise ValueError(f"unsupported Anemoi option: {option}")
    extension = _extension()
    if extension.abi_version != ABI_VERSION:
        raise RuntimeError("Anemoi extension ABI mismatch")
    return extension


@dataclass(frozen=True)
class _RunPolicy:
    """Validated, device-aware policy chosen before native execution begins."""

    groups: int
    grouping_policy: str
    grouping_schedule: str
    grouping_state: object | None
    using_mixed: bool
    policy_template: PrecisionPolicy
    center_enabled: bool
    identity: tuple[object, ...]
    previous: object | None
    collector: CalibrationCollector | None


def _validate_direct_prefix_output(enabled: bool) -> None:
    if enabled and getattr(_adapter._extension(), "supports_direct_prefix_output", False) is not True:
        raise RuntimeError("artifact lacks optional direct prefix output support")


def _resolve_run_policy(
    *,
    option,
    t,
    h,
    rope_freqs,
    sink_blocks,
    precision_policy,
    grouping_policy,
    grouping_schedule,
    evaluation_index,
    grouping_state,
    native_state,
    attention_kernel_policy,
    center_values,
    diagnostic_calibration_override,
    direct_prefix_output,
    share_phase_validity,
    optimize_phase_metadata,
    native_preparation,
    kmean,
    vscale,
    nvfp4_range_margin,
):
    """Resolve policy and calibration state without allocating native workspaces."""
    if grouping_policy not in ("none", "g4") or (
        grouping_policy == "g4" and option != "combined"
    ):
        raise ValueError("grouping_policy g4 is an explicit combined policy")
    groups = 4 if grouping_policy == "g4" else 1
    if attention_kernel_policy not in ("int8_control", "mixed_fp4"):
        raise ValueError("attention_kernel_policy must be int8_control or mixed_fp4")
    if grouping_schedule == "first_step":
        grouping_schedule = "first_eval"
    if native_state is not None:
        native_state.setdefault("scope", ("request_layer_state", id(native_state)))
        if grouping_state is None:
            grouping_state = native_state
    using_mixed = attention_kernel_policy == "mixed_fp4" or precision_policy is not None
    if (share_phase_validity or optimize_phase_metadata) and not using_mixed:
        raise ValueError(
            "share_phase_validity and optimize_phase_metadata require "
            "attention_kernel_policy='mixed_fp4'"
        )
    _validate_direct_prefix_output(direct_prefix_output)
    if precision_policy is not None and nvfp4_range_margin != 1.0:
        raise ValueError("put range_margin in precision_policy when supplying an explicit policy")
    policy_template = precision_policy or PrecisionPolicy(
        (0.0, 0.5, 0.5), range_margin=nvfp4_range_margin
    )
    if (
        using_mixed
        and policy_template.global_scales is not None
        and not diagnostic_calibration_override
    ):
        raise ValueError("explicit NV tensor scales require diagnostic_calibration_override=True")
    center_enabled = option == "combined" and (
        center_values
        if center_values is not None
        else not (grouping_schedule == "first_eval" and evaluation_index not in (None, 0))
    )
    identity = (
        t,
        h,
        str(rope_freqs.device),
        groups,
        tuple(sink_blocks or (0, 0)),
        option,
        grouping_schedule,
    )
    previous = previous_calibration(native_state, identity) if using_mixed else None
    if (
        using_mixed
        and policy_template.global_scales is None
        and previous is None
        and kmean is not None
        and vscale is not None
    ):
        raise ValueError(
            "mixed bootstrap requires original measurement traversal; native_state has no matching calibration"
        )
    collector = (
        CalibrationCollector.create(
            rope_freqs.device, centered=center_enabled, use_native=native_preparation
        )
        if using_mixed
        else None
    )
    return _RunPolicy(
        groups,
        grouping_policy,
        grouping_schedule,
        grouping_state,
        using_mixed,
        policy_template,
        center_enabled,
        identity,
        previous,
        collector,
    )


def _record_execution_diagnostics(
    *,
    diagnostics,
    result,
    x,
    groups,
    grouping_policy,
    grouping_schedule,
    attention_kernel_policy,
    policy_template,
    using_mixed,
    precision_policy,
    center_enabled,
    prepared,
    mixed,
    ids,
    counts,
    scores,
    prefix_stock,
    stock,
    prefix_mask,
    out,
    coarse,
    next_scale,
    collector,
    direct_prefix_output,
    start,
    end,
    t,
    h,
    native_preparation,
    native_ragged_preparation,
    packing_savings,
    fused_route_metadata,
    use_fused_prefix,
    avoided_layout_copies,
    avoided_layout_bytes,
    avoided_padding_copies,
    avoided_padding_bytes,
) -> None:
    if diagnostics is None:
        return
    diagnostics.update(result.execution)
    diagnostics.update(
        kitchen_counters=dict(x.counters),
        workspace_bytes=getattr(x, "plan", {}).get("total", 0),
        groups=groups,
        grouping_policy=grouping_policy,
        grouping_schedule=grouping_schedule,
        attention_kernel_policy=attention_kernel_policy,
        attention_kernel_policy_version=(
            (
                "mixed-fp4-50-50-v1"
                if policy_template.range_margin == 1.0
                else f"mixed-fp4-50-50-margin{policy_template.range_margin:g}-v1"
            )
            if using_mixed and precision_policy is None
            else "explicit-mixed-v1"
            if using_mixed
            else "int8-control-v1"
        ),
        center_values=center_enabled,
        token_aug=0,
        gpu_validated=False,
        calibration_measured=x.calibration_measured,
    )
    diagnostics["workspace_bytes"] = storage_bytes(
        getattr(x, "workspace", None), operand_tensors(getattr(x, "grouped", None)),
        operand_tensors(prepared),
        operand_tensors(None if mixed is None else mixed.nvfp4),
        operand_tensors(None if mixed is None else mixed.fp16),
        ids, counts, scores, prefix_stock, stock, prefix_mask,
        result.output, getattr(result, "lse", None), out,
        x.kmean_next, x.vamax_next, next_scale,
        getattr(x, "original_vscale", None), x.lengths, coarse,
        None if collector is None else collector.maxima,
        () if collector is None else tuple(collector.represented_means.values()),
    )
    diagnostics["workspace_accounting"] = "unique-live-backing-storage; excludes freed scratch; not peak"
    diagnostics["kitchen_workspace_bytes"] = getattr(x, "plan", {}).get("total", 0)
    diagnostics["output_savings"] = {
        "direct_prefix_output": direct_prefix_output,
        "prefix_layout_copies_eliminated": avoided_layout_copies,
        "prefix_layout_copy_bytes_eliminated": avoided_layout_bytes,
        "prefix_padding_copies_eliminated": avoided_padding_copies,
        "prefix_padding_copy_bytes_eliminated": avoided_padding_bytes,
        "gpu_launches_eliminated": 0,
        "prefix_fp16_roundtrips_eliminated": int(direct_prefix_output and end > start),
        "prefix_overlay_launches_eliminated": int(direct_prefix_output and using_mixed and end > start),
        "prefix_overlay_bytes_eliminated": (
            int(direct_prefix_output and using_mixed and end > start)
            * max(0, min(end * 64, t) - start * 64)
            * h * 128 * 2
        ),
    }
    diagnostics["preparation_fusion"] = {
        "requested": native_preparation,
        "ragged_requested": native_ragged_preparation,
        "packing": dict(packing_savings),
        "calibration": {} if collector is None else dict(collector.work_savings),
    }
    diagnostics["fused_route_metadata_requested"] = fused_route_metadata
    diagnostics["fused_route_metadata_applied"] = bool(
        fused_route_metadata and not use_fused_prefix
    )


@timed_native_call(4)
def run_chunked(
    option,
    qkv_chunks,
    t,
    h,
    rope_freqs,
    qk_norm_weights,
    kmean=None,
    vscale=None,
    tau=1.0,
    topk_ratio=0.0,
    scale=None,
    sink_blocks=None,
    sink_q=None,
    rope_eps=1e-6,
    tail=True,
    block_len=None,
    coarse_gate=None,
    token_aug=0,
    *,
    diagnostics=None,
    precision_policy: PrecisionPolicy | None = None,
    grouping_policy="none",
    grouping_schedule="all_steps",
    evaluation_index=None,
    grouping_state=None,
    validation_context=None,
    attention_kernel_policy="int8_control",
    native_state=None,
    center_values=None,
    diagnostic_calibration_override=False,
    direct_prefix_output=False,
    share_phase_validity=False,
    native_preparation=False,
    native_ragged_preparation=False,
    optimize_phase_metadata=False,
    fused_route_metadata=False,
    scratch_pool=None,
    retained_operand_bytes=0,
    reuse_geometry=False,
    _stage_mark=None,
    nvfp4_range_margin=1.0,
):
    """Kitchen streaming front door; frozen INT8 default, explicit mixed/G4 policies."""
    require_backend(option)
    if tail:
        raise NotImplementedError(
            "native Anemoi/combined currently requires tail=False; Kitchen tail state "
            "is not representable in the isolated Anemoi fine ABI"
        )
    from ..native_attention import runtime as kitchen_native
    policy = _resolve_run_policy(
        option=option,
        t=t,
        h=h,
        rope_freqs=rope_freqs,
        sink_blocks=sink_blocks,
        precision_policy=precision_policy,
        grouping_policy=grouping_policy,
        grouping_schedule=grouping_schedule,
        evaluation_index=evaluation_index,
        grouping_state=grouping_state,
        native_state=native_state,
        attention_kernel_policy=attention_kernel_policy,
        center_values=center_values,
        diagnostic_calibration_override=diagnostic_calibration_override,
        direct_prefix_output=direct_prefix_output,
        share_phase_validity=share_phase_validity,
        optimize_phase_metadata=optimize_phase_metadata,
        native_preparation=native_preparation,
        kmean=kmean,
        vscale=vscale,
        nvfp4_range_margin=nvfp4_range_margin,
    )
    groups = policy.groups
    grouping_policy = policy.grouping_policy
    grouping_schedule = policy.grouping_schedule
    grouping_state = policy.grouping_state
    using_mixed = policy.using_mixed
    policy_template = policy.policy_template
    center_enabled = policy.center_enabled
    identity = policy.identity
    previous = policy.previous
    collector = policy.collector
    mark = _stage_mark

    mark("prepare_start")

    mixed = None
    packing_savings: dict[str, int] = {}
    prepared = allocate(
        1,
        h,
        (t + 63) // 64,
        rope_freqs.device,
        centered=option == "combined",
        prefix_blocks=0 if sink_blocks is None else sink_blocks[1],
        prefix_start=0 if sink_blocks is None else sink_blocks[0],
        _trusted=True,
        groups=groups,
    )

    def calibrate(vamax, _kitchen_scale, measured):
        nonlocal mixed
        set_global_vscale(prepared, vamax.unsqueeze(0), measured=measured)
        if using_mixed:
            if policy_template.global_scales is not None:
                globals_ = policy_template.global_scales
                provenance = "diagnostic-explicit-override"
            elif collector is not None and collector.chunks:
                globals_ = scales_from_amax(
                    collector.maxima, range_margin=policy_template.range_margin, _trusted=True
                )
                provenance = "current-bootstrap-postnorm-rope-actual-values"
            elif previous is not None:
                maxima = previous["maxima"]
                if not center_enabled and previous.get("centered"):
                    maxima = maxima.clone()
                    maxima[2].copy_(previous["original_vamax"])
                globals_ = scales_from_amax(
                    maxima, range_margin=policy_template.range_margin, _trusted=True
                )
                provenance = "rolling-previous-call-checked-clipping"
            else:
                raise ValueError("measurement_hook did not supply native mixed calibration")
            mixed = allocate_mixed(
                1,
                h,
                (t + 63) // 64,
                rope_freqs.device,
                replace(policy_template, global_scales=globals_),
                centered=option == "combined",
                prefix_start=prepared.prefix_start,
                prefix_blocks=prepared.prefix_blocks,
                groups=groups,
                _trusted=True,
                int8_workspace=prepared,
                share_phase_validity=share_phase_validity,
            )
            prepared.calibration = provenance

    def chunk(t0, q, k, v, valid):
        first = t0 // 64
        last = (t0 + q.shape[2] + 63) // 64
        means = (
            torch.zeros((1, h, last - first, 1, 128), device=v.device, dtype=torch.bfloat16)
            if option == "combined" and not center_enabled
            else None
        )
        if collector is not None and center_enabled:
            means = collector.represented_means.pop(t0, None)
        if mixed is not None:
            prepare_mixed_chunk(
                mixed, q, k, v, valid[:, first:last], first,
                represented_means=means, use_native_ragged=native_ragged_preparation,
            )
        else:
            prepare_chunk(
                prepared, q, k, v, valid[:, first:last], first,
                represented_means=means, use_native_ragged=native_ragged_preparation,
            )

    def grouped_chunk(t0, q, k, v, valid, permutation, means):
        first = t0 // 64
        count = (q.shape[2] + 63) // 64
        q, k, v, savings = grouped_chunk_inputs(q, k, v, permutation, use_native=native_preparation)
        for name, value in savings.items():
            packing_savings[name] = packing_savings.get(name, 0) + value
        if mixed is not None:
            prepare_mixed_chunk(
                mixed, q, k, v, valid[:, first : first + count], first,
                represented_means=means, use_native_ragged=native_ragged_preparation,
            )
        else:
            prepare_chunk(
                prepared,
                q,
                k,
                v,
                valid[:, first : first + count],
                first,
                represented_means=means,
                use_native_ragged=native_ragged_preparation,
            )

    grouping_args: dict[str, object] = {}
    if grouping_schedule != "all_steps":
        grouping_args.update(grouping_schedule=grouping_schedule, evaluation_index=evaluation_index)
    if collector is not None:
        grouping_args["measurement_hook"] = collector.measure
    if center_values is not None:
        grouping_args["center_values"] = center_values
    if validation_context is not None:
        grouping_args["validation_context"] = validation_context
    if groups == 4:
        grouping_args.update(
            {
                "grouping_policy": "g4",
                "grouping_schedule": grouping_schedule,
                "evaluation_index": evaluation_index,
                "grouping_state": grouping_state,
                "grouping_hook": grouped_chunk,
            }
        )

    x = kitchen_native.prepare_chunked(
        qkv_chunks,
        t,
        h,
        rope_freqs,
        qk_norm_weights,
        kmean,
        vscale,
        tau,
        topk_ratio,
        scale,
        sink_blocks,
        sink_q,
        rope_eps,
        tail,
        block_len,
        coarse_gate,
        token_aug,
        option="vc",
        chunk_hook=chunk if groups == 1 else None,
        calibration_hook=calibrate,
        scratch_pool=scratch_pool,
        retained_operand_bytes=retained_operand_bytes,
        reuse_geometry=reuse_geometry,
        **grouping_args,
    )
    try:
        mark("prepare_end")
        start, end = x.sink_queries
        use_fused_prefix = end > start and getattr(
            kitchen_native, "supports_route_prefix", False
        ) is True
        prefix_stock = None
        if use_fused_prefix:
            ids, counts, scores, prefix_stock = kitchen_native.route_and_export_with_prefix(
                x, scores=mixed is not None and mixed.policy.name == SCORE_POLICY
            )
        else:
            route_kwargs = {
                "scores": mixed is not None and mixed.policy.name == SCORE_POLICY,
            }
            if fused_route_metadata:
                route_kwargs["fused_metadata"] = True
            ids, counts, scores = kitchen_native.route_and_export(x, **route_kwargs)
        mark("route_end")
        valid = x.lengths.reshape(1, -1).to(torch.int32)
        prefix_mask = torch.zeros((1, prepared.blocks), device=ids.device, dtype=torch.bool)
        avoided_layout_copies = 0
        avoided_layout_bytes = 0
        avoided_padding_copies = 0
        avoided_padding_bytes = 0
        if end > start:
            prefix_mask[:, start:end] = True
            if prefix_stock is None:
                prefix_stock = kitchen_native.fine(x, prefix_only=True)
            if direct_prefix_output:
                if t < prepared.blocks * 64:
                    avoided_padding_copies = 1
                    avoided_padding_bytes = (
                        prefix_stock.shape[0] * h * prepared.blocks * 64 * 128
                        * prefix_stock.element_size())
                elif not prefix_stock.permute(0, 2, 1, 3).is_contiguous():
                    avoided_layout_copies = 1
                    avoided_layout_bytes = prefix_stock.numel() * prefix_stock.element_size()
                stock = None
            else:
                # Both fused-route and separate-prefix producers return real T,
                # whereas the legacy fine ABI requires ceil(T/64)*64.
                stock = prefix_stock.permute(0, 2, 1, 3)
                if t < prepared.blocks * 64:
                    stock = torch.nn.functional.pad(stock, (0, 0, 0, prepared.blocks * 64 - t))
                stock = stock.contiguous()
        else:
            stock = None if direct_prefix_output else torch.empty(
                (1, h, prepared.blocks * 64, 128), device=ids.device, dtype=torch.bfloat16
            )
        mark("prefix_end")
        if mixed is not None:
            result = fine_mixed(
                mixed,
                ids,
                counts,
                original_scores=scores,
                original_metadata=x,
                prefix_query_mask=prefix_mask,
                stock_prefix_output=stock,
                softmax_scale=x.scale,
                optimize_phase_metadata=optimize_phase_metadata,
                _defer_prefix_output=direct_prefix_output,
            )
        else:
            result = fine_attention(
                prepared,
                ids,
                {"int8": counts},
                valid,
                original_metadata=x,
                prefix_query_mask=prefix_mask,
                stock_prefix_output=stock,
                softmax_scale=x.scale,
                **({"_defer_prefix_output": True} if direct_prefix_output else {}),
            )
            result.execution["precision_policy"] = (
                f"combined-int8-g{groups}-v1" if option == "combined" else "anemoi-int8-global-v1"
            )
        x.counters["fine_calls"] = x.counters.get("fine_calls", 0) + 1
        mark("fine_and_quota_end")
        native_layout_epilogue = (
            getattr(_adapter._extension(), "supports_output_layout_epilogue", False) is True
        )
        coarse = None
        if native_layout_epilogue:
            prefix_arguments = (
                {"stock_prefix_output": prefix_stock, "prefix_blocks": (start, end)}
                if end > start else {}
            )
            coarse_gate = getattr(x, "coarse_gate", None)
            if coarse_gate is not None:
                coarse = x.kitchen.coarse_output(
                    *x.kitchen._ws_block_means(x.workspace, x.plan, h, x.lengths), x.scale
                ).reshape(1, h, -1, 128).contiguous()
                out = output_epilogue(
                    result.output, coarse=coarse, coarse_gate=coarse_gate, tokens=t,
                    **prefix_arguments,
                )
                x.counters["coarse_calls"] += 1
            else:
                out = output_epilogue(result.output, tokens=t, **prefix_arguments)
        else:
            # Compatibility path for older ABI4 artifacts and test doubles:
            # retain Kitchen's exact BF16 boundary and single coarse merge.
            out = result.output[:, :, :t].permute(0, 2, 1, 3).to(torch.bfloat16).contiguous()
            if end > start:
                assert prefix_stock is not None
                # Legacy native fine epilogues overlay through FP16; restoring
                # original BF16 here prevents overflow before the single merge.
                out[:, start*64:min(end*64, t)].copy_(prefix_stock[:, start*64:min(end*64, t)])
            out = kitchen_native.merge_coarse(x, out)
        mark("coarse_and_output_end")
        next_scale = (x.vamax_next / 127.0 * 1.1).clamp_min(1e-8)
        if mixed is not None:
            retain_calibration(
                native_state,
                identity,
                mixed.nvfp4.observed_amax,
                mixed.nvfp4.clipping_counts,
                original_vamax=x.vamax_next.amax(),
                centered=center_enabled,
            )
        _record_execution_diagnostics(
            diagnostics=diagnostics,
            result=result,
            x=x,
            groups=groups,
            grouping_policy=grouping_policy,
            grouping_schedule=grouping_schedule,
            attention_kernel_policy=attention_kernel_policy,
            policy_template=policy_template,
            using_mixed=using_mixed,
            precision_policy=precision_policy,
            center_enabled=center_enabled,
            prepared=prepared,
            mixed=mixed,
            ids=ids,
            counts=counts,
            scores=scores,
            prefix_stock=prefix_stock,
            stock=stock,
            prefix_mask=prefix_mask,
            out=out,
            coarse=coarse,
            next_scale=next_scale,
            collector=collector,
            direct_prefix_output=direct_prefix_output,
            start=start,
            end=end,
            t=t,
            h=h,
            native_preparation=native_preparation,
            native_ragged_preparation=native_ragged_preparation,
            packing_savings=packing_savings,
            fused_route_metadata=fused_route_metadata,
            use_fused_prefix=use_fused_prefix,
            avoided_layout_copies=avoided_layout_copies,
            avoided_layout_bytes=avoided_layout_bytes,
            avoided_padding_copies=avoided_padding_copies,
            avoided_padding_bytes=avoided_padding_bytes,
        )
        return out, x.kmean_next, next_scale
    finally:
        x.close()
