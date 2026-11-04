"""Versioned ctypes ABI and artifact validation; safe to import without torch/CUDA."""
from __future__ import annotations

import ctypes as C
import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

from .build import ABI_VERSION, KITCHEN_REVISION, LIBRARY, ROOT, source_hashes

PLAN_NAMES = (
    "Tp", "NTB", "NPAD", "NQ", "qiP", "qs", "kiP", "ksb", "vTi", "vsc", "kciP",
    "kcs", "vcT", "thr", "cen8", "cens", "idx", "cnt", "oPart", "mPart", "lPart",
    "statsV", "qmean", "rTi", "rmean", "rscale", "scratch", "total",
)
P, I, F = C.c_void_p, C.c_int, C.c_float
SIGNATURES = {
    "na_plan": [I, I, C.POINTER(C.c_int64), I],
    "na_begin": [P, I, I, P],
    "na_chunk": [P] * 11 + [F] + [I] * 6 + [P],
    "na_route": [P] * 6 + [I] * 2 + [F] * 2 + [I] * 5 + [P],
    "na_route_export": [P] * 9 + [I] * 2 + [F] * 2 + [I] * 5 + [P],
    "na_route_export_prefix": [P] * 10 + [I] * 2 + [F] * 2 + [I] * 5 + [P],
    "na_fine": [P] * 2 + [I] * 2 + [F] + [I] * 5 + [P],
    "na_resources": [C.POINTER(C.c_int64), I],
    "na_original_scores": [P, P, I, I, F, P],
    "na_group_chunk": [P] * 12 + [I] * 9 + [P],
    "na_group_fine": [P] * 9 + [I] * 2 + [F] + [I] * 5 + [P],
    "na_group_resources": [C.POINTER(C.c_int64), I],
}
OPTIONAL_SIGNATURES = {
    "na_route_emit": SIGNATURES["na_route_export"],
    "na_route_emit_resources": [C.POINTER(C.c_int64), I],
    "na_output_epilogue": [P, P, P, P, I, I, I, I, P],
}


def artifact_report(directory=None):
    directory = Path(directory or os.environ.get("FASTH3_NATIVE_ATTENTION_DIR", ROOT))
    try:
        report = json.loads((directory / "build-report.json").read_text())
        library = directory / LIBRARY
        if (report["abi_version"] != ABI_VERSION or report["kitchen_revision"] != KITCHEN_REVISION
                or report["status"] != "compiled"):
            raise ValueError("incompatible native build manifest")
        if report["source_hashes"] != source_hashes():
            raise ValueError("packaged CUDA source differs from compiled source")
        if hashlib.sha256(library.read_bytes()).hexdigest() != report["library_sha256"]:
            raise ValueError("native library hash mismatch")
    except (OSError, KeyError, ValueError) as exc:
        raise RuntimeError(
            f"native VC artifact unavailable/invalid at {directory}; build and package it "
            "on the CUDA builder using native_attention/build.py; runtime compilation is disabled"
        ) from exc
    return library, report


class NativeLibrary:
    def __init__(self, directory=None):
        path, self.report = artifact_report(directory)
        self._device_resources = {}
        self.library = C.CDLL(str(path), mode=C.RTLD_LOCAL)
        self.library.na_error.argtypes = []
        self.library.na_error.restype = C.c_char_p
        self.library.na_abi_version.argtypes = []
        self.library.na_abi_version.restype = I
        if self.library.na_abi_version() != ABI_VERSION:
            raise RuntimeError("native attention ABI version mismatch")
        for name, args in SIGNATURES.items():
            fn = getattr(self.library, name)
            fn.argtypes, fn.restype = args, I
        for name, args in OPTIONAL_SIGNATURES.items():
            fn = getattr(self.library, name, None)
            if fn is not None:
                fn.argtypes, fn.restype = args, I

    def route_emission_resources(self, device_index):
        """Fail closed for old artifacts; cache actual emitted-kernel attributes."""
        # Route-emission resource queries only require the route-emission ABI.
        # Other optional entry points (for example the OMEGA output epilogue)
        # are independent capabilities and must not make this query fail on a
        # test double or an artifact that predates that unrelated entry point.
        if any(not hasattr(self.library, name)
               for name in ("na_route_emit", "na_route_emit_resources")):
            raise RuntimeError("native artifact lacks optional route emission; rebuild required")
        key = (device_index, "route_emit")
        if key not in self._device_resources:
            values = (C.c_int64 * 6)()
            self.call("na_route_emit_resources", values, len(values))
            self._device_resources[key] = dict(zip(
                ("shared_bytes", "registers", "local_bytes", "max_threads",
                 "binary_version", "device_shared_limit"), values))
        return dict(self._device_resources[key])

    def call(self, name, *args):
        if getattr(self.library, name)(*args):
            raise RuntimeError(self.library.na_error().decode("utf-8", errors="replace"))

    def _plan_values(self, t, h):
        values = (C.c_int64 * len(PLAN_NAMES))()
        self.call("na_plan", t, h, values, len(values))
        return tuple(values)

    def plan(self, t, h, *, reuse=False):
        """Optional bounded host-only geometry reuse, isolated to this library.

        Return a fresh dict so existing callers cannot poison cached offsets.
        No CUDA operations or device-dependent values occur inside na_plan.
        """
        if reuse:
            if type(t) is not int or type(h) is not int or t <= 0 or h <= 0:
                raise ValueError("geometry cache requires positive integral T/H")
            if not hasattr(self, "_cached_plan"):
                self._cached_plan = lru_cache(maxsize=128)(self._plan_values)
            values = self._cached_plan(t, h)
        else:
            values = self._plan_values(t, h)
        return dict(zip(PLAN_NAMES, values))

    def plan_cache_info(self):
        cache = getattr(self, "_cached_plan", None)
        return cache.cache_info()._asdict() if cache else {"hits": 0, "misses": 0,
                                                           "maxsize": 128, "currsize": 0}

    def check_resources(self, device_index, *, grouped=False):
        """Query cubin attributes and device limits before any kernel launch."""
        key = (device_index, grouped)
        if key in self._device_resources:
            return self._device_resources[key]
        values = (C.c_int64 * 18)()
        self.call("na_group_resources" if grouped else "na_resources", values, len(values))
        names = ("shared_bytes", "registers", "local_bytes", "max_threads",
                 "binary_version", "device_shared_limit")
        resources = {
            kernel: dict(zip(names, values[i*6:(i+1)*6]))
            for i, kernel in enumerate(
                ("group_prepare", "group_int8", "group_nvfp4") if grouped
                else ("producer", "route", "fine"))
        }
        self._device_resources[key] = resources
        return resources


@lru_cache(maxsize=4)
def _validated_library(directory):
    return NativeLibrary(directory)


def get_native_library(directory=None):
    """Immutable artifact-directory identity; no filesystem reads on cache hits.

    Change to a new versioned directory to load a different artifact. Replacing
    a loaded .so at the same path requires process restart (dlopen may reuse it).
    """
    directory = directory or os.environ.get("FASTH3_NATIVE_ATTENTION_DIR", ROOT)
    return _validated_library(os.path.abspath(os.fspath(directory)))


def clear_validation_cache():
    """Explicit provenance revalidation; never promises to unload a live .so."""
    _validated_library.cache_clear()


def ptr(tensor):
    return None if tensor is None else tensor.data_ptr()
