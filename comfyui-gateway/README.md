# comfyui-gateway

把本地 ComfyUI 工作流暴露成 OpenAI 兼容模型，供 Infinite Canvas 直接调用。画布不需要改请求层，只要把渠道 Base URL 指到网关。

## 架构

```text
Infinite Canvas :3000
  └─ OpenAI 兼容请求（/v1/images/*、/v1/videos、/v1/prompts/*）
       └─ comfyui-gateway :8190
            ├─ workflows/registry.json   工作流 = 模型
            ├─ bindings                 画布参数 → ComfyUI 节点输入
            ├─ tasks                    异步任务 + 输出缓存
            └─ ComfyUI :8188            /prompt → /history → /view
```

## 主要接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/images/upscale`
- `POST /v1/videos`
- `POST /v1/videos/upscale`
- `GET /v1/videos/:id`、`GET /v1/videos/:id/content`、`POST /v1/videos/:id/cancel`
- `POST /v1/prompts/optimize`、`POST /v1/prompts/optimize-image`
- `GET /api/setup/status`、`GET /api/workflows`、`GET /api/workflows/:id/schema`
- `GET /api/system/stats`、`POST /api/system/free-memory`、`POST /api/system/restart-comfy`
- `GET /api/update/check`、`POST /api/update/apply`
- `GET /api/loras`
- 管理页：`/admin`

## 工作流

`workflows/registry.json` 当前包含 20 个条目，分为：

- 图像生成：Z-Image Turbo、Krea2 Turbo / Aesthetics、MOSS SFT 8 步 / 50 步、MOSS INT8 8 步 / 50 步、Qwen Image 2.1（t2i / edit / inpaint / outpaint，多角度隐藏）。
- 视频：MiniMax-H3 文生、首尾帧、多参三个入口（VDN / 无 VDN 各一套），以及角色替换。
- 放大/超分：ESRGAN、SeedVR2 图片、SeedVR2 视频。
- 自动发现的诊断工作流标记为 hidden，不进入 `/v1/models`。

**模型权重、LoRA、自定义节点和 ComfyUI 本体不随仓库分发。** 缺少模型/节点的工作流会在扫描时标记不可用，不会出现在 `/v1/models`。

## 安装与运行

```bash
cd comfyui-gateway
npm install
node src/server.js
```

默认连接 `http://127.0.0.1:8188`，监听 `127.0.0.1:8190`。

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8190` / `127.0.0.1` | 网关监听地址 |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `COMFY_WORKFLOWS_DIR` | 空 | ComfyUI 用户工作流目录，用于自动发现 API 工作流 |
| `LAUNCHER_CONTROL_URL` | 空 | 启动器控制地址，由 `start-local.bat` 注入 |
| `REQUEST_TIMEOUT_MS` | `600000` | 图片请求超时 |
| `VIDEO_TIMEOUT_MS` | `0` | 视频超时；0 表示不设上限 |
| `POLL_INTERVAL_MS` | `750` | `/history` 轮询间隔 |
| `SCAN_ON_START` | `1` | 启动后后台扫描工作流 |
| `WATCH_WORKFLOWS` | `1` | 监听工作流目录热刷新 |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | 允许的画布来源 |
| `TASK_RETENTION_DAYS` | `0` | 任务/输出保留天数；0 不清理 |
| `MAX_STORED_TASKS` | `0` | 最多保留任务数；0 不限制 |
| `UPDATE_ENABLED` | `1` | 开启更新检查/应用；设 `0` 关闭 |
| `UPDATE_MANIFEST_PATH` | `<项目根>/update.json` | 本地更新清单 |
| `UPDATE_MANIFEST_URL` | 空 | 非 Git 安装的远端清单地址 |
| `UPDATE_REMOTE` / `UPDATE_BRANCH` | `origin` / `main` | Git 更新远端与分支 |
| `UPDATE_FETCH_TIMEOUT_MS` | `30000` | `git fetch` / 清单请求超时 |
| `UPDATE_APPLY_TIMEOUT_MS` | `600000` | 补丁下载 / `git pull` 超时 |

## 无 GPU 联调

```bash
# 终端 A
cd comfyui-gateway/mock
node comfyui-mock.mjs --port 18188 --delay 300

# 终端 B
cd comfyui-gateway
COMFY_URL=http://127.0.0.1:18188 node src/server.js
```

Mock 只验证协议与占位图，不验证真实出图质量。

## 更新

`GET /api/update/check` 比较项目根目录的 `VERSION` / `update.json` 与远端（Git 安装读 `origin/main`，压缩包安装可配 `UPDATE_MANIFEST_URL`）。

- **Git 安装**：工作区干净时 `POST /api/update/apply` 执行 `fetch` + `pull --ff-only`；脏树拒绝。启动器生成的 `infinite-canvas/web/dist/config.js` 不计入“未提交修改”。
- **强制更新**：真脏或 Git 不可用时，`POST /api/update/apply` 带 `{"force":true}` 会改用已签名补丁覆盖程序文件，保留 data/models/node_modules/config，失败回滚；前端有二次确认。
- **压缩包 / 文件夹安装**：下载 `update.json.patch` 指向的代码补丁，校验 `size` + `sha256`，支持 `PATCH-DELETE.txt` 与 `PATCH_PROTECTED` 白名单，失败回滚；成功后网关自动重启，新页面自动刷新。
- 下载进度：`GET /api/update/progress` 返回阶段、百分比、已下载 / 总量和速度。
- 有任务在跑时返回 409；更新器优先用 Windows `System32\tar.exe` 解压，PowerShell 兜底。

## 测试

```bash
cd comfyui-gateway
npm test
```

## 安全

网关、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，没有鉴权。不要暴露到公网；不要把 `data/`、任务输出、模型权重或密钥提交到仓库。

## 许可证与署名

网关代码由 1314521gjy 编写，按 MIT 许可发布；项目整体署名和第三方声明见仓库根目录 `LICENSE`、`NOTICE.md`、`THIRD_PARTY_NOTICES.md`。
