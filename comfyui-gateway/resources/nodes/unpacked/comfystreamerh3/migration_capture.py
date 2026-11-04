"""Diagnostic-only capture of consumed RGB24 bytes and pre-mux audio.

The timed path has no active capture. The encoder retains the request's sink
explicitly because its consumer thread does not inherit ContextVars. Capture
does not repack pixels, change arithmetic, or participate in latency evidence.
"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

import numpy as np

_CAPTURE: ContextVar[RawMediaCapture | None] = ContextVar("fasth3_migration_capture", default=None)


def active_capture():
    return _CAPTURE.get()


@contextmanager
def capture_context(capture):
    if active_capture() is not None:
        raise RuntimeError("migration capture is already active")
    token = _CAPTURE.set(capture)
    try:
        yield capture
    except BaseException:
        capture.abort()
        raise
    finally:
        _CAPTURE.reset(token)


def _file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class RawMediaCapture:
    """A bounded, exclusive sink for one diagnostic request's actual buffers."""

    def __init__(self, root, *, frames, width, height):
        if any(type(value) is not int or value <= 0 for value in (frames, width, height)):
            raise ValueError("capture geometry must be positive integers")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.frames, self.width, self.height = frames, width, height
        name = uuid.uuid4().hex
        self.rgb_path = self.root / f"{name}.rgb24"
        self.audio_path = self.root / f"{name}.f32"
        self.pixel_path = self.root / f"{name}.pixels"
        self._rgb = self.rgb_path.open("xb")
        self._lock = threading.RLock()
        self._frames_written = 0
        self._frame_spans = []
        self._audio = None
        self._pixels = None
        self._finished = False

    def write_rgb(self, rgb):
        """Called only after DMA completion on the bytes consumed by encoding."""
        if hasattr(rgb, "detach"):
            rgb = rgb.detach().cpu().contiguous().numpy()
        if (not isinstance(rgb, np.ndarray) or rgb.dtype != np.uint8 or rgb.ndim != 4
                or tuple(rgb.shape[1:]) != (self.height, self.width, 3)):
            raise ValueError("captured RGB geometry/dtype differs from the workload")
        with self._lock:
            if self._finished or self._rgb.closed:
                raise RuntimeError("capture is closed")
            stop = self._frames_written + int(rgb.shape[0])
            if stop > self.frames:
                raise ValueError("captured RGB exceeds the workload frame bound")
            self._rgb.write(np.ascontiguousarray(rgb).tobytes())
            self._frame_spans.append([self._frames_written, stop])
            self._frames_written = stop

    def write_audio(self, waveform, sample_rate):
        if hasattr(waveform, "detach"):
            waveform = waveform.detach().cpu().contiguous().numpy()
        if isinstance(waveform, np.ndarray) and waveform.ndim == 3 and waveform.shape[0] == 1:
            waveform = waveform[0]
        if (not isinstance(waveform, np.ndarray) or waveform.dtype != np.float32
                or waveform.ndim != 2 or waveform.shape[0] not in (1, 2, 6)
                or waveform.shape[1] <= 0 or not np.isfinite(waveform).all()):
            raise ValueError("captured waveform must be finite float32 channels/samples")
        if type(sample_rate) is not int or sample_rate <= 0:
            raise ValueError("captured sample rate must be a positive integer")
        # Ten seconds of extra audio allows the H3 tail, while rejecting corrupt
        # shapes before allocating/writing an unbounded artifact.
        if waveform.shape[1] > sample_rate * (self.frames / 24 + 10):
            raise ValueError("captured audio exceeds the workload duration bound")
        with self._lock:
            if self._audio is not None or self._finished:
                raise RuntimeError("audio capture already written or closed")
            with self.audio_path.open("xb") as stream:
                stream.write(np.ascontiguousarray(waveform, dtype="<f4").tobytes())
            self._audio = {"path": self.audio_path.name, "sha256": _file_hash(self.audio_path),
                           "bytes": self.audio_path.stat().st_size, "samples": int(waveform.shape[1]),
                           "sample_rate": sample_rate, "channels": int(waveform.shape[0]),
                           "dtype": "float32", "format": "raw"}

    def write_decoder_pixels(self, pixels):
        """Preserve unquantized output bytes after the decoder clock closes."""
        if hasattr(pixels, "detach"):
            import torch
            if not torch.isfinite(pixels).all():
                raise ValueError("decoder pixels must be finite")
            pixels = pixels.detach().cpu().contiguous()
            shape, dtype = tuple(pixels.shape), str(pixels.dtype).removeprefix("torch.")
            content = pixels.view(torch.uint8).numpy().tobytes()
        elif isinstance(pixels, np.ndarray) and np.isfinite(pixels).all():
            shape, dtype = tuple(pixels.shape), str(pixels.dtype)
            content = np.ascontiguousarray(pixels).tobytes()
        else:
            raise ValueError("decoder pixels must be finite floating output")
        if shape != (self.frames, self.height, self.width, 3) or dtype not in ("float16", "bfloat16", "float32"):
            raise ValueError("decoder pixel geometry/dtype differs from the workload")
        with self._lock:
            if self._finished or self._pixels is not None:
                raise RuntimeError("decoder pixels already captured or closed")
            with self.pixel_path.open("xb") as stream:
                stream.write(content)
            self._pixels = {"path": self.pixel_path.name, "sha256": _file_hash(self.pixel_path),
                            "bytes": len(content), "frames": self.frames,
                            "width": self.width, "height": self.height, "dtype": dtype, "format": "raw"}

    def finish(self):
        with self._lock:
            if self._finished:
                raise RuntimeError("capture already finished")
            if self._frames_written != self.frames or self._audio is None or self._pixels is None:
                raise ValueError("raw media capture is incomplete")
            self._rgb.close()
            rgb = {"path": self.rgb_path.name, "sha256": _file_hash(self.rgb_path),
                   "bytes": self.rgb_path.stat().st_size, "frames": self.frames,
                   "width": self.width, "height": self.height, "dtype": "uint8", "format": "raw"}
            identity = {"rgb": {k: v for k, v in rgb.items() if k != "path"},
                        "audio": {k: v for k, v in self._audio.items() if k != "path"},
                        "pixels": {k: v for k, v in self._pixels.items() if k != "path"}}
            receipt = {"rgb": rgb, "audio": dict(self._audio), "pixels": dict(self._pixels),
                       "frame_spans": self._frame_spans,
                       "fixture_hash": hashlib.sha256(json.dumps(identity, sort_keys=True,
                                                                  separators=(",", ":")).encode()).hexdigest()}
            self._finished = True
            return receipt

    def abort(self):
        with self._lock:
            self._rgb.close()
            self.rgb_path.unlink(missing_ok=True)
            self.audio_path.unlink(missing_ok=True)
            self.pixel_path.unlink(missing_ok=True)
            self._finished = True
