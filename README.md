# ComfyUI-本地无限画布

本地优先的 **Infinite Canvas × ComfyUI** 集成：把开源无限画布、ComfyUI 工作流和本地网关接到一起，不依赖云端 API。

> 当前版本 **v0.22.9**（2026-10-30）。GitHub 仓库 slug 使用 `ComfyUI-Local-Infinite-Canvas`（GitHub 仓库名只支持 ASCII）；项目中文名即 **ComfyUI-本地无限画布**。

## 功能

- 无限画布：文本、图片、视频、配置、分组节点；连线、框选、导出、自动保存。
- 本地网关把 ComfyUI 工作流暴露成 OpenAI 兼容模型：画布只改渠道 Base URL，不改上游代码。
- 图像：Z-Image Turbo、Krea2 Aesthetics、MOSS SFT（8 步极速 / 50 步高质量、区域布局）、Qwen Image 2.1（多图编辑 / 真蒙版局部重绘 / 扩图）。
- 视频：MiniMax-H3 文生、首尾帧、多参三个入口，共用文戏均衡工作流；支持采样预览、LoRA 卡、首尾帧/多参考素材。
- 放大：ESRGAN 快速放大、SeedVR2 图片超分、SeedVR2 视频超分（1.5×/2×，保留原音频）。
- 本地插件卡：LoRA 强度卡、ComfyUI 参数卡；提示词优化（H3 结构化 / 生图单段描述）。
- 本地反推 / 本地提示词：Qwen3.5-9B（GGUF + 视觉投影）和 Florence-2 PromptGen v2.0 可在「设置 → 添加工作流」按需安装；不装也能用云端反推。
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

以上是默认端口；画布 3000 被占用时会回退到 3001–3010，实际地址以启动器窗口输出为准。网关端口由 `gatewayPort`（默认 8190）决定；改成其他端口时，若 8190 空闲，启动器会起兼容转发，旧页面无需刷新。

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
- **Git 源码仓库不包含模型权重、自定义节点和 ComfyUI 本体。** 完整发布包会附带运行所必需的预解压节点、H3 VAE ONNX、预览 VAE 与观澜 LoRA；其余模型/LoRA 由资源中心按工作流下载，并遵守各自许可证。
- 画布 `dist/` 已随仓库提供；修改前端源码后需要重新构建。

## 快速开始

### 方式 A：使用完整发布包

1. 解压完整包（自带 Node、网关依赖、随包节点和少量 VAE/LoRA）。
2. 双击 `start-local.bat`。
3. 打开启动器打印的画布地址；默认 `http://127.0.0.1:3000`，3000 被占用时自动使用 3001–3010。
4. 首次启动按提示安装缺失资源；进画布后点右上角「配置」确认 ComfyUI 连接。

### 方式 B：从源码运行

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

### 局域网 / 多机访问（可选）

默认全部只绑 `127.0.0.1`，单机行为不变。如果要在「工作站跑模型 + 其他设备浏览器打开 WebUI」，可在 `launcher/config.json` 增加：

```json
{
  "allowLan": true,
  "canvasHost": "0.0.0.0",
  "gatewayHost": "0.0.0.0",
  "gatewayPublicHost": "192.168.1.10",
  "corsOrigins": "http://192.168.1.10:3000,http://192.168.1.20:3000"
}
```

- `allowLan`：必须显式为 `true` 才允许非回环监听；默认 `false`，避免误把服务暴露到局域网。
- `canvasHost`：画布静态服务监听地址；`gatewayHost`：网关监听地址。
- `gatewayPublicHost`：写进前端 `config.js` 的对外可达网关地址；留空等于 `127.0.0.1`。
- `corsOrigins`：允许跨域调用网关的画布来源，逗号分隔，不支持通配符。
- 网关 `/api` 和 `/admin` 默认没有鉴权；显式设置 `GATEWAY_TOKEN` 后，`/api/*` 与 `/admin` 会校验 `x-gateway-token`。放开监听后只限可信内网，并配合防火墙限制来源，**不要映射到公网**。跨机使用前先读下方「安全提示」。

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
- **文件夹安装**：点击「应用更新」会在软件内下载并校验代码补丁，只替换程序文件；`data/`、模型、`node_modules`、`resources/bundled` 和 `launcher/config.json` 不会被覆盖。更新完成后网关自动重启，新页面自动刷新。
- **Git 克隆**：工作区没有已跟踪修改时执行 `git pull --ff-only`；`package-lock.json` 有变化时先在 `comfyui-gateway` 运行 `npm install`。启动器生成的 `infinite-canvas/web/dist/config.js` 不再被误判为本地修改。
- **强制更新**：如果确实改过程序源码，更新弹窗会显示「强制更新（保留 data）」；用校验过的补丁覆盖程序文件，保留 `data/`、模型、`node_modules` 和 `launcher/config.json`，失败自动回滚。
- **旧版本自举**：v0.22.6 及更早的 Git 安装如果被提示“工作区有未提交的修改”，先点「下载更新工具」运行一次，升到 v0.22.7 后即可正常使用应用内更新。
- **v0.21.0–v0.21.2 旧版本**：这些版本里没有新的更新器。请从发布页下载 `update-bridge.zip`，解压后双击 `update.bat`，脚本会自动找到工作台并升级到最新版；之后即可使用应用内更新。不会把用户送到网页手动替换文件。
- 发布新版本：同时更新根目录 `VERSION`、`update.json`、`CHANGELOG.md`，重新构建 `infinite-canvas/web`，提交 `web/dist`，并生成 `patches/vX.zip` 与 `update.json.patch`。

## 常见问题

- **页面打不开，或地址不是 3000**：看启动器窗口打印的实际画布地址；3000 被占用时会自动用 3001–3010。
- **找不到 ComfyUI**：确认 ComfyUI 已启动；仍识别不到时进「设置 → 偏好设置 → ComfyUI 目录与资源扫描」，手动选包含 `main.py` 的根目录，保存后重新扫描。
- **工作流显示不可用 / 缺资源**：资源中心看缺多少、多大，勾选后「安装选中」；模型识别不了点「自选替换」；提示「待重启」说明文件已装但 ComfyUI 还没加载，重启 ComfyUI。
- **更新失败**：把弹窗里的完整错误（阶段 + 原因）反馈；先别删 `.update` / `.update-backup`，方便定位。应用内更新不需要手动替换文件。
- **关掉页面后后台还在跑**：默认关页 30 秒后停后台；启动参数设了 `CLOSE_CANVAS_STOPS_BACKEND=0` 或 `STOP_ADOPTED_COMFY=0` 时会保持运行。
- **局域网访问**：按下方「局域网 / 多机访问」显式设置 `allowLan`；默认只绑 `127.0.0.1`，不要映射到公网。

## 国内镜像

- ModelScope 数据集镜像：https://modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas
- 国内克隆前先安装 Git LFS（`git lfs install`）；魔搭对 `web/dist`、锁文件等使用 LFS，未安装会得到指针文件：
  `git lfs install && git clone https://www.modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas.git`
- 从魔搭克隆时远端默认分支是 `master`；网关更新逻辑会自动识别 `main`/`master`，不需要手动改 `UPDATE_BRANCH`。

## 安全提示

- 网关、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，**没有鉴权**；设置 `GATEWAY_TOKEN` 后 `/api/*` 与 `/admin` 会校验 `x-gateway-token`。
- 只有显式设置 `allowLan: true` 并配置 `canvasHost` / `gatewayHost` 才会放开监听；放开后只限可信内网，并配合防火墙限制来源，**不要映射到公网**。网关 `/api` 与 `/admin` 仍无鉴权，CORS 白名单不是访问控制。
- 不要把 `:8188`、`:8190`、`:8290` 暴露到公网或不可信局域网。
- 本地渠道默认 API Key 是占位值 `local`，网关不校验该值；仓库不包含真实 API Key、Token 或私钥。
- 不要提交 `launcher/config.json`、`comfyui-gateway/data/`、任务输出、模型权重、`.env` 或任何密钥。
- `launcher/config.json` 含本机路径；仓库只提供 `config.example.json`。

## 署名与许可证

本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) v0.20.0（MIT，Copyright (c) 2026 basketikun）修改，保留其许可证与版权声明，详见 [`infinite-canvas/LICENSE`](infinite-canvas/LICENSE) 和 [`NOTICE.md`](NOTICE.md)。

`comfyui-gateway`、`launcher` 及本地集成修改由 **1314521gjy** 编写，按 MIT 许可发布，详见根目录 [`LICENSE`](LICENSE)。

ComfyUI 本体、其余模型权重、LoRA 和第三方自定义节点适用各自许可证；完整发布包随包附带运行必需的节点与少量 VAE/LoRA，其余按工作流下载；本项目与 ComfyUI、MiniMax、阿里云通义千问、MOSS、字节跳动 SeedVR2 等项目的维护方无隶属关系。

## 状态

已在 Windows + RTX 4080 SUPER 32GB 环境完成图像、视频、放大、本地网关和画布回写的端到端验证。不同机器需要按本机 ComfyUI 的模型/节点情况调整 `registry.json`；未安装对应模型的工作流会在网关标记为不可用，不会出现在 `/v1/models`。
