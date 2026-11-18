export const AUDIO_MODES = [
    { value: "song", label: "写歌" },
    { value: "dialogue", label: "台词配音" },
] as const;

export const AUDIO_GENRES = [
    { value: "pop", label: "流行", prompt: "pop" },
    { value: "ballad", label: "抒情", prompt: "emotional ballad" },
    { value: "folk", label: "民谣", prompt: "acoustic folk" },
    { value: "rnb", label: "R&B", prompt: "R&B" },
    { value: "rock", label: "摇滚", prompt: "rock" },
    { value: "electronic", label: "电子", prompt: "electronic pop" },
    { value: "chinese", label: "中国风", prompt: "Chinese traditional fusion" },
    { value: "jazz", label: "爵士", prompt: "jazz" },
] as const;

export const AUDIO_EMOTIONS = [
    { value: "warm", label: "温柔", prompt: "warm" },
    { value: "melancholy", label: "忧郁", prompt: "melancholic" },
    { value: "bright", label: "明亮", prompt: "bright" },
    { value: "nostalgic", label: "怀旧", prompt: "nostalgic" },
    { value: "passionate", label: "热烈", prompt: "passionate" },
    { value: "healing", label: "治愈", prompt: "healing" },
    { value: "ethereal", label: "空灵", prompt: "ethereal" },
    { value: "resolute", label: "坚定", prompt: "resolute" },
] as const;

export const DEFAULT_AUDIO_GENRE = "pop";
export const DEFAULT_AUDIO_EMOTION = "warm";

export const AUDIO_STYLE_PRESETS = [
    { value: "piano-pop", label: "钢琴流行", tags: "warm piano pop, intimate female vocal, acoustic piano, soft strings, rounded bass, light drums, lyrical memorable" },
    { value: "folk", label: "民谣", tags: "acoustic folk, male vocal, fingerstyle guitar, soft percussion, warm room, storytelling" },
    { value: "chinese", label: "国风", tags: "Chinese traditional fusion, guzheng, erhu, modern pop beat, cinematic" },
    { value: "electronic", label: "电子", tags: "electronic pop, synth pads, punchy drums, bright, dance" },
    { value: "acg-edm", label: "ACG-EDM", tags: "J-pop, anime, melodic techno, progressive house, supersaw, energetic, female vocal" },
    { value: "rap", label: "说唱", tags: "fast rap, trap boom-bap hybrid, heavy 808 bass, rapid-fire male vocal" },
    { value: "rock", label: "摇滚", tags: "rock, electric guitar, live drums, male vocal, energetic, anthemic" },
    { value: "rnb", label: "R&B", tags: "R&B, groove, electric piano, smooth male vocal, warm bass, laid-back" },
    { value: "epic", label: "史诗", tags: "cinematic orchestral, epic drums, choir, strings, brass, grand, sacred" },
    { value: "jazz", label: "爵士", tags: "jazz, upright bass, brushed drums, saxophone, intimate vocal" },
] as const;

export function audioStylePresetOf(style: string | undefined) {
    const value = String(style || "").trim();
    return value ? AUDIO_STYLE_PRESETS.find((preset) => preset.tags === value) || null : null;
}

export const DIALOGUE_SPEEDS = ["慢速", "中速", "快速"] as const;
export const DIALOGUE_TONES = ["自然", "温柔", "冷静", "激动", "压低", "明亮"] as const;
export const VOICE_STRENGTHS = [
    { value: "0.6", label: "轻度" },
    { value: "0.8", label: "中度" },
    { value: "1", label: "完全" },
] as const;
export const SONG_DURATION_MIN = 30;
export const SONG_DURATION_MAX = 300;
export const SONG_DURATION_STEP = 15;
export const AUDIO_DURATION_AUTO = "0";

export function songLyricsDuration(duration: string | undefined) {
    return !duration || duration === AUDIO_DURATION_AUTO ? "120" : duration;
}

export function composeDialogueInstruction(speed: string | undefined, tone: string | undefined, instruction: string | undefined) {
    const parts: string[] = [];
    if (speed && speed !== "中速") parts.push(`语速${speed}`);
    if (tone && tone !== "自然") parts.push(`语气${tone}`);
    if (instruction?.trim()) parts.push(instruction.trim());
    return parts.join("；") || "自然、清晰地说话";
}

export function audioModeLabel(mode: string | undefined) {
    return AUDIO_MODES.find((item) => item.value === mode)?.label || "台词配音";
}

export function normalizeAudioStyle(style: string | undefined) {
    const seen = new Set<string>();
    return String(style || "")
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter((value) => {
            const key = value.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join(", ");
}

export function composeAudioStyle(base: string | undefined, genre: string | undefined, emotion: string | undefined) {
    const parts = [base?.trim() || ""];
    const genreOption = AUDIO_GENRES.find((item) => item.value === genre);
    const emotionOption = AUDIO_EMOTIONS.find((item) => item.value === emotion);
    if (genreOption) parts.push(`${genreOption.prompt} genre`);
    if (emotionOption) parts.push(`${emotionOption.prompt} mood`);
    return normalizeAudioStyle(parts.filter(Boolean).join(", "));
}
