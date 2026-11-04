"""Two-stage spectral progressive sampling for FastH3 (P1).

Algorithm: Xiao et al., Spectral Progressive Diffusion, arXiv:2605.18736.
DCT expand + kappa alignment match the MIT reference
https://github.com/howardhx/speed (not the PolyForm-NC Comfy H3 port).

Default is off. Only two spatial stages (0.5 then 1.0) fit this repo's four
Euler evaluations. Audio stays full resolution. Temporal length is unchanged.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import torch

# Baked on many-step MiniMax-H3 harvest (r^2 ~0.60). Re-harvest on the 4-step
# VSA checkpoint if the clip looks wrong; these only place the boundary.
DEFAULT_A = 7.394
DEFAULT_BETA = 0.62
DEFAULT_DELTA = 0.01
COARSE_SCALE = 0.5
SEED_OFFSET = 10_000


def even_spatial(n: int) -> int:
    """H3 2x2 patchify needs even latent H/W."""
    n = max(2, int(n))
    return n if n % 2 == 0 else n + 1


def coarse_hw(full_h: int, full_w: int, scale: float = COARSE_SCALE) -> tuple[int, int]:
    return even_spatial(round(full_h * scale)), even_spatial(round(full_w * scale))


def power_spectrum(omega: float, amplitude: float, beta: float) -> float:
    return float(amplitude) * abs(float(omega)) ** (-float(beta))


def activation_time(p_omega: float, delta: float) -> float:
    """Paper Eq. 9. Returns a time in (0, 1)."""
    if not 0.0 < delta < 1.0:
        raise ValueError("delta must be in (0, 1)")
    return 1.0 / (1.0 + math.sqrt(delta / (p_omega * (1.0 + p_omega - delta))))


def unit_interval(t: float) -> float:
    """Clamp a scheduler sigma into (0, 1) so kappa is defined."""
    return min(max(float(t), 1e-4), 1.0 - 1e-4)


def kappa(t: float, ratio: float) -> float:
    """Paper Eq. 5. ``ratio`` is s_{i+1}/s_i."""
    t = unit_interval(t)
    ratio = float(ratio)
    if ratio <= 1.0:
        raise ValueError("resolution ratio must be greater than 1")
    return ratio / (1.0 + (ratio - 1.0) * t)


def align_timestep(t: float, ratio: float) -> float:
    """Paper Eq. 6."""
    return float(t) * kappa(t, ratio)


def find_first_step_below(sigmas, threshold: float) -> int:
    values = [float(s) for s in sigmas]
    n_steps = len(values) - 1
    for index in range(n_steps):
        if values[index] <= threshold:
            return index
    return n_steps


def plan_two_stage_boundary(
    sigmas,
    *,
    boundary_step: int = 2,
    mode: str = "explicit",
    delta: float = DEFAULT_DELTA,
    amplitude: float = DEFAULT_A,
    beta: float = DEFAULT_BETA,
    full_h: int | None = None,
    full_w: int | None = None,
) -> int:
    """Index into ``sigmas`` where stage 0 ends (``0 < boundary < n_steps``)."""
    n_steps = len(list(sigmas)) - 1
    if n_steps < 4:
        raise ValueError("SPEED 2-stage needs at least four Euler evaluations")
    if mode == "explicit":
        boundary = int(boundary_step)
    elif mode == "delta":
        if full_h is None or full_w is None:
            raise ValueError("delta mode needs full latent H and W")
        omega = COARSE_SCALE * min(int(full_h), int(full_w)) / 2.0
        threshold = activation_time(power_spectrum(omega, amplitude, beta), delta)
        boundary = find_first_step_below(sigmas, threshold)
    else:
        raise ValueError("mode must be 'explicit' or 'delta'")
    if not 0 < boundary < n_steps:
        raise ValueError(
            f"SPEED boundary {boundary} is outside (0, {n_steps}); "
            "four-step schedules only fit an interior 2-stage cut"
        )
    return boundary


def _dct_matrix(size: int, device, dtype) -> torch.Tensor:
    sample = torch.arange(size, device=device, dtype=dtype) + 0.5
    frequency = torch.arange(size, device=device, dtype=dtype).unsqueeze(1)
    basis = torch.cos((math.pi / size) * frequency * sample)
    basis[0] *= math.sqrt(1.0 / size)
    if size > 1:
        basis[1:] *= math.sqrt(2.0 / size)
    return basis


def dct2(value: torch.Tensor) -> torch.Tensor:
    work = value.float()
    height, width = work.shape[-2:]
    flat = work.reshape(-1, height, width)
    height_basis = _dct_matrix(height, work.device, work.dtype)
    width_basis = _dct_matrix(width, work.device, work.dtype)
    transformed = torch.matmul(height_basis, flat)
    transformed = torch.matmul(transformed, width_basis.transpose(0, 1))
    return transformed.reshape(work.shape)


def idct2(coefficients: torch.Tensor) -> torch.Tensor:
    work = coefficients.float()
    height, width = work.shape[-2:]
    flat = work.reshape(-1, height, width)
    height_basis = _dct_matrix(height, work.device, work.dtype)
    width_basis = _dct_matrix(width, work.device, work.dtype)
    restored = torch.matmul(height_basis.transpose(0, 1), flat)
    restored = torch.matmul(restored, width_basis)
    return restored.reshape(work.shape)


def dct_lowpass(value: torch.Tensor, target_hw: tuple[int, int]) -> torch.Tensor:
    target_h, target_w = int(target_hw[0]), int(target_hw[1])
    source_h, source_w = value.shape[-2:]
    if target_h > source_h or target_w > source_w:
        raise ValueError("lowpass target cannot exceed source")
    return idct2(dct2(value)[..., :target_h, :target_w]).to(dtype=value.dtype)


def spectral_expand_dct(
    value: torch.Tensor,
    target_hw: tuple[int, int],
    time: float,
    seed: int,
) -> torch.Tensor:
    """DCT-domain high-frequency fill (paper / howardhx/speed MIT)."""
    target_h, target_w = int(target_hw[0]), int(target_hw[1])
    source_h, source_w = value.shape[-2:]
    if target_h < source_h or target_w < source_w:
        raise ValueError("DCT cannot expand to a smaller grid")
    source_coefficients = dct2(value)
    generator = torch.Generator(device="cpu")
    generator.manual_seed(int(seed))
    fill = torch.randn(
        value.shape[:-2] + (target_h, target_w),
        generator=generator,
        dtype=torch.float32,
    ) * float(time)
    expanded = fill.to(device=value.device)
    expanded[..., :source_h, :source_w] = source_coefficients
    return idct2(expanded).to(dtype=value.dtype)


def expand_and_align(
    value: torch.Tensor,
    target_hw: tuple[int, int],
    time: float,
    ratio: float,
    seed: int,
) -> tuple[torch.Tensor, float]:
    expanded = spectral_expand_dct(value, target_hw, time, seed)
    scale = kappa(time, ratio)
    return expanded * scale, align_timestep(time, ratio)


class _StreamPack:
    is_nested = True

    def __init__(self, streams: list[torch.Tensor]):
        self._streams = list(streams)

    def unbind(self):
        return list(self._streams)


def unpack_streams(samples) -> list[torch.Tensor] | None:
    if samples is None:
        return None
    if getattr(samples, "is_nested", False) and hasattr(samples, "unbind"):
        return list(samples.unbind())
    if torch.is_tensor(samples) and samples.ndim == 5:
        return [samples]
    return None


def pack_streams(streams: list[torch.Tensor]):
    if len(streams) == 1:
        return streams[0]
    try:
        from comfy.nested_tensor import NestedTensor
        return NestedTensor(list(streams))
    except Exception:  # noqa: BLE001 - nested tensor is optional
        return _StreamPack(list(streams))


def move_streams(streams: list[torch.Tensor], device) -> list[torch.Tensor]:
    """H3 pack_latents cats streams; every tensor must share one device."""
    aligned = []
    for tensor in streams:
        if torch.is_tensor(tensor) and tensor.device != device:
            aligned.append(tensor.to(device))
        else:
            aligned.append(tensor)
    return aligned


def _zeros_like_shape(template: torch.Tensor, spatial_hw: tuple[int, int] | None = None) -> torch.Tensor:
    if spatial_hw is None or template.ndim < 2:
        return torch.zeros_like(template)
    shape = list(template.shape)
    shape[-2], shape[-1] = int(spatial_hw[0]), int(spatial_hw[1])
    return template.new_zeros(shape)


def run_two_stage(
    *,
    noise,
    latent_samples,
    sigmas,
    sample_fn: Callable[..., Any],
    seed: int,
    boundary_step: int = 2,
    schedule_mode: str = "explicit",
    delta: float = DEFAULT_DELTA,
    amplitude: float = DEFAULT_A,
    beta: float = DEFAULT_BETA,
) -> tuple[Any, dict[str, Any]]:
    """Run 0.5 then 1.0 spatial stages. ``sample_fn(noise, latent, sigmas) -> samples``."""
    streams = unpack_streams(latent_samples)
    noise_streams = unpack_streams(noise)
    if streams is None or noise_streams is None or len(streams) != len(noise_streams):
        raise ValueError("SPEED needs a 5D video latent or an H3 NestedTensor")
    video = streams[0]
    if video.ndim != 5:
        raise ValueError("SPEED video stream must be [B,C,T,H,W]")
    full_h, full_w = int(video.shape[-2]), int(video.shape[-1])
    coarse_h, coarse_w = coarse_hw(full_h, full_w)
    target_device = video.device
    streams = move_streams(streams, target_device)
    noise_streams = move_streams(noise_streams, target_device)
    boundary = plan_two_stage_boundary(
        sigmas,
        boundary_step=boundary_step,
        mode=schedule_mode,
        delta=delta,
        amplitude=amplitude,
        beta=beta,
        full_h=full_h,
        full_w=full_w,
    )
    sigma_list = list(sigmas)
    device = getattr(sigmas, "device", target_device)
    dtype = getattr(sigmas, "dtype", torch.float32)

    def _as_sigmas(values: list[float]):
        if torch.is_tensor(sigmas):
            return torch.tensor(values, device=device, dtype=dtype)
        return values

    coarse_noise_video = dct_lowpass(noise_streams[0], (coarse_h, coarse_w)).to(device=target_device)
    coarse_latent = [_zeros_like_shape(video, (coarse_h, coarse_w))]
    coarse_noise = [coarse_noise_video]
    for extra_latent, extra_noise in zip(streams[1:], noise_streams[1:]):
        coarse_latent.append(_zeros_like_shape(extra_latent, None))
        coarse_noise.append(extra_noise.to(device=target_device))

    stage1 = sample_fn(
        pack_streams(move_streams(coarse_noise, target_device)),
        pack_streams(move_streams(coarse_latent, target_device)),
        _as_sigmas([float(s) for s in sigma_list[: boundary + 1]]),
    )
    stage1_streams = unpack_streams(stage1)
    if stage1_streams is None:
        raise ValueError("SPEED stage 1 did not return a packed latent")
    stage1_streams = move_streams(stage1_streams, target_device)
    time = unit_interval(float(sigma_list[boundary]))
    ratio = 1.0 / COARSE_SCALE
    expanded_video, t_tilde = expand_and_align(
        stage1_streams[0],
        (full_h, full_w),
        time,
        ratio,
        seed + SEED_OFFSET,
    )
    next_noise = [expanded_video]
    next_latent = [_zeros_like_shape(video, (full_h, full_w))]
    for extra in stage1_streams[1:]:
        next_noise.append(extra)
        next_latent.append(_zeros_like_shape(extra, None))
    tail = [float(s) for s in sigma_list[boundary + 1 :]]
    stage2 = sample_fn(
        pack_streams(move_streams(next_noise, target_device)),
        pack_streams(move_streams(next_latent, target_device)),
        _as_sigmas([t_tilde, *tail]),
    )
    plan = {
        "enabled": True,
        "stages": 2,
        "scales": [COARSE_SCALE, 1.0],
        "boundary_step": boundary,
        "coarse_hw": [coarse_h, coarse_w],
        "full_hw": [full_h, full_w],
        "t": time,
        "t_tilde": t_tilde,
        "kappa": kappa(time, ratio),
        "schedule_mode": schedule_mode,
    }
    return stage2, plan
