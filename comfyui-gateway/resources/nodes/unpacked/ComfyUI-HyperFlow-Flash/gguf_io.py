"""Read a HyperFlow GGUF into ComfyUI-GGUF tensors.

The files carry no `general.architecture` key (the layout stable-diffusion.cpp reads), and ComfyUI-GGUF only accepts
architectures it knows, so the tensors are read here and handed to its on-the-fly dequantizing ops.
"""

from __future__ import annotations

import sys
import warnings
from dataclasses import dataclass
from types import ModuleType

import gguf
import nodes as comfy_nodes
import torch

TENSOR_PREFIX = "model.diffusion_model."
TORCH_TYPES = {gguf.GGMLQuantizationType.F32, gguf.GGMLQuantizationType.F16}


@dataclass(frozen=True)
class GGUFBackend:
    """The loaded ComfyUI-GGUF package, whatever directory name it was installed under."""

    nodes: ModuleType
    ops: ModuleType
    dequant: ModuleType

    @classmethod
    def find(cls) -> GGUFBackend:
        loader = comfy_nodes.NODE_CLASS_MAPPINGS.get("UnetLoaderGGUF")
        if loader is None:
            raise RuntimeError("HyperFlow GGUF loading needs the ComfyUI-GGUF custom node (city96/ComfyUI-GGUF).")
        package = loader.__module__.rsplit(".", 1)[0]
        return cls(sys.modules[loader.__module__], sys.modules[f"{package}.ops"], sys.modules[f"{package}.dequant"])

    def operations(self):
        ops = self.ops.GGMLOps()
        ops.Linear.dequant_dtype = None
        ops.Linear.patch_dtype = None
        return ops

    def placeholder(self, like: torch.Tensor, shape: tuple[int, ...]) -> torch.Tensor:
        """A zero-byte weight with the dense shape; the module holding it is replaced before any forward."""
        return self.ops.GGMLTensor(
            torch.empty(0, dtype=torch.uint8), tensor_type=like.tensor_type, tensor_shape=torch.Size(shape)
        )

    def to_float(self, tensor: torch.Tensor) -> torch.Tensor:
        return self.dequant.dequantize_tensor(tensor, dtype=torch.float32).reshape(tensor.tensor_shape)

    def read(self, path: str) -> dict[str, torch.Tensor]:
        reader = gguf.GGUFReader(path)
        state_dict = {}
        for tensor in reader.tensors:
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="The given NumPy array is not writable")
                data = torch.from_numpy(tensor.data)
            shape = torch.Size(int(size) for size in reversed(tensor.shape))
            if tensor.tensor_type in TORCH_TYPES:
                data = data.view(*shape)
            value = self.ops.GGMLTensor(data, tensor_type=tensor.tensor_type, tensor_shape=shape)
            if len(shape) <= 1 and tensor.tensor_type == gguf.GGMLQuantizationType.BF16:
                value = self.dequant.dequantize_tensor(value, dtype=torch.float32)
            state_dict[tensor.name.removeprefix(TENSOR_PREFIX)] = value
        quantized = [name for name, value in state_dict.items() if self.dequant.is_quantized(value)]
        if quantized:
            state_dict[max(quantized, key=lambda name: state_dict[name].numel())].is_largest_weight = True
        try:
            import comfy.storage
        except ImportError:
            return state_dict
        # Lets ComfyUI's storage policy (--fast-disk, NVMe detection) see which file backs these tensors.
        annotate = getattr(comfy.storage, "annotate_state_dict", None)
        if annotate is not None:
            annotate(state_dict, path)
        return state_dict
