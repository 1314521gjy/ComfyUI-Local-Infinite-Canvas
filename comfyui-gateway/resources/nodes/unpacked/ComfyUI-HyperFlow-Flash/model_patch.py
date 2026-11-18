"""HyperFlow additions on top of ComfyUI's packed video+audio DiT.

- Factorized linears `<name>.down` / `<name>.up` replace the dense `attn.qkv_proj`, `attn.out_proj`, `mlp.fc1`
  and `mlp.fc2` of the blocks that store them; split `q/k/v_proj` are concatenated back into one projection.
  Dense linears, quantized or not, stay with ComfyUI's loader.
- Two-time checkpoints embed the step endpoint r next to t: temb = te(t) + gate * (ee(r) - te(t)).
  Text and video use (1 - sigma, 1 - sigma_next); audio uses the same pair mapped to its own shift; condition
  rows keep r = t. sigma_next comes from the running schedule in `transformer_options["sample_sigmas"]`.
"""

from __future__ import annotations

import contextlib
import logging
import re
from collections import defaultdict
from collections.abc import Callable

import comfy.ldm.minimax.model as packed_dit
import torch
from torch import nn

PackedModel = packed_dit.MiniMaxH3Model
VIDEO_SHIFT_OPTION = "minimax_h3_sigma_shift_video"
AUDIO_SHIFT_OPTION = "minimax_h3_sigma_shift_audio"
ENDPOINT_PREFIX = "endpoint_time_embedder."
PART = re.compile(
    r"^blocks\.(\d+)\.(attn\.[qkv]_proj|attn\.out_proj|mlp\.fc[12])\."
    r"(down\.weight|up\.weight|weight|weight_scale|comfy_quant)$"
)
QKV_PARTS = ("attn.q_proj", "attn.k_proj", "attn.v_proj")
DENSE_LEAVES = ("weight", "weight_scale", "comfy_quant")
# (tensor of the module, dense shape) -> a zero-byte weight with that shape, replaced before any forward.
Placeholder = Callable[[torch.Tensor, tuple[int, ...]], torch.Tensor]
# Rows of the first step share t = 0 across video and audio but not r; audio moves to the next float32 value.
AUDIO_TIME_OFFSET = 1e-6


class LowRankLinear(nn.Module):
    def __init__(self, down: nn.Module, up: nn.Module) -> None:
        super().__init__()
        self.down = down
        self.up = up

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.up(self.down(x))


class SplitQKV(nn.Module):
    def __init__(self, q_proj: nn.Module, k_proj: nn.Module, v_proj: nn.Module) -> None:
        super().__init__()
        self.q_proj = q_proj
        self.k_proj = k_proj
        self.v_proj = v_proj

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.cat((self.q_proj(x), self.k_proj(x), self.v_proj(x)), dim=-1)


class FactorizedMLP(packed_dit.MLP):
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        gate, hidden = self.fc1(x).chunk(2, dim=-1)
        return self.fc2(nn.functional.silu(gate) * hidden)


def _shape(tensor: torch.Tensor) -> tuple[int, ...]:
    shape = getattr(tensor, "tensor_shape", None)
    return tuple(int(size) for size in (tensor.shape if shape is None else shape))


class FactorizedPlan:
    """Pops the factorized and split-q/k/v linears of every block and leaves dense placeholders for model detection."""

    def __init__(self, state_dict: dict[str, torch.Tensor], placeholder: Placeholder) -> None:
        found: dict[tuple[int, str], dict[str, str]] = defaultdict(dict)
        for name in state_dict:
            match = PART.match(name)
            if match is not None:
                found[int(match.group(1)), match.group(2)][match.group(3).removesuffix(".weight")] = name
        parts: dict[int, dict[str, dict[str, torch.Tensor]]] = defaultdict(dict)
        for (block, module), leaves in found.items():
            if module in QKV_PARTS or any(leaf not in DENSE_LEAVES for leaf in leaves):
                parts[block][module] = {leaf: state_dict.pop(name) for leaf, name in leaves.items()}
        self.parts = dict(parts)
        for block, modules in self.parts.items():
            for dense, shape, like in self._dense_shapes(modules):
                state_dict[f"blocks.{block}.{dense}.weight"] = placeholder(like, shape)

    @staticmethod
    def _out_in(part: dict[str, torch.Tensor]) -> tuple[int, int]:
        if "weight" in part:
            return _shape(part["weight"])
        return _shape(part["up"])[0], _shape(part["down"])[1]

    @staticmethod
    def _like(part: dict[str, torch.Tensor]) -> torch.Tensor:
        return part.get("weight", part.get("up"))

    def _dense_shapes(self, modules: dict[str, dict[str, torch.Tensor]]):
        if any(name in modules for name in QKV_PARTS):
            shapes = [self._out_in(modules[name]) for name in QKV_PARTS]
            yield "attn.qkv_proj", (sum(out for out, _ in shapes), shapes[0][1]), self._like(modules["attn.q_proj"])
        for name in ("attn.out_proj", "mlp.fc1", "mlp.fc2"):
            if name in modules:
                yield name, self._out_in(modules[name]), self._like(modules[name])

    def install(self, model: PackedModel, ops) -> int:
        for block_index, modules in self.parts.items():
            block = model.blocks[block_index]

            def build(name: str, dtype=model.dtype, modules=modules) -> nn.Module:
                part = modules[name]
                if "weight" in part:
                    out_features, in_features = _shape(part["weight"])
                    linear = ops.Linear(in_features, out_features, bias=False, dtype=dtype)
                    linear.load_state_dict(part, strict=False)
                    return linear
                rank, in_features = _shape(part["down"])
                out_features = _shape(part["up"])[0]
                down = ops.Linear(in_features, rank, bias=False, dtype=dtype)
                up = ops.Linear(rank, out_features, bias=False, dtype=dtype)
                down.load_state_dict({"weight": part["down"]}, strict=False)
                up.load_state_dict({"weight": part["up"]}, strict=False)
                return LowRankLinear(down, up)

            if any(name in modules for name in QKV_PARTS):
                block.attn.qkv_proj = SplitQKV(*(build(name) for name in QKV_PARTS))
            if "attn.out_proj" in modules:
                block.attn.out_proj = build("attn.out_proj")
            for name in ("mlp.fc1", "mlp.fc2"):
                if name in modules:
                    setattr(block.mlp, name.split(".")[1], build(name))
            if "mlp.fc2" in modules:
                block.mlp.__class__ = FactorizedMLP
        return len(self.parts)


class EndpointState:
    """Plain holder so the endpoint embedder stays registered only once, at the model root."""

    def __init__(self, embedder: nn.Module, gate: float) -> None:
        self.embedder = embedder
        self.gate = gate
        self.endpoints: dict[float, float] = {}

    def set_endpoints(self, pairs: dict[float, float]) -> None:
        keys = torch.tensor(list(pairs), dtype=torch.float32).tolist()
        self.endpoints = dict(zip(keys, pairs.values(), strict=True))

    def lookup(self, t: torch.Tensor) -> torch.Tensor:
        values = [self.endpoints.get(value, value) for value in t.float().tolist()]
        return torch.tensor(values, dtype=torch.float32, device=t.device)


class TwoTimeEmbedder(packed_dit.TimeEmbedder):
    def forward(self, t: torch.Tensor) -> torch.Tensor:
        state: EndpointState = self.__dict__["endpoint_state"]
        current = super().forward(t)
        endpoint = state.embedder(state.lookup(t)).to(current.dtype)
        return current + state.gate * (endpoint - current)


@contextlib.contextmanager
def separated_audio_time(shift_video: float, shift_audio: float):
    original = packed_dit.time_shift_sigma

    def shifted(sigma, from_shift, to_shift):
        value = original(sigma, from_shift, to_shift)
        if (from_shift, to_shift) == (shift_video, shift_audio):
            value = value - AUDIO_TIME_OFFSET
        return value

    packed_dit.time_shift_sigma = shifted
    try:
        yield shifted
    finally:
        packed_dit.time_shift_sigma = original


def step_endpoint(sigma: torch.Tensor, sample_sigmas: torch.Tensor | None) -> torch.Tensor:
    if sample_sigmas is None:
        return sigma
    schedule = sample_sigmas.to(device=sigma.device, dtype=torch.float32)
    index = int((schedule - sigma).abs().argmin())
    return schedule[min(index + 1, schedule.shape[0] - 1)]


def _f32(value: float) -> float:
    return torch.tensor(value, dtype=torch.float32).item()


class HyperFlowModel(PackedModel):
    """Two-time forward: sets this step's (t, r) pairs on the time embedder, then runs the stock packed forward."""

    def _forward(self, x, timestep, context, transformer_options=None, **kwargs):
        transformer_options = {} if transformer_options is None else transformer_options
        state: EndpointState = self.time_embedder.__dict__["endpoint_state"]
        shift_video = float(transformer_options.get(VIDEO_SHIFT_OPTION, self.sigma_shift_video))
        shift_audio = float(transformer_options.get(AUDIO_SHIFT_OPTION, self.sigma_shift_audio))
        sigma = (timestep.flatten()[0] / 1000.0).float().clamp(min=1e-6)
        sample_sigmas = transformer_options.get("sample_sigmas")
        if sample_sigmas is None and not getattr(self, "_warned_endpoint", False):
            logging.warning("HyperFlow: no running schedule in transformer_options; using r = t")
            self._warned_endpoint = True
        sigma_next = step_endpoint(sigma, sample_sigmas)
        shift = packed_dit.time_shift_sigma
        t_video, r_video = float(1.0 - sigma), float(1.0 - sigma_next)
        r_audio = float(1.0 - shift(sigma_next, shift_video, shift_audio))
        t_audio = float(1.0 - shift(sigma, shift_video, shift_audio))
        collide = _f32(t_video) == _f32(t_audio) and r_video != r_audio
        with separated_audio_time(shift_video, shift_audio) if collide else contextlib.nullcontext() as moved:
            if moved is not None:
                t_audio = float(1.0 - moved(sigma, shift_video, shift_audio))
            state.set_endpoints({t_video: r_video, t_audio: r_audio})
            return super()._forward(x, timestep, context, transformer_options, **kwargs)


def install_two_time(model: PackedModel, endpoint_sd: dict[str, torch.Tensor], gate: float, ops) -> None:
    current = model.time_embedder
    hidden, freq_dim = _shape(endpoint_sd["proj_in.weight"])
    out_dim = _shape(endpoint_sd["proj_out.weight"])[0]
    embedder = packed_dit.TimeEmbedder(freq_dim, hidden, out_dim, dtype=torch.float32, operations=ops)
    embedder.load_state_dict(endpoint_sd, strict=False)
    model.endpoint_time_embedder = embedder
    current.__class__ = TwoTimeEmbedder
    current.__dict__["endpoint_state"] = EndpointState(embedder, gate)
    model.__class__ = HyperFlowModel
