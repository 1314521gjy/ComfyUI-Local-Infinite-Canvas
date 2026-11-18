---
name: deploy-repair
description: 部署、启动和维修 Infinite Canvas 本地画布（ComfyUI + 本地网关 + 前端）。遇到端口起不来、模型或节点缺失、ComfyUI 版本不符、显存不足、音频 503、3D 500、生成模糊、更新后网关配置丢失时使用。
---

# 部署与维修

按“先定位在哪一层，再做最小修复”的顺序处理：画布（3000）→ 网关（8190）→ ComfyUI（8188）。不要先重装整套，也不要删用户数据。

## 架构与端口

```text
画布 :3000  →  本地网关 :8190  →  ComfyUI :8188
```

- 实际地址以启动器窗口输出为准。
- 画布 3000 被占用时顺延到 3001–3010；网关在 8190–8199 找空闲端口。
- 网关换端口后，只要 8190 空闲，启动器会起兼容转发，旧标签页不用刷新；新页面读的是当前端口。
- 前端是 `infinite-canvas/web/dist` 的静态产物，由启动器托管；运行时网关地址在 `dist/config.js`。
- 3D、音频相关资源条目要求 **ComfyUI 0.44.0 及以上**；低于 0.44 先升级 ComfyUI（H3-Image 也在 0.44.0 环境验证）。

## 三步体检

1. 看端口和进程：`netstat -ano | findstr ":3000 :8190 :8188"`；对照启动器输出的实际 URL。
2. 看网关状态：`GET http://127.0.0.1:8190/health`；`GET http://127.0.0.1:8190/api/setup/status` 应为 ready；degraded 或 0 模型通常是网关先于 ComfyUI 启动。
3. 看日志：`launcher/launcher.log`、网关控制台、ComfyUI 控制台。生成失败先看网关错误码，再看 ComfyUI `/history` 里的执行图。

## 失败 → 诊断 → 修 → 门

| 现象 | 诊断 | 修 | 门 |
|---|---|---|---|
| 网关起不来 | 8190 无监听；启动器日志报缺依赖或 Node 错误 | 用发布包自带 `node\node.exe`；源码运行先 `npm install`；网关依赖缺失时启动器会自动解压 `gateway-deps.zip`，也可手动 `cd comfyui-gateway && npm install` | `GET :8190/health` 返回 200 |
| 画布打不开 | 3000 被占或 `dist` 缺失 | 看启动器输出的顺延端口；源码部署执行 `cd infinite-canvas/web && npm install && npm run build`；Vite 7 需要 Node 20+ | 打开启动器输出的画布地址，页面能加载 |
| 页面 Failed to fetch | `dist/config.js` 仍指向旧网关端口 | 重启启动器，它会按当前 `gatewayPort` 重写 `config.js`；或手动把 `LOCAL_GATEWAY_URL` 改成当前网关 | `GET :3000/config.js` 里的端口与网关一致 |
| 有网关但 0 模型 / 生成报模型缺失 | 网关先于 ComfyUI 启动，扫描时 ComfyUI 还没就绪 | 先确认 8188 可访问，再 `POST http://127.0.0.1:8190/api/setup/scan` 重扫 | `/api/setup/status` 为 ready，`/v1/models` 能看到目标模型 |
| `Node not found` / 节点类不存在 | ComfyUI 缺自定义节点，或节点装了但没重启 | 资源中心安装对应节点包；随包节点会在启动器启动时自动放到 `custom_nodes/`；ComfyUI 已在运行时必须重启 | ComfyUI 控制台无红字，重跑不再报节点缺失 |
| 模型值不在列表 / checkpoint 找不到 | 模型没放对目录或文件名不一致 | 从资源中心安装；手动放置时按类型放 `<ComfyUI>/models/<类型>`（本机示例 `E:\ComfyUI\ComfyUI\models`）；文件名保持资源条目里的名字 | 重扫后模型下拉可选，生成成功 |
| ComfyUI 版本过低 | 资源条目要求 0.44.0+ | 升级 ComfyUI 后再重扫；不要靠改资源名绕过 | 启动日志版本 ≥ 0.44.0，H3-Image/3D/音频节点能加载 |
| 409 `insufficient_vram` | Viggle 制备/参考帧预检空闲显存不足 | 等当前任务结束或取消；系统面板清理显存（`POST /api/system/free-memory`）；降低分辨率/张数/分段，任务串行 | 重新生成不再 409，显存预检可读 |
| 409 `audio_busy` / `tasks_running` | 已有任务占用 | 等完成或取消；不要并行开第二条重任务 | 任务列表为空后重试成功 |
| OOM / `out of memory` | 显存不够（网关会自动释放并重试一次） | 仍失败就降分辨率、张数或分段；关闭其他占显存程序；清理显存后重试 | 重跑成功，ComfyUI 无 OOM 红字 |
| 音频 503 `audio_model_missing` | YuE2 模型/原生节点未就绪 | 资源中心安装「音频（YuE2）」包（int8 约 3.96GB，非商用许可）；模型应位于 `models/checkpoints`；确认 ComfyUI 0.44+ | 模型下拉可见，写歌返回音频 |
| 音频 503 `audio_instrumental_node_missing` | 纯音乐转换节点未加载 | 重启 ComfyUI 让随包安装的 `YuE2InstrumentalConvert` 生效；确认 `custom_nodes/yue2_instrumental` 存在 | 节点类能加载，空歌词生成纯音乐成功 |
| 音频 503 提到 venv/CLI | 旧版 CLI 写歌教程遗留 | 当前发布版写歌只走 ComfyUI，不需要 dev 的 YuE2 CLI/venv；按上面的 ComfyUI 503 处理即可 | 不安装 CLI/venv 也能出音频 |
| 3D 500 `missing_scene3d_image_runtime` | 图像处理 Python 缺 Pillow/numpy/cv2 | 把 `SCENE3D_PYTHON` 指向 ComfyUI 的 `python_embeded/python.exe`，或安装 Pillow、numpy、opencv-python | 重跑后三个阶段（扩全景/修缝/建场景）走完 |
| 3D 500 `missing_scene3d_workflow` | 全景/修缝工作流未注册 | 安装 H3-Image 与 Qwen 2.1 相关资源/节点，重启 ComfyUI 后重扫 | `/v1/models` 含 3D 场景，任务能创建 |
| 3D `scene3d_quality_rejected` | 接缝/构图质量门未过（默认最多 3 个种子） | 换更清晰的主体图、缩短场景描述后重试；连续失败先查 H3-Image 与 Qwen 2.1 节点/权重 | 任务 completed，输出 5664×2832 PNG |
| 换音色 404 | 旧入口已从产品移除 | 画布音频卡现在只有「写歌」「台词配音」；刷新到当前版本，不要按旧教程找换音色 | 音频卡模式只有两项 |
| 生成模糊 | Z-Image 开了生图加速（=原低档） | 关闭「生图加速」回到原生采样；加速只在 2K/4K 生效，1K 下控件禁用 | 同 seed/尺寸对比，画面更清晰 |
| 更新后网关地址丢失 | 整包更新覆盖了 `dist/config.js` | 重启启动器重写 `config.js`；或手动写入当前网关地址。维护者构建后必须恢复运行时 `config.js`（默认 8190 时 md5 `15a4bf7acab25128343562dba3468f33`） | 页面能列出模型并生成 |
| 资源中心重扫后新增卡消失 / 已取消卡仍在 | rescan 强制加载远端旧索引覆盖本地 authored 索引；资源包 `hidden` 未过滤 | 重扫只 `loadIndex()` 本地优先；`resources.status()` 的 packs 过滤 `hidden:true`；不要用远端索引覆盖随包索引 | 重扫后 indexVersion 仍是本地版本，新增卡在、Idol 不在 |
| pi Agent 点拉起无反应 | 网关旧进程未加载 `/api/pi-agent/*`（404）；ensure 同步等 25s；Windows `.cmd` 直接 spawn EINVAL | 重启网关加载 `/api/pi-agent/status|ensure` + `/pi-agent` 代理；后台启动 starting→running/failed；`.cmd` 用 shell 启动；缺配置/CLI 给 error/guide | ensure 200 或 starting，status online，`/pi-agent/v1/models` 200 |
| 视频编辑/角色替换成片少约 1 秒 | Remake 17n+5 帧向下对齐丢帧；长片尾段不足 90 帧被丢弃 | 用 `alignViggleFramesUp` 向上补帧，生成后按源时长裁回；长片尾段补帧覆盖（`-shortest` 收口） | 输出 duration/nb_frames 与源片一致 |

## 维护者门禁

- 改 `comfyui-gateway/resources/index.json` 必须递增 `version`（当前 `2026.11.17-6`），同版本等于空发布，客户端不会更新。
- 节点用 `autoInstall` + `bundleDir` 随包放置；模型放对应 pack（音频包 id `audio`），来源、大小、许可、sha256 要写全。
- 节点包更新后，用户侧必须重启 ComfyUI；只重扫不会加载新节点类。
- 发布前构建前端用 `VITE_HIDE_EXPERIMENTAL=1 npm run build`，构建后恢复 `dist/config.js` 并核对 md5，不要把构建模板带进发布包。
