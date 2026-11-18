---
name: canvas
description: 操作 Infinite Canvas 当前网页画布，读取节点、选区、创建文本节点、创建生成流程、连接节点或触发生成。
---

# Infinite Canvas

你正在帮助用户操作 Infinite Canvas 网页画布。需要理解或改动画布时，优先使用已配置的 `infinite-canvas` MCP 工具；不要让用户手动复制 JSON、URL 或 token。

## 工作流

- 如果用户还没有打开或连接网页画布，使用 `open-canvas` 技能打开 Infinite Canvas，不要要求用户手动复制 URL 或 token。
- 操作前先用 `canvas_get_state` 读取当前画布；如果用户明确提到选中内容、当前节点或“这个”，先用 `canvas_get_selection`。
- 创建单个文本内容优先用 `canvas_create_text_node`。
- 创建生成内容优先用 `canvas_generate_text`、`canvas_generate_image`、`canvas_generate_video`、`canvas_generate_audio`。
- 需要把提示词、配置和生成节点串成流程时，使用 `canvas_create_generation_flow` 或项目已有的流程工具。
- 需要批量增删改、移动、连接节点或设置视口时，使用 `canvas_apply_ops`。
- 不要模拟鼠标点击，不要要求用户手动复制 JSON。
- 写入画布的操作会由网页侧边栏做二次确认，按当前工具结果继续推进即可。

## 新功能

- **3D 场景**：图片卡工具栏的「3D 场景」是唯一 3D 入口（旧 3D 物体入口已移除）。流程为扩全景（H3-Image）→ 修缝（Qwen 2.1）→ 建场景，输出单张 5664×2832 的 2:1 全景 PNG（常见约 20MB，不支持 glb）。生成是异步任务：先返回 202 + taskId，再轮询 `/v1/tasks/:id`，可取消。生成后拖动/滚轮环视（Three.js，WebGPU 失败回退 WebGL），「拍照」把当前视角导出成右侧图片卡，也可下载全景。
- **音频卡**：只有「写歌」和「台词配音」两种模式；旧「换音色/换声」入口已移除。写歌走 YuE2 ComfyUI（默认 int8 checkpoint，发布版不依赖 CLI/venv）；歌词留空、填写风格或选预设即纯音乐，由 `YuE2InstrumentalConvert` 节点转换并过滤人声风格标签。时长可自动（人声按歌词行数×6 秒、纯音乐回退 200 秒、上限 300 秒）或手动 30–300 秒；风格可点预设，也可手写覆盖。
- **视频编辑弹卡**：视频卡工具栏「视频编辑」，或多选至少两段视频后用「剪辑」。分「角色替换」「视频编辑」两套模式，可点帧或涂抹蒙版；先「生图预览」（蒙版/编辑走 Qwen 2.1，参考替换走 OldX 人物替换），再「生成视频」（Viggle）。生图预览可用优化稿，生成视频保留原始稿；Viggle 六段式视频提示词由网关本地编译，不依赖云端。
- **生图加速**：Z-Image 只有关闭/开启两档：开启等于原低档（`zimageAccelT=5`），关闭为原生采样；仅 2K/4K 生效，1K 下控件禁用。觉得模糊就关闭。
- **资源与部署**：YuE2 int8 模型在资源中心「音频（YuE2）」包；纯音乐转换节点随包自动安装（`custom_nodes/yue2_instrumental`，提供 `YuE2InstrumentalConvert`）。部署、端口、模型/节点缺失、显存、更新问题见 `deploy-repair` 技能。

## 风格

- 页面文案和画布节点内容默认使用中文。
- 生成节点、配置节点和提示词节点要保持结构清晰，方便用户继续编辑。
- 批量创建节点时注意给节点留出间距，不要堆叠在同一个位置。
- 图片、视频、音频等媒体节点默认保留原始比例；只有用户明确要求自由变形时才改变比例。
- 生成流程尽量少而清楚，优先让用户一眼能看懂节点关系。
