"""Opt-in producer traversal/gather contracts; no native performance claim.

Stock Kitchen 0.2.34 calls its factory twice when either calibration statistic
is missing, otherwise once. Measurement QKV work is unchanged. Only an explicit
measurement traversal may omit the disposable coarse-gate projection.
"""
import ctypes
from contextlib import nullcontext
from functools import lru_cache

import torch


def _count(counters, key, amount=1):
    if counters is not None:
        counters[key] = counters.get(key, 0) + amount


class RetileScratch:
    """Request-owned, at most two stream/shape buffers; never a global pool.

    Output is borrowed until the next gather on that same stream. Producer
    projection/copy consumers must enqueue before reusing it. Distinct streams
    never share storage. Eviction/clear drops references without synchronization;
    PyTorch's allocation stream plus record_stream protect in-flight work.
    """
    def __init__(self, capacity=2):
        if capacity < 1:
            raise ValueError("retile scratch capacity must be positive")
        self.capacity = capacity
        self.buffers = {}

    def acquire(self, x, rows, stream_id, counters=None):
        key = (str(x.device), x.dtype, x.shape[1], stream_id)
        buffer = self.buffers.get(key)
        if buffer is None or buffer.shape[0] < rows:
            if key not in self.buffers and len(self.buffers) >= self.capacity:
                del self.buffers[next(iter(self.buffers))]
            buffer = x.new_empty((rows, x.shape[1]))
            self.buffers[key] = buffer
            _count(counters, "native_retile_allocations")
        else:
            _count(counters, "native_retile_reuses")
        return buffer[:rows]

    def clear(self):
        self.buffers.clear()


def _retile_rows(x, source_rows, start, count):
    if x.ndim != 2 or source_rows.ndim != 1:
        raise ValueError("masked retile requires a matrix and vector of row IDs")
    if source_rows.dtype not in (torch.int32, torch.int64) or source_rows.device != x.device:
        raise ValueError("row IDs must be int32/int64 on the activation device")
    if type(start) is not int or type(count) is not int or start < 0 or count < 1:
        raise ValueError("chunk start/count must be nonnegative/positive integers")
    if start > source_rows.numel():
        raise ValueError("chunk starts outside the row table")
    rows = min(count, source_rows.numel() - start)
    if x.shape[0] == 0 and rows:
        raise ValueError("nonempty gather requires source activations")
    return rows


@lru_cache(maxsize=4)
def _retile_function(native):
    """Additive optional ABI; existing native loader still verifies source/library hashes."""
    try:
        version = native.library.na_masked_retile_version
        fn = native.library.na_masked_retile
    except AttributeError as error:
        raise RuntimeError("native masked retile unavailable; rebuild the packaged native library") from error
    version.argtypes, version.restype = [], ctypes.c_int
    if version() != 1:
        raise RuntimeError("unsupported native masked-retile ABI")
    fn.argtypes = ([ctypes.c_void_p] * 3 + [ctypes.c_int64] * 7
                   + [ctypes.c_int] * 2 + [ctypes.c_void_p])
    fn.restype = ctypes.c_int
    return fn


def native_masked_retile(x, source_rows, start, count, *, scratch=None, counters=None):
    """One masked-load CUDA gather; opt-in, no runtime build or eager fallback.

    Bitwise copies elements, preserving live NaN payloads and signed zeros.
    Invalid positive row IDs fail closed through an asynchronous device
    assertion before launch; negative IDs are padding and never load input.
    Intended for inference, not autograd.
    """
    rows = _retile_rows(x, source_rows, start, count)
    if x.device.type != "cuda":
        raise RuntimeError("native masked retile requires CUDA; no eager fallback")
    if (x.layout != torch.strided or source_rows.layout != torch.strided
            or x.is_quantized or x.is_conj() or x.is_neg()
            or x.element_size() not in (1, 2, 4, 8, 16)):
        raise ValueError("native retile requires ordinary strided storage")
    if torch.is_grad_enabled() and x.requires_grad:
        raise ValueError("native masked retile is inference-only")
    from ..native_attention._abi import get_native_library

    fn = _retile_function(get_native_library())
    with torch.cuda.device(x.device):
        stream = torch.cuda.current_stream(x.device)
        # Validate positive IDs on the producer stream before enqueueing the
        # retile. This remains asynchronous on the valid path and prevents a
        # malformed device row table from leaving output slots unwritten.
        # The native kernel also keeps a zero-initialized defensive fallback
        # for builds with device assertions disabled.
        valid_ids = source_rows[start:start + rows]
        torch._assert_async(
            ((valid_ids < 0) | (valid_ids < x.shape[0])).all(),
            "native masked retile positive row ID out of bounds",
        )
        if scratch is None:
            output = x.new_empty((rows, x.shape[1]))
            _count(counters, "native_retile_allocations")
        else:
            output = scratch.acquire(x, rows, stream.cuda_stream, counters)
        if not output.numel():
            return output
        code = fn(x.data_ptr(), source_rows.data_ptr(), output.data_ptr(),
                  x.shape[0], x.shape[1], rows, start, source_rows.stride(0),
                  x.stride(0), x.stride(1), source_rows.element_size(), x.element_size(),
                  stream.cuda_stream)
        if code:
            raise RuntimeError(f"native masked retile launch failed (CUDA code {code})")
        x.record_stream(stream)
        source_rows.record_stream(stream)
        output.record_stream(stream)
        _count(counters, "native_retile_calls")
        _count(counters, "native_retile_output_bytes", output.numel() * output.element_size())
        # IDs stay on device; start/strides are scalar launch metadata. No sliced
        # index tensor, sentinel concat, or geometry H2D upload is performed.
        _count(counters, "native_retile_input_copy_bytes", 0)
        _count(counters, "native_retile_geometry_upload_bytes", 0)
        return output


def masked_retile_reference(x, source_rows, start, count):
    """Gather a bounded tile chunk, selecting zeros for negative padding rows.

    Native seam: input [source_rows, hidden] with arbitrary element strides;
    int32/int64 row IDs (negative = padding); start/count in padded row order;
    output [min(count, remaining_rows), hidden] in x dtype/device. A native
    kernel must mask the LOAD, not multiply a loaded NaN by zero. No full input
    copy, sentinel row, host scalar read, or alteration of live-row NaNs.

    This torch reference removes the full sentinel concat but uses an extra
    chunk-local where kernel. It is a correctness reference, not a speed claim.
    """
    _retile_rows(x, source_rows, start, count)
    rows = source_rows[start:start + count]
    if x.shape[0] == 0:
        if rows.numel():
            raise ValueError("nonempty gather requires source activations")
        return x.new_empty((0, x.shape[1]))
    selected = torch.index_select(x, 0, rows.clamp_min(0))
    return torch.where((rows >= 0).unsqueeze(1), selected, 0)


def project_chunks(*, n, chunk_size, gather, qkv, gate=None, gate_output=None,
                   mode="emit", skip_measure_gate=False, counters=None,
                   record_chunk=lambda: None, stage=lambda name: nullcontext()):
    """Explicit measure/emit producer, emitting the same projected QKV chunks."""
    if mode not in ("measure", "emit"):
        raise ValueError("producer mode must be measure or emit")
    if n < 1 or chunk_size < 1:
        raise ValueError("producer dimensions must be positive")
    if gate is not None and gate_output is None:
        raise ValueError("coarse gate projection requires an output buffer")

    def count(name):
        if counters is not None:
            counters[name] = counters.get(name, 0) + 1

    count(f"traversal_{mode}")
    for start in range(0, n, chunk_size):
        with stage("vsa_gather"):
            activations = gather(start, chunk_size)
        count("gather_chunks")
        if gate is not None and not (mode == "measure" and skip_measure_gate):
            with stage("vsa_gate"):
                values = gate(activations)
            count("gate_projections")
            with stage("vsa_qkv"):
                projected = qkv(activations)
            gate_output[start:start + activations.shape[0]] = values
            count("gate_copies")
        else:
            with stage("vsa_qkv"):
                projected = qkv(activations)
            if gate is not None:
                count("measurement_gate_skips")
        count("qkv_projections")
        record_chunk()
        yield projected


class KitchenTraversalFactory:
    """Adapt Kitchen's legacy zero-argument factory to explicit traversal modes.

    Only enable on the inspected stock Kitchen two-pass ABI. Native integrations
    should call project_chunks(mode='measure'/'emit') at their explicit seam.
    """
    def __init__(self, factory, *, bootstrap, skip_measure_gate=False):
        self.factory = factory
        self.modes = ("measure", "emit") if bootstrap else ("emit",)
        self.enabled = skip_measure_gate
        self.started = 0
        self.completed = []

    def __call__(self):
        if self.enabled and self.started >= len(self.modes):
            raise RuntimeError("unexpected Kitchen producer traversal")
        mode = self.modes[self.started] if self.enabled else "emit"
        self.started += 1

        def iterator():
            yield from self.factory(mode)
            self.completed.append(mode)
        return iterator()

    def validate_complete(self):
        if self.enabled and tuple(self.completed) != self.modes:
            raise RuntimeError("Kitchen producer did not complete measurement and gate emission")
