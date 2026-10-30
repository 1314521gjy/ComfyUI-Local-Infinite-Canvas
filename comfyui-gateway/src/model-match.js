// 模型名相似匹配：格式是红线，名称相似度决定优先级。
// 目标：同一模型的不同量化/版本（int8 vs bf16、带 convrot 等）能自动认出来，
// 但不把 VAE/CLIP/文本编码器/LoRA 当成底模，也不跨格式（.safetensors ↔ .gguf）。

const MODEL_EXT = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|engine)$/i;
const FUZZY_EXT = new Set([".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf"]);

export const FUZZY_MODEL_EXTENSIONS = FUZZY_EXT;

const FAMILY_TOKENS = new Set([
    "moss",
    "krea2",
    "krea",
    "qwen",
    "qwen2",
    "qwen3",
    "h3",
    "minimax",
    "seedvr",
    "seedvr2",
    "flux",
    "wan",
    "zimage",
    "ltx",
    "ltxv",
    "ltx2",
    "hidream",
    "chroma",
    "sd3",
    "sdxl",
    "pony",
    "illustrious",
    "noob",
    "pixart",
    "kolors",
    "cascade",
    "hunyuan",
    "mochi",
]);

const ROLE_TOKENS = new Set(["vae", "clip", "text", "encoder", "te", "lora", "lycoris", "controlnet", "ipadapter", "upscale", "esrgan", "embedding"]);
const QUALIFIER_TOKENS = new Set(["audio", "video", "image", "vision"]);

export function parseModelName(value) {
    const normalized = String(value || "").replace(/\\/g, "/");
    const base = normalized.split("/").pop() || "";
    const extMatch = MODEL_EXT.exec(base);
    const ext = (extMatch?.[0] || "").toLowerCase();
    const stem = ext ? base.slice(0, -ext.length) : base;
    const tokens = stem
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .filter(Boolean);
    return { base, ext, stem, tokens, compact: tokens.join("") };
}

function bigrams(value) {
    const text = String(value || "");
    const out = new Map();
    if (text.length < 2) {
        if (text) out.set(text, 1);
        return out;
    }
    for (let index = 0; index < text.length - 1; index += 1) {
        const gram = text.slice(index, index + 2);
        out.set(gram, (out.get(gram) || 0) + 1);
    }
    return out;
}

function diceCoefficient(a, b) {
    const left = bigrams(a);
    const right = bigrams(b);
    if (!left.size || !right.size) return 0;
    let overlap = 0;
    for (const [gram, count] of left) {
        const other = right.get(gram) || 0;
        overlap += Math.min(count, other);
    }
    return (2 * overlap) / (left.size + right.size);
}

function jaccard(aTokens, bTokens) {
    const left = new Set(aTokens);
    const right = new Set(bTokens);
    if (!left.size || !right.size) return 0;
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap += 1;
    return overlap / (left.size + right.size - overlap);
}

function roles(tokens) {
    return tokens.filter((token) => ROLE_TOKENS.has(token));
}

function qualifiers(tokens) {
    return tokens.filter((token) => QUALIFIER_TOKENS.has(token));
}

function sizeTokens(tokens) {
    return tokens.filter((token) => /^\d+(?:\.\d+)?b$/i.test(token));
}

function hasToken(tokens, name) {
    return tokens.includes(name);
}

function familyRoots(tokens, compact) {
    const roots = new Set();
    for (const family of FAMILY_TOKENS) {
        if (tokens.some((token) => token === family || token.startsWith(family)) || compact.includes(family)) {
            roots.add(family.replace(/\d+$/, ""));
        }
    }
    return [...roots];
}

function sameSet(a, b) {
    const left = new Set(a);
    const right = new Set(b);
    if (left.size !== right.size) return false;
    for (const item of left) if (!right.has(item)) return false;
    return true;
}

export function modelNameSimilarity(required, candidate) {
    const left = parseModelName(required);
    const right = parseModelName(candidate);
    if (!left.ext || !right.ext) return { ok: false, score: 0, reason: "format" };
    if (left.ext !== right.ext) return { ok: false, score: 0, reason: "format" };
    // 角色和语义限定词必须一致：VAE/CLIP/TE/LoRA 不能互顶，audio/video/vision/image 不能互顶。
    if (!sameSet(roles(left.tokens), roles(right.tokens))) return { ok: false, score: 0, reason: "role" };
    if (!sameSet(qualifiers(left.tokens), qualifiers(right.tokens))) return { ok: false, score: 0, reason: "qualifier" };
    // 规模不能跨规格顶替：4B/8B、9B/27B 不是同一模型。只有两边都带规模时才硬拦，
    // 兼容没有写参数量的文件名。
    const sizes = [sizeTokens(left.tokens), sizeTokens(right.tokens)];
    if (sizes[0].length && sizes[1].length && !sameSet(sizes[0], sizes[1])) return { ok: false, score: 0, reason: "size" };
    // turbo / raw 是不同训练规格，不能自动互顶；量化差异（fp8/bf16/int8）仍允许相似匹配。
    if (hasToken(left.tokens, "turbo") !== hasToken(right.tokens, "turbo")) return { ok: false, score: 0, reason: "variant" };
    if (hasToken(left.tokens, "raw") !== hasToken(right.tokens, "raw")) return { ok: false, score: 0, reason: "variant" };
    // 不同模型家族不能互顶（Qwen / Z-Image / Krea2 / MOSS 等）。
    const leftRoots = familyRoots(left.tokens, left.compact);
    const rightRoots = familyRoots(right.tokens, right.compact);
    if (leftRoots.length && rightRoots.length && !leftRoots.some((root) => rightRoots.includes(root))) {
        return { ok: false, score: 0, reason: "family" };
    }
    const dice = diceCoefficient(left.compact, right.compact);
    const jac = jaccard(left.tokens, right.tokens);
    let score = 0.65 * dice + 0.35 * jac;
    const leftFamily = left.tokens.filter((token) => FAMILY_TOKENS.has(token));
    const rightFamily = right.tokens.filter((token) => FAMILY_TOKENS.has(token));
    if (leftFamily.some((token) => rightFamily.includes(token))) score += 0.08;
    score = Math.max(0, Math.min(1, score));
    return { ok: score >= 0.5, score };
}

// 只返回唯一最高分；两个候选分数几乎一样时不自动选，交给用户确认。
export function findSimilarModel(required, candidates, { threshold = 0.5, margin = 0.03, limit = 200 } = {}) {
    const normalizedRequired = parseModelName(required);
    const scored = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const text = String(candidate || "").trim();
        if (!text) continue;
        const parsed = parseModelName(text);
        if (!FUZZY_EXT.has(parsed.ext)) continue;
        if (parsed.base.toLowerCase() === normalizedRequired.base.toLowerCase()) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const result = modelNameSimilarity(required, text);
        if (result.ok) scored.push({ file: text, score: result.score });
        if (scored.length >= limit) break;
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return { file: "", score: 0 };
    const top = scored[0];
    if (top.score < threshold) return { file: "", score: top.score };
    if (scored.length > 1 && top.score - scored[1].score < margin) {
        return { file: "", score: top.score, ambiguous: true, candidates: scored.slice(0, 5) };
    }
    return { file: top.file, score: top.score };
}
