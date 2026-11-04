"""Provide Triton's host C compiler on minimal managed Linux runtimes."""
import os
import shlex
import shutil
import sysconfig
import tempfile
from pathlib import Path

_shim = None


def ensure_triton_compiler():
    global _shim
    existing = os.environ.get("CC") or shutil.which("gcc") or shutil.which("clang")
    if existing:
        return existing
    if _shim is not None:
        os.environ["CC"] = _shim
        return _shim
    import ziglang
    executable = Path(ziglang.__file__).parent / "zig"
    if not executable.is_file():
        raise RuntimeError("Pinned Zig C compiler executable is missing")
    include = Path(sysconfig.get_path("include")) / "Python.h"
    if not include.is_file():
        raise RuntimeError(f"Triton needs Python development headers: {include}")
    # Triton treats CC as one executable, so 'zig cc' cannot be supplied as
    # a space-separated CC value. Keep a private executable shim for this worker.
    folder = Path(tempfile.mkdtemp(prefix="fasth3-cc-"))
    wrapper = folder / "cc"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.quote(str(executable)) + ' cc "$@"\n')
    wrapper.chmod(0o700)
    _shim = str(wrapper)
    os.environ["CC"] = _shim
    return _shim
