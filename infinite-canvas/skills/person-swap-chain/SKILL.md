---
name: "person-swap-chain"
description: "一键换人/编辑 → 视频全链条：源视频 + 参考图 + 意图，自动完成选帧、OLDX/Qwen2.1 静帧制备、图像门、Viggle Aiden 视频、视频门与证据包。含失败模式维修手册（不换人/比例/换错人/只换头/回原 ghost/背景重绘/sigma/底模/图序/四视图/假绿/运行纪律）。"
---

# 一键换人/编辑全链条

给画布「一键换人/编辑」卡与内置 Agent 的 `person_swap_chain` 工具使用。用户只填一次：源视频、参考图、意图、目标点选，点一次「确定」，链路自动跑完 S1–S7。

## 输入

- 源视频（必，建议 ≥3.75s；24fps 归一）
- 参考图 1–2 张（换人必；单换 1 张、双换 2 张；编辑可 0 张）
- 意图自然语言（必）：换谁 / 换衣 / 光照 / 时间 / 双人
- 目标点选：自动框 + 可点选覆盖；多人/低置信时强制点选，不猜
- 可选 seed（默认 `98742863019142`）

## 模式与图序契约（以实测为准）

| 模式 | 图像输入顺序 | oldx | 输出 |
|---|---|---|---|
| single_swap | **image_1=替换人物参考、image_2=目标画布**（目标区黑 0.7 蒙版） | 0.9 | 832×480 painted |
| double_swap | **image_1=目标画布、image_2=参考A、image_3=参考B**；提示显式「左→图2、右→图3」 | 0 | 832×480 painted |
| edit_clothes / edit_light / edit_time | **image_1=目标画布**；提示锁身份/姿势/尺度/构图，仅改 X | 0 | 832×480 painted |

- 共同：Qwen2.1 **bf16 基座**（作者 int8_convrot 不在位时声明）、6步 LoRA `p_q_image_2.1_6_steps_v0.2_comfyui_bf16` **1.0**、euler / CFG1、ManualSigmas `1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.35, 0.152292, 0`。
- 6步 LoRA 元数据写 `...0.222292, 0`，与工作流值不一致；**以工作流值 0.35/0.152292 为准并声明**。
- OLDX LoRA 文件名 `oldx-qwen2.1人物替换.safetensors`（作者名 `oldx_personswap_qwenimage2.1`）；头解析正常时 size 159,436,400B。
- 单换人提示加 `<rwth>` 触发词；双换/编辑 oldx=0，不加 `<rwth>`。
- 参考预缩放：按源目标 head/body 与同景别；本链路用目标框 + 黑 0.7 蒙版锁姿势；不满足时在 job.readings 声明。

## 视频契约

- 换人：Aiden 作者模板原封——**124f / short_edge480 / 无 pins / 6步 Swap sigmas / SigmaShift12-2 / kitchen / BlockSparse tau1.1 / KeyframeUntil0.9**；单换用单人 prompt，双换用 2 Subject 显式映射。
- 编辑：H3 Viggle Edit——`minimax_h3_fl2va_pruned_int8_convrot` + `viggle_remake_edit_comfyui` strength1 + edit sigmas `1.0,0.983607,0.96,0.923077,0.857143,0.705882,0`。
- 底模/TE 偏离：作者 `qwen_image_2.1_int8_convrot`、`qwen3vl_32b_minimax_h3_nvfp4_awq` 不在位时，用本机 bf16/int8_convrot 并在 job 声明；同名不同内容不顶替（核 size+sha）。

## 门（自动，不过则重试/失败 surfaced）

- S4 图像门：目标区确有变化；蒙版外保持；参考与目标区颜色/结构代理相似度高于源；负控=源图自身应失败。阈值与读数入 job.gates.image。
- S6 视频门：抽 0/32/64/96 帧，目标区变化持续、背景/亮度异常检查、接触表每 8 帧；负控=源视频自身应失败。读数入 job.gates.video。
- 重试限额：S4 ≤2、S6 ≤1；失败带证据（painted/video/contact/读数/promptId），给「重试/改目标/改参考」。
- 门是代理指标（rgb64x36，非人脸 embedding）；只交原始读数，不冒充人脸 sim；最终由用户看整片判定。

## API / Agent / 画布

- `POST /v1/swap-chain` multipart：`source_video`、`refs`、`intent`、`mode`、`target_selection`(JSON)、`seed` → job id。
- `GET /v1/swap-chain/:id` 进度/阶段/读数/产物；`POST .../cancel` 真停；`POST .../resume` 中断续跑。
- 产物：`/v1/swap-chain/:id/content/video|painted|target|contact`。
- 内置 Agent：`person_swap_chain` 工具建一键配置节点；画布一键卡读取同一契约，AI 路径与人手同链。

## 运行纪律

串行 GPU 单 owner；跑前 `/queue` 空 + `nvidia-smi` 预检，不足排队不硬加载；S3 Qwen 与 S5 Viggle 切换 `/free`；job 落盘可恢复；取消=interrupt/真停；不静默放行。

## 维修手册（失败模式→诊断→修→门）

1. **不换人/贴块**：clean 照直注 Viggle 只贴参考块、不传播。→ 修：OLDX 静帧制备 painted frame，再 Viggle。→ 门：接触表身份 persist。
2. **比例猎奇**：参考景别/尺度≠源目标（实测 head/body 0.60 vs 源 0.44）。→ 修：参考预缩放至源 head/body + 同景别 + PE/提示锁尺度。→ 门：head/body ∈[0.9,1.1]×源。
3. **换错人**：蒙版不锁目标（实测 a/c 换左女）。→ 修：目标点选 + 黑 0.7 蒙版 + 提示显式映射。→ 门：分区脸比对=指定目标命中。
4. **双人右只换头**：chibi 参考风格 clash + 躯干不转移。→ 修：换写实参考或显式声明风格。→ 门：全身转移检查。
5. **视频回原/ghost**：Viggle-Animate 中段身份不 persist。→ 修：Aiden 原封 + OLDX painted。→ 门：接触表无回原/ghost。
6. **背景被重绘**：自研两步制备 outside SSIM 0.665。→ 修：OLDX 蒙版外保持。→ 门：outside SSIM ≥0.9。
7. **sigma 不一致**：6步 LoRA 元数据 0.222292 vs 工作流 0.35/0.152292。→ 修：以工作流值为准并声明。→ 门：记录实际 sigmas。
8. **底模/TE 偏离**：作者 int8_convrot/nvfp4 不在位。→ 修：bf16/int8 替代并声明；同名不同内容不顶替（核 size+sha）。→ 门：启动前核在位。
9. **输入顺序错**：OLDX `image_1=替换人物/image_2=目标`；Qwen 多图 `image_1=画布/image_2,3=参考`；BFS Head `image_1=目标/image_2=头`。→ 修：按契约重排。→ 门：图序检查。
10. **四视图直注无效**：四视图不解决换人/比例，只作身份补充。→ 修：改用 painted frame；四视图只作参考补充。→ 门：目标命中/比例。
11. **门假绿**：worker 自评曾颠倒。→ 修：只交原始证据、用户看整片判；每门带负控样本自检。→ 门：负控必须失败。
12. **运行不稳**：多模型共存/重试失控/取消不真停。→ 修：串行 GPU + `/free` 驻留 + VRAM 预检排队 + 重试 S4≤2/S6≤1 + 取消 interrupt + job 落盘恢复。→ 门：每阶段有状态/证据。

## 交付

视频 + painted frame + 目标帧 + 每 8 帧接触表 + 图像/视频门读数 + promptId/参数/seed 全部入 job。用户看整片判定；失败面板给「重试/改目标/改参考」，不静默。
