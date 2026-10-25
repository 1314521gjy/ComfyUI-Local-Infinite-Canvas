# CHANGELOG

## v0.20.0 - 2026-10-25

+ [新增] 接入本地 `comfyui-gateway`：把 ComfyUI 工作流注册为模型，画布渠道直接指向本机网关。
+ [新增] 本地模式 `LOCAL_ONLY`：隐藏云端渠道、Agent、WebDAV、提示词库等非本地入口；`VITE_LOCAL_ONLY=0` 可恢复完整界面。
+ [新增] 图像工作流：Z-Image Turbo、Krea2 Aesthetics、MOSS SFT 8 步 / 50 步、Qwen Image 2.1 多图编辑 / 局部重绘 / 扩图。
+ [新增] MOSS 区域布局：bbox 编辑器、Layout JSON、中文显示列表，支持已有框拖拽移动。
+ [新增] H3 三档视频：文生 / 首尾帧 / 多参共用文戏均衡工作流，接入采样预览。
+ [新增] SeedVR2 视频超分：1.5× / 2×，保留原音频，输出 H.264。
+ [新增] 本地插件卡：LoRA 强度卡、ComfyUI 参数卡；H3 与生图提示词优化。
+ [新增] 系统状态面板：显存 / 内存 / GPU / ComfyUI 状态、清理显存、一键重启 ComfyUI。
+ [新增] GitHub 仓库链接与本项目更新检查；Git 克隆安装支持一键 `git pull --ff-only` 更新。
+ [新增] 右上角「打赏加群」入口：微信支付二维码、感谢文案与 QQ 交流群。
+ [修复] 修复画布视频预览拖拽、MOSS bbox 拖动、扩图视口类型错误等问题。
