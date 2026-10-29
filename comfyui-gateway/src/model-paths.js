import fs from "node:fs";
import path from "node:path";

export const MODEL_DIR_KEYS = {
    diffusion_models: ["diffusion_models", "unet"],
    text_encoders: ["text_encoders", "clip"],
    vae: ["vae"],
    vae_approx: ["vae_approx"],
    loras: ["loras"],
    checkpoints: ["checkpoints"],
    upscale_models: ["upscale_models"],
    latent_upscale_models: ["latent_upscale_models"],
    vdn: ["vdn"],
    clip_vision: ["clip_vision"],
    LLM: ["LLM", "llm"],
    SEEDVR2: ["SEEDVR2", "seedvr2"],
};

export function parseExtraModelPaths(file) {
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return {};
    }
    const result = {};
    const baseDir = path.dirname(file);
    let section = null;
    let basePath = "";
    let multilineKey = "";
    const resolvePath = (value) => {
        const raw = String(value || "").trim().replace(/^"|"$/g, "");
        if (!raw) return "";
        return path.isAbsolute(raw) ? raw : path.resolve(basePath || baseDir, raw);
    };
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = line.length - line.trimStart().length;
        if (indent === 0 && /^[^:]+:\s*$/.test(trimmed)) {
            section = trimmed.replace(/:\s*$/, "");
            basePath = "";
            multilineKey = "";
            continue;
        }
        if (!section) continue;
        const match = trimmed.match(/^([\w.-]+):\s*(.*)$/);
        if (match && !trimmed.startsWith("-")) {
            const key = match[1];
            const value = match[2].trim();
            multilineKey = "";
            if (key === "base_path") {
                basePath = resolvePath(value);
                continue;
            }
            if (key === "is_default") continue;
            if (value === "|" || value === ">") {
                if (!result[key]) result[key] = [];
                multilineKey = key;
                continue;
            }
            if (!result[key]) result[key] = [];
            if (value) result[key].push(resolvePath(value));
            continue;
        }
        if (multilineKey && indent > 0) {
            const resolved = resolvePath(trimmed);
            if (resolved) result[multilineKey].push(resolved);
        }
    }
    return result;
}

const extraPathsCache = new Map();

// ComfyUI 便携包通常把 extra_model_paths.yaml 放在 ComfyUI 目录或其上一级；
// 两处都读，另加配置里的 comfyDir，映射盘模型就靠这份清单进入模型根。
export function extraModelPathsFor(root, comfyDir = "") {
    if (!root && !comfyDir) return {};
    const files = [...new Set([
        root ? path.join(root, "extra_model_paths.yaml") : "",
        root ? path.join(path.dirname(root), "extra_model_paths.yaml") : "",
        comfyDir ? path.join(comfyDir, "extra_model_paths.yaml") : "",
    ].filter(Boolean).map((file) => path.resolve(file)))];
    const key = `${root}|${comfyDir}`.toLowerCase();
    const cached = extraPathsCache.get(key);
    if (cached && Date.now() - cached.at < 10000) return cached.paths;
    const merged = {};
    for (const file of files) {
        let isFile = false;
        try {
            isFile = fs.statSync(file).isFile();
        } catch {
            isFile = false;
        }
        if (!isFile) continue;
        const parsed = parseExtraModelPaths(file);
        for (const [name, values] of Object.entries(parsed)) {
            if (!Array.isArray(values) || !values.length) continue;
            merged[name] = [...new Set([...(merged[name] || []), ...values])];
        }
    }
    extraPathsCache.set(key, { at: Date.now(), paths: merged });
    return merged;
}

export function clearExtraModelPathsCache() {
    extraPathsCache.clear();
}

export function collectModelRoots({ dir, folderPaths = {}, comfyDir = "", comfyRoot = "" } = {}) {
    const keys = MODEL_DIR_KEYS[dir] || [dir];
    const roots = [];
    const seen = new Set();
    const add = (value) => {
        if (!value || typeof value !== "string") return;
        let resolved;
        try {
            resolved = path.resolve(value);
        } catch {
            return;
        }
        const key = resolved.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        roots.push(resolved);
    };
    for (const key of keys) {
        const list = folderPaths?.[key];
        if (Array.isArray(list)) for (const entry of list) add(entry);
    }
    const base = comfyRoot || comfyDir;
    if (base) {
        const extra = extraModelPathsFor(base, comfyDir);
        for (const key of keys) {
            const list = extra[key];
            if (Array.isArray(list)) for (const entry of list) add(entry);
        }
    }
    for (const baseDir of [comfyRoot, comfyDir]) {
        if (!baseDir) continue;
        for (const key of keys) add(path.join(baseDir, "models", key));
    }
    return roots;
}

function realpathSafe(file) {
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file);
    } catch {
        return "";
    }
}

function inside(root, file) {
    const rel = path.relative(root, file);
    if (!rel) return "";
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return "";
    return rel;
}

function isDirectoryEntry(dir, entry) {
    if (entry.isDirectory()) return true;
    if (entry.isFile()) return false;
    // Windows 的目录 junction 在 Dirent 里可能既不是目录也不是文件。
    try {
        return fs.statSync(path.join(dir, entry.name)).isDirectory();
    } catch {
        return false;
    }
}

function mappedRelative(root, realTarget) {
    const stack = [{ dir: root, depth: 0 }];
    let visited = 0;
    while (stack.length && visited < 1500) {
        const current = stack.pop();
        visited += 1;
        const realDir = realpathSafe(current.dir);
        if (realDir) {
            const rel = inside(realDir, realTarget);
            if (rel) {
                const prefix = path.relative(root, current.dir);
                return path.join(prefix || "", rel).split(path.sep).join("/");
            }
        }
        if (current.depth >= 4) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (isDirectoryEntry(current.dir, entry)) stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
    }
    return "";
}

// 返回 ComfyUI loader 可见的相对路径；用户从映射盘直接选中的文件，会沿
// junction/symlink 折回模型根里的路径，否则 ComfyUI 根本看不到它。
export function modelRelativePath(roots, absolute) {
    let target;
    try {
        target = path.resolve(String(absolute || ""));
    } catch {
        return null;
    }
    for (const root of roots || []) {
        const rel = inside(root, target);
        if (rel) return { file: rel.split(path.sep).join("/"), root };
    }
    const realTarget = realpathSafe(target);
    if (!realTarget) return null;
    for (const root of roots || []) {
        const rel = mappedRelative(root, realTarget);
        if (rel) return { file: rel, root };
    }
    return null;
}
