# ComfyStreamerH3

This project is licensed under the [MIT License](LICENSE). Third-party
components remain subject to their included licenses and notices.

The most optimized live-video node for ComfyUI: run MiniMax-H3 with
ComfyStream's FastH3 runtime on RTX 5090 or RTX 6000 Pro instances for $4/hour
or less.

Generate live video at 448 × 256 on a single RTX 5090, then upscale it for
higher-resolution output.

## Install

Clone the repository into ComfyUI's `custom_nodes` directory and restart
ComfyUI:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Comfy-Org/comfystreamerh3.git
```

## Deploy to the Comfy Developer Platform

Sign up for a [Comfy plan](https://comfy.org/pricing/) to deploy.

Install the Comfy CLI and sign in:

```sh
python3 -m pip install -U comfy-cli
comfy cloud login
```

Install `ffmpeg` and make sure it is available on your `PATH` for the continuous viewer.

From the repository root:

```sh
comfy build validate . --custom-nodes-dir .
comfy build push . --custom-nodes-dir .
comfy build release create . --target linux/nvidia --watch
comfy deploy up . --gpu rtx-pro-6000-server --region anywhere --min 0 --max 1 --watch
comfy deploy status .
```

With `--min 0`, the deployment scales to zero when idle, avoiding ongoing GPU
charges at the cost of a cold start for the next job. Staged model storage is
still billed while any deployment of the Build exists in a region.

After the deployment is ready, start the continuous HLS viewer with the prompt
field and resolution picker:

```sh
python3 examples/continuous_demo.py
```

Delete each deployment when you are done to remove its endpoint. Builds and
releases are free to keep. Storage billing ends shortly after the Build's last
deployment in each region is deleted:

```sh
comfy deploy delete .
```

## Live throughput and sample clips

On one RTX 5090, a warm 448 × 256 run produced two 15.08-second clips in a
median **23.51 seconds** across 11 jobs: **1.28× real time**. The run used
four-step VSA.

Four sample clips use the prompt “Will Smith eating spaghetti” in different
visual styles. Each is 15 seconds at 448 × 256 and 24 fps.

| Style | Clip |
|---|---|
| Photorealistic | <a href="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/photorealistic.mp4"><img src="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/photorealistic.preview.png" alt="Photorealistic Will Smith eating spaghetti; open clip" width="240"></a> |
| Anime | <a href="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/anime.mp4"><img src="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/anime.preview.png" alt="Anime-style Will Smith eating spaghetti; open clip" width="240"></a> |
| Stylized 3D | <a href="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/stylized-3d.mp4"><img src="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/stylized-3d.preview.png" alt="Stylized 3D Will Smith eating spaghetti; open clip" width="240"></a> |
| Watercolor | <a href="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/watercolor.mp4"><img src="benchmark-results/fast-h3-15s-rtx5090-2026-10-06/watercolor.preview.png" alt="Watercolor Will Smith eating spaghetti; open clip" width="240"></a> |

## Runtime and models

The managed runtime targets Linux with an NVIDIA GPU, Python 3.12, CUDA 13
PyTorch, matching TorchVision and TorchAudio builds, and `comfy-kitchen` 0.2.34.
The build configuration pins the runtime and model assets. The node repository
does not include model weights.

| Model | ComfyUI folder | Managed build filename |
|---|---|---|
| FastH3 checkpoint | `models/diffusion_models/` | `fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors` |
| Text encoder | `models/text_encoders/` | `qwen3vl_4b_fp8_scaled.safetensors` |
| ClipProj MLP | `models/clip_projections/` | `mmh3-4b-ClipProj-v3.1-mlp.safetensors` |
| Audio VAE | `models/vae/` | `minimax_h3_audio_vae_fp32.safetensors` |
| Video VAE | `models/vae/` | `minimax_h3_video_vae_int8_convrot.safetensors` |

The sample workflow expects `ClipProjApply` from
[ComfyUI-ClipProj](https://github.com/nicolab28/ComfyUI-ClipProj).
