"""HyperFlow safetensors checkpoints in ComfyUI's own tensor layout.

The INT8 convrot release stores every INT8 linear as a ComfyUI `int8_tensorwise` layer (`weight`, `weight_scale`,
`comfy_quant`), so ComfyUI's loader and kernels run them as is; low-rank factors stay bf16. The `hyperflow` metadata
entry marks the files this package reads and carries the layout version in `format`.
"""

from __future__ import annotations

import functools
import json
import os
import struct

import torch
from torch import nn

METADATA_KEY = "hyperflow"
SUPPORTED_FORMAT = 1
MAX_HEADER_BYTES = 64 << 20
# comfy_kitchen's triton INT8 GEMM indexes with int32 and corrupts or faults once rows x width reaches 2^31.
ROW_ELEMENTS = 1 << 30


@functools.lru_cache(maxsize=512)
def _header(path: str, mtime_ns: int, size: int) -> dict | None:
    del mtime_ns, size  # cache keys: a rewritten file is read again
    try:
        with open(path, "rb") as file:
            length = struct.unpack("<Q", file.read(8))[0]
            if length > MAX_HEADER_BYTES:
                return None
            metadata = json.loads(file.read(length)).get("__metadata__") or {}
        return json.loads(metadata[METADATA_KEY]) if METADATA_KEY in metadata else None
    except (OSError, ValueError, struct.error):
        return None


def hyperflow_info(path: str) -> dict | None:
    """The `hyperflow` metadata of a safetensors file, or None for any other file."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return _header(path, stat.st_mtime_ns, stat.st_size)


def checked_info(path: str) -> dict:
    info = hyperflow_info(path)
    if info is None:
        raise RuntimeError(f"{path} is not a HyperFlow checkpoint (no `{METADATA_KEY}` metadata)")
    version = int(info.get("format", 0))
    if version > SUPPORTED_FORMAT:
        raise RuntimeError(
            f"{path} uses HyperFlow layout {version}; this ComfyUI-HyperFlow-Flash reads up to {SUPPORTED_FORMAT}. "
            "Update the node pack."
        )
    return info


def placeholder(like: torch.Tensor, shape: tuple[int, ...]) -> torch.Tensor:
    """A zero-stride bf16 weight: ComfyUI keeps it without a copy at this model's bf16 compute dtype."""
    del like
    return torch.zeros((), dtype=torch.bfloat16).expand(shape)


def float32_tensors(state_dict: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    return {
        name: tensor
        for name, tensor in state_dict.items()
        if tensor.dtype == torch.float32 and not name.endswith(".weight_scale")
    }


def keep_float32(root: nn.Module, tensors: dict[str, torch.Tensor]) -> int:
    """Restore the fp32 parameters that ComfyUI's mixed-precision ops cast to bf16 at load."""
    restored = 0
    for name, tensor in tensors.items():
        module_name, _, leaf = name.rpartition(".")
        try:
            module = root.get_submodule(module_name)
        except AttributeError:
            continue
        current = module._parameters.get(leaf)
        if current is None or current.dtype == torch.float32 or tuple(current.shape) != tuple(tensor.shape):
            continue
        module._parameters[leaf] = nn.Parameter(tensor.to(device=current.device), requires_grad=False)
        setattr(module, f"{leaf}_comfy_model_dtype", torch.float32)
        restored += 1
    return restored


def _int8(module: nn.Module) -> bool:
    return getattr(module, "quant_format", None) == "int8_tensorwise"


def _row_chunks(forward, width: int):
    rows = max(1, ROW_ELEMENTS // width)

    @functools.wraps(forward)
    def chunked(x, *args, **kwargs):
        flat = x.reshape(-1, x.shape[-1])
        if flat.shape[0] <= rows:
            return forward(x, *args, **kwargs)
        out = None
        for start in range(0, flat.shape[0], rows):
            part = forward(flat[start : start + rows], *args, **kwargs)
            if out is None:
                out = part.new_empty((flat.shape[0], part.shape[-1]))
            out[start : start + part.shape[0]] = part
        return out.reshape(*x.shape[:-1], out.shape[-1])

    return chunked


def limit_int8_rows(root: nn.Module) -> int:
    """Run token-wise INT8 work in row chunks below `ROW_ELEMENTS`: every INT8 linear, and every MLP with an INT8
    `fc2` whole, since its fused SwiGLU call bypasses `fc2.forward`."""
    wrapped = 0
    for module in root.modules():
        linear = module if _int8(module) else getattr(module, "fc2", None)
        if not _int8(linear):
            continue
        module.forward = _row_chunks(module.forward, max(linear.in_features, linear.out_features))
        wrapped += 1
    return wrapped
