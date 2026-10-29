import fs from "node:fs";
import path from "node:path";

import { clearExtraModelPathsCache } from "./model-paths.js";
import { nowIso, writeJsonAtomic } from "./util.js";

const SETTINGS_FILE = "directory-settings.json";
const MARK_START = "# >>> local-canvas manual directories (managed)";
const MARK_END = "# <<< local-canvas manual directories (managed)";
const MODEL_EXTS = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|engine)$/i;
const LORA_EXTS = /\.(safetensors|ckpt|pt|pth)$/i;
const MAX_SCAN_ENTRIES = 50000;

export function emptyDirectorySettings() {
    return { mode: "auto", comfyDir: "", modelDirs: [], loraDirs: [], customNodesDirs: [], updatedAt: "" };
}

function splitPaths(value) {
    const list = Array.isArray(value) ? value : String(value || "").split(/[\r\n,;]+/);
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const text = String(raw || "").trim().replace(/^"|"$/g, "");
        if (!text) continue;
        let resolved;
        try {
            resolved = path.resolve(text);
        } catch {
            continue;
        }
        const key = resolved.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(resolved);
    }
    return out;
}

export function normalizeDirectorySettings(input = {}) {
    const mode = input.mode === "manual" ? "manual" : "auto";
    return {
        mode,
        comfyDir: String(input.comfyDir || "").trim() ? path.resolve(String(input.comfyDir).trim()) : "",
        modelDirs: splitPaths(input.modelDirs ?? input.modelDir),
        loraDirs: splitPaths(input.loraDirs ?? input.loraDir),
        customNodesDirs: splitPaths(input.customNodesDirs ?? input.customNodesDir),
        updatedAt: String(input.updatedAt || ""),
    };
}

export function loadDirectorySettings(dataDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_FILE), "utf8").replace(/^\uFEFF/, ""));
        return normalizeDirectorySettings(parsed);
    } catch {
        return emptyDirectorySettings();
    }
}

export async function saveDirectorySettings(dataDir, settings) {
    const normalized = { ...normalizeDirectorySettings(settings), updatedAt: nowIso() };
    await writeJsonAtomic(path.join(dataDir, SETTINGS_FILE), normalized);
    return normalized;
}

function isDir(value) {
    try {
        return fs.statSync(value).isDirectory();
    } catch {
        return false;
    }
}

function isFile(value) {
    try {
        return fs.statSync(value).isFile();
    } catch {
        return false;
    }
}

export function detectComfyLayout(dir) {
    if (!dir || !isDir(dir)) return null;
    const mainCandidates = [
        path.join(dir, "ComfyUI", "main.py"),
        path.join(dir, "main.py"),
        path.join(dir, "resources", "ComfyUI", "main.py"),
    ];
    const mainPy = mainCandidates.find((file) => isFile(file)) || "";
    const root = mainPy ? path.dirname(mainPy) : dir;
    const workflowCandidates = [
        path.join(root, "user", "default", "workflows"),
        path.join(dir, "user", "default", "workflows"),
        path.join(dir, "workflows"),
    ];
    const workflowsDir = workflowCandidates.find((candidate) => isDir(candidate)) || "";
    const customNodesDir = path.join(root, "custom_nodes");
    return {
        dir,
        root,
        mainPy,
        workflowsDir,
        customNodesDir: isDir(customNodesDir) ? customNodesDir : "",
        modelsDir: isDir(path.join(root, "models")) ? path.join(root, "models") : "",
    };
}

export function validateDirectorySettings(settings) {
    const errors = [];
    const info = detectComfyLayout(settings.comfyDir);
    if (settings.mode === "manual" && !settings.comfyDir) errors.push("请填写 ComfyUI 目录");
    if (settings.comfyDir && !isDir(settings.comfyDir)) errors.push(`ComfyUI 目录不存在：${settings.comfyDir}`);
    else if (settings.mode === "manual" && settings.comfyDir && info && !info.mainPy && !info.modelsDir && !info.customNodesDir) {
        errors.push(`目录里没有 main.py / models / custom_nodes，可能不是 ComfyUI 目录：${settings.comfyDir}`);
    }
    for (const dir of settings.modelDirs) if (!isDir(dir)) errors.push(`模型目录不存在：${dir}`);
    for (const dir of settings.loraDirs) if (!isDir(dir)) errors.push(`LoRA 目录不存在：${dir}`);
    for (const dir of settings.customNodesDirs) if (!isDir(dir)) errors.push(`插件目录不存在：${dir}`);
    return { ok: errors.length === 0, errors, layout: info };
}

function safeStat(file) {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

function walkFiles(dir, { maxDepth = 8, limit = MAX_SCAN_ENTRIES } = {}) {
    const files = [];
    let dirs = 0;
    let truncated = false;
    let depthLimited = false;
    const stack = [{ dir, depth: 0 }];
    while (stack.length && !truncated) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const full = path.join(current.dir, entry.name);
            if (entry.isDirectory()) {
                dirs += 1;
                if (current.depth < maxDepth) stack.push({ dir: full, depth: current.depth + 1 });
                else depthLimited = true;
                continue;
            }
            if (!entry.isFile()) continue;
            const stat = safeStat(full);
            if (!stat) continue;
            files.push({
                path: full,
                rel: path.relative(dir, full).split(path.sep).join("/"),
                size: stat.size,
                name: entry.name,
            });
            if (files.length >= limit) {
                truncated = true;
                break;
            }
        }
    }
    return { dir, files, dirs, truncated: truncated || depthLimited };
}

function guessModelKind(rel) {
    const lower = String(rel || "").toLowerCase();
    const patterns = [
        ["loras", /(^|\/)(loras?|lycoris)(\/|$)/],
        ["vae", /(^|\/)vae(\/|$)/],
        ["text_encoders", /(^|\/)(text_encoders?|clip|t5)(\/|$)/],
        ["checkpoints", /(^|\/)(checkpoints?|ckpt)(\/|$)/],
        ["diffusion_models", /(^|\/)(diffusion_models?|unet)(\/|$)/],
        ["upscale_models", /(^|\/)(upscale_models?|esrgan)(\/|$)/],
        ["controlnet", /(^|\/)(controlnet|t2i_adapter)(\/|$)/],
        ["clip_vision", /(^|\/)clip_vision(\/|$)/],
        ["embeddings", /(^|\/)embeddings?(\/|$)/],
    ];
    for (const [kind, pattern] of patterns) if (pattern.test(lower)) return kind;
    return "other";
}

function summarizeFiles(files, extPattern) {
    const byKind = {};
    const samples = [];
    let totalBytes = 0;
    for (const file of files) {
        if (!extPattern.test(file.name)) continue;
        totalBytes += file.size;
        const kind = guessModelKind(file.rel);
        byKind[kind] = (byKind[kind] || 0) + 1;
        if (samples.length < 12) samples.push(file.rel);
    }
    const count = Object.values(byKind).reduce((sum, value) => sum + value, 0);
    return { count, byKind, totalBytes, samples };
}

function summarizeCustomNodes(dir) {
    const names = [];
    let count = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("__")) continue;
            const full = path.join(dir, entry.name);
            const plugin = isFile(path.join(full, "__init__.py")) || isFile(path.join(full, "nodes.py")) || isFile(path.join(full, "pyproject.toml"));
            if (!plugin) continue;
            count += 1;
            if (names.length < 20) names.push(entry.name);
        }
    } catch {
        /* 目录不可读 */
    }
    return { count, samples: names };
}

export function scanDirectories(settings) {
    const modelDirs = settings.modelDirs.map((dir) => {
        const walk = walkFiles(dir);
        return { dir, ...summarizeFiles(walk.files, MODEL_EXTS), dirs: walk.dirs, truncated: walk.truncated };
    });
    const loraDirs = settings.loraDirs.map((dir) => {
        const walk = walkFiles(dir);
        const summary = summarizeFiles(walk.files, LORA_EXTS);
        return { dir, ...summary, dirs: walk.dirs, truncated: walk.truncated };
    });
    const customNodesDirs = settings.customNodesDirs.map((dir) => {
        const custom = summarizeCustomNodes(dir);
        return { dir, ...custom };
    });
    const layout = detectComfyLayout(settings.comfyDir);
    return {
        comfy: layout
            ? {
                  dir: layout.dir,
                  root: layout.root,
                  mainPy: layout.mainPy,
                  workflowsDir: layout.workflowsDir,
                  modelsDir: layout.modelsDir,
                  customNodesDir: layout.customNodesDir,
              }
            : null,
        modelDirs,
        loraDirs,
        customNodesDirs,
        totals: {
            models: modelDirs.reduce((sum, item) => sum + item.count, 0),
            loras: loraDirs.reduce((sum, item) => sum + item.count, 0),
            plugins: customNodesDirs.reduce((sum, item) => sum + item.count, 0),
        },
    };
}

function yamlQuote(value) {
    return `"${String(value || "").replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

const MODEL_KEYS = [
    "checkpoints",
    "diffusion_models",
    "vae",
    "text_encoders",
    "clip",
    "loras",
    "upscale_models",
    "latent_upscale_models",
    "controlnet",
    "clip_vision",
    "embeddings",
];

const MODEL_DIR_HINTS = {
    checkpoints: ["checkpoints"],
    diffusion_models: ["diffusion_models", "unet"],
    vae: ["vae"],
    text_encoders: ["text_encoders", "clip"],
    clip: ["text_encoders", "clip"],
    loras: ["loras"],
    upscale_models: ["upscale_models"],
    latent_upscale_models: ["latent_upscale_models"],
    controlnet: ["controlnet", "t2i_adapter"],
    clip_vision: ["clip_vision"],
    embeddings: ["embeddings"],
};

function modelDirMappings(dir) {
    const mappings = [];
    for (const key of MODEL_KEYS) {
        const sub = (MODEL_DIR_HINTS[key] || [key]).find((name) => isDir(path.join(dir, name)));
        if (sub) mappings.push(`${key}: ${sub}`);
    }
    if (mappings.length) return mappings;
    // 目录本身就是某一类模型目录（如 .../loras）时只映射这一类。
    const base = path.basename(dir).toLowerCase();
    const ownKey = MODEL_KEYS.find((key) => key === base || (MODEL_DIR_HINTS[key] || []).includes(base));
    if (ownKey) return [`${ownKey}: .`];
    // 扁平目录没有可识别的子目录，只能按通用模型目录处理。
    return MODEL_KEYS.map((key) => `${key}: .`);
}

export function buildManagedExtraPaths(settings) {
    const lines = [];
    settings.modelDirs.forEach((dir, index) => {
        lines.push(`local_canvas_models_${index + 1}:`, `  base_path: ${yamlQuote(dir)}`);
        for (const mapping of modelDirMappings(dir)) lines.push(`  ${mapping}`);
    });
    settings.loraDirs.forEach((dir, index) => {
        lines.push(`local_canvas_loras_${index + 1}:`, `  base_path: ${yamlQuote(dir)}`, "  loras: .");
    });
    settings.customNodesDirs.forEach((dir, index) => {
        lines.push(`local_canvas_custom_nodes_${index + 1}:`, `  base_path: ${yamlQuote(dir)}`, "  custom_nodes: .");
    });
    return lines.join("\n");
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function writeManagedExtraPaths(comfyRoot, settings) {
    if (!comfyRoot || !isDir(comfyRoot)) {
        return { ok: false, file: "", changed: false, backup: "", error: `ComfyUI 目录不可用：${comfyRoot || "（空）"}` };
    }
    const file = path.join(comfyRoot, "extra_model_paths.yaml");
    let existing = "";
    try {
        existing = fs.readFileSync(file, "utf8");
    } catch {
        existing = "";
    }
    const blockBody = buildManagedExtraPaths(settings);
    const block = blockBody ? `${MARK_START}\n${blockBody}\n${MARK_END}\n` : "";
    const pattern = new RegExp(`${escapeRegExp(MARK_START)}[\\s\\S]*?${escapeRegExp(MARK_END)}\\n?`, "m");
    const hasBlock = pattern.test(existing);
    let next;
    if (!block) {
        next = hasBlock ? existing.replace(pattern, "").replace(/\n{3,}/g, "\n\n") : existing;
    } else if (hasBlock) {
        next = existing.replace(pattern, block);
    } else {
        next = `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n\n" : ""}${block}`;
    }
    if (next === existing) return { ok: true, file, changed: false, backup: "" };
    let backup = "";
    if (existing && !hasBlock) {
        backup = `${file}.local-canvas.bak`;
        if (!isFile(backup)) {
            try {
                fs.copyFileSync(file, backup);
            } catch {
                backup = "";
            }
        }
    }
    try {
        fs.writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    } catch (error) {
        return { ok: false, file, changed: false, backup, error: `写入 ${file} 失败：${error.message}` };
    }
    clearExtraModelPathsCache();
    return { ok: true, file, changed: true, backup };
}

function normalizePath(value) {
    try {
        return path.resolve(String(value || "")).toLowerCase();
    } catch {
        return "";
    }
}

function flattenFolderPaths(folderPaths = {}) {
    const roots = [];
    for (const value of Object.values(folderPaths || {})) {
        const list = Array.isArray(value) ? value : [value];
        for (const entry of list) {
            if (typeof entry !== "string" || !entry.trim()) continue;
            roots.push(entry);
        }
    }
    return [...new Set(roots.map(normalizePath).filter(Boolean))];
}

function pathInsideOrEqual(a, b) {
    const left = normalizePath(a);
    const right = normalizePath(b);
    if (!left || !right) return false;
    return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

// 判断手动目录是否已经在 ComfyUI 当前清单里；全部已加载就不需要重启。
export function directoryLoadReport(settings, { comfyRoot = "", folderPaths = {} } = {}) {
    const roots = flattenFolderPaths(folderPaths);
    const modelDirs = (settings.modelDirs || []).map((dir) => ({ dir, loaded: roots.some((root) => pathInsideOrEqual(dir, root)) }));
    const loraDirs = (settings.loraDirs || []).map((dir) => ({ dir, loaded: roots.some((root) => pathInsideOrEqual(dir, root)) }));
    const liveCustomNodes = comfyRoot ? path.join(comfyRoot, "custom_nodes") : "";
    const customNodesDirs = (settings.customNodesDirs || []).map((dir) => ({
        dir,
        loaded: (Boolean(liveCustomNodes) && normalizePath(dir) === normalizePath(liveCustomNodes)) || roots.some((root) => pathInsideOrEqual(dir, root)),
    }));
    const layout = detectComfyLayout(settings.comfyDir);
    const manualRoot = layout?.root || settings.comfyDir || "";
    const comfyLoaded = !manualRoot || !comfyRoot || normalizePath(manualRoot) === normalizePath(comfyRoot);
    const missing = [
        ...modelDirs.filter((item) => !item.loaded).map((item) => ({ kind: "model", dir: item.dir })),
        ...loraDirs.filter((item) => !item.loaded).map((item) => ({ kind: "lora", dir: item.dir })),
        ...customNodesDirs.filter((item) => !item.loaded).map((item) => ({ kind: "custom_nodes", dir: item.dir })),
        ...(comfyLoaded ? [] : [{ kind: "comfy", dir: manualRoot }]),
    ];
    return { restartRequired: missing.length > 0, missing, modelDirs, loraDirs, customNodesDirs, comfyLoaded };
}

export function describeAutoDirectories({ comfyDir = "", comfyRoot = "", workflowsDir = "" } = {}) {
    const layout = detectComfyLayout(comfyDir || comfyRoot);
    return {
        comfyDir: comfyDir || comfyRoot || "",
        root: layout?.root || comfyRoot || "",
        workflowsDir: workflowsDir || layout?.workflowsDir || "",
        modelDirs: layout?.modelsDir ? [layout.modelsDir] : [],
        loraDirs: layout?.modelsDir ? [path.join(layout.modelsDir, "loras")] : [],
        customNodesDirs: layout?.customNodesDir ? [layout.customNodesDir] : [],
    };
}
