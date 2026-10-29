#!/usr/bin/env python3
"""Bake a MOSS-Image Base+SFT preset into a native single-file diffusion model.

ComfyUI's ModelSave writes a checkpoint-prefixed patched model that the native
MOSS single-file loader cannot use; this applies the same layer ratios directly
to the Base/SFT weights and keeps the Comfy-Org layout.
"""
from __future__ import annotations

import argparse
import os

import torch
from safetensors import safe_open
from safetensors.torch import save_file

PRESETS = {
    "Base-preserve": dict(early=0.08, early_late=0.12, mid_early=0.18, mid_late=0.28, late_early=0.42, late_late=0.52, global_scale=0.12, final_linear=0.25),
    "Balanced": dict(early=0.15, early_late=0.20, mid_early=0.30, mid_late=0.45, late_early=0.60, late_late=0.72, global_scale=0.20, final_linear=0.35),
    "SFT-detail": dict(early=0.25, early_late=0.32, mid_early=0.50, mid_late=0.65, late_early=0.80, late_late=0.90, global_scale=0.30, final_linear=0.50),
}


def build_weights(preset: str, strength: float) -> dict[str, float]:
    p = PRESETS[preset]
    g = p["global_scale"]
    weights = {
        "video_embedder.": g,
        "text_embedder.proj.": g,
        "text_embedder.blocks.0.": round(g * 0.8, 2),
        "text_embedder.blocks.1.": round(g * 0.8, 2),
        "time_embedding.": round(g * 1.2, 2),
        "shared_block_modulation.": g,
        "final_norm_video.": g,
        "final_linear_video.": p["final_linear"],
        "video_head_modulation.": g,
    }
    for i in range(42):
        if i <= 7:
            weights[f"layers.{i}."] = p["early"]
        elif i <= 13:
            weights[f"layers.{i}."] = p["early_late"]
        elif i <= 21:
            weights[f"layers.{i}."] = p["mid_early"]
        elif i <= 29:
            weights[f"layers.{i}."] = p["mid_late"]
        elif i <= 35:
            weights[f"layers.{i}."] = p["late_early"]
        else:
            weights[f"layers.{i}."] = p["late_late"]
    return {key: min(1.0, value * strength) for key, value in weights.items()}


def bake(base_path: str, sft_path: str, out_path: str, preset: str, strength: float) -> None:
    weights = build_weights(preset, strength)
    ordered = sorted(weights.items(), key=lambda item: len(item[0]), reverse=True)

    def ratio_for(key: str) -> float | None:
        for prefix, value in ordered:
            if key.startswith(prefix):
                return value
        return None

    tmp_path = out_path + ".tmp.safetensors"
    with safe_open(base_path, framework="pt") as base, safe_open(sft_path, framework="pt") as sft:
        base_keys = set(base.keys())
        sft_keys = set(sft.keys())
        if base_keys != sft_keys:
            raise SystemExit(f"key mismatch: base-only={sorted(base_keys - sft_keys)[:5]} sft-only={sorted(sft_keys - base_keys)[:5]}")
        merged = {}
        unmatched = []
        for key in base.keys():
            base_t = base.get_tensor(key)
            ratio = ratio_for(key)
            if ratio is None:
                merged[key] = base_t
                unmatched.append(key)
                continue
            sft_t = sft.get_tensor(key)
            merged[key] = (base_t.float() * (1.0 - ratio) + sft_t.float() * ratio).to(base_t.dtype)
        save_file(merged, tmp_path, metadata=None)

    os.replace(tmp_path, out_path)
    print(f"preset={preset} strength={strength:.2f} keys={len(merged)} unmatched={unmatched}")
    print(f"saved {out_path} ({os.path.getsize(out_path)} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", choices=sorted(PRESETS), default="Balanced")
    parser.add_argument("--strength", type=float, default=1.0)
    comfy_root = os.environ.get("COMFYUI_DIR", "").strip()
    model_root = os.path.join(comfy_root, "models", "diffusion_models") if comfy_root else ""
    parser.add_argument("--base", default=os.path.join(model_root, "moss_image_base_bf16.safetensors") if model_root else "")
    parser.add_argument("--sft", default=os.path.join(model_root, "moss_image_sft_bf16.safetensors") if model_root else "")
    parser.add_argument("--out", default=os.path.join(model_root, "moss_balanced_s100.safetensors") if model_root else "")
    args = parser.parse_args()
    if not args.base or not args.sft or not args.out:
        parser.error("请通过 --base/--sft/--out 指定路径，或先设置 COMFYUI_DIR")
    bake(args.base, args.sft, args.out, args.preset, args.strength)


if __name__ == "__main__":
    main()
