"""Production FastH3 loader for the measured SportsBall path."""

import hashlib
import json
import os
from typing import cast

import comfy.model_management
import comfy.samplers
import torch

from . import sol_attn_minimax_v5 as sparse
from .attention_options import (
    ATTENTION_OPTIONS,
    DEFAULT_ATTENTION_OPTION,
    require_attention_option,
)
from .attention_policy import ATTENTION_POLICIES
from .attention_policy import attention_policy as resolve_attention_policy
from .contract import video_sigmas
from .fp4_kernel_config import set_fp4_kernel
from .kitchen_baseline import (
    B1_PRESET,
    BASELINE_CHUNK_SIZE,
    BASELINE_DECODER_QK_INPLACE,
    BASELINE_FUSED_OUTPUT_PACK,
    BASELINE_OUTPUT_HOST_COPY,
    BASELINE_SKIP_BOOTSTRAP_GATE,
    KITCHEN_VERSION,
    KITCHEN_WHEEL_SHA256,
    TOKEN_AUG_CHOICES,
    VAE_PRECISION_POLICIES,
)
from .loader import (
    UPSTREAM_GATE_CORE_COMMIT,
    load_upstream_gate_checkpoint,
    upstream_gate_loader_manifest,
)
from .model_cache import (
    FUSED_BASE_CACHE,
    comfyui_core_revision,
    fasth3_software_identity,
    model_key,
)
from .model_provenance import (
    fasth3_model_manifest,
    model_content_manifest,
    model_selection_signature,
)
from .pdmd_lora import PDMD_2STEP_LABEL, PDMD_2STEP_VARIANT
from .runtime import DEFAULT_PRESET, PRESETS, preset_manifest, require_b1_runtime, runtime_identity

_FUSED_MLP_ENV = "COMFYSTREAMERH3_FUSED_MLP"


def fused_mlp_enabled_from_env() -> bool:
    """Allow Blackwell deployments to fall back when offloaded weights stay on CPU."""
    value = os.environ.get(_FUSED_MLP_ENV, "auto").strip().lower() or "auto"
    if value in {"auto", "enabled", "1", "true", "yes", "on"}:
        return True
    if value in {"disabled", "0", "false", "no", "off"}:
        return False
    raise ValueError(f"{_FUSED_MLP_ENV} must be auto, enabled, or disabled")


def check_cuda_backend(*, require_sol=True):
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU required")
    if not require_sol:
        return None
    from comfy_kitchen.backends import cuda

    if not getattr(cuda, "_EXT_AVAILABLE", False):
        raise RuntimeError(f"Compiled kitchen CUDA extension unavailable: {cuda._EXT_ERROR}")
    if require_sol:
        for name in ("sol_attn", "sol_attn_chunked"):
            if not callable(getattr(cuda, name, None)):
                raise RuntimeError(f"Kitchen CUDA backend missing {name}")  # noqa: TRY004
    return cuda


class ComfyStreamerH3OptimizedLoader:
    """Load the production path or an explicitly marked narrow weight variant."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (list(PRESETS), {"default": DEFAULT_PRESET}),
            },
            "optional": {
                # Optional preserves existing workflow JSON that predates the
                # experiment selector.
                "model_variant": (["base", PDMD_2STEP_LABEL], {"default": "base"}),
                "gate_loader": (["legacy", "upstream_candidate"], {"default": "legacy"}),
                "compile_transformer": ("BOOLEAN", {"default": True}),
                "compile_transformer_scope": (["qkv", "modulation"], {"default": "qkv"}),
                "lora_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "attention_option": (list(ATTENTION_OPTIONS), {"default": DEFAULT_ATTENTION_OPTION}),
                "token_aug": (list(TOKEN_AUG_CHOICES), {"default": 0}),
                "vae_precision_policy": (list(VAE_PRECISION_POLICIES), {"default": "established"}),
                "attention_policy": (list(ATTENTION_POLICIES), {"default": "control"}),
                "producer_masked_retile": ("BOOLEAN", {"default": False}),
                "producer_native_masked_retile": ("BOOLEAN", {"default": False}),
                "fusion_scratch_pool": ("BOOLEAN", {"default": False}),
                "fusion_retained_operand_bytes": ("INT", {"default": 0, "min": 0, "max": 1073741824}),
                "fusion_reuse_geometry": ("BOOLEAN", {"default": False}),
                "fusion_share_phase_validity": ("BOOLEAN", {"default": False}),
                "fusion_native_preparation": ("BOOLEAN", {"default": False}),
                "fusion_native_ragged_preparation": ("BOOLEAN", {"default": False}),
                "fusion_optimize_phase_metadata": ("BOOLEAN", {"default": False}),
                "fusion_fused_route_metadata": ("BOOLEAN", {"default": False}),
                # OMEGA is intentionally opt-in.  Empty values preserve legacy
                # workflows; benchmark workflows provide an explicit identity
                # and a JSON object containing one or more requested flags.
                "omega_identity": (["", "stock_reference", "omega_unfused"],
                                    {"default": ""}),
                "omega_flags_json": ("STRING", {"default": "{}"}),
                "vc_e2e_config_hash": ("STRING", {"default": ""}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, preset, prompt=None, unique_id=None, model_variant="base",
                   lora_strength=1.0, gate_loader="legacy", compile_transformer=True,
                   compile_transformer_body=False, compile_transformer_scope="qkv",
                   **_kwargs):
        # PROMPT itself is not part of Comfy's input cache signature. Bind only
        # selected names/files so nonce/seed changes still reuse the fused base.
        import folder_paths

        signature = model_selection_signature(
            PRESETS[preset]["checkpoint"], prompt, unique_id,
            resolve_path=folder_paths.get_full_path_or_raise,
        )
        # Adapter strength participates in the selected variant's cache key;
        # the adapter itself remains lazily downloaded in load().
        if model_variant in (PDMD_2STEP_LABEL, PDMD_2STEP_VARIANT):
            signature = f"{signature}:{PDMD_2STEP_VARIANT}:{float(lora_strength):.6f}"
        # Ownership changes invalidate Comfy's cached node output independently
        # of the historical preset and policy hashes in saved workflows.
        signature = f"{signature}:fasth3-native-gates/v2"
        if type(compile_transformer) is not bool:
            raise TypeError("compile_transformer must be a boolean")
        if compile_transformer:
            scope = compile_transformer_scope
            signature = f"{signature}:torch-compile-boundary/v11:{scope}"
        if gate_loader == "upstream_candidate":
            return f"{signature}:fasth3-upstream-gate-loader/v1"
        if gate_loader != "legacy":
            raise ValueError(f"unknown gate loader: {gate_loader!r}")
        return signature

    RETURN_TYPES = ("MODEL", "SAMPLER", "SIGMAS", "H3_PROFILE")
    RETURN_NAMES = ("model", "sampler", "sigmas", "profile")
    FUNCTION = "load"
    CATEGORY = "ComfyStreamerH3/Deploy"

    def load(self, preset, attention_option=DEFAULT_ATTENTION_OPTION,
             token_aug=0, vae_precision_policy="established", attention_policy="control",
             producer_masked_retile=False,
             producer_native_masked_retile=False, fusion_scratch_pool=False,
             fusion_retained_operand_bytes=0, fusion_reuse_geometry=False,
             fusion_share_phase_validity=False, fusion_native_preparation=False,
             fusion_native_ragged_preparation=False, fusion_optimize_phase_metadata=False,
             fusion_fused_route_metadata=False, omega_identity=None,
             omega_flags=None, omega_flags_json=None, vc_e2e_config_hash="",
             model_variant="base", lora_strength=1.0, prompt=None, unique_id=None,
             gate_loader="legacy", compile_transformer=True, compile_transformer_body=False,
             compile_transformer_scope="qkv"):
        from .vsa_sm120.config import kitchen_version, reset_vsa_options, set_vsa_options

        model_variant = model_variant or "base"
        if type(compile_transformer_body) is not bool:
            raise TypeError("compile_transformer_body must be a boolean")
        if compile_transformer_scope not in {"qkv", "modulation"}:
            raise ValueError("unknown compiler region scope")
        if compile_transformer_body:
            raise ValueError("whole-body compilation is not output-qualified; select qkv or modulation")
        if model_variant not in ("base", PDMD_2STEP_LABEL, PDMD_2STEP_VARIANT):
            raise ValueError(f"unknown model variant: {model_variant!r}")
        use_pdmd = model_variant in (PDMD_2STEP_LABEL, PDMD_2STEP_VARIANT)
        if gate_loader not in ("legacy", "upstream_candidate"):
            raise ValueError(f"unknown gate loader: {gate_loader!r}")
        if gate_loader == "upstream_candidate" and use_pdmd:
            raise ValueError("upstream gate loader candidate excludes the PDMD variant")
        if not isinstance(lora_strength, (int, float)) or not 0.0 <= lora_strength <= 2.0:
            raise ValueError("lora_strength must be between 0.0 and 2.0")
        if type(compile_transformer) is not bool:
            raise TypeError("compile_transformer must be a boolean")

        if omega_flags is None and omega_flags_json:
            try:
                decoded_flags = json.loads(omega_flags_json)
            except (TypeError, json.JSONDecodeError) as exc:
                raise ValueError("omega_flags_json must be a JSON object") from exc
            if not isinstance(decoded_flags, dict):
                raise ValueError("omega_flags_json must be a JSON object")
            omega_flags = decoded_flags
        omega_identity = omega_identity or None

        selected_attention = require_attention_option(attention_option, native=True)
        baseline_active = preset == B1_PRESET
        # The bootstrap-gate elision is the VSA baseline. Candidate attention
        # arms do not have this Kitchen traversal contract, so the default must
        # not make them fail merely because the optional input was omitted.
        producer_skip_bootstrap_gate = bool(
            BASELINE_SKIP_BOOTSTRAP_GATE
            and baseline_active
            and selected_attention.name == "vsa"
        )
        candidate_policy = resolve_attention_policy(selected_attention.name, attention_policy)
        omega_config = None
        if omega_identity is not None or omega_flags:
            from .omega_config import resolve_omega_config
            resolved_identity = omega_identity or "omega_unfused"
            # The private all-off artifact must not inherit the historical
            # loader default.  A requested OMEGA producer bit is applied
            # below after this explicit baseline reset.
            if resolved_identity in ("stock_reference", "omega_unfused"):
                producer_skip_bootstrap_gate = False
            omega_config = resolve_omega_config(
                identity=resolved_identity,
                attention_option=selected_attention.name,
                backend="kitchen" if selected_attention.name == "vsa" else "native",
                requested=omega_flags or {},
                legacy_controls={
                    "producer_skip_bootstrap_gate": bool(producer_skip_bootstrap_gate),
                    "producer_masked_retile": bool(producer_masked_retile),
                    "producer_native_masked_retile": bool(producer_native_masked_retile),
                },
            )
            if omega_config["applied"]["omega_skip_measure_gate"]:
                producer_skip_bootstrap_gate = True
            if omega_config["applied"]["omega_masked_retile"]:
                producer_masked_retile = True
            if omega_config["applied"]["omega_native_masked_retile"]:
                producer_native_masked_retile = True
        fusion_options = {
            "fusion_scratch_pool": bool(fusion_scratch_pool),
            "retained_operand_bytes": int(fusion_retained_operand_bytes),
            "reuse_geometry": bool(fusion_reuse_geometry),
            "share_phase_validity": bool(fusion_share_phase_validity),
            "native_preparation": bool(fusion_native_preparation),
            "native_ragged_preparation": bool(fusion_native_ragged_preparation),
            "optimize_phase_metadata": bool(fusion_optimize_phase_metadata),
            "fused_route_metadata": bool(fusion_fused_route_metadata),
        }
        if selected_attention.name == "vsa" and any(
                value for key, value in fusion_options.items()
                if key not in ("retained_operand_bytes", "fusion_scratch_pool")):
            raise ValueError("native fusion options require vc, anemoi or combined")
        if selected_attention.name == "vsa" and fusion_options["retained_operand_bytes"]:
            raise ValueError("retained operands require vc, anemoi or combined")
        candidate_policy = dict(candidate_policy, **fusion_options)
        omega_execution_flags = {
            name: bool((omega_config or {}).get("applied", {}).get(name, value))
            for name, value in (omega_flags or {}).items()
            if name in {
                "omega_skip_measure_gate",
                "omega_masked_retile",
                "omega_native_masked_retile",
                "omega_fusion_scratch_pool",
                "omega_measure_only",
                "omega_producer_direct_carriers",
            }
        }
        if omega_config is not None:
            candidate_policy["omega_config"] = omega_config
            # Preserve the requested bitset for reporting, but only pass bits
            # that the registry marked as implemented to execution. Unsupported
            # requests must remain explicit no-ops rather than engaging a
            # lower-level experimental seam accidentally.
            candidate_policy["omega_flags"] = omega_config["requested"]
        config = preset_manifest(
            preset, token_aug=token_aug, vae_precision_policy=vae_precision_policy,
        )
        if compile_transformer:
            config["transformer_compile"] = {
                "enabled": True,
                "scope": "diffusion_model.modulation" if compile_transformer_scope == "modulation" else "diffusion_model.qkv_projections",
                "qkv_regional": compile_transformer_scope == "qkv",
                "transformer_body_compiled": compile_transformer_body,
                "compiler_options": {"emulate_precision_casts": True} if compile_transformer_scope == "modulation" else {},
                "backend": "inductor",
                "mode": "default",
                "fullgraph": False,
            }
            config.pop("preset_hash", None)
            config["preset_hash"] = hashlib.sha256(
                json.dumps(config, sort_keys=True).encode()
            ).hexdigest()
        if use_pdmd:
            config.update(
                model_variant=PDMD_2STEP_VARIANT,
                lora_strength=float(lora_strength),
                steps=2,
                sampler="euler",
                sampling_contract="pdmd-2step",
                experiment_note=(
                    "Experimental PDMD adapter applied to the selected FastH3 checkpoint; "
                    "the adapter was trained against the original MiniMax-H3 base."
                ),
            )
            config.pop("preset_hash", None)
            config["preset_hash"] = hashlib.sha256(
                json.dumps(config, sort_keys=True).encode()
            ).hexdigest()
        if preset == B1_PRESET:
            require_b1_runtime()
            if kitchen_version() != KITCHEN_VERSION:
                raise RuntimeError(f"B1 requires comfy-kitchen {KITCHEN_VERSION}; found {kitchen_version()}")
        # The fused model cache must distinguish incompatible ComfyUI builds.
        # Read this before global option changes or weights.
        comfyui_commit = comfyui_core_revision()
        if gate_loader == "upstream_candidate":
            if comfyui_commit != UPSTREAM_GATE_CORE_COMMIT:
                raise RuntimeError(f"upstream gate loader candidate requires ComfyUI {UPSTREAM_GATE_CORE_COMMIT}")
            config.update(gate_loader=gate_loader,
                          gate_loader_profile=upstream_gate_loader_manifest(),
                          status="unqualified_candidate")
            config.pop("preset_hash", None)
            config["preset_hash"] = hashlib.sha256(
                json.dumps(config, sort_keys=True).encode()
            ).hexdigest()
        reset_vsa_options()
        backend = "kitchen" if selected_attention.name == "vsa" else "native"
        vsa = set_vsa_options(
            backend=backend,
            attention_option=selected_attention.name,
            topk_ratio=config["vsa_topk_ratio"],
            block_size=64,
            mask_reuse="off",
            kv_quant="bf16",
            token_aug=token_aug,
        )
        kernel = set_fp4_kernel(blocks_per_program=0)
        check_cuda_backend(require_sol=selected_attention.name == "vsa")
        candidate_runtime = None
        if selected_attention.name == "cute_sol":
            from .cute_sol import probe
            capability = probe()
            candidate_runtime = {
                "backend": capability.backend,
                "architecture": capability.architecture,
                "available": capability.available,
            }
        # require_attention_option owns native availability. Triton prototypes
        # are diagnostics and cannot establish native candidate readiness.
        checkpoint = config["checkpoint"]
        import folder_paths

        model_manifest = fasth3_model_manifest(
            checkpoint, folder_paths.get_full_path_or_raise,
            prompt=prompt, unique_id=unique_id,
        )
        fused_mlp_enabled = fused_mlp_enabled_from_env()

        from .fused_mlp import FusedMLPReport, apply_fused_mlp
        from .precision import probe_nvfp4_capability

        key = model_key(
            folder_paths.get_full_path_or_raise("diffusion_models", checkpoint),
            device=comfy.model_management.get_torch_device(), precision=config["precision"],
            software=fasth3_software_identity(
                torch_version=str(torch.__version__),
                comfyui_commit=comfyui_commit,
                kitchen_version=str(kitchen_version()),
                kitchen_wheel_sha256=KITCHEN_WHEEL_SHA256,
                engine=(
                    "comfystreamerh3-fasth3-upstream-gates-v2+torch-compile-boundary-v11-"
                    + compile_transformer_scope
                    if compile_transformer else "comfystreamerh3-fasth3-upstream-gates-v2"
                ) + ("+standard-mlp-fallback-v1" if not fused_mlp_enabled else ""),
                model_variant=PDMD_2STEP_VARIANT if use_pdmd else "base",
            ),
        )

        def initialize():
            # Saved gate_loader values are metadata aliases. Upstream owns the
            # model in both paths; custom precision and sparse patches follow.
            # The fused NVFP4 converter stages each CPU source matrix on CUDA
            # independently, preserving Comfy's offloaded model residency.
            base = load_upstream_gate_checkpoint(key.path)
            if base.is_dynamic():
                base = base.get_non_dynamic_delegate()
            capability = probe_nvfp4_capability()
            if fused_mlp_enabled and capability.available and not use_pdmd:
                base, precision_report = apply_fused_mlp(base)
            else:
                # Keep the standard MLP for CPU-offloaded checkpoints, PDMD's
                # dynamic LoRA patches, or hardware without native NVFP4.
                precision_report = FusedMLPReport(
                    enabled=False,
                    applied=(),
                    skipped=tuple(
                        f"diffusion_model.blocks.{block}.mlp"
                        for block in range(50)
                    ),
                    capability=capability,
                )
            precision = precision_report.to_dict()
            precision["quality_class"] = "safe"
            if not fused_mlp_enabled:
                precision["disabled_reason"] = "disabled_by_environment"
            elif use_pdmd:
                precision["disabled_reason"] = (
                    "The fused NVFP4 MLP rejects dynamic LoRA patches; the PDMD variant "
                    "uses ComfyUI's standard MLP path."
                )
            # Invalidate if the checkpoint changed during load/conversion.
            if model_key(key.path, device=key.device, precision=key.precision,
                         software=key.software) != key:
                raise RuntimeError("checkpoint changed during fused base initialization")
            return base, precision

        with FUSED_BASE_CACHE.clone(key, initialize) as (model, precision, cache_report):
            # Restore the base object-patch view through Comfy's normal clone
            # handoff before sparse captures stock attention forwards, leaving
            # 8 GiB available for H3 activations and VAE workspaces.
            comfy.model_management.load_models_gpu(
                [model], memory_required=8 * 1024**3, force_full_load=False,
            )
            pdmd_report = None
            if use_pdmd:
                from .pdmd_lora import apply_pdmd_2step_lora
                model, pdmd_report = apply_pdmd_2step_lora(model, strength=lora_strength)
                adapter_path = pdmd_report.pop("path")
                model_manifest = dict(model_manifest)
                model_manifest.update(model_content_manifest({
                    pdmd_report["filename"]: adapter_path,
                }))
                pdmd_report["sha256"] = model_manifest[pdmd_report["filename"]]
            model = sparse._apply_patch(
                model,
                tau=1.3,
                start_percent=0.0,
                end_percent=1.0,
                min_tokens=0,
                sink_conditioning=(
                    "exact_kv" if selected_attention.name == "cute_sol"
                    else "exact_kv_and_rows"
                ),
                verbose=True,
                topk_ratio=config["vsa_topk_ratio"],
                # Candidate arithmetic is layered on the trained VSA layout;
                # this keeps padding, protected rows, and the learned coarse
                # branch identical across all four benchmark arms.
                vsa=selected_attention.name != "cute_sol",
                chunk_size=(BASELINE_CHUNK_SIZE if baseline_active
                            else cast(int, PRESETS[preset]["chunk_size"])),
                attention_option=selected_attention.name,
                token_aug=token_aug,
                attention_policy=candidate_policy,
                producer_skip_bootstrap_gate=producer_skip_bootstrap_gate,
                producer_masked_retile=producer_masked_retile,
                producer_native_masked_retile=producer_native_masked_retile,
                omega_flags=omega_execution_flags,
            )[0]
            if compile_transformer:
                from .transformer_compile import compile_fast_h3_transformer_forward

                compile_profile = compile_fast_h3_transformer_forward(
                    model,
                    target_method="_forward",
                    disable_comfy_allocator_graph=compile_transformer_scope == "qkv",
                    compile_transformer_body=False,
                    compile_modulation=compile_transformer_scope == "modulation",
                )
            else:
                from .transformer_compile import disabled_transformer_compile_report

                compile_profile = disabled_transformer_compile_report()
        profile = dict(
            config,
            model_variant=PDMD_2STEP_VARIANT if use_pdmd else "base",
            transformer_compile=compile_profile,
            lora_strength=float(lora_strength) if use_pdmd else None,
            checkpoint=checkpoint,
            runtime=runtime_identity(comfyui_commit=comfyui_commit),
            precision_report=precision,
            fp4_kernel=kernel,
            vsa=vsa,
            attention_option=selected_attention.name,
            chunk_size=(BASELINE_CHUNK_SIZE if baseline_active
                        else cast(int, PRESETS[preset]["chunk_size"])),
            attention_candidate_runtime=candidate_runtime,
            kitchen_version=kitchen_version(),
            token_aug=token_aug,
            vae_precision_policy=vae_precision_policy,
            attention_policy=candidate_policy,
            producer_skip_bootstrap_gate=bool(producer_skip_bootstrap_gate),
            producer_masked_retile=bool(producer_masked_retile),
            producer_native_masked_retile=bool(producer_native_masked_retile),
            baseline_decoder_qk_inplace=(BASELINE_DECODER_QK_INPLACE if baseline_active else False),
            baseline_fused_output_pack=(BASELINE_FUSED_OUTPUT_PACK if baseline_active else False),
            baseline_output_host_copy=(BASELINE_OUTPUT_HOST_COPY if baseline_active else "pinned"),
            fusion_options=fusion_options,
            omega_config=omega_config,
            vc_e2e_config_hash=str(vc_e2e_config_hash or ""),
            model_cache=cache_report,
            model_manifest=model_manifest,
            pdmd_lora=pdmd_report,
        )
        return (
            model,
            comfy.samplers.sampler_object(config["sampler"]),
            torch.tensor(video_sigmas(config["sampling_contract"])),
            profile,
        )


# Python callers may still import the historical class name even though the
# node display/mapping name was renamed.
FastH3OptimizedLoader = ComfyStreamerH3OptimizedLoader
