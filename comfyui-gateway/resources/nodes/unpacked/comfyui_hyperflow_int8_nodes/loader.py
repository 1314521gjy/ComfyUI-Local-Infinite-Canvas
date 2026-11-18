# Copyright (C) 2026 the ComfyUI-HyperFlow-INT8 authors. GPL-3.0; see LICENSE.
"""HyperFlow INT8 Loader: a converted HyperFlow H3 Flash INT8 checkpoint on ComfyUI's native INT8 (convrot) ops.

ComfyUI core builds and loads the model (model detection, mixed-precision ops, `int8_tensorwise` + convrot weights on
comfy_kitchen's INT8 GEMMs). This file only adds what the stock MiniMax-H3 model has no slot for, using the classes of
the official ComfyUI-HyperFlow-Flash pack (`model_patch.py`), unchanged:

* low-rank linears (`LowRankLinear`), split q/k/v projections (`SplitQKV`) and the explicit SwiGLU MLP
  (`FactorizedMLP`) for blocks whose fc2 is low-rank;
* the two-time (t, r) embedder (`install_two_time`, `TwoTimeEmbedder`, `HyperFlowModel`);
* `hyperflow_sigmas` for the official HyperFlowSigmas node.

Weights that are fp32 in the checkpoint (patch projections, time embedders, output heads) stay fp32, as in the stock
bf16 path and the GGUF path; ComfyUI's mixed-precision ops would otherwise store them in the compute dtype.

Both HyperFlow variants load here: fl2va (t2v / i2v / flf2v, 47 blocks) and ref2va (reference to video, 49 blocks).
Nothing is variant-specific at run time; the block count and the low-rank layout come from the file.

Patcher: "legacy" (default) is the classic ModelPatcher, which the official GGUF loader also uses; it ran stable on an
RTX 5090. "auto" (experimental) is what UNETLoader gets, DynamicVRAM when ComfyUI enabled it. The module swap happens
before the patcher has staged anything and every new weight lives in a ComfyUI op, so DynamicVRAM manages it like any
stock weight; still, on the 5090 it held VRAM at the card limit and slowed across consecutive runs.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import sys
from collections import defaultdict
from types import SimpleNamespace

import comfy.sd
import comfy.utils
import folder_paths
import torch
from torch import nn

OFFICIAL_PACK = "ComfyUI-HyperFlow-Flash"
ENDPOINT_PREFIX = "endpoint_time_embedder."
PART = re.compile(
    r"^blocks\.(\d+)\.(attn\.[qkv]_proj|attn\.out_proj|mlp\.fc[12])\."
    r"(down\.weight|up\.weight|weight|weight_scale|comfy_quant)$"
)
QKV_PARTS = ("attn.q_proj", "attn.k_proj", "attn.v_proj")
PATCHERS = ("legacy", "auto")


def official():
    """(model_patch, loader_nodes) of the official ComfyUI-HyperFlow-Flash pack, as ComfyUI imported it."""
    import nodes as comfy_nodes

    node = comfy_nodes.NODE_CLASS_MAPPINGS.get("HyperFlowGGUFLoader")
    if node is not None:
        package = node.__module__.rsplit(".", 1)[0]
        patch, loader = sys.modules.get(f"{package}.model_patch"), sys.modules.get(f"{package}.loader_nodes")
        if patch is not None and loader is not None:
            return patch, loader
    # Not registered (yet): import it from its folder next to this pack under a private package name.
    name = "hyperflow_flash_official"
    if name not in sys.modules:
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), OFFICIAL_PACK)
        if not os.path.isfile(os.path.join(path, "model_patch.py")):
            raise RuntimeError(f"HyperFlow INT8 needs the official {OFFICIAL_PACK} custom node pack next to this one")
        spec = importlib.util.spec_from_file_location(
            name, os.path.join(path, "__init__.py"), submodule_search_locations=[path]
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{name}.model_patch"], sys.modules[f"{name}.loader_nodes"]


def pop_factored(sd: dict[str, torch.Tensor]) -> dict[int, dict[str, dict[str, torch.Tensor]]]:
    """Pops low-rank factors and split q/k/v parts; leaves a zero-byte dense-shaped placeholder for each, so model
    detection and the stock load see every dense linear (the module holding a placeholder is replaced after)."""
    parts: dict[int, dict[str, dict[str, torch.Tensor]]] = defaultdict(lambda: defaultdict(dict))
    for name in list(sd):
        match = PART.match(name)
        if match is None:
            continue
        block, module, leaf = int(match.group(1)), match.group(2), match.group(3)
        if module in QKV_PARTS or leaf in ("down.weight", "up.weight"):
            parts[block][module][leaf] = sd.pop(name)
    parts = {block: dict(modules) for block, modules in parts.items()}

    def out_in(part):
        if "weight" in part:
            return tuple(part["weight"].shape)
        return part["up.weight"].shape[0], part["down.weight"].shape[1]

    placeholder = torch.zeros((), dtype=torch.bfloat16)
    for block, modules in parts.items():
        if any(name in modules for name in QKV_PARTS):
            shapes = [out_in(modules[name]) for name in QKV_PARTS]
            shape = (sum(o for o, _ in shapes), shapes[0][1])
            sd[f"blocks.{block}.attn.qkv_proj.weight"] = placeholder.expand(shape)
        for name in ("attn.out_proj", "mlp.fc1", "mlp.fc2"):
            if name in modules:
                sd[f"blocks.{block}.{name}.weight"] = placeholder.expand(out_in(modules[name]))
    return parts


def build_linear(part: dict[str, torch.Tensor], ops, patch) -> nn.Module:
    """A low-rank pair (bf16) or one ComfyUI linear (bf16, or INT8 with weight_scale + comfy_quant)."""
    if "down.weight" in part:
        down_w, up_w = part["down.weight"], part["up.weight"]
        down = ops.Linear(down_w.shape[1], down_w.shape[0], bias=False)
        up = ops.Linear(up_w.shape[1], up_w.shape[0], bias=False)
        down.load_state_dict({"weight": down_w}, strict=False)
        up.load_state_dict({"weight": up_w}, strict=False)
        return patch.LowRankLinear(down, up)
    weight = part["weight"]
    linear = ops.Linear(weight.shape[1], weight.shape[0], bias=False)
    linear.load_state_dict(dict(part), strict=False)
    return linear


def install_factored(model, parts, ops, patch) -> int:
    """`FactorizedPlan.install` of the official pack, for torch tensors and INT8 parts."""
    for block_index, modules in parts.items():
        block = model.blocks[block_index]
        if any(name in modules for name in QKV_PARTS):
            block.attn.qkv_proj = patch.SplitQKV(*(build_linear(modules[name], ops, patch) for name in QKV_PARTS))
        if "attn.out_proj" in modules:
            block.attn.out_proj = build_linear(modules["attn.out_proj"], ops, patch)
        for name in ("mlp.fc1", "mlp.fc2"):
            if name in modules:
                setattr(block.mlp, name.split(".")[1], build_linear(modules[name], ops, patch))
        if "mlp.fc2" in modules:
            # The stock MLP fuses SwiGLU into fc2's INT8 GEMM, which needs fc2.weight; a low-rank fc2 has none.
            block.mlp.__class__ = patch.FactorizedMLP
    return len(parts)


def keep_fp32(model, tensors: dict[str, torch.Tensor]) -> int:
    """Put the checkpoint's fp32 tensors back as fp32 Parameters, and record fp32 as their model dtype.

    ComfyUI archives every parameter's dtype when it builds the model (`archive_model_dtypes`), and DynamicVRAM
    stages each weight in that dtype. Without updating the record, the fp32 biases (built in the compute dtype) would
    go through DynamicVRAM's cast path and live in VRAM as bf16. The legacy patcher does not read the record.
    """
    kept = 0
    for key, value in tensors.items():
        owner, _, leaf = key.rpartition(".")
        module = model.get_submodule(owner)
        current = getattr(module, leaf, None)
        if isinstance(current, torch.Tensor) and current.dtype != torch.float32 and current.shape == value.shape:
            setattr(module, leaf, nn.Parameter(value, requires_grad=False))
            kept += 1
        if hasattr(module, f"{leaf}_comfy_model_dtype"):
            setattr(module, f"{leaf}_comfy_model_dtype", torch.float32)
    return kept


def load_hyperflow_int8(path: str, patcher: str = "legacy"):
    patch, loader_nodes = official()
    sd, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    if "hyperflow_gate" not in sd:
        raise ValueError(
            f"{path} is not a HyperFlow INT8 checkpoint for ComfyUI. Use the files from "
            "https://huggingface.co/BennyDaBall/HyperFlow-H3-Flash-INT8-ComfyUI"
        )
    try:
        variant = json.loads((metadata or {}).get("hyperflow_int8", "{}")).get("variant", "unknown")
    except ValueError:
        variant = "unknown"
    gate = float(sd.pop("hyperflow_gate").float().flatten()[0])
    sigmas = sd.pop("hyperflow_sigmas", None)
    endpoint_sd = {
        name.removeprefix(ENDPOINT_PREFIX): sd.pop(name) for name in list(sd) if name.startswith(ENDPOINT_PREFIX)
    }
    parts = pop_factored(sd)
    fp32 = {k: v for k, v in sd.items() if v.dtype == torch.float32 and k.endswith((".weight", ".bias"))}
    fp32.update({ENDPOINT_PREFIX + k: v for k, v in endpoint_sd.items()})

    model_patcher = comfy.sd.load_diffusion_model_state_dict(
        sd, model_options={}, metadata=metadata, disable_dynamic=patcher == "legacy"
    )
    if model_patcher is None:
        raise RuntimeError(f"Could not detect the model type of {path}")
    model = model_patcher.model.diffusion_model
    if not isinstance(model, patch.PackedModel):
        raise RuntimeError(f"{path} is not a packed video+audio DiT checkpoint")

    # The Linear class ComfyUI picked for this checkpoint (mixed-precision ops: INT8 where comfy_quant says so).
    ops = SimpleNamespace(Linear=type(model.condition_proj))
    factorized = install_factored(model, parts, ops, patch)
    for tensor in endpoint_sd.values():
        tensor.tensor_shape = tensor.shape  # install_two_time reads GGUF-style shapes
    patch.install_two_time(model, endpoint_sd, gate, ops)
    restored = keep_fp32(model, fp32)
    model.hyperflow_sigmas = loader_nodes.step_sigmas() if sigmas is None else sigmas.float().flatten()
    model.hyperflow_variant = variant

    model_patcher.size = 0  # modules changed after the patcher was made: size it again on first use
    model_patcher.cached_patcher_init = (load_hyperflow_int8, (path, patcher))
    logging.info(
        "HyperFlow INT8 %s: %d blocks, %d with factorized linears, two-time gate %.3g, %d fp32 tensors kept, "
        "%d-step schedule, %s",
        variant, len(model.blocks), factorized, gate, restored, model.hyperflow_sigmas.shape[0] - 1,
        type(model_patcher).__name__,
    )
    return model_patcher


def model_files() -> list[str]:
    names = set()
    for key in ("diffusion_models", "unet"):
        if key in folder_paths.folder_names_and_paths:
            names.update(n for n in folder_paths.get_filename_list(key) if n.endswith(".safetensors"))
    return sorted(names)


def model_path(name: str) -> str:
    for key in ("diffusion_models", "unet"):
        if key in folder_paths.folder_names_and_paths:
            path = folder_paths.get_full_path(key, name)
            if path is not None:
                return path
    raise FileNotFoundError(name)


class HyperFlowINT8Loader:
    TITLE = "HyperFlow INT8 Loader"
    CATEGORY = "HyperFlow"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    DESCRIPTION = (
        "Loads a HyperFlow H3 Flash INT8 checkpoint (fl2va or ref2va) from "
        "BennyDaBall/HyperFlow-H3-Flash-INT8-ComfyUI on Hugging Face. INT8 linears run on ComfyUI's native "
        "int8_tensorwise + convrot ops. Use with HyperFlow Sigmas, euler, cfg 1."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"unet_name": (model_files(),)},
            "optional": {
                "patcher": (
                    list(PATCHERS),
                    {
                        "default": "legacy",
                        "tooltip": "legacy: the classic ModelPatcher, as the official GGUF loader uses (recommended); "
                        "auto (experimental): the patcher UNETLoader gets, DynamicVRAM when enabled",
                    },
                ),
            },
        }

    def load(self, unet_name, patcher="legacy"):
        return (load_hyperflow_int8(model_path(unet_name), patcher),)


NODE_CLASS_MAPPINGS = {"HyperFlowINT8Loader": HyperFlowINT8Loader}
NODE_DISPLAY_NAME_MAPPINGS = {"HyperFlowINT8Loader": HyperFlowINT8Loader.TITLE}
