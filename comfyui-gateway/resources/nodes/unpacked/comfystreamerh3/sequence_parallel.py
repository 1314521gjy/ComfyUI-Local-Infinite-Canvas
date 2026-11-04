"""Fail-closed Ulysses SP2 layout and transport contracts for the B1 experiment.

This module is intentionally limited to the sequence/head collectives. It does
not claim to integrate ComfyUI's B1 sampler, Kitchen's fused VSA ABI, or NVFP4
scale reduction. The experiment must not select these primitives until those
producer/consumer hooks have an independently verified capability receipt.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

SP2_PROFILE_ID = "fasth3-b1-ulysses-sp2/test-v1"
SP2_WORLD_SIZE = 2
H3_HEADS = 56


class SequenceParallelError(RuntimeError):
    """SP2 configuration or collective contract failed closed."""


def validate_h3_heads(heads: int, world_size: int = SP2_WORLD_SIZE) -> int:
    if type(heads) is not int or heads <= 0:
        raise ValueError("attention head count must be a positive integer")
    if type(world_size) is not int or world_size != SP2_WORLD_SIZE:
        raise ValueError("the B1 experiment supports exactly two ranks")
    if heads % world_size:
        raise ValueError("attention heads must divide evenly across the two ranks")
    return heads // world_size


def validate_process_group(*, require_cuda: bool = True) -> tuple[Any, int]:
    """Require an already initialized, matching two-rank process group."""
    try:
        import torch
        import torch.distributed as dist
    except ImportError as error:  # pragma: no cover - deployment dependency
        raise SequenceParallelError("PyTorch distributed is unavailable") from error
    if not dist.is_available() or not dist.is_initialized():
        raise SequenceParallelError(
            "SP2 requires an initialized two-rank process group; refusing SP1 fallback"
        )
    if dist.get_world_size() != SP2_WORLD_SIZE:
        raise SequenceParallelError("SP2 requires process-group world size two")
    if require_cuda:
        if not torch.cuda.is_available() or not dist.is_nccl_available():
            raise SequenceParallelError("SP2 requires CUDA and NCCL")
        if dist.get_backend() != "nccl":
            raise SequenceParallelError("production SP2 collectives require NCCL")
    return dist, dist.get_rank()


def _validate_input(local_tokens, heads_per_rank: int):
    import torch

    if not isinstance(local_tokens, torch.Tensor) or local_tokens.ndim != 3:
        raise ValueError("Ulysses input must be [local_tokens, local_heads, head_dim]")
    if not local_tokens.is_contiguous():
        raise ValueError("Ulysses input must be contiguous")
    if local_tokens.shape[0] == 0 or local_tokens.shape[2] == 0:
        raise ValueError("Ulysses token count and head dimension must be positive")
    if local_tokens.shape[1] != H3_HEADS:
        raise ValueError("each token shard must contain all 56 H3 heads before exchange")
    if heads_per_rank != H3_HEADS // SP2_WORLD_SIZE:
        raise ValueError("each SP2 rank must own 28 heads")


def sequence_to_head_axis(local_tokens, *, group=None):
    """Exchange local token shards for full-sequence 28-head shards.

    Input and return shapes are `[S/2, 56, D]` and `[S, 28, D]` respectively.
    ``group`` may be a Gloo group for CPU contract tests. B1 runtime must pass
    its NCCL group and independently attest the fused-kernel boundary.
    """
    import torch
    import torch.distributed as dist

    if not dist.is_available() or not dist.is_initialized():
        raise SequenceParallelError("sequence-to-head exchange requires a process group")
    if dist.get_world_size(group) != SP2_WORLD_SIZE:
        raise SequenceParallelError("sequence-to-head exchange requires exactly two ranks")
    heads_per_rank = validate_h3_heads(H3_HEADS, dist.get_world_size(group))
    _validate_input(local_tokens, heads_per_rank)
    local_rows, _heads, head_dim = local_tokens.shape
    send = local_tokens.view(local_rows, SP2_WORLD_SIZE, heads_per_rank, head_dim)
    send = send.permute(1, 0, 2, 3).contiguous().view(-1)
    receive = torch.empty_like(send)
    dist.all_to_all_single(receive, send, group=group)
    return receive.view(SP2_WORLD_SIZE, local_rows, heads_per_rank, head_dim).reshape(
        SP2_WORLD_SIZE * local_rows, heads_per_rank, head_dim
    ).contiguous()


def head_to_sequence_axis(full_sequence_heads, *, group=None):
    """Reverse Ulysses exchange into the current rank's token rows.

    Input and return shapes are `[S, 28, D]` and `[S/2, 56, D]` respectively.
    """
    import torch
    import torch.distributed as dist

    if not dist.is_available() or not dist.is_initialized():
        raise SequenceParallelError("head-to-sequence exchange requires a process group")
    if dist.get_world_size(group) != SP2_WORLD_SIZE:
        raise SequenceParallelError("head-to-sequence exchange requires exactly two ranks")
    if not isinstance(full_sequence_heads, torch.Tensor) or full_sequence_heads.ndim != 3:
        raise ValueError("Ulysses output must be [sequence, local_heads, head_dim]")
    if not full_sequence_heads.is_contiguous():
        raise ValueError("Ulysses output must be contiguous")
    if full_sequence_heads.shape[0] == 0 or full_sequence_heads.shape[0] % SP2_WORLD_SIZE:
        raise ValueError("the global sequence rows must divide evenly across two ranks")
    heads_per_rank = validate_h3_heads(H3_HEADS, dist.get_world_size(group))
    if full_sequence_heads.shape[1] != heads_per_rank or full_sequence_heads.shape[2] == 0:
        raise ValueError("each rank must return its 28-head full-sequence result")
    global_rows, _heads, head_dim = full_sequence_heads.shape
    local_rows = global_rows // SP2_WORLD_SIZE
    send = full_sequence_heads.view(SP2_WORLD_SIZE, local_rows, heads_per_rank, head_dim)
    send = send.contiguous().view(-1)
    receive = torch.empty_like(send)
    dist.all_to_all_single(receive, send, group=group)
    return receive.view(SP2_WORLD_SIZE, local_rows, heads_per_rank, head_dim).permute(
        1, 0, 2, 3
    ).reshape(local_rows, H3_HEADS, head_dim).contiguous()


@dataclass(frozen=True)
class CollectiveSchedule:
    """Identity that both ranks must agree on before entering model collectives."""

    request_id: str
    segment_index: int
    evaluation_index: int
    layer_count: int = 50
    world_size: int = SP2_WORLD_SIZE
    profile_id: str = SP2_PROFILE_ID

    def __post_init__(self):
        if not isinstance(self.request_id, str) or not self.request_id.strip():
            raise ValueError("SP2 request_id must be nonempty")
        for name in ("segment_index", "evaluation_index", "layer_count", "world_size"):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise ValueError(f"SP2 {name} must be a nonnegative integer")
        if self.layer_count != 50 or self.world_size != SP2_WORLD_SIZE:
            raise ValueError("SP2 schedule must describe the 50-layer two-rank B1 model")

    @property
    def digest(self) -> str:
        payload = json.dumps(self.__dict__, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def agree_collective_schedule(schedule: CollectiveSchedule, *, group=None) -> str:
    """Reject rank/request/order disagreement before the first tensor exchange."""
    import torch.distributed as dist

    if not dist.is_available() or not dist.is_initialized():
        raise SequenceParallelError("collective schedule agreement requires a process group")
    if dist.get_world_size(group) != SP2_WORLD_SIZE:
        raise SequenceParallelError("collective schedule agreement requires two ranks")
    digest = schedule.digest
    gathered: list[str | None] = [None] * SP2_WORLD_SIZE
    dist.all_gather_object(gathered, digest, group=group)
    if any(item != digest for item in gathered):
        raise SequenceParallelError("SP2 ranks disagree on request or collective schedule")
    return digest
