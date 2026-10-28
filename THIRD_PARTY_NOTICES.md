# Third-Party Notices

本仓库只分发本地集成代码和画布源码；以下组件/资产**不随仓库分发**，使用时请遵守各自许可证。

## 运行时与依赖

- **Infinite Canvas** — MIT，Copyright (c) 2026 basketikun；本仓库包含其修改版，许可证见 `infinite-canvas/LICENSE`。
- **ComfyUI** — GPL-3.0；独立的本地推理应用，本仓库只通过 HTTP API 调用，不包含其源码或二进制。
- **Node.js / Express / Multer / React / Ant Design / Vite / Zustand / TanStack Query** 等 npm 依赖 — 按各自许可证分发；完整依赖树见 `comfyui-gateway/package.json`、`infinite-canvas/web/package.json` 及对应 lockfile。
- **FFmpeg** — 由 ComfyUI 节点或本机环境提供；按 FFmpeg 的许可证使用。

## 随包分发的第三方节点

以下节点允许随工作台一起分发，安装时复制到 ComfyUI 的 `custom_nodes`：

- **ComfyUI-Florence2** — MIT；上游 https://github.com/kijai/ComfyUI-Florence2 。
- **ComfyUI-llama-cpp_vllm** — MIT；上游 https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm 。
- **llama-cpp-python 预编译包** — MIT；Windows 预编译来源 https://github.com/JamePeng/llama-cpp-python ，未改动二进制。
- **TE_MAN** — 原作者 LICENSE 原文写明未经书面授权禁止再分发；本项目依据用户提供的作者授权（2026-10-29）随包分发。若权利人提出异议，将立即移除相关文件。

## 可选下载的本地反推模型

以下模型不进入主安装包，由资源卡按需从 ModelScope 数据集 `shensanshu/ComfyUI-Local-Infinite-Canvas-Models` 下载：

- **Qwen3.5-9B-Uncensored-HauhauCS-Aggressive（Q4_K_M + mmproj）** — 基于 Qwen3.5-9B，按底模 Apache-2.0 分发；如上游权利人提出限制，将移除下载。
- **Florence-2-large-PromptGen-v2.0** — MIT（模型卡标注），来源 MiaoshouAI。

## 模型与自定义节点

以下内容不随本仓库分发，需自行从合法渠道获取并遵守模型/节点许可证：

- MiniMax-H3（Singularity ref2va / 8-step LightX2V 等）相关权重与节点。
- 阿里云通义千问 Qwen Image 2.1、Qwen3-VL、Qwen3.5 相关权重。
- MOSS Image SFT、MOSS 8-step DMD LoRA、Qwen3.5-9B CLIP 等。
- SeedVR2 3B/7B、ESRGAN/RealESRGAN 放大模型。
- ComfyUI 自定义节点（VHS、KJNodes、TE-Speed、SeedVR2、FlashVSR 等）。

模型权重、LoRA、样片和生成内容可能附带额外使用限制；请以模型发布方的许可证为准。不要将无权分发的权重提交到本仓库。

## 主题素材

- **蓝色大肥鱼卡片皮肤贴纸（鲸鱼娘）** — 基于开源梗图合集 [DeepSeek-chan meme pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack) 的 #010 预览图改编：裁切、抠除背景并合成为透明贴纸，用于本地画布主题。原图版权归原作者/社区所有；如权利人不希望使用，可删除 `infinite-canvas/web/public/skins/blue-whale-girl.png` 并移除该主题。
- **蓝色大肥鱼抽鞭子小动图** — 由项目方使用 ImageGen 生成的四帧原创 sprite（参考社区鲸鱼娘形象），去底为透明 WebP，用于生成中卡片旁的动效；蓝发鲸鱼娘角色形象权利归原作者/社区，商用前请确认授权或替换为完全原创角色。

## 商标

ComfyUI、MiniMax、Qwen、MOSS、SeedVR2 等名称和标识归各自所有者。本仓库仅在说明兼容性/技术来源时使用这些名称，不表示背书或隶属关系。
