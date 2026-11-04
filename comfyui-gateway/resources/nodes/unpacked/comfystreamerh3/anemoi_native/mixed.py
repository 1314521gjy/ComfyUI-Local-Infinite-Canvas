"""Explicit mixed-phase workspace and single-kernel execution, ABI 3 extension."""

from dataclasses import dataclass, field

import torch

from .adapter import (
    ExecutionResult,
    Prepared,
    _check_stream,
    _extension,
    allocate,
    kernel_resources,
    prepare_chunk,
    route_lut,
    set_global_vscale,
)
from .quota import PrecisionPolicy, assign_phases, phase_metadata_savings


@dataclass
class MixedPrepared:
    int8: Prepared
    nvfp4: Prepared
    fp16: Prepared | None
    policy: PrecisionPolicy
    preparation_savings: dict = field(default_factory=dict)


def allocate_mixed(
    batch,
    heads,
    blocks,
    device,
    policy: PrecisionPolicy,
    *,
    centered=False,
    prefix_start=0,
    prefix_blocks=0,
    _trusted=False,
    groups=1,
    int8_workspace=None,
    share_phase_validity=False,
):
    if policy.global_scales is None:
        raise ValueError("explicit mixed policy requires calibrated NVFP4 Q/K/V tensor scales")
    device = torch.device(device)
    if device.type == "cuda" and device.index is None:
        device = torch.device("cuda", torch.cuda.current_device())
    for scale in policy.global_scales:
        if (
            scale.shape != (1,)
            or scale.dtype != torch.float32
            or scale.device != torch.device(device)
            or (not _trusted and (not torch.isfinite(scale).all() or (scale <= 0).any()))
        ):
            raise ValueError(
                "NVFP4 global scales must be finite positive FP32 [1] on workspace device"
            )
    options = {"prefix_start": prefix_start, "prefix_blocks": prefix_blocks, "_trusted": _trusted}
    i8 = (
        int8_workspace
        if int8_workspace is not None
        else allocate(batch, heads, blocks, device, centered=centered, groups=groups, **options)
    )
    # Explicit option: the three phases describe the same immutable source rows.
    # Standalone Prepared instances remain independent. No process-global cache.
    shared = {"_shared_valid": i8.valid} if share_phase_validity else {}
    nv = allocate(
        batch, heads, blocks, device, phase="nvfp4", global_scales=policy.global_scales,
        **options, **shared,
    )
    fp = (
        allocate(batch, heads, blocks, device, phase="fp16", **options, **shared)
        if policy.ratios[0] > 0
        else None
    )
    saved_allocations = (1 + int(fp is not None)) if share_phase_validity else 0
    return MixedPrepared(i8, nv, fp, policy, {
        "validity_allocations_eliminated": saved_allocations,
        "validity_allocation_bytes_eliminated": saved_allocations * batch * blocks * 4,
        "validity_copy_calls_eliminated": 0,
        "validity_copy_bytes_eliminated": 0,
    })


def calibrate_mixed(p: MixedPrepared, amax, *, measured):
    set_global_vscale(p.int8, amax, measured=measured)


def prepare_mixed_chunk(
    p: MixedPrepared,
    q,
    k,
    v,
    valid,
    block_offset,
    *,
    represented_means=None,
    use_native_ragged: bool = False,
):
    # One native boundary prepares both low-bit representations with specialized
    # CUDA kernels, avoiding Python padding and copies between representations.
    global_scales = p.policy.global_scales
    if global_scales is None:
        raise ValueError("mixed global scales missing")
    _check_stream(p.int8)
    q, k, v = (x.contiguous() for x in (q, k, v))
    if valid.ndim == 1:
        valid = valid.unsqueeze(0).expand(q.shape[0], -1)
    valid = valid.contiguous()
    n = (q.shape[2] + 63) // 64
    tail = q.shape[2] % 64
    native = _extension() if use_native_ragged and tail and q.is_cuda else None
    native_ragged = (
        tail and getattr(native, "supports_ragged_prepare", False) is True
        and callable(getattr(native, "prepare_mixed_combined_chunk_ragged" if p.int8.centered
                             else "prepare_mixed_nvfp4_chunk_ragged", None))
    )
    if tail and not native_ragged:
        q, k, v = (
            torch.nn.functional.pad(x, (0, 0, 0, n * 64 - q.shape[2])) for x in (q, k, v)
        )
        q, k, v = (x.contiguous() for x in (q, k, v))
    i8 = [p.int8.q, p.int8.k, p.int8.v, p.int8.q_scale,
          p.int8.k_scale, p.int8.v_scale, p.int8.means]
    nv = [p.nvfp4.q, p.nvfp4.k, p.nvfp4.v, p.nvfp4.q_scale,
          p.nvfp4.k_scale, p.nvfp4.v_scale]
    if p.int8.centered:
        external_means = (
            represented_means.contiguous()
            if represented_means is not None else q.new_empty((0,))
        )
        if native_ragged and native is not None:
            function = native.prepare_mixed_combined_chunk_ragged
        else:
            function = _extension().prepare_mixed_combined_chunk
        function(
            [q, k, v], valid, i8, nv, list(global_scales), external_means,
            block_offset, p.int8.prefix_start, p.int8.prefix_blocks,
            p.nvfp4.clipping_counts, p.nvfp4.observed_amax,
        )
    else:
        if p.int8.global_vscale is None:
            raise ValueError("plain mixed preparation requires original global V calibration")
        if native_ragged and native is not None:
            function = native.prepare_mixed_nvfp4_chunk_ragged
        else:
            function = _extension().prepare_mixed_nvfp4_chunk
        function(
            [q, k, v], valid, i8, nv, list(global_scales),
            p.int8.global_vscale, block_offset,
            p.nvfp4.clipping_counts, p.nvfp4.observed_amax,
        )
    if native_ragged:
        bytes_per_tensor = q.shape[0] * q.shape[1] * n * 64 * 128 * q.element_size()
        p.preparation_savings["ragged_padding_allocations_eliminated"] = (
            p.preparation_savings.get("ragged_padding_allocations_eliminated", 0) + 3
        )
        p.preparation_savings["ragged_padding_copy_bytes_eliminated"] = (
            p.preparation_savings.get("ragged_padding_copy_bytes_eliminated", 0) + 3 * bytes_per_tensor
        )
    for operand in (p.int8, p.nvfp4):
        if operand is p.int8 or operand.valid is not p.int8.valid:
            operand.valid[:, block_offset : block_offset + n].copy_(valid)
        else:
            p.preparation_savings["validity_copy_calls_eliminated"] += 1
            p.preparation_savings["validity_copy_bytes_eliminated"] += valid.numel() * valid.element_size()
        operand.ready.update(range(block_offset, block_offset + n))
        operand.prepare_calls += 1
    if p.fp16 is not None:
        # FP16 is an explicitly original-value rescue phase. It never receives
        # low-bit residuals or a second mean addition.
        shared_valid = p.fp16.valid is p.int8.valid
        prepare_chunk(p.fp16, q, k, v,
                      p.int8.valid[:, block_offset:block_offset+n] if shared_valid else valid,
                      block_offset)
        if shared_valid:
            p.preparation_savings["validity_copy_calls_eliminated"] += 1
            p.preparation_savings["validity_copy_bytes_eliminated"] += valid.numel() * valid.element_size()

    # FP16 rescue requires the original padded tensors, so low-bit ragged input
    # saves no net padding allocations or copies when FP16 rescue is enabled.
    if native_ragged and p.fp16 is not None:
        p.preparation_savings["ragged_padding_allocations_eliminated"] = 0
        p.preparation_savings["ragged_padding_copy_bytes_eliminated"] = 0


def fine_mixed(
    p: MixedPrepared,
    ids,
    counts,
    *,
    original_scores=None,
    original_metadata=None,
    prefix_query_mask=None,
    stock_prefix_output=None,
    softmax_scale=128**-0.5,
    optimize_phase_metadata=False,
    _defer_prefix_output=False,
):
    core = p.int8
    if type(optimize_phase_metadata) is not bool:
        raise TypeError("optimize_phase_metadata must be bool")
    if type(_defer_prefix_output) is not bool:
        raise TypeError("_defer_prefix_output must be bool")
    b, h = core.q.shape[:2]
    n = core.blocks
    for operand in (core, p.nvfp4, p.fp16):
        if operand is not None:
            _check_stream(operand)
            if operand.ready != set(range(n)):
                raise ValueError("mixed workspace has missing chunks")
            if not core.trusted and not torch.equal(operand.valid, core.valid):
                raise ValueError("phase validity mismatch")
    if ids.shape[:3] != (b, h, n) or ids.shape[-1] > n:
        raise ValueError("mixed routes must match workspace geometry")
    if ids.device != core.q.device:
        raise ValueError("mixed route device mismatch")
    if core.prefix_blocks and prefix_query_mask is None:
        raise ValueError("prefix queries require stock protection")
    if prefix_query_mask is not None:
        if (
            prefix_query_mask.shape != (b, n)
            or prefix_query_mask.dtype != torch.bool
            or prefix_query_mask.device != ids.device
            or (
                not _defer_prefix_output
                and (
                    stock_prefix_output is None
                    or stock_prefix_output.shape != (b, h, n * 64, 128)
                    or stock_prefix_output.device != ids.device
                )
            )
        ):
            raise ValueError("stock prefix mask/output shape/device mismatch")
        counts = counts.masked_fill(prefix_query_mask[:, None, :], 0)
    extension = _extension()
    prefix_mask = (
        prefix_query_mask if prefix_query_mask is not None
        else core.q.new_empty((0,), dtype=torch.bool)
    )
    stock_prefix = (
        stock_prefix_output if stock_prefix_output is not None
        else core.q.new_empty((0,), dtype=torch.bfloat16)
    )
    # Mixed kernels historically overlaid protected BF16 rows into their FP16
    # accumulator.  The output epilogue can select the original BF16 rows
    # directly, so suppress that redundant overlay when the caller owns the
    # final prefix merge.  Keep the mask for quota exclusion above.
    kernel_prefix_mask = (
        core.q.new_empty((0,), dtype=torch.bool) if _defer_prefix_output else prefix_mask
    )
    kernel_stock_prefix = (
        core.q.new_empty((0,), dtype=torch.bfloat16) if _defer_prefix_output else stock_prefix
    )
    fused_phase = getattr(extension, "mixed_attention_with_phase", None)
    use_fused_phase = (
        original_scores is not None and core.q.is_cuda
        and callable(fused_phase) and getattr(extension, "supports_fused_phase", False) is True
    )
    optimized_function = getattr(extension, "mixed_attention_with_phase_optimized", None)
    optimized_metadata = (
        optimize_phase_metadata and use_fused_phase and callable(optimized_function)
        and getattr(extension, "supports_phase_metadata_fusion", False) is True
    )
    if optimized_metadata:
        fused_phase = optimized_function
    metadata_savings = phase_metadata_savings(
        b, h, ids.shape[2], ids.shape[3], enabled=optimized_metadata)
    route_copy_savings = {
        "no_op_pad_calls_eliminated": 0, "copy_allocations_eliminated": 0,
        "copy_bytes_eliminated": 0,
    }
    if use_fused_phase:
        assert callable(fused_phase)
        global_scales = p.policy.global_scales
        if global_scales is None:
            raise ValueError("mixed global scales missing")
        fp16_phase = p.fp16
        if fp16_phase is None:
            fp16_inputs = []
        else:
            fp16_inputs = [fp16_phase.q, fp16_phase.k, fp16_phase.v]
        fused = fused_phase(
            [core.q, core.k, core.v, core.q_scale, core.k_scale,
             core.v_scale if core.centered else core.global_vscale],
            [p.nvfp4.q, p.nvfp4.k, p.nvfp4.v, p.nvfp4.q_scale,
             p.nvfp4.k_scale, p.nvfp4.v_scale],
            fp16_inputs,
            core.means, ids, counts, core.valid, list(global_scales),
            softmax_scale, core.trusted, kernel_prefix_mask, kernel_stock_prefix,
            list(p.policy.ratios), original_scores, core.centered,
            core.means.shape[3] == 4,
        )
        out, lse, nv_counts, int8_counts, fp16_counts = fused
        phases = {"nvfp4": nv_counts, "int8": int8_counts, "fp16": fp16_counts}
        compact = None
    else:
        compact, phases = assign_phases(ids, counts, p.policy, original_scores, _trusted=core.trusted)
        compact, route_copy_savings = route_lut(compact, n)
    i8 = [
        core.q,
        core.k,
        core.v,
        core.q_scale,
        core.k_scale,
        core.v_scale if core.centered else core.global_vscale,
    ]
    nv = p.nvfp4
    if nv.clipping_counts is None or nv.observed_amax is None:
        raise ValueError("mixed workspace missing device calibration counters")
    nv_args = [nv.q, nv.k, nv.v, nv.q_scale, nv.k_scale, nv.v_scale]
    fp = [] if p.fp16 is None else [p.fp16.q, p.fp16.k, p.fp16.v]
    if use_fused_phase:
        op = None
    else:
        op = (
        (
            extension.combined_mixed_g4_attention
            if core.means.shape[3] == 4
            else extension.combined_mixed_attention
        )
        if core.centered
        else extension.mixed_attention
    )
    if not use_fused_phase:
        assert callable(op)
        out, lse = op(
        i8,
        nv_args,
        fp,
        core.means,
        compact,
        phases["nvfp4"],
        phases["int8"],
        phases["fp16"],
        core.valid,
        p.policy.global_scales,
        softmax_scale,
        core.trusted,
        kernel_prefix_mask,
            kernel_stock_prefix,
        )
    core.fine_calls += 1
    resource_name = (
        ("combined_mixed_g4_resources" if core.means.shape[3] == 4 else "combined_mixed_resources")
        if core.centered
        else "mixed_resources"
    )
    resources = kernel_resources(resource_name, core.q.device.index, bool(fp))
    return ExecutionResult(
        out,
        lse,
        original_metadata,
        {
            "requested_backend": "combined" if core.centered else "anemoi",
            "executed_backend": "native_sm120_mixed",
            "precision_policy": p.policy.name,
            "precision_ratios_fp16_int8_nvfp4": p.policy.ratios,
            "nvfp4_measured_range_margin": p.policy.range_margin,
            "value_policy": f"combined-g{core.means.shape[3]}-nv-int8-original-fp16-v1"
            if core.centered
            else "original-v1",
            "phase_calls": {name: c.any().to(torch.int32) for name, c in phases.items()},
            "phase_pairs": {name: c.sum() for name, c in phases.items()},
            "native_attention_launches": 1,
            "route_copy_savings": route_copy_savings,
            "preparation_savings": dict(p.preparation_savings),
            "phase_metadata_savings": metadata_savings,
            "phase_metadata_optimization_requested": optimize_phase_metadata,
            "resources": resources,
            "fallback": None,
            "fp16_full_operand_storage": p.fp16 is not None,
            "calibration": core.calibration,
            "nvfp4_clipping_counts_q_k_v": nv.clipping_counts,
            "nvfp4_calibration_range_ok": (nv.clipping_counts == 0).all(),
            "gpu_validated": False,
        },
    )
