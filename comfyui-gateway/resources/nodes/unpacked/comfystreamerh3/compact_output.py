"""Low-memory MP4 output for Comfy IMAGE tensors.

The benchmark output node uses this path for the B1 baseline; the lower-level
helpers remain callable directly for diagnostics and legacy integrations.
"""

from __future__ import annotations

import errno
import logging
import math
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
import traceback
import weakref
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path
from typing import Any, cast

import av
import torch

logger = logging.getLogger(__name__)

_PRESETS = ("medium", "veryfast")
_CODECS = ("libx264", "h264_nvenc")

# A failed CUDA synchronization cannot prove that DMA has stopped. Keep both
# allocations alive in that exceptional case rather than freeing live memory.
# Entries retain the GPU item followed by a weak encoder owner, byte count,
# and latch indicating that the producing/consuming stack has released it.
_UNSAFE_TRANSFERS: list[Any] = []
_UNSAFE_TRANSFERS_LOCK = threading.Lock()


def _reap_unsafe_transfers() -> None:
    """Release retained DMA owners once their failed events become queryable."""
    with _UNSAFE_TRANSFERS_LOCK:
        retained = []
        releases = []
        item = None
        for item in _UNSAFE_TRANSFERS:
            event = item[1] if isinstance(item, tuple) and len(item) > 1 else None
            try:
                if event is None or not item[6].is_set() or not event.query():
                    retained.append(item)
                else:
                    releases.append((item[4], item[5]))
            except (AttributeError, RuntimeError, ValueError):
                retained.append(item)
        _UNSAFE_TRANSFERS[:] = retained
        item = None
        # Metadata contains only a weak encoder reference and the byte count.
        # The removed tuples must release their allocations before accounting.
        for encoder_ref, size in releases:
            encoder = encoder_ref()
            if encoder is not None:
                encoder._pinned_released(size)


def replace_file(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
    """Rename, or copy+unlink when src and dst sit on different filesystems."""
    source = Path(src)
    destination = Path(dst)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(source, destination)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        shutil.copy2(source, destination)
        source.unlink()


def probe_encoder(codec: str = "h264_nvenc") -> dict[str, Any]:
    """Smoke-test an encoder by opening it and encoding one tiny frame.

    In particular, this distinguishes an installed FFmpeg encoder from a
    usable NVENC stack.  Failures are reported as data so callers can expose
    capability in a diagnostics node without making encoding fall back to a
    different codec.  The temporary MP4 is always removed.
    """
    if codec not in _CODECS:
        raise ValueError(f"codec must be one of {_CODECS}")
    try:
        with tempfile.TemporaryDirectory(prefix="compact-output-") as temp_dir:
            destination = os.path.join(temp_dir, "probe.mp4")
            with av.open(destination, mode="w", format="mp4") as container:
                stream = cast(av.VideoStream, container.add_stream(codec, rate=1))
                stream.width = stream.height = 256
                stream.pix_fmt = "yuv420p"
                stream.options = {"preset": "p4", "cq": "23", "rc": "vbr"} if codec == "h264_nvenc" else {"preset": "veryfast", "crf": "23"}
                image = torch.zeros((256, 256, 3), dtype=torch.uint8).numpy()
                frame = _rgb24_frame(image)
                for packet in stream.encode(frame):
                    container.mux(packet)
                for packet in stream.encode(None):
                    container.mux(packet)
        return {"codec": codec, "available": True}
    except Exception as exc:  # noqa: BLE001 - capability probes must not abort the caller
        return {"codec": codec, "available": False, "reason": f"{type(exc).__name__}: {exc}"}


def _rgb24_frame(image) -> av.VideoFrame:
    """uint8 HWC RGB with BT.709 colorspace so libx264 converts like ``reformat``.

    ``from_numpy_buffer`` shares the numpy allocation (keep the array alive
    until encode finishes). ``colorspace=1`` is required for a bitstream match.
    """
    frame = av.VideoFrame.from_numpy_buffer(image, format="rgb24")
    frame.colorspace = 1  # AVCOL_SPC_BT709 — omitting this changes the bitstream
    return frame


class _PreparedFrames(list):
    """VideoFrames plus the numpy buffer they view via ``from_numpy_buffer``."""

    __slots__ = ("_numpy", "_pinned_bytes")

    def __init__(self, frames, buf):
        super().__init__(frames)
        self._numpy = buf
        self._pinned_bytes = 0


def _quantize_rgb_u8(images: torch.Tensor, start: int, stop: int) -> torch.Tensor:
    rgb = images[start:stop]
    if rgb.shape[-1] != 3:
        rgb = rgb[..., :3]
    scaled = (rgb * 255).clamp(0, 255)
    frame_u8 = scaled.to(dtype=torch.uint8)
    if not frame_u8.is_contiguous():
        frame_u8 = frame_u8.contiguous()
    return frame_u8


def _host_uint8(frame_u8: torch.Tensor) -> torch.Tensor:
    """CPU uint8 for numpy. CUDA uses a pinned staging buffer when possible."""
    if frame_u8.device.type == "cpu":
        return frame_u8
    try:
        pinned = torch.empty(
            frame_u8.shape, dtype=frame_u8.dtype, device="cpu", pin_memory=True)
        pinned.copy_(frame_u8, non_blocking=True)
        torch.cuda.current_stream(frame_u8.device).synchronize()
        return pinned
    except (AttributeError, RuntimeError, ValueError):
        return frame_u8.cpu()


def _prepare_frames(images: torch.Tensor, start: int, stop: int) -> tuple[list[av.VideoFrame], float, float]:
    try:
        from .nvtx import nvtx_range
    except ImportError:  # pragma: no cover - standalone test imports
        try:
            from nvtx import nvtx_range  # type: ignore[no-redef]
        except ImportError:
            from contextlib import nullcontext
            nvtx_range = cast(Any, nullcontext)
    transfer_started = time.perf_counter()
    with nvtx_range("encode_d2h"):
        frame_u8 = _host_uint8(_quantize_rgb_u8(images, start, stop))
        frames_cpu = frame_u8.numpy()
    transfer_ms = (time.perf_counter() - transfer_started) * 1000.0
    prep_started = time.perf_counter()
    frames = _PreparedFrames([_rgb24_frame(image) for image in frames_cpu], frames_cpu)
    return frames, transfer_ms, (time.perf_counter() - prep_started) * 1000.0


def _configure_bt709(video_stream) -> None:
    video_stream.codec_context.color_primaries = 1  # AVCOL_PRI_BT709
    video_stream.codec_context.color_trc = 13  # AVCOL_TRC_IEC61966_2_1
    video_stream.codec_context.colorspace = 1  # AVCOL_SPC_BT709


def _codec_options(codec: str, preset: str, crf: int) -> dict[str, str]:
    if codec == "h264_nvenc":
        return {"preset": "p4", "cq": str(crf), "rc": "vbr"}
    return {"preset": preset, "crf": str(crf)}


def _match_audio(waveform: torch.Tensor, sample_rate: int, channels: int, target_rate: int) -> torch.Tensor:
    if waveform.shape[0] not in (1, 2, 6):
        raise ValueError("audio waveform must have 1, 2, or 6 channels")
    if waveform.shape[0] == 1 and channels > 1:
        waveform = waveform.repeat(channels, 1)
    elif waveform.shape[0] != channels:
        waveform = waveform[:channels]
        if waveform.shape[0] < channels:
            pad = torch.zeros(channels - waveform.shape[0], waveform.shape[1], dtype=waveform.dtype)
            waveform = torch.cat([waveform, pad], dim=0)
    if sample_rate != target_rate:
        n_dst = max(1, round(waveform.shape[1] * target_rate / sample_rate))
        waveform = torch.nn.functional.interpolate(
            waveform.unsqueeze(0), size=n_dst, mode="linear", align_corners=False
        ).squeeze(0)
    return waveform


def _mux_audio(container, audio_stream, waveform: torch.Tensor, sample_rate: int,
               frame_rate: Fraction, n_frames: int) -> None:
    audio_limit = math.ceil((int(sample_rate) / frame_rate) * n_frames)
    audio_cpu = waveform[..., :audio_limit].detach().cpu().contiguous().numpy().astype("float32", copy=False)
    for start in range(0, audio_cpu.shape[1], 1024):
        chunk = audio_cpu[:, start : start + 1024]
        audio_frame = av.AudioFrame.from_ndarray(chunk, format="fltp", layout=audio_stream.layout.name)
        audio_frame.sample_rate = int(sample_rate)
        audio_frame.pts = start
        audio_frame.time_base = Fraction(1, int(sample_rate))
        for packet in audio_stream.encode(audio_frame):
            container.mux(packet)
    for packet in audio_stream.encode(None):
        container.mux(packet)


def _audio_parts(audio: Mapping[str, Any]) -> tuple[torch.Tensor, int]:
    if not isinstance(audio, Mapping) or "waveform" not in audio or "sample_rate" not in audio:
        raise TypeError("audio must contain waveform and sample_rate")
    waveform = audio["waveform"]
    if not isinstance(waveform, torch.Tensor) or not waveform.is_floating_point():
        raise TypeError("audio waveform must be a floating-point torch tensor")
    if waveform.ndim == 3:
        if waveform.shape[0] != 1:
            raise ValueError("audio waveform must have batch size 1")
        waveform = waveform[0]
    if waveform.ndim != 2:
        raise ValueError("audio waveform must have shape (channels, samples)")
    sample_rate = int(audio["sample_rate"])
    if sample_rate <= 0:
        raise ValueError("audio sample_rate must be positive")
    return waveform, sample_rate


def _probe(path: str) -> dict[str, Any]:
    with av.open(path, mode="r") as container:
        video = container.streams.video[0] if container.streams.video else None
        audio = container.streams.audio[0] if container.streams.audio else None
        result: dict[str, Any] = {
            "format": container.format.name,
            "video": None,
            "audio": None,
        }
        if video is not None:
            result["video"] = {
                "codec": video.codec_context.name,
                "width": video.width,
                "height": video.height,
                "frames": video.frames,
                "rate": float(video.average_rate) if video.average_rate else None,
                "pix_fmt": video.pix_fmt,
            }
        if audio is not None:
            result["audio"] = {
                "codec": audio.codec_context.name,
                "sample_rate": audio.codec_context.sample_rate,
                "channels": audio.codec_context.channels,
            }
        return result


def save_compact_mp4(
    images: torch.Tensor,
    audio: Mapping[str, Any] | None,
    fps: float,
    path: str | os.PathLike[str],
    *,
    transfer_batch: int = 4,
    preset: str = "medium",
    codec: str = "libx264",
    crf: int = 23,
    parallel_prepare: bool = False,
    probe: bool = True,
) -> dict[str, Any]:
    """Encode normalized Comfy IMAGE frames as CPU/libx264 MP4.

    ``images`` must be a floating-point ``(frames, height, width, channels)``
    tensor in normalized ``[0, 1]`` space.  Quantization deliberately matches
    Comfy's existing 8-bit path: clamp to ``[0, 255]`` and convert to uint8
    (truncation, not a second rounding policy) on the source device before the
    host transfer.  ``audio`` is the usual Comfy mapping with a float waveform
    shaped ``(1, channels, samples)`` or ``(channels, samples)``.

    ``transfer_batch`` controls how many already-quantized frames are moved to
    host memory per transfer. The default of 4 keeps two in-flight batches small
    enough for the parallel prepare path to overlap the codec. ``preset``
    defaults to the reference encoder preset; callers may explicitly choose
    ``veryfast`` when desired.  ``codec`` is strict: requesting NVENC never
    silently falls back to libx264.

    The function closes the final output before probing it and returns timing
    and stream metadata.  Atomic replacement is left to the caller, which can
    pass a temporary path and rename it after this function succeeds.
    """
    if not isinstance(images, torch.Tensor) or not images.is_floating_point():
        raise TypeError("images must be a floating-point torch tensor")
    if images.ndim != 4 or images.shape[-1] < 3:
        raise ValueError("images must have shape (frames, height, width, channels)")
    if images.shape[0] == 0:
        raise ValueError("images must contain at least one frame")
    if images.shape[1] % 2 or images.shape[2] % 2:
        raise ValueError("libx264 yuv420p output requires even width and height")
    if fps <= 0:
        raise ValueError("fps must be positive")
    if transfer_batch <= 0:
        raise ValueError("transfer_batch must be positive")
    if preset not in _PRESETS:
        raise ValueError(f"preset must be one of {_PRESETS}")
    if codec not in _CODECS:
        raise ValueError(f"codec must be one of {_CODECS}")
    if not isinstance(crf, int) or not 0 <= crf <= 51:
        raise ValueError("crf must be an integer between 0 and 51")

    waveform = sample_rate = None
    if audio is not None:
        waveform, sample_rate = _audio_parts(audio)
        if waveform.shape[0] not in (1, 2, 6):
            raise ValueError("audio waveform must have 1, 2, or 6 channels")

    destination = str(Path(path))
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    container = None
    try:
        container = av.open(destination, mode="w", format="mp4", options={"movflags": "use_metadata_tags+faststart"})
        frame_rate = Fraction(round(float(fps) * 1000), 1000)
        video_stream = cast(av.VideoStream, container.add_stream(codec, rate=frame_rate))
        video_stream.width = int(images.shape[2])
        video_stream.height = int(images.shape[1])
        video_stream.pix_fmt = "yuv420p"
        video_stream.options = cast(dict[str, object], _codec_options(codec, preset, crf))
        # Match CreateVideo's default sRGB transfer and BT.709 primaries.
        _configure_bt709(video_stream)

        audio_stream: av.AudioStream | None = None
        if waveform is not None:
            assert sample_rate is not None
            layout = {1: "mono", 2: "stereo", 6: "5.1"}[int(waveform.shape[0])]
            audio_stream = cast(
                av.AudioStream,
                container.add_stream("aac", rate=int(sample_rate), layout=layout),
            )

        transfer_ms = prep_ms = 0.0
        batches = [(start, min(start + transfer_batch, images.shape[0])) for start in range(0, images.shape[0], transfer_batch)]
        if parallel_prepare:
            # Keep at most two batches resident while the codec remains serial.
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="compact-prep") as pool:
                pending = []
                for batch in batches[:2]:
                    pending.append(pool.submit(_prepare_frames, images, *batch))
                for index in range(len(batches)):
                    frames, batch_transfer_ms, batch_prep_ms = pending.pop(0).result()
                    transfer_ms += batch_transfer_ms
                    prep_ms += batch_prep_ms
                    if index + 2 < len(batches):
                        pending.append(pool.submit(_prepare_frames, images, *batches[index + 2]))
                    for frame in frames:
                        for packet in video_stream.encode(frame):
                            container.mux(packet)
        else:
            for start, stop in batches:
                frames, batch_transfer_ms, batch_prep_ms = _prepare_frames(images, start, stop)
                transfer_ms += batch_transfer_ms
                prep_ms += batch_prep_ms
                for frame in frames:
                    for packet in video_stream.encode(frame):
                        container.mux(packet)
        for packet in video_stream.encode(None):
            container.mux(packet)

        if audio_stream is not None:
            assert waveform is not None and sample_rate is not None
            _mux_audio(container, audio_stream, waveform, sample_rate, frame_rate, images.shape[0])
    finally:
        if container is not None:
            container.close()

    encoded_ms = (time.perf_counter() - started) * 1000.0
    probe_started = time.perf_counter()
    probed = _probe(destination) if probe else None
    return {
        "path": destination,
        "settings": {
            "codec": codec,
            "preset": preset,
            "crf": crf,
            "transfer_batch": transfer_batch,
            "parallel_prepare": parallel_prepare,
            "probe": probe,
        },
        "timings_ms": {
            "mp4_encode": encoded_ms,
            "transfer": transfer_ms,
            "prepare": prep_ms,
            "probe": (time.perf_counter() - probe_started) * 1000.0 if probe else 0.0,
        },
        "probe": probed,
    }


class StreamingMp4Encoder:
    """Bounded-queue encoder so later VAE chunks overlap with H.264 work.

    ``push_nhwc`` runs D2H/uint8 on the caller thread, then parks the prepared
    frames on a depth-2 queue. A worker thread is the only caller of
    ``stream.encode``, matching ``save_compact_mp4``'s serial codec.
    """

    def __init__(
        self,
        path: str | os.PathLike[str],
        fps: float,
        *,
        preset: str = "veryfast",
        codec: str = "libx264",
        crf: int = 23,
        queue_depth: int = 2,
        audio_sample_rate: int | None = None,
        audio_channels: int = 2,
        fused_output_pack: bool = False,
    ):
        if fps <= 0:
            raise ValueError("fps must be positive")
        if preset not in _PRESETS:
            raise ValueError(f"preset must be one of {_PRESETS}")
        if codec not in _CODECS:
            raise ValueError(f"codec must be one of {_CODECS}")
        if not isinstance(crf, int) or not 0 <= crf <= 51:
            raise ValueError("crf must be an integer between 0 and 51")
        if queue_depth < 1:
            raise ValueError("queue_depth must be positive")
        if audio_sample_rate is not None and audio_sample_rate <= 0:
            raise ValueError("audio_sample_rate must be positive")
        if audio_sample_rate is not None and audio_channels not in (1, 2, 6):
            raise ValueError("audio_channels must be 1, 2, or 6")
        self.path = str(Path(path))
        self.fps = float(fps)
        self.preset = preset
        self.codec = codec
        self.crf = crf
        self.frame_count = 0
        self.transfer_ms = 0.0
        self.prep_ms = 0.0
        self._queue: queue.Queue = queue.Queue(maxsize=queue_depth)
        self._worker: threading.Thread | None = None
        self._error: BaseException | None = None
        self._container: Any = None
        self._video: Any = None
        self._audio: Any = None
        self.audio_sample_rate = audio_sample_rate
        self.audio_channels = audio_channels
        self.fused_output_pack = bool(fused_output_pack)
        self.output_pack_report: dict[str, Any] = {
            "requested": self.fused_output_pack,
            "backend": "disabled" if not self.fused_output_pack else "pending",
            "calls": 0,
            "eliminated_nhwc_float_bytes": 0,
        }
        self._frame_rate: Fraction | None = None
        self._opened = False
        self._closed = False
        self._started = time.perf_counter()
        self.first_encoded_packet_ms: float | None = None
        self._copy_stream: Any = None
        self._abandoned = threading.Event()
        self._queue_lock = threading.Lock()
        if __package__:
            from .migration_capture import active_capture
            self._migration_capture = active_capture()
        else:  # Standalone compatibility helpers have no qualification context.
            self._migration_capture = None
        self._resource_lock = threading.Lock()
        self._pinned_live_bytes = self._pinned_peak_bytes = self._pinned_batch_bytes = 0

    def resource_snapshot(self):
        """Encoder staging owners; excludes codec buffers and allocator caches."""
        with self._resource_lock:
            return {
                "pinned_live_bytes": self._pinned_live_bytes,
                "pinned_peak_bytes": self._pinned_peak_bytes,
                "pinned_capacity_bytes": self._pinned_batch_bytes * (self._queue.maxsize + 2),
                "encode_queue_slots": self._queue.maxsize,
                "queue_live_slots": self._queue.qsize(),
            }

    def _pinned_acquired(self, size):
        with self._resource_lock:
            self._pinned_live_bytes += size
            self._pinned_peak_bytes = max(self._pinned_peak_bytes, self._pinned_live_bytes)
            self._pinned_batch_bytes = max(self._pinned_batch_bytes, size)

    def _pinned_released(self, size):
        with self._resource_lock:
            self._pinned_live_bytes = max(0, self._pinned_live_bytes - size)

    def _retain_unsafe_transfer(self, item):
        # Recovery must wait for DMA *and* the consuming/producing stack to
        # release its references. The weak owner avoids retaining the encoder.
        ready = threading.Event()
        size = item[2].numel() * item[2].element_size()
        with _UNSAFE_TRANSFERS_LOCK:
            _UNSAFE_TRANSFERS.append((*item, weakref.ref(self), size, ready))
        return ready

    def _enqueue(self, item, *, deadline=None):
        # A failed consumer must not leave a producer blocked on a full queue.
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("stream encoder finalization timed out")
            with self._queue_lock:
                self._raise_if_failed()
                if self._abandoned.is_set():
                    raise RuntimeError("encoder abandoned")
                try:
                    self._queue.put_nowait(item)
                    return
                except queue.Full:
                    pass
            self._abandoned.wait(0.05)

    def _raise_if_failed(self) -> None:
        if self._error is not None:
            raise self._error

    def _open(self, height: int, width: int) -> None:
        if height % 2 or width % 2:
            raise ValueError("libx264 yuv420p output requires even width and height")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._container = av.open(
            self.path, mode="w", format="mp4",
            options={"movflags": "use_metadata_tags+faststart"},
        )
        self._frame_rate = Fraction(round(float(self.fps) * 1000), 1000)
        self._video = self._container.add_stream(self.codec, rate=self._frame_rate)
        self._video.width = int(width)
        self._video.height = int(height)
        self._video.pix_fmt = "yuv420p"
        self._video.options = _codec_options(self.codec, self.preset, self.crf)
        _configure_bt709(self._video)
        if self.audio_sample_rate is not None:
            layout = {1: "mono", 2: "stereo", 6: "5.1"}[int(self.audio_channels)]
            self._audio = self._container.add_stream(
                "aac", rate=int(self.audio_sample_rate), layout=layout)
        self._opened = True
        self._worker = threading.Thread(target=self._run, name="fasth3-stream-encode", daemon=True)
        self._worker.start()

    def _run(self) -> None:
        try:
            while not self._abandoned.is_set():
                try:
                    item = self._queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                if item is None:
                    break
                pinned_bytes = (item[2].numel() * item[2].element_size()
                                if isinstance(item, tuple) and item and item[0] == "gpu"
                                else getattr(item, "_pinned_bytes", 0))
                frames = frame = packet = packets = None
                unsafe_ready = None
                try:
                    frames = self._materialize_batch(item)
                    for frame in frames:
                        packets = self._video.encode(frame)
                        for packet in packets:
                            if self.first_encoded_packet_ms is None:
                                self.first_encoded_packet_ms = (time.perf_counter() - self._started) * 1000.0
                            self._container.mux(packet)
                except BaseException:
                    if isinstance(item, tuple) and item and item[0] == "gpu":
                        with _UNSAFE_TRANSFERS_LOCK:
                            for retained in _UNSAFE_TRANSFERS:
                                if retained[2] is item[2]:
                                    unsafe_ready = retained[6]
                                    break
                            retained = None
                    raise
                finally:
                    # Exception frames and encode iterators can own the input
                    # even after encode fails. Drop our references before
                    # reporting staging released, including while idle between
                    # queue gets. Codec-internal retention is outside this
                    # encoder staging metric.
                    error = sys.exception()
                    if error is not None:
                        traceback.clear_frames(error.__traceback__)
                    item = frames = frame = packet = packets = None
                    if unsafe_ready is None:
                        self._pinned_released(pinned_bytes)
                    else:
                        unsafe_ready.set()
        except Exception as exc:  # noqa: BLE001 - worker must not kill the decode thread
            with self._queue_lock:
                self._error = exc
        finally:
            self._drain_transfers()
            if self._abandoned.is_set():
                self._close_abandoned()

    def _drain_transfers(self):
        pending_items = []
        with self._queue_lock:
            while True:
                try:
                    pending_items.append(self._queue.get_nowait())
                except queue.Empty:
                    break
        # Do not hold the producer lock while waiting for cleanup DMA. Failed
        # producers must observe _error even if a queued event is still pending.
        while pending_items:
            pending = pending_items.pop(0)
            if isinstance(pending, tuple) and pending and pending[0] == "gpu":
                pinned_bytes = pending[2].numel() * pending[2].element_size()
                unsafe_ready = None
                try:
                    if pending[1] is not None:
                        pending[1].synchronize()
                except Exception as exc:  # noqa: BLE001 - retain DMA owners on unknown sync failures
                    unsafe_ready = self._retain_unsafe_transfer(pending)
                    self._error = self._error or exc
                    traceback.clear_frames(exc.__traceback__)
                finally:
                    pending = None
                    if unsafe_ready is None:
                        self._pinned_released(pinned_bytes)
                    else:
                        unsafe_ready.set()
            else:
                pinned_bytes = getattr(pending, "_pinned_bytes", 0)
                pending = None
                self._pinned_released(pinned_bytes)
        _reap_unsafe_transfers()

    def _materialize_batch(self, item):
        if isinstance(item, tuple) and item and item[0] == "gpu":
            _, event, pinned, *_source_owner = item
            if event is not None:
                try:
                    event.synchronize()
                except BaseException:
                    # The dequeued item is no longer covered by queue cleanup.
                    self._retain_unsafe_transfer(item)
                    raise
            frames_cpu = pinned.numpy()
            if self._migration_capture is not None:
                self._migration_capture.write_rgb(frames_cpu)
            frames = _PreparedFrames([_rgb24_frame(image) for image in frames_cpu], frames_cpu)
            frames._pinned_bytes = pinned.numel() * pinned.element_size()
            return frames
        if self._migration_capture is not None:
            if not isinstance(item, _PreparedFrames):
                raise RuntimeError("migration capture requires actual consumed RGB buffers")
            self._migration_capture.write_rgb(item._numpy)
        return item

    def _push_cuda_u8(self, frame_u8: torch.Tensor) -> float:
        _reap_unsafe_transfers()
        started = time.perf_counter()
        if self._copy_stream is None:
            self._copy_stream = torch.cuda.Stream(device=frame_u8.device)
        pinned = torch.empty(
            frame_u8.shape, dtype=torch.uint8, device="cpu", pin_memory=True)
        compute = torch.cuda.current_stream(frame_u8.device)
        self._copy_stream.wait_stream(compute)
        with torch.cuda.stream(self._copy_stream):
            pinned.copy_(frame_u8, non_blocking=True)
            event = self._copy_stream.record_event()
        # Keep the source allocation alive until the copy-stream event is
        # synchronized by the consumer. Without this owner the caching
        # allocator can reuse frame_u8 before non_blocking DMA completes,
        # producing intermittent static/noise frames.
        item = ("gpu", event, pinned, frame_u8)
        self._pinned_acquired(pinned.numel() * pinned.element_size())
        try:
            self._enqueue(item)
        except BaseException as exc:
            ready = self._retain_unsafe_transfer(item)
            traceback.clear_frames(exc.__traceback__)
            del item, pinned, frame_u8
            ready.set()
            raise
        return (time.perf_counter() - started) * 1000.0

    def push_nhwc(self, images: torch.Tensor) -> None:
        self._raise_if_failed()
        if self._closed:
            raise RuntimeError("encoder already finished")
        if not isinstance(images, torch.Tensor) or not images.is_floating_point():
            raise TypeError("images must be a floating-point torch tensor")
        if images.ndim != 4 or images.shape[-1] < 3:
            raise ValueError("images must have shape (frames, height, width, channels)")
        if images.shape[0] == 0:
            return
        if not self._opened:
            self._open(int(images.shape[1]), int(images.shape[2]))
        if images.device.type == "cuda":
            try:
                frame_u8 = _quantize_rgb_u8(images, 0, images.shape[0])
                self.transfer_ms += self._push_cuda_u8(frame_u8)
            except Exception:
                self._raise_if_failed()
                if self._abandoned.is_set():
                    raise
                frames, transfer_ms, prep_ms = _prepare_frames(images, 0, images.shape[0])
                self.transfer_ms += transfer_ms
                self.prep_ms += prep_ms
                self._enqueue(frames)
        else:
            frames, transfer_ms, prep_ms = _prepare_frames(images, 0, images.shape[0])
            self.transfer_ms += transfer_ms
            self.prep_ms += prep_ms
            self._enqueue(frames)
        self.frame_count += int(images.shape[0])
        self._raise_if_failed()

    def push_nhwc_u8(self, images: torch.Tensor) -> None:
        """Queue already-packed contiguous RGB24 frames without re-quantizing."""
        self._raise_if_failed()
        if self._closed:
            raise RuntimeError("encoder already finished")
        if not isinstance(images, torch.Tensor) or images.dtype != torch.uint8:
            raise TypeError("images must be a uint8 torch tensor")
        if images.ndim != 4 or images.shape[-1] < 3:
            raise ValueError("images must have shape (frames, height, width, channels)")
        if images.shape[0] == 0:
            return
        if images.shape[-1] != 3:
            images = images[..., :3]
        if not images.is_contiguous():
            images = images.contiguous()
        if not self._opened:
            self._open(int(images.shape[1]), int(images.shape[2]))
        if images.device.type == "cuda":
            self.transfer_ms += self._push_cuda_u8(images)
        else:
            started = time.perf_counter()
            frames_cpu = images.numpy()
            self.prep_ms += (time.perf_counter() - started) * 1000.0
            frames = _PreparedFrames([_rgb24_frame(image) for image in frames_cpu], frames_cpu)
            self._enqueue(frames)
        self.frame_count += int(images.shape[0])
        self._raise_if_failed()

    def finish(
        self,
        audio: Mapping[str, Any] | None = None,
        *,
        probe: bool = True,
    ) -> dict[str, Any]:
        try:
            return self._finish(audio, probe=probe)
        except BaseException:
            self.abandon()
            raise

    def _finish(self, audio, *, probe):
        self._raise_if_failed()
        if not self._opened:
            raise RuntimeError("no frames pushed")
        deadline = time.monotonic() + 300.0
        self._enqueue(None, deadline=deadline)
        if self._worker is not None:
            self._worker.join(timeout=max(0.0, deadline - time.monotonic()))
            if self._worker.is_alive():
                raise TimeoutError("stream encoder finalization timed out")
        self._raise_if_failed()
        for packet in self._video.encode(None):
            self._container.mux(packet)
        if self._audio is not None:
            assert self.audio_sample_rate is not None and self._frame_rate is not None
            if audio is None:
                n = max(1, math.ceil(int(self.audio_sample_rate) * self.frame_count / float(self.fps)))
                waveform = torch.zeros(int(self.audio_channels), n)
                sample_rate = int(self.audio_sample_rate)
            else:
                waveform, sample_rate = _audio_parts(audio)
                waveform = _match_audio(waveform, sample_rate, int(self.audio_channels),
                                        int(self.audio_sample_rate))
                sample_rate = int(self.audio_sample_rate)
            if self._migration_capture is not None:
                self._migration_capture.write_audio(waveform, sample_rate)
            _mux_audio(self._container, self._audio, waveform, sample_rate,
                       self._frame_rate, self.frame_count)
        self._container.close()
        self._container = None
        self._closed = True
        encoded_ms = (time.perf_counter() - self._started) * 1000.0
        probe_started = time.perf_counter()
        probed = _probe(self.path) if probe else None
        return {
            "path": self.path,
            "streamed": True,
            "settings": {
                "codec": self.codec,
                "preset": self.preset,
                "crf": self.crf,
                "transfer_batch": None,
                "parallel_prepare": True,
                "probe": probe,
                "fused_output_pack": self.fused_output_pack,
            },
            "timings_ms": {
                "mp4_encode": encoded_ms,
                "transfer": self.transfer_ms,
                "prepare": self.prep_ms,
                "first_encoded_packet_since_decode_start": self.first_encoded_packet_ms,
                "probe": (time.perf_counter() - probe_started) * 1000.0 if probe else 0.0,
            },
            "probe": probed,
            "frames": self.frame_count,
            "output_pack": dict(self.output_pack_report),
            "resources": self.resource_snapshot(),
            "diagnostic_capture": self._migration_capture is not None,
        }

    def abandon(self) -> None:
        self._closed = True
        self._abandoned.set()
        if self._worker is not None:
            self._worker.join(timeout=5.0)
            if self._worker.is_alive():
                # The worker owns pending DMA and codec calls. It will close
                # and unlink once they finish; never close beneath encode().
                return
        self._drain_transfers()
        self._close_abandoned()

    def _close_abandoned(self) -> None:
        try:
            if self._container is not None:
                try:
                    self._container.close()
                except Exception as exc:  # noqa: BLE001 - cleanup must not mask the primary error
                    logger.warning("encoder close failed during cleanup: %s", exc)
                self._container = None
        finally:
            try:
                Path(self.path).unlink(missing_ok=True)
            except OSError:
                pass


__all__ = ["StreamingMp4Encoder", "probe_encoder", "save_compact_mp4"]
