---
name: h3-prompt-writing-cloud
description: 把用户的多模态视频需求写成 MiniMax-H3 提示词。云端版：强制台词逐字保真，区分三段 T2VA/I2VA/FL2VA/L2VA 与六段 Ref2VA，处理首尾帧对齐、说话人编号、声音分层和参考标签。
---

# H3 视频提示词写作（云端）

## 0. 台词保真（最高优先级，违反即失败）

- 用户原文里 **引号内** 的文字，以及 `说 / 说道 / 问 / 问道 / 喊 / 叫 / 回答 / 声音 / 旁白 / 台词 / 对白 / 唱：` 后面的文字，都是台词。
- 台词必须 **逐字保留**：不翻译、不改写、不概括、不删减、不合并、不补写，标点也保留。不得把“你就是沈三叔？”改写成“压低嗓子质问”。
- 台词格式固定为 `(Sx) <d>[语言]原文</d>`：
  - `(Sx)` 用 **半角括号**，按目标视频首次发声顺序编号；同一个人全程复用同一编号。
  - `<d>` 外只写说话人身份、动作、语气、是否画外；`<d>` 内只放语言标签和原文。
  - 画外说话人写 `off-screen`；旁白写 `says in an off-screen voiceover`，并说明画面中人物闭口。
- 同一句台词只写一次。`overall_soundscape` 和 `non_diegetic_music` 只写环境声、动作声、音色和配乐，不复述台词。
- 用户没加引号、但写成“画面外同一个男人的声音：老东西。”的，也算台词，按原文写入 `<d>`。
- 示例：
  - 原文：`画面外男人质问的声音：“你就是沈三叔？” 老头儿说道：“沈什么叔？” 画面外同一个男人的声音：老东西。`
  - 正确：`画外男人 (S1) 压低嗓子问道：<d>[Chinese]你就是沈三叔？</d> 老头儿 (S2) 侧过头，沙哑地反问：<d>[Chinese]沈什么叔？</d> 同一个男人 (S1) 的声音再次响起，语气轻蔑：<d>[Chinese]老东西。</d>`
  - 错误：`画外传来一个男人压低嗓子的质问，老头儿沙哑地反问，同一个男人轻蔑地骂了一句。`（台词全部丢失）

## 1. 先判断模式

- `T2VA` / `I2VA` / `FL2VA` / `L2VA`：只输出三段，字段名和顺序固定。
- `Ref2VA`（全参考）：只输出六段，字段名和顺序固定。
- 不要输出别的字段，不要解释，不要 Markdown 代码块。

## 2. 三段模式（T2VA / I2VA / FL2VA / L2VA）

```text
integrated_multimodal_description: [Shot 1] ...
[Shot 2] At 00:0X.000, ...
overall_soundscape: ...
non_diegetic_music: ...
```

- `[Shot 1]` 不写时间，也不写 `0.00 秒`；后续镜头写 `[Shot N] At MM:SS.mmm,`，按播放顺序递增。
- 总时长与用户给定时长一致；通常 1–4 个镜头，最后一个镜头收敛到结尾。
- I2VA：从 `<Picture 1>` 的首帧向后发展，不换底图。
- FL2VA：从 `Picture 1` 连续过渡到 `Picture 2`，优先单镜头，最后一镜落到尾帧。
- L2VA：从合理的前置状态开始，结尾收敛到 `<Picture 1>`。
- 对齐句由系统在正文前补充，正文不要再写“Picture 1 aligns with 0.00 seconds”之类的对齐说明。

## 3. 六段模式（Ref2VA）

```text
subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```

- `subject_definitions`：每个标签单独一行。`<Subject N>` 定义人物/物体/场景/服装；`<Picture N>` 只在图片作为首帧、关键帧、尾帧或构图锚点时单独成条，只提供人物身份的图片写进对应 `<Subject N>`；`<Video N>` / `<Audio N>` 独立编号；全文标签含义一致。
- `summary`：以一个方括号任务类型开头，如 `[reference generation]`、`[keyframe completion]`、`[video editing]`、`[video continuation]`、`[audio reuse]`、`[audio reference]`，可组合 `+`，再概括目标视频和参考关系。
- `retention_analysis`：每个标签一行。可见内容固定用 `fully_preserved / partially_preserved / attribute_transfer / weak_reference`；音频固定用 `fully_copy / partially_copy / reference / weak_reference`，并说明保留或替换了什么。
- `detailed_description`：按播放顺序写镜头、构图、主体、动作、镜头运动、光线、环境、声音和台词；`[Shot 1]` 不写时间，后续 `[Shot N] At MM:SS.mmm`；完整台词只写在这里。
- 人物替换任务必须写清：用 `<Picture N>` 中的哪个人替换 `<Video N>` 里的哪个人，并逐项列出原样保留的人、动作、机位、背景和声音；不要把被替换的人写成保留对象。
- 画外说话人写 `<Subject N> (Sx) off-screen`；台词跨镜头用 `<scenetrans>` 并说明声音连续；结尾截断用 `<cutoff>`。

## 4. 声音两段

- `overall_soundscape`：环境声、物理动作声、非语言人声（呼吸、脚步、衣料、耳光、倒地等），1–4 句，连续段落。
- `non_diegetic_music`：只有观众能听到的背景音乐；写乐器、速度、动态；用户禁止配乐时写“无配乐”并说明整段没有音乐。
- 这两段都不重复台词内容，也不写 `<d>`。

## 5. 语言与格式

- 官方字段名保留英文。
- 字段正文默认中文；用户明确指定其他语言时遵从。
- 台词 `<d>` 内使用原语言标签：中文 `[Chinese]`、英文 `[English]`，原文是什么语言就用什么语言。
- 画面中真实可见的招牌/字幕/文字用英文双引号原样保留，不翻译；不要把画面文字当台词。
- 不要编造品牌、字幕或画面文字；不要输出思考过程、分析、解释、前后缀或 Markdown 代码块。
