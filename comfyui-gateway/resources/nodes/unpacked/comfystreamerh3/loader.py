"""Validate trained FastH3 gates; let ComfyUI construct and load the model."""
import hashlib
import json

from comfy.ldm.minimax.model import MiniMaxH3Model

UPSTREAM_GATE_CORE_COMMIT = "ee71d5c4993f29086b27fde1629a945ae48425bf"


def upstream_gate_loader_manifest():
    """Identity for the opt-in experiment; this does not certify equivalence."""
    descriptor = {
        "schema": "fasth3-gate-loader/1",
        "profile_id": "fasth3-upstream-gate-loader/v1",
        "status": "unqualified_candidate",
        "comfyui_commit": UPSTREAM_GATE_CORE_COMMIT,
        "stock_model": "comfy.model_base.MiniMaxH3",
        "stock_backbone": "comfy.ldm.minimax.model.MiniMaxH3Model",
        "detection_policy": "gate_compress=True; exactly 50 complete trained gates",
        "producer_policy": "preserve custom VSA, selective NVFP4 and fused MLP",
        "pdmd_policy": "excluded from this candidate",
    }
    descriptor["profile_hash"] = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True).encode()
    ).hexdigest()
    return descriptor


def load_upstream_gate_checkpoint(path, disable_dynamic=False):
    """Use the pinned public state-dict loader after checking every trained gate.

    The official loader consumes weight dictionaries. Validate completeness
    before that mutation without modifying ComfyUI's global model registry.
    Empty model_options preserve UNETLoader's historical default dtype choice.
    """
    import comfy.model_base
    import comfy.model_detection
    import comfy.sd
    import comfy.utils

    state_dict, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    prefix = comfy.model_detection.unet_prefix_from_state_dict(state_dict)
    # The FastVideo Comfy export stores MiniMax-H3 block keys at the top level.
    # Comfy's generic prefix helper falls back to "model." when no known wrapper
    # prefix exists, so recognize the native bare-key form before validating it.
    if (f"{prefix}blocks.0.attn.to_gate_compress.weight" not in state_dict
            and "blocks.0.attn.to_gate_compress.weight" in state_dict):
        prefix = ""
    missing = [index for index in range(50)
               if state_dict.get(f"{prefix}blocks.{index}.attn.to_gate_compress.weight") is None]
    if missing:
        raise ValueError(f"Incomplete FastH3 gate bank: missing blocks {missing}")
    model = comfy.sd.load_diffusion_model_state_dict(
        state_dict, model_options={}, metadata=metadata, disable_dynamic=disable_dynamic,
    )
    if model is None:
        raise RuntimeError("Upstream gate checkpoint model could not be detected")
    if (type(model.model) is not comfy.model_base.MiniMaxH3
            or model.model.model_type != comfy.model_base.ModelType.FLOW_AV):
        raise RuntimeError("FastH3 requires the stock MiniMaxH3 FLOW_AV model")
    backbone = model.get_model_object("diffusion_model")
    if (type(backbone) is not MiniMaxH3Model or len(backbone.blocks) != 50
            or any(getattr(block.attn, "to_gate_compress", None) is None
                   for block in backbone.blocks)):
        raise RuntimeError("Upstream gate loader did not construct all 50 native gates")
    # Keep completeness validation on Comfy's lazy dynamic-to-static reload.
    model.cached_patcher_init = (load_upstream_gate_checkpoint, (path,))
    return model
