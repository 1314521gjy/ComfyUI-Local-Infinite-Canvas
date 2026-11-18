"""ComfyUI nodes: load a HyperFlow GGUF or safetensors checkpoint and emit the 4, 6 or 8-step schedule it samples."""

from __future__ import annotations

import functools
import logging
from types import SimpleNamespace

import comfy.sd
import comfy.utils
import folder_paths
import torch

from . import safetensors_io
from .model_patch import ENDPOINT_PREFIX, FactorizedPlan, PackedModel, install_two_time

# Raw interval knots by step count and the video flow shift they are mapped through.
RAW_SIGMAS = {
    4: (1.0, 0.681872, 0.205019, 0.036496, 0.0),
    6: (1.0, 0.825217, 0.471725, 0.147401, 0.049626, 0.015517, 0.0),
    8: (1.0, 0.931506, 0.839236, 0.703462, 0.5, 0.296538, 0.160764, 0.068494, 0.0),
}
DEFAULT_STEPS = 6
VIDEO_SHIFT = 12.0
WEIGHTS_IN = ("auto", "ram", "disk")


def step_sigmas(steps: int = DEFAULT_STEPS) -> torch.Tensor:
    raw = torch.tensor(RAW_SIGMAS[steps], dtype=torch.float64)
    return (VIDEO_SHIFT * raw / (1 + (VIDEO_SHIFT - 1) * raw)).float()


MODEL_FOLDERS = ("unet_gguf", "diffusion_models", "unet")


def gguf_files() -> list[str]:
    names = set()
    for key in MODEL_FOLDERS:
        if key in folder_paths.folder_names_and_paths:
            names.update(name for name in folder_paths.get_filename_list(key) if name.endswith(".gguf"))
    return sorted(names)


def model_path(name: str) -> str:
    for key in MODEL_FOLDERS:
        if key in folder_paths.folder_names_and_paths:
            path = folder_paths.get_full_path(key, name)
            if path is not None:
                return path
    raise FileNotFoundError(name)


gguf_path = model_path


def safetensors_files() -> list[str]:
    """Safetensors files that carry HyperFlow metadata; other diffusion models are left out of the list."""
    names = set()
    for key in MODEL_FOLDERS:
        if key not in folder_paths.folder_names_and_paths:
            continue
        for name in folder_paths.get_filename_list(key):
            if name.endswith(".safetensors") and name not in names:
                path = folder_paths.get_full_path(key, name)
                if path is not None and safetensors_io.hyperflow_info(path) is not None:
                    names.add(name)
    return sorted(names)


def pop_extras(state_dict: dict[str, torch.Tensor]):
    """The step-endpoint gate, the stored schedule and the endpoint embedder, which the stock model does not have."""
    gate = state_dict.pop("hyperflow_gate", None)
    sigmas = state_dict.pop("hyperflow_sigmas", None)
    endpoint_sd = {
        name.removeprefix(ENDPOINT_PREFIX): state_dict.pop(name)
        for name in list(state_dict)
        if name.startswith(ENDPOINT_PREFIX)
    }
    return gate, sigmas, endpoint_sd


def packed_model(patcher, path: str) -> PackedModel:
    if patcher is None:
        raise RuntimeError(f"Could not detect the model type of {path}")
    model = patcher.model.diffusion_model
    if not isinstance(model, PackedModel):
        raise RuntimeError(f"{path} is not a packed video+audio DiT checkpoint")
    return model


@functools.cache
def disk_patcher(base: type) -> type:
    """A GGUFModelPatcher whose offloaded weights stay in the memory-mapped file.

    When the transformer does not fit on the GPU, the stock patcher copies every weight into RAM ("release mmap") and
    pins what it offloads, so 9 GB of memory the OS cannot reclaim. Here the weights that do not fit stay in the file's
    page cache and stream to the GPU layer by layer (ComfyUI's lowvram path); under memory pressure the OS drops those
    pages and reads them again from disk. What fits on the GPU loads as usual.
    """

    class HyperFlowDiskPatcher(base):
        mmap_released = True

        def pin_weight_to_device(self, key):
            pass

        def clone(self, *args, **kwargs):
            clone = base.clone(self, *args, **kwargs)
            clone.__class__ = HyperFlowDiskPatcher
            # GGUFModelPatcher.clone copies the source's flag into the instance, which would hide the class's.
            clone.mmap_released = True
            return clone

    return HyperFlowDiskPatcher


def supports_disk(base: type) -> bool:
    """`disk_patcher` overrides these ComfyUI-GGUF internals; an older or newer GGUFModelPatcher may lack them."""
    return hasattr(base, "mmap_released") and hasattr(base, "pin_weight_to_device")


def weights_on_disk(path: str, weights_in: str) -> bool:
    if weights_in != "auto":
        return weights_in == "disk"
    try:
        import comfy.storage
    except ImportError:
        return False
    model_fast_disk = getattr(comfy.storage, "model_fast_disk", None)
    return model_fast_disk is not None and model_fast_disk([path])


def load_hyperflow_gguf(path: str, weights_in: str = "auto"):
    from .gguf_io import GGUFBackend

    backend = GGUFBackend.find()
    state_dict = backend.read(path)
    gate, sigmas, endpoint_sd = pop_extras(state_dict)
    plan = FactorizedPlan(state_dict, backend.placeholder)
    ops = backend.operations()
    patcher = comfy.sd.load_diffusion_model_state_dict(
        state_dict, model_options={"custom_operations": ops}, disable_dynamic=True
    )
    model = packed_model(patcher, path)
    factorized = plan.install(model, ops)
    if gate is not None:
        install_two_time(model, endpoint_sd, float(backend.to_float(gate).flatten()[0]), ops)
    model.hyperflow_sigmas = step_sigmas() if sigmas is None else backend.to_float(sigmas).flatten()
    logging.info(
        "HyperFlow: %d factorized blocks, two-time=%s, %d-step schedule",
        factorized,
        gate is not None,
        model.hyperflow_sigmas.shape[0] - 1,
    )
    base = backend.nodes.GGUFModelPatcher
    on_disk = weights_on_disk(path, weights_in)
    if on_disk and not supports_disk(base):
        logging.warning("HyperFlow: this ComfyUI-GGUF cannot keep weights in the file; falling back to ram")
        on_disk = False
    patcher_class = disk_patcher(base) if on_disk else base
    patcher = patcher_class.clone(patcher)
    patcher.size = 0
    logging.info("HyperFlow: transformer weights in %s (weights_in=%s)", "disk" if on_disk else "ram", weights_in)
    return patcher


def load_hyperflow_safetensors(path: str):
    info = safetensors_io.checked_info(path)
    state_dict, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    gate, sigmas, endpoint_sd = pop_extras(state_dict)
    if gate is None or sigmas is None or not endpoint_sd:
        raise RuntimeError(f"{path} has HyperFlow metadata but no step-endpoint tensors")
    plan = FactorizedPlan(state_dict, safetensors_io.placeholder)
    full_precision = safetensors_io.float32_tensors(state_dict)
    patcher = comfy.sd.load_diffusion_model_state_dict(
        state_dict, model_options={}, metadata=metadata, disable_dynamic=True
    )
    model = packed_model(patcher, path)
    ops = SimpleNamespace(Linear=type(model.condition_proj))
    factorized = plan.install(model, ops)
    install_two_time(model, endpoint_sd, float(gate.float().flatten()[0]), ops)
    restored = safetensors_io.keep_float32(model, full_precision)
    restored += safetensors_io.keep_float32(model.endpoint_time_embedder, endpoint_sd)
    chunked = safetensors_io.limit_int8_rows(model)
    model.hyperflow_sigmas = sigmas.float().flatten().cpu()
    patcher.size = 0
    logging.info(
        "HyperFlow: %s %s (layout %s), %d factorized blocks, %d fp32 tensors, %d row-chunked INT8 modules, "
        "%d-step schedule",
        info.get("variant", "?"),
        info.get("weights", "?"),
        info.get("format"),
        factorized,
        restored,
        chunked,
        model.hyperflow_sigmas.shape[0] - 1,
    )
    return patcher


def load_hyperflow(path: str, weights_in: str = "auto"):
    if path.endswith(".gguf"):
        return load_hyperflow_gguf(path, weights_in)
    return load_hyperflow_safetensors(path)


WEIGHTS_IN_INPUT = (
    list(WEIGHTS_IN),
    {
        "default": "auto",
        "tooltip": "GGUF only. disk: weights that do not fit on the GPU stay in the memory-mapped file and stream "
        "from it, for machines with little RAM; ram: copy them into RAM; auto: disk with --fast-disk or a fast "
        "NVMe drive",
    },
)


class HyperFlowLoader:
    TITLE = "HyperFlow Loader"
    CATEGORY = "HyperFlow"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    DESCRIPTION = (
        "Loads a HyperFlow transformer from diffusion_models: a GGUF (needs ComfyUI-GGUF) or an INT8 convrot "
        "safetensors (runs on ComfyUI's INT8 kernels)."
    )

    @classmethod
    def INPUT_TYPES(cls):
        names = sorted(set(gguf_files()) | set(safetensors_files()))
        return {"required": {"unet_name": (names,)}, "optional": {"weights_in": WEIGHTS_IN_INPUT}}

    def load(self, unet_name, weights_in="auto"):
        return (load_hyperflow(model_path(unet_name), weights_in),)


class HyperFlowGGUFLoader:
    TITLE = "HyperFlow GGUF Loader"
    CATEGORY = "HyperFlow"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"unet_name": (gguf_files(),)},
            "optional": {
                "weights_in": (
                    list(WEIGHTS_IN),
                    {
                        "default": "auto",
                        "tooltip": "disk: weights that do not fit on the GPU stay in the memory-mapped file and "
                        "stream from it, for machines with little RAM; ram: copy them into RAM; auto: disk with "
                        "--fast-disk or a fast NVMe drive",
                    },
                ),
            },
        }

    def load(self, unet_name, weights_in="auto"):
        return (load_hyperflow_gguf(gguf_path(unet_name), weights_in),)


class HyperFlowSigmas:
    TITLE = "HyperFlow Sigmas"
    CATEGORY = "HyperFlow"
    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "sigmas"
    DESCRIPTION = (
        "Step schedule of the checkpoint: 4 steps favour speed, 6 (default) balance speed and quality, 8 favour "
        "quality. Use it with SamplerCustom, euler, cfg 1."
    )

    @classmethod
    def INPUT_TYPES(cls):
        steps = ("INT", {"default": DEFAULT_STEPS, "min": 4, "max": 8, "step": 2})
        return {"required": {"model": ("MODEL",)}, "optional": {"steps": steps}}

    def sigmas(self, model, steps=DEFAULT_STEPS):
        steps = int(steps)
        if steps not in RAW_SIGMAS:
            raise ValueError(f"HyperFlow samples {sorted(RAW_SIGMAS)} steps, got {steps}")
        schedule = getattr(model.model.diffusion_model, "hyperflow_sigmas", None)
        if steps != DEFAULT_STEPS or schedule is None:
            schedule = step_sigmas(steps)
        return (schedule.clone().cpu(),)


NODE_CLASS_MAPPINGS = {
    "HyperFlowLoader": HyperFlowLoader,
    "HyperFlowGGUFLoader": HyperFlowGGUFLoader,
    "HyperFlowSigmas": HyperFlowSigmas,
}
NODE_DISPLAY_NAME_MAPPINGS = {name: node.TITLE for name, node in NODE_CLASS_MAPPINGS.items()}
