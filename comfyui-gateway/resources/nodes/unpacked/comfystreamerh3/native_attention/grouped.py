"""Explicit cube grouping policy and caller-owned retained permutation state.

No dispatch/model/sampler changes and no process-global tensor state.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._abi import ptr


def conservative_global_scale(original_vscale):
    import torch
    scale = (original_vscale * (127.0 / 1.1 * 2.0 / 2688.0)).clamp_min(1e-8)
    return torch.nextafter(scale, torch.full_like(scale, float("inf"))).contiguous()


def schedule_action(grouping_policy, pv_precision, grouping_schedule, evaluation_index,
                    grouping_state):
    if grouping_policy not in ("none", "g4"):
        raise ValueError("grouping_policy must be 'none' or 'g4'")
    if pv_precision not in ("int8", "nvfp4"):
        raise ValueError("pv_precision must be 'int8' or 'nvfp4'")
    if grouping_schedule not in ("all_steps", "first_eval"):
        raise ValueError("grouping_schedule must be 'all_steps' or 'first_eval'")
    if grouping_schedule == "first_eval" and (
            type(evaluation_index) is not int or evaluation_index < 0):
        raise ValueError("first_eval requires explicit nonnegative evaluation_index")
    if grouping_policy == "none":
        if pv_precision != "int8":
            raise NotImplementedError("native NVFP4 currently requires grouping_policy='g4'")
        return False, grouping_schedule == "all_steps" or evaluation_index == 0
    if grouping_schedule == "all_steps":
        return False, True
    if type(evaluation_index) is not int or evaluation_index < 0:
        raise ValueError("first_eval requires explicit nonnegative evaluation_index")
    if not isinstance(grouping_state, dict) or "scope" not in grouping_state:
        raise ValueError("first_eval requires caller-owned grouping_state with request/layer scope")
    return evaluation_index > 0, evaluation_index == 0


@dataclass
class RetainedPermutation:
    scope: Any
    shape: tuple
    lengths: Any
    permutation: Any
    stream: int
    layout_identity: tuple
    source_ref: Any
    evaluation_index: int


@dataclass
class Grouped:
    keys: Any
    key_scale_bias: Any
    residual: Any
    means: Any
    scales: Any
    scale_codes: Any
    permutation: Any
    global_vscale: Any
    clipping_counts: Any
    fp4: bool
    reuse: bool
    center: bool
    state: Any
    evaluation_index: Any
    reused_from_state: bool

    def prepare_chunk(self, x, projection, t0, m):
        x.native.call(
            "na_group_chunk", ptr(x.workspace), ptr(projection), ptr(x.lengths),
            ptr(self.keys), ptr(self.key_scale_bias), ptr(self.residual), ptr(self.means),
            ptr(self.scales), ptr(self.scale_codes), ptr(self.permutation),
            ptr(self.clipping_counts), ptr(self.global_vscale),
            t0, m, x.t, x.h, *x.sinks, int(self.reuse), int(self.center), int(self.fp4), x.stream,
        )
        x.counters["group_prepare_chunks"] = x.counters.get("group_prepare_chunks", 0) + 1
        if not self.reuse:
            x.counters["cluster_refresh_chunks"] = x.counters.get("cluster_refresh_chunks", 0) + 1

    def commit(self, x):
        if self.state is not None:
            self.state["_native_vc_permutation"] = RetainedPermutation(
                self.state["scope"], (x.t, x.h, str(x.workspace.device), x.sinks),
                x.lengths.clone(), self.permutation, x.stream,
                x.layout_identity, x.layout_source_ref,
                0 if self.evaluation_index is None else self.evaluation_index,
            )
            self.state["_native_vc_clipping_counts"] = self.clipping_counts

    def fine(self, x, out):
        x.native.call(
            "na_group_fine", ptr(x.workspace), ptr(self.keys), ptr(self.key_scale_bias),
            ptr(self.residual), ptr(self.means), ptr(self.scales), ptr(self.scale_codes),
            ptr(self.global_vscale), ptr(out), x.t, x.h, x.scale, *x.sinks,
            *x.sink_queries, int(self.fp4), x.stream,
        )


def allocate_grouped(x, pv_precision, reuse, center, state, evaluation_index):
    import torch
    n, tp, h, device = x.plan["NTB"], x.plan["Tp"], x.h, x.workspace.device
    fp4 = pv_precision == "nvfp4"
    if fp4 and torch.cuda.get_device_capability(device) != (12, 0):
        raise RuntimeError("Kitchen-QK NVFP4 PV is an experimental SM120-only specialization")
    x.kernel_resources.update(x.native.check_resources(torch.cuda.current_device(), grouped=True))
    if state is not None and (not isinstance(state, dict) or "scope" not in state):
        raise ValueError("grouping_state must contain explicit request/layer scope")
    shape = (x.t, h, str(device), x.sinks)
    retained = None if state is None else state.get("_native_vc_permutation")
    if reuse:
        if state is None:
            raise ValueError("reuse requires caller-owned grouping state")
        if not isinstance(retained, RetainedPermutation):
            raise ValueError("no first-evaluation permutation; refusing silent regrouping")
        if retained.scope != state["scope"] or retained.shape != shape or retained.stream != x.stream:
            raise ValueError("retained grouping belongs to a different scope/shape/stream; clear state")
        if evaluation_index < retained.evaluation_index:
            raise ValueError("evaluation moved backwards; clear grouping state at request reset")
        source_same = (
            retained.layout_identity == x.layout_identity
            and (x.layout_identity[-1] is None or x.layout_identity[-1][1] is not None)
            and (retained.source_ref is None or retained.source_ref() is x.layout_source_ref())
        )
        if not source_same:
            torch._assert_async((retained.lengths == x.lengths).all(),
                                "live cube lengths changed; retained grouping cannot be reused")
        permutation = retained.permutation
    else:
        permutation = torch.empty((1, h, n, 64), dtype=torch.uint8, device=device)

    def empty(shape, dtype):
        return torch.empty(shape, dtype=dtype, device=device)

    return Grouped(
        empty((h, tp, 128), torch.int8), empty((h, tp, 2), torch.float32),
        empty((h, 128, tp // 2 if fp4 else tp), torch.uint8),
        empty((1, h, n, 4, 128), torch.bfloat16),
        empty((1, h, n, 4, 128), torch.float32),
        empty((h, n, 128, 4), torch.uint8),
        permutation,
        conservative_global_scale(x.original_vscale),
        torch.zeros(2, device=device, dtype=torch.uint64),
        fp4, reuse, center, state, evaluation_index, reuse,
    )
