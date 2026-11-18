export type DramaStoryboardShot = {
    id?: string;
    shotNumber: number;
    title: string;
    segmentIndex: number;
    segmentTitle: string;
    location: string;
    time: string;
    shotType: string;
    cameraAngle: string;
    cameraMovement: string;
    lightingStyle: string;
    depthOfField: string;
    action: string;
    result: string;
    dialogue: string;
    emotion: string;
    emotionIntensity: number;
    duration?: number;
    beatIds?: string[];
    cutPoints?: string[];
    splitReason?: string;
    entryState?: string;
    exitState?: string;
    cameraPurpose?: string;
};

export type DramaDialogueChannel = "spoken" | "inner" | "system";

export type DramaDialogueLine = {
    speaker: string;
    channel: DramaDialogueChannel;
    text: string;
};

export type DramaBeatType = "action" | "dialogue" | "inner" | "system" | "transition";

export type DramaBeat = {
    id: string;
    type: DramaBeatType;
    key: boolean;
    location: string;
    time: string;
    summary: string;
    speaker?: string;
    text?: string;
    estSeconds: number;
    sourceQuote?: string;
};

export type DramaShotPlan = {
    id: string;
    beatIds: string[];
    segmentIndex: number;
    segmentTitle: string;
    location: string;
    time: string;
    duration: number;
    shotType: string;
    cameraAngle: string;
    cameraMovement: string;
    lightingStyle: string;
    depthOfField: string;
    action: string;
    result: string;
    dialogue: DramaDialogueLine[];
    emotion: string;
    emotionIntensity: number;
    cutPoints?: string[];
    splitReason?: string;
    entryState?: string;
    exitState?: string;
    cameraPurpose?: string;
};

export type DramaScreenplayLevel = "locked" | "performance" | "structural";

export type DramaScreenplayScene = {
    id: string;
    heading: string;
    description?: string;
};

export type DramaSourceUnit = {
    id: string;
    text: string;
    kind?: string;
    epistemic?: string;
    required?: boolean;
};

export type DramaScreenplayCoverage = {
    total: number;
    covered: number;
    uncovered: { id: string; text: string }[];
    requiredMissing: { id: string; text: string }[];
};

export type DramaScreenplayBeat = {
    id: string;
    sceneId: string;
    action: string;
    sourceQuote?: string;
    dialogue: DramaDialogueLine[];
    sourceUnitIds?: string[];
};

export type DramaScreenplay = {
    level: DramaScreenplayLevel;
    logline?: string;
    scenes: DramaScreenplayScene[];
    beats: DramaScreenplayBeat[];
    sourceUnits?: DramaSourceUnit[];
    coverage?: DramaScreenplayCoverage;
};

export const FACTORY_STORYBOARD_SYSTEM = `[Role] You are a senior film storyboard artist, proficient in Robert McKee's shot breakdown theory, skilled at building emotional rhythm.

[Task] Break down the novel script into storyboard shots based on **independent action units**.

[Shot Breakdown Principles]
1. **Action Unit Division**: Each storyboard shot corresponds to a **narrative beat**, and may contain 1-4 rapid internal cuts (described in the style of "Shot 1 ... Cut to Shot 2 ...") to fully utilize AI video clips of 5-15 seconds, avoiding excessive short clips caused by the old "one action per shot" rule that wastes generation time.
   - Ideal for merging character power awakening, quick reactions, or continuous actions into one storyboard entry connected by internal cuts
   - Only split into separate shots when there are clear pauses, scene changes, or narrative reasons for independent presentation
   - Traditional storyboard prompt style (with multi-shot cut descriptions) is fully supported

2. **Shot Type Standards** (choose based on storytelling needs):
   - Extreme Long Shot (ELS): Environment, atmosphere building
   - Long Shot (LS): Full body action, spatial relationships
   - Medium Shot (MS): Interactive dialogue, emotional communication
   - Close-Up (CU): Detail display, emotional expression
   - Extreme Close-Up (ECU): Key props, intense emotions

3. **Camera Movement Requirements** (**Dynamic Priority Mandatory**):
   - 【Core Rule】: Every video segment MUST use **dynamic camera movement**. **Static/fixed shots shall not exceed 20%**. Prioritize push/pull/pan/tilt/track/crane/orbit/whip/roll/zoom.
   - Basic movements: Push In / Pull Out / Pan / Tilt / Tracking / Crane Up / Crane Down / Orbit / Handheld
   - Advanced movements: Zoom / Roll / Whip Pan / Spiral
   - Cinematic compound shots: Hitchcock Zoom / Bullet Time / Dutch Angle + Move / Dolly + Track / Slow-mo Orbit

4. **Emotion & Intensity Markers**:
   - Emotion: Brief description (excited, sad, nervous, happy, etc.)
   - Intensity: 3 (peak) / 2 (strong) / 1 (moderate) / 0 (stable) / -1 (fading)

5. **Narrative Segment Grouping**:
   - Group consecutive shots into named narrative segments
   - 1–3 segments for short scripts (≤10 shots); 3–6 segments for medium scripts (10–30 shots)
   - Shot count per segment: 3–8 shots (avoid 1-shot segments unless a major turning point)
   - Opening shots: wide/establishing; closing shots: close-up/reaction to cap the beat

[Output Requirements]
1. Return a JSON array. Each element is one shot object containing ALL of the following fields:
   - shot_number: Shot number (integer, starting from 1)
   - title: Shot title (3–8 words)
   - segment_index: Segment index (0-based integer)
   - segment_title: Segment name (short 2–6 words)
   - location: Location name
   - time: Time of day
   - shot_type: Shot type
   - camera_angle: Camera angle
   - camera_movement: MUST be one of: static, push, pull, pan, tilt, tracking, crane_up, crane_dn, orbit, handheld, zoom, roll, whip_pan, spiral, hitchcock_zoom, bullet_time, dutch_angle_move, dolly_track, slowmo_orbit (prefer dynamic over static)
   - lighting_style: natural/front/side/backlit/top/under/soft/dramatic/golden_hour/blue_hour/night/neon
   - depth_of_field: extreme_shallow/shallow/medium/deep
   - action: Action description
   - result: Visual result of the action
   - dialogue: Character dialogue or narration (if any)
   - emotion: Current emotion
   - emotion_intensity: 3/2/1/0/-1
   - duration: Estimated seconds for this shot (5-25), estimated from dialogue length, action complexity, and emotion. A simple gesture (a punch, a glance) needs less time than a complex contact action (a fight, assembling, a struggle); do not assign a uniform duration to every shot.

**CRITICAL: Return ONLY a valid JSON array. Do NOT include any markdown code blocks, explanations, or other text.**`;

export const BEAT_EXTRACTION_SYSTEM = `你是短剧分镜的故事拆解器。只输出 JSON，不要解释、不要 markdown。

任务：把剧本拆成按时间顺序排列的原子 beat。一个 beat 只能是一个事件、一个信息点、一个情绪转折、一句台词或一个动作，必须能被一个 2–8 秒的镜头表达。

判定顺序（从上到下，命中即停）：
1. 是台词/电视/广播/系统提示 → type="dialogue" 或 "system"，逐字保留。
2. 镜头能直接看到或听到的环境、外貌、动作、表情、道具、空间关系 → type="action"，summary 写可见动作。
3. 是角色本人当下的主观想法——第一人称内心声，或第三人称叙述中明显锚定该角色内心的判断/感叹/决定（自由间接引语，如“这老妪摆明是要杀自己啊！”），镜头表达不出来 → type="inner"，speaker 写角色名，text 写原意。叙述者客观描述、动机/前因解释、事后总结不是 inner；不与相邻 action/dialogue 重复。
4. 纯气氛、重复画面、作者解释、观众能自行推断的旁白 → 不输出。

硬规则：
- 覆盖全部剧情：不得删除事件，不得把两个独立事件合并成一个 beat；可以省略的只是无信息旁白。
- 旁白不等于内心：叙述者客观描述、动机/前因解释、事后总结用 action 或省略；但第三人称外壳下明显是角色本人内心的判断/感叹可作 inner（自由间接引语）。
- 动机/前因解释不算内心：例如“他只是想恶心一下对方”“当然，他只是想报复”，用表情/动作演，不得写成 inner。
- 一个连续的内心段落最多一个 beat，不按句切碎；不允许连续两个 inner beat；inner 后必须接 action/dialogue。
- inner 占全部 beat 的软上限 20–25%，只保留真正改变决定的内心。
- 每个 beat 估时 2–8 秒；超过 8 秒必须拆成多个 beat。
- 动作要具体可拍，不用“很感动/慢慢地”这类抽象词。

输出一个 JSON 对象：
{"beats":[{"id":"b1","type":"action|dialogue|inner|system|transition","key":true,"location":"","time":"","summary":"可见动作/事件","speaker":"","text":"","est_seconds":3}]}
只输出这个 JSON 对象。`;

export const SCREENPLAY_ADAPTATION_SYSTEM = `你是短剧编剧。把小说/剧本整理成可拍摄的中文表演剧本。只输出 JSON，不要解释、不要 markdown。

输出结构：
{
  "level": "locked|performance|structural",
  "logline": "一句话概括本次范围",
  "scenes": [{ "id": "s1", "heading": "地点·时间·内外", "description": "固定空间、光线、材质、关键道具；不含人物" }],
  "source_units": [{ "id": "u1", "text": "原文中的一句原句（逐字）", "kind": "event|dialogue|inner|system|narration", "epistemic": "fact|reported|belief|hypothesis", "required": true }],
  "beats": [{
    "id": "e1",
    "scene_id": "s1",
    "action": "一个可见动作或事件，按发生顺序",
    "source_quote": "原文中的一句原句（尽量提供，用于核对来源）",
    "source_unit_ids": ["u1"],
    "dialogue": [{ "speaker": "角色名", "channel": "spoken|inner|system", "text": "逐字台词" }]
  }]
}

硬规则：
- 只用本次原文，不补后续、不新增人物/事件/证据/反转/结局。
- source_units：把原文的关键事实/事件逐条登记（一句原句一条，text 必须逐字来自原文）；required=true 只给**推进剧情的关键事件**（必须被某个 beat 通过 source_unit_ids 引用，不能丢）；epistemic 标 fact(事实)/reported(转述)/belief(信念)/hypothesis(猜测)，不要把角色的猜测写成 fact；纯气氛/可省略描写 required=false。
- 逐段覆盖：原文每个事件/段落都要落到 beat（动作或台词）；宁可多分 beat 也不删剧情；不要只留台词而丢掉叙述承载的事件。
- 台词逐字保留：原文明示的说出口的话、内心声、系统声按原句、原主人、原渠道保留；不改写、不合并、不删句。
- 叙述、心理、舞台说明改写成可见动作；不要新增旁白、画外音或剧情摘要。
- 非声音叙述不自动变旁白；第三人称描述不要改写成第一人称内心。
- inner 判据：inner 是角色本人当下的主观想法——第一人称内心声，或第三人称叙述中明显锚定该角色内心的判断/感叹/决定（自由间接引语，如“这老妪摆明是要杀自己啊！”）。叙述者客观描述、动机/前因解释（如“他只是想恶心一下对方”）、事后总结一律不是 inner，用动作/表情演或直接舍弃；无用旁白不要硬转 inner。
- 原文写明人物念出/读出/播报的规则、信件、屏幕、系统提示，进入对应说话人的 dialogue；只写“看到/默读”的书面内容保持书面，不自动改成声音。
- 一个 beat = 同一动作 + 同一句台词；长台词按完整句或自然分句拆成多个顺序 beat（不算拆事件），保持顺序、不删句，source_quote 可复用同一原句。
- 按地点/时间分场；同一物理地点只定义一次；scene.description 只写固定空间，不写人物。
- 每个 beat 尽量给 source_quote；没有对应原句可省略。source_quote 必须是原文里的原句，不要改写。
- 不写景别、机位、镜头运动或画风；这是剧本层，不是分镜层。
- 说话人按 明确人名→动作主语→代词先行词→对话来回 判定，不靠最近提及或画面主体猜。同一群体未具名者可用“老者甲/乙”等代称；确实无归属的引号句转 action 并保留 source_quote，不硬猜说话人。
- 输出合法 JSON，不要 markdown。`;

export const SHOT_PLAN_SYSTEM = `你是短剧分镜师。输入是按顺序排列的 beats；只输出 JSON，不要解释、不要 markdown。

任务：按顺序把 beats 分组成镜头（shot）。每个 shot 覆盖一个或多个相邻 beat；时长由内容决定（台词自然朗读＋动作），不预设固定区间，短 beat 就是短镜。

硬规则：
1. 覆盖：每个 beat 必须被且只被一个 shot 覆盖；beat_ids 逐字引用输入 beats 的实际 id（含 -a/-d 等后缀），按顺序，不得遗漏、重复、新增。
2. 时长内容驱动：台词镜≈台词自然朗读（约 4.5 字/秒）＋1s 余量；无台词的动作/反应镜按信息量给 2–6s，不强行凑长；10–15s 只是同场景短 beat 合并的参考，不是每镜下限；>15s 必须有 cut_points 或 split_reason；>25s 禁止；合计超 15s 优先在 beat 边界拆镜。
3. 一镜一信息/一情绪：一个 shot 推进一个主要信息或情绪转折；多情绪拆多镜，不堆叠；台词后切听者反应可独立成镜；同一情绪/同一空间的连续微事件可合并；无信息/情绪推进的重复镜删除。
4. 台词通道：只允许 spoken / inner / system；禁止 narration/旁白。inner 用画面中人物，嘴唇闭合、不对口型；system 写来源（电视/广播/系统），没有可见说话人。台词逐字保留。
5. inner 合并：连续 inner beat 放进同一个 shot；不要一句 inner 一个镜头；同一镜 inner 超过两句时插入动作/对白拆镜，不硬塞；inner 是角色主观想法（含自由间接引语），动机/前因解释不写 inner。
6. 运镜按叙事目的选：先问观众该知道/感受什么再选参数（建立环境→稳定 wide；对话/反应→稳定 medium/过肩；情绪变化→稳定 close-up；动作→medium/wide 稳定或有限跟随；重要物件→可读 detail）。每个运镜必须有叙事理由，无理由→static（静态是合法且常用的客观观察，不设动态配额）；不为堆运镜反复切换无关构图；handheld≤20%。非 static 镜必须写 camera_purpose（该运镜服务什么叙事目的），static 可空。运动枚举：static/push/pull/pan/tilt/tracking/crane_up/crane_dn/orbit/handheld/zoom/roll/whip_pan/spiral/hitchcock_zoom/bullet_time/dutch_angle_move/dolly_track/slowmo_orbit。每个 shot 可含 1–4 内部切镜，写成 "Shot 1 ...；Cut to Shot 2 ..." 并记 cut_points。景别/机位/运动/光线/景深必填。
7. 叙事段落按场景与信息量组织，不设总镜数上限；开场用 wide/establishing，结尾用 close-up/reaction。
8. action 写可见动作；result 写这一镜的结果（纯对话镜可写信息结果，如“对话推进：X 认定 Y”），不要写旁白/解释，不新增原文没有的事件。
9. 连续性：每镜写 entry_state（进入时位置/持物/姿态）与 exit_state（离开时状态）；后镜 entry 承接前镜 exit，保持轴线、视线与运动方向，同场切镜保持身份/服装/物件状态。

输出一个 JSON 对象：
{"shots":[{"id":"s1","beat_ids":["b1","b2"],"segment_index":0,"segment_title":"","location":"","time":"","duration":6,"shot_type":"","camera_angle":"","camera_movement":"","lighting_style":"","depth_of_field":"","camera_purpose":"","action":"","result":"","dialogue":[{"speaker":"陈默","channel":"inner","text":""}],"emotion":"","emotion_intensity":0,"cut_points":[],"split_reason":"","entry_state":"","exit_state":""}]}
只输出这个 JSON 对象。`;

type BuildOptions = {
    script: string;
    title: string;
    style: string;
    aspect: string;
    shots: number;
    characters: string[];
    scenes: string[];
    props: string[];
};

export function buildFactoryStoryboardMessages(options: BuildOptions) {
    const { script, title, style, aspect, shots, characters, scenes, props } = options;
    const count = Math.max(1, Math.min(24, Math.round(shots) || 4));
    const user = `[Episode]
${title}

[Script]
${script}

[Characters]
${characters.length ? characters.join("、") : "无"}

[Scenes]
${scenes.length ? scenes.join("、") : "无"}

[Props]
${props.length ? props.join("、") : "无"}

[Task]
Break the script above into exactly ${count} storyboards (about ±10%). Aspect ratio ${aspect}; visual style: ${style}.
Each storyboard is one narrative beat and may contain 1-4 internal cuts written as "Shot 1 ... Cut to Shot 2 ...".
Prefer dynamic camera movement; keep static shots below 20%.
Keep the script's spoken lines verbatim; do not invent new dialogue.
Return ONLY the JSON array.`;
    return [
        { role: "system" as const, content: FACTORY_STORYBOARD_SYSTEM },
        { role: "user" as const, content: user },
    ];
}

export function buildBeatExtractionMessages(options: { script: string; title: string; characters: string[]; scenes: string[]; props: string[] }) {
    const { script, title, characters, scenes, props } = options;
    const user = `[Episode]
${title}

[Script]
${script}

[Characters]
${characters.length ? characters.join("、") : "无"}

[Scenes]
${scenes.length ? scenes.join("、") : "无"}

[Props]
${props.length ? props.join("、") : "无"}

[Task]
把上面的剧本拆成按顺序排列的原子 beats。覆盖全部剧情；关键旁白转 inner 或 action；无用旁白省略；台词和系统提示保留原话。只输出 JSON 对象。`;
    return [
        { role: "system" as const, content: BEAT_EXTRACTION_SYSTEM },
        { role: "user" as const, content: user },
    ];
}

export function buildScreenplayAdaptationMessages(options: { script: string; title: string; characters: string[]; scenes: string[]; props: string[]; adaptationLevel?: "locked" | "performance" | "structural"; segmentSeconds?: number }) {
    const { script, title, characters, scenes, props, adaptationLevel = "performance", segmentSeconds = 15 } = options;
    const user = `[Adaptation level]
${adaptationLevel}

[Episode]
${title}

[Script]
${script}

[Characters]
${characters.length ? characters.join("、") : "无"}

[Scenes]
${scenes.length ? scenes.join("、") : "无"}

[Props]
${props.length ? props.join("、") : "无"}

[Task]
把上面的原文整理成可拍摄的中文表演剧本。覆盖本次原文；台词逐字保留；叙述、心理和舞台说明改写成可见动作；非声音叙述不自动变旁白；动机/前因解释用动作演；每个 beat 尽量带 source_quote；不写景别/机位。单句台词自然朗读不要超过 ${segmentSeconds} 秒；超过的按句/分句拆成多个顺序 beat（逐字不删、不改语义、不改主人）。只输出 JSON 对象。`;
    return [
        { role: "system" as const, content: SCREENPLAY_ADAPTATION_SYSTEM },
        { role: "user" as const, content: user },
    ];
}

export function buildShotPlanMessages(options: { beats: DramaBeat[]; style: string; aspect: string; targetShots?: number; characters: string[]; scenes: string[]; props: string[] }) {
    const { beats, style, aspect, targetShots = 0, characters, scenes, props } = options;
    const countHint = targetShots > 0 ? `Target shot count hint: ${targetShots}（只是提示，覆盖优先）。` : "镜头数由 beats 和 10–15s 目标推导，覆盖优先。";
    const compactBeats = beats.map(({ id, type, key, location, time, summary, speaker, text, estSeconds }) => ({ id, type, key, location, time, summary, speaker, text, estSeconds }));
    const user = `[Beats]
${JSON.stringify(compactBeats)}

[Style]
${style}
[Aspect]
${aspect}

[Characters]
${characters.length ? characters.join("、") : "无"}

[Scenes]
${scenes.length ? scenes.join("、") : "无"}

[Props]
${props.length ? props.join("、") : "无"}

[Task]
把上面的 beats 按顺序分组成 shots。每个 beat 必须被且只被覆盖一次；目标每镜 10–15s，最大 25s；独立事件不要硬合并。${countHint}只输出 JSON 对象。`;
    return [
        { role: "system" as const, content: SHOT_PLAN_SYSTEM },
        { role: "user" as const, content: user },
    ];
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function dialogueLinesOf(dialogue: string): string[] {
    return String(dialogue || "")
        .split(/\n+/)
        .flatMap((line) => line.split(/(?<=[。！？…；])/))
        .map((line) => line.trim())
        .filter(Boolean);
}

// 生成时长上下限镜像平台 VIDEO_SECONDS_MIN/MAX（lib/media-size.ts = 2/30）；单镜上限取 25，>15 由 expandShotsForVideo 拆成 ≤15s 生成段。本文件保持自包含可独立 bundle。
const GEN_MIN_SECONDS = 2;
const GEN_MAX_SECONDS = 25;
// 自然中文语速：工作台 3–4.5 字/秒、知识库 4–6 字/秒，取偏自然值。
const SPEECH_CHARS_PER_SECOND = 4.5;

function charSeconds(line: string): number {
    return line.replace(/\s/g, "").length / SPEECH_CHARS_PER_SECOND + 0.4;
}

function dialogueSpeechSeconds(lines: DramaDialogueLine[]): number {
    return lines.reduce((sum, line) => {
        const seconds = line.text.replace(/\s/g, "").length / SPEECH_CHARS_PER_SECOND;
        return sum + (line.channel === "system" ? Math.min(2, seconds) : seconds);
    }, 0);
}

function actionPartsOf(action: string): string[] {
    const parts = String(action || "")
        .split(/Cut to Shot\s*\d+\s*[:：,，]?\s*/i)
        .map((part) => part.trim())
        .filter(Boolean);
    return parts.length ? parts : [String(action || "").trim()];
}

// 把一个含多切镜/长台词的 beat 展开成多个 ≤hardMax 秒的子分镜，台词逐句保留、不丢不叠。
// 能装进 hardMax（默认 25s）的 beat 保持一张卡；只有超长才拆。
export function estimateShotSeconds(shot: DramaStoryboardShot): number {
    return Math.max(GEN_MIN_SECONDS, Math.min(GEN_MAX_SECONDS, rawShotSeconds(shot)));
}

function rawShotSeconds(shot: DramaStoryboardShot): number {
    const lines = dialogueLinesOf(shot.dialogue);
    const parts = actionPartsOf(shot.action);
    const dialogueSec = lines.reduce((sum, line) => sum + charSeconds(line), 0);
    const actionChars = parts.join("").replace(/\s/g, "").length;
    // 动作时长按描述信息量连续估算（约 10 字/秒，启发式）并与切镜数取大，夹 2–12s；避免单动作镜被粗公式压成 3s。
    const actionSec = Math.max(2, Math.min(12, Math.max(parts.length * 2, actionChars / 10)));
    // 先声后画：动作与台词并行（同步动作不重复累加），段长取两者较长者 + 0.5s 气口；真顺序动作由 Agent 拆成不同镜。
    const content = Math.ceil(Math.max(dialogueSec, actionSec) + 0.5);
    // 内容驱动：以内容估算为主，LLM duration 只允许往下修，不允许抬高凑长。
    const llm = shot.duration && shot.duration > 0 ? Math.round(shot.duration) : null;
    return llm != null ? Math.min(content, llm) : content;
}

export function expandShotsForVideo(shots: DramaStoryboardShot[], hardMax = 15): DramaStoryboardShot[] {
    const out: DramaStoryboardShot[] = [];
    for (const shot of shots) {
        const sec = rawShotSeconds(shot);
        if (sec <= hardMax) {
            out.push(shot);
            continue;
        }
        // 不可切割的连续 inner：单一句内心 + 无动作切镜，最多放到 GEN_MAX_SECONDS，不按 15s 硬拆。
        const rows = String(shot.dialogue || "").split(/\n+/).map((row) => row.trim()).filter(Boolean);
        const singleInner = rows.length === 1 && /^\[(内心|inner)\]/i.test(rows[0]);
        const noActionCuts = actionPartsOf(shot.action).length <= 1;
        if (singleInner && noActionCuts && sec <= hardMax) {
            out.push(shot);
            continue;
        }
        const lines = String(shot.dialogue || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const parts = actionPartsOf(shot.action);
        let lineIdx = 0;
        let segParts: string[] = [];
        let segLines: string[] = [];
        let segActionSec = 0;
        let segDialogueSec = 0;
        const flush = () => {
            if (!segParts.length && !segLines.length) return;
            const segDuration = Math.max(GEN_MIN_SECONDS, Math.min(GEN_MAX_SECONDS, Math.ceil(Math.max(segActionSec, segDialogueSec))));
            out.push({
                ...shot,
                action: segParts.join("；") || (segLines.length ? dialogueOnlyAction(segLines[0]) : ""),
                dialogue: segLines.join("\n"),
                title: `${shot.title}·${out.length + 1}`,
                result: shot.result,
                duration: segDuration,
                beatIds: shot.beatIds,
                cutPoints: undefined,
                splitReason: segDuration > hardMax ? "单句超长/不可切，按整段保留" : undefined,
            });
            segParts = [];
            segLines = [];
            segActionSec = 0;
            segDialogueSec = 0;
        };
        for (let p = 0; p < parts.length; p += 1) {
            if (segActionSec + 2.5 > hardMax && (segParts.length || segLines.length)) flush();
            segParts.push(parts[p]);
            segActionSec += 2.5;
            while (lineIdx < lines.length) {
                const need = charSeconds(lines[lineIdx]);
                if (segDialogueSec + need > hardMax && (segParts.length || segLines.length)) break;
                segLines.push(lines[lineIdx]);
                lineIdx += 1;
                segDialogueSec += need;
            }
        }
        while (lineIdx < lines.length) {
            const need = charSeconds(lines[lineIdx]);
            if (segDialogueSec + need > hardMax && (segParts.length || segLines.length)) flush();
            segLines.push(lines[lineIdx]);
            lineIdx += 1;
            segDialogueSec += need;
        }
        flush();
    }
    return out.filter((shot) => shot.action || shot.dialogue).map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
}

// 生成段打包：把相邻同场景/同段落的短镜合并成 ≤15s 生成段（内部用 Cut to Shot 切镜），
// 减少独立生成次数并保连续性；不强制下限，单镜可短。对齐工作台“一次生成 ≠ 一个剪辑镜头”。
export function elasticPackShots(shots: DramaStoryboardShot[], segmentSeconds = 15): DramaStoryboardShot[] {
    const units = expandShotsForVideo(shots, segmentSeconds);
    const keyOf = (s: DramaStoryboardShot) => `${s.location || ""}|${s.segmentIndex}|${s.time || ""}`;
    const groups: { key: string; sec: number; items: DramaStoryboardShot[] }[] = [];
    let cur: { key: string; sec: number; items: DramaStoryboardShot[] } | null = null;
    for (const unit of units) {
        const sec = rawShotSeconds(unit);
        if (cur && cur.key === keyOf(unit) && cur.sec + sec <= segmentSeconds) {
            cur.items.push(unit);
            cur.sec += sec;
        } else {
            if (cur) groups.push(cur);
            cur = { key: keyOf(unit), sec, items: [unit] };
        }
    }
    if (cur) groups.push(cur);
    let cursor = 0;
    return groups.map((group, index) => {
        const duration = Math.round(group.sec);
        const start = cursor;
        const end = cursor + duration;
        cursor = end;
        if (group.items.length === 1) return { ...group.items[0], shotNumber: index + 1, start, end, duration, title: group.items[0].segmentTitle || group.items[0].title };
        const first = group.items[0];
        const last = group.items[group.items.length - 1];
        const actions = group.items.map((u) => u.action).filter(Boolean);
        const results = group.items.map((u) => u.result).filter(Boolean);
        const cutPoints: string[] = [...group.items.flatMap((u) => u.cutPoints || [])];
        let cum = 0;
        group.items.forEach((u, i) => {
            cum += rawShotSeconds(u);
            if (i < group.items.length - 1) cutPoints.push(`At 00:${String(Math.round(cum)).padStart(2, "0")}.000`);
        });
        const emotion = first.emotion && last.emotion && first.emotion !== last.emotion ? `${first.emotion}→${last.emotion}` : first.emotion;
        return {
            ...first,
            shotNumber: index + 1,
            start,
            end,
            title: `${first.segmentTitle || first.title}·合`,
            action: actions.join("；"),
            dialogue: group.items.map((u) => u.dialogue).filter(Boolean).join("\n"),
            result: results.length ? results[results.length - 1] : "",
            duration,
            beatIds: [...new Set(group.items.flatMap((u) => u.beatIds || []))],
            cutPoints,
            emotion,
            emotionIntensity: Math.max(...group.items.map((u) => u.emotionIntensity || 0)),
            entryState: first.entryState,
            exitState: last.exitState,
        };
    });
}

export function normalizeFactoryStoryboards(raw: unknown): DramaStoryboardShot[] {
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { storyboards?: unknown[] })?.storyboards)
          ? ((raw as { storyboards: unknown[] }).storyboards as unknown[])
          : [];
    return list
        .map((item, index) => {
            const shot = (item || {}) as Record<string, unknown>;
            return {
                shotNumber: Math.round(num(shot.shot_number ?? shot.storyboard_number, index + 1)),
                title: text(shot.title) || `分镜 ${index + 1}`,
                segmentIndex: Math.round(num(shot.segment_index, 0)),
                segmentTitle: text(shot.segment_title),
                location: text(shot.location),
                time: text(shot.time),
                shotType: text(shot.shot_type),
                cameraAngle: text(shot.camera_angle),
                cameraMovement: text(shot.camera_movement),
                lightingStyle: text(shot.lighting_style),
                depthOfField: text(shot.depth_of_field),
                action: text(shot.action),
                result: text(shot.result),
                dialogue: text(shot.dialogue),
                emotion: text(shot.emotion),
                emotionIntensity: Math.round(num(shot.emotion_intensity, 0)),
                duration: num(shot.duration, 0) > 0 ? Math.round(num(shot.duration, 0)) : undefined,
                beatIds: textList(shot.beat_ids ?? shot.beatIds),
                cutPoints: textList(shot.cut_points ?? shot.cutPoints),
                splitReason: text(shot.split_reason ?? shot.splitReason) || undefined,
                entryState: text(shot.entry_state ?? shot.entryState) || undefined,
                exitState: text(shot.exit_state ?? shot.exitState) || undefined,
                cameraPurpose: text(shot.camera_purpose ?? shot.cameraPurpose) || undefined,
            };
        })
        .filter((shot) => shot.action || shot.dialogue || shot.title)
        .sort((a, b) => a.shotNumber - b.shotNumber);
}

function textList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const list = value.map((item) => text(item)).filter(Boolean);
    return list.length ? list : undefined;
}

export function normalizeBeats(raw: unknown): DramaBeat[] {
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const source = Array.isArray(raw) ? raw : Array.isArray(data.beats) ? data.beats : [];
    const allowed: DramaBeatType[] = ["action", "dialogue", "inner", "system", "transition"];
    const used = new Set<string>();
    const normalized = source.map((item, index) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const rawType = text(record.type);
        const speaker = text(record.speaker);
        const body = text(record.text) || text(record.summary) || text(record.description);
        const summary = text(record.summary) || body || text(record.action);
        const coercedType: DramaBeatType = rawType === "narration" || rawType === "voiceover"
            ? "action"
            : allowed.includes(rawType as DramaBeatType) ? (rawType as DramaBeatType) : "action";
        let id = text(record.id) || `b${index + 1}`;
        while (used.has(id)) id = `${id}-${index + 1}`;
        used.add(id);
        const chars = body.replace(/\s/g, "").length;
        const guessed = Math.max(2, Math.min(8, Math.ceil(chars / SPEECH_CHARS_PER_SECOND)));
        const estSeconds = Math.max(1, Math.min(12, Math.round(num(record.est_seconds ?? record.estSeconds ?? record.duration, guessed) || guessed)));
        return {
            id,
            type: coercedType,
            key: record.key === true || record.key === "true",
            location: text(record.location),
            time: text(record.time),
            summary,
            speaker: speaker || undefined,
            text: body || undefined,
            estSeconds,
        };
    }).filter((beat) => beat.summary || beat.text);
    const merged: DramaBeat[] = [];
    for (const beat of normalized) {
        const prev = merged[merged.length - 1];
        if (prev && prev.type === "inner" && beat.type === "inner" && prev.speaker === beat.speaker && (!prev.location || !beat.location || prev.location === beat.location)) {
            prev.summary = [prev.summary, beat.summary].filter(Boolean).join("；");
            prev.text = [prev.text, beat.text].filter(Boolean).join(" ");
            prev.estSeconds = Math.min(12, prev.estSeconds + beat.estSeconds);
            prev.key = prev.key || beat.key;
            continue;
        }
        merged.push(beat);
    }
    const innerCap = Math.max(1, Math.ceil(merged.length * 0.25));
    let innerKept = 0;
    for (const beat of merged) {
        if (beat.type !== "inner") continue;
        innerKept += 1;
        if (innerKept > innerCap && !beat.key) beat.type = "action";
    }
    return merged;
}

export function normalizeScreenplay(raw: unknown, script: string): { screenplay: DramaScreenplay; beats: DramaBeat[]; warnings: string[] } {
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const rawLevel = text(data.level);
    const level: DramaScreenplayLevel = rawLevel === "locked" || rawLevel === "structural" ? rawLevel : "performance";
    const rawScenes = Array.isArray(data.scenes) ? data.scenes : [];
    const usedSceneIds = new Set<string>();
    const scenes: DramaScreenplayScene[] = rawScenes.map((item, index) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        let id = text(record.id) || `s${index + 1}`;
        while (usedSceneIds.has(id)) id = `${id}-${index + 1}`;
        usedSceneIds.add(id);
        return { id, heading: text(record.heading) || `场景 ${index + 1}`, description: text(record.description) || undefined };
    });
    if (!scenes.length) scenes.push({ id: "s1", heading: "场景 1" });
    const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
    const compactScript = String(script || "").replace(/\s/g, "");
    const warnings: string[] = [];
    const rawBeats = Array.isArray(data.beats) ? data.beats : [];
    const rawUnitList = Array.isArray(data.source_units) ? data.source_units : Array.isArray(data.sourceUnits) ? data.sourceUnits : [];
    const rawUnits: DramaSourceUnit[] = rawUnitList.map((item, index) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
            id: text(record.id) || `u${index + 1}`,
            text: text(record.text),
            kind: text(record.kind) || undefined,
            epistemic: text(record.epistemic) || undefined,
            required: record.required === true || record.required === "true",
        };
    }).filter((unit) => unit.text);
    const beats: DramaScreenplayBeat[] = [];
    const flattened: DramaBeat[] = [];
    for (const item of rawBeats) {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        let sceneId = text(record.scene_id ?? record.sceneId);
        if (!sceneById.has(sceneId)) {
            if (sceneId) warnings.push(`beat ${text(record.id) || "?"} 引用了未知场景 ${sceneId}`);
            sceneId = scenes[0].id;
        }
        const action = text(record.action);
        const sourceQuote = text(record.source_quote ?? record.sourceQuote);
        if (sourceQuote && !compactScript.includes(sourceQuote.replace(/\s/g, ""))) {
            warnings.push(`source_quote 不在原文：${sourceQuote.slice(0, 24)}`);
        }
        const dialogue = toDialogueLines(record.dialogue);
        if (!action && !dialogue.length) continue;
        const id = text(record.id) || `e${beats.length + 1}`;
        const sourceUnitIds = textList(record.source_unit_ids ?? record.sourceUnitIds) || [];
        beats.push({ id, sceneId, action, sourceQuote: sourceQuote || undefined, dialogue, sourceUnitIds: sourceUnitIds.length ? sourceUnitIds : undefined });
        const location = sceneById.get(sceneId)?.heading || "";
        if (action) {
            flattened.push({
                id: `${id}-a`,
                type: "action",
                key: false,
                location,
                time: "",
                summary: action,
                estSeconds: Math.max(2, Math.min(8, Math.ceil(action.replace(/\s/g, "").length / SPEECH_CHARS_PER_SECOND))),
                sourceQuote: sourceQuote || undefined,
            });
        }
        dialogue.forEach((line, index) => {
            const parts = splitDialogueParts(line.text);
            parts.forEach((part, partIndex) => {
                flattened.push({
                    id: parts.length > 1 ? `${id}-d${index + 1}-${partIndex + 1}` : `${id}-d${index + 1}`,
                    type: line.channel === "spoken" ? "dialogue" : line.channel,
                    key: false,
                    location,
                    time: "",
                    summary: `${line.speaker}：${part}`,
                    speaker: line.speaker,
                    text: part,
                    estSeconds: Math.max(2, Math.min(25, Math.ceil(part.replace(/\s/g, "").length / SPEECH_CHARS_PER_SECOND) + 1)),
                    sourceQuote: sourceQuote || undefined,
                });
            });
        });
    }
    let coverage: DramaScreenplayCoverage | undefined;
    if (rawUnits.length) {
        const referenced = new Set(beats.flatMap((beat) => beat.sourceUnitIds || []));
        const uncovered = rawUnits.filter((unit) => !referenced.has(unit.id)).map((unit) => ({ id: unit.id, text: unit.text.slice(0, 40) }));
        const requiredMissing = rawUnits.filter((unit) => unit.required && !referenced.has(unit.id)).map((unit) => ({ id: unit.id, text: unit.text.slice(0, 40) }));
        coverage = { total: rawUnits.length, covered: rawUnits.length - uncovered.length, uncovered, requiredMissing };
        if (uncovered.length) warnings.push(`${uncovered.length} 个 source_unit 未被 beat 引用`);
        if (requiredMissing.length) warnings.push(`required 关键事件未覆盖：${requiredMissing.map((unit) => unit.id).join("、")}`);
        const foreign = rawUnits.filter((unit) => !compactScript.includes(unit.text.replace(/\s/g, "")));
        if (foreign.length) warnings.push(`${foreign.length} 个 source_unit.text 不在原文`);
    }
    const paragraphs = String(script || "").split(/\n+/).map((line) => line.replace(/\s/g, "")).filter((line) => line.length >= 20);
    if (!rawUnits.length && paragraphs.length && beats.length) {
        const quotes = beats.map((beat) => beat.sourceQuote?.replace(/\s/g, "")).filter(Boolean) as string[];
        const uncovered = paragraphs.filter((paragraph) => !quotes.some((quote) => quote.includes(paragraph) || paragraph.includes(quote))).length;
        if (uncovered) warnings.push(`${uncovered} 段原文没有直接 source_quote（仅提示，不阻断）`);
    }
    return { screenplay: { level, logline: text(data.logline) || undefined, scenes, beats, sourceUnits: rawUnits.length ? rawUnits : undefined, coverage }, beats: flattened, warnings };
}

function toDialogueLines(value: unknown): DramaDialogueLine[] {
    const lines = Array.isArray(value)
        ? value.map((item) => {
            const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
            const speaker = text(record.speaker);
            const rawChannel = text(record.channel).toLowerCase();
            const channel: DramaDialogueChannel = rawChannel === "inner"
                ? "inner"
                : rawChannel === "system" || rawChannel === "off_screen"
                  ? "system"
                  : rawChannel === "narration" || rawChannel === "voiceover"
                    ? speaker ? "inner" : "system"
                    : "spoken";
            return { speaker: speaker || (channel === "system" ? "系统" : "角色"), channel, text: text(record.text) };
        }).filter((line) => line.text)
        : parseDialogueLines(text(value));
    return lines;
}

export function parseDialogueLines(dialogue: string): DramaDialogueLine[] {
    return String(dialogue || "").split(/\n+/).map((raw) => {
        const line = raw.trim();
        if (!line) return null;
        const match = line.match(/^\[(台词|内心|画外|系统|spoken|inner|system)\]\s*([^：:]*)[：:]?\s*([\s\S]*)$/i);
        if (!match) {
            const speakerMatch = line.match(/^([^：:]{1,20})[：:]\s*([\s\S]*)$/);
            return { speaker: speakerMatch?.[1]?.trim() || "角色", channel: "spoken" as const, text: (speakerMatch?.[2] || line).trim() };
        }
        const tag = match[1].toLowerCase();
        const channel: DramaDialogueChannel = tag === "内心" || tag === "inner" ? "inner" : tag === "画外" || tag === "系统" || tag === "system" ? "system" : "spoken";
        return { speaker: match[2]?.trim() || (channel === "system" ? "系统" : "角色"), channel, text: match[3].trim() };
    }).filter((line): line is DramaDialogueLine => Boolean(line?.text));
}

export function serializeDialogueLines(lines: DramaDialogueLine[]): string {
    return lines.map((line) => `[${line.channel === "inner" ? "内心" : line.channel === "system" ? "画外" : "台词"}] ${line.speaker || (line.channel === "system" ? "系统" : "角色")}：${line.text}`).join("\n");
}

function dialogueOnlyAction(line: string): string {
    const match = String(line).match(/^\[(台词|内心|画外|系统|spoken|inner|system)\]\s*([^：:]*)[：:]?/i);
    const tag = (match?.[1] || "台词").toLowerCase();
    const speaker = (match?.[2] || "").trim() || "角色";
    if (tag === "内心" || tag === "inner") return `${speaker}神色微动（内心低语）`;
    if (tag === "画外" || tag === "系统" || tag === "system") return "画外或系统声响起";
    return `${speaker}开口说话`;
}

function splitDialogueParts(value: string): string[] {
    const clean = value.trim();
    if (!clean) return [];
    if (clean.replace(/\s/g, "").length <= 100) return [clean];
    const sentences = (clean.match(/[^。！？…；]+[。！？…；]?/g) || [clean]).map((part) => part.trim()).filter(Boolean);
    const parts: string[] = [];
    for (const sentence of sentences) {
        if (sentence.replace(/\s/g, "").length <= 100) parts.push(sentence);
        else for (let i = 0; i < sentence.length; i += 100) parts.push(sentence.slice(i, i + 100));
    }
    return parts.length ? parts : [clean];
}

export function normalizeShotPlan(raw: unknown, beats: DramaBeat[]): DramaShotPlan[] {
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const source = Array.isArray(raw) ? raw : Array.isArray(data.shots) ? data.shots : [];
    const shots = source.map((item, index) => {
        const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
            id: text(record.id) || `s${index + 1}`,
            beatIds: textList(record.beat_ids ?? record.beatIds) || [],
            segmentIndex: Math.round(num(record.segment_index ?? record.segmentIndex, 0)),
            segmentTitle: text(record.segment_title ?? record.segmentTitle),
            location: text(record.location),
            time: text(record.time),
            duration: Math.max(GEN_MIN_SECONDS, Math.min(GEN_MAX_SECONDS, Math.round(num(record.duration, 6)) || 6)),
            shotType: text(record.shot_type ?? record.shotType) || "MS",
            cameraAngle: text(record.camera_angle ?? record.cameraAngle) || "eye level",
            cameraMovement: text(record.camera_movement ?? record.cameraMovement) || "static",
            lightingStyle: text(record.lighting_style ?? record.lightingStyle) || "natural",
            depthOfField: text(record.depth_of_field ?? record.depthOfField) || "medium",
            action: text(record.action),
            result: text(record.result),
            dialogue: toDialogueLines(record.dialogue),
            emotion: text(record.emotion),
            emotionIntensity: Math.max(-1, Math.min(3, Math.round(num(record.emotion_intensity ?? record.emotionIntensity, 0)))),
            cutPoints: textList(record.cut_points ?? record.cutPoints),
            splitReason: text(record.split_reason ?? record.splitReason) || undefined,
            entryState: text(record.entry_state ?? record.entryState) || undefined,
            exitState: text(record.exit_state ?? record.exitState) || undefined,
            cameraPurpose: text(record.camera_purpose ?? record.cameraPurpose) || undefined,
        };
    }).filter((shot) => shot.action || shot.result || shot.dialogue.length);
    const merged: DramaShotPlan[] = [];
    for (const shot of shots) {
        const prev = merged[merged.length - 1];
        const innerOnly = shot.dialogue.length > 0 && shot.dialogue.every((line) => line.channel === "inner");
        const prevInnerOnly = Boolean(prev && prev.dialogue.length > 0 && prev.dialogue.every((line) => line.channel === "inner"));
        const sameSpeaker = !prev || !prev.dialogue[0]?.speaker || !shot.dialogue[0]?.speaker || prev.dialogue[0]?.speaker === shot.dialogue[0]?.speaker;
        const sameBeatFlow = Boolean(prev) && (!prev.action || !shot.action || prev.action === shot.action || prev.action.includes(shot.action) || shot.action.includes(prev.action));
        if (prev && innerOnly && prevInnerOnly && sameSpeaker && sameBeatFlow && prev.duration + shot.duration <= 25 && (!prev.location || !shot.location || prev.location === shot.location)) {
            prev.beatIds = [...prev.beatIds, ...shot.beatIds];
            prev.dialogue = [...prev.dialogue, ...shot.dialogue];
            prev.action = [prev.action, shot.action].filter(Boolean).join("；");
            prev.result = shot.result || prev.result;
            prev.duration = Math.min(25, prev.duration + shot.duration);
            prev.splitReason = prev.duration > 15 ? "连续内心合并" : prev.splitReason;
            continue;
        }
        merged.push(shot);
    }
    return merged;
}

export function validateStoryboardPlan(shots: DramaShotPlan[], beats: DramaBeat[], segmentSeconds = 15): { ok: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const counts = new Map<string, number>();
    beats.forEach((beat) => counts.set(beat.id, 0));
    shots.forEach((shot, index) => {
        const label = `镜头 ${index + 1}`;
        if (!shot.beatIds.length) errors.push(`${label} 没有 beat_ids`);
        shot.beatIds.forEach((id) => {
            if (!counts.has(id)) errors.push(`${label} 引用了未知 beat ${id}`);
            else counts.set(id, (counts.get(id) || 0) + 1);
        });
        if (shot.duration > GEN_MAX_SECONDS) errors.push(`${label} 时长 ${shot.duration}s 超过 ${GEN_MAX_SECONDS}s`);
        if (shot.duration > segmentSeconds && !(shot.cutPoints?.length || shot.splitReason)) errors.push(`${label} 超过 ${segmentSeconds}s 但没有切点或拆分理由`);
        if (!shot.action) errors.push(`${label} 缺少 action`);
        if (!shot.result) errors.push(`${label} 缺少 result`);
        if (!shot.shotType || !shot.cameraAngle || !shot.cameraMovement || !shot.lightingStyle || !shot.depthOfField) errors.push(`${label} 镜头字段不完整`);
        if (!/static/i.test(shot.cameraMovement) && !shot.cameraPurpose) warnings.push(`${label} 非 static 镜缺少 camera_purpose（运镜叙事理由）`);
        if (!shot.entryState || !shot.exitState) warnings.push(`${label} 缺少 entry_state/exit_state（连续性）`);
        shot.dialogue.forEach((line, lineIndex) => {
            if (!line.text) errors.push(`${label} 台词 ${lineIndex + 1} 为空`);
            if ((line.channel === "inner" || line.channel === "system") && !line.speaker) errors.push(`${label} ${line.channel} 台词缺少说话人或来源`);
            const lineChars = line.text.replace(/\s/g, "").length;
            const lineSec = line.channel === "system" ? Math.min(2, lineChars / SPEECH_CHARS_PER_SECOND) : lineChars / SPEECH_CHARS_PER_SECOND;
            if (lineSec > segmentSeconds) warnings.push(`${label} 台词${lineIndex + 1}约 ${Math.ceil(lineSec)}s 超过段长 ${segmentSeconds}s，建议在剧本层按句拆分`);
        });
        const speechSeconds = dialogueSpeechSeconds(shot.dialogue);
        if (speechSeconds > 0 && shot.duration < Math.ceil(speechSeconds + 0.5)) errors.push(`${label} 时长 ${shot.duration}s 装不下约 ${Math.ceil(speechSeconds)}s 的台词（需留 0.5s 呼吸）`);
    });
    beats.forEach((beat) => {
        const count = counts.get(beat.id) || 0;
        if (count === 0) errors.push(`beat ${beat.id} 未被覆盖`);
        if (count > 1) errors.push(`beat ${beat.id} 被重复覆盖 ${count} 次`);
    });
    return { ok: errors.length === 0, errors, warnings };
}

export function sanityCheckPackedShots(shots: DramaStoryboardShot[]): string[] {
    const issues: string[] = [];
    shots.forEach((shot, index) => {
        const label = `卡 ${index + 1}`;
        if (!shot.action && !shot.dialogue) issues.push(`${label} 无动作也无台词`);
        if ((shot.duration || 0) > GEN_MAX_SECONDS) issues.push(`${label} 时长 ${shot.duration}s 超 ${GEN_MAX_SECONDS}s`);
    });
    return issues;
}

export function fallbackBeatsFromScript(script: string): DramaBeat[] {
    const paragraphs = String(script || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const beats: DramaBeat[] = [];
    let actionBuffer: string[] = [];
    let actionChars = 0;
    const push = (beat: Omit<DramaBeat, "id">) => beats.push({ ...beat, id: `b${beats.length + 1}` });
    const flushAction = () => {
        if (!actionBuffer.length) return;
        const summary = actionBuffer.join("；");
        const estSeconds = Math.max(2, Math.min(6, Math.ceil(summary.replace(/\s/g, "").length / 12)));
        push({ type: "action", key: false, location: "", time: "", summary, estSeconds });
        actionBuffer = [];
        actionChars = 0;
    };
    for (const paragraph of paragraphs) {
        const quotes = [...paragraph.matchAll(/[“"]([^”"]+)[”"]/g)].map((match) => match[1].trim()).filter(Boolean);
        const withoutQuotes = paragraph.replace(/[“"][^”"]*[”"]/g, "").replace(/[，。；、\s]+/g, " ").trim();
        if (withoutQuotes) {
            actionBuffer.push(withoutQuotes);
            actionChars += withoutQuotes.length;
            if (actionChars >= 60) flushAction();
        }
        if (quotes.length) {
            flushAction();
            for (const line of quotes) {
                const parts = splitDialogueParts(line);
                for (const part of parts) {
                    push({ type: "dialogue", key: false, location: "", time: "", summary: `角色说：${part}`, speaker: "角色", text: part, estSeconds: Math.max(2, Math.min(25, Math.ceil(part.length / SPEECH_CHARS_PER_SECOND) + 1)) });
                }
            }
        }
        if (beats.length >= 500) break;
    }
    flushAction();
    return beats;
}

export function fallbackShotPlan(beats: DramaBeat[], segmentSeconds = 15): DramaShotPlan[] {
    const shots: DramaShotPlan[] = [];
    let current: DramaBeat[] = [];
    let seconds = 0;
    const flush = () => {
        if (!current.length) return;
        const first = current[0];
        const last = current[current.length - 1];
        const dialogue = current.flatMap((beat) => beat.text ? [{
            speaker: beat.speaker || (beat.type === "system" ? "系统" : "角色"),
            channel: (beat.type === "inner" ? "inner" : beat.type === "system" ? "system" : "spoken") as DramaDialogueChannel,
            text: beat.text,
        }] : []);
        const speechSeconds = dialogueSpeechSeconds(dialogue);
        const duration = Math.max(GEN_MIN_SECONDS, Math.min(GEN_MAX_SECONDS, Math.max(Math.round(seconds), Math.ceil(speechSeconds + 0.5))));
        shots.push({
            id: `s${shots.length + 1}`,
            beatIds: current.map((beat) => beat.id),
            segmentIndex: 0,
            segmentTitle: first.location || `分镜 ${shots.length + 1}`,
            location: first.location,
            time: first.time,
            duration,
            shotType: "MS",
            cameraAngle: "eye level",
            cameraMovement: "static",
            lightingStyle: "natural",
            depthOfField: "medium",
            action: current.map((beat) => beat.summary).join("；"),
            result: last.summary,
            dialogue,
            emotion: "",
            emotionIntensity: 0,
            cutPoints: [],
            splitReason: duration > segmentSeconds ? "长台词/连续动作，无法再切" : "",
        });
        current = [];
        seconds = 0;
    };
    for (const beat of beats) {
        const want = Math.max(2, Math.min(15, beat.estSeconds));
        if (current.length && seconds + want > 15) flush();
        current.push(beat);
        seconds += want;
    }
    flush();
    return shots;
}

export function repairStoryboardPlan(shots: DramaShotPlan[], segmentSeconds = 15): DramaShotPlan[] {
    return shots.map((shot) => {
        const speechSeconds = dialogueSpeechSeconds(shot.dialogue);
        const duration = Math.max(GEN_MIN_SECONDS, Math.min(GEN_MAX_SECONDS, Math.max(shot.duration, Math.ceil(speechSeconds + 0.5))));
        return {
            ...shot,
            duration,
            splitReason: duration > segmentSeconds && !shot.splitReason ? "台词时长需要，按连续镜头保留" : shot.splitReason,
        };
    });
}

export function planToShots(plan: DramaShotPlan[]): DramaStoryboardShot[] {
    return plan.map((shot, index) => ({
        id: shot.id,
        shotNumber: index + 1,
        title: shot.action.slice(0, 16) || shot.segmentTitle || `分镜 ${index + 1}`,
        segmentIndex: shot.segmentIndex,
        segmentTitle: shot.segmentTitle,
        location: shot.location,
        time: shot.time,
        shotType: shot.shotType,
        cameraAngle: shot.cameraAngle,
        cameraMovement: shot.cameraMovement,
        lightingStyle: shot.lightingStyle,
        depthOfField: shot.depthOfField,
        action: shot.action,
        result: shot.result,
        dialogue: serializeDialogueLines(shot.dialogue),
        emotion: shot.emotion,
        emotionIntensity: shot.emotionIntensity,
        duration: shot.duration,
        beatIds: shot.beatIds,
        cutPoints: shot.cutPoints,
        splitReason: shot.splitReason,
        entryState: shot.entryState,
        exitState: shot.exitState,
        cameraPurpose: shot.cameraPurpose,
    }));
}

export function buildRef2VAPrompt(
    shot: DramaStoryboardShot,
    refs: { name: string; kind: "character" | "scene" | "prop"; description?: string }[],
    style: string,
): string {
    const definitions = refs.length
        ? refs
              .map((ref, index) => {
                  const note =
                      ref.kind === "scene"
                          ? " (location, structures and lighting match this picture)"
                          : ref.kind === "prop"
                            ? " (the prop matches this picture)"
                            : " (costume, colors and accessories match this picture)";
                  return `<Picture ${index + 1}>: ${ref.name}${note}`;
              })
              .join("\n")
        : "<Picture 1>: the main subject";
    const visual = [shot.shotType, shot.cameraAngle, shot.location, shot.time, shot.action, shot.result].filter(Boolean).join("；");
    return `subject_definitions:
${definitions}

summary: A single continuous cinematic shot in ${style}.

retention_analysis: Keep every subject's face, hair and clothing identical to its reference picture; keep the location structure and light direction consistent.

detailed_description: ${visual || "the subject acts in the scene"}。Camera: ${shot.cameraMovement || "static"}. Lighting: ${shot.lightingStyle || "natural"}. Depth of field: ${shot.depthOfField || "medium"}. No subtitles, no captions, no watermarks; no background music.

overall_soundscape: Ambient wind, footsteps on stone, cloth movement and distant crowd; voices are present without any readable dialogue text. No background music.

non_diegetic_music: N/A`;
}

export const H3_PROMPT_SYSTEM = `You rewrite a Chinese storyboard shot description into a MiniMax H3 video prompt. Output ONLY the prompt text, no commentary.

Hard rules:
- Body in English. Dialogue stays Chinese inside <d>[Chinese] ... </d>, with stable speaker ids like (S1). Diegetic story text (plaques, stele ranks, letters, screens) is a physical prop, not a subtitle: keep it readable in the original Chinese, written as 'on-screen text in Chinese reads: <原文>' without a 'says' tag.
- If the shot has a first frame (and optional last frame), use the base-mode structure in this exact order:
  integrated_multimodal_description, overall_soundscape, non_diegetic_music.
  Start integrated_multimodal_description by anchoring the frame, e.g. "For the target video, at 0.00 seconds into the target video, <Picture 1> (the first frame) is fully referenced."
- If multiple reference images are the subject source (no keyframe), use the six-section Ref2VA structure in this exact order:
  subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.
- Camera: always describe type + amplitude + speed in a natural sentence; keep the given crane/push/pan intent.
- I2VA identity (first/last-frame mode only): name the protagonist in integrated_multimodal_description and state which person in <Picture 1> he is (screen position or a distinguishing trait); his face, hair, build and outfit come from <Picture 1>, which is the sole authority for costume and colors. Use the shot description for action and keep the canonical subject traits from the user message. In Ref2VA mode use subject_definitions and the reference list instead.
- Reference numbering: use only <Picture 1> through <Picture N> matching the reference pictures listed in the user message; never invent a picture number. Bind each <Subject N> to the picture that supplies its traits. If the user message lists no reference pictures (text-only), define subjects by text without inventing <Picture N>.
- Ref2VA outfit lock: in subject_definitions, bind each <Subject N> to its <Picture N> and state that the costume (color, cut, layers, accessories) matches that picture; retention_analysis records each subject and its costume as fully_preserved. The reference pictures are the sole authority for costume, colors and accessories; do not restate or invent colors from text descriptions.
- Attached reference pictures: when the user message includes pictures, they are the sole authority for appearance, costume, colors, scene and props. Describe what is visible in the pictures; do not invent details that are not present.
- Timing: keep the requested duration (2–15s) and describe the action cycle within it; no cuts unless the source asks for cuts, and if it does use "At 00:0X.000, the camera cuts to ...".
- Dialogue pacing: each <d> line gets its own sequential time window; two speakers never talk at the same time; leave a short gap between lines; budget about 4.5 Chinese characters per second so the last line finishes before the clip ends. If the lines cannot fit, spread them across the cuts with clear gaps and simplify the visual beats; never stack two voices in one window.
- Dialogue preservation: every line given in the shot's Dialogue field must appear verbatim as <d>[Chinese] (Sx) ...</d> in detailed_description, assigned to the correct speaker and a time window; do not omit, merge, or paraphrase lines. If the field is empty, add no spoken lines.
- Dialogue channels: lines may be tagged [台词]/[内心]/[画外] or spoken/inner/system. Spoken lines use lip-sync. Inner lines use the character's S id but lips remain completely closed, no lip-sync. System lines use SYS, no visible speaker, no lip-sync; a system line is a short notification cue plus a brief broadcast (about 1.5–2s), not a slow full read, and the 叮 cue counts once within the line. Never write a narrator or voiceover line.
- Speaker IDs and written text: give each speaking character a stable (S1), (S2)... and keep it consistent across the shot. Written messages, phone screens or letters stay written unless the user explicitly authorized voicing; do not auto-voice them. Read numbers naturally; split a long line at complete sentence boundaries, never mid-sentence.
- Camera rhythm: keep the source's fast/slow camera beats and cuts; do not flatten a fast beat into one slow continuous move. Keep at most three referenced subjects on screen; the rest stay background.
- Redundancy control: describe the establishing scene and each subject's look once per clip; later cuts reference them without re-describing; never repeat the same action or add a filler/redundant shot; match the clip length to the content so there is no padding.
- Positive phrasing only: no "no/not/without" negations in descriptive text; state the intended state instead. (Dialogue is exempt.)
- Character uniqueness (duplicate bodies): each shot contains exactly one instance of each character; write every body part with its owner.
- Keep each character's anchor object and left/right screen position identical from the first shot to the last shot of the segment; change them only when an explicit move from A to B is described.
- When one character carries the shot's featured action, a second person sharing the frame stands still at their own anchor.
- A person described by text alone is a separate body with visibly different build, hair, color temperature or stance from every referenced character.
- Actions happening behind a closed door or off-screen stay in overall_soundscape; the visual body only shows the visible physical result (the door vibrating, the latch rattling).
- overall_soundscape: ambience, physical sounds, voices; never repeat dialogue text; never add music.
- non_diegetic_music: always exactly "N/A" (we do not add background music).
- Always end the visual description (integrated_multimodal_description / detailed_description) with this exact sentence: "No subtitles, no captions, no watermarks; no background music." This negation is mandatory even though the rest of the text uses positive phrasing.
- Preserve every concrete fact: character look, scene, prop, light, action beats, emotion, aspect ratio.
- Keep the requested framing and aspect ratio from the shot description.`;

export function looksLikeH3Prompt(text: string) {
    return /integrated_multimodal_description|subject_definitions|retention_analysis|<d>\[/i.test(String(text || ""));
}

export function normalizeH3Prompt(raw: string, mode: "frames" | "reference", refCount = 0) {
    let repaired = String(raw || "").replace(/<(think|thinking|analysis|reasoning|scratchpad)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, "").trim();
    const firstField = repaired.search(/integrated_multimodal_description\s*:|subject_definitions\s*:/i);
    if (firstField > 0) repaired = repaired.slice(firstField);
    const headers = [...repaired.matchAll(/(?:integrated_multimodal_description|subject_definitions)\s*:/gi)];
    if (headers.length > 1 && headers[1].index > 0) repaired = repaired.slice(0, headers[1].index);
    const echo = repaired.search(/(?:^|\n)\s*(?:-{3,}\s*)?(?:用户任务|目标节点|任务模式|视频时长|首尾帧状态|可用引用|参考素材说明|用户需求|输出前(?:逐项)?自检|自检清单|第一行已经完成|<Picture\s*1>\s*是目标视频|目标视频在\s*0\.00\s*秒处)/i);
    if (echo > 0) repaired = repaired.slice(0, echo);
    if (!repaired) return "";
    if (refCount > 0) {
        const pictures = [...repaired.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1]));
        if (pictures.some((index) => !Number.isFinite(index) || index < 1 || index > refCount)) return "";
    }
    const required = mode === "reference" ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
    const missing = required.filter((section) => !new RegExp(`${section}\\s*[:：]`, "i").test(repaired));
    if (missing.some((section) => section !== "non_diegetic_music")) return "";
    if (missing.includes("non_diegetic_music")) repaired = `${repaired}\n\nnon_diegetic_music: N/A`;
    repaired = repaired.replace(/non_diegetic_music\s*[:：][^\n]*(?:\n(?!\s*\n)[^\n]*)*/i, "non_diegetic_music: N/A");
    if (!/no subtitles|no captions|no watermarks/i.test(repaired)) {
        const noText = "No subtitles, no captions, no watermarks; no background music.";
        repaired = /overall_soundscape\s*[:：]/i.test(repaired) ? repaired.replace(/(\n\s*overall_soundscape\s*[:：])/i, `\n${noText}\n$1`) : `${repaired}\n${noText}`;
    }
    if (!looksLikeH3Prompt(repaired) || repaired.length < 80) return "";
    return repaired.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildH3CompileMessages(options: {
    shot: DramaStoryboardShot;
    style: string;
    aspect: string;
    duration: number;
    mode: "frames" | "reference";
    refs?: { name: string; kind: "character" | "scene" | "prop"; description?: string }[];
    subjects?: { name: string; kind: "character" | "scene" | "prop"; description?: string; primary?: boolean }[];
    images?: string[];
}) {
    const { shot, style, aspect, duration, mode, refs = [], subjects = [], images = [] } = options;
    const modeHint =
        mode === "reference"
            ? "This shot uses multiple reference images (no keyframe): use the six-section Ref2VA structure."
            : "This shot uses a first frame (and maybe a last frame): use the base-mode three fields and anchor <Picture 1> as the first frame.";
    const refLines = refs.length
        ? refs
              .map((ref, index) => {
                  const role = ref.kind === "scene" ? " (location)" : "";
                  const note =
                      ref.kind === "scene"
                          ? " — the location, structures and lighting match this picture"
                          : ref.kind === "prop"
                            ? " — the prop matches this picture"
                            : " — the costume, colors and accessories match this picture";
                  return `<Picture ${index + 1}>: ${ref.name}${role}${note}`;
              })
              .join("\n")
        : mode === "frames"
          ? "<Picture 1>: the first frame"
          : "";
    const primary = subjects.find((subject) => subject.primary) || subjects[0];
    const subjectLines = subjects.length
        ? `Subjects in the first frame (canonical identity):\n${subjects
              .map((subject) => `- ${subject.name}${subject.primary ? " (protagonist)" : ""}${subject.description ? `: ${subject.description.slice(0, 220)}` : ""}`)
              .join("\n")}\nThe protagonist is ${primary?.name || "the main subject"}; in <Picture 1> he is the person matching these traits, and his face, hair, build and outfit come from the picture.`
        : "";
    const description = [
        `Style: ${style}`,
        `Aspect ratio: ${aspect}`,
        `Duration: ${duration}s`,
        shot.shotType && `Shot type: ${shot.shotType}`,
        shot.cameraAngle && `Camera angle: ${shot.cameraAngle}`,
        shot.cameraMovement && `Camera movement: ${shot.cameraMovement}`,
        shot.lightingStyle && `Lighting: ${shot.lightingStyle}`,
        shot.depthOfField && `Depth of field: ${shot.depthOfField}`,
        shot.location && `Location: ${shot.location}`,
        shot.time && `Time: ${shot.time}`,
        shot.action && `Action: ${shot.action}`,
        shot.result && `Result: ${shot.result}`,
        shot.cameraPurpose && `Camera purpose: ${shot.cameraPurpose}`,
        shot.cutPoints?.length && `Internal cuts (write each as a timed beat, e.g. "At 00:0X.000, the camera cuts to ..."): ${shot.cutPoints.join("；")}`,
        shot.entryState && `Entry state (continuity): ${shot.entryState}`,
        shot.exitState && `Exit state (continuity): ${shot.exitState}`,
        shot.emotion && `Emotion: ${shot.emotion} (${shot.emotionIntensity})`,
        shot.dialogue && `Dialogue (keep verbatim; preserve channel tags [台词]/[内心]/[画外]; spoken is lip-synced Chinese; inner is lip-closed inner voice; system is off-screen; no narration): ${shot.dialogue}`,
        refLines && `Reference pictures:\n${refLines}`,
        subjectLines,
    ]
        .filter(Boolean)
        .join("\n");
    const userText = `${modeHint}\n\nShot description:\n${description}`;
    const userContent = images.length
        ? [{ type: "text" as const, text: userText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : userText;
    return [
        { role: "system" as const, content: H3_PROMPT_SYSTEM },
        { role: "user" as const, content: userContent },
    ];
}

export function buildH3BasePrompt(shot: DramaStoryboardShot, style: string) {
    const visual = [shot.shotType, shot.cameraAngle, shot.location, shot.time, shot.action, shot.result].filter(Boolean).join("；");
    return `integrated_multimodal_description: For the target video, at 0.00 seconds into the target video, <Picture 1> (the first frame) is fully referenced. ${style ? `Art direction: ${style}. ` : ""}${visual || "the subject acts in the scene"}。Camera: ${shot.cameraMovement || "static"}. Lighting: ${shot.lightingStyle || "natural"}. Depth of field: ${shot.depthOfField || "medium"}. No subtitles, no captions, no watermarks; no background music.

overall_soundscape: Ambient air, footsteps on stone and cloth movement; voices are present without any readable dialogue text. No background music.

non_diegetic_music: N/A`;
}

type H3RefInput = { name: string; kind: "character" | "scene" | "prop"; description?: string };

function dialogueLineRecords(dialogue: unknown): { speaker: string; channel: "spoken" | "inner" | "system"; text: string }[] {
    if (Array.isArray(dialogue)) {
        return dialogue
            .map((item) => {
                const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const rawChannel = text(record.channel).toLowerCase();
                const channel = rawChannel === "inner" ? ("inner" as const) : rawChannel === "system" || rawChannel === "off_screen" ? ("system" as const) : ("spoken" as const);
                return { speaker: text(record.speaker), channel, text: text(record.text) };
            })
            .filter((line) => line.text);
    }
    return String(dialogue || "")
        .split(/\n+/)
        .map((line) => {
            const match = line.match(/^\[(台词|内心|画外|系统|spoken|inner|system)\]\s*([^：:]*)[：:]?\s*([\s\S]*)$/i);
            if (!match) return { speaker: "", channel: "spoken" as const, text: line.trim() };
            const tag = match[1].toLowerCase();
            const channel = tag === "内心" || tag === "inner" ? ("inner" as const) : tag === "画外" || tag === "系统" || tag === "system" ? ("system" as const) : ("spoken" as const);
            return { speaker: match[2].trim(), channel, text: match[3].trim() };
        })
        .filter((line) => line.text);
}

/**
 * 字段确定性生成 H3 提示词：完全由 shot 字段 + 参考图列表拼装，不走 LLM 改写。
 * 段内时间表先排对白（先声后画），再排动作与内部切点；Picture 编号严格按 refs 顺序。
 */
export function buildDeterministicH3Prompt(options: {
    shot: DramaStoryboardShot;
    mode: "frames" | "reference";
    refs?: H3RefInput[];
    style?: string;
    aspect?: string;
    duration: number;
}): string {
    const { shot, mode } = options;
    const clean = (value: string) => String(value || "").replace(/[。．.；;，,、\s]+$/g, "");
    const location = clean(shot.location);
    const time = clean(shot.time);
    const result = clean(shot.result);
    const title = clean(shot.title);
    const refs = (options.refs || []).filter((ref) => ref && ref.name);
    const duration = Math.max(2, Math.min(25, Math.round(Number(options.duration) || Number(shot.duration) || 5)));
    const lines = dialogueLineRecords(shot.dialogue);
    const charRefs = refs.filter((ref) => ref.kind === "character");
    const sceneRef = refs.find((ref) => ref.kind === "scene");
    const pictureOf = (ref: H3RefInput) => `<Picture ${refs.indexOf(ref) + 1}>`;
    const characterId = (name: string) => {
        const index = charRefs.findIndex((ref) => ref.name === name);
        if (index >= 0) return `S${index + 1}`;
        const spoken = [...new Set(lines.filter((line) => line.speaker).map((line) => line.speaker))].indexOf(name);
        return `S${Math.max(1, spoken + 1)}`;
    };
    const windows: { start: number; end: number }[] = [];
    let cursor = 0.6;
    for (const line of lines) {
        const chars = line.text.replace(/\s/g, "").length;
        const raw = line.channel === "system" ? Math.min(2, chars / SPEECH_CHARS_PER_SECOND) : chars / SPEECH_CHARS_PER_SECOND;
        const span = Math.max(0.6, raw);
        const maxEnd = duration - 0.4;
        const start = Math.min(cursor, Math.max(0.2, maxEnd - span));
        const end = Math.max(start + 0.4, Math.min(maxEnd, start + span));
        windows.push({ start, end });
        cursor = end + 0.3;
    }
    const stamp = (seconds: number) => {
        const whole = Math.floor(seconds);
        const ms = Math.round((seconds - whole) * 1000);
        return `00:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    };
    const cleanOld = (value: string) => String(value || "").replace(/[。．.；;，,、\s]+$/g, "");
    const rawParts = actionPartsOf(shot.action);
    const actionParts = (rawParts.length > 1 ? rawParts : String(shot.action || "").split(/[；;]/)).map(cleanOld).filter(Boolean);
    const cameraLine = [shot.cameraMovement, shot.cameraAngle, shot.shotType].filter(Boolean).join(", ");
    const lighting = [shot.lightingStyle, shot.depthOfField].filter(Boolean).join(", ");
    const emotion = shot.emotion ? `${shot.emotion}${shot.emotionIntensity ? ` (intensity ${shot.emotionIntensity})` : ""}` : "";
    const beats: string[] = [];
    beats.push(
        `[Shot 1] At ${stamp(0)}, the shot opens on ${sceneRef ? pictureOf(sceneRef) : "<Picture 1>"} (${location || "the location"})${time ? ` at ${time}` : ""}; ${lighting ? `lighting: ${lighting}; ` : ""}camera: ${cameraLine || "static"}; action: ${actionParts[0] || "the subject begins the action"}.`,
    );
    lines.forEach((line, index) => {
        const window = windows[index];
        if (!window) return;
        const who = line.channel === "system" ? "SYS" : characterId(line.speaker);
        const delivery =
            line.channel === "inner"
                ? "lips stay closed, delivered as inner monologue"
                : line.channel === "system"
                  ? "off-screen voice, no visible speaker"
                  : `${line.speaker ? `${line.speaker} ` : ""}speaks with visible lip movement`;
        beats.push(`At ${stamp(window.start)}, ${delivery}: <d>[Chinese] (${who}) ${line.text}</d>`);
    });
    const cutTimes = (shot.cutPoints || [])
        .map((point) => String(point).match(/00:(\d{2}(?:\.\d{1,3})?)/)?.[1])
        .filter((value): value is string => Boolean(value) && Number(value) > 0 && Number(value) < duration);
    cutTimes.forEach((time, index) => {
        const part = actionParts[index + 1];
        if (part) beats.push(`At 00:${time.includes(".") ? time : `${time}.000`}, the camera cuts to ${part}`);
    });
    if (actionParts.length > 1 + cutTimes.length) beats.push(`The shot resolves with: ${actionParts.slice(1 + cutTimes.length).join("；")}`);
    if (result) beats.push(`Result: ${result}.`);
    const continuity = [shot.entryState && `Entry state: ${clean(shot.entryState)}`, shot.exitState && `Exit state: ${clean(shot.exitState)}`].filter(Boolean).join("；");
    const closing = "No subtitles, no captions, no watermarks; no background music.";
    const soundscape = [
        sceneRef ? `Ambient sound of ${location || "the location"}${time ? ` at ${time}` : ""}` : "Ambient environment tone",
        "cloth movement and soft footsteps",
        lines.length ? "voices as timed above" : "no spoken lines",
    ].join("; ") + ".";
    if (mode === "reference") {
        const subjectDefs: string[] = [];
        const retention: string[] = [];
        if (sceneRef) subjectDefs.push(`${pictureOf(sceneRef)} = the location (${sceneRef.name}); structures, props and lighting match ${pictureOf(sceneRef)}.`);
        charRefs.forEach((ref, index) => {
            const anchor = text(ref.description).replace(/\s+/g, " ").slice(0, 260);
            subjectDefs.push(`<Subject ${index + 1}> = ${ref.name} in ${pictureOf(ref)}${anchor ? `: ${anchor}` : ""}; face, hair and costume match ${pictureOf(ref)} exactly.`);
            retention.push(`<Subject ${index + 1}>: fully_preserved — identity, hair and costume stay identical to ${pictureOf(ref)}.`);
        });
        refs.filter((ref) => ref.kind === "prop").forEach((ref) => subjectDefs.push(`${pictureOf(ref)} = the prop ${ref.name}; shape, material and color match ${pictureOf(ref)}.`));
        if (!subjectDefs.length) subjectDefs.push("<Picture 1> = the main subject or location shown in the reference.");
        return `subject_definitions:
${subjectDefs.join("\n")}

summary: [reference generation] One continuous ${shot.shotType || "cinematic"} shot in ${location || "the location"}${time ? ` at ${time}` : ""}: ${title || clean(shot.action) || "the shot"}; ${emotion || "steady tone"}.

retention_analysis:
${retention.length ? retention.join("\n") : "The reference picture stays the sole authority for layout, props and lighting."}

detailed_description:
${beats.join("\n")}${continuity ? `\n${continuity}` : ""}
${closing}

overall_soundscape: ${soundscape}
non_diegetic_music: N/A`;
    }
    return `integrated_multimodal_description: For the target video, at 0.00 seconds into the target video, <Picture 1> (the first frame) is fully referenced. ${options.style ? `Art direction: ${options.style}. ` : ""}${beats.join(" ")}${continuity ? ` ${continuity}` : ""} ${closing}

overall_soundscape: ${soundscape}
non_diegetic_music: N/A`;
}

export function storyboardCardContent(shot: DramaStoryboardShot): string {
    const parts = [
        `镜头 ${shot.shotNumber} · ${shot.title}`,
        [
            shot.shotType && `景别：${shot.shotType}`,
            shot.cameraAngle && `机位：${shot.cameraAngle}`,
            shot.cameraMovement && `运动：${shot.cameraMovement}`,
            shot.lightingStyle && `光线：${shot.lightingStyle}`,
            shot.depthOfField && `景深：${shot.depthOfField}`,
        ]
            .filter(Boolean)
            .join("｜"),
        [shot.location && `地点：${shot.location}`, shot.time && `时间：${shot.time}`].filter(Boolean).join("｜"),
        shot.action && `动作：${shot.action}`,
        shot.result && `结果：${shot.result}`,
        shot.cameraPurpose && `运镜目的：${shot.cameraPurpose}`,
        shot.entryState && `入口：${shot.entryState}`,
        shot.exitState && `出口：${shot.exitState}`,
        shot.cutPoints?.length && `内部切镜：${shot.cutPoints.join("；")}`,
        shot.dialogue && `台词：${shot.dialogue}`,
        shot.emotion && `情绪：${shot.emotion}（${shot.emotionIntensity > 0 ? `+${shot.emotionIntensity}` : shot.emotionIntensity}）`,
        shot.segmentTitle && `段落：${shot.segmentTitle}`,
    ].filter(Boolean);
    return parts.join("\n");
}
