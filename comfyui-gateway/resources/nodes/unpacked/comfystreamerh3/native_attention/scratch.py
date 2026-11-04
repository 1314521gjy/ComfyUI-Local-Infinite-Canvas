"""Bounded caller-owned scratch leases; no CUDA imports or global GPU cache.

The byte/entry limits bound retained (including leased) pool storage, not
transient overflow allocations. Factories must arrange allocator stream safety
for discarded tensors. Events must cover every use before a lease is released.
"""

from dataclasses import dataclass
from threading import RLock
from typing import Any


@dataclass(eq=False)
class _Entry:
    key: tuple
    size: int
    value: Any
    active: bool = True
    event: Any = None


class ScratchLease:
    def __init__(self, pool, entry, finish, reused):
        self._pool, self._entry, self._finish = pool, entry, finish
        self.reused = reused

    @property
    def value(self):
        if self._entry is None:
            raise RuntimeError("scratch lease is closed")
        return self._entry.value

    def close(self):
        entry, self._entry = self._entry, None
        if entry is not None:
            self._pool._release(entry, self._finish)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class ScratchPool:
    """Opt-in pool: key must contain device, stream, geometry and policy.

    Values and all aliases are borrowed until lease.close(). Never return a
    borrowed output to a consumer after close. clear() retires current leases
    too, without synchronizing or recycling in-flight storage.
    """

    def __init__(self, *, max_bytes=1024**3, max_entries=4):
        if (
            type(max_bytes) is not int
            or max_bytes < 0
            or type(max_entries) is not int
            or max_entries < 0
        ):
            raise ValueError("scratch limits must be nonnegative integers")
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self._entries: list[_Entry] = []
        self._lock = RLock()
        self._stats = {
            "allocations": 0,
            "reuses": 0,
            "releases": 0,
            "evictions": 0,
            "overflow_allocations": 0,
            "event_failures": 0,
        }

    def acquire(self, key, size, factory, finish):
        if type(size) is not int or size < 0:
            raise ValueError("scratch size must be a nonnegative integer")
        with self._lock:
            for entry in self._entries:
                if (
                    entry.key == key
                    and entry.size == size
                    and not entry.active
                    and entry.event.query()
                ):
                    # A pending event is not a license for same-stream reuse:
                    # query completion explicitly, including stream-handle reuse.
                    entry.active = True
                    entry.event = None
                    self._stats["reuses"] += 1
                    return ScratchLease(self, entry, finish, True)
            while self._entries and (
                len(self._entries) >= self.max_entries
                or sum(e.size for e in self._entries) + size > self.max_bytes
            ):
                victim = next((e for e in self._entries if not e.active and e.event.query()), None)
                if victim is None:
                    break
                self._entries.remove(victim)
                self._stats["evictions"] += 1
            entry = _Entry(key, size, factory())
            self._stats["allocations"] += 1
            if (
                len(self._entries) < self.max_entries
                and sum(e.size for e in self._entries) + size <= self.max_bytes
            ):
                self._entries.append(entry)
            else:
                self._stats["overflow_allocations"] += 1
            return ScratchLease(self, entry, finish, False)

    def _release(self, entry, finish):
        with self._lock:
            self._stats["releases"] += 1
            try:
                event = finish()
            except BaseException:  # noqa: BLE001 - cleanup must preserve the original cancellation
                # Do not mask a producer exception/cancellation with cleanup.
                self._stats["event_failures"] += 1
                self._entries = [e for e in self._entries if e is not entry]
                return
            entry.event, entry.active = event, False

    def clear(self):
        with self._lock:
            self._entries.clear()

    def diagnostics(self):
        with self._lock:
            return dict(
                self._stats,
                retained_bytes=sum(e.size for e in self._entries),
                retained_entries=len(self._entries),
                active_entries=sum(e.active for e in self._entries),
            )


class RetainedReplay:
    """Two-pass source: retain private copies within a byte cap, else replay.

    stream() is checked before each use. copy() must register allocator stream
    ownership; dropping retained values on cancellation never waits for CUDA.
    No partial retention/replay mix: overflowing discards the entire cache.
    """

    def __init__(self, factory, max_bytes, size, copy, stream):
        if not callable(factory) or type(max_bytes) is not int or max_bytes <= 0:
            raise ValueError("retention requires a factory and positive byte cap")
        self.factory, self.max_bytes = factory, max_bytes
        self.size, self.copy, self.stream = size, copy, stream
        self.owner = stream()
        self.values: list[Any] = []
        self.bytes = 0
        self.complete = False
        self.closed = False
        self.overflow = False
        self.stats = {
            "retained_bytes_peak": 0,
            "retained_chunks": 0,
            "replay_passes": 0,
            "retained_passes": 0,
            "retention_overflows": 0,
        }

    def __call__(self):
        if self.closed or self.stream() != self.owner:
            raise RuntimeError("retained operands closed or on a different stream")
        if self.complete and not self.overflow:
            self.stats["retained_passes"] += 1
            for value in self.values:
                if self.stream() != self.owner:
                    raise RuntimeError("retained operands changed stream")
                yield value
            return
        self.stats["replay_passes"] += 1
        try:
            for value in self.factory():
                if self.stream() != self.owner:
                    raise RuntimeError("projection source changed stream")
                if not self.complete and not self.overflow:
                    size = self.size(value)
                    if size < 0:
                        raise ValueError("negative operand byte size")
                    if self.bytes + size > self.max_bytes:
                        self.values.clear()
                        self.bytes = 0
                        self.overflow = True
                        self.stats["retention_overflows"] += 1
                    else:
                        self.values.append(self.copy(value))
                        self.bytes += size
                        self.stats["retained_chunks"] += 1
                        self.stats["retained_bytes_peak"] = self.bytes
                yield value
            self.complete = True
        except BaseException:
            self.close()
            raise

    def close(self):
        self.values.clear()
        self.bytes = 0
        self.closed = True
