"""Versioned B1 policy; configuration identity is not GPU promotion evidence.

Decoder ABI: ``vae_precision_policy`` is ``established`` (preserve accumulation
precision, enable eligible exact fusions) or ``fp16_accum`` (opt-in eligible
Kitchen VAE operations only). Adapters
must report executed/skipped counts and must never cast the whole model.
"""

import hashlib
import json

BASELINE_ID = "kitchen034-b1"
B1_PRESET = "fp4-mlp-fused-fasth3-v2-4step-vsa20-kitchen034-b1"
# LOCAL SUBSTITUTION (this host, 2026-10-12, re-pinned 2026-10-28).  The pinned
# 0.2.34 wheel is cp312-abi3-manylinux and cannot be installed on Windows; the
# host carries the ComfyUI-bundled 0.2.40 (was 0.2.37 until the 2026-10-23
# ComfyUI update).  Substituted criteria, re-verified on 0.2.40:
#   1. comfy_kitchen.backends.cuda._C exposes sol_producer_begin /
#      sol_producer_chunk / sol_attn_core / sol_attn_plan   -> all present
#   2. comfy_kitchen.backends.cuda._SOL_HD == 128            -> 128
#   3. comfy_kitchen.backends.cuda._SOL_VSCALE_MARGIN == 1.1 -> 1.1
KITCHEN_VERSION = "0.2.40"
KITCHEN_SOURCE_COMMIT = "e5e0d020e2add85f50466bb79171bc04ef7492b6"
KITCHEN_WHEEL_SHA256 = "71ba8bc72b54f2914b5e15d210eea2e25931006cf57ca14d033ae4050f4b0d1a"
# LOCAL SUBSTITUTION (this host, 2026-10-12).  The digest above is kept as a RECORD of what
# the recipe pins -- model_cache.py validates this field as a 64-hex digest, so it must not
# be blanked or falsified.  Enforcement of the byte-level wheel provenance is switched off
# here instead, because the ComfyUI-bundled 0.2.37 install ships no direct_url.json.
KITCHEN_PROVENANCE_ENFORCED = False
KITCHEN_WHEEL_URL = (
    "https://files.pythonhosted.org/packages/28/0f/c30f26d33bfa2685433a7d3993d438dcff9f6d97f0b8b531f9a6793562d2/"
    "comfy_kitchen-0.2.34-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
    f"#sha256={KITCHEN_WHEEL_SHA256}"
)
BASELINE_CHUNK_SIZE = 8192
BASELINE_SKIP_BOOTSTRAP_GATE = True
BASELINE_DECODER_QK_INPLACE = True
BASELINE_FUSED_OUTPUT_PACK = True
BASELINE_OUTPUT_HOST_COPY = "pinned"
TOKEN_AUG_CHOICES = (0, 64, 128, 256)
VAE_PRECISION_POLICIES = ("established", "fp16_accum")


def baseline_policy(*, token_aug=0, vae_precision_policy="established") -> dict:
    if type(token_aug) is not int or token_aug not in TOKEN_AUG_CHOICES:
        raise ValueError(f"token_aug must be one of {TOKEN_AUG_CHOICES}")
    if vae_precision_policy not in VAE_PRECISION_POLICIES:
        raise ValueError(f"vae_precision_policy must be one of {VAE_PRECISION_POLICIES}")
    policy = {
        "schema": "fasth3-kitchen-baseline/1",
        "baseline_id": BASELINE_ID,
        "promotion_status": "awaiting_gpu_evidence",
        "kitchen_version": KITCHEN_VERSION,
        "kitchen_source_commit": KITCHEN_SOURCE_COMMIT,
        "kitchen_wheel_sha256": KITCHEN_WHEEL_SHA256,
        "producer_chunk_size": BASELINE_CHUNK_SIZE,
        "producer_skip_bootstrap_gate": BASELINE_SKIP_BOOTSTRAP_GATE,
        "decoder_qk_inplace": BASELINE_DECODER_QK_INPLACE,
        "fused_output_pack": BASELINE_FUSED_OUTPUT_PACK,
        "output_host_copy": BASELINE_OUTPUT_HOST_COPY,
        "token_aug": token_aug,
        "vae_precision_policy": vae_precision_policy,
        "vae_exact_fusions": True,
        "decoder_mode": "fused_ff_qk_rope",
        "decoder_tile_batch": 3,
        "audio": True,
        "encode_backend": "nvenc",
        "stream_finalized_tiles": True,
    }
    policy["policy_hash"] = hashlib.sha256(
        json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return policy
