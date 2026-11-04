"""Shared report, timing and publication helpers for benchmark stages."""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, cast

fcntl: Any
try:
    fcntl = importlib.import_module("fcntl")
except ImportError:  # pragma: no cover - Windows workers do not use shared manifests
    fcntl = None

_GPU_LOCK = threading.Lock()
logger = logging.getLogger(__name__)
_REPORT_FIELDS = [
    "schema_version", "run_id", "run_nonce", "job_id", "status", "failure_stage", "error",
    "preset_id", "preset_hash", "execution_profile_id", "execution_profile_hash",
    "model_family", "sampling_contract", "attention_status", "dmad_noise_stream",
    "gate_compress",
    "memory_feature_calls", "memory_counter_mode", "memory_boundaries", "mechanism_metrics",
    "dmad_comfy_manifest_sha256", "audio_latent_frames", "audio_target_sample_rate",
    "model_variant", "lora_strength", "pdmd_lora", "transformer_compile",
    "kitchen_vae_fusions",
    "release_id", "build_id", "deployment_id", "workflow_hash",
    "prompt_hash", "seed", "image_hash_or_null", "model_hashes", "precision_map_hash",
    "conversion_manifest_hash_or_null", "gpu_name", "gpu_capability", "driver", "torch",
    "cuda", "comfy", "kitchen", "kernel_versions", "width", "height", "internal_width",
    "internal_height", "frames", "fps", "audio_enabled", "sampler", "sigma_positions",
    "actual_nfe", "actual_sparse_calls", "fallback_calls", "cache_policy",
    "conditioning_cache_hit", "timings_ms", "timing_clock", "peak_vram_bytes",
    "vram_snapshots", "euler_step_ms", "dispatch", "run_knobs", "output_paths",
    "output_hashes", "output_probe", "cleanup_status", "cleanup_errors", "profile",
    "execution_profile_id", "execution_profile_hash", "config_hash", "source_hash",
    "binary_hash", "model_hash", "workload_hash",
    "source_fingerprint", "binary_fingerprint", "vc_e2e_config_hash",
]


def _provenance_digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(_json_safe(value), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def _annotate_workload_provenance(report: dict[str, Any]) -> None:
    """Hash the observed workload contract without claiming model-weight identity."""
    fields = (
        "width", "height", "internal_width", "internal_height", "frames", "fps",
        "seed", "sampler", "sigma_positions", "actual_nfe", "audio_enabled",
    )
    workload = {key: report.get(key) for key in fields}
    workload["run_knobs"] = report.get("run_knobs") or {}
    report["workload_digest"] = _provenance_digest(workload)
    report["workload_hash"] = report["workload_digest"]
    checkpoint = report.get("vae_checkpoint")
    if isinstance(checkpoint, dict) and checkpoint.get("sha256"):
        report["vae_weights_digest"] = checkpoint["sha256"]
    # This remains null until all model files, not just the VAE, are bound to
    # a manifest. Evaluation must treat that absence as evidence missing.
    report.setdefault("weights_digest", None)


def _storage_identity(value: Any) -> dict[str, Any] | None:
    """Record tensor storage identity at graph boundaries, not Python owners."""
    try:
        import torch
        if not isinstance(value, torch.Tensor):
            return None
        storage = value.untyped_storage()
        return {
            "shape": list(value.shape), "stride": list(value.stride()),
            "dtype": str(value.dtype), "device": str(value.device),
            "storage_ptr": int(storage.data_ptr()), "storage_bytes": int(storage.nbytes()),
            "tensor_bytes": int(value.numel() * value.element_size()),
            "storage_offset": int(value.storage_offset()),
        }
    except (AttributeError, RuntimeError):
        return None


def _record_storage(report: dict[str, Any], name: str, value: Any) -> None:
    identity = _storage_identity(value)
    if identity is not None:
        report.setdefault("storage_boundaries", {})[name] = identity




def _blank_report(*, run_nonce: str, seed: int, profile: Any) -> dict[str, Any]:
    report: dict[str, Any] = {key: None for key in _REPORT_FIELDS}
    report.update(
        run_id=str(uuid.uuid4()),
        schema_version="fasth3-benchmark/1",
        run_nonce=run_nonce,
        job_id=None,
        status="CREATED",
        failure_stage=None,
        error=None,
        seed=seed,
        timing_clock={"monotonic": "perf_counter", "wall": "time"},
        timings_ms={},
        output_paths=[],
        output_hashes={},
        vram_snapshots={},
        cleanup_status="pending",
        cleanup_errors=[],
        profile={},
    )
    if isinstance(profile, dict):
        # Copy only schema fields: profiles may contain tensors or runtime objects.
        for key in ("preset_id", "preset_hash", "execution_profile_id",
                    "execution_profile_hash", "model_variant", "lora_strength", "pdmd_lora",
                    "release_id", "build_id", "deployment_id", "model_family",
                    "sampling_contract", "attention_mode", "attention_status", "precision_mode",
                    "gate_compress", "transformer_compile",
                    "width", "height", "internal_width", "internal_height", "frames", "fps",
                    "audio_enabled", "sigma_positions", "cache_policy", "vsa",
                    "kitchen_version", "checkpoint", "attention_option", "kitchen_baseline",
                    "token_aug", "vae_precision_policy", "attention_policy", "model_cache",
                    "omega_config", "dmad_comfy_manifest_sha256",
                    "audio_latent_frames",
                    "audio_target_sample_rate", "base_model_id", "base_revision",
                    "memory_flags", "memory_optimizations_diagnostic_only", "kitchen_vae_fusions",
                    "omega_flags", "producer_skip_bootstrap_gate"):
            if key in profile:
                report[key] = _json_safe(profile[key])
        execution_profile = profile.get("execution_profile")
        if isinstance(execution_profile, dict):
            report["execution_profile_id"] = execution_profile.get("profile_id")
            report["execution_profile_hash"] = execution_profile.get("profile_hash")
            report["execution_profile"] = _json_safe(execution_profile)
        if "attention_candidate_runtime" in profile:
            report["attention_candidate_runtime"] = _json_safe(
                profile["attention_candidate_runtime"]
            )
        report["runtime"] = _json_safe(profile.get("runtime", {}))
        report["precision_report"] = _json_safe(profile.get("precision_report", {}))
        report["vc_e2e_config_hash"] = profile.get("vc_e2e_config_hash") or None
        if report["vc_e2e_config_hash"]:
            report["config_hash"] = report["vc_e2e_config_hash"]
        try:
            from .build_identity import node_binary_fingerprint, node_source_fingerprint
        except ImportError:  # pragma: no cover
            from build_identity import (  # type: ignore[import-not-found, no-redef]
                node_binary_fingerprint,
                node_source_fingerprint,
            )
        report["source_fingerprint"] = node_source_fingerprint()
        report["binary_fingerprint"] = node_binary_fingerprint()
        report["source_hash"] = report["source_fingerprint"]
        # Missing native artifact identity is unknown evidence, never a source
        # hash match that could pass promotion checks.
        report["binary_hash"] = report["binary_fingerprint"]
        model_manifest = profile.get("model_manifest")
        if isinstance(model_manifest, dict) and model_manifest:
            from .model_provenance import model_manifest_digest
            report["model_hashes"] = dict(model_manifest)
            report["model_hash"] = model_manifest_digest(model_manifest)
            report["weights_digest"] = report["model_hash"]
            report["model_identity_scope"] = "resolved FastH3 asset file contents"
        report["cache_policy"] = "per_request"
        knobs = {}
        for key in ("fp4_kernel", "preset_id", "chunk_size", "vsa", "attention_option", "kitchen_version",
                    "model_variant", "lora_strength", "pdmd_lora", "transformer_compile",
                    "omega_config", "omega_flags", "producer_skip_bootstrap_gate"):
            if key in profile:
                knobs[key] = _json_safe(profile[key])
        runtime = profile.get("runtime")
        if isinstance(runtime, dict):
            knobs["runtime"] = _json_safe(runtime)
            report["environment_digest"] = runtime.get("environment_digest")
        if knobs:
            report["run_knobs"] = knobs
    return report


def _stats(reset: bool = False) -> dict[str, Any]:
    """Read the optional VSA counters without making offline imports fragile."""
    try:
        from . import sol_attn_minimax_v5 as sparse
        if reset:
            sparse.reset_sol_attn_stats()
            return {}
        return sparse.sol_attn_stats()
    except (ImportError, AttributeError):
        return {}


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if all(hasattr(value, name) for name in ("shape", "dtype", "device", "numel")):
        try:
            return {
                "tensor": True,
                "shape": list(value.shape),
                "dtype": str(value.dtype),
                "device": str(value.device),
                "numel": int(value.numel()),
            }
        except Exception:  # noqa: BLE001 - failure reporting must not mask the original error
            return {"tensor": True, "repr": "<uninspectable tensor>"}
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_safe(v) for v in value]
    return str(value)


def serialize_report(report: dict[str, Any]) -> dict[str, Any]:
    """Return a detached, JSON-compatible report (without tensor/object values)."""
    _annotate_workload_provenance(report)
    return _json_safe(dict(report))


def report_json(report: dict[str, Any]) -> str:
    return json.dumps(serialize_report(report), sort_keys=True, separators=(",", ":"))


def _safe_exception_text(error: BaseException) -> str:
    try:
        return f"{type(error).__name__}: {error}"
    except BaseException:  # noqa: BLE001 - preserve the primary failure
        return f"{type(error).__name__}: <unprintable exception>"


def _atomic_json(path: Path, report: dict[str, Any]) -> None:
    """Write a report without exposing a half-written sidecar."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(report_json(report))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass


def _validate_segment_identity(key: str, index: int) -> None:
    """Validate the public output-node manifest identity before any writes."""
    if not isinstance(key, str) or not key or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in key):
        raise ValueError("segment manifest key must be URL-safe")
    if type(index) is not int or not 0 <= index <= 64:
        raise ValueError("segment index must be an integer from 0 to 64")


def _publish_segment(output_root: Path, key: str, index: int, artifact: dict[str, Any]) -> None:
    """Atomically merge endpoint and video updates into a generation-bound manifest."""
    _validate_segment_identity(key, index)
    manifest = output_root / "fight" / "segments" / f"{key}.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    lock_path = manifest.with_suffix(manifest.suffix + ".lock")
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        if fcntl is not None:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            try:
                prior = json.loads(manifest.read_text()) if manifest.exists() else {}
            except json.JSONDecodeError:
                prior = {}
            existing: dict[str, Any] = next((item for item in prior.get("segments", [])
                             if item.get("index") == index), {})
            segments = [item for item in prior.get("segments", []) if item.get("index") != index]
            segments.append({**existing, "index": index, **artifact})
            _atomic_json(manifest, {
                "generation_id": key,
                "segments": sorted(segments, key=lambda item: item["index"]),
            })
        finally:
            if fcntl is not None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def _node_value(value: Any) -> Any:
    """Unwrap both legacy tuple nodes and native IO.NodeOutput values."""
    if isinstance(value, tuple):
        return value[0] if len(value) == 1 else value
    args = getattr(value, "args", None)
    if args is not None:
        return args[0] if len(args) == 1 else args
    return value


def _vram_snap() -> dict | None:
    try:
        from .nvtx import vram_snapshot
    except ImportError:
        from nvtx import vram_snapshot  # type: ignore[import-not-found, no-redef]
    return vram_snapshot()


def _note_vram(report: dict[str, Any], label: str) -> None:
    snap = _vram_snap()
    if snap is None:
        return
    report.setdefault("vram_snapshots", {})[label] = snap
    peak = snap.get("peak_allocated_bytes")
    if peak is not None:
        report["peak_vram_bytes"] = peak


def _update_timing(report: dict[str, Any], name: str, started: float) -> None:
    report.setdefault("timings_ms", {})[name] = (time.perf_counter() - started) * 1000.0


def _fill_phase_residual(report: dict[str, Any]) -> None:
    """Host gap between named phases and the published clip clock. No extra sync."""
    tm = report.get("timings_ms")
    if not isinstance(tm, dict):
        return
    clip = tm.get("sample_to_finalized_mp4")
    if not isinstance(clip, (int, float)):
        return
    parts = []
    for key in ("sampling", "video_decode", "audio_decode", "mp4_encode"):
        value = tm.get(key)
        if not isinstance(value, (int, float)):
            return
        parts.append(value)
    tm["phase_residual"] = round(clip - sum(parts), 3)


def _decode_report(report: dict[str, Any], stage: str, operation, *, cuda_sync: bool = True):
    """Run a stock decoder and propagate the report through the decode chain.

    Sampling already synchronized the default stream. A second pre-decode
    ``cuda.synchronize`` only stalls the published wall clock. Post-decode
    sync is kept by default so stage timers isolate GPU work; pass
    ``cuda_sync=False`` to skip it (quality-free for default-stream pixels).
    """
    report = serialize_report(report)
    report["status"] = "DECODING"
    import torch
    try:
        from .nvtx import nvtx_range
    except ImportError:
        from contextlib import nullcontext
        nvtx_range = cast(Any, nullcontext)
    started = time.perf_counter()
    try:
        from .memory_evidence import memory_evidence
        with memory_evidence(report.get("profile_memory", False)) as memory, nvtx_range(stage):
            output = operation()
        if memory is not None:
            report.setdefault("memory_evidence", {})[stage] = memory
        if cuda_sync and torch.cuda.is_available():
            # Current stream only: a device-wide synchronize would wait for the
            # overlapping audio VAE stream and fold its time into video_decode.
            torch.cuda.current_stream().synchronize()
        _update_timing(report, stage, started)
        report["status"] = "DECODED"
        return _node_value(output), report
    except Exception as exc:
        _update_timing(report, stage, started)
        report["status"] = "FAILED"
        report["failure_stage"] = stage
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["cleanup_status"] = "complete"
        logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
        raise
