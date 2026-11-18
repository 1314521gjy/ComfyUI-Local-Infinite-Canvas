# ComfyUI-HyperFlow-Flash

[![Hacker News](assets/hacker-news-badge.svg)](https://news.ycombinator.com/item?id=50405263)

ComfyUI custom nodes and drag-and-drop workflows for [HyperFlow H3 Flash](https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash) checkpoints: the GGUF quants (`fl2va_gguf/`, `ref2va_gguf/`) and the INT8 convrot safetensors (`fl2va_int8_convrot_comfyui/`, `ref2va_int8_convrot_comfyui/`):

- **HyperFlow Loader**: loads either kind of pruned, low-rank factored, two-time `(t, r)` checkpoint from `diffusion_models/`. The INT8 linears of the safetensors run on ComfyUI's own INT8 kernels; its low-rank linears stay bf16. Long clips run the INT8 layers in row chunks, within the 32-bit offsets of comfy-kitchen's Triton kernels. `weights_in: auto | disk | ram` applies to GGUF files.
- **HyperFlow GGUF Loader**: the GGUF-only loader of 1.0.0, kept for existing workflows.
- **HyperFlow Sigmas**: emits the 4-, 6- (default), or 8-step sigma schedule at `CFG = 1.0`.
- **Workflow templates** (`example_workflows/`): `hyperflow_t2v`, `hyperflow_i2v`, `hyperflow_flf2v`, and `hyperflow_ref2v` with a GGUF, and the same four with the INT8 safetensors (`*_int8`), automatically listed under **Workflow > Browse Templates > ComfyUI-HyperFlow-Flash**.

## Install

Requires a [ComfyUI](https://github.com/Comfy-Org/ComfyUI) build with native MiniMax-H3 support (`0.43.0` or newer). GGUF files also need [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF); the INT8 safetensors do not:

```sh
cd ComfyUI/custom_nodes
git clone https://github.com/city96/ComfyUI-GGUF  # for GGUF files only
git clone https://github.com/Video-Rebirth/ComfyUI-HyperFlow-Flash
pip install -r ComfyUI-HyperFlow-Flash/requirements.txt  # in ComfyUI's Python environment
```

## Model Files

Place the downloaded files in `ComfyUI/models/`:

```text
ComfyUI/
├── main.py
├── custom_nodes/
│   ├── ComfyUI-GGUF/                                                  # for GGUF files only
│   └── ComfyUI-HyperFlow-Flash/
└── models/
    ├── diffusion_models/
    │   ├── minimax_h3_fl2va_hyperflow_flash_14b-Q4_K_M.gguf           # fl2va_gguf/, or:
    │   ├── minimax_h3_fl2va_hyperflow_flash_14b-int8_convrot.safetensors   # fl2va_int8_convrot_comfyui/
    │   └── minimax_h3_ref2va_hyperflow_flash_14b-Q4_K_M.gguf          # optional, for ref2v (ref2va_gguf/; or the INT8 file of ref2va_int8_convrot_comfyui/)
    ├── text_encoders/
    │   └── qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors               # from Comfy-Org/MiniMax-H3 (15.7 GB)
    └── vae/
        ├── minimax_h3_video_vae_fp16.safetensors                      # from Comfy-Org/MiniMax-H3
        └── minimax_h3_audio_vae_fp32.safetensors                      # from Comfy-Org/MiniMax-H3
```

The model files come from [VideoRebirthAI/hyperflow-h3-flash](https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash) and [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3). With a GGUF on PCs with 16 GB or 32 GB of system RAM, launch with `python main.py --fast-disk` from `ComfyUI/`. The INT8 safetensors ran with 12 GiB of system RAM left to ComfyUI (a 16 GB PC), without `--fast-disk`. For complete setup instructions, benchmarks, and troubleshooting, see [`integrations/README.md`](https://github.com/Video-Rebirth/hyperflow-h3-flash/blob/main/integrations/README.md).

## Compatibility

The INT8 safetensors carry a `hyperflow` metadata entry with a layout version (`format`). **HyperFlow Loader** lists only safetensors files that have it, and refuses a layout newer than it reads with a message to update the node pack. Workflows saved with **HyperFlow GGUF Loader** keep working.

## License

- **Code:** GPL-3.0 (see [`LICENSE`](LICENSE)).
- **Model weights:** Not included. The GGUF and INT8 checkpoints are a Model Derivative of MiniMax-H3 under the [MiniMax H3 Community License Agreement](https://huggingface.co/VideoRebirthAI/hyperflow-h3-flash/blob/main/LICENSE), not GPL-3.0. The Agreement does not cover use in the European Union, the United Kingdom, the Republic of Korea, or the United States without MiniMax's authorization, and it includes an Acceptable Use Policy.
