# HANDOFF — 无界工作台 v0.21.26（已发布）

日期：2026-10-29
状态：**v0.21.26 已推送 GitHub / 魔搭 / 夸克，补丁与匿名下载均已核验。**

## 0. 本轮完成（v0.21.19 → v0.21.26，一天内连续发版）

- **v0.21.19**：关页 30 秒回收后台（网关 `sessions` 补 `startedAt/closedAt`，启动器默认 30s，旧配置的 15 视为新默认）；超分包补 5 个 SeedVR2 运行库（diffusers/rotary/omegaconf/opencv/einops，阿里云镜像，带 SHA）；视频 ESRGAN 2× 去掉 WAS 依赖改核心节点；旧版升级桥接优先用随包离线补丁（不再强制联网）。
- **v0.21.20**：资源卡「不适用」→「显存紧张」。
- **v0.21.21**：模型放深层子目录可识别（唯一后缀匹配 + 提交时改写真实路径）；插件按 `provides` 类名判已装（启动器复制前也查）；不可用徽章分「缺 N / 待重启 / 模型名未匹配」；显存状态条 nvidia-smi 8s 超时、System32 兜底、超时保留上次读数并标 `gpuStale`。
- **v0.21.22**：ComfyUI 桌面版 + 各种整合包：端口并行探测（comfyUrl → 8188 → 8000 → 7860/8080/8888/18000 → 8189–8199，`COMFY_PORT_SCAN` 可加）；安装目录增加桌面版路径；启动计划 = 桌面 exe → 内容调用 `main.py` 的脚本（任意/中文名，父目录也扫）→ `python main.py --port <空闲>`。
- **v0.21.23**：人物替换（H3 角色替换）硬性跟随源视频全长——节点策略改 `model_minimum`，长度按 17n+5 **向下对齐、不封顶**；ffprobe 探不到时用前端上报时长 ×24 换算。
- **v0.21.24**：单文件上传上限 50MB → **512MB**，超限返回 413 中文提示。
- **v0.21.25**：自由卡片提交前剔除「未连接输出」的节点（ComfyUI 会校验全部节点）；生图响应与日志回传本次实际 `seed`。
- **v0.21.26**：自由卡片进一步只保留**最大输出链路**——游离的 `SaveImage` 也是输出节点，v0.21.25 裁不掉它。

## 1. 当前产物

- 版本：`VERSION` / `infinite-canvas/VERSION` / `CHANGELOG` / `update.json` = **v0.21.26**。
- 补丁：`patches/v0.21.26.zip`，**37,531,224 B**，sha256 `09880aec2f906b5fdab52cd99bd2ca4e01cafc7942d3bad907e4f4b7d6784869`。
- GitHub：`1314521gjy/ComfyUI-Local-Infinite-Canvas` `main = a2852c1`（远端 hash 由 API 通道生成，与本地提交号不同但内容一致）。
- 魔搭：`shensanshu/ComfyUI-Local-Infinite-Canvas` `master = ba08be9`；LFS 跟踪 `web/dist` 与 `patches/*.zip`。
- 夸克：程序包已到 v0.21.26；升级目录 `程序升级（旧版 → v0.21.19 … v0.21.26）` 每个都带 `manifest.json + zip + update.bat/apply-update.ps1/README`。
- 测试：网关 **142/142**；启动器 5/5；前端 typecheck/build 通过。

## 2. 新增/变化的关键链路

- **可用性缓存**：只由启动、工作流目录变化、安装/切主模型、资源中心「重新扫描」触发；**没有后台自动扫描**（做过又撤掉，用户明确否决）。
- **模型已装判定顺序**：精确相对路径 → 主模型覆盖 → 同族底模回退 → 用户别名 → 唯一后缀匹配（`a/b/x.safetensors` 视作 `x.safetensors`）。
- **节点已装判定**：`custom_nodes/<目录名>` 存在，**或** `provides` 里的类全部出现在 `/object_info`；启动器复制内置节点前同样检查。
- **上传**：multer memoryStorage，单文件 512MB、最多 12 个；`MAX_UPLOAD_BYTES` 可调。
- **人物替换时长**：无手选；ffprobe → 前端 `source_duration_seconds` → 17n+5 向下对齐；policy `model_minimum`；>15s 画质/一致性**未实测**。
- **自由卡片**：提交前 `pruneUnreachableNodes`（`ui-workflow.js`）只保留最大输出链路；无输出节点时原样提交。
- **显存状态**：`/api/system/stats` 由网关调 nvidia-smi（8s 超时、System32 兜底）；失败沿用上次读数并标 `gpuStale`。
- **seed 回传**：`/v1/images/generations|/edits` 响应带 `seed`，日志 `image … seed=…`（视频异步暂不回传）。

## 3. 发布流程（本轮实际用法）

1. 改 `VERSION` / `CHANGELOG` / `update.json`；2. **先改版本再** `npm run build`（build-patch 会校验 dist 里的版本串）；3. `node tools/build-patch.mjs --root .. --out patches/vX.zip --write-manifest`；4. commit；5. 推 GitHub（直连常被 reset，失败用 `tools/push-github-api.mjs`；远端与本地基线 hash 不一致时用自写的 API 脚本，按「本地最后一次内容相同的提交」做 base）；6. 魔搭：`GIT_LFS_SKIP_SMUDGE=1` + `core.longpaths` clone、`GIT_ASKPASS` 用 `~/.modelscope/credentials/git_token`、追加 `.gitattributes` LFS 规则、`git lfs push --all`、push master；7. 夸克：新建升级目录、程序包换文件、**旧件移到顶层回收站**；8. 匿名核验补丁 sha 与远端 `update.json`。

## 4. 环境事实

- ComfyUI：`E:\ComfyUI`（:8188），torch 2.12.0+cu130，4080S 32GB；启动命令无 `--reserve-vram/--lowvram`；CUDA 可见 31.99 GiB。
- 服务：网关 :8190、画布 :3000、启动器控制 :8290；`launcher/config.json` 的 `canvasIdleGraceSec = 30`。
- 两棵树：`…\2026-10-24\07842353`（dev，无 .git，本机安装/实验）与 `…\07842353-release-staging`（仓库，发布源）。

## 5. 未完成 / 风险

- **seed 回传**只到响应和日志，节点信息面板还没展示（原计划跟版本一起上）。
- **桌面版 / 整合包**只用假目录 + 端口 stub 验证了决策逻辑，真机未验。
- **8G 卡满载**的状态条未真机；「显存显示不正常」未复现（疑似多卡或状态条冻结）。
- **H3 角色替换 >15s** 的画质、显存、耗时未实测；VDN 偶发闪烁仍在。
- 资源卡徽章 UI（待重启/模型名未匹配）未截图验证。
- 本地提交号与 GitHub 远端 hash 分歧（内容一致），下次 `git fetch` 后需对齐。
- 夸克顶层 `_无界工作台-回收站` 里是历史旧件，要彻底清理需在夸克 App 手动删除（CLI 只能 move）。

## 6. 命令

```bash
cd C:/Users/Administrator/Documents/Qoder/2026-10-24/07842353-release-staging/comfyui-gateway
COMFYUI_DIR=E:/ComfyUI/ComfyUI node --test --test-timeout=120000 test/*.test.js

node --test launcher/test/launch-plan.test.js
cd infinite-canvas/web && npm run typecheck && npm run build
node ../../tools/build-patch.mjs --root ../.. --out ../../patches/v0.21.26.zip --write-manifest
```

## 7. 约束

- 不从 dev 实验区整目录复制到 staging；不覆盖用户 `data/models/node_modules/bundled/config`；不自动跑 GPU 编译/推理；不上传 Key。
- H3 的 SageAttention 是工作流的一部分，不旁路、不删节点。
- 夸克同名上传会出副本；没有删除命令，只能 move；**旧件只进顶层 `_无界工作台-回收站`，绝不放进分享树**。
- CC-BY-NC-SA 模型不得随分发源提供。
- 发布顺序：改版本 → build → build-patch 守卫 → 上传 → 匿名核验。
- 文档保持单文档 ≤200 行，历史追加 `docs/PROJECT_LOG.md`。

## 8. 交接入口

1. 先读本文件；2. 架构与运行链路见 `docs/ARCHITECTURE.md`（已入库并同步魔搭）；3. 具体行为以 `comfyui-gateway/workflows/*.json`、`resources/index.json`、`comfyui-gateway/src/*` 为准。
