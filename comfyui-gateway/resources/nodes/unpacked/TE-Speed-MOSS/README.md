# TE-Speed-MOSS 1.0

MOSS-Image image-generation acceleration node for ComfyUI. It reduces model calls while keeping the native attention path and the native sampler.

TE-Speed-MOSS adds output-prediction step caching to ComfyUI's MOSS-Image model: every full evaluation records the real output, the recent trajectory is used to predict the following steps, and the next full evaluation checks the prediction error. The node offers two prediction modes, `te_predictor` and `te_predictor 2`; cond and uncond share one per-step decision, and it is compatible with model offloading, LoRA, and ComfyUI's native sampling flow.

## 1.0

- MOSS-Image output-prediction step caching.
- `euler` sampler support.
- Multiple attention backends; ComfyUI's native attention is kept by default.

## TE-Speed Dynamic Acceleration

TE-Speed-MOSS does more than reuse the previous step's output. The node keeps recording real model outputs and uses them to decide which steps can be skipped:



cond and uncond make a single shared decision per step, so both sides of CFG stay consistent. The first and last steps are always evaluated in full; skips only happen in the middle of the schedule.

## Requirements

- Windows x64
- ComfyUI
- ComfyUI portable environment with Python 3.13
- NVIDIA GPU, 16 GB VRAM or more recommended
- No extra quantization dependencies are required for the int8 models

## Model Directory

Default model directories:

```text
ComfyUI/models/diffusion_models/
ComfyUI/models/text_encoders/
ComfyUI/models/vae/
```

Required files:

```text
diffusion_models/moss_image_sft_int8_convrot.safetensors
text_encoders/qwen3.5_9b_int8_convrot.safetensors
vae/flux2-vae.safetensors
```

The bf16 `moss_image_sft_bf16.safetensors` also works but uses more VRAM.

## Node

### TE-Speed MOSS

Model acceleration node, connected between `UNETLoader` and `KSampler`.

- `model`: connect to `UNETLoader`.
- `attention`: attention backend; keep `default`. `sageattn`, `sdpa`, `flashattn`, `kitchen_int8`, and `kitchen_sol` are slower on MOSS and change the image; use them only for special cases.
- `step_cache`
  - `te_predictor`: two-point secant, at most 1 consecutive prediction; suitable for 20–30 steps.
  - `te_predictor 2`: least-squares fit over the last 4 real outputs, 1–3 consecutive predictions; default; suitable for 40+ steps.
- `reuse_threshold`: a step is skipped only when the relative latent change between steps is below this value; default `0.12`. Higher values skip more and change the image more.
- `start_percent` / `end_percent`: prediction window, default `0.20` / `0.80`. The first and last steps are always evaluated in full.
- `predictor_error_limit`: self-monitoring tolerance, default `0.06`. Lower is more conservative; higher is more aggressive.
- `uncond_cache`: off by default. When enabled, the negative branch may predict on its own when the step decision is full; cond stays exact.
- `verbose`: log the skip decision for every step.
- `status`: outputs the settings that are actually in effect.

Recommended defaults:

```text
attention          default
step_cache         te_predictor 2
reuse_threshold    0.12
start_percent      0.20
end_percent        0.80
predictor_error_limit 0.06
uncond_cache       false
```

## Usage

Workflow connection:

```text
UNETLoader → TE-Speed MOSS → KSampler(euler / simple)
```

---

# TE-Speed-MOSS 1.0

MOSS-Image 图像生成 ComfyUI 加速节点，在保持原生注意力和原生采样器的前提下减少模型调用。

TE-Speed-MOSS 为 ComfyUI 的 MOSS-Image 模型加入输出预测步缓存：每次完整评估都会记录真实输出，用最近的轨迹预测后续步骤，并用真实评估反向校验预测误差。节点支持 `te_predictor` 与 `te_predictor 2` 两种预测模式，cond / uncond 共用同一步决策，兼容模型 offload、LoRA 和 ComfyUI 原生采样流程。


## 1.0

- 支持 MOSS-Image 输出预测步缓存。
- 支持 `euler` 采样器。
- 支持多种注意力后端，默认保持 ComfyUI 原生注意力。

## TE-Speed 动态加速

TE-Speed-MOSS 不只是复用上一步输出。节点会持续记录真实模型输出，并据此决定哪些步可以跳过：



## 环境要求

- Windows x64
- ComfyUI
- ComfyUI 使用 Python 3.13 的便携环境
- NVIDIA GPU，建议 16GB 及以上显存
- 使用 int8 模型时无需额外安装量化依赖

## 模型目录

默认模型目录：

```text
ComfyUI/models/diffusion_models/
ComfyUI/models/text_encoders/
ComfyUI/models/vae/
```

需要的文件：

```text
diffusion_models/moss_image_sft_int8_convrot.safetensors
text_encoders/qwen3.5_9b_int8_convrot.safetensors
vae/flux2-vae.safetensors
```

也可以使用 bf16 的 `moss_image_sft_bf16.safetensors`，显存占用更高。

## 节点

### TE-Speed MOSS

模型加速节点，连接在 `UNETLoader` 和 `KSampler` 之间。

- `model`：连接 `UNETLoader`。
- `attention`：注意力后端，保持 `default`。`sageattn`、`sdpa`、`flashattn`、`kitchen_int8`、`kitchen_sol` 在 MOSS 上更慢且会改变画面，仅用于特殊场景。
- `step_cache`
  - `te_predictor`：两点割线，最多连续预测 1 步，适合 20–30 步。
  - `te_predictor 2`：最近 4 个真实输出最小二乘拟合，连续预测 1–3 步，默认，适合 40 步以上。
- `reuse_threshold`：latent 步间相对变化低于此值才允许跳过，默认 `0.12`。调大跳得更多，画面变化也更明显。
- `start_percent` / `end_percent`：预测窗口，默认 `0.20` / `0.80`。首尾步始终完整评估。
- `predictor_error_limit`：自监控容差，默认 `0.06`。调小更保守，调大更激进。
- `uncond_cache`：默认关闭。打开后负向分支可以在整步判定为完整时单独预测，cond 始终精确。
- `verbose`：打印每一步的跳步判定。
- `status`：输出实际生效的设置。

推荐默认设置：

```text
attention          default
step_cache         te_predictor 2
reuse_threshold    0.12
start_percent      0.20
end_percent        0.80
predictor_error_limit 0.06
uncond_cache       false
```

## 使用方式

工作流连接：

```text
UNETLoader → TE-Speed MOSS → KSampler(euler / simple)
```
