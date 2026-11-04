"""Chunked ABI, using pinned Kitchen Python routing/coarse helpers unchanged.

CUDA is loaded only on explicit preparation. No stock fallback or runtime build.
"""
from __future__ import annotations

import math
import weakref
from dataclasses import dataclass, field
from functools import lru_cache
from importlib.metadata import version
from typing import Any

from ._abi import get_native_library, ptr
from .grouped import allocate_grouped, conservative_global_scale, schedule_action
from .instrumentation import operand_tensors, storage_bytes, timed_native_call
from .scratch import RetainedReplay, ScratchPool


def _tensor_version_or_none(tensor):
    """Read a tensor version without rejecting inference-mode tensors."""
    try:
        return tensor._version
    except RuntimeError:
        # Inference tensors can mutate without a version bump. Never cache
        # validation or a retained permutation based on this identity alone.
        return None


@lru_cache(maxsize=32)
def _dtype_bytes(dtype):
    """Metadata only: at most one CPU scalar allocation per cached dtype."""
    import torch
    return torch.empty((), dtype=dtype, device="cpu").element_size()


@lru_cache(maxsize=1)
def _dependencies():
    import torch
    if version("comfy-kitchen") != "0.2.34":
        raise RuntimeError("native attention requires comfy-kitchen==0.2.34 Python helpers")
    from comfy_kitchen.backends import cuda as kitchen
    return torch, kitchen


def validate_policy(t, h, option, token_aug, tau, topk_ratio, scale, rope_eps):
    if option != "vc":
        raise ValueError(f"this native entry implements option='vc', got {option!r}")
    if token_aug != 0:
        raise NotImplementedError("native VC supports token_aug=0 only")
    if type(t) is not int or type(h) is not int or not 0 < t <= 64 * 65535 or not 0 < h <= 65535:
        raise ValueError("native VC requires positive integral T/H within CUDA grid/route limits")
    if not math.isfinite(tau) or not 0 <= topk_ratio <= 1:
        raise ValueError("tau must be finite and topk_ratio must lie in [0,1]")
    if scale is not None and (not math.isfinite(scale) or scale <= 0):
        raise ValueError("scale must be positive and finite")
    if not math.isfinite(rope_eps) or rope_eps <= 0:
        raise ValueError("rope_eps must be positive and finite")


def validate_chunk(t0, m, t):
    if m <= 0 or t0 % 64 or m > t - t0 or (t0 + m < t and m % 64):
        raise ValueError("chunks must cover T in order with 64-aligned starts and nonfinal sizes")


def producer_measurement_skipped_bytes(h, m, *, keep_k, keep_residual=False):
    """Logical global stores omitted by the statistics-only producer pass.

    The count mirrors the nullable destinations in ``na_chunk`` and is a
    diagnostic accounting target, not a device profiler measurement.
    """
    blocks = (m + 63) // 64
    q_rows = h * m * (128 + 4)
    q_summary = h * blocks * (128 + 4 + 128 * 4)
    k_carrier = 0 if keep_k else h * blocks * 64 * (128 + 8)
    v_carrier = h * blocks * (128 * 64 + 128 * 2)
    residual = 0 if keep_residual else h * blocks * (128 * 64 + 128 * 2 + 128 * 4)
    return q_rows + q_summary + k_carrier + v_carrier + residual


@dataclass
class ValidationContext:
    """Caller-owned validated layout identity; no tensors or process-global state.

    Revalidates when shape/device/tensor identity/version changes. Statistics
    always receive a device-side finite assertion, never a cached finite flag.
    Caller must not mutate block lengths via raw pointers behind PyTorch's version.
    """
    identity: tuple | None = None
    source_ref: Any = None

    def matches(self, identity, source):
        if source is not None and identity[-1][1] is None:
            return False
        return (self.identity == identity and
                (source is None or (self.source_ref is not None and self.source_ref() is source)))

    def remember(self, identity, source):
        self.identity = identity
        self.source_ref = None if source is None else weakref.ref(source)


@dataclass
class Prepared:
    """Request-owned operands; all methods use the producer's device/current stream.

    close() drops owned device references. Returned views keep their own storage
    alive; callers must release these on cancellation. No model/global GPU cache.
    """
    workspace: Any
    plan: dict
    lengths: object
    original_vscale: object
    native: object
    kitchen: object
    t: int
    h: int
    stream: int
    scale: float
    tau: float
    topk_ratio: float
    sinks: tuple
    sink_queries: tuple
    tail: bool
    block_len: object = None
    coarse_gate: object = None
    kmean_next: object = None
    vamax_next: object = None
    phase: str = "prepared"
    counters: dict = field(default_factory=lambda: {
        "producer_passes": 0, "producer_chunks": 0, "route_calls": 0, "fine_calls": 0,
        "prefix_fine_calls": 0, "coarse_calls": 0,
        "producer_measurement_chunks": 0,
        "producer_measurement_skipped_bytes": 0,
    })
    calibration_measured: bool = False
    kernel_resources: dict = field(default_factory=dict)
    grouped: Any = None
    layout_identity: tuple = ()
    layout_source_ref: Any = None
    center_values: bool = True
    scratch_lease: Any = None
    block_offsets: Any = None
    route_metadata: dict = field(default_factory=dict)
    omega_coarse_epilogue: bool = False
    # Reused callback scratch. Hooks consume these views on the producer
    # stream and must not retain them past the callback (the same lifetime
    # rule as other prepared workspace views).
    hook_buffers: Any = None
    hook_capacity: int = 0

    def view(self, name, dtype, shape):
        if self.workspace is None:
            raise RuntimeError("prepared workspace is closed")
        n = math.prod(shape) * _dtype_bytes(dtype)
        offset = self.plan[name]
        return self.workspace[offset:offset+n].view(dtype).reshape(shape)

    def residual_metadata(self):
        import torch
        if self.grouped is not None:
            return self.grouped.means, self.grouped.scales
        shape = (1, self.h, self.plan["NTB"], 1, 128)
        return (self.view("rmean", torch.bfloat16, shape),
                self.view("rscale", torch.float32, shape))

    def close(self):
        if self.scratch_lease is not None:
            self.scratch_lease.close()
            self.scratch_lease = None
        for name in ("workspace", "lengths", "original_vscale", "block_len", "coarse_gate",
                     "kmean_next", "vamax_next", "grouped", "block_offsets", "hook_buffers"):
            setattr(self, name, None)
        self.hook_capacity = 0
        self.phase = "closed"
        self.route_metadata.clear()


def _check_stream(prepared):
    import torch
    if prepared.workspace is None:
        raise RuntimeError("prepared workspace is closed")
    if torch.cuda.current_stream(prepared.workspace.device).cuda_stream != prepared.stream:
        raise RuntimeError("native attention phases must use the producer's CUDA stream")


def prepare_chunked(
    qkv_chunks, t, h, rope_freqs, qk_norm_weights, kmean=None, vscale=None,
    tau=1.0, topk_ratio=0.0, scale=None, sink_blocks=None, sink_q=None,
    rope_eps=1e-6, tail=True, block_len=None, coarse_gate=None, token_aug=0,
    *, option="vc", chunk_hook=None, calibration_hook=None, grouping_hook=None,
    measurement_hook=None,
    grouping_policy="none", pv_precision="int8", grouping_schedule="all_steps",
    evaluation_index=None, grouping_state=None, validation_context=None, center_values=None,
    scratch_pool=None, retained_operand_bytes=0, reuse_geometry=False,
    omega_coarse_epilogue=False,
):
    """Prepare original Kitchen routing state and cube-centered INT8 V.

    chunk_hook(t0,q,k,v,valid_counts) sees bounded BF16 [1,H,M,128] operands
    after native norm/RoPE, before Kitchen quantization. Physical cube order;
    valid_counts is full int32 [1,Kblocks]. The final M may not be 64-aligned.
    Consume on the same stream; do not retain all chunks.

    calibration_hook(vamax,vscale,measured) runs before the final traversal.
    Bootstrap supplies fresh original absmax. Cached calls supply the stale
    estimate vscale*127/1.1 (the scale clamp is not invertible at zero).

    Optional caller-owned ScratchPool borrows workspace until close(). All
    workspace views must be consumed on this stream before close and must not
    escape that lifetime. Returned fine outputs/statistics remain separately owned.
    """
    validate_policy(t, h, option, token_aug, tau, topk_ratio, scale, rope_eps)
    reuse, center = schedule_action(grouping_policy, pv_precision, grouping_schedule,
                                    evaluation_index, grouping_state)
    if center_values is not None:
        if type(center_values) is not bool:
            raise TypeError("center_values must be bool or None (schedule default)")
        center = center_values
    if grouping_hook is not None and grouping_policy != "g4":
        raise ValueError("grouping_hook requires grouping_policy='g4'")
    if validation_context is not None and not isinstance(validation_context, ValidationContext):
        raise TypeError("validation_context must be a request-owned ValidationContext")
    if scratch_pool is not None and not isinstance(scratch_pool, ScratchPool):
        raise TypeError("scratch_pool must be a caller-owned ScratchPool")
    if type(retained_operand_bytes) is not int or retained_operand_bytes < 0:
        raise ValueError("retained_operand_bytes must be a nonnegative integer")
    if type(reuse_geometry) is not bool:
        raise TypeError("reuse_geometry must be bool")
    if type(omega_coarse_epilogue) is not bool:
        raise TypeError("omega_coarse_epilogue must be bool")
    torch, kitchen = _dependencies()
    if not rope_freqs.is_cuda:
        raise ValueError("native attention requires CUDA tensors")
    dev = rope_freqs.device
    native = get_native_library()
    capability = torch.cuda.get_device_capability(dev)
    if pv_precision == "nvfp4" and capability != (12, 0):
        raise RuntimeError("Kitchen-QK NVFP4 PV requires SM120")
    arch = f"{capability[0]}{capability[1]}"
    if arch not in native.report["architectures"]:
        raise RuntimeError(f"packaged native attention has no sm_{arch} cubin; rebuild on builder")
    if len(qk_norm_weights) != 2 or any(w.numel() != 128 for w in qk_norm_weights):
        raise ValueError("Q/K RMSNorm weights must each contain 128 elements")
    rot = rope_freqs.shape[-3] * 2
    if rot % 8 or not 0 < rot <= 128:
        raise ValueError("RoPE rotation dimension must be a multiple of 8 in (0,128]")
    kitchen._check_sol_args(dev, sink_blocks, sink_q, topk_ratio)
    p = native.plan(t, h, reuse=True) if reuse_geometry else native.plan(t, h)
    for pair in (sink_blocks, sink_q):
        if pair is not None and not 0 <= pair[0] <= pair[1] <= p["NTB"]:
            raise ValueError("sink intervals must be within the physical block range")
    with torch.cuda.device(dev):
        resources = native.check_resources(torch.cuda.current_device())
        fab = kitchen._packed_rope_fab(rope_freqs, t, rot)
        layout_source = block_len
        layout_identity = (t, h, str(dev), None if block_len is None else
                           (id(block_len), _tensor_version_or_none(block_len),
                            tuple(block_len.shape)))
        if block_len is not None:
            block_len = kitchen._check_block_len(block_len, t, dev)
        lengths = kitchen._block_lengths(t, p["NTB"], dev, block_len).to(torch.int32)
        # Kitchen producer skips empty blocks without initializing Q/K statistics.
        raw_lengths = lengths if block_len is None else block_len
        known_layout = validation_context is not None and validation_context.matches(
            layout_identity, layout_source)
        if block_len is not None and not known_layout:
            capacity = (t - torch.arange(p["NTB"], device=dev) * 64).clamp(max=64)
            valid_lengths = ((raw_lengths > 0) & (raw_lengths <= capacity)).all()
            if validation_context is not None:
                torch._assert_async(valid_lengths, "native attention requires 1..capacity live rows in each cube")
            elif not bool(valid_lengths):
                raise ValueError("native attention requires 1..capacity live rows in each cube")
            if validation_context is not None:
                validation_context.remember(layout_identity, layout_source)
        if coarse_gate is not None:
            coarse_gate = kitchen._check_coarse_gate(coarse_gate, (1, t, h, 128), dev)
        qw, kw = (w.to(device=dev, dtype=torch.bfloat16).reshape(128).contiguous()
                  for w in qk_norm_weights)
        stream_object = torch.cuda.current_stream(dev)
        stream = stream_object.cuda_stream
        # For production H3 geometries the workspace is hundreds of MB to
        # several GB. A caller-owned event pool then creates one entry per
        # layer/geometry and spends more time allocating/retiring storage than
        # PyTorch's allocator cache. Keep the pool for small kernels, but fail
        # open to the allocator for large workspaces so enabling the option
        # cannot turn into a latency regression.
        scratch_pool_bypassed = int(scratch_pool is not None and p["total"] > 64 * 1024**2)
        if scratch_pool_bypassed:
            scratch_pool = None
        lease = None
        offsets = None
        if scratch_pool is None:
            ws = torch.empty(p["total"], dtype=torch.uint8, device=dev)
        else:
            key = (str(dev), stream, t, h, p["total"], option, grouping_policy,
                   pv_precision, grouping_schedule, center, bool(tail), float(topk_ratio),
                   tuple(kitchen._sink_pair(sink_blocks)), tuple(kitchen._sink_pair(sink_q)))

            def allocate_scratch():
                workspace = torch.empty(p["total"], dtype=torch.uint8, device=dev)
                block_offsets = torch.arange(p["NTB"], device=dev)
                # Discard/clear may occur before native pointer consumers finish.
                workspace.record_stream(stream_object)
                block_offsets.record_stream(stream_object)
                return workspace, block_offsets

            def finish_scratch():
                with torch.cuda.device(dev):
                    event = torch.cuda.Event()
                    event.record(stream_object)
                    return event

            lease = scratch_pool.acquire(key, p["total"] + p["NTB"] * 8,
                                         allocate_scratch, finish_scratch)
            ws, offsets = lease.value
        prepared = Prepared(
            ws, p, lengths, None, native, kitchen, t, h, stream,
            128 ** -0.5 if scale is None else float(scale), float(tau), float(topk_ratio),
            tuple(kitchen._sink_pair(sink_blocks)), tuple(kitchen._sink_pair(sink_q)),
            bool(tail), block_len, coarse_gate,
        )
        prepared.omega_coarse_epilogue = omega_coarse_epilogue
        prepared.kernel_resources = resources
        if reuse_geometry:
            prepared.counters["geometry_cache_hits_total"] = native.plan_cache_info()["hits"]
            prepared.counters["geometry_cache_misses_total"] = native.plan_cache_info()["misses"]
        prepared.scratch_lease = lease
        prepared.block_offsets = offsets
        prepared.counters.update(scratch_allocations=int(lease is None or not lease.reused),
                                 scratch_reuses=int(lease is not None and lease.reused),
                                 geometry_reuses=int(lease is not None and lease.reused),
                                 scratch_pool_bypassed_large_workspace=scratch_pool_bypassed)
        prepared.center_values = center
        prepared.layout_identity = layout_identity
        prepared.layout_source_ref = None if layout_source is None else weakref.ref(layout_source)
        measured = kmean is None or vscale is None
        if measured and not callable(qkv_chunks):
            # Do not silently list() and retain the full BF16 projection.
            prepared.close()
            raise ValueError("bootstrap requires a replayable zero-argument chunk factory")

        retained = None
        if measured and retained_operand_bytes:
            def copy_operand(value):
                result = value.clone(memory_format=torch.contiguous_format)
                result.record_stream(stream_object)
                return result

            retained = RetainedReplay(
                qkv_chunks, retained_operand_bytes,
                lambda value: value.numel() * value.element_size(), copy_operand,
                lambda: (str(dev), torch.cuda.current_stream(dev).cuda_stream),
            )
            qkv_chunks = retained

        def produce(km, vs, emit):
            native.call("na_begin", ptr(ws), t, h, stream)
            if prepared.grouped is not None:
                prepared.grouped.clipping_counts.zero_()
            prepared.counters["producer_passes"] += 1
            t0 = 0
            chunks = qkv_chunks() if callable(qkv_chunks) else iter(qkv_chunks)
            for chunk in chunks:
                if (chunk.ndim not in (2, 3) or (chunk.ndim == 3 and chunk.shape[0] != 1)
                        or chunk.shape[-1] != 3 * h * 128 or chunk.dtype != torch.bfloat16
                        or chunk.device != dev):
                    raise ValueError("chunks must be [M,3*H*128] or [1,M,3*H*128] BF16 on device")
                m = chunk.shape[-2]
                validate_chunk(t0, m, t)
                chunk = chunk.contiguous()
                hook = [None, None, None]
                needs_hook = ((emit and (chunk_hook is not None or grouping_hook is not None))
                              or (not emit and measurement_hook is not None))
                if needs_hook:
                    # Chunk sizes commonly repeat across a request. Keep one
                    # grow-only set of callback buffers instead of allocating
                    # three BF16 tensors for every chunk and calibration pass.
                    if prepared.hook_capacity < m:
                        prepared.hook_buffers = [
                            torch.empty((1, h, m, 128), dtype=torch.bfloat16, device=dev)
                            for _ in range(3)]
                        prepared.hook_capacity = m
                    hook = [buffer[..., :m, :] for buffer in prepared.hook_buffers]
                producer_flags = int(center)
                if not emit:
                    # Statistics-only bootstrap: preserve K only when the G4
                    # preparation kernel will consume it after this call.
                    producer_flags |= 2
                    if prepared.grouped is not None:
                        producer_flags |= 4
                    if prepared.center_values and prepared.grouped is None:
                        # Centered combined calibration consumes represented
                        # residual means from the measurement traversal.
                        producer_flags |= 8
                native.call(
                    "na_chunk", ptr(ws), ptr(chunk), ptr(fab), ptr(qw), ptr(kw),
                    ptr(km), ptr(vs), ptr(block_len), *(ptr(x) for x in hook),
                    float(rope_eps), rot, t0, m, t, h, producer_flags, stream,
                )
                prepared.counters["producer_chunks"] += 1
                if not emit:
                    skipped = producer_measurement_skipped_bytes(
                        h,
                        m,
                        keep_k=prepared.grouped is not None,
                        keep_residual=prepared.center_values and prepared.grouped is None,
                    )
                    prepared.counters["producer_measurement_chunks"] += 1
                    prepared.counters["producer_measurement_skipped_bytes"] += skipped
                if prepared.grouped is not None:
                    prepared.grouped.prepare_chunk(prepared, chunk, t0, m)
                if emit and chunk_hook is not None:
                    chunk_hook(t0, *hook, lengths.reshape(1, -1))
                    _check_stream(prepared)
                if emit and grouping_hook is not None:
                    first, end = t0 // 64, (t0 + m + 63) // 64
                    grouping_hook(t0, *hook, lengths.reshape(1, -1),
                               prepared.grouped.permutation[:, :, first:end],
                               prepared.grouped.means[:, :, first:end])
                    _check_stream(prepared)
                if not emit and measurement_hook is not None:
                    first, end = t0 // 64, (t0 + m + 63) // 64
                    if prepared.grouped is None:
                        perm = None
                        means = prepared.residual_metadata()[0][:, :, first:end].clone()
                        ss, se = prepared.sinks
                        if max(first, ss) < min(end, se):
                            means[:, :, max(first, ss)-first:min(end, se)-first] = 0
                    else:
                        perm = prepared.grouped.permutation[:, :, first:end]
                        means = prepared.grouped.means[:, :, first:end]
                    measurement_hook(t0, *hook, lengths.reshape(1, -1), perm, means)
                    _check_stream(prepared)
                t0 += m
            if t0 != t:
                raise ValueError(f"chunks cover {t0} tokens, expected {t}")

        try:
            if measured:
                if grouping_policy == "g4" and measurement_hook is not None:
                    # Quantization here is disposable; original values/means measure the
                    # next global calibration. Reuse its permutation in the final pass.
                    prepared.original_vscale = torch.ones(
                        (h, 128), device=dev, dtype=torch.float32)
                    prepared.grouped = allocate_grouped(
                        prepared, pv_precision, reuse, center, grouping_state, evaluation_index)
                produce(torch.zeros(h, 128, device=dev, dtype=torch.float32),
                        torch.ones(h, 128, device=dev, dtype=torch.float32), False)
                kmean = kitchen._ws_ksums(ws, p, h).sum(1) / lengths.sum()
                vmax = prepared.view("statsV", torch.float32, (h, 128)).clone()
                vscale = (vmax / 127.0 * 1.1).clamp_min(1e-8)
            for label, value in (("kmean", kmean), ("vscale", vscale)):
                if tuple(value.shape) != (h, 128):
                    raise ValueError(f"{label} must have [H,128] values")
                if validation_context is None and not bool(torch.isfinite(value).all()):
                    raise ValueError(f"{label} must be finite")
            kmean = kmean.to(device=dev, dtype=torch.float32).contiguous()
            vscale = vscale.to(device=dev, dtype=torch.float32).contiguous()
            if validation_context is not None:
                torch._assert_async(torch.isfinite(kmean).all(), "native kmean must be finite")
                torch._assert_async(torch.isfinite(vscale).all(), "native vscale must be finite")
            vscale = vscale.clamp_min(1e-8)
            prepared.original_vscale = vscale
            prepared.calibration_measured = measured
            if grouping_policy == "g4":
                if prepared.grouped is None:
                    prepared.grouped = allocate_grouped(
                        prepared, pv_precision, reuse, center, grouping_state, evaluation_index)
                else:
                    prepared.grouped.global_vscale = conservative_global_scale(vscale)
                    prepared.grouped.reuse = True
            if calibration_hook is not None:
                calibration_hook(vmax if measured else vscale * (127.0 / 1.1), vscale, measured)
                _check_stream(prepared)
            produce(kmean, vscale, True)
            if prepared.grouped is not None:
                prepared.grouped.commit(prepared)
        except BaseException:
            prepared.close()
            raise
        finally:
            if retained is not None:
                prepared.counters.update(retained.stats)
                retained.close()
    return prepared


def route(prepared):
    """Finish original statistics and execute Kitchen routing exactly once.

    Return device uint16 IDs [1,H,N,N] and int32 counts [1,H,N].
    Unused ID capacity is uninitialized and must never be used as live routes.
    """
    import torch
    _check_stream(prepared)
    if prepared.phase != "prepared":
        raise RuntimeError("route requires a freshly prepared workspace")
    x = prepared
    with torch.cuda.device(x.workspace.device):
        threshold = (
            x.kitchen._topk_threshold_from_workspace(
                x.workspace, x.plan, x.h, x.topk_ratio, x.scale, x.lengths, x.sinks)
            if x.topk_ratio else None
        )
        x.kmean_next = torch.empty((x.h, 128), device=x.workspace.device, dtype=torch.float32)
        x.vamax_next = torch.empty_like(x.kmean_next)
        x.native.call(
            "na_route", ptr(x.workspace), ptr(x.original_vscale), ptr(x.kmean_next),
            ptr(x.vamax_next), ptr(x.block_len), ptr(threshold),
            x.t, x.h, x.tau, x.scale, *x.sinks, *x.sink_queries, int(x.tail), x.stream,
        )
    x.phase = "routed"
    x.counters["route_calls"] += 1
    n = x.plan["NTB"]
    return (x.view("idx", torch.uint16, (1, x.h, n, n)),
            x.view("cnt", torch.int32, (1, x.h, n)))


def route_and_export(prepared, *, scores=False, fused_metadata=True):
    """Route and export native int32 IDs in one C-ABI call.

    Kitchen remains the owner of thresholding and route selection. The native
    wrapper converts its packed uint16 route table, masks inactive slots, and
    optionally exports the original route scores before Python regains
    control. This keeps the route handoff device-resident.

    The fused metadata kernel is the default: it emits int32 slots/counts in
    the existing route kernel, preserving its per-row stable compaction and
    avoiding the separate export launch. Pass fused_metadata=False only for
    an explicit control comparison. No global CSR scan or fine-kernel fusion.
    Diagnostics scope excludes threshold/preprocessing.
    """
    import torch
    _check_stream(prepared)
    if prepared.phase != "prepared":
        raise RuntimeError("route_and_export requires a freshly prepared workspace")
    if type(fused_metadata) is not bool:
        raise TypeError("fused_metadata must be bool")
    x = prepared
    n = x.plan["NTB"]
    with torch.cuda.device(x.workspace.device):
        if fused_metadata:
            x.kernel_resources["route_emit"] = x.native.route_emission_resources(
                torch.cuda.current_device())
        threshold = (
            x.kitchen._topk_threshold_from_workspace(
                x.workspace, x.plan, x.h, x.topk_ratio, x.scale, x.lengths, x.sinks)
            if x.topk_ratio else None
        )
        x.kmean_next = torch.empty((x.h, 128), device=x.workspace.device, dtype=torch.float32)
        x.vamax_next = torch.empty_like(x.kmean_next)
        ids = torch.empty((1, x.h, n, n), device=x.workspace.device, dtype=torch.int32)
        counts = torch.empty((1, x.h, n), device=x.workspace.device, dtype=torch.int32)
        route_scores = torch.empty((1, x.h, n, n), device=x.workspace.device,
                                   dtype=torch.float32) if scores else None
        x.native.call(
            "na_route_emit" if fused_metadata else "na_route_export",
            ptr(x.workspace), ptr(x.original_vscale), ptr(x.kmean_next),
            ptr(x.vamax_next), ptr(x.block_len), ptr(threshold), ptr(ids), ptr(counts),
            ptr(route_scores), x.t, x.h, x.tau, x.scale, *x.sinks, *x.sink_queries,
            int(x.tail), x.stream,
        )
    x.phase = "routed"
    x.counters["route_calls"] += 1
    x.counters.update(
        route_metadata_fused=int(fused_metadata),
        route_and_export_kernel_launches=1 if fused_metadata else 2,
        route_score_kernel_launches=int(scores),
        route_metadata_host_copies=0, route_metadata_host_syncs=0,
        route_wrapper_d2d_copies=2, route_wrapper_d2d_bytes=8 * x.h * 128,
        route_metadata_rows=x.h * n, route_metadata_id_capacity=x.h * n * n,
        route_metadata_output_bytes=4 * x.h * n * n + 4 * x.h * n,
    )
    # Counts ARE the selected-ID count per row. Keep them device-resident;
    # summing here would add a reduction launch and .item() would synchronize.
    x.route_metadata = {"selected_id_counts": counts,
                        "selected_counts_scope": "per-head/per-query-row device int32",
                        "counter_scope": "route+export only; excludes finish/threshold",
                        "order": "protected keys first, then ascending selected nonprotected keys"}
    if scores:
        x.counters["route_score_exports"] = x.counters.get("route_score_exports", 0) + 1
    return ids, counts, route_scores


supports_route_prefix = True


def route_and_export_with_prefix(prepared, *, scores=False, skip_empty_prefix=False):
    """Route/export and compute exact protected-prefix output in one C-ABI call."""
    import torch
    _check_stream(prepared)
    if prepared.phase != "prepared":
        raise RuntimeError("route_and_export_with_prefix requires a freshly prepared workspace")
    if type(skip_empty_prefix) is not bool:
        raise TypeError("skip_empty_prefix must be bool")
    x = prepared
    if skip_empty_prefix and x.sink_queries[0] == x.sink_queries[1]:
        ids, counts, route_scores = route_and_export(x, scores=scores)
        # No protected rows exist; preserve the old undefined output contract.
        prefix = torch.empty((1, x.t, x.h, 128), device=x.workspace.device,
                             dtype=torch.bfloat16)
        x.counters["prefix_launches_skipped"] = x.counters.get("prefix_launches_skipped", 0) + 1
        return ids, counts, route_scores, prefix
    n = x.plan["NTB"]
    with torch.cuda.device(x.workspace.device):
        threshold = (
            x.kitchen._topk_threshold_from_workspace(
                x.workspace, x.plan, x.h, x.topk_ratio, x.scale, x.lengths, x.sinks)
            if x.topk_ratio else None
        )
        x.kmean_next = torch.empty((x.h, 128), device=x.workspace.device, dtype=torch.float32)
        x.vamax_next = torch.empty_like(x.kmean_next)
        ids = torch.empty((1, x.h, n, n), device=x.workspace.device, dtype=torch.int32)
        counts = torch.empty((1, x.h, n), device=x.workspace.device, dtype=torch.int32)
        route_scores = torch.empty((1, x.h, n, n), device=x.workspace.device,
                                   dtype=torch.float32) if scores else None
        prefix = torch.empty((1, x.t, x.h, 128), device=x.workspace.device,
                             dtype=torch.bfloat16)
        x.native.call(
            "na_route_export_prefix", ptr(x.workspace), ptr(x.original_vscale),
            ptr(x.kmean_next), ptr(x.vamax_next), ptr(x.block_len), ptr(threshold),
            ptr(ids), ptr(counts), ptr(route_scores), ptr(prefix), x.t, x.h, x.tau,
            x.scale, *x.sinks, *x.sink_queries, int(x.tail), x.stream,
        )
    x.phase = "routed"
    x.counters["route_calls"] += 1
    x.counters["prefix_fine_calls"] += 1
    if scores:
        x.counters["route_score_exports"] = x.counters.get("route_score_exports", 0) + 1
    return ids, counts, route_scores, prefix


def anemoi_routes(prepared):
    """GPU-only ID conversion; no host lists, route selection, or count changes."""
    import torch
    _check_stream(prepared)
    if prepared.phase != "routed":
        raise RuntimeError("route() must run before exporting Anemoi routes")
    x, n = prepared, prepared.plan["NTB"]
    counts = x.view("cnt", torch.int32, (1, x.h, n))
    ids = x.view("idx", torch.uint16, (1, x.h, n, n)).to(torch.int32)
    offsets = x.block_offsets
    if offsets is None:
        offsets = torch.arange(n, device=ids.device)
    ids.masked_fill_(offsets >= counts.unsqueeze(-1), -1)
    return ids, counts, x.lengths.reshape(1, n).to(torch.int32)


def original_route_scores(prepared):
    """Original Kitchen raw log2 proxy scores [1,H,N,N], key-ID aligned.

    int32_dot(cen8[q],kciP[k]) * (cens[q] * scale*LOG2E) * kcs[k].
    Carriers already share perm_d. No softmax, alternate router, or route changes.
    """
    import torch
    _check_stream(prepared)
    x = prepared
    if x.phase != "routed":
        raise RuntimeError("original route scores require finished pooled-key quantization")
    n = x.plan["NTB"]
    with torch.cuda.device(x.workspace.device):
        scores = torch.empty((1, x.h, n, n), device=x.workspace.device, dtype=torch.float32)
        x.native.call("na_original_scores", ptr(x.workspace), ptr(scores), x.t, x.h, x.scale, x.stream)
    x.counters["route_score_exports"] = x.counters.get("route_score_exports", 0) + 1
    return scores


def fine(prepared, *, prefix_only=False, skip_empty_prefix=False):
    """Native sparse INT8 VC result [1,T,H,128] BF16, before coarse merge.

    prefix_only writes stock output ONLY to sink_q rows; all other rows are
    undefined. This avoids a second full attention pass for Anemoi integration.
    """
    import torch
    _check_stream(prepared)
    x = prepared
    if x.phase != "routed":
        raise RuntimeError("route() must run before fine()")
    if type(skip_empty_prefix) is not bool:
        raise TypeError("skip_empty_prefix must be bool")
    with torch.cuda.device(x.workspace.device):
        out = torch.empty((1, x.t, x.h, 128), dtype=torch.bfloat16, device=x.workspace.device)
        if prefix_only and skip_empty_prefix and x.sink_queries[0] == x.sink_queries[1]:
            x.counters["prefix_launches_skipped"] = x.counters.get("prefix_launches_skipped", 0) + 1
            return out
        if x.grouped is not None and not prefix_only:
            x.grouped.fine(x, out)
        else:
            x.native.call("na_fine", ptr(x.workspace), ptr(out), x.t, x.h, x.scale,
                          *x.sinks, *x.sink_queries, int(prefix_only), x.stream)
    x.counters["prefix_fine_calls" if prefix_only else "fine_calls"] += 1
    return out


def merge_coarse(prepared, out):
    """Original BF16 fine boundary then Kitchen addcmul order; call once."""
    import torch
    _check_stream(prepared)
    x = prepared
    if x.phase != "routed":
        raise RuntimeError("coarse merge requires routed original statistics")
    if (tuple(out.shape) != (1, x.t, x.h, 128) or out.dtype != torch.bfloat16
            or out.device != x.workspace.device):
        raise ValueError("coarse merge requires BF16 [1,T,H,128] on producer device")
    if x.coarse_gate is not None:
        with torch.cuda.device(out.device):
            coarse = x.kitchen.coarse_output(
                *x.kitchen._ws_block_means(x.workspace, x.plan, x.h, x.lengths), x.scale)
            if x.omega_coarse_epilogue:
                if (not coarse.is_cuda or not coarse.is_contiguous()
                        or not x.coarse_gate.is_cuda or not x.coarse_gate.is_contiguous()
                        or coarse.device != out.device or x.coarse_gate.device != out.device
                        or coarse.dtype != torch.float32
                        or x.coarse_gate.dtype not in (torch.bfloat16, torch.float32)):
                    raise RuntimeError(
                        "omega_coarse_epilogue requires contiguous CUDA FP32 coarse and "
                        "contiguous CUDA BF16/FP32 gate tensors"
                    )
                library = getattr(x.native, "library", None)
                if library is None or not hasattr(library, "na_output_epilogue"):
                    raise RuntimeError(
                        "omega_coarse_epilogue requested but native artifact lacks "
                        "na_output_epilogue; rebuild required"
                    )
                x.native.call(
                    "na_output_epilogue", ptr(out), ptr(coarse), ptr(x.coarse_gate), ptr(out),
                    x.t, x.h, x.plan["NTB"], int(x.coarse_gate.dtype == torch.float32), x.stream,
                )
                x.counters["output_epilogue_launches"] = (
                    x.counters.get("output_epilogue_launches", 0) + 1)
                elements = x.t * x.h * 128
                gate_bytes = 4 if x.coarse_gate.dtype == torch.float32 else 2
                output_bytes = elements * 2
                input_bytes = output_bytes + elements * gate_bytes + x.h * x.plan["NTB"] * 128 * 4
                x.counters["output_epilogue_input_bytes"] = input_bytes
                x.counters["output_epilogue_output_bytes"] = output_bytes
                x.counters["output_epilogue_bytes"] = input_bytes + output_bytes
                x.counters["output_epilogue_copy_bytes"] = 0
                x.counters["output_epilogue_python_addcmul_eliminated"] = 1
            else:
                x.kitchen.add_coarse_(out, coarse, x.coarse_gate)
        x.counters["coarse_calls"] += 1
    return out


@timed_native_call(3)
def sol_attn_chunked(
    qkv_chunks, t, h, rope_freqs, qk_norm_weights, kmean=None, vscale=None,
    tau=1.0, topk_ratio=0.0, scale=None, sink_blocks=None, sink_q=None,
    rope_eps=1e-6, tail=True, block_len=None, coarse_gate=None, token_aug=0,
    *, option="vc", diagnostics=None, grouping_policy="none", pv_precision="int8",
    grouping_schedule="all_steps", evaluation_index=None, grouping_state=None,
    validation_context=None, center_values=None, _stage_mark=None,
    scratch_pool=None, retained_operand_bytes=0, reuse_geometry=False,
    omega_coarse_epilogue=False,
):
    """Kitchen sol_attn_chunked positional ABI; explicit VC, no fallback."""
    mark = _stage_mark
    mark("prepare_start")
    x = prepare_chunked(
        qkv_chunks, t, h, rope_freqs, qk_norm_weights, kmean, vscale,
        tau, topk_ratio, scale, sink_blocks, sink_q, rope_eps, tail,
        block_len, coarse_gate, token_aug, option=option,
        grouping_policy=grouping_policy, pv_precision=pv_precision,
        grouping_schedule=grouping_schedule, evaluation_index=evaluation_index,
        grouping_state=grouping_state, validation_context=validation_context,
        center_values=center_values,
        scratch_pool=scratch_pool,
        retained_operand_bytes=retained_operand_bytes,
        reuse_geometry=reuse_geometry,
        omega_coarse_epilogue=omega_coarse_epilogue,
    )
    try:
        mark("prepare_end")
        route(x)
        mark("route_end")
        out = fine(x)
        mark("fine_end")
        out = merge_coarse(x, out)
        mark("coarse_and_output_end")
        next_scale = (x.vamax_next / 127.0 * 1.1).clamp_min(1e-8)
        if diagnostics is not None:
            diagnostics.update(
                requested_backend=option,
                executed_backend=f"kitchen034_native_vc_{pv_precision}_{'g4' if x.grouped else 'g1'}",
                counters=dict(x.counters), workspace_bytes=x.plan["total"],
                calibration_measured=x.calibration_measured, gpu_validated=False,
                build_report=x.native.report, token_aug=0, groups=4 if x.grouped else 1,
                grouping_policy=grouping_policy, grouping_schedule=grouping_schedule,
                permutation_reused=bool(x.grouped and x.grouped.reused_from_state),
                centered=bool(x.grouped.center) if x.grouped else x.center_values,
                pv_precision=pv_precision, evaluation_index=evaluation_index,
                prefix_query_policy="original-stock",
                prefix_key_policy="original-stock-carrier",
                kernel_resources=x.kernel_resources,
            )
            diagnostics["kitchen_workspace_bytes"] = x.plan["total"]
            diagnostics["workspace_bytes"] = storage_bytes(
                getattr(x, "workspace", None), operand_tensors(x.grouped), out,
                x.kmean_next, x.vamax_next, next_scale,
                getattr(x, "original_vscale", None), getattr(x, "lengths", None),
            )
            diagnostics["workspace_accounting"] = "unique-live-backing-storage; excludes freed scratch; not peak"
            if scratch_pool is not None:
                diagnostics["scratch_pool"] = scratch_pool.diagnostics()
            if x.grouped is not None and x.grouped.fp4:
                diagnostics["vc_nvfp4_clipping_counts"] = x.grouped.clipping_counts
                diagnostics["vc_nvfp4_clipping_count_names"] = [
                    "residual_values_outside_global_range_or_nonfinite",
                    "groups_outside_global_range_or_nonfinite",
                ]
                diagnostics["vc_nvfp4_calibration"] = {
                    "policy": "channel-global-2x-original-vamax-bound",
                    "fresh_original_vamax": x.calibration_measured,
                    "exact_residual_amax": False,
                    "minimum_global_scale": 1e-8,
                    "cached_scale_clamp_invertible": False,
                    "global_scale_outward_rounded": True,
                    "normal_microscale_rounding_is_calibration_clipping": False,
                }
        return out, x.kmean_next, next_scale
    finally:
        x.close()
