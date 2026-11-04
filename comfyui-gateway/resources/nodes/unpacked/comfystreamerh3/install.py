"""Compile isolated native attention artifacts during managed-image assembly.

The runtime consumes these binaries and never requires nvcc or a host compiler.
Non-Linux developer checkouts retain CPU-reference imports without compilation.
"""
import importlib.metadata
import importlib.util
import json
import platform
import subprocess
import sys
from pathlib import Path

if __package__:
    from .kitchen_baseline import KITCHEN_VERSION, KITCHEN_WHEEL_SHA256, KITCHEN_WHEEL_URL
else:
    from kitchen_baseline import (  # type: ignore[import-not-found, no-redef]
        KITCHEN_VERSION,
        KITCHEN_WHEEL_SHA256,
        KITCHEN_WHEEL_URL,
    )


def _installed_kitchen_wheel_hash() -> str | None:
    distribution = importlib.metadata.distribution("comfy-kitchen")
    if distribution.version != KITCHEN_VERSION:
        return None
    direct_url = distribution.read_text("direct_url.json")
    if direct_url is None:
        return None
    try:
        metadata = json.loads(direct_url)
        return metadata["archive_info"]["hashes"]["sha256"]
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError):
        return None


def ensure_locked_kitchen_wheel() -> None:
    """Reinstall the exact wheel when the base image hides its provenance."""
    if _installed_kitchen_wheel_hash() == KITCHEN_WHEEL_SHA256:
        return
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--force-reinstall",
            "--no-deps",
            "--no-cache-dir",
            "--require-hashes",
            KITCHEN_WHEEL_URL,
        ],
        check=True,
    )
    installed_hash = _installed_kitchen_wheel_hash()
    if installed_hash != KITCHEN_WHEEL_SHA256:
        raise RuntimeError(
            "FastH3 build did not install the locked comfy-kitchen wheel with verifiable provenance"
        )


def main():
    if platform.system() != "Linux":
        print("FastH3 native CUDA build skipped on non-Linux development host")
        return
    ensure_locked_kitchen_wheel()
    root = Path(__file__).resolve().parent
    for package in ("native_attention", "anemoi_native"):
        path = root / package / "build.py"
        spec = importlib.util.spec_from_file_location(f"fasth3_build_{package}", path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"missing native builder: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        manifest = module.build(architectures=("120",))
        print(f"FastH3 {package} build manifest: {manifest}")


if __name__ == "__main__":
    main()
