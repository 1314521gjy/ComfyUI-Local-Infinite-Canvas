# ComfyUI-本地无限画布

本地优先的 **Infinite Canvas × ComfyUI** 集成：把开源无限画布、ComfyUI 工作流和本地网关接到一起，不依赖云端 API。

> GitHub 仓库 slug 使用 `ComfyUI-Local-Infinite-Canvas`（GitHub 仓库名只支持 ASCII）；项目中文名即 **ComfyUI-本地无限画布**。

## 功能

- 无限画布：文本、图片、视频、配置、分组节点；连线、框选、导出、自动保存。
- 本地网关把 ComfyUI 工作流暴露成 OpenAI 兼容模型：画布只改渠道 Base URL，不改上游代码。
- 图像：Z-Image Turbo、Krea2 Aesthetics、MOSS SFT（8 步极速 / 50 步高质量、区域布局）、Qwen Image 2.1（多图编辑 / 真蒙版局部重绘 / 扩图）。
- 视频：MiniMax-H3 文生、首尾帧、多参三个入口，共用文戏均衡工作流；支持采样预览、LoRA 卡、首尾帧/多参考素材。
- 放大：ESRGAN 快速放大、SeedVR2 图片超分、SeedVR2 视频超分（1.5×/2×，保留原音频）。
- 本地插件卡：LoRA 强度卡、ComfyUI 参数卡；提示词优化（H3 结构化 / 生图单段描述）。
- 系统面板：显存/内存/GPU/ComfyUI 状态、清理显存、一键重启 ComfyUI。
- `LOCAL_ONLY` 本地模式：隐藏云端渠道、Agent、WebDAV、提示词库等非本地入口。

## 架构

```text
start-local.bat
  └─ launcher/start.mjs
       ├─ ComfyUI        :8188   检测 / 接管 / 拉起
       ├─ comfyui-gateway:8190   OpenAI 兼容网关 + 任务/预览/系统接口
       └─ canvas         :3000   托管 infinite-canvas/web/dist

画布 :3000  →  网关 :8190  →  ComfyUI :8188
```

## 目录

```text
infinite-canvas/      基于 Infinite Canvas v0.20.0 的本地修改版（MIT）
  web/                画布前端源码 + 构建产物 dist/
  web/public/plugins/ 本地 LoRA / ComfyUI 参数插件
comfyui-gateway/      Node.js + Express 本地网关（工作流注册表、绑定、任务、预览）
launcher/             启动器（检测/接管 ComfyUI、拉起网关、托管画布）
start-local.bat       Windows 一键启动
```

## 环境要求

- Windows 10/11；NVIDIA GPU（开发环境：RTX 4080 SUPER 32GB）。
- Node.js 24+。
- 一份可运行的 ComfyUI（便携版即可）。
- **本仓库不包含模型权重、自定义节点和 ComfyUI 本体。** 工作流里引用的模型、LoRA、自定义节点需要在本机自行安装，并遵守各自许可证。
- 画布 `dist/` 已随仓库提供；修改前端源码后需要重新构建。

## 安装与启动

```bat
:: 1. 安装网关依赖
cd comfyui-gateway
npm install
cd ..

:: 2. 安装画布依赖并构建（修改前端后执行）
cd infinite-canvas\web
npm install --legacy-peer-deps
npm run build
cd ..\..

:: 3. 复制启动器配置，按本机路径修改（也可以让启动器自动发现 ComfyUI）
copy launcher\config.example.json launcher\config.json

:: 4. 一键启动
start-local.bat
```

启动器会检测 `8188` 和常见 ComfyUI 目录；找到后接管或拉起 ComfyUI，启动网关，并在 `http://127.0.0.1:3000` 托管画布。首次发现 ComfyUI 后会把路径写入 `launcher/config.json`。

## 网关

- 健康检查：`GET http://127.0.0.1:8190/health`
- 模型列表：`GET http://127.0.0.1:8190/v1/models`
- 管理页：`http://127.0.0.1:8190/admin`
- 工作流注册表：`comfyui-gateway/workflows/registry.json`
- 工作流 = 模型；参数通过 bindings 映射到 ComfyUI 节点输入。
- 视频任务异步执行，支持轮询、取消和采样预览；图片任务复用网关的请求取消。

详细接口、环境变量和测试方法见 [`comfyui-gateway/README.md`](comfyui-gateway/README.md)。

## 更新

- 版本弹窗的「检查更新」由网关 `/api/update/check` 提供，读取项目根目录的 `update.json`；Git 克隆安装会从 `origin/main` 获取最新清单（点击检查时执行 `git fetch`）。
- 如果当前目录是 Git 克隆且工作区没有已跟踪修改，「应用更新」会执行 `git pull --ff-only`。它不会修改 `launcher/config.json`、`comfyui-gateway/data/`、ComfyUI、模型或用户输出；更新后需要重启 `start-local.bat`。如果 `package-lock.json` 有变化，先在 `comfyui-gateway` 运行 `npm install`。
- 下载 zip 安装的用户当前可以查看更新并手动下载；自动替换发布包的更新器在后续版本加入。`update.json` 同时提供版本、说明和下载地址。
- 发布新版本：同时更新根目录 `VERSION`、`update.json`、`CHANGELOG.md`，重新构建 `infinite-canvas/web`，并提交 `web/dist`。

## 国内镜像

- ModelScope 数据集镜像：https://modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas
- 国内克隆：`git clone https://www.modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas.git`
- 从魔搭克隆时远端默认分支是 `master`；网关更新逻辑会自动识别 `main`/`master`，不需要手动改 `UPDATE_BRANCH`。

## 安全提示

- 网关、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，**没有鉴权**。
- 不要把 `:8188`、`:8190`、`:8290` 暴露到公网或不可信局域网。
- 本地渠道默认 API Key 是占位值 `local`，网关不校验该值；仓库不包含真实 API Key、Token 或私钥。
- 不要提交 `launcher/config.json`、`comfyui-gateway/data/`、任务输出、模型权重、`.env` 或任何密钥。
- `launcher/config.json` 含本机路径；仓库只提供 `config.example.json`。

## 署名与许可证

本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) v0.20.0（MIT，Copyright (c) 2026 basketikun）修改，保留其许可证与版权声明，详见 [`infinite-canvas/LICENSE`](infinite-canvas/LICENSE) 和 [`NOTICE.md`](NOTICE.md)。

`comfyui-gateway`、`launcher` 及本地集成修改由 **1314521gjy** 编写，按 MIT 许可发布，详见根目录 [`LICENSE`](LICENSE)。

ComfyUI 本体、模型权重、LoRA 和第三方自定义节点不随本仓库分发，分别适用其各自许可证；本项目与 ComfyUI、MiniMax、阿里云通义千问、MOSS、字节跳动 SeedVR2 等项目的维护方无隶属关系。

## 状态

已在 Windows + RTX 4080 SUPER 32GB 环境完成图像、视频、放大、本地网关和画布回写的端到端验证。不同机器需要按本机 ComfyUI 的模型/节点情况调整 `registry.json`；未安装对应模型的工作流会在网关标记为不可用，不会出现在 `/v1/models`。
