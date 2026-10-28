# NOTICE / 署名与修改说明

## 上游项目

本仓库包含 **Infinite Canvas** 的修改版：

- 项目：basketikun/infinite-canvas
- 版本：v0.20.0（上游提交 `9f2bd9f`，`chore: update CHANGELOG for v0.20.0 release`）
- 许可证：MIT License，Copyright (c) 2026 basketikun
- 上游地址：https://github.com/basketikun/infinite-canvas
- 许可证全文：`infinite-canvas/LICENSE`

上游代码、界面、文档的版权归原作者所有。本仓库保留上游 LICENSE 与版权声明，并在修改版中继续以 MIT 许可分发。

## 本地修改

`infinite-canvas/` 目录相对上游 v0.20.0 的主要修改：

- 新增 `LOCAL_ONLY` 本地模式，隐藏云端渠道、Agent、WebDAV、提示词库等非本地入口。
- 接入本地 `comfyui-gateway` 渠道，增加本地模型同步、系统状态、清理显存/重启 ComfyUI。
- 增加 LoRA 卡、ComfyUI 参数卡等本地插件（`web/public/plugins/`）。
- 增加 MOSS 区域布局、Qwen 2.1 编辑/局部重绘/扩图、H3 三档视频、SeedVR2 视频超分等本地工作流入口。
- 修复若干交互/类型问题（IMEs、蒙版编辑器、扩图视口、视频超分参数链等）。

`comfyui-gateway/`、`launcher/` 和根目录脚本为本地集成新增代码，不在上游仓库中。

## 本项目

- 项目名：ComfyUI-本地无限画布
- 作者：1314521gjy（GitHub）
- 许可证：MIT License，见根目录 `LICENSE`
- 仓库：https://github.com/1314521gjy/ComfyUI-Local-Infinite-Canvas

## 第三方与模型

ComfyUI 本体、模型权重、LoRA、FFmpeg 等不随本仓库分发。少量用于本地反推/本地提示词的第三方节点（Florence2、llama-cpp_vllm、TE_MAN）随工作台分发；Qwen/Florence 权重由资源卡按需下载。分别适用其各自许可证，详见 `THIRD_PARTY_NOTICES.md`。

本项目与 basketikun、ComfyUI、MiniMax、阿里云通义千问、MOSS、字节跳动 SeedVR2 等项目的维护方无隶属关系；相关名称仅用于说明兼容性或技术来源。
