"""DMAD's four-step re-noise sampler adapted to ComfyUI's native MiniMax-H3 model.

The Comfy model is one packed audio/video denoiser. ``ModelSamplingAV`` and the
stock H3 forward preserve its distinct audio clock; this sampler supplies the
joint sigma grid and re-noise updates used to train the released DMAD adapter.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

import torch

DMAD_STEP_COUNT = 4
DMAD_VIDEO_SHIFT = 12.0
DMAD_AUDIO_SHIFT = 2.0
DMAD_SAMPLING_CONTRACT = "dmad-h3-4step-renoise/1"
AUDIO_LATENTS_PER_SECOND = 40
VIDEO_FPS = 24
AUDIO_CHANNELS = 2
AUDIO_LATENT_CHANNELS = 32


class DmadSamplingError(RuntimeError):
    """The workflow cannot satisfy the supported DMAD sampling contract."""


def _shift_sigma(sigma: torch.Tensor, shift: float) -> torch.Tensor:
    return shift * sigma / (1.0 + (shift - 1.0) * sigma)


def sigma_grid(steps: int = DMAD_STEP_COUNT, shift: float = DMAD_VIDEO_SHIFT) -> torch.Tensor:
    """Return DMAD's shifted linear grid (points = model calls + terminal zero)."""
    if type(steps) is not int or steps != DMAD_STEP_COUNT:
        raise ValueError(f"DMAD H3 adapters require exactly {DMAD_STEP_COUNT} model evaluations")
    if not isinstance(shift, (int, float)) or not torch.isfinite(torch.tensor(float(shift))) or shift <= 0:
        raise ValueError("sigma shift must be a positive finite number")
    return _shift_sigma(torch.linspace(1.0, 0.0, steps + 1, dtype=torch.float32), float(shift))


def modality_sigma_grids() -> tuple[torch.Tensor, torch.Tensor]:
    """The reference has four joint calls but separate audio and video clocks."""
    return sigma_grid(shift=DMAD_VIDEO_SHIFT), sigma_grid(shift=DMAD_AUDIO_SHIFT)


def _latent_parts(value: Any, latent_shapes: tuple[tuple[int, ...], ...] | None = None
                  ) -> tuple[torch.Tensor, torch.Tensor]:
    if isinstance(value, dict):
        value = value.get("samples")
    if isinstance(value, (tuple, list)):
        parts = tuple(value)
    elif isinstance(value, torch.Tensor) and value.is_nested:
        parts = tuple(value.unbind())
    elif isinstance(getattr(value, "tensors", None), (tuple, list)):
        # ComfyUI 0.36 represents H3 audio/video latents with its own
        # NestedTensor wrapper; it is not a torch nested Tensor.
        parts = tuple(value.tensors)
    elif isinstance(value, torch.Tensor) and latent_shapes and value.ndim == 3:
        # Comfy packs H3 streams as [batch, 1, concatenated] at the sampler
        # boundary. Retain the original component shapes for every re-noise step.
        remaining = value
        unpacked = []
        for shape in latent_shapes:
            elements = math.prod(shape[1:])
            unpacked.append(remaining[:, :, :elements].reshape((shape[0], *shape[1:])))
            remaining = remaining[:, :, elements:]
        if remaining.numel() != 0:
            raise DmadSamplingError("Packed DMAD latent has trailing elements beyond its saved stream shapes")
        parts = tuple(unpacked)
    else:
        raise DmadSamplingError(
            "DMAD noise requires a nested (video, audio) H3 latent; "
            f"received {type(value).__module__}.{type(value).__qualname__}"
        )
    if len(parts) != 2 or not all(isinstance(part, torch.Tensor) for part in parts):
        raise DmadSamplingError("DMAD latent must contain exactly video and audio tensors")
    video, audio = parts
    if video.ndim != 5 or video.shape[0] != 1 or video.shape[1] != 24:
        raise DmadSamplingError(f"Unsupported DMAD video latent shape: {tuple(video.shape)}")
    if (audio.ndim != 4 or audio.shape[0] != 1 or audio.shape[1] != AUDIO_LATENT_CHANNELS
            or audio.shape[2] != AUDIO_CHANNELS):
        raise DmadSamplingError(f"Unsupported DMAD stereo audio latent shape: {tuple(audio.shape)}")
    return video, audio


def _pack_latent_parts(video: torch.Tensor, audio: torch.Tensor, *, nested: bool) -> Any:
    if nested:
        import comfy.nested_tensor

        return comfy.nested_tensor.NestedTensor([video, audio])
    return [video, audio]


def _pack_like(value: Any, video: torch.Tensor, audio: torch.Tensor) -> Any:
    if isinstance(value, torch.Tensor) and not value.is_nested:
        return torch.cat((video.reshape(video.shape[0], 1, -1),
                          audio.reshape(audio.shape[0], 1, -1)), dim=-1)
    if isinstance(value, torch.Tensor) and value.is_nested:
        return torch.nested.nested_tensor([video, audio])
    if hasattr(value, "tensors"):
        return _pack_latent_parts(video, audio, nested=True)
    if isinstance(value, tuple):
        return (video, audio)
    return [video, audio]


@dataclass
class DmadNoiseStream:
    """One inference's CPU RNG; initial and four fresh-noise draws share state."""

    seed: int
    generator: torch.Generator = field(init=False)
    initial_draws: int = 0
    resample_draws: int = 0
    _initial_complete: bool = False
    _latent_shapes: tuple[tuple[int, ...], ...] | None = None

    def __post_init__(self) -> None:
        if type(self.seed) is not int or self.seed < 0 or self.seed > 0x7FFFFFFFFFFFFFFF:
            raise ValueError("DMAD seed must be a non-negative signed 64-bit integer")
        self.generator = torch.Generator(device="cpu").manual_seed(self.seed)

    def _draw(self, video: torch.Tensor, audio: torch.Tensor, *, fresh: bool = False
              ) -> tuple[torch.Tensor, torch.Tensor]:
        # The released sampler draws video noise first, then the two channel-major
        # audio row blocks from the same CPU generator, before moving to the worker.
        if fresh:
            batch, channels, frames, height, width = video.shape
            if height % 2 or width % 2:
                raise DmadSamplingError("DMAD fresh noise requires the H3 1x2x2 patch grid")
            rows = torch.randn(
                (batch, frames * (height // 2) * (width // 2), channels * 4),
                generator=self.generator, dtype=torch.float32,
            )
            video_noise = rows.reshape(
                batch, frames, height // 2, width // 2, channels, 2, 2,
            ).permute(0, 4, 1, 2, 5, 3, 6).reshape(video.shape)
        else:
            video_noise = torch.randn(video.shape, generator=self.generator, dtype=torch.float32)
        audio_t = int(audio.shape[-1])
        audio_rows = torch.randn(
            (audio_t * AUDIO_CHANNELS, AUDIO_LATENT_CHANNELS),
            generator=self.generator,
            dtype=torch.float32,
        )
        audio_noise = (
            audio_rows.reshape(AUDIO_CHANNELS, audio_t, AUDIO_LATENT_CHANNELS)
            .permute(2, 0, 1)
            .unsqueeze(0)
        )
        return (
            video_noise.to(device=video.device, dtype=video.dtype),
            audio_noise.to(device=audio.device, dtype=audio.dtype),
        )

    def initial_noise(self, latent: Any) -> Any:
        if self._initial_complete:
            raise DmadSamplingError("DMAD initial noise can be generated only once per inference")
        video, audio = _latent_parts(latent)
        self._latent_shapes = (tuple(video.shape), tuple(audio.shape))
        parts = self._draw(video, audio)
        self.initial_draws = 2
        self._initial_complete = True
        samples = latent.get("samples") if isinstance(latent, dict) else latent
        nested = (isinstance(samples, torch.Tensor) and samples.is_nested) or hasattr(samples, "tensors")
        return _pack_latent_parts(*parts, nested=nested)

    def fresh_noise_like(self, latent: Any) -> Any:
        if not self._initial_complete:
            raise DmadSamplingError("Generate DMAD initial video/audio noise before sampling")
        video, audio = _latent_parts(latent, self._latent_shapes)
        parts = self._draw(video, audio, fresh=True)
        self.resample_draws += 2
        samples = latent.get("samples") if isinstance(latent, dict) else latent
        return _pack_like(samples, *parts)


def _video_reference(value: Any) -> torch.Tensor:
    return _latent_parts(value)[0]


def renoise_sample(
    model: Any,
    x: Any,
    sigmas: torch.Tensor,
    *,
    noise_stream: DmadNoiseStream,
    extra_args: dict[str, Any] | None = None,
    callback: Any = None,
) -> Any:
    """K-diffusion sampler callback implementing DMAD's denoise/re-noise rule.

    ``model`` is Comfy's ``KSamplerX0Inpaint`` wrapper, so each call returns the
    clean sample in the same common audio/video space as ``x``. H3 ModelSamplingAV
    carries/restores the audio clock around that model call.
    """
    if not isinstance(sigmas, torch.Tensor) or sigmas.ndim != 1 or sigmas.numel() != 5:
        raise DmadSamplingError("DMAD H3 requires a 5-point sigma grid for four evaluations")
    values = sigmas.detach().to(device="cpu", dtype=torch.float32).tolist()
    expected = sigma_grid()
    if not torch.allclose(torch.tensor(values), expected, atol=2e-7, rtol=2e-7):
        raise DmadSamplingError("Sigma grid differs from the DMAD four-step video shift-12 contract")
    if not noise_stream._initial_complete:
        raise DmadSamplingError("DMAD initial noise and sampler must share the same run-scoped noise stream")
    if noise_stream.resample_draws:
        raise DmadSamplingError("A DMAD noise stream cannot be reused by another inference")
    args = {} if extra_args is None else extra_args
    total = len(values) - 1
    for i, (sigma, sigma_next) in enumerate(pairwise(values)):
        video, _audio = _latent_parts(x, noise_stream._latent_shapes)
        timestep = torch.full(
            (video.shape[0],), sigma, device=video.device, dtype=torch.float32,
        )
        denoised = model(x, timestep, **args)
        denoised_video, denoised_audio = _latent_parts(denoised, noise_stream._latent_shapes)
        fresh = noise_stream.fresh_noise_like(x)
        fresh_video, fresh_audio = _latent_parts(fresh, noise_stream._latent_shapes)
        x = _pack_like(x,
            (1.0 - sigma_next) * denoised_video.float() + sigma_next * fresh_video.float(),
            (1.0 - sigma_next) * denoised_audio.float() + sigma_next * fresh_audio.float(),
        )
        if callback is not None:
            callback({"i": i, "x": x, "denoised": denoised, "sigma": sigma,
                      "sigma_hat": sigma, "total_steps": total})
    return x


def build_comfy_dmad_sampler(noise_stream: DmadNoiseStream) -> tuple[Any, Any, torch.Tensor]:
    """Create stock Comfy Sampler/Noise wrappers without global registration."""
    import comfy.samplers

    class Noise:
        def __init__(self, stream: DmadNoiseStream):
            self.stream = stream
            self.seed = stream.seed

        def generate_noise(self, latent: Any) -> Any:
            return self.stream.initial_noise(latent)

    def sample_fn(model, x, sigmas, extra_args=None, callback=None, disable=None, **_kwargs):
        del disable
        return renoise_sample(model, x, sigmas, noise_stream=noise_stream,
                              extra_args=extra_args, callback=callback)

    return (
        comfy.samplers.KSAMPLER(sample_fn),
        Noise(noise_stream),
        sigma_grid(),
    )


def shift_comfy_model(model: Any, *, video_shift: float = DMAD_VIDEO_SHIFT,
                       audio_shift: float = DMAD_AUDIO_SHIFT) -> Any:
    """Clone an H3 patcher and set its native ModelSamplingAV dual-clock shifts."""
    import comfy.model_sampling

    sampling_av = getattr(comfy.model_sampling, "ModelSamplingAV", None)
    if sampling_av is None:
        raise DmadSamplingError("Pinned ComfyUI must provide MiniMax-H3 ModelSamplingAV")
    if (not isinstance(video_shift, (int, float)) or not torch.isfinite(torch.tensor(float(video_shift)))
            or video_shift <= 0 or not isinstance(audio_shift, (int, float))
            or not torch.isfinite(torch.tensor(float(audio_shift))) or audio_shift <= 0):
        raise DmadSamplingError("DMAD video/audio shifts must be positive finite values")

    # Pinned Comfy H3 returns negated raw velocity. Its stock CONST subtraction
    # therefore implements upstream DMAD's x0 = xt + sigma * raw_velocity.
    ModelSamplingAVDmad = type(
        "ModelSamplingAVDmad", (sampling_av, comfy.model_sampling.CONST), {},
    )

    clone = model.clone()
    original = model.get_model_object("model_sampling")
    candidate = ModelSamplingAVDmad(model.model.model_config)
    candidate.set_parameters(
        shift=float(video_shift),
        audio_shift=float(audio_shift),
        multiplier=getattr(original, "multiplier", 1000),
    )
    if hasattr(original, "noise_scale"):
        candidate.set_noise_scale(original.noise_scale)
    clone.add_object_patch("model_sampling", candidate)
    options = dict(clone.model_options.get("transformer_options", {}))
    options.update(
        minimax_h3_sigma_shift_video=float(video_shift),
        minimax_h3_sigma_shift_audio=float(audio_shift),
    )
    clone.model_options["transformer_options"] = options
    return clone


__all__ = [
    "AUDIO_CHANNELS",
    "AUDIO_LATENT_CHANNELS",
    "DMAD_AUDIO_SHIFT",
    "DMAD_SAMPLING_CONTRACT",
    "DMAD_STEP_COUNT",
    "DMAD_VIDEO_SHIFT",
    "DmadNoiseStream",
    "DmadSamplingError",
    "build_comfy_dmad_sampler",
    "modality_sigma_grids",
    "renoise_sample",
    "shift_comfy_model",
    "sigma_grid",
]
