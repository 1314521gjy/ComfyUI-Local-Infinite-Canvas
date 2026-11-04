"""Named stage ranges: NVTX marks plus optional CUDA-event attribution.

``nvtx_range`` has always pushed an NVTX mark, which is free but only visible
to nsys. Deploy workers are serverless and cannot host nsys or ncu, so those
marks have never produced a single number. The same call sites now also carry
an opt-in CUDA-event timer, which is the only GPU attribution instrument
available on the worker.

Design constraints that the implementation must respect:

* **Off by default and cheap when off.** With no collector and no
  ``FASTH3_NVTX=1``, a range is a no-op: no NVTX, no events, no lock.
* **Never synchronize inside a range.** Events are recorded on the stream and
  read only once, after an explicit synchronize in :func:`collect`. Calling
  ``elapsed_time`` mid-forward would stall the pipeline and corrupt the very
  measurement being taken.
* **Bounded memory.** A decode pass enters ``decode_attn`` on the order of
  thousands of times, so each stage samples at most ``max_events`` pairs and
  reports how many calls it skipped rather than growing without limit.
* **Durations stay compact.** collect() keeps percentiles and a tiny histogram,
  never the raw per-call list, so the log line stays under the job-log cap.
"""

from __future__ import annotations

import os
import statistics
import threading
from contextlib import contextmanager
from typing import Any

import torch

_CUDA_NVTX = None  # None = unknown; avoid torch.cuda.is_available() on every range

# Stage names this project instruments. Recording an unlisted name still works;
# this exists so a report can show a stage as absent rather than missing.
KNOWN_STAGES = (
    "sample",
    "mlp_fc1",
    "mlp_amax",
    "mlp_pack",
    "mlp_fc2",
    "attn_out_proj",
    "vsa_producer",
    "vsa_core",
    "vsa_layout",
    "vsa_route",
    "vsa_attend",
    "vsa_coarse",
    "vsa_gather",
    "vsa_gate",
    "vsa_qkv",
    "vsa_gate_qkv",
    "vsa_unpermute",
    "decode_tile",
    "decode_embed",
    "decode_attn",
    "decode_attention_core",
    "decode_block",
    "decode_qk",
    "decode_ff",
    "decode_norm",
    "decode_proj",
    "decode_proj_qkv",
    "decode_proj_attn_out",
    "decode_proj_ff_w1",
    "decode_proj_ff_w2",
    "decode_proj_final",
    "decode_mod",
    "decode_fold",
    "decode_blend",
    "decode_assemble",
    "video_decode",
    "audio_decode",
    "encode_d2h",
    "mod_scale_shift",
    "mod_gate",
)

# Inclusive ranges that contain other instrumented ranges. Exclusive leaf sums
# omit these parents so nested mlp/vsa/decode children are not double-counted.
STAGE_PARENTS = {
    "sample": ("mlp_fc1", "mlp_amax", "mlp_pack", "mlp_fc2", "attn_out_proj",
               "vsa_producer", "vsa_core", "mod_scale_shift", "mod_gate"),
    "vsa_producer": (
        "vsa_core", "vsa_gather", "vsa_gate", "vsa_qkv", "vsa_gate_qkv",
        "vsa_unpermute", "attn_out_proj",
    ),
    "video_decode": ("decode_tile", "decode_blend", "decode_assemble"),
    "decode_assemble": ("decode_tile", "decode_blend"),
    "decode_tile": ("decode_embed", "decode_block", "decode_norm", "decode_fold"),
    "decode_attn": ("decode_qk", "decode_attention_core", "decode_proj_qkv", "decode_proj_attn_out"),
    "decode_ff": ("decode_proj_ff_w1", "decode_proj_ff_w2"),
    "decode_block": ("decode_attn", "decode_ff", "decode_norm", "decode_mod"),
}

# Log-spaced ms buckets for a compact per-stage histogram.
HIST_EDGES_MS = (0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0)


class _StageCollector:
    """Accumulates CUDA event pairs per stage name.

    Thread-safety: the sampler holds a process-wide GPU lock, but the decoder
    and output paths can run helper threads, so appends are guarded.
    """

    def __init__(self, max_events: int = 20000):
        self.max_events = int(max_events)
        self._pairs: dict[str, list[tuple[torch.cuda.Event, torch.cuda.Event]]] = {}
        self._calls: dict[str, int] = {}
        self._lock = threading.Lock()
        self._local = threading.local()
        self._nested: dict[str, list[dict[str, Any]]] = {}
        self._streams: set[int] = set()

    def enter(self, name, start, end, stream_id):
        stacks = getattr(self._local, 'stacks', None)
        if stacks is None:
            stacks = self._local.stacks = {}
        stack = stacks.setdefault(stream_id, [])
        frame = {'name': name, 'start': start, 'end': end, 'children': [], 'complete': False}
        if stack:
            stack[-1]['children'].append(frame)
        stack.append(frame)
        with self._lock:
            self._streams.add(stream_id)
        return frame

    def exit(self, frame, stream_id, complete):
        self._local.stacks[stream_id].pop()
        frame['complete'] = complete
        with self._lock:
            self._nested.setdefault(frame['name'], []).append(frame)

    @staticmethod
    def frame_times(frame):
        if not frame['complete']:
            return None
        try:
            total = float(frame['start'].elapsed_time(frame['end']))
            child_times = [_StageCollector.frame_times(c) for c in frame['children']]
            if any(c is None for c in child_times):
                return None
            own = total - sum(c[0] for c in child_times)
            if own < -0.001:
                return None
            return total, max(0.0, own)
        except RuntimeError:
            return None

    def note_call(self, name: str) -> bool:
        """Count one entry into *name*; return True if it should be timed."""
        with self._lock:
            self._calls[name] = self._calls.get(name, 0) + 1
            return len(self._pairs.get(name, ())) < self.max_events

    def record(self, name: str, start: torch.cuda.Event, end: torch.cuda.Event) -> None:
        with self._lock:
            self._pairs.setdefault(name, []).append((start, end))

    def collect(self) -> dict[str, dict]:
        """Synchronize once, then read every recorded pair."""
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        out: dict[str, dict] = {}
        with self._lock:
            for name, calls in sorted(self._calls.items()):
                pairs = self._pairs.get(name, [])
                durations: list[float] = []
                for start, end in pairs:
                    try:
                        durations.append(float(start.elapsed_time(end)))
                    except RuntimeError:
                        # An unrecorded event means the range raised before its
                        # exit. Drop that pair rather than reporting a lie.
                        continue
                entry: dict = {
                    "calls": calls,
                    "timed_calls": len(durations),
                    "skipped_calls": calls - len(durations),
                }
                if durations:
                    total = sum(durations)
                    entry.update(
                        total_ms=round(total, 4),
                        mean_ms=round(total / len(durations), 6),
                        max_ms=round(max(durations), 6),
                        min_ms=round(min(durations), 6),
                    )
                    entry.update(duration_stats(durations))
                    # Only extrapolate when sampling actually truncated, and
                    # label it, so a reader never mistakes it for a measurement.
                    if entry["skipped_calls"]:
                        entry["estimated_total_ms"] = round(total / len(durations) * calls, 4)
                out[name] = entry
                frames: list[dict[str, Any]] = self._nested.get(name, [])
                if frames:
                    times = [self.frame_times(f) for f in frames]
                    valid = [t for t in times if t is not None]
                    entry['exclusive_total_ms'] = sum(t[1] for t in valid)
                    entry['nesting_valid'] = len(valid) == len(pairs) == calls
                    entry['stream_count'] = len(self._streams)
                    entry['accounting'] = 'observed_nesting'
        return out


_COLLECTOR: _StageCollector | None = None


def duration_stats(durations: list[float]) -> dict:
    """Compact distribution: percentiles, stdev, histogram. No raw samples."""
    ordered = sorted(durations)
    n = len(ordered)

    def _pct(p: float) -> float:
        if n == 1:
            return round(ordered[0], 6)
        idx = min(n - 1, max(0, round((p / 100.0) * (n - 1))))
        return round(ordered[idx], 6)

    hist = [0] * (len(HIST_EDGES_MS) + 1)
    for value in durations:
        placed = False
        for i, edge in enumerate(HIST_EDGES_MS):
            if value < edge:
                hist[i] += 1
                placed = True
                break
        if not placed:
            hist[-1] += 1
    stats: dict = {
        "p50_ms": _pct(50),
        "p95_ms": _pct(95),
        "p99_ms": _pct(99),
        "hist_edges_ms": list(HIST_EDGES_MS),
        "hist_counts": hist,
    }
    if n >= 2:
        stats["stdev_ms"] = round(statistics.pstdev(durations), 6)
    return stats


def _children_of(name: str, present: set[str]) -> tuple[str, ...]:
    children = list(STAGE_PARENTS.get(name, ()))
    # vsa_core is nested in vsa_producer when both fired; don't subtract twice.
    if name == "sample" and "vsa_producer" in present:
        # Producer already includes vsa_core and attn_out_proj; subtracting
        # them again at sample would double-count the nested ranges.
        children = [c for c in children if c not in ("vsa_core", "attn_out_proj")]
    return tuple(c for c in children if c in present)


def exclusive_totals(stages: dict) -> dict[str, float]:
    """Inclusive totals minus nested children. Missing children count as 0."""

    if stages and all('exclusive_total_ms' in e for e in stages.values()):
        return {name: float(e['exclusive_total_ms']) for name, e in stages.items()}

    def _ms(entry: dict) -> float:
        value = entry.get("estimated_total_ms", entry.get("total_ms", 0.0))
        return float(value or 0.0)

    inclusive = {name: _ms(entry) for name, entry in stages.items()}
    present = set(inclusive)
    exclusive: dict[str, float] = {}
    for name, total in inclusive.items():
        child_sum = sum(inclusive.get(child, 0.0) for child in _children_of(name, present))
        exclusive[name] = round(max(0.0, total - child_sum), 4)
    return exclusive


def exclusive_leaf_sum(stages: dict) -> float:
    exclusive = exclusive_totals(stages)
    return round(sum(ms for name, ms in exclusive.items() if name not in STAGE_PARENTS), 4)


def vram_snapshot() -> dict | None:
    """Driver query at a phase boundary. Do not call inside a hot kernel loop."""
    try:
        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        return {
            "allocated_bytes": int(torch.cuda.memory_allocated()),
            "reserved_bytes": int(torch.cuda.memory_reserved()),
            "peak_allocated_bytes": int(torch.cuda.max_memory_allocated()),
            "free_bytes": int(free),
            "total_bytes": int(total),
        }
    except Exception:  # noqa: BLE001 - diagnostics are best-effort
        return None


def _cuda_ready() -> bool:
    global _CUDA_NVTX
    if _CUDA_NVTX is None:
        try:
            _CUDA_NVTX = bool(torch.cuda.is_available())
        except Exception:  # noqa: BLE001 - diagnostics are best-effort
            _CUDA_NVTX = False
    return _CUDA_NVTX


def _want_nvtx_mark(collector) -> bool:
    if collector is not None:
        return True
    return os.environ.get("FASTH3_NVTX", "") == "1"


@contextmanager
def stage_collector(*, max_events: int = 20000):
    """Activate CUDA-event capture for the duration of the block.

    Yields a callable returning the collected per-stage table. Nesting is
    rejected: two overlapping collectors would double-count shared stages.
    """
    global _COLLECTOR
    if _COLLECTOR is not None:
        raise RuntimeError("a stage collector is already active; nesting would double-count")
    collector = _StageCollector(max_events=max_events)
    _COLLECTOR = collector
    try:
        yield collector.collect
    finally:
        _COLLECTOR = None


def active() -> bool:
    return _COLLECTOR is not None


@contextmanager
def nvtx_range(name: str):
    collector = _COLLECTOR
    cuda = _cuda_ready()

    pushed = False
    if cuda and _want_nvtx_mark(collector):
        try:
            torch.cuda.nvtx.range_push(name)
            pushed = True
        except Exception:  # noqa: BLE001 - diagnostics are best-effort
            pushed = False

    start = end = None
    frame = None
    stream_id = None
    if collector is not None and cuda and collector.note_call(name):
        try:
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record()
            stream_id = int(torch.cuda.current_stream().cuda_stream)
            frame = collector.enter(name, start, end, stream_id)
        except Exception:  # noqa: BLE001 - diagnostics are best-effort
            start = end = None
    elif collector is not None and not cuda:
        # Keep call counts honest on a CPU-only host even though no GPU time
        # exists to measure.
        collector.note_call(name)

    try:
        yield
    finally:
        complete = False
        if start is not None and end is not None:
            try:
                end.record()
                if collector is not None:
                    collector.record(name, start, end)
                complete = True
            except Exception:  # noqa: BLE001,S110 - diagnostics are best-effort
                pass
        if frame is not None and collector is not None:
            collector.exit(frame, stream_id, complete)
        if pushed:
            try:
                torch.cuda.nvtx.range_pop()
            except Exception:  # noqa: BLE001,S110 - diagnostics are best-effort
                pass


__all__ = [
    "KNOWN_STAGES",
    "STAGE_PARENTS",
    "active",
    "duration_stats",
    "exclusive_leaf_sum",
    "exclusive_totals",
    "nvtx_range",
    "stage_collector",
    "vram_snapshot",
]
