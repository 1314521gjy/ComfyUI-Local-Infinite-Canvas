export type DramaAssetSpec = {
    kind: "character" | "scene" | "prop";
    name: string;
    nameEn?: string;
    role?: string;
    description: string;
    prompt?: string;
    location?: string;
    time?: string;
};

const MAX_PER_KIND = 6;

function styleLine(styleLabel: string, stylePrompt: string, aspect: string) {
    return `- **风格要求**：${[styleLabel, stylePrompt].filter(Boolean).join("；") || "未指定"}\n- **图片比例**：${aspect || "16:9"}`;
}

export function buildCharacterExtractionMessages(script: string, episodeTitle: string, styleLabel: string, stylePrompt: string, aspect: string) {
    const system = `你是一个专业的角色分析师，擅长从剧本中提取和分析角色信息。

**【语言要求】所有字段的值必须使用中文，禁止出现英文内容（role字段的值除外，固定为 main/supporting/minor）。**

你的任务是根据提供的剧本内容，提取并整理剧中出现的所有有名字角色的设定。

要求：
1. 提取所有有名字的角色（忽略无名路人或背景角色）
2. 对每个角色，提取以下信息（全部用中文填写）：
   - name: 角色名字（中文）
   - name_en: 角色名的拼音或英文名（用于参考表标题）
   - role: 角色类型，固定值之一：main / supporting / minor
   - appearance: 外貌描述（中文，100-200字，包含性别、年龄、体型、面部特征、发型、服装风格等，不含任何场景或环境信息）
   - description: 背景故事和角色关系（中文，50-100字）
3. 主要角色外貌要详细，次要角色可简化
${styleLine(styleLabel, stylePrompt, aspect)}
输出格式：
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个元素是一个角色对象，包含上述字段（最多 ${MAX_PER_KIND} 个）。`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: `剧集：${episodeTitle || "未命名"}\n\n剧本：\n${script.slice(0, 12000)}` },
    ];
}

export function buildSceneExtractionMessages(script: string, episodeTitle: string, styleLabel: string, stylePrompt: string, aspect: string) {
    const system = `【任务】从剧本中提取所有唯一的场景背景

【要求】
1. 识别剧本中所有不同的场景（地点+时间组合）
2. 为每个场景生成详细的**中文**图片生成提示词（Prompt）
3. **重要**：场景描述必须是**纯背景**，不能包含人物、角色、动作等元素
4. **重要**：prompt 字段必须为中文，不得使用英文（风格词如 realistic 可保留）
5. **风格要求**：${[styleLabel, stylePrompt].filter(Boolean).join("；") || "未指定"}
   - **图片比例**：${aspect || "16:9"}

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块。直接以 [ 开头，以 ] 结尾。**
每个元素包含：location（地点）, time（时间）, prompt（完整的中文图片生成提示词，纯背景，明确说明无人物）。最多 ${MAX_PER_KIND} 个。`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: `剧集：${episodeTitle || "未命名"}\n\n剧本：\n${script.slice(0, 12000)}` },
    ];
}

function asText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function readList(value: unknown, kind: "character" | "scene" | "prop"): DramaAssetSpec[] {
    const list = Array.isArray(value) ? value : [];
    return list
        .map((item, index) => {
            if (typeof item === "string") return { kind, name: item.trim() || `${kind === "character" ? "角色" : "场景"}${index + 1}`, description: "" };
            const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
            const location = asText(record.location) || asText(record.place) || asText(record.scene);
            const time = asText(record.time) || asText(record.when);
            const name = (kind === "scene" ? location : "") || asText(record.name) || asText(record.location) || asText(record.title) || `${kind === "character" ? "角色" : "场景"}${index + 1}`;
            const nameEn = asText(record.name_en) || asText(record.nameEn) || asText(record.romanization);
            const description = asText(record.appearance) || asText(record.prompt) || asText(record.description) || asText(record.desc) || asText(record.time);
            return {
                kind,
                name,
                nameEn: nameEn || undefined,
                role: asText(record.role) || undefined,
                description,
                location: kind === "scene" ? location || name : undefined,
                time: kind === "scene" ? time || undefined : undefined,
            };
        })
        .filter((item) => item.name)
        .slice(0, MAX_PER_KIND);
}

export function normalizeCharacters(raw: unknown): DramaAssetSpec[] {
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    return readList(Array.isArray(raw) ? raw : data?.characters ?? data?.roles, "character");
}

export function normalizeScenes(raw: unknown): DramaAssetSpec[] {
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const scenes = readList(Array.isArray(raw) ? raw : data?.scenes ?? data?.locations ?? data?.environments, "scene");
    const used = new Set<string>();
    return scenes.map((scene, index) => {
        const base = scene.name;
        let name = base;
        if (used.has(name)) {
            const suffix = scene.time || `场景 ${index + 1}`;
            name = `${base} · ${suffix}`;
            let serial = 2;
            while (used.has(name)) name = `${base} · ${suffix} ${serial++}`;
        }
        used.add(name);
        return { ...scene, name };
    });
}

const SCENE_TIME_WORDS = /清晨|凌晨|拂晓|黎明|早晨|上午|正午|中午|午后|下午|傍晚|黄昏|夜晚|深夜|夜色|白天|白日|晴日|雨后|雪后|晨光|暮色/g;
const SCENE_VIEW_WORDS = /入口|出口|外沿|外围|边缘|角落|内部|内景|外景|近景|远景|中景|全景|特写|台阶|石阶|廊柱|回廊|门口|门前|中央|正中|区域|一角|交界处/g;
const SCENE_PUNCTUATION = /[（）()【】\[\]·•\-—_、,，。.\s]/g;
const SCENE_SEPARATORS = /[-—_·:：/|（）()【】\[\]《》]/;

export function normalizeLocationKey(location: string) {
    const raw = String(location || "");
    const stems = raw.split(SCENE_SEPARATORS).map((part) => part.trim()).filter(Boolean);
    const base = stems[0] || raw;
    const key = base
        .replace(SCENE_PUNCTUATION, "")
        .replace(SCENE_TIME_WORDS, "")
        .replace(SCENE_VIEW_WORDS, "");
    return key || raw.replace(SCENE_PUNCTUATION, "");
}

// 同一基址常被写成「萧家家族广场」和「广场边缘角落」，按前后缀包含兜底归组。
export function isSameSceneKey(a: string, b: string) {
    if (!a || !b) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length < 2) return false;
    return long.startsWith(short) || long.endsWith(short);
}

// 同一地点常被写成「萧家广场中央」和「萧家广场外石径」：前后缀都不包含，但共享基名前缀。
export function sharesSceneBase(a: string, b: string) {
    if (!a || !b) return false;
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
    return shared >= 4;
}

export function deriveSceneVariant(location: string, time: string, locationKey = "") {
    const raw = String(location || "");
    const parts = raw
        .split(SCENE_SEPARATORS)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length > 1) return parts.slice(1).join(" · ");
    if (locationKey) {
        if (raw.includes(locationKey)) {
            const rest = raw.replace(locationKey, "").replace(SCENE_PUNCTUATION, "");
            if (rest) return rest;
        } else {
            const compact = raw.replace(SCENE_PUNCTUATION, "");
            let shared = 0;
            while (shared < compact.length && shared < locationKey.length && compact[compact.length - 1 - shared] === locationKey[locationKey.length - 1 - shared]) shared += 1;
            if (shared >= 2) {
                const rest = compact.slice(0, compact.length - shared);
                if (rest) return rest;
            }
        }
    }
    return time || "主视角";
}

export function isMajorSceneChange(text: string) {
    return /焚毁|废墟|战后|改建|坍塌/.test(text);
}

export function sceneReferencePrompt(prompt: string) {
    return `保持图一的场景不变，只改变时间/机位/区域。\n只以参考图为准保持建筑结构、材质、配色、光线；构图按下列描述。\n\n${prompt}`;
}

export function frameReferencePrompt(prompt: string, refs: { name: string; kind: "character" | "scene" | "prop" }[]) {
    const kindLabel = { character: "角色", scene: "场景", prop: "道具" } as const;
    const mapping = refs.map((ref, index) => `图片${index + 1}＝${kindLabel[ref.kind]}「${ref.name}」`).join("；");
    const primary = refs.find((ref) => ref.kind === "character");
    const subject = primary ? `画面主角是角色「${primary.name}」，画面中只出现一个该角色，保持其脸型、发型、服装和体型与参考一致。` : "";
    const lock = "人物脸型、发型、服装以角色参考为准；场景结构、材质、光线以场景参考为准；不要照搬参考图的排版、标签或多格分栏。";
    return `参考图对应：${mapping}。${subject}${lock}\n\n${prompt}，single continuous scene, no split panels, no side-by-side layout, no collage`;
}

export function buildRolePolishMessages(asset: DramaAssetSpec, stylePrompt: string, aspect: string) {
    const system = `# 工业角色参考表标准提示词生成器

## 你的身份
你是专业的角色视觉设计师，负责将角色描述转换为「工业角色参考表」绘图提示词：分栏、标签清晰、主体填满画幅；**不是**四宫格拼图、**不是**海报、**不是**真人棚拍写真、**不是**漫画分镜、**不是**贴纸拼贴。

## 核心规则

### 提取与限制
- **仅提取**：角色描述中明确的外貌与服装特征
- **严禁添加**：场景、环境、叙事性光影特效、情绪形容词堆砌
- **标志性道具（可选）**：仅当原文明确写出身份关键道具时，写在「SIGNATURE PROP / EQUIPMENT DETAIL」小窗内容里；**不得**凭空加武器或剧情道具
- **全版面一致**：所有面板同一角色、同一年龄段与妆面；发型、瞳色、服装、体型、比例完全一致
- **时代匹配**：服装与发型必须符合作品类型所属时代背景${stylePrompt ? `\n- **画风风格（须贯穿各栏描述，与生图侧画风块一致）**：${stylePrompt}` : ""}

### 版式（强制，减少留白）
- **顶部标题栏**：浅灰细边框技术标题条，标题使用用户提供的角色名称（或作品内统一称呼），与正文描述一致
- **左约三分之一竖栏**：仅放置 **FACE HERO CLOSE-UP**（主面部特写竖条，大块面部占位，减少无用留白）
- **右约三分之二区域**：放置 **FRONT VIEW**、**BACK VIEW**、**SIDE PROFILE CLOSE-UP**、**COSTUME / SUIT DETAIL VIEW**、**MATERIAL & TEXTURE NOTES**；各分区配有清晰英文/中英对照标签
- **禁止侧身全身**：不设置 90° 侧面全身面板
- **FRONT VIEW 与 BACK VIEW**：同一角色、同一套服装版本、同一身高比例、同一灯光与同一标尺尺度；正面与背面均为稳定直立全身（头顶到脚底），不做动作姿势，无扭身；双臂自然下垂于体侧，手部自然
- **SIDE PROFILE CLOSE-UP**：90° 侧面脸部特写（非全身），展示侧脸轮廓、鼻梁侧面、耳部、发型侧面与下颌线；**必须与左侧 FACE HERO CLOSE-UP 同一张脸**（不可变成另一年龄或另一妆面），与正脸形成互补而非重复
- **COSTUME / SUIT DETAIL VIEW 与 MATERIAL & TEXTURE NOTES**：仅在右侧区域内展示衣领、袖口、腰带、鞋靴、配饰、边缘轮廓及布料/金属/皮革/绷带等材质；**MATERIAL & TEXTURE NOTES** 只能用**短标签**（如 cloth、metal、leather、wet fabric、edge wear），**不得**写成横跨全画幅的底部长文说明栏
- **可选**：**SIGNATURE PROP / EQUIPMENT DETAIL** 小窗（按需）
- **取消**：色板条、调色块模块
- **分隔**：各面板之间细浅灰分割线，边界规整、留白克制；整体 4K 级细节密度、结构稳定的电影工业参考表质感

### 输出语言约束
- **禁止情绪描写**：禁止「带憧憬」、「给人…感」等
- **禁止抽象形容**：禁止「俊美」「自信」「温柔」等无法直接画出的词
- **只用具象描述**：可视化物理特征

### 避免与生图侧重复
- **不要**重复赘述纯白底、禁止拼贴分镜等生图 API 系统提示里已有的硬性条款
- **须**在润色输出中明确：标题条应显示的标题文字、各分区的英文标签名（如 FACE HERO CLOSE-UP、FRONT VIEW、SIDE PROFILE CLOSE-UP、MATERIAL & TEXTURE NOTES），并与【输出格式】各节一一对应（参考表画面上的技术标签不是「水印」）
- 正文仍以具象外貌/服装/材质为主，避免空洞「8K」「超高清」堆砌

## 时代服装匹配表

| 类型 | 服装体系 |
|------|---------|
| 古风/仙侠/玄幻 | 中国古代汉服体系，交领右衽、广袖长袍 |
| 武侠 | 中国古代劲装体系，交领窄袖劲装 |
| 西幻/奇幻 | 欧洲中世纪服饰，束腰长袍、斗篷 |
| 现代都市 | 现代服装，T恤、衬衫、西装、连衣裙 |

## 抽象词汇转具象示例

| 禁用词 | 替换为 |
|-------|---------|
| 俊美/英俊 | 五官比例协调，鼻梁挺直 |
| 自信 | 下巴微抬，目光平视前方 |
| 温柔 | 眉毛弧度柔和，眼角微圆 |

## 输出格式

【基础设定】
人物基础: 性别，年龄段，身高体型，肤色
五官: 眉形，眼型，瞳色，鼻型，唇形
表情（全身与主特写）: 中性、无表情或统一证件照式平静
发型: 颜色，长度，质感，发型结构
服装: 款式名称，主色，材质，领型，袖型

【标题栏】
标题条内要显示的确切标题文字（通常即角色名）

【FACE HERO CLOSE-UP｜左竖栏】
主脸特写（竖向大画幅）：发际线到下颌，肤质、眉眼妆面、唇形与整体脸型比例

【FRONT VIEW｜右区-正面全身】
正面全身：从头到脚完整入画，站姿稳定，服装前襟与裤/裙正面结构

【BACK VIEW｜右区-背面全身】
背面全身：从头到脚后跟完整入画，与正面同比例同服装；后脑发型、后领、背身裁片与下摆

【SIDE PROFILE CLOSE-UP｜右区】
90° 侧面脸部特写：侧脸轮廓、鼻梁侧面、耳部、发型侧面、下颌线与唇线侧面（与左栏正脸同一人，互补不重复）

【COSTUME / SUIT DETAIL VIEW｜右区】
衣领、袖口、腰带、鞋靴、配饰、裁片边缘等（不写整景）

【MATERIAL & TEXTURE NOTES｜右区小标签】
若干短英文或中英标签列举材质关键词（非长段落）

【SIGNATURE PROP / EQUIPMENT DETAIL｜可选】
仅当有原文依据时写道具局部特写说明

只输出润色后的参考表描述正文，不要解释。`;
    const title = [asset.name, asset.nameEn].filter(Boolean).join(" / ");
    const user = `角色名：${asset.name}\n标题栏文字：${title}\n角色类型：${asset.role || "main"}\n角色描述：${asset.description}\n图片比例：${aspect || "16:9"}`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
    ];
}

export function detectGenderFromDescription(text: string): "MALE" | "FEMALE" | null {
    if (!text) return null;
    if (/男性|男生|男孩|男人|帅哥|先生/.test(text)) return "MALE";
    if (/女性|女生|女孩|女人|美女|小姐|女士/.test(text)) return "FEMALE";
    if (/哥哥|大哥|二哥|老哥|小哥|兄长|兄弟|弟弟|老弟|小弟|爸爸|父亲|老爸|爷爷|老爷|叔叔|伯伯|舅舅/.test(text)) return "MALE";
    if (/姐姐|大姐|二姐|老姐|小姐姐|妹妹|小妹|大妹|妈妈|母亲|老妈|奶奶|姑姑|婶婶|阿姨/.test(text)) return "FEMALE";
    if (/男主|男二|男三|男配|男反|男一号/.test(text)) return "MALE";
    if (/女主|女二|女三|女配|女反|女一号/.test(text)) return "FEMALE";
    if (/\b(male|man|boy|gentleman|he|his)\b/i.test(text)) return "MALE";
    if (/\b(female|woman|girl|lady|she|her)\b/i.test(text)) return "FEMALE";
    return null;
}

export function characterAssetPrompt(stylePrompt: string, asset: DramaAssetSpec, polished: string) {
    const title = [asset.name, asset.nameEn].filter(Boolean).join(" / ");
    const gender = detectGenderFromDescription(`${asset.description} ${polished}`);
    const genderEnforcement =
        gender === "MALE"
            ? "GENDER: male only — masculine build and facial features; do not feminize."
            : gender === "FEMALE"
              ? "GENDER: female only — feminine build and facial features; do not masculinize."
              : "";
    return `${stylePrompt ? `【画风·最高优先级】四格统一：${stylePrompt}\nMANDATORY ART STYLE (all panels): ${stylePrompt}.\n\n` : ""}Industrial character reference sheet — image only, no text reply.

ONE image, single canvas (NOT a 2×2 or 4×4 grid, NOT four equal quadrants). Layout:
- Top: thin light-gray technical TITLE BAR; title text must be legible: "${title}".
- LEFT ~1/3 COLUMN: FACE HERO CLOSE-UP (tall vertical hero face; maximize face scale, minimal empty margin).
- RIGHT ~2/3: labeled sub-panels: FRONT VIEW (front full body, head-to-toe), BACK VIEW (back full body, head-to-toe), SIDE PROFILE CLOSE-UP (90° profile face close-up, not full body), COSTUME / SUIT DETAIL VIEW (collar, cuffs, belt, shoes, accessories), MATERIAL & TEXTURE NOTES (short tags only: fabric, embroidery, metal, leather — not a full-width text bar).
- No left-profile full-body panel. FRONT and BACK: same character, same outfit, same proportions, same lighting and scale; neutral standing, arms at sides, no action pose. SIDE PROFILE CLOSE-UP complements the FACE HERO (same identity, age, makeup; profile view, not a duplicate front face).
- Costume/material only in right-side panels. No color-swatch strip. Fine light-gray dividers. Cinematic industrial reference sheet, 4K detail density — not a poster, not a comic grid, not a photo collage.

Solid white background (RGB 255,255,255). No watermark or logos. Panel titles and material tags printed on the sheet are required. No environment; at most minimal foot contact.

---

${polished || asset.description}
${genderEnforcement ? `\n\n---\n\n${genderEnforcement}` : ""}`;
}

export function buildScenePolishMessages(asset: DramaAssetSpec, stylePrompt: string, aspect: string) {
    const system = `# 场景单图参考图生成器

## 你的身份
你是专业的影视美术设计师，负责将场景描述转换为AI绘图标准单图场景参考图提示词（**非四宫格**）。

## 核心规则

### 提取与统一
- **单张连续画面**：生成一段完整、统一的场景描述，用于绘制**一张**图片
- **完整展示**：必须包含场景的全貌、主要建筑结构、地面材质、关键陈设、光线/时段、氛围
- **禁止出现**：角色、人物剪影、文字标注、水印、四宫格/分格/第1格/第2格等字样
- **真实可信**：建筑风格、材质、植被必须符合场景所属时代和地域${stylePrompt ? `\n- **画风风格**：${stylePrompt}` : ""}

### 单图内容设计原则
- 用最宽/最合适的视角一次性展示整体空间关系，不遗漏边界
- 清晰呈现人物最常活动的区域（对话区/行动区）
- 突出最具场景辨识度的标志性细节
- 强调光线、材质、氛围的统一性

### 避免与生图侧重复
- **不要**写四宫格顺序、无人物、无文字水印等与版面/负面清单相关的长段说明（生图 API 会统一注入）；只写场景可视信息与完整画面内容

## 输出要求
直接输出一段连贯的场景描述文字，不要分段落标题，不要出现「第X格」字样。`;
    const user = `场景：${asset.name}\n场景描述：${asset.description}\n图片比例：${aspect || "16:9"}`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
    ];
}

export function sceneAssetPrompt(stylePrompt: string, asset: DramaAssetSpec, polished: string) {
    return `${stylePrompt ? `ART STYLE (all panels): ${stylePrompt}.\n\n` : ""}Scene environment reference — image only, no text reply.

ONE single continuous image (no grid, no split panels, no collage).
Show the complete scene in one unified view: wide establishing shot capturing the full space, key architectural features, lighting, atmosphere, and environmental details.
No people: no characters, silhouettes, human shadows. No text/labels/watermarks/location lettering.

---

${polished || asset.description}`;
}

export function buildPropExtractionMessages(script: string, episodeTitle: string, styleLabel: string, stylePrompt: string, aspect: string) {
    const system = `你是一位专业的剧本道具分析师，擅长从剧本中提取具有视觉特征的关键道具。

你的任务是根据提供的剧本内容，提取并整理所有对剧情有重要作用或有特殊视觉特征的关键道具。

要求：
1. 只提取对剧情发展有重要作用、或有特殊视觉特征的关键道具。
2. 普通的生活用品（如普通的杯子、笔）如果无特殊剧情意义不需要提取。
3. 若道具有明确归属者，**仅**写在 "description" 中（可用中文人名）；**禁止**在 "image_prompt" 中出现任何角色名、昵称、称谓或人际关系用语。
4. **description 字段强制纯中文**：必须输出**纯中文、80-150字**的详细视觉外观描述 + 该道具在剧中的核心作用/归属/剧情功能。必须严格遵循中文影视提示词风格：符合道具所属时代的真实物理尺度意识、材质工艺细节、磨损痕迹、柔和棚拍光质感、电影化构图暗示。严禁英文，严禁只写剧情不写可用于画图的外观细节。
5. "image_prompt" 输出纯中文单道具主图提示词，按影视资产库/电商主图级标准：轮廓、材质、颜色、磨损与工艺细节、体量感。
6. "image_prompt" 必须写明：单一无缝纯色棚拍背景（哑光、无渐变）、画面中仅有该道具一个主体、柔和均匀棚拍光；明确禁止人物、手、家具、地面/台面、室内外环境、散落杂物、其他道具、文字商标、包装（除非道具本身是包装）、烟尘粒子。
7. **image_prompt 禁止泄漏剧本特征**：不得出现剧本人名、地名、组织名、台词、情节专有称呼；改写为泛化视觉描述（如"刻有细小铭文"）。唯一例外：文字实体印/刻在道具表面且剧本明确要求还原时可保留。
8. **image_prompt 严格不扩展**：只写剧本与 description 中已交代、肉眼可见的外观；禁止凭空增加配饰、品牌故事、煽情形容词。
- **风格要求**：${[styleLabel, stylePrompt].filter(Boolean).join("；") || "未指定"}
- **图片比例**：${aspect || "16:9"}

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个对象包含：name（道具名称）、type（武器/关键证物/日常用品/特殊装置）、description（纯中文作用+外观，80-150字）、image_prompt（纯中文单道具主图提示词）。最多 ${MAX_PER_KIND} 个。`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: `剧集：${episodeTitle || "未命名"}\n\n剧本：\n${script.slice(0, 12000)}` },
    ];
}

export function normalizeProps(raw: unknown): DramaAssetSpec[] {
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    return readList(Array.isArray(raw) ? raw : data?.props ?? data?.items, "prop");
}

export function buildPropPolishMessages(asset: DramaAssetSpec, stylePrompt: string, aspect: string) {
    const system = `# 道具图片提示词生成器（中文版）

## 你的身份
你是专业的影视道具美术与产品摄影指导，负责把道具描述写成**资产主图级中文生图提示词**。

## 核心规则

### 剧本信息隔离（强制）
- 用户输入可能含剧本人名、地名、台词或剧情——**一律不得**写入最终中文 prompt（含音译名、拼音、引号对话）。若输入出现姓名，用泛化中性描述改写或删除。
- **零扩展**：只保留输入里已写明或可合理从材质/形制直接读出的视觉信息；禁止新增配饰、品牌/朝代故事、情绪叙事、与物体无关的联想词。

### 主体与背景（最高优先级，违反即失败）
- **唯一主体 + 纯色零背景**：画面中只能有这一件道具，100% 纯色无缝无限影棚背景（单一哑光纯色 seamless cyclorama），绝对禁止环境、地面、台面、墙壁、地板、阴影投射、渐变、纹理、室内外元素；背景不得出现除道具本体以外的像素。
- **严禁**：漂亮的室内场景、木质桌面、大理石台面、柔焦背景、环境光影、地面反射、轻微景深、工作室一角、放在架子上/地板上。
- **零杂物**：禁止散落物、书本、植物、器皿、布料堆叠、包装箱、工具、第二件道具、灰尘烟雾粒子、景深虚化里的远处物体。
- **真实物理尺度**：严格遵循道具所属时代的真实尺寸与相对比例，严禁夸大或破坏透视。

### 质感与光
- 材质、镀层、磨损、刻字、比例暗示写具体（拉丝/哑光/抛光/微细划痕）；句子宁少勿多。
- 光：柔和均匀棚拍光，仅允许极轻接触阴影；禁止戏剧轮廓光、强逆光、体积光、镜头眩光、色散、电影级低 key 高反差。

### 硬性排除
- 禁止人物、手、身体任何部分、文字水印、商标（剧情指定且为道具本体的一部分除外）、叙事性场景词、任何专有名词式剧本标签。${stylePrompt ? `\n- **画风风格**（仅作用于渲染质感）：${stylePrompt}` : ""}

### 输出格式
直接输出**一段**中文提示词（约 45–90 字，能更短则更短），不要解释、标题、列表或引号。必须自然包含：单一主体、纯色无缝棚拍背景、无多余物体、无人物、无手、无环境；末尾接画风。`;
    const user = `道具：${asset.name}\n道具描述：${asset.description}\n图片比例：${aspect || "16:9"}`;
    return [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
    ];
}

export function propAssetPrompt(stylePrompt: string, asset: DramaAssetSpec, polished: string) {
    return polished || asset.description;
}


export async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
