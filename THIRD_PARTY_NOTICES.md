# Third-Party Notices

本仓库只分发本地集成代码和画布源码；以下组件/资产**不随仓库分发**，使用时请遵守各自许可证。

## 运行时与依赖

- **Infinite Canvas** — MIT，Copyright (c) 2026 basketikun；本仓库包含其修改版，许可证见 `infinite-canvas/LICENSE`。
- **ComfyUI** — GPL-3.0；独立的本地推理应用，本仓库只通过 HTTP API 调用，不包含其源码或二进制。
- **Node.js / Express / Multer / React / Ant Design / Vite / Zustand / TanStack Query** 等 npm 依赖 — 按各自许可证分发；完整依赖树见 `comfyui-gateway/package.json`、`infinite-canvas/web/package.json` 及对应 lockfile。
- **FFmpeg** — 由 ComfyUI 节点或本机环境提供；按 FFmpeg 的许可证使用。

## 模型与自定义节点

以下内容不随本仓库分发，需自行从合法渠道获取并遵守模型/节点许可证：

- MiniMax-H3（Singularity ref2va / 8-step LightX2V 等）相关权重与节点。
- 阿里云通义千问 Qwen Image 2.1、Qwen3-VL、Qwen3.5 相关权重。
- MOSS Image SFT、MOSS 8-step DMD LoRA、Qwen3.5-9B CLIP 等。
- SeedVR2 3B/7B、ESRGAN/RealESRGAN 放大模型。
- ComfyUI 自定义节点（VHS、KJNodes、TE-Speed、SeedVR2、FlashVSR 等）。

模型权重、LoRA、样片和生成内容可能附带额外使用限制；请以模型发布方的许可证为准。不要将无权分发的权重提交到本仓库。

## 主题素材

- **蓝色大肥鱼卡片皮肤贴纸** — 基于开源梗图合集 [DeepSeek-chan meme pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack) 的 #087 预览图改编：抠除背景并合成为圆形贴纸，用于本地画布主题。原图版权归原作者/社区所有；如权利人不希望使用，可删除 `infinite-canvas/web/public/skins/blue-fat-fish.png` 并移除该主题。

## 商标

ComfyUI、MiniMax、Qwen、MOSS、SeedVR2 等名称和标识归各自所有者。本仓库仅在说明兼容性/技术来源时使用这些名称，不表示背书或隶属关系。
