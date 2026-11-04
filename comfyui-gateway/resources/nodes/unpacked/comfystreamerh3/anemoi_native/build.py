"""Builder-only artifact generation; never imported by the runtime adapter.

build(output_dir=None, architectures=('120',), nvcc=None) -> manifest path.
Output defaults to this package; package the binary AND build-report.json.
Requires the deployment Python/PyTorch ABI, CUDA 13.0+ and C++ compiler on builder.
Does not import/load the resulting extension or launch any GPU work.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sysconfig
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Keep the builder manifest revision identical to the runtime and extension
# identity.  A mismatch makes an otherwise valid freshly-built library fail
# closed in artifact_report() before it can be imported.
REVISION = "native-phase-output-v1"
SOURCES = (
    "bindings.cpp",
    "prepare.cu",
    "int8.cu",
    "combined.cu",
    "fp16.cu",
    "nvfp4.cu",
    "nvfp4_prepare.cu",
    "mixed.cu",
    "combined_mixed.cu",
    "combined_g4.cu",
    "combined_mixed_g4.cu",
    "phase_assign.cu",
    "output_epilogue.cu",
)


def source_hashes():
    return {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for directory in ("csrc", "vendor")
        for p in sorted((ROOT / directory).rglob("*"))
        if p.is_file()
    }


def build_command(nvcc, output, architectures=("120",)):
    if tuple(str(x) for x in architectures) != ("120",):
        raise ValueError("this artifact supports SM120 only")
    import torch
    from torch.utils.cpp_extension import include_paths, library_paths

    command = [
        str(nvcc),
        # PyTorch 2.14 headers require C++20 (torch/all.h enforces it).
        "-std=c++20",
        "-O3",
        "--shared",
        "-Xcompiler=-fPIC",
        "--expt-relaxed-constexpr",
        "--expt-extended-lambda",
        "-gencode=arch=compute_120a,code=sm_120a",
        "-Xptxas=-v,-warn-spills",
        "--resource-usage",
        "-DTORCH_EXTENSION_NAME=_anemoi_sm120",
        "-DTORCH_API_INCLUDE_EXTENSION_H",
        f"-D_GLIBCXX_USE_CXX11_ABI={int(torch._C._GLIBCXX_USE_CXX11_ABI)}",
    ]
    for path in [sysconfig.get_path("include"), *include_paths(device_type="cuda")]:
        command += ["-I", str(path)]
    command += [str(ROOT / "csrc" / name) for name in SOURCES]
    for path in library_paths(device_type="cuda"):
        command += ["-L", str(path)]
    # torch is imported before extension loading and preloads its libraries.
    # Never encode a relocatable builder venv as the runtime search location.
    command += ["-Xlinker=-rpath,$ORIGIN"]
    command += [
        "-ltorch_python",
        "-ltorch",
        "-ltorch_cpu",
        "-lc10",
        "-ltorch_cuda",
        "-lc10_cuda",
        "-lcudart",
        "-o",
        str(output),
    ]
    return command


def build(output_dir=None, architectures=("120",), nvcc=None):
    output_dir = Path(output_dir or ROOT).resolve()
    compiler = nvcc or shutil.which("nvcc")
    if compiler is None:
        raise RuntimeError("nvcc required on builder; runtime cannot compile")
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = sysconfig.get_config_var("EXT_SUFFIX") or ".so"
    binary = "_anemoi_sm120" + suffix
    report = {
        "abi_version": 4,
        "source_revision": REVISION,
        "architectures": list(architectures),
        "source_hashes": source_hashes(),
        "gpu_validated": False,
        "library": binary,
        "nvcc_version": subprocess.check_output([compiler, "--version"], text=True),
    }
    import torch

    report["torch_abi"] = {
        "version": str(torch.__version__),
        "cuda": torch.version.cuda,
        "cxx11": int(torch._C._GLIBCXX_USE_CXX11_ABI),
    }
    with tempfile.TemporaryDirectory(prefix="anemoi-build-", dir=output_dir) as tmp:
        artifact = Path(tmp) / binary
        command = build_command(compiler, artifact, architectures)
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        report.update(
            command=command,
            returncode=result.returncode,
            compiler_output=result.stdout + result.stderr,
        )
        if result.returncode:
            report["status"] = "failed"
            (output_dir / "build-failure.json").write_text(json.dumps(report, indent=2) + "\n")
            raise RuntimeError(
                f"Anemoi builder failed: {output_dir / 'build-failure.json'}\n"
                + report["compiler_output"][-16000:]
            )
        dump = shutil.which("cuobjdump")
        report["resource_report"] = None
        if dump:
            for flag, name in (
                ("--dump-resource-usage", "resources.txt"),
                ("--dump-sass", "kernels.sass"),
            ):
                result = subprocess.run(
                    [dump, flag, str(artifact)], capture_output=True, text=True, check=False
                )
                (output_dir / name).write_text(result.stdout + result.stderr)
                report[name] = {"returncode": result.returncode, "file": name}
        report.update(
            status="compiled", library_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest()
        )
        os.replace(artifact, output_dir / binary)
        manifest = Path(tmp) / "build-report.json"
        manifest.write_text(json.dumps(report, indent=2) + "\n")
        os.replace(manifest, output_dir / manifest.name)
    return output_dir / "build-report.json"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--arch", action="append")
    parser.add_argument("--nvcc")
    args = parser.parse_args()
    print(build(args.output_dir, tuple(args.arch or ("120",)), args.nvcc))
