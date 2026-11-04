"""Audio decoder and overlap lifecycle for benchmark runs."""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .benchmark_report import _decode_report, _node_value, serialize_report

logger = logging.getLogger(__name__)
_PENDING_AUDIO_LOCK = threading.Lock()
_pending_audio: dict[str, tuple[threading.Thread, dict[str, Any]]] = {}

def _execute_audio_vae(vae, samples):
    from comfy_extras.nodes_audio import VAEDecodeAudio
    execute = getattr(VAEDecodeAudio, "execute", None)
    if execute is None:
        execute = VAEDecodeAudio().decode
    return _node_value(execute(vae, samples))

def _start_audio_overlap(run_nonce: str, vae, samples) -> None:
    """Run the audio VAE on a side CUDA stream while video tiles occupy default.

    Connecting ``audio_vae`` on the video decode node is the switch. Comfy
    still executes nodes one at a time, so overlap has to start here and be
    joined by ``ComfyStreamerH3 Audio Decode``. Create the CUDA stream on
    this thread: a first ``import torch`` inside the worker would land on the
    clip clock, and CUDA contexts belong on the caller.
    """
    from contextlib import nullcontext

    import torch

    holder: dict[str, Any] = {"audio": None, "error": None, "ms": None}
    started = time.perf_counter()
    stream = torch.cuda.Stream() if torch.cuda.is_available() else None
    audio_samples = dict(samples) if isinstance(samples, dict) else samples

    def run():
        try:
            ctx = torch.cuda.stream(stream) if stream is not None else nullcontext()
            with ctx:
                holder["audio"] = _execute_audio_vae(vae, audio_samples)
                if stream is not None:
                    stream.synchronize()
            holder["ms"] = (time.perf_counter() - started) * 1000.0
        except Exception as exc:  # noqa: BLE001 - worker failures must reach the joining node
            holder["error"] = exc
            holder["ms"] = (time.perf_counter() - started) * 1000.0

    thread = threading.Thread(target=run, name="fasth3-audio-vae", daemon=True)
    with _PENDING_AUDIO_LOCK:
        if run_nonce in _pending_audio:
            raise RuntimeError(f"duplicate active run_nonce: {run_nonce!r}")
        _pending_audio[run_nonce] = (thread, holder)
    thread.start()

def _join_audio_overlap(run_nonce: str | None) -> dict[str, Any] | None:
    if not run_nonce:
        return None
    with _PENDING_AUDIO_LOCK:
        item = _pending_audio.pop(run_nonce, None)
    if item is None:
        return None
    thread, holder = item
    thread.join()
    return holder

def _abandon_audio_overlap(run_nonce: str | None) -> None:
    holder = _join_audio_overlap(run_nonce)
    if holder is not None and holder.get("error") is not None:
        logger.info("FASTH3_AUDIO_OVERLAP_ABANDON %s", holder["error"])

class ComfyStreamerH3BenchmarkVAEDecodeAudio:
    """Timed adapter around the installed native ``VAEDecodeAudio`` API."""

    RETURN_TYPES = ("AUDIO", "H3_RUN_REPORT")
    RETURN_NAMES = ("audio", "report")
    FUNCTION = "decode"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",),
                              "report": ("H3_RUN_REPORT",)}}

    def decode(self, samples, vae, report):
        nonce = report.get("run_nonce") if isinstance(report, dict) else None
        overlapped = _join_audio_overlap(str(nonce) if nonce else None)
        if overlapped is not None:
            if overlapped.get("error") is not None:
                raise overlapped["error"]
            updated = serialize_report(report)
            updated.setdefault("timings_ms", {})["audio_decode"] = overlapped["ms"]
            updated["audio_decode_overlapped"] = True
            updated["status"] = "DECODED"
            return overlapped["audio"], updated
        return _decode_report(report, "audio_decode", lambda: _execute_audio_vae(vae, samples))
