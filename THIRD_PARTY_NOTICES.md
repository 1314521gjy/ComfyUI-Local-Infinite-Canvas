# Third-Party Notices

本仓库只分发本地集成代码和画布源码；以下组件/资产**不随仓库分发**，使用时请遵守各自许可证。

## 运行时与依赖

- **Infinite Canvas** — MIT，Copyright (c) 2026 basketikun；本仓库包含其修改版，许可证见 `infinite-canvas/LICENSE`。
- **ComfyUI** — GPL-3.0；独立的本地推理应用，本仓库只通过 HTTP API 调用，不包含其源码或二进制。
- **Node.js / Express / Multer / React / Ant Design / Vite / Zustand / TanStack Query** 等 npm 依赖 — 按各自许可证分发；完整依赖树见 `comfyui-gateway/package.json`、`infinite-canvas/web/package.json` 及对应 lockfile。
- **FFmpeg** — 由 ComfyUI 节点或本机环境提供；按 FFmpeg 的许可证使用。
- **three.js** — MIT；随前端 dist 分发（`three.webgpu` 独立 chunk 约 715KB，以及 GaussianSplat / PLY / GLTF 加载器）；上游 https://github.com/mrdoob/three.js 。

## 内置助手运行时（assistant-runtime）

- **assistant-runtime.zip** — 本项目 MIT；包含 `assistant/server.mjs`、`skill.mjs`、诊断/修复工具、`@mariozechner/pi-agent-core@0.73.1` / `@mariozechner/pi-ai@0.73.1` 及其依赖，以及画布前端工作区源码和随包 `node_modules`；不包含 Node.js 可执行文件，运行依赖应用自带 Node。pi Agent 库为 MIT，作者 Mario Zechner，上游 https://github.com/badlogic/pi-mono ；随包根目录附 `LICENSE` 与 `NOTICE`。
- 随包 npm 依赖以 MIT / Apache-2.0 / BSD / ISC 为主；另含 MPL-2.0（lightningcss）、CC-BY-4.0（caniuse-lite）、Python-2.0、BlueOak、Unlicense 等许可。完整许可文本随包内 1,365 个 license/notice 文件提供；未发现 GPL/AGPL/SSPL/LGPL。
- 本运行时是画布助手桥，不是 pi Agent / OpenClaw；本项目不包含、也不提供 pi Agent / OpenClaw 的下载。

## 随包分发的第三方节点

以下节点允许随工作台一起分发，安装时复制到 ComfyUI 的 `custom_nodes`：

- **ComfyUI-Florence2** — MIT；上游 https://github.com/kijai/ComfyUI-Florence2 。
- **ComfyUI-llama-cpp_vllm** — MIT；上游 https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm 。
- **llama-cpp-python 预编译包** — MIT；Windows 预编译来源 https://github.com/JamePeng/llama-cpp-python ，未改动二进制。
- **TE_MAN** — 原作者 LICENSE 原文写明未经书面授权禁止再分发；本项目依据用户提供的作者授权（2026-10-29）随包分发。若权利人提出异议，将立即移除相关文件。
- **ComfyUI-KJNodes** — GPL-3.0；上游 https://github.com/kijai/ComfyUI-KJNodes ；随工作台提供预解压目录，未改动源码。
- **ComfyUI-SeedVR2_VideoUpscaler** — Apache-2.0；上游 https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler ；随工作台提供预解压目录，未改动源码。
- **comfystreamerh3** — MIT，Copyright (c) 2026 Comfy Org；上游 https://github.com/Comfy-Org/comfystreamerh3 ；随工作台提供预解压目录，未改动源码。
- **ComfyUI-ClipProj** — MIT，Copyright (c) 2026 nicolab28；上游 https://github.com/nicolab28/ComfyUI-ClipProj ；随工作台提供预解压目录，未改动源码。
- **Goohaitools-comfyui** — GPL-3.0；上游 https://github.com/goohai/Goohaitools-comfyui ；随工作台提供预解压目录，未改动源码。

## 自托管的 Qwen 2.1 LoRA（资源卡下载）

以下 LoRA 由本项目镜像到 ModelScope 数据集 `shensanshu/ComfyUI-Local-Infinite-Canvas` 供资源卡下载，不进入主程序包：

- **Qwen 2.1 一致性无偏移 / 万物移除 / GH 扩图** — 社区开源，作者 GooHAI，上游 https://huggingface.co/GooHAI/Qwen-image-2.1_loras ；未改动权重。

## 按需下载的第三方运行库

以下运行库不进入主安装包，由资源卡按需从 ModelScope 数据集 `shensanshu/ComfyUI-Local-Infinite-Canvas-Models` 下载：

- **SageAttention 2.2.0 Windows 预编译包** — Apache-2.0；构建来源 https://github.com/woct0rdho/SageAttention （基于 https://github.com/thu-ml/SageAttention ），未改动 wheel；H3 视频的内存优化依赖。

## 可选下载的本地反推模型

以下模型不进入主安装包，由资源卡按需下载：

- **Qwen3.5-9B GGUF（Q4_K_M + mmproj BF16）** — Apache-2.0；上游模型 Qwen/Qwen3.5-9B，GGUF 由 unsloth 转换；从 ModelScope `unsloth/Qwen3.5-9B-GGUF` 下载（HF 镜像为备用），未改动权重。原第三方「Uncensored」版本已停止提供。
- **Florence-2-large-PromptGen-v2.0** — MIT（模型卡标注），来源 MiaoshouAI，从 ModelScope 数据集 `shensanshu/ComfyUI-Local-Infinite-Canvas-Models` 下载。

## 可选下载的 3D 组件

以下 3D 节点与权重不进入主安装包，由「3D 生成（Idol / MoGe）」资源卡按需下载；需要 ComfyUI 0.44.0 及以上：

- **ComfyUI-Idol** — GPL-3.0；上游 https://github.com/PedroMarinhoDev/ComfyUI-Idol ；仅节点代码，经资源卡安装到 ComfyUI 的 `custom_nodes`。
- **Idol UNet / VAE fp16** — Apache-2.0；来源 https://huggingface.co/PedroMarinhoDev/Idol-ComfyUI （hf-mirror 镜像）；未改动权重。
- **BiRefNet** — 许可以上游为准；来源 https://huggingface.co/VAST-AI/TripoSplat （hf-mirror 镜像）；未改动权重。
- **DINOv3 ViT-H** — 许可以上游为准；来源 https://huggingface.co/VAST-AI/TripoSplat （hf-mirror 镜像）；未改动权重。
- **MoGe-2 ViT-L** — 许可以上游为准；来源 https://huggingface.co/Comfy-Org/MoGe 与 ModelScope 镜像；未改动权重。

## 可选下载的 H3 极速草稿组件

以下组件不进入主安装包，由「H3 极速草稿」资源卡按需下载：

- **Qwen3-VL-4B FP8 文本编码器**（`qwen3vl_4b_fp8_scaled`）— Apache-2.0；来源 ModelScope `Comfy-Org/Krea-2`（aifasthub 为备源）；未改动权重。
- **ClipProj 4B v3.1 MLP 投影** — 许可以上游模型页为准；来源 `NicoLab28/ClipProj-MiniMax-H3`；未改动权重。
- **minimax_h3_video_vae_int8_convrot** — MiniMax H3 社区许可；来源 ModelScope `Comfy-Org/MiniMax-H3`。
- **minimax_h3_audio_vae_fp32** — MiniMax H3 Community License；来源 ModelScope `Comfy-Org/MiniMax-H3`（hf-mirror 备源）。

## 可选下载的超分模型

以下模型不进入主安装包，由「超分」资源卡按工作流按需下载：

- **RealESRGAN x2plus / x4plus / x4plus anime 6B** — BSD-3-Clause；上游 https://github.com/xinntao/Real-ESRGAN ；从 ModelScope 数据集 `shensanshu/ComfyUI-Local-Infinite-Canvas-Models` 的 `upscale_models/` 下载，未改动权重。
- **SeedVR2 3B / 7B DiT 与 VAE** — Apache-2.0；上游 https://github.com/ByteDance-Seed/SeedVR ；权重来自 https://huggingface.co/numz/SeedVR2_comfyUI 与 https://huggingface.co/AInVFX/SeedVR2_comfyUI ，经 hf-mirror 下载，未改动权重。
- 4x-UltraSharp、4x-AnimeSharp 为 CC-BY-NC-SA-4.0（禁止商用、相同方式共享），本项目不提供下载。

## 其他模型

以下内容不随本仓库分发，需自行从合法渠道获取并遵守模型/节点许可证：

- MiniMax-H3（Singularity ref2va / 8-step LightX2V 等）相关权重与节点。
- 阿里云通义千问 Qwen Image 2.1、Qwen3-VL、Qwen3.5 相关权重。
- MOSS Image SFT、MOSS 8-step DMD LoRA、Qwen3.5-9B CLIP 等。
- 未随包的 ComfyUI 自定义节点（VHS、TE-Speed、FlashVSR 等）。

模型权重、LoRA、样片和生成内容可能附带额外使用限制；请以模型发布方的许可证为准。不要将无权分发的权重提交到本仓库。

## 主题素材

- **提灯水母娘**（`lantern-guard-idle.png` / `lantern-guard-raise.png`）— 项目方使用 ImageGen 生成的原创角色，用于付费皮肤「蓝色大肥鱼」（保留原皮肤 ID 与激活码）；台词「我将守护你的进程」。
- **天使娘**（`angel-girl-idle.webp` / `angel-girl-write.webp`）— 项目方使用 ImageGen 生成的原创角色，用于免费皮肤；台词「圣光与你同在」。

## 商标

ComfyUI、MiniMax、Qwen、MOSS、SeedVR2 等名称和标识归各自所有者。本仓库仅在说明兼容性/技术来源时使用这些名称，不表示背书或隶属关系。
