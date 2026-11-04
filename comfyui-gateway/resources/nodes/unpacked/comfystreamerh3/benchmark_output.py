"""Comfy video/file output packing benchmark node."""
from __future__ import annotations

import os
import tempfile
import time
import uuid
from pathlib import Path

from .benchmark_report import (
    _atomic_json,
    _fill_phase_residual,
    _node_value,
    _note_vram,
    _publish_segment,
    _record_storage,
    _validate_segment_identity,
    logger,
    report_json,
    serialize_report,
)
from .compact_output import replace_file


def _nhwc_width_height(images) -> tuple[int, int]:
    """CreateVideo's get_dimensions: (width, height) from NHWC IMAGE."""
    return int(images.shape[2]), int(images.shape[1])

def _video_from_saved_mp4(path, images, fps, audio, *, require_file=False):
    """Prefer a file-backed VIDEO so compact encode does not keep 362 frames resident."""
    try:
        from comfy_api.latest import InputImpl
        return InputImpl.VideoFromFile(str(path)), "file"
    except Exception:  # noqa: BLE001 - unavailable wrapper intentionally uses the fallback
        if require_file:
            raise RuntimeError("final-frame retention requires a file-backed VIDEO") from None
        from comfy_extras.nodes_video import CreateVideo
        return _node_value(CreateVideo.execute(images, fps, audio)), "components_fallback"

class ComfyStreamerH3BenchmarkOutput:
    """Finalize the fixed parallel SportsBall MP4 stream."""

    RETURN_TYPES = ("VIDEO", "H3_RUN_REPORT")
    RETURN_NAMES = ("video", "report")
    FUNCTION = "save"
    CATEGORY = "ComfyStreamerH3/Deploy"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "report": ("H3_RUN_REPORT",),
            "filename_prefix": ("STRING", {"default": "FastH3/benchmark"}),
            "fps": ("FLOAT", {"default": 24.0, "min": 22.0, "max": 24.0}),
        }, "optional": {"audio": ("AUDIO",),
                        "output_backend": (["nvenc", "parallel"], {"default": "nvenc"}),
                        "segment_manifest": ("STRING", {"default": ""}),
                        "segment_index": ("INT", {"default": -1, "min": -1, "max": 64}),
                        "shared_handoff_subfolder": ("STRING", {"default": ""})}}

    def save(self, images, report, filename_prefix="FastH3/benchmark", fps=24.0, audio=None,
             output_backend="nvenc", segment_manifest="", segment_index=-1,
             shared_handoff_subfolder=""):
        if float(fps) not in (22.0, 24.0):
            raise ValueError("ComfyStreamerH3BenchmarkOutput supports 22 or 24 fps")
        if output_backend not in {"parallel", "nvenc"}:
            raise ValueError("ComfyStreamerH3BenchmarkOutput requires output_backend='parallel' or 'nvenc'")
        import folder_paths
        shared_handoff = None
        shared_path = None
        if segment_manifest or segment_index != -1:
            _validate_segment_identity(segment_manifest, segment_index)
            if shared_handoff_subfolder:
                subfolder = Path(str(shared_handoff_subfolder))
                if subfolder.is_absolute() or any(part in {"", ".", ".."} for part in subfolder.parts) or "\\" in str(shared_handoff_subfolder):
                    raise ValueError("shared handoff subfolder must be relative")
                shared_handoff = "/".join((*subfolder.parts, f"{segment_manifest}-{segment_index}.png"))
                input_root = Path(folder_paths.get_input_directory()).resolve()
                shared_path = input_root / shared_handoff
                if not shared_path.resolve().is_relative_to(input_root):
                    raise ValueError("shared handoff escaped its input root")
        started = time.perf_counter()
        report = serialize_report(report)
        _record_storage(report, "output_images_entry", images)
        if isinstance(audio, dict):
            _record_storage(report, "output_audio_entry", audio.get("waveform"))
        knobs = report.get("run_knobs")
        if not isinstance(knobs, dict):
            knobs = {}
            report["run_knobs"] = knobs
        knobs["output_backend"] = output_backend
        _note_vram(report, "encode_begin")
        partial = target = sidecar = None
        stream_session = None
        try:
            nonce = report.get("run_nonce")
            try:
                from .decoder_stream import compact_settings_for_backend, take_stream_session
            except ImportError:  # pragma: no cover
                from decoder_stream import (  # type: ignore[import-not-found, no-redef]
                    compact_settings_for_backend,
                    take_stream_session,
                )
            stream_session = take_stream_session(str(nonce) if nonce else None)
            retention = report.get("decoded_image_retention")
            final_frame_only = retention is not None
            frame_count = int(images.shape[0])
            if final_frame_only:
                if (not isinstance(retention, dict) or retention.get("mode") != "final_frame"
                        or type(retention.get("decoded_frames")) is not int
                        or retention["decoded_frames"] < 1
                        or retention.get("returned_frames") != 1 or frame_count != 1):
                    raise ValueError("invalid final-frame retention metadata")
                frame_count = retention["decoded_frames"]
                if stream_session is None:
                    raise ValueError("final-frame retention requires the complete encoded stream")
            width, height = _nhwc_width_height(images)
            folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(
                filename_prefix, folder_paths.get_output_directory(), width, height)
            filename = f"{name}_{counter:05}_{uuid.uuid4().hex[:8]}.mp4"
            target = Path(folder) / filename
            partial = target.with_name(target.stem + ".partial.mp4")
            sidecar = target.with_suffix(".json")
            if segment_manifest and segment_index >= 0:
                import torch
                from PIL import Image
                last = images[-1].detach().float().clamp(0, 1).mul(255).to(device="cpu", dtype=torch.uint8).numpy()
                last_name = target.stem + ".last.png"
                Image.fromarray(last).save(target.with_name(last_name))
                if shared_path is not None:
                    # A two-GPU Pod runs both Comfy processes against the same
                    # input directory. Publish the reference atomically there
                    # so the peer's LoadImage node can consume it without an
                    # upload/download round trip.
                    shared_path.parent.mkdir(parents=True, exist_ok=True)
                    fd, name = tempfile.mkstemp(prefix=f".{shared_path.name}.", suffix=".tmp", dir=shared_path.parent)
                    temporary = Path(name)
                    try:
                        with os.fdopen(fd, "wb") as handle:
                            Image.fromarray(last).save(handle, format="PNG")
                        os.replace(temporary, shared_path)
                    finally:
                        temporary.unlink(missing_ok=True)
                _publish_segment(Path(folder_paths.get_output_directory()), str(segment_manifest), int(segment_index),
                                 {"last_frame": {"filename": last_name, "subfolder": subfolder, "type": "output"},
                                  **({"shared_handoff": shared_handoff} if shared_handoff else {})})
            compact = None
            if stream_session is not None:
                encoder_settings = compact_settings_for_backend(output_backend)
                same_backend = (
                    encoder_settings is not None
                    and stream_session.preset == encoder_settings["preset"]
                    and stream_session.codec == encoder_settings["codec"]
                )
                if (
                    same_backend
                    and stream_session.frame_count == frame_count
                    and abs(stream_session.fps - float(fps)) < 1e-6
                ):
                    compact = stream_session.finish(audio, probe=False)
                    replace_file(compact["path"], partial)
                    compact["path"] = str(partial)
                else:
                    if final_frame_only:
                        raise ValueError("final-frame retention encoded stream does not match")
                    stream_session.abandon()
                    stream_session = None
                    report.setdefault("stream_encode", {})["save_fallback"] = "mismatch"
            if compact is None:
                from .compact_output import save_compact_mp4
                encoder_settings = compact_settings_for_backend(output_backend)
                if encoder_settings is None:
                    raise ValueError("ComfyStreamerH3BenchmarkOutput requires a concrete encoder backend")
                compact = save_compact_mp4(
                    images, audio, float(fps), partial, preset=encoder_settings["preset"], codec=encoder_settings["codec"],
                    parallel_prepare=True, probe=False,
                )
            report["compact_output"] = compact
            report["output_backend"] = output_backend
            replace_file(partial, target)
            published_at = time.perf_counter()
            if report.get("sample_started_monotonic") is not None:
                report.setdefault("timings_ms", {})["sample_to_published_mp4"] = (
                    published_at - report["sample_started_monotonic"]
                ) * 1000.0
            # This proves a finalized file is at its published worker path;
            # it does not prove a downstream viewer received or played it.
            report["media_publication_scope"] = "worker-local finalized MP4 path"
            if final_frame_only:
                video, wrap = _video_from_saved_mp4(target, images, float(fps), audio, require_file=True)
            else:
                video, wrap = _video_from_saved_mp4(target, images, float(fps), audio)
            report["save_video_wrap"] = wrap
            if "compact_output" in report:
                report["compact_output"]["path"] = str(target)
                compact_ms = report["compact_output"].get("timings_ms") or {}
                # Existing compact timers already split D2H vs YUV vs encode; copy
                # them onto the published report without an extra CUDA synchronize.
                report.setdefault("timings_ms", {}).update({
                    "encode_d2h": compact_ms.get("transfer"),
                    "encode_yuv": compact_ms.get("prepare"),
                    "encode_compress": compact_ms.get("mp4_encode"),
                    "first_encoded_packet_since_decode_start": compact_ms.get(
                        "first_encoded_packet_since_decode_start"),
                    "encode_mux_probe": compact_ms.get("probe"),
                })
            report.setdefault("timings_ms", {})["mp4_encode"] = (time.perf_counter() - started) * 1000.0
            report["fps"] = float(fps)
            report["audio_enabled"] = audio is not None
            report["status"] = "SUCCEEDED"
            report.update(width=width, height=height, frames=frame_count,
                          internal_width=width, internal_height=height)
            report["output_paths"] = [str(target)]
            _record_storage(report, "output_images_final", images)
            if report.get("sample_started_monotonic") is not None:
                report["timings_ms"]["sample_to_finalized_mp4"] = (time.perf_counter() - report["sample_started_monotonic"]) * 1000
            _fill_phase_residual(report)
            _note_vram(report, "encode_end")
            report["cleanup_status"] = "complete"
            _atomic_json(sidecar, report)
            if segment_manifest and segment_index >= 0:
                _publish_segment(Path(folder_paths.get_output_directory()), str(segment_manifest), int(segment_index),
                                 {"filename": filename, "subfolder": subfolder, "type": "output"})
            # This is intentionally after every final field and sidecar write.
            logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
            return {"ui": {"images": [{"filename": filename, "subfolder": subfolder, "type": "output"}],
                           "animated": (True,), "text": [report_json(report)]},
                    "result": (video, report)}
        except Exception as exc:
            if stream_session is not None:
                stream_session.abandon()
            report["status"] = "FAILED"
            report["failure_stage"] = "encoding"
            report["error"] = f"{type(exc).__name__}: {exc}"
            report.setdefault("timings_ms", {})["mp4_encode"] = (time.perf_counter() - started) * 1000.0
            cleanup_errors = []
            if partial is not None and partial.exists():
                try:
                    partial.unlink()
                except OSError as cleanup_exc:
                    cleanup_errors.append(f"partial: {cleanup_exc}")
            if cleanup_errors:
                report["cleanup_status"] = "error"
                report["cleanup_errors"] = cleanup_errors
            else:
                report["cleanup_status"] = "complete"
            if sidecar is not None:
                try:
                    _atomic_json(sidecar, report)
                except OSError as sidecar_exc:
                    report["cleanup_status"] = "error"
                    report.setdefault("cleanup_errors", []).append(f"sidecar: {sidecar_exc}")
            logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
            raise

    execute = save
