---
name: "viggle-remake-prompt"
description: "Write or fix Viggle Remake prompts for the canvas H3 character-swap workflow: the author's fixed six-section template (English body, write the finished film), <Picture N>/<Subject N> mapping, pins, and the default one-shot swap. Selecting this workflow and clicking optimize sends the text to the cloud model automatically; natural-language prompts are also auto-compiled before generation."
---

# Viggle Remake Prompt

给画布「H3 角色替换（Viggle Remake）」写提示词、配 pins/参考图，或排查“不换人 / 只换一部分 / 串脸 / 闪帧”。

**默认口径：一次产片**——源片 + 1–4 张角色参考图 + 提示词，网关自动编译六段式、自动选帧填 pins，一次生成；不做目标帧制备、不跑两遍、不走图像编辑模型。

## 优化入口（已绑定）

- 在画布选中本工作流后点提示词面板的「优化」，**自动走云端 AI**（`isViggleSwap` 强制 cloud，任务类型 `Viggle`），不需要手动切引擎。
- 一次产片默认无感：提示词是自然语言时，网关提交前自动编译六段式（带参考图+源片抽帧），不点优化也能直接生成；已是六段式则直用。
- 云端系统提示已是作者的固定模板：输出英文正文、六段式固定骨架、写“目标成片”，不写“把 A 换成 B”。

## 作者模板（固定六段式）

字段名固定，正文英文（台词/画面文字保留原语言）：

```
subject_definitions:
<Video 1> is the source video with multiple people in one continuous shot.
<Picture 1> is the target video's frame at the pin (MM:SS.mmm), showing person A as <Subject 1>; composition and pose match the source at that frame.
<Picture 2> is the target video's frame at the pin (MM:SS.mmm), showing person B as <Subject 2>; composition and pose match the source at that frame.
<Subject 1> is person A in <Video 1> replaced by the person in <Picture 1>: <look/wardrobe>.
<Subject 2> is person B in <Video 1> replaced by the person in <Picture 2>: <look/wardrobe>.

summary:
[video editing + character replacement] The target video is an edited version of <Video 1> where person A becomes <Subject 1> exactly as in <Picture 1>, person B becomes <Subject 2> exactly as in <Picture 2>, keeping the same actions. Background, props, other people (if any), camera, motion and timing of <Video 1> are kept.

retention_analysis:
<Video 1> (source video editing): fully_preserved - shot structure, camera path, scene, lighting, non-replaced people, and action timing stay frame-accurate.
<Picture 1> (appears in [Shot 1]): reference - identity and wardrobe for <Subject 1>.
<Picture 2> (appears in [Shot 1]): reference - identity and wardrobe for <Subject 2>.
<Subject 1> (appears in [Shot 1]): fully_preserved - matches <Picture 1> throughout; no leftover original face, hair or clothes of person A.
<Subject 2> (appears in [Shot 1]): fully_preserved - matches <Picture 2> throughout; no leftover original face, hair or clothes of person B.

detailed_description:
The target video matches <Video 1> in scene, colour grade and camera.
[Shot 1] From 00:00.000 to <duration>, person A is replaced by <Subject 1> as in <Picture 1>, and person B is replaced by <Subject 2> as in <Picture 2>, each following their own body path, poses and timing from <Video 1>. Hair and clothes move naturally. Only these replaced figures change; everything else stays as in <Video 1>.

overall_soundscape:
The source soundtrack continues throughout.

non_diegetic_music:
N/A
```

## 硬规则

1. 写“目标成片长什么样”，不写“把 A 换成 B”的操作指令。
2. `<Picture N>` 是**角色参考图**，按上传/连线顺序对应 Picture 1..N：默认一次产片直接用角色图，不做重绘关键帧、不跑两遍。
3. 一张 Picture 里有多人时，多个 Subject 共用同一张 `<Picture N>`，不要拆成身份照。
4. 每个要替换的人一个 Subject，写清 left/center/right、源片里的外观、换成参考帧里的谁；subject_definitions / retention_analysis / detailed_description 三处都要出现。
5. retention_analysis 逐项写 fully_preserved / reference；源片的镜头、构图、场景、光线、其他人物、时序默认 fully_preserved。
6. detailed_description 用 `[Shot 1]`，时间戳 `MM:SS.mmm` 必须落在 duration 内。
7. 静音源写 `The source clip is silent; the soundtrack stays silent.`，`non_diegetic_music:` 只写 `N/A`。
8. pins 不写进正文：留空时网关自动选帧（优先与角色参考图构图/姿态最接近的源帧，灰度网格相关性）并按参考图张数填入；显式填写则覆盖自动值。
9. 防闪：`<Picture N>` 按“目标视频在 pin 帧的画面”写；retention_analysis 对 `<Video 1>` 与未替换主体逐项 fully_preserved（除被换主体）。
10. 一次产片：禁止第二遍、禁止抽帧回注；不要写新的目标帧或“先跑一遍再跑一遍”。

## pins 行为（实测）

- 留空：网关自动选帧填入（一次产片）；若绕过网关直接提交，空=不触发替换。
- `0`：触发替换，但第 0 帧会被参考图场景覆盖（首帧污染），网关拒绝。
- `k>0`：在第 k..k+2 帧注入参考图（约 2–3 帧闪烁）。
- 显式 pins 优先；多张角色图时网关自动值=同一个最优帧，显式值可每图不同。

## 两遍目标帧配方（非默认，可选备注）

- 用户已拍板：默认一次产片，不制备目标帧、不跑两遍。以下仅旧版/特殊需求参考，不作默认。
- 旧配方：源片 + 角色图跑最短 90 帧（`pins=17`）→ 抽第 20 帧 → 第二遍用该帧作 `<Picture 1>`、`pins=20`，总耗时约 70s + 88s。

## 画布操作

- 模型选「H3 角色替换（Viggle Remake）」；源视频 1 段（≥3.75s，超过分段长度自动切段，静音源网关自动补静音轨）。
- 参考图 1–4 张，上传顺序即 `<Picture 1..4>`。
- 视频设置：「分段长度」3.75–14.4s；「钉源帧 pins」留空=网关自动选帧，显式填写（每图一个帧号）覆盖自动值。
- 提示词可点「优化」用云端生成，但输出必须是六段式英文；中文正文会被模型弱化。

## 检查清单

- 逐人：每个 Subject 落到指定位置；无串脸；无漏人（原脸保留）。
- 闪帧：抽 pins 附近帧看是否出现参考图场景；相邻帧 SSIM 突变（<0.5）即可疑。
- 音轨：静音源输出应静音（aac 32k，RMS≈-97dB）；有音轨源 RMS 应与源对齐（±0.5dB）。

## V7 一键链契约（2026-11-14）

本 skill 被 `person-swap-chain` 一键链调用时，以下口径覆盖上文“一次产片默认 auto pins”：

- 图像制备：OLDX 静帧先做 painted frame；**单换人** `image_1=替换人物参考、image_2=目标画布`（目标区黑 0.7 蒙版），oldx strength **0.9**；**双人**走 Qwen 多图编辑 `image_1=目标画布、image_2=参考A、image_3=参考B`，oldx strength **0**；**编辑** `image_1=目标画布`，oldx **0**。
- 视频：Aiden 作者模板原封——124f / short_edge480 / **无 pins** / 6 步 Swap sigmas / SigmaShift 12-2 / kitchen / BlockSparse tau1.1 / KeyframeUntil0.9；单/多人模板按 Subject 数自动选。
- 编辑视频：H3 Viggle Edit（`minimax_h3_fl2va_pruned_int8_convrot` + `viggle_remake_edit_comfyui` + edit sigmas）。
- 详细契约与维修手册见 `infinite-canvas/skills/person-swap-chain/SKILL.md`。

## 维修手册（失败模式→诊断→修→门）

| # | 失败模式 | 诊断 | 修 | 门 |
|---|---|---|---|---|
| 1 | 不换人/贴块 | clean 照直注 Viggle 只贴参考块，不传播 | OLDX 静帧制备 painted frame，再走 Viggle | 接触表身份 persist |
| 2 | 比例猎奇 | 参考景别/尺度≠源目标（head/body 0.60 vs 源 0.44） | 参考预缩放至源 head/body + 同景别 + PE/提示锁尺度 | head/body ∈[0.9,1.1]×源 |
| 3 | 换错人 | 蒙版不锁目标（实测 a/c 换左女） | 目标点选 + 黑 0.7 蒙版 + 提示显式映射 | 分区脸比对=指定目标命中 |
| 4 | 双人右只换头 | chibi 参考风格 clash + 躯干不转移 | 换写实参考，或显式声明风格 | 全身转移检查 |
| 5 | 视频回原/ghost | Viggle-Animate 中段身份不 persist | Aiden 原封 + OLDX painted | 接触表无回原/ghost |
| 6 | 背景被重绘 | 自研两步制备 outside SSIM 0.665 | OLDX 蒙版外保持 | outside SSIM ≥0.9 |
| 7 | sigma 不一致 | 6步 LoRA 元数据 0.222292 vs 工作流 0.35/0.152292 | 以工作流值为准并声明 | 记录实际 sigmas |
| 8 | 底模/TE 偏离 | 作者 int8_convrot/nvfp4 不在位 | bf16/int8 替代并声明；同名不同内容不顶替（核 size+sha） | 启动前核在位 |
| 9 | 输入顺序错 | OLDX image_1=替换人物/image_2=目标；Qwen 多图 image_1=画布/image_2,3=参考；BFS Head image_1=目标/image_2=头 | 按契约重排 | 图序检查 |
| 10 | 四视图直注无效 | 四视图不解决换人/比例，只作身份补充 | 改用 painted frame；四视图只作参考补充 | 目标命中/比例 |
| 11 | 门假绿 | worker 自评曾颠倒 | 只交原始证据、用户看整片判；每门带负控样本自检 | 负控必须失败 |
| 12 | 运行不稳 | 多模型共存/重试失控/取消不真停 | 串行 GPU + /free 驻留 + VRAM 预检排队 + 重试 S4≤2/S6≤1 + 取消 interrupt + job 落盘恢复 | 每阶段有状态/证据 |
