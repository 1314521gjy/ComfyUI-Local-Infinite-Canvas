"""Fail-closed identity checks for install-time native artifacts."""

import hashlib
import json
import sysconfig
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def artifact_report(root=None):
    root = Path(root) if root is not None else Path(__file__).resolve().parent
    try:
        report = json.loads((root / "build-report.json").read_text())
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            "Native Anemoi artifact manifest missing/invalid; install on CUDA builder; "
            "runtime compilation and reference fallback are disabled"
        ) from exc
    if (
        report.get("abi_version") != 4
        or report.get("status") != "compiled"
            or report.get("source_revision") != "native-phase-output-v1"
        or report.get("architectures") != ["120"]
    ):
        raise RuntimeError("Native Anemoi manifest ABI/revision/architecture mismatch")
    library = report.get("library", "")
    expected_library = "_anemoi_sm120" + (sysconfig.get_config_var("EXT_SUFFIX") or ".so")
    if library != expected_library:
        raise RuntimeError("Native Anemoi binary Python ABI/name mismatch")
    sources = report.get("source_hashes", {})
    current = {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for d in ("csrc", "vendor")
        for p in sorted((root / d).rglob("*"))
        if p.is_file()
    }
    if not current or sources != current:
        raise RuntimeError("Native Anemoi source hashes differ from compiled artifact; rebuild")
    try:
        digest = hashlib.sha256((root / library).read_bytes()).hexdigest()
    except OSError as exc:
        raise RuntimeError("Native Anemoi packaged binary missing; rebuild on builder") from exc
    if digest != report.get("library_sha256"):
        raise RuntimeError("Native Anemoi binary hash mismatch; rebuild")
    import torch

    abi = report.get("torch_abi", {})
    if abi != {
        "version": str(torch.__version__),
        "cuda": torch.version.cuda,
        "cxx11": int(torch._C._GLIBCXX_USE_CXX11_ABI),
    }:
        raise RuntimeError("Native Anemoi PyTorch/CUDA/C++ ABI differs from builder")
    return report
