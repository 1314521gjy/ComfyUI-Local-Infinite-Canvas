"""Request-owned CUDA events and storage accounting; never synchronizes a call."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from itertools import pairwise

_request_timings = ContextVar("native_attention_request_timings", default=None)


def timed_native_call(rope_position):
    def decorate(function):
        @wraps(function)
        def call(*args, **kwargs):
            rope = args[rope_position] if len(args) > rope_position else kwargs.get("rope_freqs")
            with stage_timing_call(kwargs.get("diagnostics"), getattr(rope, "device", None)) as mark:
                return function(*args, **kwargs, _stage_mark=mark)
        return call
    return decorate


class StageTimings:
    """Own events until explicit post-sampling resolve(); no tensor references.

    resolve() defaults to nonblocking completion checks. resolve(synchronize=True)
    waits once per producer stream, at the caller's explicit request boundary.
    Scope exit on failure clears events. This replaces stage_timing_events, whose
    legacy dispatcher consumer synchronizes every attention invocation.
    """
    def __init__(self):
        self.records = []

    def resolve(self, *, synchronize=False):
        last = {}
        for stream, events in self.records:
            if events:
                last[stream] = events[-1][1]
        if synchronize:
            for event in last.values():
                event.synchronize()
        if any(not events[-1][1].query() for _, events in self.records if events):
            raise RuntimeError("native timings pending; resolve after sampling synchronization")
        totals: dict[str, float] = {}
        for _, events in self.records:
            for (name, start), (end_name, end) in pairwise(events):
                key = f"{name}->{end_name}"
                totals[key] = totals.get(key, 0.0) + float(start.elapsed_time(end))
        result = {"stage_timings_ms": totals, "timed_calls": len(self.records)}
        self.clear()
        return result

    def clear(self):
        self.records.clear()


@contextmanager
def request_stage_timings(collector=None):
    collector = StageTimings() if collector is None else collector
    token = _request_timings.set(collector)
    try:
        yield collector
    except BaseException:
        collector.clear()
        raise
    finally:
        _request_timings.reset(token)


@contextmanager
def stage_timing_call(diagnostics, device):
    """Transaction: failed calls never append partial timing records."""
    owner = _request_timings.get()
    requested = diagnostics is not None and diagnostics.get("record_stage_timings", False)
    if owner is None and requested:
        owner = diagnostics.setdefault("deferred_stage_timings", StageTimings())
    if owner is not None and not isinstance(owner, StageTimings):
        raise TypeError("deferred_stage_timings must be a StageTimings instance")
    events, streams = [], []

    def mark(name):
        if owner is None:
            return
        import torch
        stream = torch.cuda.current_stream(device)
        event = torch.cuda.Event(enable_timing=True)
        event.record(stream)
        streams.append((str(stream.device), stream.cuda_stream))
        events.append((name, event))

    try:
        yield mark
    except BaseException:
        events.clear()
        raise
    else:
        if owner is not None and events:
            if any(stream != streams[0] for stream in streams):
                raise RuntimeError("native timing call changed CUDA stream")
            owner.records.append((streams[0], events))
            if diagnostics is not None:
                diagnostics["stage_timings_deferred"] = True
    finally:
        streams.clear()


def storage_bytes(*values):
    """Unique live tensor backing-storage bytes, including views' full storage.

    Metadata-only; no tensor scalar reads or CUDA synchronization. This is a live
    snapshot, not peak VRAM: freed chunk/threshold/CUB scratch is not included.
    """
    storages = {}
    seen = set()

    def visit(value):
        if id(value) in seen:
            return
        seen.add(id(value))
        if hasattr(value, "untyped_storage"):
            storage = value.untyped_storage()
            storages[(str(value.device), storage.data_ptr())] = storage.nbytes()
        elif isinstance(value, (tuple, list)):
            for item in value:
                visit(item)
    for value in values:
        visit(value)
    return sum(storages.values())


def operand_tensors(prepared):
    """Explicit operand inventory: exclude model inputs, caches and arbitrary metadata."""
    return tuple(getattr(prepared, name, None) for name in (
        "q", "k", "v", "q_scale", "k_scale", "v_scale", "means", "valid",
        "global_vscale", "global_scales", "clipping_counts", "observed_amax",
        "keys", "key_scale_bias", "residual", "scales", "scale_codes", "permutation",
    ))
