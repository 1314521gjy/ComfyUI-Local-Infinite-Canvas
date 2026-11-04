"""Track B changed-math arms. Never compose with each other by default."""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field

import torch


def density_keep(n_video_blocks: int, topk_ratio: float) -> int:
    if n_video_blocks <= 0:
        return 0
    return max(1, math.ceil(n_video_blocks * topk_ratio))


def quantize_kv(k: torch.Tensor, v: torch.Tensor, mode: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Selected-KV quantization only. Routing still uses INT8 Q/K carriers."""
    if mode == "bf16":
        return k, v
    if mode == "int8":
        return _dequant_int8(*_quant_int8(k)), _dequant_int8(*_quant_int8(v))
    if mode == "fp8":
        if not hasattr(torch, "float8_e4m3fn"):
            return _dequant_int8(*_quant_int8(k)), _dequant_int8(*_quant_int8(v))
        k8 = k.to(torch.float8_e4m3fn).to(k.dtype)
        v8 = v.to(torch.float8_e4m3fn).to(v.dtype)
        return k8, v8
    raise ValueError(f"unknown kv_quant {mode!r}")


def _quant_int8(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    amax = x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-6)
    scale = amax / 127.0
    q = (x / scale).round().clamp(-128, 127).to(torch.int8)
    return q, scale


def _dequant_int8(q: torch.Tensor, scale: torch.Tensor) -> torch.Tensor:
    return q.to(torch.float32) * scale.to(torch.float32)


def selection_hash(indices: torch.Tensor) -> str:
    payload = indices.detach().to("cpu", torch.int32).contiguous().numpy().tobytes()
    return hashlib.sha256(payload).hexdigest()[:16]


@dataclass
class MaskCache:
    """Reuse selected block ids across layers, then across Euler steps."""

    mode: str = "off"
    _by_layer: dict[int, torch.Tensor] = field(default_factory=dict)
    _by_step: dict[tuple[int, int], torch.Tensor] = field(default_factory=dict)
    hits: int = 0
    misses: int = 0

    def lookup(self, *, layer: int, step: int, fresh: torch.Tensor) -> torch.Tensor:
        if self.mode == "off":
            self.misses += 1
            return fresh
        if self.mode == "layers":
            hit = self._by_layer.get(0)
            if hit is not None and hit.shape == fresh.shape:
                self.hits += 1
                return hit.to(device=fresh.device)
            self.misses += 1
            self._by_layer[0] = fresh.detach().to("cpu")
            return fresh
        if self.mode == "steps":
            key = (layer, 0)
            hit = self._by_step.get(key)
            if hit is not None and hit.shape == fresh.shape:
                self.hits += 1
                return hit.to(device=fresh.device)
            self.misses += 1
            self._by_step[key] = fresh.detach().to("cpu")
            return fresh
        raise ValueError(f"unknown mask_reuse {self.mode!r}")

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {
            "mode": self.mode,
            "hits": self.hits,
            "misses": self.misses,
            "recall": (self.hits / total) if total else 0.0,
        }
