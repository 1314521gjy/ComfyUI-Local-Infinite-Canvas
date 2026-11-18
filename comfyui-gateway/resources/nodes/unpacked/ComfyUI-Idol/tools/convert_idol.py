"""Repackage the speridlabs/idol release for ComfyUI's native TripoSplat loaders.

    python tools/convert_idol.py RELEASE_DIR [--models ComfyUI/models]

RELEASE_DIR holds the release's denoiser.safetensors, decoder.safetensors and decoder_gs.safetensors. Writes, in
fp32 as released and in fp16 (half the size, the dtype ComfyUI computes in by default on GPUs):
  diffusion_models/idol/idol_{fp32,fp16}.safetensors   the denoiser without its pos_pe buffer (ComfyUI recomputes the
                                                       same scrambled Sobol positions, checked here)
  vae/idol_vae_decoder_{fp32,fp16}.safetensors         the octree and Gaussian decoders under the octree. / gs. prefixes
Existing outputs are left alone.
"""
import argparse
import os

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def read(path):
    with safe_open(path, "pt") as f:
        return {k: f.get_tensor(k) for k in f.keys()}


def write(sd, path):
    if os.path.exists(path):
        print(f"exists, skipped: {path}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    save_file(sd, path + ".part", metadata={"format": "pt"})
    with safe_open(path + ".part", "pt") as f:
        assert set(f.keys()) == set(sd), path
    os.replace(path + ".part", path)
    print(f"wrote {path} ({len(sd)} tensors)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release")
    parser.add_argument("--models", default=os.path.expanduser("~/AI/ComfyUI/models"))
    args = parser.parse_args()

    denoiser = read(os.path.join(args.release, "denoiser.safetensors"))
    pos = denoiser.pop("pos_pe")[0]
    sobol = torch.quasirandom.SobolEngine(dimension=3, scramble=True, seed=123).draw(pos.shape[0])
    if not torch.equal(pos, sobol):
        raise ValueError("pos_pe is not ComfyUI's Sobol sequence (seed 123); the native model would place the latent tokens wrongly")
    decoder = {"octree." + k: v for k, v in read(os.path.join(args.release, "decoder.safetensors")).items()}
    decoder.update({"gs." + k: v for k, v in read(os.path.join(args.release, "decoder_gs.safetensors")).items()})
    for name, dtype in (("fp32", torch.float32), ("fp16", torch.float16)):
        write({k: v.to(dtype) for k, v in denoiser.items()}, os.path.join(args.models, "diffusion_models", "idol", f"idol_{name}.safetensors"))
        write({k: v.to(dtype) for k, v in decoder.items()}, os.path.join(args.models, "vae", f"idol_vae_decoder_{name}.safetensors"))


if __name__ == "__main__":
    main()
