import type { AiTextMessage } from "@/services/api/image";
import type {
    CanvasAutomationCharacter,
    CanvasAutomationCharacterSheet,
    CanvasAutomationGrid,
    CanvasAutomationPage,
    CanvasAutomationPanelSpec,
    CanvasAutomationScene,
    CanvasAutomationSceneSheet,
    CanvasAutomationScript,
    CanvasAutomationScriptBeat,
    CanvasAutomationScriptLine,
    CanvasAutomationScriptScene,
    CanvasAutomationSettings,
    CanvasAutomationShotGroup,
    CanvasMossLayout,
    CanvasMossLayoutRegion,
} from "@/types/canvas";

export type AutomationVideoCharacterReference = {
    characterId: string;
    name: string;
    pictureIndex: number;
    nodeId: string;
    appearanceLock: string;
    outfitLock: string;
    negativeLock: string;
};

export type AutomationVideoSceneReference = {
    sceneId: string;
    name: string;
    description: string;
    pictureIndex: number;
    nodeId: string;
};

export type AutomationVideoReferenceManifest = {
    characters: AutomationVideoCharacterReference[];
    scene?: AutomationVideoSceneReference;
    storyboardPictureIndex: number;
    missing: string[];
};

export function automationSceneName(page: Pick<CanvasAutomationPage, "scene" | "title" | "index">) {
    return String(page.scene || page.title || `场景 ${page.index + 1}`).trim();
}

export function collectAutomationScenes(pages: CanvasAutomationPage[]): CanvasAutomationScene[] {
    const scenes = new Map<string, CanvasAutomationScene>();
    pages.forEach((page) => {
        const name = automationSceneName(page);
        const id = page.sceneId || name;
        if (!id || scenes.has(id)) return;
        scenes.set(id, { id, name, description: page.sceneDescription || "" });
    });
    return [...scenes.values()];
}

export function buildAutomationVideoReference(page: CanvasAutomationPage, sheets: CanvasAutomationCharacterSheet[] = [], sceneSheets: CanvasAutomationSceneSheet[] = []): AutomationVideoReferenceManifest {
    const usable = new Map(sheets.filter((sheet) => sheet.state === "done" && sheet.nodeId).map((sheet) => [sheet.characterId, sheet]));
    const characters: AutomationVideoCharacterReference[] = [];
    const missing: string[] = [];
    (page.characters || []).forEach((character) => {
        const sheet = usable.get(character.id);
        if (!sheet) {
            missing.push(character.name);
            return;
        }
        characters.push({
            characterId: character.id,
            name: character.name,
            pictureIndex: characters.length + 1,
            nodeId: sheet.nodeId,
            appearanceLock: character.appearanceLock || character.description || "",
            outfitLock: character.outfitLock || "",
            negativeLock: character.negativeLock || "",
        });
    });
    const sceneName = automationSceneName(page);
    const sceneKey = page.sceneId || sceneName;
    const sceneSheet = sceneSheets.find((sheet) => sheet.state === "done" && sheet.nodeId && (sheet.sceneId === sceneKey || sheet.sceneId === sceneName || sheet.name === sceneName));
    const scene = sceneSheet
        ? {
              sceneId: sceneKey,
              name: sceneName,
              description: page.sceneDescription || "",
              pictureIndex: characters.length + 1,
              nodeId: sceneSheet.nodeId,
          }
        : undefined;
    return {
        characters,
        scene,
        storyboardPictureIndex: characters.length + (scene ? 1 : 0) + 1,
        missing,
    };
}

export function isRef2VAPrompt(prompt?: string) {
    return Boolean(prompt && /subject_definitions\s*:/.test(prompt) && /retention_analysis\s*:/.test(prompt) && /detailed_description\s*:/.test(prompt));
}

const REF2VA_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
export const AUTOMATION_VIDEO_PROMPT_VERSION = 22;
export const AUTOMATION_SCRIPT_VERSION = 1;
export const STORYBOARD_NEGATIVE_PROMPT = "face, eyes, nose, mouth, ears, hair, facial expression, eyebrows, lips, nude, naked, breasts, nipples, genitalia, detailed anatomy, anime, manga, comic illustration, art style, Makoto Shinkai style, detailed clothing, fabric folds, shading, screentone, color, photorealistic, detailed background, detailed props, statue, subtitles, captions, on-screen text, watermark, text outside speech bubbles";
export const STORYBOARD_PROMPT_VERSION = 5;

const GRID_META: Record<CanvasAutomationSettings["grid"], { rows: number; cols: number; panelCount: number; label: string }> = {
    "2x2": { rows: 2, cols: 2, panelCount: 4, label: "四宫格（2列×2行）" },
    "2x3": { rows: 3, cols: 2, panelCount: 6, label: "六宫格（2列×3行）" },
    "3x3": { rows: 3, cols: 3, panelCount: 9, label: "九宫格（3列×3行）" },
};

export function automationGridSpec(grid: CanvasAutomationSettings["grid"]) {
    return GRID_META[grid] || GRID_META["2x3"];
}

const DEFAULT_STYLE_NEGATIVE = "不要改变人物脸型、发型、服装和配色；不要加入未定义角色；不要跨格串画；不要在画面里绘制分镜编号、时间码或说明文字。";
const STYLE_GUIDES: Record<string, string> = {
    新海诚风格: "Makoto Shinkai style, full-color anime: saturated blue skies, towering cumulus clouds, lens flare, soft backlight, detailed urban and sky backgrounds, delicate light, melancholy atmosphere",
    宫崎骏风格: "Hayao Miyazaki / Studio Ghibli style, full-color anime: hand-drawn watercolor backgrounds, soft natural light, rounded expressive faces, gentle wind and lush greenery, warm nostalgic palette",
    彩色动漫: "full-color anime: clean line art, vivid cel shading, expressive faces, clear silhouettes, saturated colors and anime lighting",
    黑白漫画: "black-and-white manga: crisp ink lines, screentone shading, strong contrast, dramatic lighting",
    日漫网点: "Japanese manga with screentone: clean ink lines, dot screentone, expressive eyes, high-contrast shadows",
    彩色条漫: "full-color comic: clean line art, soft cel shading, clear silhouettes, readable panel compositions",
    美式写实: "American realistic comic: detailed anatomy, bold ink, dramatic shadows, muted colors",
};
const cjkPattern = /[\u3400-\u9fff]/g;
const wordPattern = /[a-z0-9]+/gi;
const STORYBOARD_STYLE = "白模故事板";
const STORYBOARD_STYLE_LOCK = "白底或浅灰块面，粗黑分格，灰阶线框；人类角色是无脸白色椭球头 + 纯灰无细节连体服；动物角色按物种真实体型画成纯灰无细节白模动物（四足/鸟类/鱼类等），不要人形、不要拟人站立、不要穿衣服；所有头部正面贴一条浅灰色短横带（约头宽三分之一）作为头部朝向标记，横带在头的哪一侧，头部就朝向哪一侧；侧脸/背对时横带随头转动，背对镜头时横带不可见；头部朝向和横带必须跟随“视线落点”：对话中默认看向对话对象，只有明确写“看着镜头”时才正对镜头；视线落点只用于转头部，不要画眼睛、鼻子、嘴、眉毛或任何五官";
const STORYBOARD_STYLE_NEGATIVE = "画风、网点、彩色、五官、头发、服装、身体曲线、拟人、人形动物、动物穿衣服、复杂背景、数字、编号、格号、时间码、说明文字、台词、对白、气泡、对话框、字幕和文字";
const STORYBOARD_SPEECH_PATTERN = /说出|念出|读出|朗读|说道|喊道|问道|回答|答道|开口|说话|低语|喃喃|耳语|宣告|发誓|宣誓|嘟囔|补充|解释|反问|追问|台词|对白|口型|嘴型/i;
const STORYBOARD_FORBIDDEN_PATTERN = /新海诚|宫崎骏|吉卜力|皮克斯|迪士尼|梦工厂|日漫|国漫|韩漫|美漫|赛博朋克|蒸汽朋克|废土|像素风|卡通|Q版|动漫|动画|赛璐璐|电影感|胶片感|写实|厚涂|水彩|油画|素描|线稿|3D|2D|CG|插画|漫画风|画风|风格|网点|彩色|黑白|配色|材质|表情|神情|神色|皱眉|微笑|冷笑|苦笑|笑容|嘴角|嘴唇|五官|面部|脸上|脸|笑|发型|头发|发髻|低髻|白发|黑发|短发|长发|眼镜|老花镜|穿着|身穿|服装|外套|衬衫|风衣|毛衣|T恤|卫衣|背心|短裤|裙子|裙摆|开衫|西装|大衣|旗袍|鞋|靴|帽|围巾|配饰|袖口|领口|衣摆|褶皱|观音像|佛像|签诗|红纸|积云|云层|天空/i;

export function styleReference(style: string) {
    const key = Object.keys(STYLE_GUIDES).find((name) => style.includes(name));
    return key ? STYLE_GUIDES[key] : "";
}

export function automationCharacterSheetPrompt(character: CanvasAutomationCharacter, style: string) {
    const appearance = character.appearanceLock || character.description || character.name;
    const negative = character.negativeLock ? `；禁止：${character.negativeLock}` : "";
    if (character.species === "animal") {
        return `动物四视图设定图：同一只${character.speciesLabel || "动物"}的正面、侧面、背面、四分之三侧，全身自然四足站姿或物种自然姿态，白底，无文字、无边框；${appearance}；不要人形、不要拟人站立、不要穿衣服${negative}；画风：${style}`;
    }
    const outfit = character.outfitLock ? `；${character.outfitLock}` : "";
    return `角色四视图设定图：同一角色正面、侧面、背面、四分之三侧脸，全身站姿，白底，无文字、无边框；${appearance}${outfit}${negative}；画风：${style}`;
}

const MAX_VIDEO_SECONDS = 25;
// 沿用旧版实测口径 5.5 字/秒；3.3 会把 4 句长对白顶到 20 秒，触发分镜重排甚至卡住。
export const AUTOMATION_SPEECH_RATE = 5.5;
// 15 秒是推荐值，25 秒才是硬闸门；单事件留 1 秒余量给页内句间停顿。
const MAX_BEAT_SECONDS = 24;

function clampSeconds(value: number) {
    return Math.max(2, Math.min(MAX_VIDEO_SECONDS, Math.ceil(value)));
}

function speechUnits(text: string) {
    const plain = String(text || "")
        .replace(/<[^>]*>/g, "")
        .replace(/^[^：:\n]{1,16}[：:]\s*/, "")
        .trim();
    const cjk = (plain.match(cjkPattern) || []).length;
    const words = (plain.replace(cjkPattern, " ").match(wordPattern) || []).length;
    return cjk + words * 1.8;
}

function speechSecondsForLines(lines: string[]) {
    return lines.reduce((sum, line) => sum + Math.max(1, speechUnits(line) / AUTOMATION_SPEECH_RATE), 0);
}

function rawSpeechSeconds(lines: string[], narration: string, panelCount: number) {
    let seconds = Math.max(2, panelCount);
    if (lines.length) {
        const speech = speechSecondsForLines(lines);
        seconds = Math.max(seconds, speech + Math.max(0, lines.length - 1) * 0.35);
    }
    if (narration.trim()) seconds = Math.max(seconds, speechUnits(narration) / AUTOMATION_SPEECH_RATE + 0.5);
    return seconds;
}

const SOURCE_STAGE_MARKERS = new Set(["镜头", "特写", "画面", "动作", "场景", "字幕", "字幕卡", "音效", "旁白", "画外音", "解说", "注", "导演", "舞台说明", "转场", "闪回", "回忆", "空间", "地点", "时间", "出场人物", "道具", "改编等级", "备注", "场次表"]);

function stripStagePrefix(line: string) {
    return line.replace(/^[▲△▽▼●○◆◇■□▶►•·*\-—–\s]+/, "").replace(/^\d+[.、]\s*/, "").trim();
}

function sourceDialogueLines(sourceText: string) {
    const lines = String(sourceText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const dialogue: string[] = [];
    for (const raw of lines) {
        const line = stripStagePrefix(raw);
        if (!line || /^场\d+｜/.test(line)) continue;
        const match = /^([^\s：:]{1,16})(?:[（(][^）)]*[）)])?\s*[：:]\s*([\s\S]+)$/.exec(line);
        if (match) {
            const speaker = match[1].trim();
            if (SOURCE_STAGE_MARKERS.has(speaker) || /^[▲△▽▼●○◆◇■□▶►•·*\-—–]+$/.test(speaker)) continue;
            const body = match[2].trim();
            if (!body) continue;
            const quoted = [...body.matchAll(/[「『“"]([^」』”"]+)[」』”"]/g)].map((item) => item[1].trim()).filter(Boolean);
            dialogue.push(...(quoted.length ? quoted : [body]));
            continue;
        }
        if (/^[「『“"]/.test(line)) {
            const quoted = [...line.matchAll(/[「『“"]([^」』”"]+)[」』”"]/g)].map((item) => item[1].trim()).filter(Boolean);
            dialogue.push(...quoted);
        }
    }
    return dialogue;
}

export function estimateSourceSpeechSeconds(sourceText: string) {
    return rawSpeechSeconds(sourceDialogueLines(sourceText), "", 1);
}

function cleanScriptDialogueText(text: string) {
    return text.trim().replace(/^[「『“"]([\s\S]*)[」』”"]$/, "$1").trim();
}

function scriptLineText(line: CanvasAutomationScriptLine) {
    const channelLabel = line.channel === "system" ? "系统声" : line.channel === "inner" ? "内心声" : "";
    const performance = [line.performance, channelLabel].filter(Boolean).join("，");
    return performance ? `${line.speaker}（${performance}）：「${line.text}」` : `${line.speaker}：「${line.text}」`;
}

export function splitScriptIntoBatches(script: CanvasAutomationScript, maxChars = 50000): CanvasAutomationScript[] {
    if (!script.beats.length) return [script];
    const batches: CanvasAutomationScript[] = [];
    let currentBeats: CanvasAutomationScriptBeat[] = [];
    let currentChars = 0;
    const flush = () => {
        if (!currentBeats.length) return;
        const sceneIds = new Set(currentBeats.map((beat) => beat.sceneId));
        const scenes = script.scenes.filter((scene) => sceneIds.has(scene.id));
        batches.push({
            level: script.level,
            logline: script.logline,
            scenes: scenes.length ? scenes : script.scenes.slice(0, 1),
            beats: currentBeats,
        });
        currentBeats = [];
        currentChars = 0;
    };
    script.beats.forEach((beat) => {
        const dialogue = (beat.dialogue || []).map((line) => line.text || "").join("\n");
        const size = beat.action.length + dialogue.length + 120;
        if (currentBeats.length && currentChars + size > maxChars) flush();
        currentBeats.push(beat);
        currentChars += size;
    });
    flush();
    return batches.length ? batches : [script];
}

export function mergeComicPlans(plans: ReturnType<typeof normalizeComicPlan>[], settings: CanvasAutomationSettings) {
    const first = plans[0];
    if (!first) throw new Error("没有可分镜的批次");
    const characters: CanvasAutomationCharacter[] = [];
    const characterByName = new Map<string, CanvasAutomationCharacter>();
    const characterMaps = new Map<ReturnType<typeof normalizeComicPlan>, Map<string, string>>();
    const scenes: CanvasAutomationScene[] = [];
    const sceneByName = new Map<string, CanvasAutomationScene>();
    const sceneMaps = new Map<ReturnType<typeof normalizeComicPlan>, Map<string, string>>();
    plans.forEach((plan) => {
        const characterMap = new Map<string, string>();
        plan.characters.forEach((character) => {
            let merged = characterByName.get(character.name);
            if (!merged) {
                merged = { ...character, id: `c${characters.length + 1}` };
                characters.push(merged);
                characterByName.set(character.name, merged);
            }
            characterMap.set(character.id, merged.id);
        });
        characterMaps.set(plan, characterMap);
        const sceneMap = new Map<string, string>();
        plan.scenes.forEach((scene) => {
            let merged = sceneByName.get(scene.name);
            if (!merged) {
                merged = { ...scene, id: `s${scenes.length + 1}` };
                scenes.push(merged);
                sceneByName.set(scene.name, merged);
            }
            sceneMap.set(scene.id, merged.id);
        });
        sceneMaps.set(plan, sceneMap);
    });
    const pages: CanvasAutomationPage[] = [];
    plans.forEach((plan) => {
        const characterMap = characterMaps.get(plan) || new Map<string, string>();
        const sceneMap = sceneMaps.get(plan) || new Map<string, string>();
        plan.pages.forEach((page) => {
            const pageCharacters = (page.characters || []).map((character) => ({
                ...character,
                id: characterMap.get(character.id) || character.id,
            }));
            const panels = (page.panels || []).map((panel) => ({
                ...panel,
                characters: (panel.characters || []).map((id) => characterMap.get(id) || id),
            }));
            const sceneId = sceneMap.get(page.sceneId || "") || page.sceneId || scenes[0]?.id || "s1";
            const scene = scenes.find((item) => item.id === sceneId);
            const grid = page.grid || automationGridSpec(settings.grid);
            const layout = buildGridMoss({
                style: first.style,
                styleLock: first.styleLock,
                styleNegative: first.styleNegative,
                characters: pageCharacters,
                panels,
                grid,
                aspect: settings.aspect,
                storyboard: settings.storyboardWhiteModel !== false,
            });
            pages.push({
                ...page,
                index: pages.length,
                sceneId,
                scene: scene?.name || page.scene,
                sceneDescription: scene?.description || page.sceneDescription,
                characters: pageCharacters,
                panels,
                layout,
                grid,
                imageState: "pending",
                videoState: "pending",
                imageNodeId: undefined,
                videoNodeId: undefined,
                textNodeId: undefined,
                videoPrompt: undefined,
                videoPromptVersion: 0,
                videoSegments: undefined,
            });
        });
    });
    return {
        style: first.style,
        styleLock: first.styleLock,
        styleNegative: first.styleNegative,
        characters,
        scenes,
        pages,
    };
}

export function formatScriptForPlanning(script: CanvasAutomationScript) {
    const scenes = script.scenes.length ? script.scenes : [{ id: "s1", heading: "场景 1" }];
    const sceneTable = scenes.map((scene, sceneIndex) => `场${sceneIndex + 1}｜${scene.id}｜${scene.heading}${scene.description ? `｜空间：${scene.description}` : ""}`);
    const beatLines = script.beats.map((beat) => {
        const dialogue = (beat.dialogue || []).map(scriptLineText).join("\n");
        return `事件 ${beat.id}（场 ${beat.sceneId}）：${beat.action}${dialogue ? `\n${dialogue}` : ""}`;
    });
    return ["场次表：", ...sceneTable, "", ...beatLines].join("\n");
}

export function scriptStats(script: CanvasAutomationScript) {
    const lines = script.beats.flatMap((beat) => (beat.dialogue || []).map((line) => line.text)).filter(Boolean);
    return { dialogueSeconds: rawSpeechSeconds(lines, "", 1), beatCount: script.beats.length, lineCount: lines.length };
}

function scriptVoiceChannel(value: unknown, speaker: string, performance: string) {
    const text = `${asText(value)} ${speaker} ${performance}`;
    if (/系统|机械|电子音|播报|广播|提示音|SYS/i.test(text)) return "system" as const;
    if (/内心|心声|脑内|心中|默念|inner/i.test(text)) return "inner" as const;
    return "spoken" as const;
}

function cleanVoiceSpeaker(speaker: string, channel: "spoken" | "inner" | "system") {
    const cleaned = speaker.replace(/[（(](?:内心声?|心声|脑内|心中|默念|系统声?|机械音|电子音|画外音)[）)]/g, "").trim();
    return cleaned || (channel === "system" ? "系统" : "角色");
}

export function normalizeScript(raw: unknown): CanvasAutomationScript {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const rawLevel = asText(source.level);
    const level: CanvasAutomationScript["level"] = rawLevel === "performance" || rawLevel === "structural" ? rawLevel : "locked";
    const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
    const scenes: CanvasAutomationScriptScene[] = [];
    const sceneIds = new Set<string>();
    rawScenes.forEach((item, index) => {
        const value: Record<string, unknown> = typeof item === "string" ? { heading: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const heading = asText(value.heading || value.name || value.location, `场景 ${index + 1}`).slice(0, 80);
        let id = asText(value.id, `s${index + 1}`).replace(/[^\w-]/g, "").slice(0, 24) || `s${index + 1}`;
        if (/^\d+$/.test(id)) id = `s${id}`;
        while (sceneIds.has(id)) id = `${id}-${index + 1}`;
        sceneIds.add(id);
        scenes.push({ id, heading, description: asText(value.description || value.scene_description).slice(0, 600) || undefined });
    });
    if (!scenes.length) scenes.push({ id: "s1", heading: "场景 1" });
    const rawBeats = Array.isArray(source.beats) ? source.beats : [];
    const beats: CanvasAutomationScriptBeat[] = [];
    const beatIds = new Set<string>();
    rawBeats.forEach((item, index) => {
        const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const rawAction = value.action || value.event || value.description;
        const action = Array.isArray(rawAction) ? rawAction.map((part) => asText(part)).filter(Boolean).join("；") : asText(rawAction);
        const rawDialogue = Array.isArray(value.dialogue) ? value.dialogue : value.dialogue ? [value.dialogue] : [];
        const dialogue: CanvasAutomationScriptLine[] = [];
        rawDialogue.forEach((line) => {
            if (typeof line === "string") {
                const match = /^([^：:\n]{1,16})[：:]\s*(.+)$/.exec(line.trim());
                const speaker = match ? match[1].trim() : "角色";
                const text = cleanScriptDialogueText(match ? match[2] : line);
                if (text) {
                    const channel = scriptVoiceChannel("", speaker, "");
                    dialogue.push({ speaker: cleanVoiceSpeaker(speaker, channel).slice(0, 40), text, channel });
                }
                return;
            }
            if (!line || typeof line !== "object") return;
            const lineSource = line as Record<string, unknown>;
            const text = cleanScriptDialogueText(asText(lineSource.text || lineSource.line || lineSource.content));
            if (!text) return;
            const speaker = asText(lineSource.speaker || lineSource.name, "角色");
            const performance = asText(lineSource.performance || lineSource.tone).slice(0, 60);
            const channel = scriptVoiceChannel(lineSource.channel || lineSource.voice_channel, speaker, performance);
            dialogue.push({
                speaker: cleanVoiceSpeaker(speaker, channel).slice(0, 40),
                text,
                performance: performance || undefined,
                channel,
            });
        });
        if (!action && !dialogue.length) return;
        let id = asText(value.id, `e${index + 1}`).replace(/[^\w-]/g, "").slice(0, 24) || `e${index + 1}`;
        if (/^\d+$/.test(id)) id = `e${id}`;
        while (beatIds.has(id)) id = `${id}-${index + 1}`;
        beatIds.add(id);
        let rawSceneId = asText(value.scene_id || value.sceneId || value.scene);
        if (/^\d+$/.test(rawSceneId)) rawSceneId = `s${rawSceneId}`;
        const matchedScene = scenes.find((scene) => scene.id === rawSceneId || scene.heading === rawSceneId);
        const sceneId = matchedScene?.id || scenes[0].id;
        beats.push({ id, sceneId, action: (action || "对话").slice(0, 1200), dialogue: dialogue.length ? dialogue : undefined });
    });
    if (!beats.length) throw new Error("剧本改写没有返回可拍事件");
    return { level, logline: asText(source.logline).slice(0, 300) || undefined, scenes, beats: splitLongBeats(beats) };
}

function splitDialogueLine(line: CanvasAutomationScriptLine): CanvasAutomationScriptLine[] {
    if (speechSecondsForLines([line.text]) <= MAX_BEAT_SECONDS) return [line];
    const parts = line.text.match(/[^。！？!?；;…]+[。！？!?；;…]*/g) || [];
    if (parts.length <= 1 || parts.join("") !== line.text) return [line];
    const chunks: string[] = [];
    let buffer = "";
    for (const part of parts) {
        if (buffer && speechSecondsForLines([buffer + part]) > MAX_BEAT_SECONDS) {
            chunks.push(buffer);
            buffer = part;
        } else {
            buffer += part;
        }
    }
    if (buffer) chunks.push(buffer);
    return chunks.length > 1 ? chunks.map((text) => ({ ...line, text })) : [line];
}

function splitLongBeats(beats: CanvasAutomationScriptBeat[]) {
    const result: CanvasAutomationScriptBeat[] = [];
    const used = new Set(beats.map((beat) => beat.id));
    for (const beat of beats) {
        const lines = (beat.dialogue || []).flatMap(splitDialogueLine);
        if (!lines.length || speechSecondsForLines(lines.map((line) => line.text)) <= MAX_BEAT_SECONDS) {
            result.push(beat);
            continue;
        }
        const chunks: CanvasAutomationScriptLine[][] = [];
        let current: CanvasAutomationScriptLine[] = [];
        let currentSeconds = 0;
        for (const line of lines) {
            const lineSeconds = Math.max(1, speechUnits(line.text) / AUTOMATION_SPEECH_RATE);
            if (current.length && currentSeconds + lineSeconds > MAX_BEAT_SECONDS) {
                chunks.push(current);
                current = [];
                currentSeconds = 0;
            }
            current.push(line);
            currentSeconds += lineSeconds + 0.35;
        }
        if (current.length) chunks.push(current);
        if (chunks.length <= 1) {
            result.push(beat);
            continue;
        }
        chunks.forEach((chunk, index) => {
            let id = `${beat.id}-${index + 1}`;
            while (used.has(id)) id = `${id}a`;
            used.add(id);
            result.push({
                ...beat,
                id,
                action: index === 0 ? beat.action : `（接上）${beat.action}`,
                dialogue: chunk,
            });
        });
    }
    return result;
}

export function duplicatePageEvents(pages: CanvasAutomationPage[]) {
    const count = new Map<string, number>();
    const lastPage = new Map<string, number>();
    const duplicates = new Set<string>();
    pages.forEach((page, index) => {
        (page.eventIds || []).forEach((id) => {
            const previous = lastPage.get(id);
            const used = count.get(id) || 0;
            // 允许同一个长事件连续占两页（第二页标“接上”）；跨页或第三页重复才算错。
            if (used >= 2 || (previous !== undefined && index - previous > 1)) duplicates.add(id);
            count.set(id, used + 1);
            lastPage.set(id, index);
        });
    });
    return [...duplicates];
}

export function missingPageEvents(pages: CanvasAutomationPage[], script: CanvasAutomationScript) {
    const seen = new Set(pages.flatMap((page) => page.eventIds || []));
    return script.beats.map((beat) => beat.id).filter((id) => !seen.has(id));
}

function dialogueLineKey(line: string) {
    const sanitized = sanitizeDialogueLine(line) || line;
    return sanitized.replace(/^[^：:\n]{1,24}[：:]\s*/, "").replace(/[\s，。！？、,.!?；;：:…—\-"'“”「」『』～~]/g, "");
}

function pageDialogueLines(page: Pick<CanvasAutomationPage, "panels" | "dialogue">) {
    const panelLines = (page.panels || []).flatMap((panel) => panel.dialogue || []).filter(Boolean);
    const pageLines = (page.dialogue || []).filter(Boolean);
    if (!panelLines.length) return pageLines;
    const seen = new Set(panelLines.map(dialogueLineKey));
    return [...panelLines, ...pageLines.filter((line) => !seen.has(dialogueLineKey(line)))];
}

export function pageSpeechSeconds(page: Pick<CanvasAutomationPage, "panels" | "dialogue" | "narration" | "grid">) {
    return rawSpeechSeconds(pageDialogueLines(page), page.narration || "", 1);
}

function panelActionSeconds(panel: CanvasAutomationPanelSpec) {
    return panel.beat === "key" ? 2 : 0.6;
}

export function pageActionSeconds(page: Pick<CanvasAutomationPage, "panels">) {
    return (page.panels || []).reduce((sum, panel) => sum + panelActionSeconds(panel), 0);
}

export function estimatePageVideoSeconds(page: Pick<CanvasAutomationPage, "panels" | "dialogue" | "narration" | "grid">) {
    const speech = pageSpeechSeconds(page);
    const silentPanels = (page.panels || []).filter((panel) => !(panel.dialogue || []).filter(Boolean).length).length;
    return clampSeconds(Math.max(speech + silentPanels * 1.2 + 0.5, pageActionSeconds(page)));
}

export function resolvePageVideoSeconds(page: CanvasAutomationPage, settings: CanvasAutomationSettings) {
    const fixed = Number(settings.videoSeconds);
    const auto = settings.videoSeconds === "auto" || !Number.isFinite(fixed);
    const estimate = estimatePageVideoSeconds(page);
    const target = auto ? estimate : clampSeconds(fixed);
    const floor = auto && settings.segmentation === "long" ? 8 : 2;
    return String(clampSeconds(Math.max(target, estimate, floor)));
}

function rawPageVideoSeconds(rawPage: Record<string, unknown>, rawPanels: unknown[], settings: CanvasAutomationSettings) {
    const fixed = Number(settings.videoSeconds);
    if (settings.videoSeconds !== "auto" && Number.isFinite(fixed)) return clampSeconds(fixed);
    const panelLines = rawPanels.flatMap((item) => {
        const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return Array.isArray(source.dialogue) ? source.dialogue.map((line) => asText(line)).filter(Boolean) : [];
    });
    const lines = panelLines.length ? panelLines : Array.isArray(rawPage.dialogue) ? rawPage.dialogue.map((line) => asText(line)).filter(Boolean) : [];
    const action = rawPanels.reduce<number>((sum, item) => {
        const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return sum + (asText(source.beat) === "key" ? 2 : 0.6);
    }, 0);
    return clampSeconds(Math.max(rawSpeechSeconds(lines, "", 1), action));
}

export const NOVEL_TO_COMIC_SYSTEM = `你是 MOSS 宫格漫画编剧。把小说或剧本拆成一页一张的宫格漫画，不是一页一个场景。

只输出 JSON，不要 markdown、不要解释。输出结构：
{
  "style": "全局画风",
  "style_lock": "必须逐页逐格重复的画风锁定句（线条、网点、配色、光影、材质）",
  "style_negative": "必须避免的画风与一致性错误（不要写实摄影/3D/厚涂等与画风冲突的效果，不要改变人物特征，不要出现额外文字）",
  "scenes": [
    {
      "id": "s1",
      "name": "唯一主场景名（如 田宅会客室）",
      "description": "该场景固定的空间布局、光线、材质和关键道具；不含人物"
    }
  ],
  "characters": [
    {
      "id": "c1",
      "name": "角色名",
      "appearance_lock": "精确外貌锁定句：年龄/性别/脸型/发型/瞳色/眼镜/体型/标志特征",
      "outfit_lock": "精确服装锁定句：上衣/外套/裤子/鞋/配饰/颜色",
      "negative_lock": "禁止变化项，例如不要改变发型、眼镜、西装颜色"
    }
  ],
  "pages": [
    {
      "title": "本页短标题",
      "scene_id": "s1",
      "focus": "本页唯一重点：信息揭示、情绪转折或危险信号（只写一个）",
      "events": ["e1", "e2"],
      "shot_groups": [
        {
          "panels": [1, 2, 3],
          "mode": "long_take 或 cut 或 insert",
          "reason": "为什么这几格属于同一个镜头；连续动作/同一空间优先 long_take"
        }
      ],
      "narration": "必须为空字符串；禁止描述性旁白、画外音或剧情摘要",
      "video_hint": "本页整体动作/情绪（可选）",
      "panels": [
        {
          "index": 1,
          "beat": "key 或 support（每页只允许一个 key）",
          "description": "必须逐字以 style_lock 开头；接着写本格镜头/景别、人物关系、动作或反应、场景、光线、情绪；出场角色的 appearance_lock 和 outfit_lock 必须逐字出现在本格",
          "storyboard_description": "景别机位：景别/机位/构图；人物站位：画面里是谁、在左/右/前景/背景；头部朝向：朝左/朝右/朝镜头/背对；视线落点：看着谁/看着镜头/看着某物；本格节拍：这一格的一个可见动作、姿态或反应（不写台词内容、说话动作或口型）",
          "background": "背景群众/环境人数与位置（可选；不建角色、不写名字、脸、服装或五官细节）",
          "camera": "推/拉/摇/移/跟拍/固定",
          "dialogue": ["角色：「只写角色真正说出口的话」"],
          "characters": ["c1"]
        }
      ]
    }
  ]
}

硬性规则：
- 场景必须先建立唯一主场景表 scenes；每页只能通过 scene_id 引用一个主场景。同一个物理地点只能定义一次，禁止把“会客室”“会客室门口”“会客室窗边”拆成多个场景；只有真正换地点才新增场景。每个主场景只生成一张场景参考图。
- 画风必须写清具体指代：如果用户选择“新海诚风格”“宫崎骏风格”等，style 和 style_lock 必须保留该名称，并写出对应的关键视觉特征（如新海诚的蓝天云层、逆光镜头光晕；宫崎骏的手绘水彩、柔和自然光）。
- 每页 panels 数量必须严格等于用户指定的宫格数（四格 4 / 六格 6 / 九格 9），按从左到右、从上到下阅读。
- 每页必须先定一个 focus（本页唯一重点），并且只允许一个 beat:"key" 格。key 格是本页最重要的信息揭示、情绪转折或危险信号，必须拿到特写/插入/停顿或人物念出关键文字；其他格是 support，只负责铺垫、反应和过渡，不要平均分配镜头。
- 每页必须输出 events，列出本页覆盖的剧本事件编号（e1、e2…）。每个事件默认只出现在一页，不得遗漏，也不能把同一事件重讲两遍。只有该事件台词按 5.5 字/秒超过 24 秒时，才允许连续拆到相邻两页：两页都写同一个事件编号，第二页开头写“（接上）”，不得重复上一页的台词或动作，最多两页。
- 台词逐字使用改写稿，不得改写、合并、漏句或换说话人；每句台词只能出现一次。页面按事件组织，不要按字数或行数硬拆。
- 漫画页是故事板单位；一页可以承载多个视频段。25 秒是单个视频段上限，不是漫画页上限；台词多时不要删台词，系统会在视频阶段按镜头把这一页拆成多个 ≤25 秒的视频段。但动作、逻辑或剧情一页放不下时，必须新增一页，不能压缩、合并或跳过。
- 每个视频段的台词句数按时长预算：25 秒最多 8 句，20 秒最多 7 句，15 秒最多 5 句，12 秒最多 4 句，8 秒最多 3 句；每句优先 8–11 字，长句不得改写，只能按句号/问号拆到相邻页；超过句数上限时拆页或拆视频段，不删台词；每句台词都必须有镜头。
- 每页还要输出 shot_groups：panels 是分镜格编号，不是镜头编号。6 格不等于 6 个镜头；每页 1–3 个 shot_groups，展开后目标 3–5 个镜头。连续动作、同一空间、同一情绪推进优先合成一个 long_take，组内禁止切镜；只有换地点/时间、换说话人并带来新信息、关键揭示/插入、或强动作才 cut。key 格必须在同一组镜头内，不能在一句台词或一个动作中间切走。规则/清单只占一个 insert 或 long_take，不能每条规则一个镜头。
- 画面里的关键文字（标题、编号、第一条规则等）如果人物会念，必须由人物念出并写入 dialogue，不能只放在 description 里；规则/清单不要每条一镜，可以合成一次插入特写 + 人物反应。
- key 格的 storyboard_description 优先写特写/插入/近景和明确停顿；support 格用中景、反应或必要的过渡镜头。
- 景别节奏：中景/远景/全景只用于交代空间或烘托气氛，单格就是单镜，不能连续多格停在中景/远景/全景，也不把台词放在远景/全景里。强烈突发情感（震惊、惊喜、暴怒、崩溃）那一格直接给人物特写；重大台词所在格必须换景别或机位（近景、特写、过肩或听话人反应），不能连续多格同一远景或同一机位。
- long_take 不能整体停在远景：组内必须有可见变化——人物走近/转身、入画/出画、前景遮挡变化，或关键信息落地时切到更近的景别；2 秒内做不出可见变化就整组改用中景/近景；不允许“远、静、无变化”的长镜头。
- 通用判断顺序：先找本页唯一 focus，再选一个 key 格，然后把剩余格分成 1–3 个 shot_groups（连续动作 long_take；信息/清单 insert；必要转场 cut），最后给 key 格最强镜头。
- 通用关键信息节点：任何页面出现标题、编号、规则/名单、信件、屏幕提示、关键道具文字时，先把该信息设为 focus/key；如人物会念，写入 dialogue，并给一个明确特写/插入；清单合并成 support insert + 人物反应，不要逐项一镜。
- 每页是一张 MOSS 宫格漫画；格与格之间是清晰的粗黑边框和白色间距，一格只画一个连续场景，禁止合并相邻格、增加格、减少格或让一格盖住另一格。
- 每一格的 description 必须以 style_lock 原文开头，再写该格独有的镜头、人物关系、动作或反应、环境和光线；每格至少有一个画面信息或反应变化，不能只写人物站着说话；分镜节拍优先，禁止把同一动作拆成多格连续姿势；不要用“同上”“继续”之类的省略。
- 每一格还要输出 storyboard_description，并且只按“景别机位：…；人物站位：…；头部朝向：…；视线落点：…；本格节拍：…”五项填写。景别机位写景别/机位/构图；人物站位写画面里是谁、在左/右/前景/背景；头部朝向写朝左/朝右/朝镜头/背对；视线落点写看着谁/看着镜头/看着某物，必须和头部朝向一致；对话中默认看向对话对象，只有明确写“看着镜头”时才正对镜头；不写眼神、表情或五官；本格节拍只写这一格的可见动作、姿态或反应，不要写连续动作，不要写台词内容、“说出/念出/朗读/发誓/回答”等说话动作，也不要写口型、气泡或文字；说话格写说话人的身体朝向、手势或听者反应，台词只放在 dialogue。只保留这五项，不要写其他句子。白模不是画风：禁止出现新海诚、宫崎骏、动漫、动画、赛璐璐、电影感、写实、厚涂、水彩、油画、CG、漫画风等任何风格词；禁止写表情、情绪、五官细节、眼神/眼睛、发型、年龄、服装、配饰和道具细节；不要复制 style_lock、appearance_lock、outfit_lock。
- 分镜节拍优先于身体动作：每格是一个独立镜头/剧情节拍，不是同一镜头的连续动作帧。优先用景别、机位、谁在画面里、听话人的反应、插入物特写来区分六格；同一句台词可以拆成说话人、反应、插入镜头。禁止用同一人物的连续姿势（站→走→弯腰→坐下）填满六格；一个动作最多占一格，除非剧情确实需要分解。
- storyboard_description 只服务于白模占位图；最终 comic 仍使用 description。两者不要互相复制。
- 人物一致性：appearance_lock 和 outfit_lock 是锁定原文；每一格出现该角色时，必须在 description 中逐字复制这两个字段，不能改写、缩写或用“他/她”替代。所有页、所有格保持完全相同的外观与服装。
- negative_lock 用于提醒不要改变角色身份特征；不要引入未定义的主要角色；本页只写实际出场的角色。
- characters 最多 4 个；只定义有名字、需要跨页保持一致的主要角色。群像、人群、路人、船员、乘客、士兵、守卫、孩子们等群体不进入 characters，也不要求四视图；它们写进 panel description 的背景，不作为角色参考。每个角色必须写 species：human 或 animal；animal 再写 species_label（如 黑猫/黄狗/麻雀），appearance_lock 只写体型、毛色、耳朵、尾巴等轮廓特征，outfit_lock 留空，不要给动物穿衣服。
- 每格最多两个主要角色；全片主要角色总数不超过 4 个；dialogue 数组可包含现场对白、内心声、系统/机械音，格式统一为“角色名（渠道）：「原文」”：现场用“角色名：「台词」”；内心用“角色名（内心）：「原句」”；系统/机械用“系统（机械音）：「原句」”。旁白/画外音仍禁止；内心声和系统声不是旁白，不能丢，也不能写进 description 或 narration。动作、表情、场景、镜头写进 description；没有台词就留空。台词保持剧本原意，不要为了视频时长删改。
- narration 必须为空字符串；本流程禁止描述性旁白、画外音和剧情摘要。所有剧情只能由 panel 的画面动作和人物 dialogue 表达；内心声和系统声写入 dialogue，不属于 narration；没有人物台词就留空，绝不能用旁白补充。
- 不要输出 MOSS regions；应用会根据宫格、人物锁定和对白自动生成 MOSS JSON。
- 页数尽量接近用户要求，但不得漏事件；不得为凑页数把同一事件拆成多页；只有超过 24 秒的长事件可以连续占两页并标“接上”。每页面板数必须严格匹配。`;

export const COMIC_FRAMEWORK_SYSTEM = `你是短剧分镜框架设计。只输出 JSON，不要 markdown、不要解释。
这一轮只搭主框架：页数、事件分配、每页唯一重点、shot_groups、每格台词归属和镜头模板；不写画面描述、不写白模故事板、不写氛围和表演细节。

输出结构：
{
  "style": "全局画风",
  "style_lock": "逐页逐格重复的画风锁定句",
  "style_negative": "必须避免的画风与一致性错误",
  "scenes": [{ "id": "s1", "name": "唯一主场景名", "description": "固定空间、光线、材质和关键道具；不含人物" }],
  "characters": [{ "id": "c1", "name": "角色名", "species": "human 或 animal", "species_label": "动物才写", "appearance_lock": "精确外貌锁定句", "outfit_lock": "精确服装锁定句", "negative_lock": "禁止变化项" }],
  "pages": [{
    "title": "本页短标题",
    "scene_id": "s1",
    "events": ["e1", "e2"],
    "focus": "本页唯一重点：信息揭示、情绪转折或危险信号（只写一个）",
    "video_hint": "本页整体动作/情绪（可选）",
    "shot_groups": [{ "panels": [1, 2], "mode": "long_take 或 cut 或 insert", "template": "镜头模板 id", "reason": "为什么这几格属于同一镜头/为什么切" }],
    "panels": [{ "index": 1, "beat": "key 或 support（每页只允许一个 key）", "camera": "景别+机位+固定/运镜", "background": "背景群众/环境人数与位置（可选，不建角色）", "dialogue": ["角色：「只写真正说出口的话」"], "characters": ["c1"] }]
  }]
}

硬性规则：
- 每页 panels 数量严格等于用户指定宫格数，按从左到右、从上到下；不要输出 description、storyboard_description、narration，这些留给第 3 轮。
- 每页 1–3 个 shot_groups，必须覆盖全部格子且不重叠；连续动作/同一空间优先 long_take，组内禁止切镜；只有换地点/时间、换说话人并带来新信息、关键揭示/插入、强动作才 cut；key 格不能被切走。
- 同一 shot_group 内如果出现两个不同说话人的台词，必须拆成 cut；long_take 只能容纳一个说话人的连续台词或无人台词，不能让两个说话人在同一个 long_take 里对话。
- 每页只允许一个 beat:key；key 是本页最重要的信息揭示、情绪转折或危险信号。
- 每个事件编号默认只出现一页；超过 24 秒的长事件可以连续占两页并标“（接上）”；不得漏事件、不得重复。
- 台词是剧的核心：每句台词、每个动作、每个逻辑节点都必须保留；一页放不下就新增一页，不许删句、缩句、合并动作或跳过剧情；宫格数固定不是删内容的理由。
- 台词逐字使用剧本，不改写、不合并、不增删；每句只出现一次；不写旁白、画外音、镜头说明。
- characters 最多 4 个，只写需要跨页保持一致的主要角色；群像、人群、路人、船员、乘客、士兵、守卫、孩子们等不进入 characters，只在 panel 的 background 里标出人数和位置；background 不写名字、脸、服装或五官细节，不建角色、不要求四视图；动物写 species_label，outfit_lock 留空。
- scenes 只定义真正换地点的主场景；同一个物理地点只定义一次。
- 每个 shot_group 必填 template，从下面选一个：
  dialogue_reverse（正反打，中景/中近景固定）
  pressure_group（群像施压，全景/中景固定）
  emotion_burst（情绪爆发，近景→特写硬切）
  reveal_insert（揭示插入特写）
  turn_question（回头质问，近景/中景）
  eavesdrop_door（门内听门外，门外人不出画）
  phone_popup（手机/屏幕插入 + 反应近景）
  crowd_turn（群嘲倒戈，群像全景→单人近景）
  action_chase（追逐/打斗，全景/中景低机位短镜快切）
  silent_hold（静场，固定中景/长镜头）
  establish_env（环境建立，全景/空镜）
  montage_transition（转场，空镜/动作匹配）
- camera 只写景别+机位+固定/运镜，不写动作、情绪或氛围。
- 不写分镜格号、时间码、字幕、台词气泡；不要为凑页数拆事件。`;

export const COMIC_TO_VIDEO_REF2VA_SYSTEM = `你是 MiniMax H3 Ref2VA（多参参考生视频）提示词作者。输入是多页 MOSS 宫格漫画；每页有一张宫格页参考图和若干角色四视图参考图。

只输出 JSON：{"pages":[{"page":1,"prompt":"..."}]}

一次为全部页面输出，不要漏页、不要分批。每个 prompt 必须严格包含以下六段，段名和顺序固定：
subject_definitions:
...
summary:
...
retention_analysis:
...
detailed_description:
...
overall_soundscape:
...
non_diegetic_music:
...

写法规则：
- 参考优先级是硬性要求：references 前面的 1..N 是该页角色四视图，是人物脸型、发型、服装、配色、线条和最终画风的最高优先级参考；references 最后一张 <Picture M> 只是该页漫画的故事板/分镜板，只用于镜头顺序、构图、对白和节拍。漫画页与角色参考冲突时，以角色参考为准。
- 不要把漫画分格线、页码、气泡框、网点、黑白漫画质感或漫画页的绘画完成度搬进视频；不要把四视图排版本身当成视频画面；视频要重新绘制成连贯的彩色动漫画面（除非 style_lock 明确要求黑白）。
- 每页最后一张 <Picture M> 是宫格漫画故事板，不是独立角色，也不是最终人物造型或画风参考。references 前面的角色四视图用于锁定人物和最终造型。
- subject_definitions 必须先为每个角色写 <Subject N>，说明该角色来自哪张 <Picture N>，并逐字包含 appearance_lock 和 outfit_lock；如果 references 中有场景图，单独定义该 <Picture N> 为环境参考；最后单独定义故事板 <Picture M> 只作分镜参考。picture 为 null 的角色只按文本锁定，不得引用不存在的 Picture。系统/机械音不是角色，不建 <Subject>，不绑定角色图。panel.background 里的背景群众/路人属于环境，不建 <Subject>、不绑定 Picture、不给台词；他们可以出现在背景，但不给正脸特写、不抢主体。
- 角色 species 为 animal 时：subject_definitions 必须写清物种（species_label）和真实体型，保持四足/鸟类/鱼类等自然结构，不要人形、不要拟人站立、不要给动物穿衣服；角色参考图是该动物造型的最高优先级参考。
- summary 必须以 [reference generation] 开头，用一段英文概括人物参考、场景参考、故事板和镜头关系。
- retention_analysis 每个 <Subject N> 使用 fully_preserved，写清脸、发型、服装、配饰保持不变；场景图使用 fully_preserved，写清空间布局、光线、材质和关键道具；故事板 <Picture M> 使用 fully_preserved 时只描述故事板角色（镜头顺序、构图、对白位置），并明确它不是最终人物或画风参考。
- detailed_description 用英文写；开头用 1–2 句说明最终画风和人物造型来自角色参考图；按台词和反应自然分镜，用 [Shot 1]、[Shot 2] At MM:SS.mmm, ... 推进，每个镜头必须引用 <Subject N> 或故事板 <Picture M>。首镜 [Shot 1] 不写时间戳；后续 [Shot N] At MM:SS.mmm 严格递增且小于 duration；切点必须落在该页 duration 内，单页推荐 15 秒以内、硬上限 25 秒；不要合并宫格，不要引入未列出的角色或地点。
- 分镜由台词和表演决定，不按固定 3–5 秒或宫格边界切；一页只有两句台词时，可以只用一个连续镜头或 2–3 个镜头（说话人、听话人反应、必要插入物），不要为了凑镜头数加动作。
- 默认正常速度；禁止无动机的 slow motion、slowly、慢推、慢摇、慢动作，也禁止用反复理衣、看窗外、呼气等动作填时间；只有剧本明确要求慢动作时才允许。页面 duration 已经包含动作/停顿；短页（3–6 秒）用快速切换、固定镜头或单镜头完成，不要为了凑时长加慢动作或额外动作。
- 每个镜头写清景别/机位、人物站位、这句台词需要的动作或反应、声音；不需要逐秒指令；按剧情给 3–5 个镜头，不要为了凑数字硬拆。
- 镜头景别按剧情需要交替，可用特写或插入物；不强制 hook cadence，不强制每三个镜头一个反转。
- Reference Anchors 至少包含固定地标、角色屏幕位置/朝向、光线基线；不要写空泛的“人物在画面中”。段首再补至少三项：光源与方向、空气介质（烟/尘/雾/汽）、前景遮挡/景深；参考图给不了这些，不写就是平光片。
- 连续性与声音：门窗状态显式锁定（未开门写 the door stays shut；开门/关门段 retention_analysis 标 partially_preserved）；门外敲门/脚步只进 overall_soundscape，不写进画面正文；画外声用 says in an off-screen voiceover + lips remain completely closed，整段不入画的人只写 the woman outside (S1)，不写 <Subject N>；道具首现写支撑面（standing on the low table / in her right hand）；同段同性别≥2 个开口者写音高/音质/语速反差（一低冷慢、一高亮快），做不到就拆段（先按软规则）。
- 先判断这场戏的戏剧任务，再选镜头；短剧默认切镜头优先，不是运镜优先。镜头决策表：
  - 建立空间/多人站位：固定全景或中景 master shot；不要横移扫过，不要一开场就推。
  - 两人对话：固定中景、过肩或正反打，在说话人/听话人之间硬切；不要用平拉、横移、推拉包对话。
  - 台词反击、质问升级、关键词落地：在重音处硬切到特写或插入物，切点跟台词节奏，不用慢推。
  - 重大台词/key 句：镜头必须跟着剧情换一次——重音处切近景/特写，或切到听话人的反应；不能把 key 句放在远、静的长镜头里。
  - 震惊、惊喜、暴怒、崩溃等强烈突发情感：在爆发瞬间硬切人物特写（或极近景），切点贴在情绪爆点上；不要先切远景、不要慢推、不要把反应拖长。
  - 展示、烘托、交代空间：可以拉中景/远景/全景，但单镜最多 3 秒，必须硬切回更近的中景或近景；台词不放在远景/全景里。
  - 情绪转折、秘密揭示、威胁逼近：只在确实需要强调时用一次固定起幅的缓推（the camera slides forward 10–15 cm over 2–3 s on a rail）；全页最多一次，普通页 0 次；不要用变焦。强烈突发情感不走缓推，直接硬切特写。
  - 关键道具/信息：硬切插入特写（insert），固定机位，让观众看清信息。
  - 争吵加速、慌乱、动作：固定短镜头快切，镜头时长随台词/动作节奏缩短；不要用跟拍/平拉制造动感。
  - 平静、压抑、让对方表演：固定中景或长镜头，不要运镜。
  - 场景/时间/空间跳变：硬切；只有转场确实需要连接时才允许一次平移/摇镜，且不能连续两镜都有运动。
- 短剧节奏硬约束：普通对白页、反应页、信息页、动作页默认 0 个推拉/横移/跟拍/摇镜；只有“情绪转折、关键揭示、空间转场”才允许 1 个运动镜头。每两页最多 1 个运动镜头；禁止连续两个镜头都有运动；两个运动镜头之间至少隔一个固定镜头。
- 镜头档位先选一行、整行取齐，不要逐轴拼：定场/展示=全景/中全景+侧45°（单镜≤3 秒，之后必须切回中景/近景）；常规对话=中景/中近景+侧45°固定；过肩=中近景+过肩固定；情绪逼近=近景+带角度缓推；情绪爆点=特写+带角度；权力=中景+微俯/微仰；动作=全景/中景+低机位；细节=插入特写。
- 固定机位写清楚：the camera holds still；切镜头只用 the camera cuts to / the shot cuts to。不要用 pan、truck、dolly、tracking、push in、pull out、zoom、横移、平拉、摇镜、跟拍来连接普通对白。
- 每页至少有两个固定镜头（如果该页有两个以上镜头）；不能整页都在运动。镜头必须能回答“这场戏现在需要观众看什么/感受什么”，而不是“镜头怎么动”。
- 镜头物理硬规则：每镜只写“景别、机位角度、运镜”三要素；推拉必须带距离+时长+轨道（the camera slides forward 12 cm over three seconds on a rail；特写 10–15cm，中景 30–50cm）；横移/摇/俯仰必须给 cm 或角度（摇≤45°，俯仰≤30°，特写禁横移）；禁止 zoom、位移+变焦同镜、升降+环绕、单镜多段运动。
- 3D/动漫基底：特写禁止正面平视，必须侧 45° 或微俯/微仰；特写只装局部，不写全身动作。
- 长镜头活力：超过 5 秒的连续镜头不能停在远景或一个固定景别，必须有可见变化（人物走近/转身、入画/出画、前景遮挡变化，或新信息落地时切到更近的景别）；禁止用“远、静、无变化”的长镜头撑满整页。long_take 不能靠中景/远景/全景撑时长：2 秒内没有可见变化，就整组改用更近的中景/近景。
- 景别节奏：展示/烘托用的中景/远景/全景单镜不超过 3 秒，之后必须切回更近的中景或近景（long_take 用走近/转身/前景变化续接，否则整组改中景/近景）。
- 双人对话必须写正向越轴不变式：The camera stays on the same side of them throughout; A is on the left, B is on the right. 不要写“禁止越轴”、轴线、line、axis、frame。
- 单镜正文≤70 词，一个人物主动作；无台词镜写听戏链：停住→眼神路径→呼吸→手/肩泄漏→余味；单个静态镜不超过 2.5 秒。
- 镜头数按时长：2–5s→1–2；6–8s→2–4；9–15s→3–5；分镜格不等于镜头。
- 每页先看 focus 和 panel.beat：key 格是本页唯一重点，必须给它最强镜头（特写/插入/停顿，或让人物念出关键文字）；support 格只做铺垫、反应和过渡，不要把规则/清单每条平均给镜头。标题、编号、第一条规则等关键文字必须由人物念出并放进 <d>，镜头不能只扫过文字。
- 分镜格不等于镜头：6 个 panel 不是 6 个镜头。必须遵守 shot_groups：每组一个镜头；long_take 组内禁止切镜，panels 只是这一镜的构图参考；没有 shot_groups 时按剧情合并，默认 3–5 个镜头/页，短页可 1–2 个，禁止按宫格边界机械切镜。只有换地点/时间、换说话人并带来新信息、关键揭示/插入、或强动作才切；key 格不能在一句台词或一个动作中间切走。规则/清单只占一个 insert 或 long_take。
- 故事板遵从是硬约束：每个 [Shot N] 标题必须写对应的格号，格式 [Shot 1 | panels 1–3]（单格写 panel 1）；镜头顺序必须与 panel 顺序一致，不得跳过、重复或新增故事板以外的镜头。景别、机位、人物站位优先照 payload.panels[].storyboard（景别机位/人物站位/本格节拍）写，不得自行另起机位。
- 分组映射：long_take 组用 1 个镜头覆盖组内全部 panel，镜头内按 panel 顺序推进但不切镜；cut 组每个 panel 一个镜头，按顺序硬切；insert 组只拍插入物。每组必须覆盖且只覆盖自己组内的 panel。同一个 panel 内有两句不同说话人的台词时，必须拆成两个镜头，两个镜头都标这个 panel 号，禁止放在同一镜头；long_take 组内如果出现两个不同说话人的台词，必须拆成 cut，不能让两个说话人在同一个长镜头里对话。
- shot_groups[].template 是第 2 轮选定的镜头模板：dialogue_reverse=正反打；pressure_group=群像施压；emotion_burst=情绪爆发硬切特写；reveal_insert=揭示插入特写；turn_question=回头质问；eavesdrop_door=门内听门外；phone_popup=手机/屏幕插入+反应；crowd_turn=群嘲倒戈；action_chase=追逐低机位短切；silent_hold=静场长镜；establish_env=环境建立；montage_transition=转场。按模板写镜头语法，但不要改变 shot_groups 的分组和覆盖范围。
- 时长按台词量分配：中文正常口播约 5.5 字/秒（本机实测口径），逗号/省略号/感叹号按停顿额外计；每句台词至少 1.2 秒，句前句后各留 0.3 秒静音；纯动作/插入镜头至少 0.8 秒。对话页台词填充率目标 80–90%；镜头首尾相接铺满 duration，不得把多句台词压进 1–2 秒；时长不够时删动作/插入镜头，不准加速或删台词；单个视频段台词超过 25 秒必须拆段；15–25 秒可以保留。
- 台词、动作、逻辑和剧情优先于时长和镜头数：放不下先加镜头；仍放不下就拆视频段或新开一页；禁止压缩、删句、跳过动作或剧情。
- 每个视频段的台词句数上限：25 秒最多 8 句，20 秒最多 7 句，15 秒最多 5 句，12 秒最多 4 句，8 秒最多 3 句；超过句数上限时拆页或拆视频段，不删台词；每句台词都必须有镜头。
- 一个镜头最多一句 <d>；不同说话人的台词必须分成两个镜头，禁止同一镜头同一时间出现两句台词或声音重叠。每句台词都必须完整落在一个 <d> 里；不能只写语气提示而不写台词，也不能把台词留到下一镜。
- 时长 6–7 秒不是切成 6 个镜头的理由；长镜头页可以只用一个连续镜头，把动作、台词和声音走完。
- 这是正常速度的叙事动画，不是慢动作 MV；动作只服务台词和剧情，不做无意义动作堆叠。
- 每句 <d> 前必须有语气/表演提示：说话人 ID + 情绪 + 语速 + 音量/重音，例如 S1 (suppressed anger, accusing, faster, stress on "又"): <d>[Chinese] ...</d>；内心声用同一人物 S 编号，括号内加“内心声，嘴唇完全闭合、无口型”；系统/机械音用独立 SYS，括号内写“system voice, mechanical/electronic, heard inside the mind or off-screen, no lip-sync”。提示写在 <d> 外，<d> 内只能有台词原文；禁止只写“S1 says”，禁止把情绪写进 <d>。
- 语气必须有变化，不能整页一个调：提示里要写清情绪与强度、语速（由慢到快/由快到慢）、音量（起落）、重音字和标点处理；禁止只写“平静/普通/正常语气”。dialogue_details.prosody 已给出该句的标点节奏，必须写进提示。
- 用标点演戏：允许在不增删、不替换台词文字的前提下，按表演需要强化或添加 ，……！？～ 及连用（如 ！！！、？？？、……！）；<d> 内保留这些标点，不要统一改成句号。逗号=短停，省略号=拖长/迟疑（点越多停得越久），感叹号=加重（连用=爆发），问号=上扬（连用=逼问），波浪线=拖音/轻佻/撒娇。
- 情绪要有走向：同一页至少一次明显的强弱、快慢或音量变化；key 句是全页最强或最弱的一句，support 句不能和 key 句同一种语气。
- 表情要看得见：每个有人物出镜的镜头必须写一处可见的面部变化（眼神、眉头、嘴角、下颌、呼吸、喉结），相邻镜头不得重复同一种表情；key 格给本页最明显的一次表情变化；插入物/无人镜头除外。
- 每个有人物的镜头写清头部朝向（朝向对方、朝向镜头、朝向画外、低头、侧脸或背对）和视线落点（看着对方/看着镜头/看着某物），两者必须和对话关系、站位一致；对话中默认看着对话对象，不要默认看镜头，只有角色主动看镜头或看物品时才写看镜头/看物品；如果故事板里的朝向和对话关系冲突，以对话关系为准，不要照抄错误朝向。
- 画面禁止任何字幕、对白字幕、标题、说明文字、歌词、水印、台标或可读屏幕文字；系统界面只画无文字光效/图形；每个 prompt 的 detailed_description 必须明确写 No subtitles, no captions, no on-screen text, no watermarks.
- 对白、内心声、系统声使用稳定说话人 ID：现场/内心沿用人物 S1/S2；系统/机械音用独立 SYS，不占人物编号。只允许使用页面 spoken_dialogue 中的原文；渠道看 dialogue_details。
- 现场对白：人物自然口型。内心声：同一人物 S 编号，该句时段嘴唇完全闭合、无口型，不要给整段或其他角色加闭唇。系统/机械音：SYS，机械/电子音色，脑内或画外响起；无可见说话人、无口型、不绑定角色参考；画面可用系统界面/光效/听者反应。
- 双人同框口型锁：镜头里有两个可见人物且只有一个人说 <d> 时，必须写明另一个可见人物 lips remain completely closed, no lip-sync, no mouthing；听者只做眼神、呼吸、手肩反应，不能默念或跟着动嘴；同一镜头禁止两人同时有口型。双人正脸同框优先改成过肩/正反打。
- 禁止旁白/画外音；内心声/系统声不是旁白，不能丢。没有台词、内心声或系统声时不要写 <d>，用画面动作表达。
- overall_soundscape 只写环境声、动作声、对白和非语言人声；增加 voice performance，写清 S1/S2/SYS 的情绪、语速和音量；系统音注明机械/电子质感和无口型，内心声注明脑内和闭唇；禁止任何背景音乐、配乐、BGM、score 或 music bed。non_diegetic_music 必须写 N/A。
- 不要输出 I2VA 第一行，不要使用 integrated_multimodal_description，不要 markdown，不要额外解释。`;

function cellPixels(aspect: string) {
    switch (aspect) {
        case "4:3":
            return { width: 640, height: 480 };
        case "1:1":
            return { width: 512, height: 512 };
        case "16:9":
            return { width: 640, height: 360 };
        case "3:4":
            return { width: 480, height: 640 };
        case "9:16":
        default:
            return { width: 360, height: 640 };
    }
}

function gridPagePixels(grid: CanvasAutomationGrid, aspect: string) {
    const cell = cellPixels(aspect);
    return { width: cell.width * grid.cols, height: cell.height * grid.rows };
}

export const SCRIPT_ADAPTATION_SYSTEM = `你是短剧剧本改编。把用户提供的小说或剧本整理成可拍摄的中文表演剧本。只输出 JSON，不要 markdown、不要解释。

输出结构：
{
  "level": "locked",
  "logline": "一句话概括本次范围",
  "scenes": [
    { "id": "s1", "heading": "地点·时间·内外", "description": "固定空间、光线、材质、关键道具；不含人物" }
  ],
  "beats": [
    {
      "id": "e1",
      "scene_id": "s1",
      "action": "一个可见动作或事件，按发生顺序",
      "dialogue": [
        { "speaker": "角色名", "channel": "spoken", "performance": "可选的语气/动作提示", "text": "逐字台词" }
      ]
    }
  ]
}

硬性规则：
- 只使用用户本次提供的原文。不补后续、不新增人物、事件、证据、反转或结局。
- 台词逐字保留：原文中人物说出口的话、内心声、系统声按原句保留；不改写、不合并、不删句、不换说话人。performance 只写语气或表演，不能改台词。
- 每句台词标注 channel：现场说出口 spoken；只在人物脑内响起 inner；系统、机械、广播或播报提示 system。system/inner 也必须逐字保留，不能改成旁白、画外音或动作。
- 原文写明人物念出、读出、播报的文字（规则、信件、屏幕、系统提示），必须放进入对应说话人的 dialogue，逐字保留；只写“看到/默读”的书面内容保持书面，不自动改成说话。
- 规则、清单、信件被念出时，每条都保留原文；不要概括成“他念了四条规则”。
- 把叙述、心理、舞台说明改写成可见动作；不要新增旁白、画外音或剧情摘要。
- 一个 beat 只承担一个连续事件；同一事件的动作和台词放在同一个 beat；不要为了凑页数把同一事件拆成多个 beat。
- 一个 beat 的台词控制在约 12 秒以内（约 60 个汉字）；长独白、规则清单、连续追问按完整句子拆成多个 beat，保持原文顺序，不删句。
- 按地点/时间分场；同一物理地点只定义一次。scene.description 只写固定空间，不写人物。
- beat 顺序就是故事顺序；保留原文的因果、信息揭示顺序和关键道具。
- 保留原文对可见外貌、服装、空间、光线的明示信息；不要添加原文没有的外貌、服装或道具。
- 没有台词时 dialogue 为空数组或省略。
- 说话人必须是原文或本段能确认的角色；不能猜性别、身份或说话人。
- 不写景别、机位、镜头运动或画风；这是剧本层，不是分镜层。
- 如果原文已经是剧本（▲动作、角色：台词），按原顺序整理，不改台词。
- 只处理下面提供的原文范围，不要写范围之外的后续。
- 输出必须是合法 JSON，不要用 markdown 代码块。`;

export function splitAutomationSource(sourceText: string, maxChars = 24000): string[] {
    const text = String(sourceText || "").trim();
    if (!text) return [];
    if (text.length <= maxChars) return [text];
    const paragraphs = text.split(/\n{2,}/);
    const chunks: string[] = [];
    let current = "";
    const flush = () => {
        if (current.trim()) {
            chunks.push(current.trim());
            current = "";
        }
    };
    for (const paragraph of paragraphs) {
        const piece = paragraph.trim();
        if (!piece) continue;
        if ((current ? `${current}\n\n${piece}` : piece).length > maxChars) {
            flush();
            if (piece.length > maxChars) {
                for (let start = 0; start < piece.length; start += maxChars) chunks.push(piece.slice(start, start + maxChars));
            } else {
                current = piece;
            }
        } else {
            current = current ? `${current}\n\n${piece}` : piece;
        }
    }
    flush();
    return chunks.length ? chunks : [text];
}

export function mergeAutomationScripts(parts: CanvasAutomationScript[]): CanvasAutomationScript {
    const scenes: CanvasAutomationScriptScene[] = [];
    const sceneIdByHeading = new Map<string, string>();
    const beats: CanvasAutomationScriptBeat[] = [];
    let sceneIndex = 0;
    let beatIndex = 0;
    const resolveScene = (part: CanvasAutomationScript, sceneId: string) => {
        const scene = part.scenes.find((item) => item.id === sceneId) || part.scenes[0];
        const heading = scene?.heading?.trim() || `场景 ${sceneIndex + 1}`;
        let id = sceneIdByHeading.get(heading);
        if (!id) {
            id = `s${sceneIndex + 1}`;
            sceneIndex += 1;
            sceneIdByHeading.set(heading, id);
            scenes.push({ ...(scene || { id, heading }), id });
        }
        return id;
    };
    parts.forEach((part) => {
        part.beats.forEach((beat) => {
            beatIndex += 1;
            beats.push({ ...beat, id: `e${beatIndex}`, sceneId: resolveScene(part, beat.sceneId) });
        });
    });
    const logline = parts.map((part) => part.logline).filter(Boolean).join("；") || undefined;
    return { level: parts.find((part) => part.level)?.level || "locked", logline, scenes, beats };
}

export function buildScriptAdaptationMessages(sourceText: string): AiTextMessage[] {
    return [
        { role: "system", content: SCRIPT_ADAPTATION_SYSTEM },
        {
            role: "user",
            content: `改编等级：locked（台词逐字保留，只把叙述、心理和舞台说明改写成可拍动作）
本次只处理以下原文，不要补写后续：

${sourceText.slice(0, 60000)}`,
        },
    ];
}

export function buildNovelToComicMessages(sourceText: string, settings: CanvasAutomationSettings, script?: CanvasAutomationScript, strictEvents = false, overlongPages: number[] = [], framework?: unknown): AiTextMessage[] {
    const autoPageCount = settings.pageCountAuto === true;
    const pageCount = Math.max(2, Math.min(24, settings.pageCount || 12));
    const grid = automationGridSpec(settings.grid);
    const stats = script ? scriptStats(script) : null;
    const estimatedSpeech = Math.max(2, Math.ceil(stats?.dialogueSeconds ?? estimateSourceSpeechSeconds(sourceText)));
    const beatCount = stats?.beatCount || 0;
    const longSegments = settings.segmentation === "long";
    const segmentationLabel = longSegments ? "长分段" : "短分段";
    const minByDialogue = Math.ceil(estimatedSpeech / 15);
    const targetByDialogue = Math.ceil(estimatedSpeech / (longSegments ? 15 : 14));
    const minByBeats = beatCount ? Math.ceil(beatCount / 6) : 0;
    const targetByBeats = beatCount ? Math.ceil(beatCount / (longSegments ? 5 : 3)) : 0;
    const minPages = Math.max(2, Math.min(24, Math.max(minByDialogue, minByBeats)));
    const targetPages = Math.max(minPages, Math.min(24, Math.max(targetByDialogue, targetByBeats)));
    const scriptSummary = beatCount ? `实际台词约 ${estimatedSpeech} 秒，可拍事件 ${beatCount} 个；` : `完整台词约 ${estimatedSpeech} 秒；`;
    const segmentationRule = longSegments
        ? "分段方式：长分段。优先把相邻短事件合并到同一页/同一长镜头，减少段数；漫画页推荐 15 秒；25 秒是单个视频段上限，不是漫画页上限，超过 25 秒不拆漫画页，系统会把这一页拆成多个视频段；同一事件默认不跨页，只有超过 24 秒的长事件可以连续占两页并标“接上”。"
        : "分段方式：短分段。页数可以多一些，每页只承担 1–2 个事件，台词和反应分开，不为了合并把多个事件塞进一页。";
    const eventRule = script
        ? `事件约束：每页必须输出 events 数组，列出本页覆盖的剧本事件编号；每个事件编号默认只出现在一页，不得遗漏，也不能把同一事件重讲两遍。若该事件台词按 5.5 字/秒超过 24 秒，允许拆到相邻两页：两页都写同一个事件编号，第二页开头写“（接上）”，不得重复上一页的台词或动作。${strictEvents ? "上一版分页出现了事件重复或遗漏，本版必须严格按事件清单逐项覆盖。" : ""}`
        : "";
    const overlongRule = overlongPages.length
        ? `时长修正：上一版第 ${overlongPages.join("、")} 页台词超过 25 秒。必须把这些页拆开：属于同一长事件的，连续占两页并都写该事件编号，第二页开头写“（接上）”；按 5.5 字/秒估算，每页台词不超过 22 秒，禁止把 4 句长台词继续塞进一页。`
        : "";
    const pageRule = autoPageCount
        ? `分镜页数自动（${segmentationLabel}）：${scriptSummary}至少 ${minPages} 页，优先 ${targetPages} 页左右；漫画页推荐 15 秒；25 秒是单个视频段上限，不是漫画页上限，超过 25 秒不拆漫画页，系统会把这一页拆成多个视频段。页数按事件和台词自然分段，台词少时合并，不要为凑页数把同一事件拆成多页；长独白按句号/问号/分号拆到相邻页，保留原文；不要漏剧情。每页 ${grid.panelCount} 格用景别、机位、反应或插入物区分，不是 ${grid.panelCount} 个等时动作。最多 24 页；24 页仍装不下请在正文提示拆分。`
        : `分镜页数：约 ${pageCount} 页（${segmentationLabel}）；${scriptSummary}漫画页推荐 15 秒；25 秒是单个视频段上限，不是漫画页上限，超过 25 秒不拆漫画页，系统会把这一页拆成多个视频段。页数按事件和台词自然分段，台词少时合并，不要为凑页数把同一事件拆成多页；长独白按句号/问号/分号拆到相邻页，保留原文；每页 ${grid.panelCount} 格用景别、机位、反应或插入物区分，不是 ${grid.panelCount} 个等时动作。`;
    const durationRule =
        settings.videoSeconds === "auto"
            ? longSegments
                ? "视频时长：系统按台词和动作计算，长分段每页至少 8 秒、推荐 15 秒以内、最多 25 秒（硬上限）；不要为凑时长加动作，也不要超过 25 秒；超过由系统拆成多个视频段。"
                : "视频时长：系统会按每页台词的实际长度估算（5.5 字/秒；最少 2 秒、最多 25 秒），不按 6 格平均，也不要求每页凑到 10 秒；请保留剧本原有台词和剧情，不要为了时长加动作、加停顿或删改台词。超过 15 秒仍可保留，超过 25 秒必须拆页。"
            : `视频目标时长：${settings.videoSeconds} 秒（每格约 ${(Number(settings.videoSeconds) || 6) / grid.panelCount} 秒，供分镜节奏参考）；请保留完整台词，不要为了固定时长删改。`;
    const frameworkRule = framework
        ? `第 2 轮已锁定分镜框架（不得改动 pages 数量、title、scene_id、events、focus、video_hint、shot_groups、panels.index/beat/camera/dialogue/characters、style/characters/scenes；只补全每个 panel 的 description 和 storyboard_description；framework 里的 panel.background 必须写进对应 panel 的 description 背景，不要给群众建角色、不要写群众的脸/服装细节；template 只作镜头写法参考，不改变分组；不得增删页、格或台词；下面的页数/事件建议与框架冲突时以框架为准）：\n${JSON.stringify(framework)}\n输出完整 JSON（沿用框架结构），不要只输出 description 补丁。\n`
        : "";
    return [
        { role: "system", content: NOVEL_TO_COMIC_SYSTEM },
        {
            role: "user",
            content: `请把下面的${script ? "改写稿" : "正文"}拆成${autoPageCount ? "适合的页数" : `约 ${pageCount} 页`}的 MOSS 宫格漫画。
每页宫格：${grid.label}（${grid.cols} 列 × ${grid.rows} 行，共 ${grid.panelCount} 格，必须严格等于 ${grid.panelCount} 格，不能合并或增加格子）
每一格与最终视频同画幅：${settings.aspect}（默认 16:9，由用户画幅参数控制，不要把格子改成其他比例）
画风：${settings.style}${styleReference(settings.style) ? `；明确画风指代：${styleReference(settings.style)}` : ""}
${pageRule}
${segmentationRule}
${eventRule}
${overlongRule}
${durationRule}
${script ? "这是已经改写好的可拍剧本：台词必须逐字使用，不得改写、合并、漏句或换说话人；每句台词只能出现一次。scene_id 必须使用改写稿中的场次编号（s1、s2…）；页面按事件 eN 组织；同一事件默认只在一页，超过 24 秒的长事件可以连续占两页并标“接上”。" : ""}
先建立唯一的主场景表 scenes 和角色锁定表，再写每一页的每一格。characters 最多 4 个，只定义有名字、需要跨页保持一致的主要角色；群像、人群、路人、船员、乘客、士兵、守卫、孩子们等群体不进入 characters，也不要求四视图，写进画面背景。每个角色必须写 species：human 或 animal；animal 再写 species_label（如 黑猫/黄狗/麻雀），appearance_lock 只写体型、毛色、耳朵、尾巴等轮廓特征，outfit_lock 留空，不要给动物穿衣服。每页用 scene_id 引用其中一个主场景；同一个物理地点只能定义一次，只有真正换地点才新增场景，每个主场景只生成一张场景资产。每页先定一个 focus（本页唯一重点），并且只允许一个 beat:key 格；key 格是本页最重要的信息揭示、情绪转折或危险信号，必须拿到特写/插入/停顿或人物念出关键文字；其他格是 support。每页还要输出 shot_groups，6 格不等于 6 个镜头，每页只允许 1–3 组；连续动作/同一空间优先 long_take，组内禁止切镜；只有换地点/时间、换说话人并带来新信息、关键揭示/插入或强动作才 cut；key 格不能在一句台词或一个动作中间被切走。画面里的关键文字（标题、编号、第一条规则等）如果人物会念，必须写入 dialogue，不能只放在 description 里；规则/清单只占一个 insert 或 long_take，不要每条规则一镜。每个 panel 是一个独立镜头/剧情节拍，优先用景别、机位、人物关系、听话人的反应或插入物特写来区分；不要用同一人物的连续姿势（站→走→弯腰→坐下）拆一个动作；每一格 description 必须以 style_lock 原文开头，并逐字带上出场角色的 appearance_lock 和 outfit_lock；每页只写实际出场角色。每一格还要写 storyboard_description，并且只按“景别机位：…；人物站位：…；头部朝向：…；视线落点：…；本格节拍：…”五项填写，不要写其他句子；视线落点写看着谁/镜头/物品，必须和头部朝向一致，对话中默认看向对话对象，不要默认看镜头；白模不是画风，禁止任何新海诚/宫崎骏/动漫/电影感/写实/水彩等风格词，禁止表情、五官细节、眼神/眼睛、发型、年龄、服装、配饰和道具细节，不要复制 style_lock/appearance_lock/outfit_lock。剧情必须写进画面动作和对白；narration 必须为空字符串，禁止描述性旁白/画外音/剧情摘要。dialogue 可写现场对白、内心声、系统/机械音（格式见规则），内心声和系统声不能丢；动作、表情、镜头和旁白绝不能写进 dialogue。

每个视频段的台词句数控制：25 秒最多 8 句，20 秒最多 7 句，15 秒最多 5 句，12 秒最多 4 句，8 秒最多 3 句；每句优先 8–11 字，长句只拆页、不改写；超过句数上限时拆页或拆视频段，不删台词；每句台词都必须有镜头。

${frameworkRule}正文：
${sourceText.slice(0, 60000)}`,
        },
    ];
}

export function buildComicFrameworkMessages(sourceText: string, settings: CanvasAutomationSettings, script?: CanvasAutomationScript, strictEvents = false, overlongPages: number[] = []): AiTextMessage[] {
    const autoPageCount = settings.pageCountAuto === true;
    const pageCount = Math.max(2, Math.min(24, settings.pageCount || 12));
    const grid = automationGridSpec(settings.grid);
    const stats = script ? scriptStats(script) : null;
    const estimatedSpeech = Math.max(2, Math.ceil(stats?.dialogueSeconds ?? estimateSourceSpeechSeconds(sourceText)));
    const beatCount = stats?.beatCount || 0;
    const pageRule = autoPageCount
        ? `页数自动：按事件和台词自然分段，至少 ${Math.max(2, Math.min(24, Math.ceil(estimatedSpeech / 20)))} 页，优先 ${Math.max(2, Math.min(24, Math.ceil(estimatedSpeech / 15)))} 页左右；最多 24 页；不要为凑页数拆事件。`
        : `页数：约 ${pageCount} 页；按事件和台词自然分段，不要为凑页数拆事件。`;
    const eventRule = script
        ? `事件约束：每页 events 必须覆盖剧本事件编号，每个事件默认只出现一页；超过 24 秒的长事件可以连续占两页并标“（接上）”；不得漏事件、不得重复。${strictEvents ? "上一版出现事件重复或遗漏，本版必须严格按事件清单逐项覆盖。" : ""}`
        : "";
    const overlongRule = overlongPages.length
        ? `时长修正：上一版第 ${overlongPages.join("、")} 页台词超过 25 秒，本版框架必须把这些页拆开或拆成多个视频段；正文和 group 不能继续压在同一页。`
        : "";
    return [
        { role: "system", content: COMIC_FRAMEWORK_SYSTEM },
        {
            role: "user",
            content: `请先搭分镜主框架，不写任何画面描述或白模细节。
每页宫格：${grid.label}（${grid.cols} 列 × ${grid.rows} 行，共 ${grid.panelCount} 格，必须严格等于 ${grid.panelCount} 格）
每一格与最终视频同画幅：${settings.aspect}
画风：${settings.style}${styleReference(settings.style) ? `；明确画风指代：${styleReference(settings.style)}` : ""}
${pageRule}
${script ? `这是已改写好的可拍剧本：实际台词约 ${estimatedSpeech} 秒，可拍事件 ${beatCount} 个；台词逐字保留，不得改写、合并、漏句或换说话人；scene_id 使用改写稿场次编号。` : `完整台词约 ${estimatedSpeech} 秒。`}
${eventRule}
${overlongRule}
只输出框架 JSON：style / style_lock / style_negative / scenes / characters / pages（title、scene_id、events、focus、video_hint、shot_groups、panels）。panels 只写 index、beat、camera、background、dialogue、characters；不要写 description、storyboard_description、narration。

正文：
${sourceText.slice(0, 60000)}`,
        },
    ];
}

export function buildComicToVideoMessages(pages: CanvasAutomationPage[], style: string, settings: CanvasAutomationSettings, sheets: CanvasAutomationCharacterSheet[] = [], sceneSheets: CanvasAutomationSceneSheet[] = [], strictCamera = false): AiTextMessage[] {
    const first = pages[0];
    const grid = first?.grid || { rows: 2, cols: 3, panelCount: 6 };
    const payload = pages.map((page) => {
        const manifest = buildAutomationVideoReference(page, sheets, sceneSheets);
        const references = [
            ...manifest.characters.map((character) => ({
                picture: character.pictureIndex,
                kind: "character_sheet",
                role: "highest-priority final character look, costume and art-style reference",
                character_id: character.characterId,
                name: character.name,
                appearance_lock: character.appearanceLock,
                outfit_lock: character.outfitLock,
                negative_lock: character.negativeLock,
            })),
            ...(manifest.scene ? [{
                picture: manifest.scene.pictureIndex,
                kind: "scene_sheet",
                role: "environment reference: space layout, lighting, materials and key props",
                name: manifest.scene.name,
                description: manifest.scene.description,
            }] : []),
            { picture: manifest.storyboardPictureIndex, kind: "comic_page", role: "storyboard only: shot order, composition and dialogue placement; not the final character or style reference" },
        ];
        return {
            page: page.index + 1,
            title: page.title,
            focus: page.focus || "",
            segment: page.segmentCount ? { index: (page.segmentIndex || 0) + 1, count: page.segmentCount, panel_range: page.panelRange } : undefined,
            events: page.eventIds || [],
            shot_groups: page.shotGroups || [],
            scene_id: page.sceneId || "",
            scene: page.scene || "",
            scene_description: page.sceneDescription || "",
            style: page.styleLock || page.style || style,
            style_negative: page.styleNegative || "",
            duration: Number(resolvePageVideoSeconds(page, settings)) || estimatePageVideoSeconds(page),
            grid: page.grid,
            panels: (page.panels || []).map((panel) => {
                const comicPanel = { ...panel };
                const storyboard = comicPanel.storyboardDescription || "";
                delete comicPanel.storyboardDescription;
                return { ...comicPanel, storyboard, description: lockedPanelDescription(panel, page.styleLock || page.style || style, page.characters || []) };
            }),
            spoken_dialogue: pageSpokenDialogue(page),
            dialogue_details: pageDialogueDetails(page),
            references,
            characters: (page.characters || []).map((character) => ({
                id: character.id,
                name: character.name,
                species: character.species || "human",
                species_label: character.speciesLabel || "",
                appearance_lock: character.appearanceLock || character.description || "",
                outfit_lock: character.outfitLock || "",
                negative_lock: character.negativeLock || "",
                picture: manifest.characters.find((item) => item.characterId === character.id)?.pictureIndex ?? null,
            })),
        };
    });
    const durations = payload.map((page) => `第${page.page}页 ${page.duration}s`).join("；");
    const segmentRule = payload.some((page) => page.segment)
        ? "- 这些页是同一张漫画页的视频段：只拍本段 panel_range 内的镜头和台词，panels 使用原页 panel.index，不要从 1 重编，不要重复其他段；所有段共享同一张故事板。\n"
        : "";
    return [
        { role: "system", content: COMIC_TO_VIDEO_REF2VA_SYSTEM },
        {
            role: "user",
            content: `画风：${style}
宫格：${grid.cols} 列 × ${grid.rows} 行，共 ${grid.panelCount} 格；每一格和最终视频都是 ${settings.aspect} 画幅
各页时长：${durations}；每页按台词和反应自然分镜，单页推荐 15 秒以内、硬上限 25 秒；不要套用固定 3–5 秒或 4/6/9 秒，不要为了凑镜头数加慢动作。
台词预算：正常口播约 5.5 字/秒，对话页台词填充率目标 80–90%；25 秒最多 8 句、20 秒最多 7 句、15 秒最多 5 句、12 秒最多 4 句、8 秒最多 3 句；不要加速或删台词，超时请拆页。
${segmentRule}参考图规则：
- 每页 references 的顺序固定：前面 1..N 是该页人物四视图；如果有场景图，下一张是场景参考；最后一张是该页宫格漫画故事板。
- 人物四视图是人物脸型、发型、服装、配色和最终画风的最高优先级参考；场景图是空间布局、光线、材质和道具的最高优先级参考；故事板只决定镜头顺序、构图、对白位置和节拍。
- 故事板不是最终人物造型或画风参考；漫画宫格与人物/场景参考冲突时，以参考图为准。
- 必须在 subject_definitions 中为每个角色写 <Subject N> 并绑定对应的 <Picture N>；场景图单独绑定 <Picture N>；故事板必须绑定最后一张 <Picture>。
- 不要把分格线、气泡框、页码或漫画网点画进视频；不要把四视图排版本身当成视频画面。
- 每页只允许出现该页 characters 数组中的角色；picture 为 null 的角色只能用文本锁定，不得引用不存在的图片。panel.background 里的背景群众/路人属于环境：可以出现在背景，但不建 <Subject>、不绑定 Picture、不给台词、不正脸特写、不抢主体；不要因为不在 characters 数组就删掉他们。
- characters 里 species=animal 的角色：写清 species_label 和真实体型，保持四足/鸟类/鱼类等自然结构，不要人形、不要拟人站立、不要给动物穿衣服；动物参考图优先于故事板。
- 每页先看 focus 和 panel.beat：key 格是本页唯一重点，必须给它最强镜头（特写/插入/停顿，或让人物念出关键文字）；support 格只做铺垫、反应和过渡，不要把规则/清单每条平均给镜头。
- 页面的 events 是唯一事件边界：同一事件只在本页拍摄，不要把同一事件拆成多个镜头或重复描述；镜头只改变看法，不改变事件。
- 分镜格不等于镜头：6 个 panel 不是 6 个镜头。遵守 shot_groups，每组一个镜头；long_take 组内禁止切镜；没有 shot_groups 时按剧情合并，默认 3–5 个镜头/页，短页可 1–2 个，禁止按宫格边界机械切镜。key 格不能在一句台词或一个动作中间切走；规则/清单只占一个 insert 或 long_take。
- 画面里的关键文字（标题、编号、第一条规则等）如果人物会念，必须放进 <d> 台词；不要让镜头只扫过文字而没有表演。
- 对白、内心声、系统声只能使用该页 spoken_dialogue 里的原文放进 <d>；渠道看 dialogue_details。不得写旁白、画外音、镜头说明或任何描述性台词。
- 现场对白：人物自然口型。内心声：同一人物 S 编号，括号写“内心声，嘴唇完全闭合、无口型”。系统/机械音：独立 SYS，括号写“system voice, mechanical/electronic, heard inside the mind or off-screen, no lip-sync”，无可见说话人、无口型、不绑定角色参考。
- 双人同框口型锁：镜头里有两个可见人物且只有一个人说 <d> 时，必须写明说话人正在说，另一个可见人物 lips remain completely closed, no lip-sync, no mouthing；听者只做眼神、呼吸、手肩反应，不能默念或跟着动嘴；同一镜头禁止两人同时有口型。双人正脸同框优先改成过肩/正反打。
- 每句 <d> 前必须写语气/表演提示：说话人 ID + 情绪与强度 + 语速 + 音量/重音 + 标点处理，例如 S1 (压着火气，中低音量，语速由慢到快，重音在“又”，省略号处停顿半秒): <d>[Chinese] ...</d>；提示写在 <d> 外，<d> 内只能是台词原文，禁止只写“S1 says”，禁止只写“平静/普通语气”。
- dialogue_details.prosody 给出该句标点节奏，必须写进语气提示；允许按表演需要强化或添加 ，……！？～ 及连用（！！！、？？？、……！），但不得增删、替换台词文字，<d> 内保留这些标点。
- 同一页至少一次明显的强弱/快慢/音量变化；key 句最强或最弱，support 句不能和 key 句同调。
- 每个有人物出镜的镜头必须写一处可见的面部变化（眼神、眉头、嘴角、下颌、呼吸、喉结），相邻镜头不得重复同一种表情；key 格给最明显的一次；插入物/无人镜头除外。
- 每个有人物的镜头写清头部朝向（对方/镜头/画外/低头/侧脸/背对）和视线落点（看着对方/看着镜头/看着某物），与对话关系和站位一致；对话中默认看着对话对象，不要默认看镜头；不要照抄故事板里错误的朝向。
- 画面禁止字幕、说明文字、歌词、水印和可读屏幕文字；detailed_description 必须写 No subtitles, no captions, no on-screen text.
- 每个 [Shot N] 必须标 | panels X–Y；景别/机位/站位照 payload.panels[].storyboard 写，顺序与 panel 一致，不跳格、不重复、不新增故事板以外的镜头。首镜不写时间戳；后续 [Shot N] At MM:SS.mmm 严格递增且小于 duration。
- 按 shot_groups 映射：long_take 一组一镜，cut 组每格一镜，insert 只拍插入物；同一格两句不同说话人的台词拆成两镜，都标该格号；long_take 组内出现两个不同说话人的台词时，必须拆成 cut，不能让两人在同一个长镜头里对话。
- shot_groups[].template 是镜头模板：dialogue_reverse 正反打、pressure_group 群像施压、emotion_burst 情绪爆发硬切特写、reveal_insert 揭示插入特写、turn_question 回头质问、eavesdrop_door 门内听门外、phone_popup 手机/屏幕插入+反应、crowd_turn 群嘲倒戈、action_chase 追逐低机位短切、silent_hold 静场长镜、establish_env 环境建立、montage_transition 转场。按模板写镜头语法，不改变分组和覆盖范围。
- 一个镜头最多一句 <d>；不同说话人必须分镜，禁止两句台词或声音重叠。每句台词都必须完整写入 <d>；不能只写语气提示或空着；台词没写完不能结束该镜。
- 台词按 5.5 字/秒 + 标点停顿分配时间，每句至少 1.2 秒，句前后留 0.3 秒静音；纯动作镜至少 0.8 秒；镜头铺满 duration，台词优先，不够就删动作，不能删台词；时长不够就延长到 25 秒或拆段；对话页填充率目标 80–90%，不要用静默填时长。
- 台词/动作/剧情不可删减或压缩：放不下先加镜头，仍放不下就拆视频段或新开一页；句数上限只是拆页信号，不是删台词信号。
- 每页句数上限：25 秒最多 8 句，20 秒最多 7 句，15 秒最多 5 句，12 秒最多 4 句，8 秒最多 3 句；超过上限时拆页或拆视频段，不删台词。
- 没有对白、内心声或系统声时不要写 <d>，用画面动作表达。
- 默认正常速度；禁止无动机的 slow motion、slowly、慢推、慢摇、慢动作；只有剧本明确要求慢动作时才允许。
- 短剧默认切镜头：普通对白、反应、信息、动作全部固定机位 + 硬切；每两页最多 1 个推拉/横移/跟拍，只有情绪转折/关键揭示/转场才用；禁止连续两个镜头都运动。
- 镜头物理限位：推拉写 10–15 cm over 2–3 s on a rail；横移/摇/俯仰给 cm 或角度（摇≤45°，俯仰≤30°）；静止写 the camera holds still；切镜只用 the camera cuts to / the shot cuts to；禁止 zoom、位移+变焦同镜。
- 3D/动漫特写必须带角度（侧 45° 或微俯/微仰），禁止正面平视；双人对话写正向越轴不变式；单镜≤70 词、一个人物主动作；镜头数按时长：2–5s→1–2，6–8s→2–4，9–15s→3–5。
${strictCamera ? "- 严格镜头模式：本批普通页一律 locked-off fixed camera，整批运动镜头页数不超过一半；不要写 pan/truck/dolly/tracking/push/pull/zoom/横移/平拉/摇镜/跟拍。" : ""}
- 禁止任何背景音乐、配乐、BGM、score 或 music bed；overall_soundscape 只能写环境声、动作声、对白和人声；non_diegetic_music 必须是 N/A。

漫画页：
${JSON.stringify(payload, null, 2)}

请一次为全部页面输出六段式 H3 Ref2VA prompt，不能漏页；按台词和反应自然分镜，不套固定 3–5 秒镜头；每句 <d> 前写语气/表演提示；段名和顺序固定，不要输出 I2VA 第一行。`,
        },
    ];
}

export function extractJson(text: string): unknown {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const start = candidate.search(/[[{]/);
    if (start < 0) throw new Error("模型没有返回 JSON");
    const slice = candidate.slice(start);
    for (let end = slice.length; end > 0; end -= 1) {
        try {
            return JSON.parse(slice.slice(0, end));
        } catch {
            // Try the next shorter prefix so trailing prose does not break parsing.
        }
    }
    throw new Error("模型返回的 JSON 无法解析");
}

function asText(value: unknown, fallback = "") {
    return typeof value === "string" ? value.trim() : fallback;
}

const NON_DIALOGUE_SPEAKERS = new Set(["旁白", "画外音", "解说", "镜头", "画面", "动作", "场景", "字幕", "音效", "导演", "舞台说明", "注"]);

function sanitizeDialogueLine(value: unknown): string | null {
    const raw = asText(value);
    if (!raw) return null;
    const match = /^([^：:\n]{1,24})[：:]\s*([\s\S]*)$/.exec(raw);
    if (!match) return null;
    const speaker = match[1].trim();
    if (!speaker || NON_DIALOGUE_SPEAKERS.has(speaker)) return null;
    let body = match[2].trim();
    if (!body) return null;
    const quoted = [...body.matchAll(/[「『“"]([^」』”"]+)[」』”"]/g)].map((item) => item[1].trim()).filter(Boolean);
    if (quoted.length) body = quoted.join(" ");
    body = body
        .replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!body) return null;
    if (NON_DIALOGUE_SPEAKERS.has(body.replace(/^([^：:]{1,12})[：:][\s\S]*$/, "$1").trim())) return null;
    return `${speaker}：${body}`;
}

function sanitizeDialogueLines(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(sanitizeDialogueLine).filter((line): line is string => Boolean(line));
}

export function sanitizePageDialogue(page: CanvasAutomationPage): CanvasAutomationPage {
    return {
        ...page,
        narration: "",
        dialogue: sanitizeDialogueLines(page.dialogue),
        panels: (page.panels || []).map((panel) => ({ ...panel, dialogue: sanitizeDialogueLines(panel.dialogue) })),
    };
}

export function pageSpokenDialogue(page: Pick<CanvasAutomationPage, "panels" | "dialogue">) {
    const lines = pageDialogueLines(page);
    return lines
        .map((line) => sanitizeDialogueLine(line)?.replace(/^[^：:\n]{1,24}[：:]\s*/, "").trim() || "")
        .filter(Boolean);
}

type PageDialogueDetail = {
    speaker: string;
    channel: "spoken" | "inner" | "system";
    text: string;
    punctuation?: { comma: number; ellipsis: number; exclamation: number; question: number; tilde: number };
    prosody?: string;
};

export function pageDialogueDetails(page: Pick<CanvasAutomationPage, "panels" | "dialogue">): PageDialogueDetail[] {
    return pageDialogueLines(page)
        .map((line): PageDialogueDetail | null => {
            const sanitized = sanitizeDialogueLine(line);
            if (!sanitized) return null;
            const match = /^([^：:\n]{1,24})[：:]\s*([\s\S]*)$/.exec(sanitized);
            const speakerRaw = match ? match[1].trim() : "";
            const text = match ? match[2].trim() : sanitized;
            const channel = /系统|机械|电子音|播报|广播|提示音/i.test(speakerRaw) ? "system" : /内心|心声|脑内|心中|默念/i.test(speakerRaw) ? "inner" : "spoken";
            const speaker = speakerRaw.replace(/[（(](?:内心声?|心声|脑内|心中|默念|系统声?|机械音|电子音|画外音)[）)]/g, "").trim() || (channel === "system" ? "系统" : "角色");
            const punctuation = {
                comma: (text.match(/[，,]/g) || []).length,
                ellipsis: (text.match(/…{2,}|\.{3,}/g) || []).length,
                exclamation: (text.match(/[！!]/g) || []).length,
                question: (text.match(/[？?]/g) || []).length,
                tilde: (text.match(/[～~]/g) || []).length,
            };
            const prosody = [
                punctuation.comma ? `逗号${punctuation.comma}处短停` : "",
                punctuation.ellipsis ? `省略号${punctuation.ellipsis}处拖长/迟疑` : "",
                punctuation.exclamation ? `感叹号${punctuation.exclamation}处加重` : "",
                punctuation.question ? `问号${punctuation.question}处上扬` : "",
                punctuation.tilde ? `波浪线${punctuation.tilde}处拖音` : "",
            ].filter(Boolean).join("；") || "无特殊标点，按语义自然停顿";
            return { speaker, channel, text, punctuation, prosody };
        })
        .filter((item): item is PageDialogueDetail => Boolean(item));
}

function asNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: unknown, fallback: number) {
    return Math.min(1, Math.max(0, asNumber(value, fallback)));
}

function normalizeRegion(raw: unknown, index: number): CanvasMossLayoutRegion | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const label = source.label === "character" || source.label === "text" || source.label === "object" ? source.label : "object";
    const caption = asText(source.caption) || (label === "text" ? "旁白" : "画面内容");
    const x = clamp01(source.x, 0);
    const y = clamp01(source.y, 0);
    const width = Math.min(1 - x, Math.max(0.02, clamp01(source.width, 0.4)));
    const height = Math.min(1 - y, Math.max(0.02, clamp01(source.height, 0.4)));
    return {
        id: asText(source.id, `r${index + 1}`).slice(0, 40),
        label,
        caption: caption.slice(0, 500),
        ...(label === "text" && typeof source.text === "string" ? { text: source.text.slice(0, 500) } : {}),
        x,
        y,
        width,
        height,
    };
}

export function normalizeMossLayout(raw: unknown, aspect: string): CanvasMossLayout {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const size = cellPixels(aspect);
    const summary = asText(source.summary).slice(0, 4000) || "MOSS 宫格漫画";
    const regions = Array.isArray(source.regions) ? source.regions.map(normalizeRegion).filter((region): region is CanvasMossLayoutRegion => Boolean(region)).slice(0, 32) : [];
    if (!regions.length) regions.push({ id: "r1", label: "object", caption: summary.slice(0, 300), x: 0, y: 0, width: 1, height: 1 });
    return { summary, regions, width: size.width, height: size.height };
}

const CROWD_MARKERS = ["群像", "人群", "群众", "群演", "路人", "背景人物", "一群", "女团", "男团", "合唱团", "舞团", "船员们", "乘客们", "士兵们", "守卫们", "女孩们", "男孩们", "孩子们", "怪物群", "尸群", "兽群"];

export function isCrowdCharacterName(name: string) {
    const text = String(name || "").replace(/\s/g, "");
    return CROWD_MARKERS.some((marker) => text.includes(marker)) || /们$/.test(text);
}

const ANIMAL_SPECIES_PATTERN = /animal|动物|猫|狗|犬|马|狼|狐|兔|蛇|鱼|龙|熊|虎|狮|鹿|鹰|鸟|猴|鸡|鸭|鹅|牛|羊|猪|鼠|象|鲸|海豚|蝙蝠|猫头鹰|乌鸦|麻雀|宠物|cat|dog|horse|wolf|fox|rabbit|snake|fish|dragon|bear|tiger|lion|deer|eagle|bird|monkey|chicken|duck|goose|cow|sheep|pig|mouse|elephant|whale|dolphin|bat|owl|crow|sparrow|pet/i;

function normalizeCharacter(raw: unknown, index: number): CanvasAutomationCharacter | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const name = asText(source.name);
    const appearanceLock = asText(source.appearance_lock || source.appearanceLock || source.appearance || source.description);
    if (!name && !appearanceLock) return null;
    const outfitLock = asText(source.outfit_lock || source.outfitLock || source.outfit);
    const negativeLock = asText(source.negative_lock || source.negativeLock || source.negative);
    const speciesRaw = asText(source.species || source.kind || source.type);
    const speciesLabelRaw = asText(source.species_label || source.speciesLabel || source.animal_kind || source.animalKind);
    const species: "human" | "animal" = speciesLabelRaw || (speciesRaw && !/human|人类/i.test(speciesRaw) && ANIMAL_SPECIES_PATTERN.test(speciesRaw)) ? "animal" : "human";
    const speciesLabel = species === "animal" ? speciesLabelRaw || speciesRaw.replace(/^animal\s*[:：]?\s*/i, "").trim() || "动物" : "";
    const description = [appearanceLock, outfitLock].filter(Boolean).join("；");
    return {
        id: asText(source.id, `c${index + 1}`).slice(0, 40),
        name: name || `角色${index + 1}`,
        species,
        speciesLabel,
        description,
        appearanceLock: appearanceLock || name,
        outfitLock,
        negativeLock,
    };
}

function normalizePanelCharacters(value: unknown, characters: CanvasAutomationCharacter[]) {
    if (!Array.isArray(value)) return [];
    const ids = value
        .map((item) => {
            if (typeof item === "string") {
                const found = characters.find((character) => character.id === item || character.name === item);
                return found?.id || "";
            }
            if (item && typeof item === "object") {
                const source = item as Record<string, unknown>;
                const key = asText(source.id || source.name);
                const found = characters.find((character) => character.id === key || character.name === key);
                return found?.id || "";
            }
            return "";
        })
        .filter(Boolean);
    return [...new Set(ids)].slice(0, 2);
}

function normalizePanel(raw: unknown, index: number, characters: CanvasAutomationCharacter[], duration: number, panelCount: number): CanvasAutomationPanelSpec {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const dialogue = sanitizeDialogueLines(source.dialogue);
    return {
        index: index + 1,
        time: panelRangeLabel(index, panelCount, duration),
        description: asText(source.description || source.scene || source.action, "画面内容"),
        storyboardDescription: asText(source.storyboard_description || source.storyboardDescription),
        background: asText(source.background || source.background_people || source.crowd).slice(0, 160) || undefined,
        beat: asText(source.beat) === "key" ? "key" : "support",
        camera: asText(source.camera || source.camera_move),
        dialogue,
        characters: normalizePanelCharacters(source.characters || source.characters_in_panel, characters),
    };
}

function panelRangeLabel(index: number, panelCount: number, duration: number) {
    const perPanel = duration / Math.max(1, panelCount);
    const start = index * perPanel;
    const end = Math.min(duration, start + perPanel);
    return `${start.toFixed(2)}–${end.toFixed(2)}s`;
}

function gridLabel(grid: CanvasAutomationGrid) {
    const match = Object.values(GRID_META).find((item) => item.rows === grid.rows && item.cols === grid.cols);
    return match?.label || `${grid.rows}×${grid.cols} 宫格`;
}

function cleanPanelDescription(panel: CanvasAutomationPanelSpec) {
    return panel.description.replace(/^第\s*\d+\s*格[：:]\s*/, "").replace(/^Panel\s+\d+[：:]\s*/i, "").trim();
}

function lockedPanelDescription(panel: CanvasAutomationPanelSpec, styleLock: string, characters: CanvasAutomationCharacter[], removeStyleLock?: string) {
    let description = cleanPanelDescription(panel);
    if (removeStyleLock) description = description.split(removeStyleLock).join("").replace(/^[；;。.\s]+/, "").trim();
    if (styleLock && !description.includes(styleLock)) description = `${styleLock}；${description}`;
    (panel.characters || []).forEach((id) => {
        const character = characters.find((item) => item.id === id || item.name === id);
        if (!character) return;
        const appearance = character.appearanceLock || character.description || "";
        if (appearance && !description.includes(appearance)) description += `；${character.name}：${appearance}`;
        if (character.outfitLock && !description.includes(character.outfitLock)) description += `；${character.outfitLock}`;
    });
    if (panel.background && !description.includes(panel.background)) description += `；背景群众：${panel.background}`;
    return description;
}

function stripStoryboardTerms(value: string) {
    return value
        .replace(/\b(?:crisp|clean linework|luminous|cel shading|fine background detail|cinematic composition|anime|manga|comic illustration|photorealistic|shading|screentone)\b/gi, "")
        .replace(/新海诚|宫崎骏|吉卜力|皮克斯|迪士尼|梦工厂|日漫|国漫|韩漫|美漫|赛博朋克|蒸汽朋克|废土|像素风|卡通|Q版|动漫|动画|赛璐璐|电影感|胶片感|写实|厚涂|水彩|油画|素描|线稿|3D|2D|CG|插画|漫画风|画风|风格|网点|彩色|黑白|配色|材质|光影|镜头光晕|复杂背景|背景细节/gi, "")
        .replace(/表情|神情|神色|眼神|目光|视线|对视|凝视|注视|皱眉|眉头|微笑|冷笑|苦笑|笑容|笑意|哭|流泪|眼泪|发亮|坚定|固执|执着|迟疑|凝重|温柔|愤怒|悲伤|惊讶|紧张|平静|冷漠|气势|抿住|抿嘴|咬牙|嘴角|嘴唇|五官|面部|脸上|脸|笑|遮脸|捂脸/g, "")
        .replace(/(?:穿着|身穿|戴着|穿|戴)?(?:大衣|旗袍|西装|外套|衬衫|风衣|毛衣|T恤|卫衣|背心|短裤|长衫|长裤|裙子|裙摆|开衫|皮鞋|布鞋|靴|眼镜|老花镜|帽子|围巾|发髻|低髻|发型|头发|白发|黑发|短发|长发|配饰|袖口|领口|衣摆|鞋)/g, "")
        .replace(/灰色|深灰|浅灰|白色|黑色|红色|蓝色|绿色|彩色|花白|黄色|棕色|金色|橘色|褐色|银色|米色|青色|紫色|粉色/g, "")
        .replace(/(?:看向|看着|望向|盯着|扫向|落在|移到|从[^，。；]{1,12}移向)/g, "")
        .replace(/观音像|佛像|神像|雕像|签诗|香炉|供桌|红纸|纸角|纸面|签纸|积云|云层|天空|光线|逆光|侧光|窗光|窗风|明亮背景|花纹|纹理|图案|勾亮|透进的光|光把|光在|褶皱/g, "")
        .replace(/\b\d+:\d+\b/g, "")
        .replace(/[（(][^）)]*[）)]/g, " ")
        .replace(/(?:台词|对白)[：:][^；;。.\n]*/g, "")
        .replace(/(?:说出|念出|读出|朗读|说道|喊道|问道|回答|答道|开口|说话|低语|喃喃|耳语|宣告|发誓|宣誓|嘟囔|补充|解释|反问|追问)[^，。；;…\n]*/g, "")
        .replace(/白模不是画风|白模不是|不是画风|不要画风|禁止画风|不要写|禁止写|不要出现|禁止出现/g, "")
        .replace(/^(?:storyboard_description|白模故事板|白模|画面|描述|动作)[：:]\s*/i, "")
        .replace(/[。；;]\s*[^；：]{1,24}：\s*(?=[；;。]|$)/g, "")
        .replace(/[；;]\s*：\s*/g, "")
        .replace(/[，,；;。]\s*而\s*(?=[；;。]|$)/g, "")
        .replace(/她的|他的/g, "")
        .replace(/[；;，,\s]{2,}/g, " ")
        .replace(/从\s*转为/g, "")
        .replace(/^[；;，,。.\s]+|[；;，,。.\s]+$/g, "")
        .trim();
}

function cleanGazeValue(value: string) {
    const cleaned = value
        .replace(/眼神|目光|眼睛|双眼|瞳孔|对视|凝视|注视|表情|神情|神色|五官|面部|脸上|脸/g, "")
        .replace(/[，。；;]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const match = /(看着|看向|望向|盯着|视线落点(?:在|是)?|目光落在)\s*([^，。；;\s][^，。；;]{0,23})/.exec(cleaned);
    if (match) return `${match[1]}${match[2].trim()}`;
    return cleaned.slice(0, 28);
}

function structuredStoryboard(value: string) {
    const matches = [...value.matchAll(/(?:^|[；;\n])\s*(景别机位|景别|机位|镜头运动|镜头|人物站位|人物|站位|头部朝向|朝向|视线落点|视线|目光|看着|看向|望向|本格节拍|节拍|动作|反应)[：:]\s*([^；;\n]+)/g)];
    if (matches.length < 2) return "";
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const [, rawLabel, rawValue] of matches) {
        const label = rawLabel.includes("景别") || rawLabel.includes("机位") || rawLabel.includes("镜头")
            ? "景别机位"
            : rawLabel.includes("视线") || rawLabel.includes("目光") || rawLabel.includes("看着") || rawLabel.includes("看向") || rawLabel.includes("望向")
              ? "视线落点"
              : rawLabel.includes("朝向")
                ? "头部朝向"
                : rawLabel.includes("人物") || rawLabel.includes("站位")
                  ? "人物站位"
                  : "本格节拍";
        if (seen.has(label)) continue;
        const cleaned = label === "视线落点" ? cleanGazeValue(rawValue) : stripStoryboardTerms(rawValue);
        if (!cleaned) continue;
        if (label === "本格节拍" && STORYBOARD_SPEECH_PATTERN.test(cleaned)) continue;
        if (label === "本格节拍" && cleaned.length <= 4 && !/[走站坐躺转抬伸推拉握放拿低俯靠退进跨跑停跪蹲抱递交挥指点倾侧起伸抬低抬转迈移近离]/.test(cleaned)) continue;
        seen.add(label);
        parts.push(`${label}：${cleaned}`);
    }
    return parts.join("；");
}

function storyboardPanelDescription(panel: CanvasAutomationPanelSpec) {
    const source = panel.storyboardDescription?.trim() || panel.description;
    const structured = structuredStoryboard(source);
    let description = structured || stripStoryboardTerms(cleanPanelDescription({ ...panel, description: source }));
    if (!description) description = "人物按分镜站位，动作保持简单清晰";
    if (STORYBOARD_FORBIDDEN_PATTERN.test(description)) description = "人物按分镜站位，动作保持简单清晰";
    if (panel.background && !description.includes(panel.background)) description += `；背景群众：${panel.background}`;
    return description;
}

function mossDialogueText(lines?: string[]) {
    return (lines || [])
        .map((line) => sanitizeDialogueLine(line)?.replace(/^[^：:\n]{1,24}[：:]\s*/, "").trim() || "")
        .filter(Boolean)
        .join("\n");
}

export function buildGridMoss({
    style,
    styleLock,
    styleNegative,
    characters,
    panels,
    grid,
    aspect,
    storyboard = false,
}: {
    style: string;
    styleLock?: string;
    styleNegative?: string;
    characters: CanvasAutomationCharacter[];
    panels: CanvasAutomationPanelSpec[];
    grid: CanvasAutomationGrid;
    aspect: string;
    storyboard?: boolean;
}): CanvasMossLayout {
    const size = gridPagePixels(grid, aspect);
    const cellWidth = 1 / grid.cols;
    const cellHeight = 1 / grid.rows;
    const effectiveStyle = storyboard ? STORYBOARD_STYLE : style;
    const effectiveStyleLock = storyboard ? STORYBOARD_STYLE_LOCK : styleLock || style;
    const effectiveStyleNegative = storyboard ? STORYBOARD_STYLE_NEGATIVE : styleNegative;
    const describePanel = (panel: CanvasAutomationPanelSpec) =>
        storyboard ? storyboardPanelDescription(panel) : lockedPanelDescription(panel, effectiveStyleLock, characters);
    const panelCaption = (panel: CanvasAutomationPanelSpec) => {
        const description = describePanel(panel);
        const camera = panel.camera && !description.includes("镜头：") && !description.includes("景别机位：") ? `；镜头：${panel.camera}` : "";
        return `${description}${camera}`;
    };
    const summaryLines = storyboard
        ? [
            `白模故事板：严格 ${grid.cols} 列 × ${grid.rows} 行，共 ${grid.panelCount} 格；每格 ${aspect}，粗黑边框、白色格间距，从左到右、从上到下；不要多列、多行或重复格子。`,
            `白模规范：${effectiveStyleLock}。`,
            `禁止：${effectiveStyleNegative}。`,
            characters.length ? `角色：${characters.map((character) => `${character.name}（${character.species === "animal" ? `动物：${character.speciesLabel || "按描述体型"}` : "人类"}）`).join("、")}。人类用无脸灰衣人形；动物按物种体型画，不要人形；所有头部用短横带标朝向。` : "无主要角色。",
            `这 ${grid.panelCount} 格是 ${grid.panelCount} 个独立镜头/节拍；用景别、机位、人物反应或插入物区分；不要把同一动作拆成连续姿势。`,
            ...panels.map((panel) => `• ${panelCaption(panel)}`),
        ]
        : [
            `MOSS ${effectiveStyle} 漫画页，严格 ${gridLabel(grid)}：${grid.cols} 列 × ${grid.rows} 行等分格，共 ${grid.panelCount} 格。横向只有 ${grid.cols} 列，纵向只有 ${grid.rows} 行；禁止出现第 ${grid.cols + 1} 列，禁止 4 列、8 格、9 格、12 格等额外布局。`,
            `每一格都是 ${aspect} 画幅，粗黑边框、白色格间距，一格只画一个连续场景；同一格可以容纳多个角色，禁止按人物数量把一格拆成左右或上下两格。格与格不合并、不重叠，按从左到右、从上到下阅读。`,
            `全局画风锁定（每一格完全一致，逐格重复）：${effectiveStyleLock}`,
            ...(effectiveStyleNegative ? [`禁止出现：${effectiveStyleNegative}`] : []),
            `本页只允许以下角色出场，外观与服装必须逐格一致：`,
            ...(characters.length
                ? characters.map((character) => `- [${character.id}] ${character.name}：${character.appearanceLock || character.description || ""}${character.outfitLock ? `；${character.outfitLock}` : ""}${character.negativeLock ? `；禁止：${character.negativeLock}` : ""}`)
                : ["- 无主要角色"]),
            `分镜顺序（仅用于排布；不要在画面中绘制格号、时间码、提示词或说明文字）：`,
            ...panels.map((panel) => `• ${panelCaption(panel)}`),
            `文字只出现在每格底部的文字区域，必须与台词完全一致；文字多时按自然断句换行，不要增删内容。`,
        ];
    const cells = panels.map((_, index) => {
        const row = Math.floor(index / grid.cols);
        const col = index % grid.cols;
        return { x: col * cellWidth + 0.006, y: row * cellHeight + 0.006, width: cellWidth - 0.012, height: cellHeight - 0.012 };
    });
    const texts = storyboard ? panels.map(() => "") : panels.map((panel) => mossDialogueText(panel.dialogue));
    const objectRegions: CanvasMossLayoutRegion[] = panels.map((panel, index) => {
        const cell = cells[index];
        return {
            id: `p${index + 1}`,
            label: "object",
            caption: panelCaption(panel).slice(0, 500),
            x: cell.x,
            y: cell.y,
            width: cell.width,
            height: texts[index] ? cell.height * 0.72 : cell.height,
        };
    });
    const textRegions: CanvasMossLayoutRegion[] = panels.flatMap((_, index) => {
        if (!texts[index]) return [];
        const cell = cells[index];
        return [{
            id: `p${index + 1}t`,
            label: "text" as const,
            caption: "本格对白",
            text: texts[index].slice(0, 500),
            x: cell.x + cell.width * 0.05,
            y: cell.y + cell.height * 0.76,
            width: cell.width * 0.9,
            height: cell.height * 0.2,
        }];
    });
    // One object region per panel only; extra character boxes make MOSS split cells into extra panels.
    const regions = [...objectRegions, ...textRegions].slice(0, 32);
    return { summary: summaryLines.join("\n").slice(0, 4000), regions, width: size.width, height: size.height, ...(storyboard ? { storyboardVersion: STORYBOARD_PROMPT_VERSION } : {}) };
}

function normalizeShotGroups(value: unknown, panelCount: number): CanvasAutomationShotGroup[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const groups: CanvasAutomationShotGroup[] = [];
    value.forEach((item) => {
        const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const rawPanels = Array.isArray(source.panels) ? source.panels : [];
        const panels = [...new Set(rawPanels.map((panel) => Number(panel)).filter((panel) => Number.isInteger(panel) && panel >= 1 && panel <= panelCount))].sort((left, right) => left - right);
        if (!panels.length) return;
        const mode = source.mode === "long_take" || source.mode === "insert" ? source.mode : "cut";
        groups.push({ panels, mode, template: asText(source.template).slice(0, 40) || undefined, reason: asText(source.reason).slice(0, 200) });
    });
    groups.sort((left, right) => left.panels[0] - right.panels[0]);
    return groups.length ? groups : undefined;
}

function normalizeEventIds(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    const ids = value
        .map((item) => {
            const raw = typeof item === "number" ? `e${item}` : asText(item).trim();
            const match = /^(?:e|E)?(\d+)$/.exec(raw);
            return match ? `e${match[1]}` : raw;
        })
        .filter(Boolean)
        .slice(0, 40);
    return ids.length ? [...new Set(ids)] : undefined;
}

export function normalizeComicPlan(raw: unknown, settings: CanvasAutomationSettings): { style: string; styleLock: string; styleNegative: string; characters: CanvasAutomationCharacter[]; scenes: CanvasAutomationScene[]; pages: CanvasAutomationPage[] } {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const style = asText(source.style, settings.style);
    let styleLock = asText(source.style_lock || source.styleLock, style);
    if (!styleLock.includes(style)) styleLock = `${style}；${styleLock}`;
    const guide = styleReference(style);
    if (guide && !styleLock.includes(guide)) styleLock = `${styleLock}；${guide}`;
    const styleNegative = asText(source.style_negative || source.styleNegative, DEFAULT_STYLE_NEGATIVE);
    const rawCharacters = Array.isArray(source.characters) ? source.characters : [];
    const characters = rawCharacters
        .map(normalizeCharacter)
        .filter((character): character is CanvasAutomationCharacter => Boolean(character))
        .filter((character) => !isCrowdCharacterName(character.name))
        .slice(0, 4);
    const scenes: CanvasAutomationScene[] = [];
    const sceneById = new Map<string, CanvasAutomationScene>();
    const sceneByName = new Map<string, CanvasAutomationScene>();
    const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
    rawScenes.forEach((item, index) => {
        const sceneSource = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const name = asText(sceneSource.name);
        if (!name) return;
        const id = asText(sceneSource.id, `s${index + 1}`).slice(0, 40);
        const description = asText(sceneSource.description || sceneSource.scene_description).slice(0, 500);
        const existing = sceneById.get(id) || sceneByName.get(name);
        if (existing) {
            if (!existing.description && description) existing.description = description;
            return;
        }
        const scene = { id, name, description };
        scenes.push(scene);
        sceneById.set(id, scene);
        sceneByName.set(name, scene);
    });
    const gridSpec = automationGridSpec(settings.grid);
    const grid: CanvasAutomationGrid = { rows: gridSpec.rows, cols: gridSpec.cols, panelCount: gridSpec.panelCount };
    const rawPages = Array.isArray(source.pages) ? source.pages : [];
    if (!rawPages.length) throw new Error("模型没有返回分镜页");
    const autoPageCount = settings.pageCountAuto === true;
    const pageLimit = Math.max(2, Math.min(24, settings.pageCount || 12));
    const acceptedPages = autoPageCount ? rawPages.slice(0, 24) : rawPages.slice(0, pageLimit);
    const pages = acceptedPages.map((item, index) => {
        const page = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const rawSceneId = asText(page.scene_id || page.sceneId);
        const rawSceneName = asText(page.scene || page.location);
        let pageScene = sceneById.get(rawSceneId) || sceneByName.get(rawSceneName);
        if (!pageScene && scenes.length) pageScene = scenes[0];
        if (!pageScene) {
            const name = rawSceneName || asText(page.title, `场景 ${index + 1}`);
            const id = rawSceneId || `s${scenes.length + 1}`;
            pageScene = { id, name, description: asText(page.scene_description || page.sceneDescription).slice(0, 500) };
            scenes.push(pageScene);
            sceneById.set(id, pageScene);
            sceneByName.set(name, pageScene);
        }
        const sceneId = pageScene.id;
        const scene = pageScene.name;
        const sceneDescription = pageScene.description || asText(page.scene_description || page.sceneDescription).slice(0, 500);
        const rawPanels = Array.isArray(page.panels) ? [...page.panels] : [];
        while (rawPanels.length < gridSpec.panelCount) {
            rawPanels.push({ description: "same scene, reaction or establishing beat", camera: "static", dialogue: [], characters: [] });
        }
        const pageSeconds = clampSeconds(Math.max(rawPageVideoSeconds(page, rawPanels, settings), settings.videoSeconds === "auto" && settings.segmentation === "long" ? 8 : 2));
        const panels = rawPanels
            .slice(0, gridSpec.panelCount)
            .map((panel, panelIndex) => normalizePanel(panel, panelIndex, characters, pageSeconds, gridSpec.panelCount));
        let keySeen = false;
        panels.forEach((panel) => {
            if (panel.beat !== "key") return;
            if (keySeen) panel.beat = "support";
            else keySeen = true;
        });
        const usedCharacterIds = new Set(panels.flatMap((panel) => panel.characters || []));
        const hadCharacterRefs = rawPanels.some((item) => {
            const panelSource = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const raw = panelSource.characters || panelSource.characters_in_panel;
            return Array.isArray(raw) && raw.length > 0;
        });
        const pageCharacters = characters.filter((character) => usedCharacterIds.has(character.id));
        const visibleCharacters = usedCharacterIds.size ? pageCharacters : hadCharacterRefs ? [] : characters;
        const layout = buildGridMoss({ style, styleLock, styleNegative, characters: visibleCharacters, panels, grid, aspect: settings.aspect, storyboard: settings.storyboardWhiteModel !== false });
        const dialogue = sanitizeDialogueLines(page.dialogue);
        return {
            index,
            title: asText(page.title, `第 ${index + 1} 页`).slice(0, 60),
            sceneId,
            scene,
            sceneDescription,
            focus: asText(page.focus || page.story_focus || page.key_beat).slice(0, 200),
            eventIds: normalizeEventIds(page.events || page.event_ids || page.eventIds),
            shotGroups: normalizeShotGroups(page.shot_groups || page.shotGroups, gridSpec.panelCount),
            narration: "",
            dialogue,
            videoHint: asText(page.video_hint || page.videoHint).slice(0, 800),
            grid,
            panels,
            style,
            styleLock,
            styleNegative,
            videoSeconds: String(pageSeconds),
            characters: visibleCharacters,
            layout,
            imageState: "pending" as const,
            videoState: "pending" as const,
        };
    });
    const usedSceneIds = new Set(pages.map((page) => page.sceneId).filter((id): id is string => Boolean(id)));
    const storyScenes = usedSceneIds.size ? scenes.filter((scene) => usedSceneIds.has(scene.id)) : scenes;
    return { style, styleLock, styleNegative, characters, scenes: storyScenes, pages };
}

function normalizeSpokenMatch(text: string) {
    return text
        .replace(/^\[[^\]]+\]\s*/, "")
        .replace(/^[^：:\n]{1,24}[：:]\s*/, "")
        .replace(/[\s，。！？、,.!?；;：:…—\-"'“”「」『』～~]/g, "")
        .trim();
}

function longestCommonSubstringLength(left: string, right: string) {
    let previous = new Array(right.length + 1).fill(0);
    let best = 0;
    for (let index = 1; index <= left.length; index += 1) {
        const current = new Array(right.length + 1).fill(0);
        for (let cursor = 1; cursor <= right.length; cursor += 1) {
            if (left[index - 1] === right[cursor - 1]) {
                current[cursor] = previous[cursor - 1] + 1;
                if (current[cursor] > best) best = current[cursor];
            }
        }
        previous = current;
    }
    return best;
}

function dialogueSimilarity(left: string, right: string) {
    const length = Math.max(left.length, right.length);
    return length ? longestCommonSubstringLength(left, right) / length : 0;
}

function sanitizePromptDialogue(prompt: string, page: CanvasAutomationPage) {
    const allowed = pageSpokenDialogue(page)
        .map((line) => ({ line, key: normalizeSpokenMatch(line) }))
        .filter((entry) => Boolean(entry.key));
    return prompt.replace(/<d>([\s\S]*?)<\/d>/gi, (whole, inner) => {
        const spoken = normalizeSpokenMatch(String(inner || ""));
        if (!spoken) return whole;
        if (allowed.some((entry) => entry.key === spoken)) return whole;
        let best = allowed[0];
        let bestScore = 0;
        for (const entry of allowed) {
            const score = dialogueSimilarity(spoken, entry.key);
            if (score > bestScore) {
                best = entry;
                bestScore = score;
            }
        }
        if (!best || bestScore < 0.7) return whole;
        const language = /^\s*(\[[^\]]+\])/.exec(String(inner))?.[1] || "[Chinese]";
        return `<d>${language} ${best.line}</d>`;
    });
}

function missingPromptDialogue(prompt: string, page: CanvasAutomationPage) {
    const present = new Set(
        [...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)]
            .map((match) => normalizeSpokenMatch(match[1]))
            .filter(Boolean),
    );
    return pageSpokenDialogue(page).filter((line) => !present.has(normalizeSpokenMatch(line)));
}

function unmatchedPromptDialogue(prompt: string, page: CanvasAutomationPage) {
    const allowed = new Set(pageSpokenDialogue(page).map(normalizeSpokenMatch).filter(Boolean));
    return [...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)]
        .map((match) => normalizeSpokenMatch(match[1]))
        .filter(Boolean)
        .filter((line) => !allowed.has(line));
}

function repairMissingPromptDialogue(prompt: string, page: CanvasAutomationPage) {
    const missing = missingPromptDialogue(prompt, page);
    if (!missing.length) return { text: prompt, missing };
    let cursor = 0;
    const text = prompt.replace(/((?:S\d+|SYS)[^\n:：]{0,240}[:：])[ \t]*(?=\n|$)/g, (whole, cue) => {
        if (cursor >= missing.length) return whole;
        const line = missing[cursor];
        cursor += 1;
        return `${cue} <d>[Chinese] ${line}</d>`;
    });
    return { text, missing: missing.slice(cursor) };
}

export function applyComicFrameworkHints(plan: ReturnType<typeof normalizeComicPlan>, framework?: unknown) {
    const raw = framework && typeof framework === "object" ? (framework as Record<string, unknown>) : null;
    const rawPages = raw && Array.isArray(raw.pages) ? raw.pages : [];
    plan.pages.forEach((page, index) => {
        const rawPage = rawPages[index] && typeof rawPages[index] === "object" ? (rawPages[index] as Record<string, unknown>) : null;
        if (!rawPage) return;
        const rawPanels = Array.isArray(rawPage.panels) ? rawPage.panels : [];
        page.panels?.forEach((panel, panelIndex) => {
            if (panel.background) return;
            const rawPanel = rawPanels[panelIndex] && typeof rawPanels[panelIndex] === "object" ? (rawPanels[panelIndex] as Record<string, unknown>) : null;
            panel.background = asText(rawPanel?.background || rawPanel?.background_people || rawPanel?.crowd).slice(0, 160) || undefined;
        });
        const rawGroups = normalizeShotGroups(rawPage.shot_groups, page.panels?.length || 0) || [];
        page.shotGroups?.forEach((group) => {
            if (group.template) return;
            const key = `${group.panels.join("-")}:${group.mode}`;
            const match = rawGroups.find((item) => `${item.panels.join("-")}:${item.mode}` === key) || rawGroups[page.shotGroups!.indexOf(group)];
            if (match?.template) group.template = match.template;
        });
    });
    return plan;
}

function dialogueSpeakerKey(line: string) {
    const match = /^([^：:]{1,24})[：:]/.exec(line);
    return match ? match[1].trim() : line;
}

export function reviewComicPlan(
    plan: ReturnType<typeof normalizeComicPlan>,
    settings: CanvasAutomationSettings,
    script?: CanvasAutomationScript,
    framework?: unknown,
): { warnings: string[]; needsRetry: boolean } {
    const warnings: string[] = [];
    let needsRetry = false;
    const gridSpec = automationGridSpec(settings.grid);
    const rawFramework = framework && typeof framework === "object" ? (framework as Record<string, unknown>) : null;
    const rawPages = rawFramework && Array.isArray(rawFramework.pages) ? rawFramework.pages : [];
    if (rawPages.length) {
        if (rawPages.length !== plan.pages.length) {
            warnings.push(`第 3 轮页数偏离框架：框架 ${rawPages.length} 页，细节 ${plan.pages.length} 页`);
            needsRetry = true;
        }
        plan.pages.forEach((page, index) => {
            const rawPage = rawPages[index] && typeof rawPages[index] === "object" ? (rawPages[index] as Record<string, unknown>) : null;
            if (!rawPage) return;
            const rawEvents = normalizeEventIds(rawPage.events) || [];
            const planEvents = page.eventIds || [];
            if (rawEvents.join(",") !== planEvents.join(",")) {
                warnings.push(`第 ${page.index + 1} 页事件与框架不一致`);
                needsRetry = true;
            }
            const rawGroups = normalizeShotGroups(rawPage.shot_groups, gridSpec.panelCount) || [];
            const planGroups = page.shotGroups || [];
            const groupKey = (groups: CanvasAutomationShotGroup[]) => groups.map((group) => `${group.panels.join("-")}:${group.mode}`).join("|");
            if (groupKey(rawGroups) !== groupKey(planGroups)) {
                warnings.push(`第 ${page.index + 1} 页 shot_groups 与框架不一致`);
                needsRetry = true;
            }
            const rawPanels = Array.isArray(rawPage.panels) ? rawPage.panels : [];
            const rawDialogue = rawPanels.flatMap((panel) => sanitizeDialogueLines(panel && typeof panel === "object" ? (panel as Record<string, unknown>).dialogue : [])).join("|");
            const planDialogue = (page.panels || []).flatMap((panel) => panel.dialogue || []).join("|");
            if (rawDialogue !== planDialogue) {
                warnings.push(`第 ${page.index + 1} 页台词与框架不一致`);
                needsRetry = true;
            }
            if (asText(rawPage.title) && asText(rawPage.title) !== page.title) warnings.push(`第 ${page.index + 1} 页标题与框架不一致`);
            const rawSceneId = asText(rawPage.scene_id || rawPage.sceneId);
            if (rawSceneId && rawSceneId !== page.sceneId) warnings.push(`第 ${page.index + 1} 页场景与框架不一致`);
            if (asText(rawPage.focus) && asText(rawPage.focus) !== page.focus) warnings.push(`第 ${page.index + 1} 页 focus 与框架不一致`);
        });
    }
    const frameworkHasTemplates = rawPages.some((rawPage) => {
        const page = rawPage && typeof rawPage === "object" ? (rawPage as Record<string, unknown>) : null;
        return Array.isArray(page?.shot_groups) && page.shot_groups.some((group) => group && typeof group === "object" && Boolean(asText((group as Record<string, unknown>).template)));
    });
    if (frameworkHasTemplates) {
        const missingTemplates = plan.pages.flatMap((page) => (page.shotGroups || []).filter((group) => !group.template).map(() => `第 ${page.index + 1} 页`));
        if (missingTemplates.length) {
            warnings.push(`第 4 轮查错：${missingTemplates.length} 个 shot_group 丢失镜头模板`);
            needsRetry = true;
        }
    }
    plan.pages.forEach((page) => {
        (page.shotGroups || []).filter((group) => group.mode === "long_take").forEach((group) => {
            const speakers = new Set(group.panels.flatMap((panelIndex) => page.panels?.[panelIndex - 1]?.dialogue || []).map(dialogueSpeakerKey));
            if (speakers.size > 1) {
                warnings.push(`第 4 轮查错：第 ${page.index + 1} 页 long_take 组 panels ${group.panels.join("–")} 包含多个说话人`);
                needsRetry = true;
            }
        });
    });
    const missingStoryboards = plan.pages.flatMap((page) =>
        (page.panels || [])
            .filter((panel) => !panel.storyboardDescription?.trim())
            .map((panel) => `第 ${page.index + 1} 页第 ${panel.index} 格`),
    );
    if (missingStoryboards.length) {
        warnings.push(`第 3 轮有 ${missingStoryboards.length} 格没有白模故事板：${missingStoryboards.slice(0, 8).join("、")}`);
        if (missingStoryboards.length > plan.pages.length) needsRetry = true;
    }
    const emptyPanels = plan.pages.flatMap((page) =>
        (page.panels || [])
            .filter((panel) => !panel.description || panel.description === "画面内容")
            .map((panel) => `第 ${page.index + 1} 页第 ${panel.index} 格`),
    );
    if (emptyPanels.length) {
        warnings.push(`第 3 轮有 ${emptyPanels.length} 格没有有效 description：${emptyPanels.slice(0, 8).join("、")}`);
        if (emptyPanels.length > plan.pages.length) needsRetry = true;
    }
    const duplicates = duplicatePageEvents(plan.pages);
    if (duplicates.length) {
        warnings.push(`第 4 轮查错：事件重复 ${duplicates.join("、")}`);
        needsRetry = true;
    }
    if (script) {
        const missing = missingPageEvents(plan.pages, script);
        if (missing.length) {
            warnings.push(`第 4 轮查错：漏事件 ${missing.join("、")}`);
            needsRetry = true;
        }
    }
    const overlong = plan.pages.filter((page) => pageSpeechSeconds(page) > 25).map((page) => page.index + 1);
    if (overlong.length) {
        warnings.push(`第 4 轮查错：第 ${overlong.join("、")} 页台词超过 25 秒`);
        needsRetry = true;
    }
    plan.pages.forEach((page) => {
        const groups = page.shotGroups || [];
        if (!groups.length) return;
        const panelCount = page.panels?.length || 0;
        const covered = new Set(groups.flatMap((group) => group.panels));
        if (covered.size !== panelCount || Array.from({ length: panelCount }, (_, index) => index + 1).some((panel) => !covered.has(panel))) {
            warnings.push(`第 ${page.index + 1} 页 shot_groups 没有覆盖全部 panel`);
        }
    });
    return { warnings: [...new Set(warnings)], needsRetry };
}

const CAMERA_MOVE_PATTERN = /\b(?:pan|pans|panning|truck|trucks|trucking|dolly|dollies|dollying|track|tracks|tracking|push in|pushes in|pushing in|pull out|pulls out|pulling out|zoom|zooms|zooming|slides? forward|pulls? back|slides? (?:left|right|up|down)|rises|lowers|tilts? (?:up|down)|arcs?|drifts? with|slow push|slow pull|slow pan|slow truck|slow dolly)\b|横移|平拉|摇镜|摇摄|移镜|跟拍|推近|拉远|推镜|拉镜|缓慢推|缓慢拉|变焦/gi;

export function cameraMoveCount(prompt: string) {
    return (String(prompt || "").match(CAMERA_MOVE_PATTERN) || []).length;
}

const PERFORMANCE_DETAIL_PATTERN = /(停顿|拖长|上扬|压低|加重|重音|语速|音量|颤|爆发|咬牙|冷笑|喘|吼|低语|哽咽|沙哑|拖音|pause|stress|emphasis|trembl|whisper|shout|snarl|sneer|gasp|pace|volume|loud|quiet|slow|fast|rising|falling|drawn|lip|mechanical|electronic)/i;

function shotPanelSets(prompt: string) {
    return [...prompt.matchAll(/\[Shot\s+\d+([^\]]*)\]/gi)].map((header) => {
        const match = /panels?\s+([0-9][0-9\s,，、\-–—]*)/i.exec(header[1] || "");
        const panels = new Set<number>();
        if (!match) return [] as number[];
        for (const part of match[1].split(/[,，、]/)) {
            const range = /(\d+)\s*[-–—]\s*(\d+)/.exec(part);
            if (range) {
                const start = Number(range[1]);
                const end = Number(range[2]);
                if (start > end) return [] as number[];
                for (let index = start; index <= end; index += 1) panels.add(index);
                continue;
            }
            const value = Number(part.trim());
            if (Number.isFinite(value) && value > 0) panels.add(value);
        }
        return [...panels].sort((a, b) => a - b);
    });
}

export function shotPanelCoverage(prompt: string, panelCount: number) {
    if (!panelCount) return true;
    const sets = shotPanelSets(prompt);
    if (!sets.length || sets.some((set) => !set.length)) return false;
    const covered = new Set(sets.flat());
    if (covered.size !== panelCount) return false;
    return [...covered].sort((a, b) => a - b).every((value, index) => value === index + 1);
}

export function shotGroupConformance(prompt: string, page: Pick<CanvasAutomationPage, "shotGroups">) {
    const groups = page.shotGroups || [];
    if (!groups.length) return true;
    const sets = shotPanelSets(prompt);
    if (!sets.length || sets.some((set) => !set.length)) return false;
    const belongs = sets.every((set) => groups.some((group) => set.every((panel) => group.panels.includes(panel))));
    if (!belongs) return false;
    for (const group of groups) {
        const inside = sets.filter((set) => set.every((panel) => group.panels.includes(panel)));
        if (group.mode === "long_take") {
            if (inside.length !== 1) return false;
            if (!group.panels.every((panel) => inside[0].includes(panel))) return false;
            continue;
        }
        const covered = new Set(inside.flat());
        if (covered.size !== group.panels.length) return false;
        if (inside.some((set) => set.length !== 1)) return false;
    }
    return true;
}

export function hasSingleDialoguePerShot(prompt: string) {
    const blocks = prompt.split(/\[Shot\s+\d+/i).slice(1);
    if (!blocks.length) return !/<d>/i.test(prompt);
    return blocks.every((block) => ((block.match(/<d>/gi) || []).length <= 1));
}

function shotCharacterSubjects(block: string, characterCount: number) {
    return new Set(
        [...block.matchAll(/<Subject\s+(\d+)>/gi)]
            .map((match) => Number(match[1]))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= characterCount),
    );
}

function hasListenerLipLock(block: string) {
    return /lips?\s+(?:remain|stay)\s+(?:completely\s+)?closed|no lip[- ]?sync|mouth\s+(?:remains|stays)\s+closed|closed mouth/i.test(block);
}

function missingListenerLipLock(prompt: string, characterCount: number) {
    if (characterCount < 2) return false;
    const blocks = prompt.split(/\[Shot\s+\d+/i).slice(1);
    return blocks.some((block) => /<d>/i.test(block) && shotCharacterSubjects(block, characterCount).size >= 2 && !hasListenerLipLock(block));
}

function repairListenerLipLock(prompt: string, characterCount: number) {
    if (characterCount < 2) return prompt;
    const blocks = prompt.split(/(?=\[Shot\s+\d+)/i);
    return blocks.map((block) => {
        if (!/^\[Shot\s+\d+/i.test(block) || !/<d>/i.test(block)) return block;
        if (shotCharacterSubjects(block, characterCount).size < 2 || hasListenerLipLock(block)) return block;
        return block.replace(/(<d>[\s\S]*?<\/d>)/i, "$1 The other visible character's lips remain completely closed, no lip-sync, no mouthing.");
    }).join("");
}

function hasPerformanceCues(prompt: string) {
    const blocks = [...prompt.matchAll(/<d>/gi)];
    return blocks.every((block) => {
        const start = block.index || 0;
        const before = prompt.slice(Math.max(0, start - 260), start);
        const speakers = [...before.matchAll(/(?:\(?\s*(?:S\d+|SYS)\b\s*\)?)/gi)];
        if (!speakers.length) return false;
        const last = speakers[speakers.length - 1];
        const cue = before.slice(last.index || 0);
        if (!/^\(?\s*(?:S\d+|SYS)\b\s*\)?\s*[（(][^）)]{2,}[）)]/.test(cue)) return false;
        return PERFORMANCE_DETAIL_PATTERN.test(cue);
    });
}

function ensureRef2VAPrompt(prompt: string, pageIndex: number) {
    let text = String(prompt || "").trim().replace(/^```(?:text)?\s*/i, "").replace(/```$/i, "").trim();
    text = text.replace(/^For the target video,[^\n]*\n*/i, "").trim();
    if (/integrated_multimodal_description\s*:/i.test(text)) throw new Error(`第 ${pageIndex + 1} 页仍是 I2VA 格式，已拒绝`);
    const positions = REF2VA_SECTIONS.map((section) => {
        const match = new RegExp(`(^|\\n)\\s*${section}\\s*:`).exec(text);
        return match ? match.index : -1;
    });
    const missing = REF2VA_SECTIONS.filter((_, index) => positions[index] < 0);
    if (missing.length) throw new Error(`第 ${pageIndex + 1} 页 Ref2VA 提示词缺少字段：${missing.join("、")}`);
    if (!positions.every((position, index) => index === 0 || positions[index - 1] < position)) throw new Error(`第 ${pageIndex + 1} 页 Ref2VA 字段顺序不正确`);
    REF2VA_SECTIONS.forEach((section) => {
        text = text.replace(new RegExp(`(^|\\n)\\s*${section}\\s*:`, "g"), `\n\n${section}:`);
    });
    text = text.trim();
    const subjectStart = text.indexOf("subject_definitions:");
    if (subjectStart > 0) text = text.slice(subjectStart).trim();
    if (!/no subtitles|no captions|no on-screen text|无字幕/i.test(text)) {
        text = text.replace(/(\ndetailed_description\s*:[\s\S]*?)(\n\s*overall_soundscape\s*:)/i, (whole, head, tail) => `${head}\nNo subtitles, no captions, no on-screen text, no watermarks.${tail}`);
    }
    text = text.replace(/(\n\nnon_diegetic_music\s*:)[\s\S]*$/i, "\n\nnon_diegetic_music: N/A");
    return text;
}

function fallbackRef2VAPrompt(page: CanvasAutomationPage, sheets: CanvasAutomationCharacterSheet[], sceneSheets: CanvasAutomationSceneSheet[], style: string) {
    const manifest = buildAutomationVideoReference(page, sheets, sceneSheets);
    const subjects: string[] = [];
    const subjectBySpeaker = new Map<string, number>();
    manifest.characters.forEach((character, index) => {
        subjectBySpeaker.set(character.name, index + 1);
        subjects.push(`<Subject ${index + 1}> (S${index + 1}) ${character.name}; appearance: ${character.appearanceLock || "as shown"}; outfit: ${character.outfitLock || "as shown"}; reference <Picture ${character.pictureIndex}>.`);
    });
    const sceneSubject = manifest.scene ? manifest.characters.length + 1 : 0;
    if (manifest.scene) subjects.push(`<Subject ${sceneSubject}> (SCENE) ${manifest.scene.name}; reference <Picture ${manifest.scene.pictureIndex}>.`);
    const details = pageDialogueDetails(page);
    details.forEach((line) => {
        if (line.channel !== "spoken" || subjectBySpeaker.has(line.speaker)) return;
        const index = subjects.length + 1;
        subjectBySpeaker.set(line.speaker, index);
        subjects.push(`<Subject ${index}> (S${index}) ${line.speaker}; text-only, no reference picture; keep the same look.`);
    });
    if (!subjects.length) subjects.push(`<Subject 1> (S1) the character shown in <Picture ${manifest.storyboardPictureIndex}>; use the storyboard only for appearance.`);
    const panelCount = page.panels?.length || 1;
    const action = page.focus || page.videoHint || page.title || "the storyboard beat";
    const shots = details.map((line, index) => {
        const subject = line.channel === "system" ? "SYS" : `S${subjectBySpeaker.get(line.speaker) || 1}`;
        const channel = line.channel === "inner" ? "inner voice, lips closed" : line.channel === "system" ? "system voice, mechanical, no lip-sync" : "natural";
        return `[Shot ${index + 1}] | panels ${Math.min(panelCount, index + 1)} | ${action}. ${subject} (${channel}, medium volume, steady pace): <d>[Chinese] ${line.text}</d>`;
    });
    if (!shots.length) shots.push(`[Shot 1] | panels 1-${panelCount} | ${action}.`);
    return `subject_definitions:
${subjects.join("\n")}

summary:
${page.title || "Storyboard page"}; ${page.focus || ""}; ${manifest.scene?.name || page.scene || page.sceneId || "scene"}. Art style: ${style || page.styleLock || page.style || "consistent with the storyboard"}. Storyboard <Picture ${manifest.storyboardPictureIndex}> is for shot order and composition only.

retention_analysis:
${manifest.characters.map((_, index) => `<Subject ${index + 1}>: fully_preserved.`).join("\n")}
${manifest.scene ? `<Subject ${sceneSubject}> (scene): fully_preserved.` : ""}
<Picture ${manifest.storyboardPictureIndex}>: fully_preserved as storyboard only.

detailed_description:
No subtitles, no captions, no on-screen text.
${shots.join("\n")}

overall_soundscape:
Ambient room tone and physical action sounds. voice performance: S1 natural, medium volume, steady pace.

non_diegetic_music:
N/A`;
}

function dialogueSpeaker(lines?: string[]) {
    const line = lines?.[0];
    if (!line) return "";
    const match = /^([^：:\n]{1,24})[：:]\s*/.exec(line);
    return match?.[1]?.trim() || "";
}

export type CanvasAutomationVideoSegmentDraft = {
    index: number;
    panels: CanvasAutomationPanelSpec[];
    dialogue: string[];
    shotGroups?: CanvasAutomationShotGroup[];
    panelRange: [number, number];
    seconds: string;
};

export function splitPageVideoSegments(page: CanvasAutomationPage, grid: CanvasAutomationSettings["grid"], maxSeconds = 25): CanvasAutomationVideoSegmentDraft[] {
    if (pageSpeechSeconds(page) <= maxSeconds) return [];
    const gridCount = page.grid?.panelCount || automationGridSpec(grid).panelCount;
    const panels: CanvasAutomationPanelSpec[] = (page.panels || []).length
        ? page.panels!
        : (page.dialogue || []).map((line, index) => ({ index: index + 1, description: page.focus || "同场景节拍", camera: "static", dialogue: [line], characters: [] }));
    if (!panels.length) return [];
    const panelSeconds = panels.map((panel) => rawSpeechSeconds(panel.dialogue || [], "", 1));
    const prefix = [0];
    panelSeconds.forEach((seconds) => prefix.push(prefix[prefix.length - 1] + seconds));
    const shotGroups = page.shotGroups || [];
    const breaks = new Set<number>();
    shotGroups.slice(1).forEach((group) => {
        const first = Math.min(...group.panels) - 1;
        if (first > 0) breaks.add(first);
    });
    if (!shotGroups.length) {
        for (let index = 1; index < panels.length; index += 1) {
            const previous = panels[index - 1];
            const next = panels[index];
            const previousSpeaker = dialogueSpeaker(previous.dialogue);
            const nextSpeaker = dialogueSpeaker(next.dialogue);
            if (previousSpeaker && nextSpeaker && previousSpeaker !== nextSpeaker) breaks.add(index);
            else if (previous.camera !== next.camera) breaks.add(index);
            else if ((previous.beat || "") !== (next.beat || "")) breaks.add(index);
        }
    }
    const chunks: { panels: CanvasAutomationPanelSpec[]; start: number; end: number }[] = [];
    let start = 0;
    while (start < panels.length) {
        let end = start;
        let total = 0;
        while (end < panels.length && end - start < gridCount && (end === start || total + panelSeconds[end] <= maxSeconds)) {
            total += panelSeconds[end];
            end += 1;
        }
        if (end === start) end = start + 1;
        if (end < panels.length) {
            const candidates = [...breaks].filter((candidate) => candidate > start && candidate <= end && prefix[candidate] - prefix[start] >= 8);
            if (candidates.length) end = Math.max(...candidates);
        }
        chunks.push({ panels: panels.slice(start, end), start, end });
        start = end;
    }
    if (chunks.length <= 1) return [];
    return chunks.map((chunk, index) => {
        const chunkPanels = chunk.panels;
        const panelIds = new Set(chunkPanels.map((panel) => panel.index));
        const segmentGroups = shotGroups
            .map((group) => {
                const included = group.panels.filter((panel) => panelIds.has(panel));
                if (!included.length) return null;
                return { ...group, panels: included, mode: included.length === group.panels.length ? group.mode : ("cut" as const) };
            })
            .filter((group): group is CanvasAutomationShotGroup => Boolean(group));
        const dialogue = chunkPanels.flatMap((panel) => panel.dialogue || []);
        const segmentPage = { ...page, panels: chunkPanels, dialogue, shotGroups: segmentGroups.length ? segmentGroups : undefined, videoSeconds: undefined };
        return {
            index,
            panels: chunkPanels,
            dialogue,
            shotGroups: segmentGroups.length ? segmentGroups : undefined,
            panelRange: [chunkPanels[0].index, chunkPanels[chunkPanels.length - 1].index] as [number, number],
            seconds: String(clampSeconds(Math.max(estimatePageVideoSeconds(segmentPage), 2))),
        };
    });
}

export function splitOverlongPages(pages: CanvasAutomationPage[], grid: CanvasAutomationSettings["grid"], maxSeconds = 25): CanvasAutomationPage[] {
    const result: CanvasAutomationPage[] = [];
    for (const page of pages) {
        if (pageSpeechSeconds(page) <= maxSeconds) {
            result.push(page);
            continue;
        }
        const gridCount = page.grid?.panelCount || automationGridSpec(grid).panelCount;
        const panels: CanvasAutomationPanelSpec[] = (page.panels || []).length
            ? page.panels!
            : (page.dialogue || []).map((line, index) => ({ index: index + 1, description: page.focus || "同场景节拍", camera: "static", dialogue: [line], characters: [] }));
        if (!panels.length) {
            result.push(page);
            continue;
        }
        const panelSeconds = panels.map((panel) => rawSpeechSeconds(panel.dialogue || [], "", 1));
        const prefix = [0];
        panelSeconds.forEach((seconds) => prefix.push(prefix[prefix.length - 1] + seconds));
        const shotGroups = page.shotGroups || [];
        const breaks = new Set<number>();
        shotGroups.slice(1).forEach((group) => {
            const first = Math.min(...group.panels) - 1;
            if (first > 0) breaks.add(first);
        });
        if (!shotGroups.length) {
            for (let index = 1; index < panels.length; index += 1) {
                const previous = panels[index - 1];
                const next = panels[index];
                const previousSpeaker = dialogueSpeaker(previous.dialogue);
                const nextSpeaker = dialogueSpeaker(next.dialogue);
                if (previousSpeaker && nextSpeaker && previousSpeaker !== nextSpeaker) breaks.add(index);
                else if (previous.camera !== next.camera) breaks.add(index);
                else if ((previous.beat || "") !== (next.beat || "")) breaks.add(index);
            }
        }
        const chunks: { panels: CanvasAutomationPanelSpec[]; start: number; end: number }[] = [];
        let start = 0;
        while (start < panels.length) {
            let end = start;
            let total = 0;
            while (end < panels.length && end - start < gridCount && (end === start || total + panelSeconds[end] <= maxSeconds)) {
                total += panelSeconds[end];
                end += 1;
            }
            if (end === start) end = start + 1;
            if (end < panels.length) {
                const candidates = [...breaks].filter((candidate) => candidate > start && candidate <= end && prefix[candidate] - prefix[start] >= 8);
                if (candidates.length) end = Math.max(...candidates);
            }
            chunks.push({ panels: panels.slice(start, end), start, end });
            start = end;
        }
        if (chunks.length <= 1) {
            result.push(page);
            continue;
        }
        chunks.forEach(({ panels: chunk, start: chunkStart, end: chunkEnd }, chunkIndex) => {
            const filled = [...chunk];
            for (let index = filled.length; index < gridCount; index += 1) {
                filled.push({ index: index + 1, description: "同场景反应或环境补充", camera: "static", dialogue: [], characters: [] });
            }
            const mappedShotGroups = shotGroups
                .map((group) => {
                    const included = group.panels.filter((panel) => panel - 1 >= chunkStart && panel - 1 < chunkEnd);
                    if (!included.length) return null;
                    return { ...group, panels: included.map((panel) => panel - chunkStart), mode: included.length === group.panels.length ? group.mode : ("cut" as const) };
                })
                .filter((group): group is CanvasAutomationShotGroup => Boolean(group));
            result.push({
                ...page,
                index: 0,
                title: chunkIndex ? `${page.title}（续${chunkIndex + 1}）` : page.title,
                narration: "",
                dialogue: chunk.flatMap((panel) => panel.dialogue || []),
                panels: filled.slice(0, gridCount).map((panel, index) => ({ ...panel, index: index + 1 })),
                eventIds: chunkIndex === 0 ? page.eventIds : undefined,
                shotGroups: mappedShotGroups.length ? mappedShotGroups : undefined,
                videoSeconds: undefined,
                textNodeId: undefined,
                imageNodeId: undefined,
                videoNodeId: undefined,
                imageState: "pending",
                videoState: "pending",
                error: undefined,
            });
        });
    }
    return result.map((page, index) => ({ ...page, index }));
}

export function normalizeVideoPrompts(raw: unknown, pages: CanvasAutomationPage[], sheets: CanvasAutomationCharacterSheet[] = [], sceneSheets: CanvasAutomationSceneSheet[] = []): { pages: CanvasAutomationPage[]; failed: number[]; warnings: string[]; reasons: Record<number, string> } {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const list = Array.isArray(source.pages) ? source.pages : Array.isArray(raw) ? raw : [];
    const byPage = new Map<number, string>();
    list.forEach((item, index) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const page = asNumber(entry.page, index + 1) - 1;
        const prompt = asText(entry.prompt);
        if (prompt) byPage.set(page, prompt);
    });
    const failed: number[] = [];
    const warnings: string[] = [];
    const reasons: Record<number, string> = {};
    const next = pages.map((page) => {
        const prompt = byPage.get(page.index) || page.videoPrompt || "";
        const useFallback = (reason: string) => {
            warnings.push(`第 ${page.index + 1} 页${reason ? `（${reason}）` : ""}，已使用保底提示词`);
            return { ...page, videoPrompt: fallbackRef2VAPrompt(page, sheets, sceneSheets, page.styleLock || page.style || "") };
        };
        if (!prompt) return useFallback("没有返回提示词");
        try {
            const rawText = ensureRef2VAPrompt(prompt, page.index);
            let text = sanitizePromptDialogue(rawText, page);
            const unmatched = unmatchedPromptDialogue(text, page);
            if (unmatched.length) {
                warnings.push(`第 ${page.index + 1} 页有 ${unmatched.length} 句台词与原剧本不一致，已使用保底提示词`);
                return useFallback("台词未匹配原剧本");
            }
            const missingBefore = missingPromptDialogue(text, page);
            if (missingBefore.length) {
                const repaired = repairMissingPromptDialogue(text, page);
                text = repaired.text;
                if (repaired.missing.length) {
                    warnings.push(`第 ${page.index + 1} 页有 ${repaired.missing.length} 句台词未写入提示词，已使用保底提示词`);
                    return useFallback("台词缺失");
                }
                warnings.push(`第 ${page.index + 1} 页有 ${missingBefore.length} 句台词未写入提示词，已补回`);
            }
            const manifest = buildAutomationVideoReference(page, sheets, sceneSheets);
            const lipLockBefore = missingListenerLipLock(text, manifest.characters.length);
            text = repairListenerLipLock(text, manifest.characters.length);
            if (lipLockBefore && missingListenerLipLock(text, manifest.characters.length)) {
                warnings.push(`第 ${page.index + 1} 页双人同框有台词，但没锁住听者嘴唇`);
            }
            if (/<d>/i.test(text) && !hasPerformanceCues(text)) warnings.push(`第 ${page.index + 1} 页台词缺少语气提示`);
            if (!hasSingleDialoguePerShot(text)) warnings.push(`第 ${page.index + 1} 页有一镜多句台词，可能重叠`);
            if (!shotPanelCoverage(text, page.panels?.length || 0)) warnings.push(`第 ${page.index + 1} 页未按故事板标 panel`);
            if (!shotGroupConformance(text, page)) warnings.push(`第 ${page.index + 1} 页未按 shot_groups 分镜`);
            const pageSeconds = Math.max(Number(page.videoSeconds) || 0, estimatePageVideoSeconds(page));
            const spokenLines = pageSpokenDialogue(page);
            if (spokenLines.length && pageSeconds) {
                const chars = spokenLines.join("").replace(/\s/g, "").length;
                const fill = chars / AUTOMATION_SPEECH_RATE / pageSeconds;
                if (fill < 0.65 || fill > 0.95) warnings.push(`第 ${page.index + 1} 页台词填充率约 ${Math.round(fill * 100)}%（目标 80–90%）`);
            }
            const maxLines = pageSeconds <= 5 ? 2 : pageSeconds <= 8 ? 3 : pageSeconds <= 12 ? 4 : pageSeconds <= 15 ? 5 : pageSeconds <= 20 ? 7 : 8;
            if (spokenLines.length > maxLines) warnings.push(`第 ${page.index + 1} 页 ${spokenLines.length} 句台词，${pageSeconds}s 建议最多 ${maxLines} 句`);
            const shotCount = (text.match(/\[Shot\s+\d+/gi) || []).length;
            const minShots = pageSeconds <= 5 ? 1 : pageSeconds <= 8 ? 2 : 3;
            const maxShots = pageSeconds <= 5 ? 2 : pageSeconds <= 8 ? 4 : 5;
            const panelCount = page.panels?.length || 0;
            const fullLongTake = panelCount > 0 && (page.shotGroups || []).some((group) => group.mode === "long_take" && group.panels.length >= panelCount);
            if (!fullLongTake && shotCount && (shotCount < minShots || shotCount > maxShots)) warnings.push(`第 ${page.index + 1} 页 ${shotCount} 个镜头，${pageSeconds}s 建议 ${minShots}–${maxShots} 个`);
            const cameraMoves = cameraMoveCount(text);
            if (cameraMoves > 1) warnings.push(`第 ${page.index + 1} 页镜头运动 ${cameraMoves} 处，短剧建议只保留 1 处`);
            const missingPicture = manifest.characters.find((reference) => !text.includes(`<Picture ${reference.pictureIndex}>`));
            if (missingPicture) warnings.push(`第 ${page.index + 1} 页 Ref2VA 缺少角色参考 <Picture ${missingPicture.pictureIndex}>`);
            if (manifest.scene && !text.includes(`<Picture ${manifest.scene.pictureIndex}>`)) warnings.push(`第 ${page.index + 1} 页 Ref2VA 缺少场景参考 <Picture ${manifest.scene.pictureIndex}>`);
            if (!text.includes(`<Picture ${manifest.storyboardPictureIndex}>`)) warnings.push(`第 ${page.index + 1} 页 Ref2VA 缺少故事板 <Picture ${manifest.storyboardPictureIndex}>`);
            const pictureNumbers = [...text.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1]));
            if (pictureNumbers.some((number) => number < 1 || number > manifest.storyboardPictureIndex)) warnings.push(`第 ${page.index + 1} 页引用了不存在的 <Picture N>`);
            return { ...page, videoPrompt: text };
        } catch (error) {
            reasons[page.index] = error instanceof Error ? error.message : "提示词校验失败";
            return useFallback(reasons[page.index]);
        }
    });
    return { pages: next, failed, warnings, reasons };
}

export function formatPageCard(page: CanvasAutomationPage) {
    return JSON.stringify(
        {
            page: page.index + 1,
            title: page.title,
            sceneId: page.sceneId || "",
            scene: page.scene || "",
            sceneDescription: page.sceneDescription || "",
            narration: page.narration || "",
            dialogue: page.dialogue || [],
            focus: page.focus || "",
            events: page.eventIds || [],
            shotGroups: page.shotGroups || [],
            videoHint: page.videoHint || "",
            videoSeconds: page.videoSeconds || "",
            style: page.style,
            styleLock: page.styleLock,
            styleNegative: page.styleNegative || "",
            grid: page.grid,
            characters: page.characters,
            panels: page.panels,
            moss: page.layout,
        },
        null,
        2,
    );
}
