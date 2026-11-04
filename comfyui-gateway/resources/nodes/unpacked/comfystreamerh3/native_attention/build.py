"""Builder-only CUDA compilation. Runtime never invokes a compiler.

Install hook: load this file directly, then build(architectures=("120",)).
CLI: python native_attention/build.py --arch 120 [--output-dir DIRECTORY]

The default output is the package root so managed custom-node assembly retains
the prebuilt library and manifest after install.py completes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ABI_VERSION = 3
KITCHEN_REVISION = "e5e0d020e2add85f50466bb79171bc04ef7492b6"
LIBRARY = "libfasth3_native_attention.so"
SOURCES = (
    "native.cu", "sol_attn_producer.cu", "sol_attn_preprocess.cu",
    "sol_attn_route.cu", "sol_attn_exact.cu", "vc_group_prepare.cu", "vc_group_fine.cu",
    "output_epilogue.cu",
)


def source_hashes():
    return {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((ROOT / "csrc").iterdir()) if p.is_file()
    }


def build_command(nvcc, output, architectures=("120",)):
    architectures = tuple(str(a) for a in architectures)
    if not architectures or any(not re.fullmatch(r"(80|86|89|90|100|120)", a)
                                for a in architectures):
        raise ValueError("architectures must be explicit supported SM numbers")
    command = [str(nvcc), "-std=c++17", "-O3", "--shared", "--cudart=static",
               "-Xcompiler=-fPIC", "-Xlinker=-Bsymbolic",
               "--resource-usage", "-Xptxas=-v,-warn-spills",
               "-I", str(ROOT / "csrc")]
    for arch in dict.fromkeys(architectures):
        target = "120a" if arch == "120" else arch
        command += ["-gencode", f"arch=compute_{target},code=sm_{target}"]
    command += [str(ROOT / "csrc" / name) for name in SOURCES]
    return command + ["-o", str(output)]


def build(output_dir=None, architectures=("120",), nvcc=None):
    """Compile on the builder, atomically publish artifact and provenance report.

    Does not load CUDA, launch kernels, probe a GPU, or install dependencies.
    Missing nvcc is an error, never a request for runtime JIT compilation.
    """
    architectures = tuple(str(a) for a in architectures)
    output_dir = Path(output_dir or ROOT).resolve()
    compiler = nvcc or shutil.which("nvcc")
    if not compiler:
        raise RuntimeError("nvcc required on BUILDER; package the resulting native artifacts")
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "abi_version": ABI_VERSION, "kitchen_revision": KITCHEN_REVISION,
        "architectures": list(architectures), "source_hashes": source_hashes(),
        "compiler_architectures": ["120a" if a == "120" else a for a in architectures],
        "gpu_validated": False, "status": "building",
        "prefix_query_policy": "original-stock",
        "prefix_key_policy": "original-stock-carrier",
        "fine_policy": "int8-residual-g1-no-clustering",
        "vc_policies": ["g1_int8", "g4_int8", "g4_nvfp4"],
        "nvcc_version": subprocess.check_output([str(compiler), "--version"], text=True),
    }
    with tempfile.TemporaryDirectory(prefix="native-vc-", dir=output_dir) as temporary:
        library = Path(temporary) / LIBRARY
        command = build_command(compiler, library, architectures)
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        report.update(command=command, returncode=result.returncode,
                      compiler_output=result.stdout + result.stderr)
        if result.returncode:
            report["status"] = "failed"
            (output_dir / "build-failure.json").write_text(json.dumps(report, indent=2))
            raise RuntimeError(
                f"native VC compilation failed: {output_dir / 'build-failure.json'}\n"
                + report["compiler_output"][-16000:]
            )
        dump = shutil.which("cuobjdump")
        report["resource_report"] = None
        report["sass_file"] = None
        if dump:
            resources = subprocess.run([dump, "--dump-resource-usage", str(library)],
                                       capture_output=True, text=True, check=False)
            report["resource_report"] = resources.stdout + resources.stderr
            report["resource_returncode"] = resources.returncode
            sass = subprocess.run([dump, "--dump-sass", str(library)],
                                  capture_output=True, text=True, check=False)
            (output_dir / "kernels.sass").write_text(sass.stdout + sass.stderr)
            report["sass_file"] = "kernels.sass"
            report["sass_returncode"] = sass.returncode
        report.update(status="compiled", library=LIBRARY,
                      library_sha256=hashlib.sha256(library.read_bytes()).hexdigest())
        os.replace(library, output_dir / LIBRARY)
        staged_report = Path(temporary) / "build-report.json"
        staged_report.write_text(json.dumps(report, indent=2) + "\n")
        os.replace(staged_report, output_dir / "build-report.json")
    return output_dir / "build-report.json"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", action="append", dest="architectures")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--nvcc")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    architectures = tuple(args.architectures or ("120",))
    if args.dry_run:
        print(json.dumps(build_command(args.nvcc or "nvcc",
                                       (args.output_dir or ROOT) / LIBRARY,
                                       architectures), indent=2))
    else:
        print(build(args.output_dir, architectures, args.nvcc))
