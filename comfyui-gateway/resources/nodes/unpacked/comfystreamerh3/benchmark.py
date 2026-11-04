"""Benchmark nodes for repeatable FastH3 measurements.

The nonce is deliberately an input to the node.  Comfy therefore cannot reuse
an execution result for a new benchmark repetition, while the nonce is never
used as part of the RNG seed or sampler parameters.
"""

# Keep the Comfy node import surface stable while each stage lives in its own module.
from .benchmark_audio import (
    ComfyStreamerH3BenchmarkVAEDecodeAudio,
    _abandon_audio_overlap,
    _execute_audio_vae,
    _join_audio_overlap,
    _start_audio_overlap,
)
from .benchmark_output import (
    ComfyStreamerH3BenchmarkOutput,
    _nhwc_width_height,
    _video_from_saved_mp4,
)
from .benchmark_report import (  # noqa: F401 - report helpers remain available to callers
    _GPU_LOCK,
    _annotate_workload_provenance,
    _atomic_json,
    _blank_report,
    _decode_report,
    _fill_phase_residual,
    _json_safe,
    _node_value,
    _note_vram,
    _provenance_digest,
    _publish_segment,
    _record_storage,
    _safe_exception_text,
    _stats,
    _storage_identity,
    _update_timing,
    _vram_snap,
    logger,
    report_json,
    serialize_report,
)
from .benchmark_sampler import ComfyStreamerH3BenchmarkSampler, _noise
from .benchmark_video import (
    ComfyStreamerH3BenchmarkVAEDecode,
    ComfyStreamerH3DmadBenchmarkVAEDecode,
    _copy_output_to_cpu,
)

__all__ = [
    "ComfyStreamerH3BenchmarkOutput",
    "ComfyStreamerH3BenchmarkSampler",
    "ComfyStreamerH3BenchmarkVAEDecode",
    "ComfyStreamerH3BenchmarkVAEDecodeAudio",
    "ComfyStreamerH3DmadBenchmarkVAEDecode",
    "_abandon_audio_overlap",
    "_copy_output_to_cpu",
    "_execute_audio_vae",
    "_join_audio_overlap",
    "_nhwc_width_height",
    "_noise",
    "_start_audio_overlap",
    "_video_from_saved_mp4",
]
