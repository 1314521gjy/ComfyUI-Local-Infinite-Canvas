"""Opt-in ComfyUI nodes for merged DMAD MiniMax-H3 benchmark runs."""
from __future__ import annotations

import gc
import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import torch

from .dmad_sampling import (
    DMAD_AUDIO_SHIFT,
    DMAD_SAMPLING_CONTRACT,
    DMAD_STEP_COUNT,
    DMAD_VIDEO_SHIFT,
    DmadNoiseStream,
    build_comfy_dmad_sampler,
    shift_comfy_model,
    sigma_grid,
)

UPSTREAM_GATE_CORE_COMMIT = "ee71d5c4993f29086b27fde1629a945ae48425bf"

_SUPPORTED_VARIANTS = ("lora_critic", "full_critic")
_SUPPORTED_ATTENTION = ("dense", "vsa_fine_only")
_SUPPORTED_PRECISION = ("bf16", "fp8_e4m3fn", "nvfp4_mlp")
DEFAULT_DMAD_VRAM_RESERVE_GIB = 8.0


def _memory_flags(raw: str) -> dict[str, bool]:
    from .inference_features import FLAGS as SAMPLER_FEATURES
    from .memory_features import FLAGS

    if not isinstance(raw, str) or len(raw) > 8192:
        raise ValueError("memory_flags_json must be a JSON object no longer than 8192 characters")
    try:
        flags = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("memory_flags_json is invalid JSON") from exc
    if not isinstance(flags, dict):
        raise TypeError("memory_flags_json must be a JSON object")
    unknown = set(flags) - set(FLAGS)
    if unknown:
        raise ValueError(f"unknown memory optimization flags: {sorted(unknown)}")
    unimplemented = set(flags) - set(SAMPLER_FEATURES)
    if unimplemented:
        raise ValueError(f"memory optimization(s) are not wired at the DMAD sampling seam: {sorted(unimplemented)}")
    if any(type(value) is not bool for value in flags.values()):
        raise TypeError("memory optimization flags must be booleans")
    if flags.get("fuse_modulation_kernel"):
        raise ValueError("fuse_modulation_kernel is a killed experiment and cannot be enabled")
    if flags.get("rounded_modulation_scale_shift"):
        raise ValueError("rounded_modulation_scale_shift requires a separate arithmetic-quality profile")
    return {name: bool(flags.get(name, False)) for name in FLAGS}


class DmadModelError(RuntimeError):
    """The selected merged artifact cannot safely enter the Comfy H3 model path."""


def _vram_reserve_bytes(reserve_gib: float) -> int:
    """Validate a per-request Comfy low-VRAM reservation and return bytes."""
    if (type(reserve_gib) not in (int, float)
            or not torch.isfinite(torch.tensor(float(reserve_gib)))
            or not 0.0 <= float(reserve_gib) <= 24.0):
        raise ValueError("vram_reserve_gib must be a finite value in 0..24")
    return int(float(reserve_gib) * 1024**3)


def _first_node_output(value):
    outputs = getattr(value, "args", value)
    if isinstance(outputs, (tuple, list)) and outputs:
        return outputs[0]
    raise DmadModelError("Comfy attention patch did not return a model output")


def _validate_attention_mode(value: str) -> str:
    if value not in _SUPPORTED_ATTENTION:
        raise ValueError(f"attention_mode must be one of {_SUPPORTED_ATTENTION}")
    return value


def _json_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def read_dmad_artifact(path: str | os.PathLike[str], *, variant: str) -> tuple[Path, dict, str]:
    checkpoint = Path(path).resolve(strict=True)
    if not checkpoint.is_file() or checkpoint.suffix != ".safetensors":
        raise DmadModelError("DMAD checkpoint must be a Comfy converted safetensors file")
    sidecar = checkpoint.with_suffix(checkpoint.suffix + ".dmad.json")
    try:
        manifest = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DmadModelError(f"DMAD checkpoint manifest is missing or invalid: {exc}") from exc
    if manifest.get("format") != "comfystreamerh3-dmad-comfy-h3-v1":
        raise DmadModelError("Unsupported DMAD Comfy checkpoint manifest")
    if variant not in _SUPPORTED_VARIANTS or manifest.get("variant") != variant:
        raise DmadModelError("Selected DMAD variant does not match the checkpoint manifest")
    if (manifest.get("base_model_id") != "MiniMaxAI/MiniMax-H3"
            or manifest.get("base_revision") != "42ed227ee7df40d41602854ae760620d6eb651fe"):
        raise DmadModelError("DMAD checkpoint was not prepared from the pinned original MiniMax-H3 base")
    if manifest.get("comfyui_core_commit") != UPSTREAM_GATE_CORE_COMMIT:
        raise DmadModelError("DMAD checkpoint was converted for a different ComfyUI Core contract")
    if manifest.get("gate_compress") is not False:
        raise DmadModelError("DMAD Dense H3 must not synthesize or inherit FastH3 VSA gates")
    if manifest.get("activation_layout") != "comfy_gate_up":
        raise DmadModelError("DMAD checkpoint must convert Diffusers up/gate rows to Comfy gate/up order")
    checkpoint_identity = manifest.get("comfy_checkpoint")
    if not isinstance(checkpoint_identity, dict) or checkpoint_identity.get("file") != checkpoint.name:
        raise DmadModelError("DMAD manifest checkpoint name does not match the selected file")
    return checkpoint, manifest, str(checkpoint_identity.get("sha256", ""))


def _load_dmad_model(checkpoint: Path, precision_mode: str = "bf16"):
    """Load through pinned public Comfy APIs, accepting exactly the gate-free H3 variant."""
    import comfy.model_base
    import comfy.model_detection
    import comfy.ops
    import comfy.sd
    import comfy.utils
    from comfy.ldm.minimax.model import MiniMaxH3Model

    from .model_cache import comfyui_core_revision

    if not torch.cuda.is_available():
        raise DmadModelError("DMAD Comfy inference needs a CUDA GPU; no model state was loaded")
    core_revision = comfyui_core_revision()
    if core_revision != UPSTREAM_GATE_CORE_COMMIT:
        raise DmadModelError(
            f"DMAD checkpoint/runtime require ComfyUI {UPSTREAM_GATE_CORE_COMMIT}; found {core_revision}"
        )
    state_dict, metadata = comfy.utils.load_torch_file(str(checkpoint), return_metadata=True)
    prefix = comfy.model_detection.unet_prefix_from_state_dict(state_dict)
    gate_keys = [f"{prefix}blocks.{i}.attn.to_gate_compress.weight" for i in range(50)]
    if any(key in state_dict for key in gate_keys):
        raise DmadModelError("DMAD base unexpectedly contains FastH3 gate weights")
    model_options: dict[str, Any] = {}
    if precision_mode == "fp8_e4m3fn":
        # AIMDO preserves source storage dtype. The checkpoint must actually
        # contain FP8 matrices; a configured dtype alone does not convert them.
        # Keep norms/compute BF16 and explicitly exclude native unscaled FP8
        # arithmetic from this storage/memory arm.
        model_options.update(dtype=torch.bfloat16, custom_operations=comfy.ops.manual_cast)
    model = comfy.sd.load_diffusion_model_state_dict(
        state_dict, model_options=model_options, metadata=metadata, disable_dynamic=True,
    )
    if model is None:
        raise DmadModelError("Pinned Comfy Core could not recognize converted MiniMax-H3 weights")
    if type(model.model) is not comfy.model_base.MiniMaxH3 or model.model.model_type != comfy.model_base.ModelType.FLOW_AV:
        raise DmadModelError("DMAD model loader did not construct stock MiniMaxH3 FLOW_AV")
    backbone = model.get_model_object("diffusion_model")
    if (type(backbone) is not MiniMaxH3Model or len(backbone.blocks) != 50
            or len(backbone.token_refiner.blocks) != 2):
        raise DmadModelError("Converted checkpoint is not the supported MiniMax-H3 50+2 model")
    if precision_mode == "fp8_e4m3fn":
        _weight_storage_evidence(backbone, require_fp8=True)
    if any(getattr(block.attn, "to_gate_compress", None) is not None for block in backbone.blocks):
        raise DmadModelError("Dense DMAD model must have no FastH3 attention gates")
    if model.is_dynamic():
        raise DmadModelError("Merged DMAD weights must load without dynamic patching")
    model.cached_patcher_init = (_load_dmad_model, (str(checkpoint), precision_mode))
    return model


def _release_checkpoint_file_cache(checkpoint: Path) -> bool:
    """Ask Linux to reclaim clean safetensors page-cache pages before FP4 conversion."""
    advise = getattr(os, "posix_fadvise", None)
    dontneed = getattr(os, "POSIX_FADV_DONTNEED", None)
    if advise is None or dontneed is None:
        return False
    try:
        fd = os.open(checkpoint, os.O_RDONLY)
        try:
            advise(fd, 0, 0, dontneed)
        finally:
            os.close(fd)
    except OSError:
        return False
    return True


def _validate_weight_storage(manifest: dict, precision_mode: str) -> None:
    storage = manifest.get("weight_storage", {})
    is_fp8 = storage.get("mode") == "fp8_e4m3fn"
    is_int8_convrot = storage.get("mode") == "int8_convrot"
    if precision_mode == "fp8_e4m3fn":
        if not is_fp8 or storage.get("converted_linear_weights") != 260 or storage.get("scaled") is not False:
            raise DmadModelError("FP8 mode requires an exported FP8 checkpoint with 260 unscaled linear weights")
    elif is_fp8:
        raise DmadModelError("An FP8 checkpoint must use precision_mode=fp8_e4m3fn")
    if is_int8_convrot and (
            storage.get("converted_linear_weights") != 208
            or storage.get("convrot") is not True
            or storage.get("convrot_groupsize") != 256):
        raise DmadModelError("INT8 mode requires 208 shared ConvRot matrices with group size 256")
    if is_int8_convrot and precision_mode != "nvfp4_mlp":
        raise DmadModelError("INT8 ConvRot source checkpoints must use precision_mode=nvfp4_mlp")


def _weight_storage_evidence(backbone, *, require_fp8: bool = False) -> dict:
    counts: dict[str, int] = {}
    sizes: dict[str, int] = {}
    fp8_matrices = 0
    int8_matrices = 0
    int8_storage_bytes = 0
    int8_convrot_matrices = 0
    for name, parameter in backbone.named_parameters():
        dtype = str(parameter.dtype)
        counts[dtype] = counts.get(dtype, 0) + 1
        sizes[dtype] = sizes.get(dtype, 0) + parameter.numel() * parameter.element_size()
        qdata = getattr(parameter, "_qdata", None)
        if isinstance(qdata, torch.Tensor) and qdata.dtype == torch.int8:
            int8_matrices += 1
            int8_storage_bytes += qdata.numel() * qdata.element_size()
            int8_convrot_matrices += int(bool(getattr(getattr(parameter, "_params", None), "convrot", False)))
        if parameter.dtype == torch.float8_e4m3fn:
            if parameter.ndim != 2 or not name.endswith(".weight"):
                raise DmadModelError(f"Unexpected FP8 non-linear parameter: {name}")
            fp8_matrices += 1
    if require_fp8 and fp8_matrices != 260:
        raise DmadModelError(f"FP8 checkpoint loaded {fp8_matrices} FP8 matrices; expected 260")
    return {
        "dtype_tensors": counts,
        "dtype_bytes": sizes,
        "fp8_matrix_weights": fp8_matrices,
        "int8_quantized_matrices": int8_matrices,
        "int8_convrot_matrices": int8_convrot_matrices,
        "int8_storage_bytes": int8_storage_bytes,
    }


def _software_identity(manifest: dict, precision_mode: str, compile_transformer: bool = False) -> str:
    return "|".join((
        "comfystreamerh3-dmad-h3/v1",
        str(manifest.get("dmad_merge_manifest_sha256", "")),
        str(manifest.get("base_revision", "")),
        precision_mode,
        f"compile_transformer={bool(compile_transformer)}",
        str(torch.__version__),
        UPSTREAM_GATE_CORE_COMMIT,
    ))


def _transformer_compile_report(model, enabled: bool) -> dict[str, object]:
    if not enabled:
        from .transformer_compile import disabled_transformer_compile_report

        return disabled_transformer_compile_report(include_allocator_policy=True)
    from .transformer_compile import compile_fast_h3_transformer_forward

    # Preserve _forward for the request-scoped cache/release rewrites, and
    # suppress AIMDO's incompatible allocator graph during compiled calls.
    return compile_fast_h3_transformer_forward(
        model, disable_comfy_allocator_graph=True, emulate_precision_casts=True,
    )


_TRANSFORMER_COMPILE_IDENTITY_FIELDS = (
    "enabled",
    "scope",
    "transformer_body_compiled",
    "context_shell_eager",
    "compiler_options",
    "backend",
    "mode",
    "fullgraph",
    "compile_is_lazy",
    "comfy_allocator_graph_suppressed",
    "dynamo_disabled_ops",
    "kitchen_boundary_policy",
)


def _transformer_compile_identity(report: object) -> dict[str, object]:
    """Keep requested compiler policy; omit counters that change while running."""
    if not isinstance(report, Mapping):
        return {}
    return {
        key: report[key]
        for key in _TRANSFORMER_COMPILE_IDENTITY_FIELDS
        if key in report
    }


class ComfyStreamerH3DmadLoader:
    """Load one merged, gate-free DMAD checkpoint and opt into existing H3 acceleration."""

    RETURN_TYPES = ("MODEL", "H3_PROFILE")
    RETURN_NAMES = ("model", "profile")
    FUNCTION = "load"
    CATEGORY = "ComfyStreamerH3/DMAD"

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths

        checkpoints = sorted(
            name for name in folder_paths.get_filename_list("diffusion_models")
            if name.endswith(".safetensors")
        )
        return {
            "required": {
                "checkpoint": (checkpoints,),
                "text_encoder": (["qwen3vl_4b_fp8_scaled.safetensors"],
                                 {"default": "qwen3vl_4b_fp8_scaled.safetensors"}),
                "video_vae": (["minimax_h3_video_vae_int8_convrot.safetensors"],
                              {"default": "minimax_h3_video_vae_int8_convrot.safetensors"}),
                "audio_vae": (["minimax_h3_audio_vae_fp32.safetensors"],
                              {"default": "minimax_h3_audio_vae_fp32.safetensors"}),
                "variant": (list(_SUPPORTED_VARIANTS), {"default": "lora_critic"}),
                "precision_mode": (list(_SUPPORTED_PRECISION), {"default": "bf16"}),
                "attention_mode": (list(_SUPPORTED_ATTENTION), {"default": "dense"}),
                "vram_reserve_gib": ("FLOAT", {
                    "default": DEFAULT_DMAD_VRAM_RESERVE_GIB, "min": 0.0, "max": 24.0, "step": 1.0,
                }),
                "keep_percent": ("FLOAT", {"default": 100.0, "min": 5.0, "max": 100.0, "step": 5.0}),
                "vae_precision_policy": (["established", "fp16_accum"], {"default": "established"}),
                "kitchen_vae_fusions": ("BOOLEAN", {"default": False}),
                "compile_transformer": ("BOOLEAN", {"default": False}),
                "memory_flags_json": ("STRING", {"default": "{}", "multiline": True}),
                "omega_flags_json": ("STRING", {"default": "{}", "multiline": True}),
            }
        }

    @classmethod
    def IS_CHANGED(cls, checkpoint, variant="lora_critic", precision_mode="bf16",
                   attention_mode="dense", keep_percent=100.0,
                   vram_reserve_gib=DEFAULT_DMAD_VRAM_RESERVE_GIB,
                   text_encoder="qwen3vl_4b_fp8_scaled.safetensors",
                   video_vae="minimax_h3_video_vae_int8_convrot.safetensors",
                   audio_vae="minimax_h3_audio_vae_fp32.safetensors",
                   vae_precision_policy="established", kitchen_vae_fusions=False,
                   memory_flags_json="{}", omega_flags_json="{}", compile_transformer=False):
        import folder_paths

        resolved = Path(folder_paths.get_full_path_or_raise("diffusion_models", checkpoint))
        sidecar = resolved.with_suffix(resolved.suffix + ".dmad.json")
        stat = resolved.stat()
        manifest_id = hashlib.sha256(sidecar.read_bytes()).hexdigest()
        components = [
            (category, name, Path(folder_paths.get_full_path_or_raise(category, name)))
            for category, name in (("text_encoders", text_encoder), ("vae", video_vae),
                                   ("vae", audio_vae))
        ]
        component_identity = [
            (category, name, (p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns))
            for category, name, p in components
        ]
        identity = [checkpoint, (stat.st_dev, stat.st_ino, stat.st_size,
                                stat.st_mtime_ns, stat.st_ctime_ns), manifest_id, variant, precision_mode, attention_mode,
                    component_identity, float(keep_percent), float(vram_reserve_gib),
                    vae_precision_policy, bool(kitchen_vae_fusions),
                    memory_flags_json, omega_flags_json, bool(compile_transformer)]
        return _json_hash(identity)

    def load(self, checkpoint, variant="lora_critic", precision_mode="bf16",
             attention_mode="dense", keep_percent=100.0,
             vram_reserve_gib=DEFAULT_DMAD_VRAM_RESERVE_GIB,
             text_encoder="qwen3vl_4b_fp8_scaled.safetensors",
             video_vae="minimax_h3_video_vae_int8_convrot.safetensors",
             audio_vae="minimax_h3_audio_vae_fp32.safetensors",
             vae_precision_policy="established", kitchen_vae_fusions=False,
             memory_flags_json="{}", omega_flags_json="{}", compile_transformer=False):
        import comfy.model_management
        import folder_paths

        from .attention_policy import attention_policy
        from .fp4_kernel_config import set_fp4_kernel
        from .model_cache import FUSED_BASE_CACHE, model_key
        from .model_provenance import model_content_manifest

        if variant not in _SUPPORTED_VARIANTS:
            raise ValueError(f"variant must be one of {_SUPPORTED_VARIANTS}")
        if precision_mode not in _SUPPORTED_PRECISION:
            raise ValueError(f"precision_mode must be one of {_SUPPORTED_PRECISION}")
        if vae_precision_policy not in ("established", "fp16_accum"):
            raise ValueError("vae_precision_policy must be established or fp16_accum")
        if type(compile_transformer) is not bool:
            raise TypeError("compile_transformer must be a boolean")
        attention_mode = _validate_attention_mode(attention_mode)
        memory_flags = _memory_flags(memory_flags_json)
        if not isinstance(omega_flags_json, str) or len(omega_flags_json) > 8192:
            raise ValueError("omega_flags_json must be a JSON object no longer than 8192 characters")
        try:
            omega_flags = json.loads(omega_flags_json or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("omega_flags_json is invalid JSON") from exc
        if not isinstance(omega_flags, dict):
            raise TypeError("omega_flags_json must be a JSON object")
        omega_config = None
        omega_execution_flags = {}
        if omega_flags:
            from .omega_config import resolve_omega_config

            omega_config = resolve_omega_config(
                identity="omega_unfused",
                attention_option="vsa" if attention_mode == "vsa_fine_only" else "dense",
                backend="kitchen",
                requested=omega_flags,
            )
            omega_execution_flags = {
                name: omega_config["applied"][name]
                for name in (
                    "omega_skip_measure_gate", "omega_masked_retile",
                    "omega_native_masked_retile", "omega_fusion_scratch_pool",
                    "omega_measure_only", "omega_producer_direct_carriers",
                )
            }
        if not isinstance(keep_percent, (int, float)) or not 5.0 <= keep_percent <= 100.0:
            raise ValueError("DMAD sparse attention retention must be in 5..100 percent")
        vram_reserve_bytes = _vram_reserve_bytes(vram_reserve_gib)
        vram_reserve_gib = vram_reserve_bytes / 1024**3
        selected_path = folder_paths.get_full_path_or_raise("diffusion_models", checkpoint)
        resolved_path, manifest, manifest_checkpoint_hash = read_dmad_artifact(selected_path, variant=variant)
        _validate_weight_storage(manifest, precision_mode)
        component_paths = {
            checkpoint: resolved_path,
            text_encoder: folder_paths.get_full_path_or_raise("text_encoders", text_encoder),
            video_vae: folder_paths.get_full_path_or_raise("vae", video_vae),
            audio_vae: folder_paths.get_full_path_or_raise("vae", audio_vae),
        }
        asset_manifest = model_content_manifest(component_paths)
        checkpoint_sha = asset_manifest[checkpoint]
        if checkpoint_sha != manifest_checkpoint_hash:
            raise DmadModelError("DMAD checkpoint hash disagrees with its conversion receipt")

        attention = attention_mode
        if attention == "vsa_fine_only":
            from comfy_kitchen.backends import cuda
            if not getattr(cuda, "_EXT_AVAILABLE", False):
                raise DmadModelError(f"Gate-less VSA requires the compiled Kitchen CUDA extension: {cuda._EXT_ERROR}")
            from .vsa_sm120.config import reset_vsa_options, set_vsa_options
            reset_vsa_options()
            set_vsa_options(
                backend="kitchen", attention_option="vsa",
                topk_ratio=float(keep_percent) / 100.0, block_size=64,
                mask_reuse="off", kv_quant="bf16", token_aug=0,
            )
        else:
            from .vsa_sm120.config import reset_vsa_options
            reset_vsa_options()
        set_fp4_kernel(blocks_per_program=0)
        key = model_key(
            resolved_path,
            device=comfy.model_management.get_torch_device(),
            precision=precision_mode,
            software=_software_identity(manifest, precision_mode, compile_transformer),
        )

        def initialize():
            base = _load_dmad_model(resolved_path, precision_mode)
            # Comfy can map the checkpoint into the process; drop file-backed
            # source pages and collect transient loader objects before any
            # extra precision representation is retained.
            gc.collect()
            cache_drop_requested = _release_checkpoint_file_cache(resolved_path)
            if precision_mode == "nvfp4_mlp":
                from .fused_mlp import apply_fused_mlp

                base, precision = apply_fused_mlp(base)
                precision = precision.to_dict()
                precision["quality_class"] = "approximate"
            elif precision_mode == "fp8_e4m3fn":
                precision = {
                    "enabled": False,
                    "applied": [],
                    "skipped": [f"diffusion_model.blocks.{i}.mlp" for i in range(50)],
                    "quality_class": "unscaled_fp8_storage_bf16_compute",
                    "weight_dtype": "torch.float8_e4m3fn",
                    "compute_dtype": "torch.bfloat16",
                    "native_fp8_gemm": False,
                }
            else:
                precision = {
                    "enabled": False,
                    "applied": [],
                    "skipped": [f"diffusion_model.blocks.{i}.mlp" for i in range(50)],
                    "quality_class": "bf16_reference",
                }
            precision["checkpoint_file_cache_dontneed_requested"] = cache_drop_requested
            storage_field = "source_weight_storage" if precision_mode == "nvfp4_mlp" else "actual_weight_storage"
            precision[storage_field] = _weight_storage_evidence(
                base.get_model_object("diffusion_model"), require_fp8=precision_mode == "fp8_e4m3fn",
            )
            precision["gate_compress"] = False
            return base, precision

        with FUSED_BASE_CACHE.clone(key, initialize) as (model, precision, cache_report):
            # Preserve Comfy's low-VRAM block offload on 32 GiB cards. MLP FP4
            # conversion above is streamed one source matrix at a time from CPU.
            comfy.model_management.load_models_gpu(
                [model], memory_required=vram_reserve_bytes, force_full_load=False,
            )
            sparse_report = None
            if attention == "vsa_fine_only":
                from . import sol_attn_minimax_v5 as sparse

                patched = sparse._apply_patch(
                    model, tau=1.3, start_percent=0.0, end_percent=1.0,
                    min_tokens=0, sink_conditioning="exact_kv_and_rows", verbose=True,
                    topk_ratio=float(keep_percent) / 100.0, vsa=True, chunk_size=8192,
                    attention_option="vsa", attention_policy=attention_policy("vsa", "control"),
                    producer_skip_bootstrap_gate=True,
                    omega_flags=omega_execution_flags,
                )
                model = _first_node_output(patched)
                sparse_report = {
                    "status": "applied",
                    "backend": "kitchen",
                    "attention_option": "vsa",
                    "topk_ratio": float(keep_percent) / 100.0,
                    "fine_only": True,
                }
            transformer_compile = _transformer_compile_report(model, compile_transformer)
            profile = {
                "model_family": "dmad",
                "model_variant": variant,
                "base_model_id": manifest["base_model_id"],
                "base_revision": manifest["base_revision"],
                "checkpoint": checkpoint,
                "text_encoder": text_encoder,
                "video_vae": video_vae,
                "audio_vae": audio_vae,
                "steps": DMAD_STEP_COUNT,
                "sampler": "dmad_4step_renoise",
                "sampling_contract": DMAD_SAMPLING_CONTRACT,
                "sigma_positions": sigma_grid().tolist(),
                "video_shift": DMAD_VIDEO_SHIFT,
                "audio_shift": DMAD_AUDIO_SHIFT,
                "audio_enabled": True,
                "precision_mode": precision_mode,
                "vram_reserve_gib": float(vram_reserve_gib),
                "vae_precision_policy": vae_precision_policy,
                "kitchen_vae_fusions": bool(kitchen_vae_fusions),
                "memory_flags": memory_flags,
                "omega_flags": omega_flags,
                "omega_config": omega_config,
                "producer_skip_bootstrap_gate": attention == "vsa_fine_only",
                "transformer_compile": transformer_compile,
                "memory_flags_json": json.dumps(memory_flags, sort_keys=True, separators=(",", ":")),
                "memory_optimizations_diagnostic_only": bool(
                    memory_flags.get("profile_modulation") or memory_flags.get("first_hit_counters")
                ),
                "precision_report": precision,
                "attention_mode": attention,
                "attention_keep_percent": float(keep_percent) if attention != "dense" else None,
                "gate_compress": False,
                "sparse_attention_execution": sparse_report,
                "model_manifest": asset_manifest,
                "dmad_conversion_manifest_sha256": manifest["dmad_merge_manifest_sha256"],
                "dmad_comfy_manifest_sha256": _json_hash(manifest),
                "model_cache": cache_report,
                "kitchen_baseline": None,
                "status": "unqualified_candidate",
            }
            config_hash_payload = {
                k: profile[k] for k in (
                    "model_family", "model_variant", "checkpoint", "steps", "sampler",
                    "sampling_contract", "video_shift", "audio_shift", "precision_mode",
                    "vram_reserve_gib",
                    "attention_mode", "attention_keep_percent", "dmad_comfy_manifest_sha256",
                    "memory_flags", "omega_flags", "producer_skip_bootstrap_gate",
                )
            }
            config_hash_payload["transformer_compile"] = _transformer_compile_identity(
                profile["transformer_compile"]
            )
            profile["config_hash"] = _json_hash(config_hash_payload)
        return model, profile



class ComfyStreamerH3DmadSampling:
    """Pair native H3 audio/video shifts with DMAD re-noise sampling and RNG."""

    RETURN_TYPES = ("MODEL", "SAMPLER", "SIGMAS", "DMAD_NOISE")
    RETURN_NAMES = ("model", "sampler", "sigmas", "noise_stream")
    FUNCTION = "create"
    CATEGORY = "ComfyStreamerH3/DMAD"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "profile": ("H3_PROFILE",),
            "seed": ("INT", {"default": 42, "min": 0, "max": 0x7FFFFFFFFFFFFFFF}),
            "run_nonce": ("STRING", {"default": ""}),
        }}

    @classmethod
    def IS_CHANGED(cls, model, profile, seed, run_nonce):
        if not isinstance(run_nonce, str) or not run_nonce.strip():
            raise ValueError("run_nonce must be a unique non-empty string")
        return float("nan")

    def create(self, model, profile, seed, run_nonce):
        if (not isinstance(profile, dict) or profile.get("model_family") != "dmad"
                or profile.get("sampling_contract") != DMAD_SAMPLING_CONTRACT):
            raise DmadModelError("DMAD sampler requires a DMAD-profile model")
        if not isinstance(run_nonce, str) or not run_nonce.strip():
            raise ValueError("run_nonce must be a unique non-empty string")
        shifted = shift_comfy_model(model)
        sampler, noise, sigmas = build_comfy_dmad_sampler(DmadNoiseStream(int(seed)))
        return shifted, sampler, sigmas, noise
