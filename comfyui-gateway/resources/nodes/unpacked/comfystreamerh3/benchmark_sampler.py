"""Comfy sampler benchmark node."""

from __future__ import annotations

import time
from contextlib import contextmanager

from .benchmark_report import (
    _GPU_LOCK,
    _blank_report,
    _json_safe,
    _note_vram,
    _safe_exception_text,
    _stats,
    logger,
    report_json,
    serialize_report,
)


def _noise(seed: int):
    class Noise:
        def __init__(self, value: int):
            self.seed = value

        def generate_noise(self, latent):
            import comfy.sample

            return comfy.sample.prepare_noise(
                latent["samples"], self.seed, latent.get("batch_index")
            )

    return Noise(seed)


def _is_dmad_profile(profile) -> bool:
    if not isinstance(profile, dict):
        return False
    # `sampling_contract` is the current loader/report field. Accept the older
    # `sampler_contract` alias for saved candidate workflows.
    contract = profile.get("sampling_contract", profile.get("sampler_contract"))
    return contract == "dmad-h3-4step-renoise/1"


def _sampler_name(sampler) -> str | None:
    name = getattr(sampler, "name", None) or getattr(sampler, "sampler", None)
    if isinstance(name, str):
        return name
    sampler_function = getattr(sampler, "sampler_function", None)
    function_name = getattr(sampler_function, "__name__", None)
    return function_name.removeprefix("sample_") if isinstance(function_name, str) else None


def _record_transformer_compile(report, profile) -> None:
    compile_report = profile.get("transformer_compile") if isinstance(profile, dict) else None
    if not isinstance(compile_report, dict):
        return
    initial = report.get("transformer_compile", {})
    before = initial.get("dynamo_counters_before_sample") if isinstance(initial, dict) else None
    compile_report = _json_safe(compile_report)
    if compile_report.get("enabled") is True:
        after = compile_report.get("dynamo_counters_after")
        compile_report["dynamo_counters_before_sample"] = before
        compile_report["compiled_graphs_added_this_sample"] = None
        compile_report["captured_ops_added_this_sample"] = None
        compile_report["counter_scope"] = "process-global Dynamo counters, not GPU coverage"
        compile_report["captured_calls_semantics"] = "FX call nodes, not transformer invocations"
        if isinstance(before, dict) and isinstance(after, dict):
            before_stats = before.get("stats", {})
            after_stats = after.get("stats", {})
            compile_report["compiled_graphs_added_this_sample"] = (
                after_stats.get("unique_graphs", 0) - before_stats.get("unique_graphs", 0)
            )
            compile_report["captured_ops_added_this_sample"] = (
                after_stats.get("calls_captured", 0) - before_stats.get("calls_captured", 0)
            )
    report["transformer_compile"] = compile_report
    report.setdefault("run_knobs", {})["transformer_compile"] = compile_report


@contextmanager
def _inference_feature_scope(patcher, flags, report=None):
    """Apply request-local inference experiments for DMAD runs."""
    from . import memory_features
    from .inference_features import inference_experiments

    with memory_features.feature_scope(flags):
        try:
            with inference_experiments(patcher):
                yield
        finally:
            if report is not None:
                memory_features.annotate(report)


class ComfyStreamerH3BenchmarkSampler:
    """Run a checked FastH3 sampler contract from the selected loader profile."""

    RETURN_TYPES = ("LATENT", "H3_RUN_REPORT")
    RETURN_NAMES = ("output", "report")
    FUNCTION = "sample"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                "conditioning": ("GUIDER",),
                "latent_image": ("LATENT",),
                "seed": ("INT", {"default": 42424242, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "run_nonce": ("STRING", {"default": ""}),
                "profile": ("H3_PROFILE",),
                "mode": (["normal"], {"default": "normal"}),
            },
            "optional": {
                "profile_memory": ("BOOLEAN", {"default": False}),
                "noise_stream": ("DMAD_NOISE",),
                "benchmark_output_backend": (["nvenc", "parallel"], {"default": "nvenc"}),
            },
        }

    def sample(
        self,
        model,
        sampler,
        sigmas,
        conditioning,
        latent_image,
        seed,
        run_nonce,
        profile=None,
        mode="normal",
        profile_memory=False,
        noise_stream=None,
        benchmark_output_backend="nvenc",
    ):
        if not isinstance(run_nonce, str) or not run_nonce.strip():
            raise ValueError("run_nonce must be a non-empty string")
        if mode != "normal":
            raise ValueError("ComfyStreamerH3 Sampler supports only mode='normal'")
        if benchmark_output_backend not in {"nvenc", "parallel"}:
            raise ValueError("benchmark_output_backend must be 'nvenc' or 'parallel'")
        is_dmad = _is_dmad_profile(profile)
        if is_dmad and noise_stream is None:
            raise ValueError("DMAD sampling requires its sampler/noise object pair")
        if is_dmad and getattr(noise_stream, "seed", None) != seed:
            raise ValueError("DMAD noise seed must match the benchmark seed")
        if noise_stream is not None and not is_dmad:
            raise ValueError("A DMAD noise object cannot be combined with a non-DMAD profile")
        report = _blank_report(run_nonce=run_nonce, seed=seed, profile=profile)
        if is_dmad:
            from .dmad_sampling import _latent_parts

            video_latent, audio_latent = _latent_parts(latent_image)
            latent_frames, latent_height, latent_width = (
                int(video_latent.shape[2]),
                int(video_latent.shape[3]),
                int(video_latent.shape[4]),
            )
            if (latent_frames - 2) % 5:
                raise ValueError("DMAD video latent does not follow the native 17*n+5 frame grid")
            frames = ((latent_frames - 2) // 5) * 17 + 5
            report.update(
                model_family="dmad",
                model_variant=profile["model_variant"],
                base_model_id=profile["base_model_id"],
                base_revision=profile["base_revision"],
                dmad_comfy_manifest_sha256=profile["dmad_comfy_manifest_sha256"],
                width=latent_width * 16,
                height=latent_height * 16,
                internal_width=latent_width * 16,
                internal_height=latent_height * 16,
                frames=frames,
                fps=24.0,
                audio_enabled=True,
                audio_latent_frames=int(audio_latent.shape[-1]),
                audio_target_sample_rate=32000,
                attention_status=profile["attention_mode"],
                gate_compress=False,
                run_knobs=dict(
                    report.get("run_knobs") or {},
                    precision_mode=profile["precision_mode"],
                    video_shift=profile["video_shift"],
                    audio_shift=profile["audio_shift"],
                    kitchen_vae_fusions=profile["kitchen_vae_fusions"],
                    vae_precision_policy=profile["vae_precision_policy"],
                ),
            )
        report["profile_memory"] = bool(profile_memory)
        report["benchmark_output_backend"] = benchmark_output_backend
        if isinstance(latent_image, dict) and "fasth3_encoder_execution" in latent_image:
            report["encoder_optimization"] = _json_safe(latent_image["fasth3_encoder_execution"])
        sampler_name = _sampler_name(sampler)
        report["sampler"] = sampler_name
        if report.get("kitchen_baseline") and sampler_name != profile.get("sampler"):
            raise ValueError(
                f"actual sampler {sampler_name!r} differs from Kitchen baseline "
                f"{profile.get('sampler')!r}"
            )
        observed_nfe = [0]
        try:
            report["actual_nfe"] = max(0, len(sigmas) - 1)
        except TypeError:
            report["actual_nfe"] = None

        with _GPU_LOCK:
            import torch

            compile_receipt = report.get("transformer_compile")
            if isinstance(compile_receipt, dict) and compile_receipt.get("enabled") is True:
                from .transformer_compile import _dynamo_counter_snapshot

                compile_receipt["dynamo_counters_before_sample"] = _dynamo_counter_snapshot(torch)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
                report["gpu_name"] = torch.cuda.get_device_name(0)
                cap = torch.cuda.get_device_capability()
                report["gpu_capability"] = f"{cap[0]}.{cap[1]}"
                gpu_uuid = getattr(torch.cuda.get_device_properties(0), "uuid", None)
                if gpu_uuid is not None:
                    report["gpu_uuid"] = str(gpu_uuid)
            started = time.perf_counter()
            report["status"] = "SAMPLING"
            report["vram_snapshots"] = {}
            _note_vram(report, "sample_begin")
            _stats(reset=True)
            step_marks: list[float] = [started]
            execution = {}
            memory = None
            try:
                from .attention_execution import (
                    capture_attention_execution,
                    finalize_attention_execution,
                )
                from .memory_evidence import memory_evidence
                from .native_attention import request_stage_timings

                with (
                    capture_attention_execution() as execution,
                    request_stage_timings() as native_timings,
                    memory_evidence(profile_memory) as memory,
                ):
                    if is_dmad:
                        patcher = getattr(conditioning, "model_patcher", model)
                        with _inference_feature_scope(patcher, profile.get("memory_flags", {}), report):
                            result = self._run_sample(
                                model,
                                sampler,
                                sigmas,
                                conditioning,
                                latent_image,
                                seed,
                                observed_nfe,
                                step_marks,
                                noise_stream=noise_stream,
                            )
                    else:
                        result = self._run_sample(
                            model,
                            sampler,
                            sigmas,
                            conditioning,
                            latent_image,
                            seed,
                            observed_nfe,
                            step_marks,
                            noise_stream=noise_stream,
                        )
                if memory is not None:
                    report.setdefault("memory_evidence", {})["sampling"] = memory
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
                    _note_vram(report, "sample_end")
                    report["peak_vram_bytes"] = torch.cuda.max_memory_allocated()
                timing_evidence = native_timings.resolve()
                if timing_evidence["timed_calls"]:
                    execution.update(timing_evidence)
                report["actual_nfe"] = observed_nfe[0] or None
                if len(step_marks) >= 2:
                    step_timings = [
                        round((step_marks[i] - step_marks[i - 1]) * 1000.0, 3)
                        for i in range(1, len(step_marks))
                    ]
                    report["timings_ms"]["denoising_steps"] = step_timings
                    if is_dmad:
                        report["renoise_step_ms"] = step_timings
                    else:
                        report["euler_step_ms"] = step_timings
                        report["timings_ms"]["euler_steps"] = step_timings
                report["status"] = "SAMPLED"
                report["sample_started_monotonic"] = started
                report["sample_finished_monotonic"] = time.perf_counter()
                report["timings_ms"]["sampling"] = (time.perf_counter() - started) * 1000.0
                _record_transformer_compile(report, profile)
                report["attention_execution"] = finalize_attention_execution(execution)
                if execution.get("calibration_clipped"):
                    raise RuntimeError("native NVFP4 calibration clipped operands; reject this run")
                counters = _stats()
                report["dispatch"] = _json_safe(counters)
                primary_attention_counter = (
                    "sparse" if report.get("attention_option") == "cute_sol" else "producer"
                )
                report["actual_sparse_calls"] = counters.get(primary_attention_counter, 0)
                report["fallback_calls"] = counters.get("dense_fallback", 0) + counters.get(
                    "errors", 0
                )
                report["hard_fallback_calls"] = counters.get("errors", 0)
                expected_nfe = profile.get("steps", 4) if isinstance(profile, dict) else 4
                if not isinstance(expected_nfe, int) or expected_nfe < 1:
                    expected_nfe = 4
                expected_sparse_calls = 50 * expected_nfe
                nfe_ok = report["actual_nfe"] == expected_nfe
                fallback_ok = (
                    report["hard_fallback_calls"] == 0
                    if report.get("attention_option") == "cute_sol"
                    else report["fallback_calls"] == 0
                )
                producer_ok = report["actual_sparse_calls"] == expected_sparse_calls
                if report.get("kitchen_baseline") and execution["calls"] != expected_sparse_calls:
                    raise RuntimeError(
                        f"attention execution evidence missing: {execution['calls']} "
                        f"completed calls, expected {expected_sparse_calls}"
                    )
                if is_dmad:
                    attention_mode = profile.get("attention_mode")
                    if attention_mode == "dense":
                        producer_ok = report["actual_sparse_calls"] == 0
                        fallback_ok = report["hard_fallback_calls"] == 0
                    elif attention_mode == "vsa_fine_only":
                        producer_ok = report["actual_sparse_calls"] == expected_sparse_calls
                        fallback_ok = report["hard_fallback_calls"] == 0
                    else:
                        raise RuntimeError(f"unsupported DMAD attention mode: {attention_mode!r}")
                    stream = getattr(noise_stream, "stream", None)
                    if (
                        stream is None
                        or (stream.initial_draws, stream.resample_draws) != (2, 8)
                        or observed_nfe[0] != 4
                    ):
                        raise RuntimeError(
                            "DMAD run did not record the initial pair and four video/audio re-noise draws"
                        )
                    report["model_family"] = "dmad"
                    report["sampling_contract"] = profile["sampling_contract"]
                    report["dmad_noise_stream"] = {
                        "initial_component_draws": stream.initial_draws,
                        "resample_component_draws": stream.resample_draws,
                        "sampler_contract": profile["sampling_contract"],
                    }
                    report["attention_status"] = attention_mode
                if not (nfe_ok and fallback_ok and producer_ok):
                    raise RuntimeError(
                        "strict FastH3 dispatch check failed: "
                        f"nfe={report['actual_nfe']}, "
                        f"producer={report['actual_sparse_calls']}, fallback={report['fallback_calls']}, "
                        f"expected_nfe={expected_nfe}, expected_producer={expected_sparse_calls}"
                    )
                report["cleanup_status"] = "complete"
                logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
                return result, serialize_report(report)
            except Exception as exc:
                report["status"] = "FAILED"
                report["failure_stage"] = "sampling"
                _record_transformer_compile(report, profile)
                report["attention_execution"] = _json_safe(execution)
                failure_counters = _stats()
                report["dispatch"] = _json_safe(failure_counters)
                primary_attention_counter = (
                    "sparse" if report.get("attention_option") == "cute_sol" else "producer"
                )
                report["actual_sparse_calls"] = failure_counters.get(primary_attention_counter, 0)
                report["fallback_calls"] = failure_counters.get(
                    "dense_fallback", 0
                ) + failure_counters.get("errors", 0)
                report["hard_fallback_calls"] = failure_counters.get("errors", 0)
                report["actual_nfe"] = observed_nfe[0]
                if memory is not None:
                    report.setdefault("memory_evidence", {})["sampling"] = memory
                report["error"] = _safe_exception_text(exc)
                report["timings_ms"]["sampling"] = (time.perf_counter() - started) * 1000.0
                report["cleanup_status"] = "complete"
                logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
                raise

    @staticmethod
    def _run_sample(
        model,
        sampler,
        sigmas,
        conditioning,
        latent_image,
        seed,
        observed_nfe,
        step_marks=None,
        noise_stream=None,
    ):
        """Use the pinned advanced guider path; retain a stock fallback for tests/old Comfy."""
        latent = dict(latent_image)
        latent["samples"] = latent_image["samples"]

        def callback(*_args, **_kwargs):
            observed_nfe[0] += 1
            from .attention_execution import set_evaluation

            set_evaluation(observed_nfe[0])
            if step_marks is not None:
                step_marks.append(time.perf_counter())

        if hasattr(conditioning, "sample"):
            try:
                import comfy.sample

                latent["samples"] = comfy.sample.fix_empty_latent_channels(
                    conditioning.model_patcher,
                    latent["samples"],
                    latent.get("downscale_ratio_spacial"),
                    latent.get("downscale_ratio_temporal"),
                )
            except (ImportError, AttributeError):
                pass

            def _guider_sample(noise, latent_samples, stage_sigmas):
                return conditioning.sample(
                    noise,
                    latent_samples,
                    sampler,
                    stage_sigmas,
                    denoise_mask=latent.get("noise_mask"),
                    callback=callback,
                    disable_pbar=True,
                    seed=seed,
                )

            noise = (_noise(seed) if noise_stream is None else noise_stream).generate_noise(latent)
            samples = _guider_sample(noise, latent["samples"], sigmas)
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            out["samples"] = samples
            return out

        import comfy.sample

        def _custom_sample(noise, latent_samples, stage_sigmas):
            return comfy.sample.sample_custom(
                model,
                noise,
                1.0,
                sampler,
                stage_sigmas,
                conditioning,
                None,
                latent_samples,
                noise_mask=latent.get("noise_mask"),
                callback=callback,
                disable_pbar=True,
                seed=seed,
            )

        noise = (_noise(seed) if noise_stream is None else noise_stream).generate_noise(latent)
        samples = _custom_sample(noise, latent["samples"], sigmas)
        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = samples
        return out
