"""Comfy video decoder benchmark node."""

from __future__ import annotations

import time
from typing import Any

from .benchmark_audio import _abandon_audio_overlap, _start_audio_overlap
from .benchmark_report import _decode_report, _json_safe, _note_vram, _record_storage
from .kitchen_baseline import (
    BASELINE_DECODER_QK_INPLACE,
    BASELINE_FUSED_OUTPUT_PACK,
    BASELINE_OUTPUT_HOST_COPY,
)
from .runtime import validate_execution_profile_id


def _stream_audio_sample_rate(report):
    sample_rate = report.get("audio_target_sample_rate") if isinstance(report, dict) else None
    if type(sample_rate) is int and 8000 <= sample_rate <= 192000:
        return sample_rate
    return 44100


def _copy_output_to_cpu(images, mode: str, report: dict[str, Any]):
    """Return a complete CPU IMAGE with an explicit, measurable copy mode."""
    if mode not in ("pageable", "pinned"):
        raise ValueError("output_host_copy must be pageable or pinned")
    import torch

    started = time.perf_counter()
    if images.device.type != "cuda" or mode == "pageable":
        result = images.to(device="cpu")
    else:
        try:
            result = torch.empty(images.shape, dtype=images.dtype, device="cpu", pin_memory=True)
            result.copy_(images, non_blocking=True)
            torch.cuda.current_stream(images.device).synchronize()
        except Exception as exc:
            raise RuntimeError(f"pinned output copy requested but unavailable: {exc}") from exc
    report["output_host_copy"] = {
        "mode": mode,
        "bytes": int(images.numel() * images.element_size()),
        "ms": (time.perf_counter() - started) * 1000.0,
        "device": str(images.device),
    }
    return result


def _decoder_execution_profile(report, decoder_mode, execution_profile_id, *, replay):
    experimental_h3_profile = isinstance(report, dict) and report.get("model_family") in {
        "dmad",
    }
    report_preset = report.get("preset_id") if isinstance(report, dict) else None
    if isinstance(report_preset, str):
        return validate_execution_profile_id(
            report_preset,
            decoder_mode,
            execution_profile_id,
            resolved_preset_hash=report.get("preset_hash"),
        )
    if not replay and not experimental_h3_profile:
        raise ValueError("H3 decoder report is missing the preset identity")
    return None


def _expected_benchmark_output_backend(report: dict[str, Any]) -> str:
    """Read an explicit benchmark-only encoder override, retaining NVENC by default."""
    backend = report.get("benchmark_output_backend", "nvenc")
    if backend not in ("nvenc", "parallel"):
        raise ValueError("benchmark_output_backend must be nvenc or parallel")
    return backend


class ComfyStreamerH3BenchmarkVAEDecode:
    """Decode through the fixed SportsBall fused/tiled/streaming path."""

    RETURN_TYPES = ("IMAGE", "H3_RUN_REPORT")
    RETURN_NAMES = ("images", "report")
    FUNCTION = "decode"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"samples": ("LATENT",), "vae": ("VAE",), "report": ("H3_RUN_REPORT",)},
            "optional": {
                "output_on_gpu": ("BOOLEAN", {"default": True}),
                "decoder_mode": (
                    ["fused_ff_qk_rope", "native_v036"],
                    {"default": "fused_ff_qk_rope"},
                ),
                "execution_profile_id": ("STRING", {"default": ""}),
                "overlap_output": ("BOOLEAN", {"default": True}),
                "stream_finalized_tiles": ("BOOLEAN", {"default": True}),
                "retain_final_frame_only": ("BOOLEAN", {"default": False}),
                "encode_backend": (["nvenc", "parallel"], {"default": "nvenc"}),
                "stream_fps": ("FLOAT", {"default": 24.0, "min": 22.0, "max": 24.0}),
                "tile_batch": ("INT", {"default": 3, "min": 3, "max": 3}),
                "cuda_sync": ("BOOLEAN", {"default": False}),
                "audio_vae": ("VAE",),
                "vae_precision_policy": (["established", "fp16_accum"], {"default": "established"}),
                # Keep the default baseline on the existing
                # fast decoder path. Kitchen VAE adapters are
                # memory experiments until GPU fusion is
                # independently verified.
                "kitchen_vae_fusions": ("BOOLEAN", {"default": False}),
                # Fixed-shape CUDA Graph replay is an
                # optional decoder benchmark arm. It uses
                # the existing VAE weights and is never
                # enabled by the production default.
                "decoder_cuda_graph": ("BOOLEAN", {"default": False}),
                # The B1 decoder contract owns Q/K buffers,
                # packs output on the GPU, and uses pinned D2H.
                "reuse_staging": ("BOOLEAN", {"default": False}),
                "staging_capacity": ("INT", {"default": 1, "min": 1, "max": 2}),
                "elide_owned_clone": ("BOOLEAN", {"default": False}),
            },
        }

    def decode(
        self,
        samples,
        vae,
        report,
        output_on_gpu=True,
        decoder_mode="fused_ff_qk_rope",
        overlap_output=True,
        stream_finalized_tiles=True,
        encode_backend="nvenc",
        stream_fps=24.0,
        tile_batch=3,
        cuda_sync=False,
        audio_vae=None,
        vae_precision_policy="established",
        kitchen_vae_fusions=False,
        decoder_cuda_graph=False,
        decoder_qk_inplace=BASELINE_DECODER_QK_INPLACE,
        reuse_staging=False,
        staging_capacity=1,
        elide_owned_clone=False,
        fused_output_pack=BASELINE_FUSED_OUTPUT_PACK,
        output_host_copy=BASELINE_OUTPUT_HOST_COPY,
        execution_profile_id=None,
        retain_final_frame_only=False,
        *,
        _replay=False,
        _migration_diagnostic=False,
    ):
        if not isinstance(_replay, bool):
            raise TypeError("_replay must be boolean")
        if not isinstance(decoder_cuda_graph, bool):
            raise TypeError("decoder_cuda_graph must be boolean")
        if not isinstance(_migration_diagnostic, bool):
            raise TypeError("_migration_diagnostic must be boolean")
        if type(retain_final_frame_only) is not bool:
            raise TypeError("retain_final_frame_only must be boolean")
        if float(stream_fps) not in (22.0, 24.0):
            raise ValueError("H3 benchmark output supports 22 or 24 fps")
        if retain_final_frame_only and (
            _replay or _migration_diagnostic or encode_backend != "nvenc"
            or not stream_finalized_tiles or not overlap_output
            or not isinstance(report, dict) or not report.get("run_nonce")
        ):
            raise ValueError("final-frame retention requires an identified NVENC temporal stream")
        if decoder_mode == "native_v036" and (
            reuse_staging or elide_owned_clone or staging_capacity != 1
        ):
            raise ValueError("native_v036 does not expose legacy staging or clone experiments")
        experimental_h3_profile = (
            isinstance(report, dict) and report.get("model_family") == "dmad"
        )
        runtime_profile = _decoder_execution_profile(
            report,
            decoder_mode,
            execution_profile_id,
            replay=_replay,
        )
        if runtime_profile is not None and not _replay:
            report = dict(
                report,
                execution_profile_id=runtime_profile["profile_id"],
                execution_profile_hash=runtime_profile["profile_hash"],
                execution_profile=runtime_profile,
            )
        # These settings are part of the B1 contract.  Retain the parameters
        # for old serialized graphs, but do not allow them to turn the baseline
        # off.  The upstream native_v036 decoder remains the sole exception
        # because it owns a different Q/K buffer contract.
        baseline = report.get("kitchen_baseline")
        b1_baseline = isinstance(baseline, dict)
        if _replay:
            decoder_qk_inplace = decoder_qk_inplace and decoder_mode != "native_v036"
            fused_output_pack = False
            output_host_copy = None
        elif experimental_h3_profile:
            decoder_qk_inplace = bool(decoder_qk_inplace and decoder_mode != "native_v036")
            fused_output_pack = bool(fused_output_pack)
        else:
            decoder_qk_inplace = (
                b1_baseline and BASELINE_DECODER_QK_INPLACE and decoder_mode != "native_v036"
            )
            fused_output_pack = b1_baseline and BASELINE_FUSED_OUTPUT_PACK
            output_host_copy = BASELINE_OUTPUT_HOST_COPY
        for name, value in (
            ("decoder_qk_inplace", decoder_qk_inplace),
            ("reuse_staging", reuse_staging),
            ("elide_owned_clone", elide_owned_clone),
        ):
            if not isinstance(value, bool):
                raise TypeError(f"{name} must be boolean")
        if type(staging_capacity) is not int or staging_capacity not in (1, 2):
            raise ValueError("staging_capacity must be 1 or 2")
        if vae_precision_policy not in ("established", "fp16_accum"):
            raise ValueError("invalid VAE precision policy")
        if baseline and baseline.get("vae_precision_policy") != vae_precision_policy:
            raise ValueError("decoder precision policy differs from loader profile")
        if not baseline and not experimental_h3_profile and vae_precision_policy != "established":
            raise ValueError("FP16 accumulation requires a Kitchen baseline profile")
        if kitchen_vae_fusions and not (baseline or experimental_h3_profile):
            raise ValueError("Kitchen VAE fusions require a Kitchen baseline profile")
        if decoder_mode == "native_v036" and kitchen_vae_fusions:
            raise ValueError("native_v036 already owns the native VAE fusion path")
        if (
            experimental_h3_profile
            and decoder_mode == "native_v036"
            and (reuse_staging or elide_owned_clone or staging_capacity != 1 or tile_batch != 3)
        ):
            raise ValueError(
                "native_v036 DMAD runs do not use staged/clone-controlled reference tiles"
            )
        from .migration_capture import active_capture

        migration_capture = active_capture()
        _migration_diagnostic = _migration_diagnostic or migration_capture is not None
        if retain_final_frame_only and _migration_diagnostic:
            raise ValueError("final-frame retention is unavailable during migration capture")
        if _replay:
            if decoder_mode not in ("fused_ff_qk_rope", "native_v036") or tile_batch != 3:
                raise ValueError("unsupported decoder-only replay settings")
            stream_finalized_tiles = False
            overlap_output = False
            audio_vae = None
        else:
            if experimental_h3_profile:
                if decoder_mode not in (
                    "reference",
                    "fused_ff",
                    "fused_ff_qk_rope",
                    "scale_cache",
                    "native_v036",
                ):
                    raise ValueError("unsupported experimental H3 decoder profile")
                if type(stream_finalized_tiles) is not bool or type(overlap_output) is not bool:
                    raise TypeError("H3 streaming flags must be booleans")
                if encode_backend not in ("nvenc", "parallel"):
                    raise ValueError("H3 encode_backend must be nvenc or parallel")
                if type(tile_batch) is not int or tile_batch not in (1, 2, 3):
                    raise ValueError("H3 tile_batch must be one through three")
                if type(cuda_sync) is not bool:
                    raise TypeError("cuda_sync must be boolean")
            else:
                expected_output_backend = _expected_benchmark_output_backend(report)
                expected = {
                    "output_on_gpu": (output_on_gpu, True),
                    "decoder_mode": (decoder_mode, decoder_mode),
                    "overlap_output": (overlap_output, True),
                    "stream_finalized_tiles": (stream_finalized_tiles, True),
                    "encode_backend": (encode_backend, expected_output_backend),
                    "stream_fps": (float(stream_fps), float(stream_fps)),
                    "tile_batch": (int(tile_batch), 3),
                    "cuda_sync": (cuda_sync, False),
                }
                invalid = [name for name, (actual, golden) in expected.items() if actual != golden]
                if invalid:
                    raise ValueError("non-golden FastH3 decode settings: " + ", ".join(invalid))
        try:
            from .build_identity import node_fingerprint
        except ImportError:
            from build_identity import node_fingerprint  # type: ignore[import-not-found, no-redef]
        report = dict(report, node_fingerprint=node_fingerprint(), fps=float(stream_fps))
        if isinstance(samples, dict):
            _record_storage(report, "decode_input_latent", samples.get("samples"))
        report["vae_checkpoint"] = _json_safe(getattr(vae, "_fasth3_checkpoint", None))
        tile_report = {
            "groups": 0,
            "staged_groups": 0,
            "staging_allocations": 0,
            "staging_reuses": 0,
        }
        try:
            from .decoder_stream import (
                abandon_stream_session,
                push_finalized_bcthw,
                register_stream_session,
                require_stream_finalized_tiles,
                resolve_output_overlap,
                start_stream_session,
                wrap_decode_temporal,
            )
        except ImportError:  # pragma: no cover - standalone test imports
            from decoder_stream import (  # type: ignore[import-not-found, no-redef]
                abandon_stream_session,
                push_finalized_bcthw,
                register_stream_session,
                require_stream_finalized_tiles,
                resolve_output_overlap,
                start_stream_session,
                wrap_decode_temporal,
            )
        report["audio_overlap"] = {
            "enabled": False,
            "mode": "off",
            "reason": "decoder_only_replay" if _replay else "audio_not_started",
        }
        if not _replay:
            stream_finalized_tiles, skip_audio_thread = resolve_output_overlap(
                overlap_output, stream_finalized_tiles
            )
            if skip_audio_thread or not overlap_output:
                audio_vae = None
                report["audio_overlap"] = {
                    "enabled": False,
                    "mode": "serial",
                    "reason": "B1_stream_serial_audio"
                    if skip_audio_thread
                    else "output_overlap_disabled",
                }
            if overlap_output:
                cuda_sync = False
            if not experimental_h3_profile:
                require_stream_finalized_tiles(stream_finalized_tiles)
        nonce = report.get("run_nonce") if isinstance(report, dict) else None
        stream_session = None
        stream_info = {"enabled": False, "mode": "off"}
        if stream_finalized_tiles:
            stream_session, stream_info = start_stream_session(
                encode_backend=encode_backend,
                fps=float(stream_fps),
                fused_output_pack=fused_output_pack,
                audio_sample_rate=_stream_audio_sample_rate(report),
            )
            if stream_session is not None and nonce:
                register_stream_session(str(nonce), stream_session)
        import torch
        from nodes import VAEDecode

        node = VAEDecode()
        previous_device = vae.output_device
        if getattr(vae.device, "type", None) != "cuda":
            raise RuntimeError("golden FastH3 decode requires a CUDA VAE")
        vae.output_device = vae.device if output_on_gpu else torch.device("cpu")
        try:
            if audio_vae is not None and nonce:
                _start_audio_overlap(str(nonce), audio_vae, samples)
                report["audio_overlap"] = {
                    "enabled": True,
                    "mode": "concurrent",
                    "reason": "audio_vae_thread_started",
                }
            from contextlib import ExitStack, nullcontext

            with ExitStack() as stack:
                from .decoder_optimizations import decoder_cuda_graph as configure_cuda_graph
                from .decoder_optimizations import decoder_mode as configure_decoder
                from .decoder_optimizations import decoder_qk_inplace as configure_qk_inplace
                from .decoder_optimizations import tile_batch as configure_tile_batch

                profile = stack.enter_context(
                    configure_decoder(vae.first_stage_model, decoder_mode, qk_rope_parity=None)
                )
                if (
                    profile is not None
                    and not profile.enabled
                    and (decoder_mode != "reference" or not profile.capability.available)
                ):
                    raise RuntimeError(profile.capability.reason)
                cuda_graph_profile = None
                if decoder_cuda_graph:
                    cuda_graph_profile = stack.enter_context(configure_cuda_graph(vae.first_stage_model))
                qk_inplace_profile = stack.enter_context(
                    configure_qk_inplace(vae.first_stage_model, enabled=decoder_qk_inplace)
                )
                kitchen_evidence = None
                if (baseline or experimental_h3_profile) and kitchen_vae_fusions:
                    from .kitchen_vae import kitchen_vae_mode

                    kitchen_evidence = stack.enter_context(
                        kitchen_vae_mode(
                            vae.first_stage_model,
                            precision_policy=vae_precision_policy,
                            enabled=True,
                        )
                    )
                if decoder_mode != "native_v036":
                    stack.enter_context(
                        configure_tile_batch(
                            vae.first_stage_model,
                            tile_batch,
                            bounded=False,
                            reuse_staging=reuse_staging,
                            persistent_canvas=False,
                            report=tile_report,
                            staging_capacity=staging_capacity,
                            elide_owned_clone=elide_owned_clone,
                        )
                    )
                # Ownership checks run before our diagnostic hooks attach.
                # Otherwise Q/K in-place correctly rejects the attention hooks
                # as a foreign wrapper and the B1 control never engages.
                decoder_execution_evidence = None
                upstream_dispatch_evidence = None
                if _migration_diagnostic:
                    from .decoder_optimizations import decoder_execution

                    decoder_execution_evidence = stack.enter_context(
                        decoder_execution(vae.first_stage_model)
                    )
                if migration_capture is not None:
                    from .decoder_optimizations import decoder_upstream_dispatch

                    upstream_dispatch_evidence = stack.enter_context(decoder_upstream_dispatch())
                _note_vram(report, "decode_begin")
                stream_wrap = (
                    wrap_decode_temporal(
                        vae,
                        lambda part: push_finalized_bcthw(
                            stream_session, part, fused_output_pack=fused_output_pack
                        ),
                        retain_cpu=False,
                    )
                    if stream_session is not None
                    else nullcontext({"mode": stream_info.get("mode", "off")})
                )
                wrap_meta = stack.enter_context(stream_wrap)
                result, updated = _decode_report(
                    report,
                    "video_decode",
                    lambda: node.decode(vae, samples),
                    cuda_sync=bool(_replay),
                )
                if migration_capture is not None:
                    # Exact original floating output; D2H/finite checks/IO are
                    # diagnostic-only and begin after the decoder clock stops.
                    migration_capture.write_decoder_pixels(result)
                _note_vram(updated, "decode_end")
                knobs = updated.get("run_knobs")
                if not isinstance(knobs, dict):
                    knobs = {}
                    updated["run_knobs"] = knobs
                knobs.update(
                    decoder_mode=decoder_mode,
                    execution_profile_id=(
                        runtime_profile["profile_id"] if runtime_profile else None
                    ),
                    execution_profile_hash=(
                        runtime_profile["profile_hash"] if runtime_profile else None
                    ),
                    execution_profile=(runtime_profile["profile_id"] if runtime_profile else None),
                    tile_batch="native" if decoder_mode == "native_v036" else tile_batch,
                    decode_cuda_sync=bool(_replay),
                    output_on_gpu=True if _replay else bool(output_on_gpu),
                    stream_finalized_tiles=bool(stream_finalized_tiles and not _replay),
                    overlap_output=bool(overlap_output and not _replay),
                    decoder_cuda_graph=decoder_cuda_graph,
                    decoder_qk_inplace=decoder_qk_inplace,
                    reuse_staging=reuse_staging,
                    staging_capacity=staging_capacity,
                    elide_owned_clone=elide_owned_clone,
                    fused_output_pack=fused_output_pack,
                    output_host_copy=output_host_copy,
                )
                updated["decoder_tile_execution"] = tile_report
                stream_info = dict(stream_info)
                stream_info["mode"] = wrap_meta.get("mode", stream_info.get("mode"))
                if stream_session is not None and stream_session.frame_count == 0:
                    if retain_final_frame_only:
                        raise ValueError("final-frame retention requires finalized temporal frames")
                    stream_info["mode"] = "fallback_full_decode"
                    stream_session.push_nhwc(result)
                stream_info["frames"] = (
                    0 if stream_session is None else int(stream_session.frame_count)
                )
                if retain_final_frame_only:
                    decoded_frames = int(result.shape[0])
                    if (
                        stream_session is None
                        or stream_session.codec != "h264_nvenc"
                        or decoded_frames <= 0
                        or int(stream_session.frame_count) != decoded_frames
                        or stream_info["mode"] not in (
                            "temporal_write_part", "temporal_write_part_replay",
                        )
                    ):
                        raise ValueError("final-frame retention requires a complete NVENC temporal stream")
                    updated["decoded_image_retention"] = {
                        "mode": "final_frame",
                        "decoded_frames": decoded_frames,
                        "returned_frames": 1,
                        "float_host_bytes_avoided": int(
                            (result.numel() - result[-1:].numel()) * result.element_size()
                        ),
                    }
                    updated["frames"] = decoded_frames
                if not _replay:
                    stream_info["encode_backend"] = encode_backend
                updated["stream_finalized_tiles"] = bool(stream_finalized_tiles and not _replay)
                updated["overlap_output"] = bool(overlap_output and not _replay)
                updated["stream_encode"] = stream_info
                updated["tile_batch"] = "native" if decoder_mode == "native_v036" else tile_batch
                updated["decode_cuda_sync"] = bool(_replay)
            if kitchen_evidence is not None:
                updated["kitchen_vae_execution"] = _json_safe(kitchen_evidence)
            if decoder_execution_evidence is not None:
                profile.execution.update(decoder_execution_evidence)
            if upstream_dispatch_evidence is not None:
                profile.upstream_dispatch.update(upstream_dispatch_evidence)
            updated["decoder_optimization"] = profile.to_dict()
            if _migration_diagnostic:
                updated["migration_diagnostic"] = True
                updated["timing_eligible"] = False
            # ExitStack has now restored all decoder wrappers.  Copy these
            # reports after scope exit so `restored` and graph teardown state
            # describe the completed request rather than the active scope.
            updated["decoder_cuda_graph"] = (
                dict(cuda_graph_profile)
                if cuda_graph_profile is not None
                else {
                    "enabled": False,
                    "reason": "disabled",
                }
            )
            updated["decoder_qk_inplace"] = dict(qk_inplace_profile)
            updated["kitchen_vae_fusions"] = bool(kitchen_vae_fusions)
            updated["video_decode_output_device"] = str(getattr(result, "device", "unknown"))
            if retain_final_frame_only:
                # RGB24 transfers already own every encoded frame. Keep only
                # continuity pixels, with storage independent of the full video.
                result = result[-1:]
                if result.device.type != "cuda":
                    result = result.clone()
                result = _copy_output_to_cpu(result, output_host_copy or "pageable", updated)
            # Comfy's RAM-pressure cache can retain many completed node outputs
            # on large-RAM workers. Do not leave a full float32 video batch in
            # VRAM per cached decode. Streaming encoding has already received
            # its own uint8 transfers; downstream frame selection works on CPU.
            elif output_host_copy is not None:
                result = _copy_output_to_cpu(result, output_host_copy, updated)
            updated["video_decode_output_device"] = str(result.device)
            return result, updated
        except Exception:
            if not _replay:
                _abandon_audio_overlap(str(nonce) if nonce else None)
                abandon_stream_session(str(nonce) if nonce else None)
            if stream_session is not None and (not nonce):
                stream_session.abandon()
            raise
        finally:
            vae.output_device = previous_device


class ComfyStreamerH3DmadBenchmarkVAEDecode(ComfyStreamerH3BenchmarkVAEDecode):
    """Expose existing H3 decoder ablations to the DMAD experimental profile."""

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        optional = dict(inputs["optional"])
        optional["decoder_mode"] = (
            [
                "reference",
                "fused_ff",
                "fused_ff_qk_rope",
                "scale_cache",
                "native_v036",
            ],
            {"default": "fused_ff_qk_rope"},
        )
        optional["tile_batch"] = ("INT", {"default": 3, "min": 1, "max": 3})
        return {**inputs, "optional": optional}
