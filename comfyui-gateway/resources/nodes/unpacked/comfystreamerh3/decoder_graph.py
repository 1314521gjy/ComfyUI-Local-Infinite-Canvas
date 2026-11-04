"""Fixed-shape CUDA Graph replay for the H3 decoder."""
from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import torch


class _CudaGraphDecode:
    """Per-shape CUDA Graph replay for one decoder's pixel function.

    Replays return the captured static output (no clone). The product tiled
    path copies each tile into the canvas and clones overlap tails before the
    next replay. Cloning the full tile on every replay was the B13 falsifier.
    Pass ``copy_output=True`` only if a caller retains the tensor across the
    next replay.
    """

    def __init__(self, decode_fn, *, copy_output: bool = False):
        self.decode_fn = decode_fn
        self.copy_output = bool(copy_output)
        self.entries: dict[tuple, dict[str, Any]] = {}
        self.replay_events: list[tuple[torch.cuda.Event, torch.cuda.Event]] = []
        self.report: dict[str, Any] = {
            "enabled": True,
            "captures": 0,
            "replays": 0,
            "fallback_calls": 0,
            "aliased_replays": 0,
            "shapes": [],
            "output_copy_bytes": 0,
            "copy_output": self.copy_output,
            "restored": False,
            "setup_wall_ms": 0.0,
            "replay_enqueue_wall_ms": 0.0,
            "timing_note": "Setup is synchronized wall time; replay enqueue includes copies but is not GPU duration. Whole decode includes both.",
            "max_shapes": 4,
        }

    @staticmethod
    def _key(x: torch.Tensor) -> tuple:
        return (tuple(int(dim) for dim in x.shape), str(x.dtype), str(x.device),
                tuple(int(stride) for stride in x.stride()))

    def __call__(self, x):
        from .decoder_optimizations import DecoderOptimizationError
        if not isinstance(x, torch.Tensor) or x.device.type != "cuda":
            self.report["fallback_calls"] += 1
            return self.decode_fn(x)
        key = self._key(x)
        entry = self.entries.get(key)
        if entry is None:
            if len(self.entries) >= self.report["max_shapes"]:
                self.report["fallback_calls"] += 1
                return self.decode_fn(x)
            torch.cuda.synchronize(x.device)
            setup_started = time.perf_counter()
            static_input = x.detach().clone()
            # Warm up outside capture so lazy kernels and allocators are not
            # counted as graph replay work.
            for _ in range(2):
                self.decode_fn(static_input)
            torch.cuda.synchronize(x.device)
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph):
                static_output = self.decode_fn(static_input)
            if not isinstance(static_output, torch.Tensor):
                raise DecoderOptimizationError("CUDA Graph decoder output must be a Tensor")
            torch.cuda.synchronize(x.device)
            self.report["setup_wall_ms"] += (time.perf_counter() - setup_started) * 1000
            entry = {
                "graph": graph,
                "static_input": static_input,
                "static_output": static_output,
            }
            self.entries[key] = entry
            self.report["captures"] += 1
            self.report["shapes"].append({
                "shape": list(key[0]), "dtype": key[1], "device": key[2],
                "stride": list(key[3]), "output_shape": list(static_output.shape),
            })
        replay_started = time.perf_counter()
        marks = None
        if len(self.replay_events) < 256:
            marks = (torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True))
            marks[0].record()
        entry["static_input"].copy_(x)
        entry["graph"].replay()
        output = entry["static_output"]
        if self.copy_output:
            output = output.clone()
            self.report["output_copy_bytes"] += output.numel() * output.element_size()
        else:
            self.report["aliased_replays"] += 1
        if marks is not None:
            marks[1].record()
            self.replay_events.append(marks)
        self.report["replays"] += 1
        self.report["replay_enqueue_wall_ms"] += (time.perf_counter() - replay_started) * 1000
        return output

    def collect_timing(self):
        if self.replay_events:
            self.replay_events[-1][1].synchronize()
        durations = [a.elapsed_time(b) for a, b in self.replay_events]
        self.report["replay_with_copies_gpu_ms"] = sum(durations)
        self.report["timed_replays"] = len(durations)
        self.report["untimed_replays"] = self.report["replays"] - len(durations)

@contextmanager
def decoder_cuda_graph(vae, *, copy_output: bool = False) -> Iterator[dict[str, Any]]:
    """Capture fixed-shape decoder tile calls, default-off and reversible."""
    from .decoder_optimizations import DecoderOptimizationError, _decoder_of, _is_actual_h3_decoder
    if torch.is_grad_enabled():
        raise DecoderOptimizationError("CUDA Graph decoder replay requires inference mode")
    if not torch.cuda.is_available() or not hasattr(torch.cuda, "CUDAGraph"):
        raise DecoderOptimizationError("CUDA Graph decoder replay requires CUDA CUDAGraph support")
    decoder = _decoder_of(vae)
    if not _is_actual_h3_decoder(decoder):
        raise DecoderOptimizationError("CUDA Graph decoder replay requires native H3 ViT3DDecoder")
    if getattr(vae, "_fasth3_cuda_graph_active", False):
        raise DecoderOptimizationError("nested CUDA Graph decoder replay is unsupported")
    decode_fn = getattr(vae, "_decode_pixels", None)
    if not callable(decode_fn):
        raise DecoderOptimizationError("CUDA Graph decoder replay requires VAE._decode_pixels")
    runner = _CudaGraphDecode(decode_fn, copy_output=copy_output)

    def wrapped(x):
        return runner(x)

    had_instance = "_decode_pixels" in getattr(vae, "__dict__", {})
    old_instance = getattr(vae, "__dict__", {}).get("_decode_pixels")
    vae._decode_pixels = wrapped
    vae._fasth3_cuda_graph_active = True
    try:
        yield runner.report
    finally:
        if had_instance:
            vae._decode_pixels = old_instance
        else:
            getattr(vae, "__dict__", {}).pop("_decode_pixels", None)
        getattr(vae, "__dict__", {}).pop("_fasth3_cuda_graph_active", None)
        runner.collect_timing()
        runner.entries.clear()
        runner.report["restored"] = True
