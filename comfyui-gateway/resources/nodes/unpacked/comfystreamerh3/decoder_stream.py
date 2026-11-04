"""Overlap compact encode with finalized VAE temporal chunks.

Comfy's ``MiniMaxH3VideoVAE.decode_temporal`` already finalizes overlap-complete
pixels in ``write_part`` after the temporal blend. This module intercepts those
``copy_`` writes so D2H/encode can run while the next latent chunk still runs
on GPU. Spatial tiles are never streamed; only blend-complete temporal parts
are. If the VAE has no native ``decode_temporal``, the same control flow is
replayed in Python.

Video decode cannot start during DiT sampling: the clip latent exists only
after the last Euler step. ``overlap_output`` hides encode behind decode (and
lets the encode queue drain during serial audio decode). It does not hide the
~4 s VAE behind the ~17 s sampler.

"""
from __future__ import annotations

import logging
import math
import os
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import torch

_SESSIONS: dict[str, Any] = {}
_SESSION_LOCK = threading.Lock()
_SESSION_CONDITION = threading.Condition(_SESSION_LOCK)
_SESSION_DEADLINES: dict[str, float] = {}
_SESSION_REAPER: threading.Thread | None = None
_ABANDONING_SESSIONS = 0
_MAX_STREAM_SESSIONS = 8
_STREAM_SESSION_TIMEOUT_SECONDS = 300.0
logger = logging.getLogger(__name__)
_WRITE_HOOK = threading.local()


class _NotifyTensor(torch.Tensor):
    """Tensor subclass whose ``copy_`` reports writes into the decode canvas."""

    def copy_(self, other, non_blocking=False, **kwargs):  # type: ignore[override]
        hook = getattr(_WRITE_HOOK, "state", None)
        if (
            hook is not None
            and isinstance(other, torch.Tensor)
            and other.ndim == 5
            and other.shape[2] > 0
        ):
            try:
                same = self.untyped_storage().data_ptr() == hook["root"].untyped_storage().data_ptr()
            except (AttributeError, RuntimeError):
                same = False
            if same:
                hook["fn"](other)
        return super().copy_(other, non_blocking=non_blocking, **kwargs)


def _allocate_decode_buffer(vae, z: torch.Tensor) -> torch.Tensor:
    shape_fn = getattr(vae, "decode_output_shape", None)
    if callable(shape_fn):
        shape = shape_fn(z.shape)
    else:
        pad_tokens, num_chunks = decode_temporal_chunks(vae, z.shape[2])
        frames = decode_temporal_frame_plan(vae, z.shape[2] + pad_tokens, num_chunks, pad_tokens)
        spatial = getattr(vae, "vae_ratio", 1)
        if not isinstance(spatial, int):
            spatial = 1
        shape = (z.shape[0], 3, frames, z.shape[3] * spatial, z.shape[4] * spatial)
    return torch.empty(shape, dtype=torch.float32, device=_output_device(z))

_STREAM_ATTRS = (
    "tokens_chunk_size",
    "token_overlap",
    "token_drop",
    "frame_pre_padding",
    "frame_overlap",
    "vae_ratio_t",
)


def require_stream_finalized_tiles(enabled: bool) -> None:
    """Enforce the fixed B1 streaming contract at the decode boundary."""
    if not enabled:
        raise ValueError("FastH3 baseline requires stream_finalized_tiles=True")


def resolve_output_overlap(overlap_output: bool, stream_finalized_tiles: bool) -> tuple[bool, bool]:
    """Map user-facing overlap to stream-encode + skip concurrent audio VAE.

    Returns ``(stream_encode, skip_audio_thread)``. Concurrent audio VAE races
    Comfy ``free_memory``. Any stream-encode path (overlap_output or the inner
    stream_finalized_tiles switch) keeps audio serial so the encode queue can
    drain after video decode instead of racing the allocator.
    """
    stream = bool(overlap_output or stream_finalized_tiles)
    return stream, stream


def temporal_owner(vae):
    inner = getattr(vae, "first_stage_model", None)
    for obj in (inner, vae):
        if obj is None:
            continue
        if callable(getattr(obj, "decode_temporal", None)) or callable(
            getattr(obj, "_adaptive_decode", None)
        ):
            return obj
    return None


def can_stream_temporal(vae) -> bool:
    owner = temporal_owner(vae)
    if owner is None:
        return False
    if not callable(getattr(owner, "_adaptive_decode", None)):
        return False
    if not callable(getattr(owner, "blend", None)):
        return False
    return all(hasattr(owner, name) for name in _STREAM_ATTRS)


def decode_temporal_chunks(vae, z_len: int) -> tuple[int, int]:
    native = getattr(vae, "_decode_temporal_chunks", None)
    if callable(native):
        return native(z_len)
    token_drop = int(vae.token_drop)
    chunk = int(vae.tokens_chunk_size)
    pseudo_total_tokens = z_len + token_drop
    pad_tokens = (-pseudo_total_tokens) % chunk
    pseudo_total_tokens += pad_tokens
    num_chunks = pseudo_total_tokens // chunk - int(token_drop > 0)
    if num_chunks < 1:
        pad_tokens += chunk
        num_chunks += 1
    return pad_tokens, num_chunks


def decode_temporal_pad_frames(vae, z_len: int, pad_tokens: int) -> int:
    native = getattr(vae, "_decode_temporal_pad_frames", None)
    if callable(native):
        return native(z_len, pad_tokens)
    if pad_tokens <= 0:
        return 0
    intra_tail = int(vae.clip_length) % int(vae.vae_ratio_t)
    if intra_tail == 0:
        return pad_tokens * int(vae.vae_ratio_t)
    z_len_before_pad = z_len - pad_tokens
    return sum(
        (intra_tail if (z_len_before_pad + k) % int(vae.tokens_chunk_size) == 0
         else int(vae.vae_ratio_t))
        for k in range(pad_tokens)
    )


def decode_temporal_frame_plan(vae, z_len: int, num_chunks: int, pad_tokens: int) -> int:
    native = getattr(vae, "_decode_temporal_frame_plan", None)
    if callable(native):
        return native(z_len, num_chunks, pad_tokens)
    chunk_dec = int(vae.tokens_chunk_size) * int(vae.vae_ratio_t)
    split_count = int(int(vae.token_drop) > 0) + 1
    total_frames = 0
    final_overlap_frames = 0
    for i in range(num_chunks):
        t_start_idx = i * int(vae.tokens_chunk_size)
        t_end_idx = t_start_idx + int(vae.tokens_chunk_size) + int(vae.token_overlap)
        clip_token_len = max(0, min(t_end_idx, z_len) - min(t_start_idx, z_len))
        clip_frame_len = clip_token_len * int(vae.vae_ratio_t)
        for j in range(split_count):
            f_start_idx = j * chunk_dec
            f_end_idx = min(f_start_idx + chunk_dec, clip_frame_len)
            chunk_frames = max(0, f_end_idx - f_start_idx - int(vae.frame_pre_padding))
            if j == 0:
                total_frames += chunk_frames
            else:
                final_overlap_frames = chunk_frames
    total_frames += final_overlap_frames
    return total_frames - decode_temporal_pad_frames(vae, z_len, pad_tokens)


def bcthw_to_nhwc(part: torch.Tensor) -> torch.Tensor:
    batch, _channels, time, height, width = part.shape
    return part.permute(0, 2, 3, 4, 1).reshape(batch * time, height, width, part.shape[1])


def _output_device(z: torch.Tensor):
    try:
        import comfy.model_management as mm
        return mm.intermediate_device()
    except (ImportError, AttributeError, RuntimeError):
        return z.device


def _finalize_pixels(vae, part: torch.Tensor) -> torch.Tensor:
    fn = getattr(vae, "_finalize_pixels", None)
    if callable(fn):
        return fn(part)
    return part


def decode_temporal_streaming(
    vae,
    z: torch.Tensor,
    output_buffer: torch.Tensor | None = None,
    on_finalized: Callable[[torch.Tensor], None] | None = None,
    *,
    retain_cpu: bool = False,
) -> torch.Tensor:
    """Same control flow as pinned MiniMaxH3VideoVAE.decode_temporal, plus emit."""
    if retain_cpu:
        raise ValueError("CPU-retained decode canvas is not part of the product path")
    chunk_dec = int(vae.tokens_chunk_size) * int(vae.vae_ratio_t)
    split_count = int(int(vae.token_drop) > 0) + 1
    if output_buffer is None:
        output_buffer = _allocate_decode_buffer(vae, z)

    pad_tokens, num_chunks = decode_temporal_chunks(vae, z.shape[2])
    if pad_tokens > 0:
        pad_z = z[:, :, -1:, :, :].repeat(1, 1, pad_tokens, 1, 1)
        z = torch.cat([z, pad_z], dim=2)

    dec = output_buffer
    dec_overlap = None
    write_pos = 0

    def write_part(part: torch.Tensor) -> None:
        nonlocal write_pos
        part_frames = part.shape[2]
        if part_frames <= 0:
            return
        copy_frames = min(part_frames, max(0, dec.shape[2] - write_pos))
        part = _finalize_pixels(vae, part)
        if copy_frames > 0:
            emitted = part[:, :, :copy_frames, :, :]
            if on_finalized is not None:
                on_finalized(emitted)
            dec[:, :, write_pos:write_pos + copy_frames, :, :].copy_(emitted)
        write_pos += copy_frames

    for i in range(num_chunks):
        t_start_idx = i * int(vae.tokens_chunk_size)
        t_end_idx = t_start_idx + int(vae.tokens_chunk_size) + int(vae.token_overlap)
        clip_z = z[:, :, t_start_idx:t_end_idx, :, :]
        clip_dec = vae._adaptive_decode(clip_z)
        for j in range(split_count):
            f_start_idx = j * chunk_dec
            f_end_idx = min(f_start_idx + chunk_dec, clip_dec.shape[2])
            clip_dec_chunk = clip_dec[:, :, f_start_idx:f_end_idx, :, :]
            clip_dec_chunk = clip_dec_chunk[:, :, int(vae.frame_pre_padding):, :, :]
            if j == 0:
                if dec_overlap is not None:
                    clip_dec_chunk = vae.blend(
                        dec_overlap, clip_dec_chunk, int(vae.frame_overlap), dim=-3
                    )
                    dec_overlap = None
                write_part(clip_dec_chunk)
            else:
                dec_overlap = clip_dec_chunk.contiguous()
        if i == num_chunks - 1 and dec_overlap is not None:
            write_part(dec_overlap)
            dec_overlap = None
        del clip_dec, clip_z
    return dec


@contextmanager
def wrap_decode_temporal(vae, on_finalized: Callable[[torch.Tensor], None], *,
                         retain_cpu: bool = False) -> Iterator[dict[str, Any]]:
    if retain_cpu:
        raise ValueError("CPU-retained decode canvas is not part of the product path")
    owner = temporal_owner(vae)
    if owner is None or not can_stream_temporal(owner):
        yield {"mode": "fallback_full_decode", "reason": "vae_missing_decode_temporal"}
        return
    original = getattr(owner, "decode_temporal", None)
    had_original = "decode_temporal" in owner.__dict__
    saved_original = owner.__dict__.get("decode_temporal")

    def wrapped(z, output_buffer=None):
        if callable(original):
            if output_buffer is None:
                output_buffer = _allocate_decode_buffer(owner, z)
            canvas = output_buffer.as_subclass(_NotifyTensor)
            previous = getattr(_WRITE_HOOK, "state", None)
            state = {"root": canvas, "fn": on_finalized}
            _WRITE_HOOK.state = state
            try:
                result = original(z, canvas)
            finally:
                _WRITE_HOOK.state = previous
            return canvas if result is None else result
        return decode_temporal_streaming(owner, z, output_buffer, on_finalized)

    owner.decode_temporal = wrapped
    try:
        yield {"mode": "temporal_write_part" if callable(original) else "temporal_write_part_replay"}
    finally:
        if had_original:
            owner.decode_temporal = saved_original
        else:
            owner.__dict__.pop("decode_temporal", None)


def compact_settings_for_backend(backend: str) -> dict[str, Any] | None:
    if backend == "reference":
        return None
    if backend == "nvenc":
        return {"preset": "veryfast", "codec": "h264_nvenc", "crf": 23}
    if backend == "compact":
        return {"preset": "medium", "codec": "libx264", "crf": 23}
    if backend in ("veryfast", "parallel"):
        return {"preset": "veryfast", "codec": "libx264", "crf": 23}
    raise ValueError(f"Unknown output backend: {backend}")


def _abandon_registered_session(session: Any) -> None:
    global _ABANDONING_SESSIONS
    try:
        session.abandon()
    except Exception:
        logger.exception("stream encoder cleanup failed")
    finally:
        with _SESSION_CONDITION:
            _ABANDONING_SESSIONS -= 1
            _SESSION_CONDITION.notify_all()


def _expire_stream_sessions() -> None:
    """Release skipped consumers without relying on another graph execution.

    This is a worker-local ownership deadline, not a whole-prompt cancellation
    hook. An in-flight codec/DMA call still owns its buffers until it returns.
    """
    global _ABANDONING_SESSIONS, _SESSION_REAPER
    while True:
        with _SESSION_CONDITION:
            if not _SESSIONS:
                _SESSION_REAPER = None
                return
            now = time.monotonic()
            expired = [key for key, deadline in _SESSION_DEADLINES.items() if deadline <= now]
            if not expired:
                _SESSION_CONDITION.wait(min(_SESSION_DEADLINES.values()) - now)
                continue
            sessions = [_SESSIONS.pop(key) for key in expired]
            for key in expired:
                _SESSION_DEADLINES.pop(key)
            _ABANDONING_SESSIONS += len(sessions)
        for session in sessions:
            try:
                threading.Thread(
                    target=_abandon_registered_session,
                    args=(session,),
                    name="fasth3-stream-abandon",
                    daemon=True,
                ).start()
            except RuntimeError:
                _abandon_registered_session(session)


def register_stream_session(
    run_nonce: str, session: Any, *, timeout_seconds: float = _STREAM_SESSION_TIMEOUT_SECONDS,
) -> None:
    """Retain at most eight encoders for at most five minutes pending output."""
    global _ABANDONING_SESSIONS, _SESSION_REAPER
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= _STREAM_SESSION_TIMEOUT_SECONDS):
        session.abandon()
        raise ValueError("stream session timeout must be positive and at most 300 seconds")
    with _SESSION_CONDITION:
        previous = _SESSIONS.get(run_nonce)
        full = len(_SESSIONS) + _ABANDONING_SESSIONS >= _MAX_STREAM_SESSIONS
        if not full:
            if previous is not None:
                _ABANDONING_SESSIONS += 1
            _SESSIONS[run_nonce] = session
            _SESSION_DEADLINES[run_nonce] = time.monotonic() + timeout_seconds
            if _SESSION_REAPER is None:
                _SESSION_REAPER = threading.Thread(
                    target=_expire_stream_sessions, name="fasth3-stream-cleanup", daemon=True,
                )
                _SESSION_REAPER.start()
            _SESSION_CONDITION.notify_all()
    if full:
        session.abandon()
        raise RuntimeError("stream session limit reached")
    if previous is not None:
        try:
            threading.Thread(
                target=_abandon_registered_session,
                args=(previous,),
                name="fasth3-stream-abandon",
                daemon=True,
            ).start()
        except RuntimeError:
            _abandon_registered_session(previous)


def take_stream_session(run_nonce: str | None):
    if not run_nonce:
        return None
    with _SESSION_CONDITION:
        session = _SESSIONS.pop(run_nonce, None)
        _SESSION_DEADLINES.pop(run_nonce, None)
        _SESSION_CONDITION.notify_all()
        return session


def abandon_stream_session(run_nonce: str | None) -> None:
    session = take_stream_session(run_nonce)
    if session is not None:
        session.abandon()


def start_stream_session(
    *,
    encode_backend: str,
    fps: float,
    path: str | os.PathLike[str] | None = None,
    fused_output_pack: bool = False,
    audio_sample_rate: int = 44100,
):
    if type(audio_sample_rate) is not int or not 8000 <= audio_sample_rate <= 192000:
        raise ValueError("audio_sample_rate must be an integer between 8000 and 192000")
    settings = compact_settings_for_backend(encode_backend)
    if settings is None:
        return None, {"enabled": True, "mode": "skipped_reference"}
    try:
        from .compact_output import StreamingMp4Encoder
    except ImportError:  # pragma: no cover - standalone test imports
        from compact_output import StreamingMp4Encoder  # type: ignore[import-not-found, no-redef]
    destination = str(path) if path is not None else _temp_mp4_path()
    if fused_output_pack:
        try:
            from .output_packing import triton_pack_available
        except ImportError:  # pragma: no cover - standalone test imports
            from output_packing import (  # type: ignore[import-not-found, no-redef]
                triton_pack_available,
            )
        available, reason = triton_pack_available()
        if not available:
            raise RuntimeError(f"fused_output_pack requested but unavailable: {reason}")
    encoder = StreamingMp4Encoder(
        destination, fps, preset=settings["preset"], codec=settings["codec"], crf=settings["crf"],
        audio_sample_rate=audio_sample_rate, audio_channels=2, queue_depth=8,
        fused_output_pack=fused_output_pack,
    )
    return encoder, {
        "enabled": True, "mode": "pending", "path": destination,
        "fused_output_pack": bool(fused_output_pack),
        "audio_sample_rate": audio_sample_rate, **settings,
    }


def _temp_mp4_path() -> str:
    with tempfile.NamedTemporaryFile(prefix="fasth3-stream-", suffix=".mp4", delete=False) as handle:
        return handle.name


def push_finalized_bcthw(session, part: torch.Tensor, *, fused_output_pack: bool = False) -> None:
    if session is None or part.shape[2] <= 0:
        return
    if fused_output_pack:
        try:
            from .output_packing import pack_finalized_rgb24
        except ImportError:  # pragma: no cover - standalone test imports
            from output_packing import pack_finalized_rgb24  # type: ignore[no-redef]
        pack_report = getattr(session, "output_pack_report", None)
        packed = pack_finalized_rgb24(part, backend="triton", report=pack_report)
        if isinstance(pack_report, dict):
            pack_report["calls"] = int(pack_report.get("calls", 0)) + 1
            pack_report["eliminated_nhwc_float_bytes"] = int(
                pack_report.get("eliminated_nhwc_float_bytes", 0)
            ) + int(part.shape[0] * part.shape[2] * part.shape[3] * part.shape[4] * 3 * part.element_size())
        session.push_nhwc_u8(packed)
        return
    session.push_nhwc(bcthw_to_nhwc(part).contiguous())
