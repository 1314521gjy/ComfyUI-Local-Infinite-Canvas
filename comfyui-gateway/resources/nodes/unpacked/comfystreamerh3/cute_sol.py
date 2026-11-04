"""Optional NVIDIA CuTe Sol-Attn bridge for native H3 attention.

The pinned Sol-Attn source owns routing and the CUDA kernel. This module
performs only the one-time capability check and the layout bridge from
ComfyUI's BHND attention contract to the package's contiguous BTHD contract;
there are no Python loops over tokens, heads, or blocks.
"""

from __future__ import annotations

import hashlib
import importlib.util
import inspect
import sys
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Any

_VENDOR = Path(__file__).parent / "third_party" / "sol_attn"
_IMPORT_LOCK = RLock()


@dataclass(frozen=True)
class CuteSolCapability:
    available: bool
    backend: str | None
    architecture: str | None
    reason: str | None = None


@lru_cache(maxsize=1)
def _sol_attn_module():
    # Upstream uses absolute sol_attn.* imports. Never mix two source trees.
    with _IMPORT_LOCK:
        for name, module in tuple(sys.modules.items()):
            if name == "sol_attn" or name.startswith("sol_attn."):
                path = getattr(module, "__file__", None)
                if path is None or not Path(path).resolve().is_relative_to(_VENDOR.resolve()):
                    raise ImportError(
                        f"foreign {name} already loaded; restart with vendored Sol-Attn"
                    )
        if "sol_attn" in sys.modules:
            return sys.modules["sol_attn"]
        spec = importlib.util.spec_from_file_location(
            "sol_attn",
            _VENDOR / "__init__.py",
            submodule_search_locations=[str(_VENDOR)],
        )
        if spec is None or spec.loader is None:
            raise ImportError("vendored Sol-Attn source is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules["sol_attn"] = module
        before = set(sys.modules) - {"sol_attn"}
        try:
            spec.loader.exec_module(module)
        except BaseException:
            for name in set(sys.modules) - before:
                if name == "sol_attn" or name.startswith("sol_attn."):
                    sys.modules.pop(name, None)
            raise
        return module


def runtime_identity() -> str:
    """Attest the actual vendored Python source, not an installed namesake."""
    root = Path(inspect.getfile(_sol_attn_module())).resolve().parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _arch_name(arch: tuple[int, int]) -> str:
    return f"sm_{arch[0]}{arch[1]}"


@lru_cache(maxsize=8)
def probe(device: Any = None) -> CuteSolCapability:
    """Probe the external kernel without allocating model tensors."""
    try:
        import torch
    except ImportError as error:  # pragma: no cover - deployment-only path
        return CuteSolCapability(False, None, None, f"torch unavailable: {error}")
    if not torch.cuda.is_available():
        return CuteSolCapability(False, None, None, "CUDA unavailable")
    try:
        sol_attn = _sol_attn_module()
    except ImportError as error:  # pragma: no cover - deployment-only path
        return CuteSolCapability(
            False,
            None,
            None,
            str(error),
        )
    arch = tuple(torch.cuda.get_device_capability(device))
    if len(arch) != 2:
        return CuteSolCapability(False, None, None, f"unexpected CUDA capability: {arch!r}")
    arch = (arch[0], arch[1])
    architecture = _arch_name(arch)
    try:
        backend = sol_attn.get_sol_attn_backend(device)
    except Exception as error:  # noqa: BLE001 - capability probe must report external failures
        return CuteSolCapability(False, None, architecture, str(error))
    if backend != "cute_sm120":
        return CuteSolCapability(
            False,
            str(backend),
            architecture,
            f"CuTe Sol requires sm_120; resolver selected {backend!r}",
        )
    return CuteSolCapability(True, str(backend), architecture)


def require(device: Any = None) -> CuteSolCapability:
    capability = probe(device)
    if not capability.available:
        raise RuntimeError(f"CuTe Sol unavailable: {capability.reason}")
    return capability


def prepare_layout(
    q, k, v, *, layout: str | None = None, heads: int | None = None, diagnostics: dict | None = None
):
    """Return contiguous BTHD operands; legacy heads-only calls must be unambiguous.

    This operation is device-independent for testing and isolated measurement.
    copy_bytes counts destination bytes, not combined read/write traffic.
    """
    if q.ndim != 4 or q.shape != k.shape or q.shape != v.shape:
        raise ValueError("CuTe Sol expects matching 4-D q/k/v tensors")
    if layout is None:
        matches = [
            name
            for name, axis in (("BHND", 1), ("BTHD", 2))
            if heads is not None and q.shape[axis] == heads
        ]
        if len(matches) != 1:
            raise ValueError("pass explicit layout='BHND' or 'BTHD'; ambiguous legacy heads")
        layout = matches[0]
    if layout not in ("BHND", "BTHD"):
        raise ValueError("unsupported layout; expected BHND or BTHD")
    axis = 1 if layout == "BHND" else 2
    if heads is not None and q.shape[axis] != heads:
        raise ValueError("heads does not match explicit layout")
    if q.shape[-1] != 128 or any(size <= 0 for size in q.shape):
        raise ValueError("CuTe Sol requires nonempty operands with head dimension 128")
    operands = tuple(x.transpose(1, 2) if layout == "BHND" else x for x in (q, k, v))
    if diagnostics is not None:
        copies = [x for x in operands if not x.is_contiguous()]
        diagnostics["layout_calls"] = diagnostics.get("layout_calls", 0) + 1
        diagnostics["layout_copies"] = diagnostics.get("layout_copies", 0) + len(copies)
        diagnostics["layout_copy_bytes"] = diagnostics.get("layout_copy_bytes", 0) + sum(
            x.numel() * x.element_size() for x in copies
        )
        diagnostics["input_layout"] = layout
    return tuple(x.contiguous() for x in operands)


def _execute(q, k, v, *, tau, scale, sink_blocks, diagnostics=None):
    module = _sol_attn_module()
    start, stop = sink_blocks
    if not isinstance(start, int) or not isinstance(stop, int) or not 0 <= start <= stop:
        raise ValueError("invalid sink block interval")
    tokens = q.shape[1]
    if stop > (tokens + 63) // 64:
        raise ValueError("sink block interval exceeds sequence")
    sink_start = min(start * 64, tokens)
    sink_tokens = min(stop * 64, tokens) - sink_start
    cache = module.interface._compiled
    key = (q.device.index, (12, 0), q.shape[0], tokens, q.shape[2], 1)
    hit = key in cache
    kwargs = {
        "tau": float(tau),
        "thresh_type": "diag",
        "kv_splits": 1,
        "sink_start": sink_start,
        "sink_tokens": sink_tokens,
        "scale": scale,
    }
    if diagnostics is not None:
        kwargs["diagnostics"] = diagnostics
    output = module.sol_attn(q, k, v, **kwargs)
    if diagnostics is not None:
        for name, increment in (
            ("kernel_calls", 1),
            ("compile_cache_hits", int(hit)),
            ("compile_cache_misses", int(not hit)),
            ("compiled_entries_added", int(not hit and key in cache)),
        ):
            diagnostics[name] = diagnostics.get(name, 0) + increment
    return output


def attention(
    q,
    k,
    v,
    *,
    tau: float,
    scale: float | None,
    sink_blocks: tuple[int, int],
    heads: int | None = None,
    capability: CuteSolCapability | None = None,
    layout: str | None = None,
    diagnostics: dict | None = None,
):
    """Run one external CuTe Sol kernel call for BHND tensors.

    ComfyUI supplies ``[B,H,N,D]`` when ``skip_reshape`` is true.  The
    external kernel consumes contiguous ``[B,N,H,D]``.  The transposes are
    one layout conversion per operand; all routing, reductions, and attention
    arithmetic remain inside the external CUDA implementation.
    """
    import torch

    if not all(isinstance(value, torch.Tensor) for value in (q, k, v)):
        raise TypeError("CuTe Sol expects tensor q/k/v")
    if q.ndim != 4 or q.shape != k.shape or q.shape != v.shape:
        raise ValueError("CuTe Sol expects matching 4-D q/k/v tensors")
    if (
        any(x.dtype != torch.bfloat16 or x.device != q.device for x in (q, k, v))
        or q.device.type != "cuda"
    ):
        raise TypeError("CuTe Sol requires CUDA BF16 q/k/v")
    if capability is None:
        capability = require(q.device)
    if not capability.available or capability.backend != "cute_sm120":
        raise RuntimeError("CuTe SM120 capability is required")
    operands = prepare_layout(q, k, v, layout=layout, heads=heads, diagnostics=diagnostics)
    return _execute(
        *operands, tau=tau, scale=scale, sink_blocks=sink_blocks, diagnostics=diagnostics
    )


def benchmark_operations(
    q, k, v, *, layout, heads=None, tau=1.3, scale=None, sink_blocks=(0, 0), repetitions=3
):
    """Measure first-call and warm layout/kernel scopes on CUDA, without cache eviction.

    Kernel timing INCLUDES upstream preprocessing. First-call wall time captures
    JIT when the cache is cold; cache counters state whether it actually was cold.
    Output checks are outside measured scopes. No jobs or model loads occur.
    """
    import torch

    if not isinstance(repetitions, int) or repetitions < 1:
        raise ValueError("repetitions must be a positive integer")
    require(q.device)
    if (
        any(x.dtype != torch.bfloat16 or x.device != q.device for x in (q, k, v))
        or q.device.type != "cuda"
    ):
        raise TypeError("benchmark requires CUDA BF16 operands on one device")
    records = []
    reference = None
    with torch.cuda.device(q.device), torch.inference_mode():
        for index in range(repetitions + 1):
            counters: dict[str, Any] = {}

            def measure(fn):
                torch.cuda.synchronize(q.device)
                begin, end = (
                    torch.cuda.Event(enable_timing=True),
                    torch.cuda.Event(enable_timing=True),
                )
                started = time.perf_counter()
                begin.record()
                result = fn()
                end.record()
                end.synchronize()
                return result, {
                    "wall_ms": (time.perf_counter() - started) * 1000,
                    "cuda_event_ms": begin.elapsed_time(end),
                }

            operands, layout_time = measure(
                lambda counters=counters: prepare_layout(
                    q, k, v, layout=layout, heads=heads, diagnostics=counters
                )
            )
            output, kernel_time = measure(
                lambda operands=operands, counters=counters: _execute(
                    *operands, tau=tau, scale=scale, sink_blocks=sink_blocks, diagnostics=counters
                )
            )
            if (
                output.shape != operands[0].shape
                or output.dtype != q.dtype
                or output.device != q.device
            ):
                raise RuntimeError("CuTe output contract mismatch")
            if not bool(torch.isfinite(output).all()):
                raise RuntimeError("CuTe output contains nonfinite values")
            if reference is None:
                reference = output.clone()
            else:
                torch.testing.assert_close(output, reference, rtol=0.02, atol=0.02)
            records.append(
                {
                    "phase": "first_call" if index == 0 else "warm",
                    "layout": layout_time,
                    "kernel_including_preprocess": kernel_time,
                    "counters": counters,
                }
            )
    return {
        "source_sha256": runtime_identity(),
        "source_path": str(_VENDOR.resolve()),
        "runs": records,
        "output_checks": "shape/dtype/device/finite/repeatability",
        "quality_certified": False,
    }


__all__ = [
    "CuteSolCapability",
    "attention",
    "benchmark_operations",
    "prepare_layout",
    "probe",
    "require",
    "runtime_identity",
]
