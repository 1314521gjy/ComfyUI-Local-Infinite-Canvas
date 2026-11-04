"""H3 4×4×4 cube tiling, prefix sinks, and partial-edge block_len."""
from __future__ import annotations

import math
from typing import Any

import torch

DEFAULT_BLOCK_SIZE = 64
DEFAULT_CUBE = (4, 4, 4)


def cube_for_block_size(block_size: int) -> tuple[int, int, int]:
    if block_size == 64:
        return (4, 4, 4)
    if block_size == 128:
        return (4, 4, 8)  # changed math: not the trained H3 cube
    raise ValueError(f"no H3 cube for block_size {block_size}")


def pad_segment_tiles(n: int, start: int, block_size: int) -> torch.Tensor:
    """Zero-pad a linear prefix/audio span into 64-row tiles. Pad rows are -1."""
    m = (n + block_size - 1) // block_size
    seg = torch.full((m * block_size,), -1, dtype=torch.int64)
    if n:
        seg[:n] = torch.arange(start, start + n)
    return seg.view(m, block_size)


def video_cube_tiles(
    n: int,
    start: int,
    grid: tuple[int, int, int],
    *,
    block_size: int = DEFAULT_BLOCK_SIZE,
    cube: tuple[int, int, int] = DEFAULT_CUBE,
) -> torch.Tensor:
    """Re-tile a video span as H3 cubes. Live rows first inside each tile."""
    gt, gh, gw = grid
    if gt * gh * gw != n:
        raise RuntimeError(f"VSA: video segment {n} rows does not match grid {grid}")
    if cube[0] * cube[1] * cube[2] != block_size:
        raise ValueError(f"cube {cube} is not {block_size} tokens; 128-token routing is changed math")
    ct, ch, cw = cube
    pt, ph, pw = ((g + c - 1) // c * c for g, c in zip(grid, cube))
    padded = torch.full((pt, ph, pw), -1, dtype=torch.int64)
    padded[:gt, :gh, :gw] = torch.arange(start, start + n).view(*grid)
    cubes = (
        padded.view(pt // ct, ct, ph // ch, ch, pw // cw, cw)
        .permute(0, 2, 4, 1, 3, 5)
        .reshape(-1, block_size)
    )
    order = torch.argsort((cubes < 0).to(torch.int8), dim=1, stable=True)
    return torch.gather(cubes, 1, order)


def build_plan(
    *,
    text_len: int,
    video_grid: tuple[int, int, int],
    audio_len: int = 0,
    block_size: int = DEFAULT_BLOCK_SIZE,
    cube: tuple[int, int, int] | None = None,
    device: str | torch.device = "cpu",
) -> dict[str, Any]:
    """Synthetic PackedLayout-equivalent plan for tests and the microbench."""
    cube = cube or cube_for_block_size(block_size)
    tiles = []
    n_prefix = 0
    cursor = 0
    if text_len:
        prefix = pad_segment_tiles(text_len, cursor, block_size)
        tiles.append(prefix)
        n_prefix += int(prefix.shape[0])
        cursor += text_len
    video_n = video_grid[0] * video_grid[1] * video_grid[2]
    tiles.append(video_cube_tiles(video_n, cursor, video_grid, block_size=block_size, cube=cube))
    cursor += video_n
    if audio_len:
        # Audio is a prefix-style exact sink in the H3 pack *before* video in
        # production; tests may append a trailing exact span.
        extra = pad_segment_tiles(audio_len, cursor, block_size)
        tiles.append(extra)
        n_prefix += int(extra.shape[0])
        cursor += audio_len
    packed = torch.cat(tiles)
    src = packed.reshape(-1)
    live = src >= 0
    seq_len = cursor
    inv = torch.empty(seq_len, dtype=torch.int64)
    inv[src[live]] = torch.nonzero(live).flatten()
    return {
        "n": int(src.numel()),
        "n_orig": int(seq_len),
        "n_prefix": n_prefix,
        "block_size": block_size,
        "src": src.to(device),
        "inv": inv.to(device),
        "live_mask": live.to(device),
        "block_len": (packed >= 0).sum(1).to(torch.int32).to(device),
        "tiles": packed.to(device),
    }


def token_mask(block_len: torch.Tensor, block_size: int) -> torch.Tensor:
    """[n_blocks, block_size] True where the row is a live token."""
    idx = torch.arange(block_size, device=block_len.device)
    return idx.unsqueeze(0) < block_len.unsqueeze(1)


def n_video_keep(n_blocks: int, n_prefix: int, topk_ratio: float) -> int:
    n_video = n_blocks - n_prefix
    if n_video <= 0:
        return 0
    return max(1, math.ceil(n_video * topk_ratio))
