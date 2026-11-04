"""Lazy loading for the experimental MiniMax-H3 PDMD 2-step adapter."""

PDMD_2STEP_VARIANT = "pdmd_2step_lora"
PDMD_2STEP_LABEL = "PDMD 2-step LoRA (download adapter)"
PDMD_2STEP_REPO = "Kijai/MiniMax-H3-experimental"
PDMD_2STEP_REVISION = "294f771095af5b03c38a26aab3ad6498b88092b2"
PDMD_2STEP_FILENAME = "loras/minimax_h3_pdmd_2step_lora_avg_rank_38_bf16.safetensors"


def apply_pdmd_2step_lora(model, strength=1.0):
    """Download just the selected adapter and apply it through Comfy's LoRA API."""
    import comfy.sd
    import comfy.utils
    from huggingface_hub import hf_hub_download

    adapter_path = hf_hub_download(
        repo_id=PDMD_2STEP_REPO,
        revision=PDMD_2STEP_REVISION,
        filename=PDMD_2STEP_FILENAME,
        repo_type="model",
    )
    lora = comfy.utils.load_torch_file(adapter_path, safe_load=True)
    if not isinstance(strength, (int, float)) or not 0.0 <= strength <= 2.0:
        raise ValueError("PDMD LoRA strength must be between 0.0 and 2.0")
    patched_model, _ = comfy.sd.load_lora_for_models(model, None, lora, float(strength), 0.0)
    if patched_model is None:
        raise RuntimeError("ComfyUI did not return a model after applying the PDMD LoRA")
    return patched_model, {
        "repo_id": PDMD_2STEP_REPO,
        "revision": PDMD_2STEP_REVISION,
        "filename": PDMD_2STEP_FILENAME,
        "path": adapter_path,
        "strength": float(strength),
        "download": "selected-adapter-only",
    }


__all__ = [
    "PDMD_2STEP_FILENAME",
    "PDMD_2STEP_LABEL",
    "PDMD_2STEP_REPO",
    "PDMD_2STEP_REVISION",
    "PDMD_2STEP_VARIANT",
    "apply_pdmd_2step_lora",
]
