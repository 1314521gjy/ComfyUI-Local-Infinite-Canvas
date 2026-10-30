import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { findUnetLoader } from "./base-models.js";
import { MODEL_LOADER_SPECS } from "./model-loaders.js";
import { findSimilarModel, FUZZY_MODEL_EXTENSIONS } from "./model-match.js";
import { collectModelRoots, clearExtraModelPathsCache } from "./model-paths.js";
import { nowIso, truncate, writeJsonAtomic } from "./util.js";

const MODEL_DIRS = new Set(["diffusion_models", "text_encoders", "vae", "vae_approx", "loras", "checkpoints", "upscale_models", "latent_upscale_models", "vdn", "clip_vision", "LLM", "SEEDVR2"]);
const WEIGHT_FILE_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|data|engine)$/i;
const LOADER_BY_DIR = {
    diffusion_models: { classType: "UNETLoader", input: "unet_name" },
    text_encoders: { classType: "CLIPLoader", input: "clip_name" },
    vae: { classType: "VAELoader", input: "vae_name" },
    loras: { classType: "LoraLoaderModelOnly", input: "lora_name" },
    checkpoints: { classType: "CheckpointLoaderSimple", input: "ckpt_name" },
    upscale_models: { classType: "UpscaleModelLoader", input: "model_name" },
    clip_vision: { classType: "CLIPVisionLoader", input: "clip_name" },
};
const JOB_LIMIT = 20;

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isDir(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

// Windows 下 child.kill() 只结束包装脚本，编译器孙进程会继续占 GPU；
// 取消时必须整棵进程树一起结束。
function killChildTree(child) {
    if (!child || !child.pid) return;
    if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => {
            try {
                child.kill();
            } catch {
                // 子进程已退出。
            }
        });
        return;
    }
    try {
        child.kill();
    } catch {
        // 子进程已退出。
    }
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
        return null;
    }
}

function targetParts(target) {
    const parts = String(target || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === ".." || part === ".")) throw new Error(`非法资源路径：${target}`);
    const dir = parts.shift();
    if (!MODEL_DIRS.has(dir) && dir !== "custom_nodes") throw new Error(`不支持的资源目录：${dir}`);
    return { dir, file: parts.join("/") };
}

function resolveComfyRoot(config) {
    const candidates = [];
    const add = (value) => {
        if (!value) return;
        const resolved = path.resolve(value);
        candidates.push(resolved);
        candidates.push(path.join(resolved, "ComfyUI"));
    };
    add(config.comfyDir);
    add(config.comfyFrontendDir);
    let cursor = config.comfyWorkflowsDir ? path.resolve(config.comfyWorkflowsDir) : "";
    for (let i = 0; cursor && i < 6; i += 1) {
        candidates.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    const home = os.homedir();
    for (const fallback of [
        "C:/ComfyUI",
        "D:/ComfyUI",
        "E:/ComfyUI",
        "C:/ComfyUI_windows_portable",
        path.join(home, "ComfyUI"),
        path.join(home, "Documents", "ComfyUI"),
    ]) {
        add(fallback);
    }
    const seen = new Set();
    for (const dir of candidates) {
        const key = dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (isFile(path.join(dir, "main.py")) || isDir(path.join(dir, "custom_nodes")) || isDir(path.join(dir, "models"))) return dir;
    }
    return "";
}

export function inferComfyRootFromFolderPaths(folderPaths = {}) {
    const strict = [];
    const loose = [];
    for (const value of Object.values(folderPaths || {})) {
        if (!Array.isArray(value)) continue;
        for (const entry of value) {
            if (typeof entry !== "string" || !entry.trim()) continue;
            const resolved = path.resolve(entry);
            const parts = resolved.split(path.sep);
            for (let index = parts.length - 1; index > 0; index -= 1) {
                if (parts[index].toLowerCase() !== "models") continue;
                const candidate = parts.slice(0, index).join(path.sep);
                if (!candidate) continue;
                if (isFile(path.join(candidate, "main.py")) || isDir(path.join(candidate, "custom_nodes"))) {
                    strict.push(candidate);
                } else if (isDir(path.join(candidate, "models")) && path.parse(candidate).root !== candidate) {
                    loose.push(candidate);
                }
            }
        }
    }
    return strict[0] || loose[0] || "";
}

function pythonFromBat(bat) {
    try {
        const text = fs.readFileSync(bat, "utf8");
        const match = text.match(/(?:^|[\s"'])((?:[A-Za-z]:)?[^"'\r\n]*?python(?:w)?\.exe)\b/i);
        if (!match) return "";
        const token = match[1].trim().replace(/^"|"$/g, "");
        return path.isAbsolute(token) ? token : path.resolve(path.dirname(bat), token);
    } catch {
        return "";
    }
}

const processPythonCache = new Map();

// 从监听 ComfyUI 端口的进程反查它真实的 Python，兼容非便携版/conda/自定义启动脚本。
function pythonFromRunningComfy(config) {
    if (process.platform !== "win32") return "";
    let port = 8188;
    try {
        const url = new URL(config.comfyUrl || "http://127.0.0.1:8188");
        port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    } catch {
        port = 8188;
    }
    const cached = processPythonCache.get(port);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
        `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
        "if ($conn) {",
        "  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $conn.OwningProcess)",
        "  if ($proc) { $proc.ExecutablePath }",
        "}",
    ].join("\n");
    let found = "";
    try {
        const output = execFileSync(powershell, ["-NoProfile", "-Command", script], {
            timeout: 4000,
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 64 * 1024,
        });
        const first = String(output || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
        if (first && /python(?:w)?\.exe$/i.test(first) && isFile(first)) found = first;
    } catch {
        found = "";
    }
    processPythonCache.set(port, { value: found, at: Date.now() });
    return found;
}

const pythonProbeCache = new Map();

function pythonRuns(file) {
    if (!file) return false;
    const cached = pythonProbeCache.get(file);
    if (cached && Date.now() - cached.at < 300000) return cached.ok;
    let ok = false;
    try {
        const stdout = execFileSync(file, ["-c", "import sys;print(sys.version_info[0])"], {
            timeout: 8000,
            windowsHide: true,
            encoding: "utf8",
        });
        ok = /^\s*3\s*$/m.test(String(stdout || ""));
    } catch {
        ok = false;
    }
    pythonProbeCache.set(file, { at: Date.now(), ok });
    return ok;
}

function resolveComfyPython(config, root, { probeProcess = false } = {}) {
    const candidates = [];
    const add = (value) => {
        if (value) candidates.push(value);
    };
    add(process.env.COMFY_PYTHON);
    const roots = [root, config.comfyDir].filter(Boolean);
    for (const base of roots) {
        add(path.join(base, "python.exe"));
        add(path.join(base, "python_embeded", "python.exe"));
        add(path.join(base, "python_embedded", "python.exe"));
        // 整合包常见布局：环境根目录下的 python/python.exe 或 env/Scripts、env/python。
        add(path.join(base, "python", "python.exe"));
        add(path.join(base, "env", "python.exe"));
        add(path.join(base, "env", "python", "python.exe"));
        add(path.join(base, "env", "Scripts", "python.exe"));
        add(path.join(base, "venv", "Scripts", "python.exe"));
        add(path.join(base, ".venv", "Scripts", "python.exe"));
        add(path.join(base, "Scripts", "python.exe"));
        add(path.join(base, "miniconda3", "python.exe"));
        add(path.join(base, "miniforge3", "python.exe"));
        add(path.join(base, "anaconda3", "python.exe"));
        add(pythonFromBat(path.join(base, "run_nvidia_gpu.bat")));
        try {
            const envs = path.join(base, "envs");
            for (const name of fs.readdirSync(envs)) {
                add(path.join(envs, name, "python.exe"));
                add(path.join(envs, name, "Scripts", "python.exe"));
            }
        } catch {
            // 没有 conda envs 目录。
        }
    }
    if (root) {
        const parent = path.dirname(root);
        add(path.join(parent, "python", "python.exe"));
        add(path.join(parent, "env", "python.exe"));
        add(path.join(parent, "env", "python", "python.exe"));
        add(path.join(parent, "env", "Scripts", "python.exe"));
        add(pythonFromBat(path.join(parent, "run_nvidia_gpu.bat")));
    }
    if (probeProcess) {
        // pip 安装必须先确认真能跑：整合包里可能存在一个坏掉的 env\Scripts\python.exe。
        const working = candidates.find((candidate) => isFile(candidate) && pythonRuns(candidate));
        if (working) return working;
        return pythonFromRunningComfy(config);
    }
    return candidates.find(isFile) || "";
}

function safeUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
    } catch {
        return "";
    }
}

function normalizeSources(resource) {
    return (Array.isArray(resource.sources) ? resource.sources : [])
        .map((source) => (typeof source === "string" ? { url: source } : source))
        .map((source) => ({ ...source, url: source?.url ? safeUrl(source.url) : "" }))
        .filter((source) => source.url || ((source.kind === "bundled" || source.kind === "bundled-dir") && source.path));
}

function execFileText(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout || ""));
        });
    });
}

function validateIndex(index) {
    if (!index || index.schema !== 1 || !Array.isArray(index.packs) || !Array.isArray(index.resources)) {
        throw new Error("资源索引格式不正确");
    }
    const ids = new Set();
    for (const resource of index.resources) {
        if (!resource?.id || ids.has(resource.id)) throw new Error(`资源 ID 缺失或重复：${resource?.id}`);
        ids.add(resource.id);
        targetParts(resource.target);
    }
    for (const pack of index.packs) {
        if (!pack?.id) throw new Error("功能包缺少 ID");
        for (const id of pack.resources || []) {
            if (!ids.has(id)) throw new Error(`功能包 ${pack.id} 引用了不存在的资源 ${id}`);
        }
        for (const [workflowId, workflowIds] of Object.entries(pack.workflowDependencies || {})) {
            if (!Array.isArray(workflowIds)) throw new Error(`功能包 ${pack.id} 的工作流 ${workflowId} 依赖格式不正确`);
            for (const id of workflowIds) {
                if (!ids.has(id)) throw new Error(`工作流 ${workflowId} 引用了不存在的资源 ${id}`);
            }
        }
    }
    return index;
}

export function buildTrtCompileHint({ python, compiler, input, output, device = 0 }) {
    const quote = (value) => (/[\s"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value);
    const command = [python, compiler, "--input", input, "--output", output, "--device", String(device)].map(quote).join(" ");
    return [
        "H3 的 TensorRT VAE engine 没有编译成功，视频工作流暂时用不了。",
        "可以把下面这段话直接发给你的 AI Agent：",
        `「请在这台机器的 ComfyUI 环境里安装与本机 CUDA/驱动匹配的 tensorrt，然后重新编译 H3 的 VAE engine：${command}。如果编译仍然报错，把完整报错贴给你。」`,
    ].join("\n");
}

function versionParts(value) {
    const match = String(value || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersionParts(left, right) {
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

function satisfiesVersion(value, spec) {
    const current = versionParts(value);
    if (!current) return false;
    const text = String(spec || "").trim();
    if (!text) return true;
    return text.split(",").every((part) => {
        const match = part.trim().match(/^(>=|<=|>|<|=)?\s*v?(.+)$/);
        if (!match) return false;
        const target = versionParts(match[2]);
        if (!target) return false;
        const compared = compareVersionParts(current, target);
        switch (match[1] || "=") {
            case ">=":
                return compared >= 0;
            case "<=":
                return compared <= 0;
            case ">":
                return compared > 0;
            case "<":
                return compared < 0;
            default:
                return compared === 0;
        }
    });
}

function cudaMatches(value, expected) {
    const current = String(value || "").trim();
    const target = String(expected || "").trim();
    if (!current || !target) return false;
    return current === target || current.startsWith(`${target}.`);
}

export function selectPipWheelForRuntime(resource, runtime) {
    const matrix = Array.isArray(resource?.wheelMatrix) ? resource.wheelMatrix : [];
    if (!matrix.length) return null;
    for (const entry of matrix) {
        if (!entry?.url) continue;
        if (entry.python && !satisfiesVersion(runtime?.python, entry.python)) continue;
        if (entry.torch && !satisfiesVersion(runtime?.torch, entry.torch)) continue;
        if (entry.cuda && !cudaMatches(runtime?.cuda, entry.cuda)) continue;
        return {
            url: String(entry.url),
            size: Number(entry.size) || 0,
            sha256: String(entry.sha256 || ""),
            label: String(entry.label || ""),
        };
    }
    return null;
}

export function createResourceManager({ config, setup, registry, logger, workflowVisibility = null, mainModels = null, hardware: hardwareOverride = null } = {}) {
    const indexPath = path.join(config.rootDir, "resources", "index.json");
    const indexCachePath = path.join(config.dataDir, "resources-index.json");
    const lockPath = path.join(config.dataDir, "resource-lock.json");
    const jobs = new Map();
    const inventoryCache = new Map();
    let index = null;
    let hardware = hardwareOverride;
    let indexSource = "local";
    let indexError = "";
    let indexWarning = "";
    let lock = { version: 1, installed: {} };
    let loadedAt = null;

    function comfyRoot() {
        return resolveComfyRoot(config) || inferComfyRootFromFolderPaths(setup?.folderPaths?.() || {});
    }

    function comfyPython(root = comfyRoot()) {
        return resolveComfyPython(config, root);
    }

    function comfyPythonForBake(root = comfyRoot()) {
        return resolveComfyPython(config, root, { probeProcess: true });
    }

    function canWrite(dir) {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    function modelRoots(dir, root = comfyRoot()) {
        return collectModelRoots({ dir, folderPaths: setup?.folderPaths?.() || {}, comfyDir: config.comfyDir, comfyRoot: root });
    }

    function modelFileCandidates(resource, root = comfyRoot()) {
        const { dir, file } = targetParts(resource.target);
        if (dir === "custom_nodes") return root ? [path.join(root, "custom_nodes", file)] : [];
        return modelRoots(dir, root).map((entry) => path.join(entry, file));
    }

    function normalizeRelName(value) {
        return String(value || "").replace(/\\/g, "/").replace(/^\.?\//, "").trim().toLowerCase();
    }

    // ComfyUI 的 loader 只给相对文件名；用户可能放在子目录或重命名。这里把
    // “文件系统里的相对路径 + loader 列表”合成一份清单，按路径/文件名/体积匹配。
    function inventoryFor(dir, root) {
        const roots = modelRoots(dir, root);
        const key = `${dir}|${roots.join("|").toLowerCase()}`;
        const cached = inventoryCache.get(key);
        if (cached && Date.now() - cached.at < 5000) return cached.items;
        const items = [];
        const byRel = new Map();
        const addItem = (rel, absPath, size, fromLoader) => {
            const normalized = normalizeRelName(rel);
            if (!normalized) return;
            const existing = byRel.get(normalized);
            if (existing) {
                if (absPath && !existing.abs) {
                    existing.abs = absPath;
                    existing.size = size;
                }
                return;
            }
            const item = { rel: normalized, abs: absPath || "", size: Number(size) || 0, fromLoader: Boolean(fromLoader) };
            byRel.set(normalized, item);
            items.push(item);
        };
        for (const base of roots) {
            if (!isDir(base)) continue;
            const stack = [{ dir: base, depth: 0 }];
            const visited = new Set();
            const started = Date.now();
            while (stack.length && Date.now() - started < 2500) {
                const current = stack.pop();
                let real = "";
                try {
                    real = fs.realpathSync(current.dir).toLowerCase();
                } catch {
                    continue;
                }
                if (visited.has(real)) continue;
                visited.add(real);
                let entries = [];
                try {
                    entries = fs.readdirSync(current.dir, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const entry of entries) {
                    if (entry.name.startsWith(".")) continue;
                    const full = path.join(current.dir, entry.name);
                    if (entry.isDirectory()) {
                        if (current.depth < 5) stack.push({ dir: full, depth: current.depth + 1 });
                        continue;
                    }
                    if (!entry.isFile() || !WEIGHT_FILE_EXTENSIONS.test(entry.name)) continue;
                    let size = 0;
                    try {
                        size = fs.statSync(full).size;
                    } catch {
                        size = 0;
                    }
                    addItem(path.relative(base, full), full, size, false);
                }
            }
        }
        const spec = LOADER_BY_DIR[dir];
        const options = spec ? setup?.loaderOptions?.()?.[spec.classType] : null;
        if (Array.isArray(options)) {
            for (const name of options) {
                if (typeof name === "string") addItem(name, "", 0, true);
            }
        }
        inventoryCache.set(key, { at: Date.now(), items });
        return items;
    }

    function resourceMatch(resource, root = comfyRoot()) {
        const { dir, file } = targetParts(resource.target);
        if (dir === "custom_nodes" && !root) return { present: false, path: "", rel: "", size: 0, matchedBy: "", mismatch: "" };
        if (resource.type === "dir") {
            for (const base of modelRoots(dir, root)) {
                const candidate = path.join(base, file);
                if (isDir(candidate) && (isFile(path.join(candidate, "config.json")) || isFile(path.join(candidate, "model.safetensors")))) {
                    return { present: true, path: candidate, rel: root ? path.relative(root, candidate) : candidate, size: 0, matchedBy: "path", mismatch: "" };
                }
            }
            return { present: false, path: "", rel: "", size: 0, matchedBy: "", mismatch: "" };
        }
        if (dir === "custom_nodes") {
            const target = path.join(root, "custom_nodes", file);
            return { present: isDir(target), path: isDir(target) ? target : "", rel: file, size: 0, matchedBy: "path", mismatch: "" };
        }
        const wanted = normalizeRelName(file);
        const wantedBase = wanted.split("/").pop() || wanted;
        const expectedSize = Number(resource.size) || 0;
        const sameSize = (item) => !expectedSize || !item.size || item.size === expectedSize;
        let directMismatch = "";
        for (const candidate of modelFileCandidates(resource, root)) {
            if (!isFile(candidate)) continue;
            let candidateSize = 0;
            try {
                candidateSize = fs.statSync(candidate).size;
            } catch {
                candidateSize = 0;
            }
            if (sameSize({ size: candidateSize })) {
                return { present: true, path: candidate, rel: root ? path.relative(root, candidate) : candidate, size: candidateSize, matchedBy: "path", mismatch: "" };
            }
            if (expectedSize && candidateSize) {
                directMismatch = `本机同名文件大小不一致（${candidateSize} / 资源包 ${expectedSize}）`;
            }
        }
        const inventory = inventoryFor(dir, root);
        const exact = inventory.filter((item) => item.rel === wanted);
        const byBase = inventory.filter((item) => (item.rel.split("/").pop() || item.rel) === wantedBase);
        const choose = (items) => items.find((item) => sameSize(item)) || null;
        let found = choose(exact) || choose(byBase);
        let matchedBy = found ? (found.rel === wanted ? "path" : "name") : "";
        let mismatch = "";
        if (!found) {
            const nameCandidate = exact[0] || byBase[0];
            if (nameCandidate) {
                found = nameCandidate;
                matchedBy = nameCandidate.rel === wanted ? "path" : "name";
                if (expectedSize && nameCandidate.size && nameCandidate.size !== expectedSize) {
                    mismatch = `本机同名文件大小不一致（${nameCandidate.size} / 资源包 ${expectedSize}），可能不是同一版本`;
                }
            }
        }
        if (!found && expectedSize > 0) {
            const bySize = inventory.filter((item) => item.size === expectedSize && item.size > 0);
            if (bySize.length === 1) {
                found = bySize[0];
                matchedBy = "size";
            }
        }
        let similarScore = 0;
        // 格式相同、名称相似度 ≥50% 的同类模型（不同量化/版本）识别；
        // 只对普通权重生效，.onnx/.engine 编译产物不做模糊匹配。
        if (!found && String(resource.type || "model") === "model") {
            const targetExt = path.extname(wantedBase).toLowerCase();
            if (FUZZY_MODEL_EXTENSIONS.has(targetExt)) {
                const similar = findSimilarModel(wantedBase, inventory.map((item) => item.rel));
                if (similar.file) {
                    const candidate = inventory.find((item) => item.rel === similar.file);
                    if (candidate) {
                        found = candidate;
                        matchedBy = "similar";
                        similarScore = similar.score;
                    }
                }
            }
        }
        if (found) {
            return { present: true, path: found.abs, rel: found.rel, size: found.size, matchedBy, mismatch: mismatch || directMismatch, similarScore };
        }
        return {
            present: false,
            path: "",
            rel: "",
            size: 0,
            matchedBy: "",
            mismatch: directMismatch,
        };
    }

    function existingPath(resource, root = comfyRoot()) {
        return resourceMatch(resource, root).path;
    }

    // 安装落点：优先 ComfyUI 实际在用、且可写的模型目录（含 extra_model_paths / 目录映射），
    // 都不可写时退回 <ComfyUI>/models/<类型>。
    function targetPath(resource, root = comfyRoot()) {
        const { dir, file } = targetParts(resource.target);
        if (dir === "custom_nodes") {
            if (!root) throw new Error("未找到 ComfyUI 安装目录");
            return path.join(root, "custom_nodes", file);
        }
        const writable = modelRoots(dir, root).find((entry) => isDir(entry) && canWrite(entry));
        if (writable) return path.join(writable, file);
        if (root) return path.join(root, "models", dir, file);
        throw new Error("未找到可写的 ComfyUI 模型目录；请确认 ComfyUI 已启动，并且「添加工作流」能识别到模型目录");
    }

    async function loadLock() {
        const data = readJson(lockPath);
        if (data && data.version === 1 && data.installed && typeof data.installed === "object") lock = data;
    }

    async function saveLock() {
        await writeJsonAtomic(lockPath, lock);
    }

    async function loadIndex({ forceRemote = false } = {}) {
        indexError = "";
        indexWarning = "";
        indexSource = "local";
        let local = null;
        let localError = "";
        const localExists = fs.existsSync(indexPath);
        try {
            local = validateIndex(readJson(indexPath));
        } catch (error) {
            localError = localExists ? error.message : "文件不存在";
        }
        let cached = null;
        if (!local) {
            try {
                cached = validateIndex(readJson(indexCachePath));
            } catch {
                cached = null;
            }
        }
        const remoteUrls = [config.resourcesIndexUrl, config.resourcesIndexUrlBackup].filter(Boolean);
        const shouldFetchRemote = forceRemote || !local;
        if (shouldFetchRemote && remoteUrls.length) {
            let lastError = null;
            let remoteLoaded = false;
            for (const [urlIndex, url] of remoteUrls.entries()) {
                try {
                    const response = await fetch(url, {
                        signal: AbortSignal.timeout(config.resourcesFetchTimeoutMs || 8000),
                        headers: { Accept: "application/json" },
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const remote = validateIndex(await response.json());
                    index = remote;
                    indexSource = urlIndex === 0 && config.resourcesIndexUrl ? "remote" : "remote-backup";
                    indexWarning = localError ? `本地索引不可用（${localError}），已从镜像加载` : "";
                    remoteLoaded = true;
                    await fsp.mkdir(config.dataDir, { recursive: true });
                    await writeJsonAtomic(indexCachePath, remote).catch(() => {});
                    break;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!remoteLoaded) {
                if (local) {
                    index = local;
                    indexSource = "local";
                    indexWarning = `远端索引不可用：${lastError?.message || "未知错误"}，已使用本地索引`;
                } else if (cached) {
                    index = cached;
                    indexSource = "cache";
                    indexWarning = `本地索引不可用（${localError || "未知错误"}），远端也不可用（${lastError?.message || "未知错误"}），已使用缓存`;
                } else {
                    index = null;
                    indexSource = "none";
                    indexError = `本地索引不可用：${localError || "未知错误"}；远端索引不可用：${lastError?.message || "未知错误"}`;
                }
            }
        } else if (local) {
            index = local;
            indexSource = "local";
        } else if (cached) {
            index = cached;
            indexSource = "cache";
            indexWarning = `本地索引不可用（${localError || "未知错误"}），已使用缓存`;
        } else {
            index = null;
            indexSource = "none";
            indexError = `本地索引不可用：${localError || "未知错误"}`;
        }
        loadedAt = nowIso();
        return index;
    }

    async function probeHardware() {
        const ramTotalBytes = os.totalmem();
        const ramFreeBytes = os.freemem();
        const args = ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"];
        const commands = [
            ["nvidia-smi", args],
            [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"), args],
        ];
        for (const [file, commandArgs] of commands) {
            try {
                const output = await execFileText(file, commandArgs);
                const line = output.trim().split(/\r?\n/)[0];
                if (!line) continue;
                const comma = line.lastIndexOf(",");
                if (comma < 0) continue;
                const gpuName = line.slice(0, comma).trim();
                const vramTotalMb = Number(line.slice(comma + 1).trim());
                if (!gpuName || !Number.isFinite(vramTotalMb) || vramTotalMb <= 0) continue;
                return { gpuName, vramTotalMb: Math.round(vramTotalMb), ramTotalBytes, ramFreeBytes, detectedAt: nowIso(), source: "nvidia-smi" };
            } catch {
                // 试下一个 nvidia-smi 路径。
            }
        }
        return { gpuName: "", vramTotalMb: 0, ramTotalBytes, ramFreeBytes, detectedAt: nowIso(), source: "none" };
    }

    async function copyBundledSource(source, destination, jobItem, signal) {
        const root = path.resolve(config.rootDir);
        const file = path.resolve(root, String(source.path || "").replace(/^[/\\]+/, ""));
        if (!file.startsWith(`${root}${path.sep}`)) throw new Error("非法内置资源路径");
        if (!isFile(file)) throw new Error("内置资源不存在");
        if (signal?.aborted) throw new Error("已取消");
        const size = fs.statSync(file).size;
        await fsp.copyFile(file, destination);
        jobItem.bytes = size;
        updateJob(jobItem.job);
        return size;
    }

    function resourceLoaderSpecs(resource) {
        let dir = "";
        let file = "";
        try {
            ({ dir, file } = targetParts(resource.target));
        } catch {
            return [];
        }
        // llama-cpp 的 GGUF 不在标准 MODEL_LOADER_SPECS 里：主模型和 mmproj 是两个不同输入。
        if (dir === "LLM") {
            return [{
                classType: "llama_cpp_model_loader",
                input: /mmproj/i.test(file) ? "mmproj" : "model",
                from: file,
            }];
        }
        return MODEL_LOADER_SPECS.filter((spec) => (spec.dirs || []).includes(dir)).map((spec) => ({
            classType: spec.classType,
            input: spec.input,
            from: file,
        }));
    }

    function resourceAliasFor(resource) {
        for (const spec of resourceLoaderSpecs(resource)) {
            // 只有用户显式「自选替换」才显示为已替换；自动/相似别名由文件匹配呈现。
            const to = setup?.userModelAliasFor?.(spec.classType, spec.input, spec.from) || "";
            if (to) return { ...spec, to };
        }
        return null;
    }

    async function pickResourceReplacement(resourceId) {
        const resource = resourceById(resourceId);
        if (!resource) throw new Error("资源不存在");
        if (!["model", "bake"].includes(resource.type || "model")) throw new Error("这个资源不支持替换");
        let dir = "";
        try {
            dir = targetParts(resource.target).dir;
        } catch {
            throw new Error("这个资源不支持替换");
        }
        const picked = await setup.pickModelFile({ dir });
        return picked?.file || "";
    }

    async function setResourceReplacement(resourceId, file) {
        const resource = resourceById(resourceId);
        if (!resource) throw new Error("资源不存在");
        if (!["model", "bake"].includes(resource.type || "model")) throw new Error("这个资源不支持替换");
        const specs = resourceLoaderSpecs(resource);
        if (!specs.length) throw new Error("这个资源不支持替换");
        // 底模替换时清掉旧的“按包主模型”选择，避免旧的 UNET 覆盖压过新的资源替换。
        const dir = targetParts(resource.target).dir;
        if (dir === "diffusion_models" && mainModels?.setForWorkflow) {
            const targetFile = targetParts(resource.target).file;
            for (const pack of index?.packs || []) {
                if (!(pack.resources || []).includes(resourceId)) continue;
                const workflowIds = [...new Set([...(pack.workflows || []), ...Object.keys(pack.workflowDependencies || {})])];
                for (const workflowId of workflowIds) {
                    const entry = registry?.resolve?.(workflowId);
                    const defaultFile = findUnetLoader(entry?.workflow)?.file || "";
                    if (defaultFile && defaultFile.replace(/\\/g, "/") === targetFile) {
                        await mainModels.setForWorkflow(workflowId, "");
                    }
                }
            }
        }
        await setup.setModelAliases(specs.map((spec) => ({ ...spec, to: file })));
        inventoryCache.clear();
        clearExtraModelPathsCache();
        return status();
    }

    function registeredModel(modelDir, file) {
        const spec = LOADER_BY_DIR[modelDir];
        if (!spec) return false;
        const options = setup?.loaderOptions?.() || {};
        const list = Array.isArray(options[spec.classType]) ? options[spec.classType] : [];
        return list.includes(file);
    }

    const pipCheckCache = new Map();
    const pythonVersionCache = new Map();

    function pythonVersionFor(python) {
        if (!python) return "";
        const cached = pythonVersionCache.get(python);
        if (cached && Date.now() - cached.at < 600000) return cached.version;
        let version = "";
        try {
            version = String(execFileSync(python, ["-c", "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
                timeout: 10000,
                windowsHide: true,
                encoding: "utf8",
            })).trim();
        } catch {
            version = "";
        }
        pythonVersionCache.set(python, { at: Date.now(), version });
        return version;
    }

    function pipImportStatus(python, module, { fresh = false, distribution = "" } = {}) {
        if (!python || !module) return { present: false, version: "", reason: "未找到 ComfyUI 的 Python" };
        const key = `${python}|${module}`.toLowerCase();
        const cached = pipCheckCache.get(key);
        if (!fresh && cached && Date.now() - cached.at < (cached.present ? 600000 : 60000)) return cached;
        try {
            const distributionName = String(distribution || module).trim() || module;
            const code = [
                `import ${module} as _m`,
                "import importlib.metadata as _md",
                "try:",
                `    _v = _md.version(${JSON.stringify(distributionName)})`,
                "except Exception:",
                '    _v = ""',
                'print(getattr(_m, "__version__", "") or _v)',
            ].join("\n");
            const stdout = execFileSync(python, ["-c", code], {
                timeout: 15000,
                windowsHide: true,
                encoding: "utf8",
            });
            // import 时第三方库可能往 stdout 打日志，版本号取最后一行。
            const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
            const result = { present: true, version: lines.pop() || "", reason: "", at: Date.now() };
            pipCheckCache.set(key, result);
            return result;
        } catch {
            const result = { present: false, version: "", reason: `Python 环境缺少 ${module}`, at: Date.now() };
            pipCheckCache.set(key, result);
            return result;
        }
    }

    function pipStatusFor(resource, root) {
        const python = comfyPythonForBake(root);
        const module = String(resource.module || resource.importName || "").trim();
        const distribution = String(resource.pipName || module).trim();
        const imported = pipImportStatus(python, module, { distribution });
        const distributionVersion = imported.present ? "" : pipDistributionVersion(python, distribution);
        return { python, ...imported, distributionVersion };
    }

    function pipDistributionVersion(python, distribution) {
        if (!python || !distribution) return "";
        try {
            return String(
                execFileSync(python, ["-c", `import importlib.metadata as m;print(m.version(${JSON.stringify(String(distribution))}))`], {
                    timeout: 10000,
                    windowsHide: true,
                    encoding: "utf8",
                }),
            ).trim();
        } catch {
            return "";
        }
    }

    const pipRuntimeCache = new Map();

    function pipRuntimeFor(python) {
        if (!python) return { python: "", torch: "", cuda: "" };
        const cached = pipRuntimeCache.get(python);
        if (cached && Date.now() - cached.at < 1800000) return cached.info;
        let info = { python: pythonVersionFor(python), torch: "", cuda: "" };
        try {
            const stdout = execFileSync(
                python,
                [
                    "-c",
                    "import sys,json,torch;print(json.dumps({'python':f'{sys.version_info.major}.{sys.version_info.minor}','torch':torch.__version__,'cuda':torch.version.cuda or ''}))",
                ],
                { timeout: 20000, windowsHide: true, encoding: "utf8" },
            );
            const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).reverse();
            for (const line of lines) {
                const text = line.trim();
                if (!text.startsWith("{")) continue;
                const parsed = JSON.parse(text);
                info = {
                    python: String(parsed.python || info.python),
                    torch: String(parsed.torch || ""),
                    cuda: String(parsed.cuda || ""),
                };
                break;
            }
        } catch {
            // torch 导入失败时保留 Python 版本，wheel 选择会按缺失 Torch 处理。
        }
        pipRuntimeCache.set(python, { at: Date.now(), info });
        return info;
    }

    function pickPipWheel(resource, python) {
        const matrix = Array.isArray(resource?.wheelMatrix) ? resource.wheelMatrix : [];
        if (matrix.length) {
            const runtime = pipRuntimeFor(python);
            const selected = selectPipWheelForRuntime(resource, runtime);
            if (selected) return { ...selected, runtime };
            return { url: "", size: 0, sha256: "", label: "", runtime, missing: true };
        }
        const version = pythonVersionFor(python);
        const wheels = resource?.wheels && typeof resource.wheels === "object" ? resource.wheels : {};
        const url = String(wheels[version] || resource?.wheel || "").trim();
        return {
            url,
            size: 0,
            sha256: "",
            label: "",
            runtime: { python: version, torch: "", cuda: "" },
            missing: !url,
        };
    }

    function resourceStatus(resource, root) {
        const { dir, file } = targetParts(resource.target);
        const isNode = dir === "custom_nodes" || resource.type === "node";
        const isPip = resource.type === "pip";
        const pip = isPip ? pipStatusFor(resource, root) : null;
        const directMatch = isPip || isNode ? null : resourceMatch(resource, root);
        // 用户显式「自选替换」是基本功能：无论自动结果是精确、同名、体积还是相似，
        // 只要用户选过就以用户选择为准；自动匹配只在没有自选时生效。
        const alias = isPip || isNode ? null : resourceAliasFor(resource);
        const match = alias
            ? { present: true, path: "", rel: alias.to, size: 0, matchedBy: "alias", mismatch: "" }
            : isPip
              ? { present: Boolean(pip.present), path: "", rel: "", size: 0, matchedBy: pip.present ? "python" : "", mismatch: "" }
              : isNode
                ? (() => {
                      const target = root ? path.join(root, "custom_nodes", file) : "";
                      const dirPresent = Boolean(target && isDir(target));
                      // 用户可能装的是同名插件的另一个目录（大小写/后缀不同），
                      // 只要能提供同样的节点类就算已装，避免重复下载。
                      const provides = Array.isArray(resource.provides) ? resource.provides.filter(Boolean) : [];
                      const classPresent = provides.length > 0 && provides.every((name) => setup?.hasNodeClass?.(name));
                      const present = dirPresent || classPresent;
                      return { present, path: dirPresent ? target : "", rel: file, size: 0, matchedBy: dirPresent ? "path" : classPresent ? "class" : "", mismatch: "" };
                  })()
                : directMatch;
        const exists = Boolean(match.present);
        let size = Number(match.size) || 0;
        if (!size && match.path) {
            try {
                size = fs.statSync(match.path).size;
            } catch {
                size = 0;
            }
        }
        const registered = dir !== "custom_nodes" ? exists : false;
        const isBake = resource.type === "bake";
        const wheelMatrix = isPip && Array.isArray(resource.wheelMatrix) ? resource.wheelMatrix : [];
        const wheelPlan = isPip ? pickPipWheel(resource, pip?.python || "") : null;
        const wheelVersions = isPip
            ? wheelMatrix.length
                ? wheelMatrix.map((item) => `${item.cuda || "*"} / torch ${item.torch || "*"}`)
                : Object.keys(resource.wheels || {})
            : [];
        const pythonVersion = isPip ? (wheelPlan?.runtime?.python || pythonVersionFor(pip?.python || "")) : "";
        const missingRequires = isBake ? (resource.requires || []).filter((id) => {
            const dependency = index?.resources?.find((item) => item.id === id);
            if (!dependency) return true;
            if (!root) return true;
            return !resourceMatch(dependency, root).present;
        }) : [];
        const status = isBake
            ? (exists ? "present" : missingRequires.length ? "blocked" : "missing")
            : isNode
              ? exists ? "present" : "missing"
              : exists
                ? "present"
                : "missing";
        const installed = lock.installed?.[resource.id] || null;
        return {
            id: resource.id,
            type: resource.type || "model",
            label: resource.label || resource.id,
            target: resource.target,
            size: Number(resource.size) || 0,
            sha256: resource.sha256 || "",
            license: resource.license || "",
            note: resource.note || "",
            sources: (() => {
                const sources = normalizeSources(resource);
                return resource.bundleDir ? [{ kind: "bundled-dir", path: resource.bundleDir, label: "内置目录" }, ...sources] : sources;
            })(),
            requires: resource.requires || [],
            builder: resource.builder || null,
            status,
            present: status === "present",
            registered,
            exists,
            matchedFile: match.rel || "",
            matchedBy: match.matchedBy || "",
            similarScore: Number(match.similarScore) || 0,
            sizeMismatch: resource.type === "bake" ? "" : match.mismatch || "",
            actualSize: size,
            installed,
            missingRequires,
            ...(alias ? { overridden: true, overriddenBy: alias.to, matchedFile: alias.to } : {}),
            ...(isPip
                ? {
                      pythonRuntime: pip.python || "",
                      pythonVersion,
                      pipVersion: pip.present ? pip.version || "" : pip.distributionVersion || "",
                      pipBroken: Boolean(!pip.present && pip.distributionVersion),
                      pipReason: pip.reason || "",
                      pipName: String(resource.pipName || resource.module || ""),
                      wheelVersions,
                      pipRuntime: wheelPlan?.runtime || null,
                      pipWheel: wheelPlan?.url ? { url: wheelPlan.url, size: wheelPlan.size || 0, sha256: wheelPlan.sha256 || "" } : null,
                      pipWheelMissing: Boolean(pythonVersion && wheelPlan?.missing),
                      pipMinVersion: String(resource.minVersion || ""),
                      pipOutdated: Boolean(
                          pip.present &&
                              resource.minVersion &&
                              (!pip.version || !satisfiesVersion(pip.version, `>=${resource.minVersion}`)),
                      ),
                      restartAfterInstall: Boolean(resource.restartAfterInstall),
                  }
                : {}),
        };
    }

    function resourceFile(resource) {
        try {
            return targetParts(resource.target).file;
        } catch {
            return "";
        }
    }

    function mainModelInfo(pack, installed) {
        const workflowIds = [...new Set([...(pack.workflows || []), ...Object.keys(pack.workflowDependencies || {})])];
        if (!workflowIds.length) return null;
        const resolved = workflowIds.map((id) => ({ id, entry: registry?.resolve?.(id) })).filter((item) => item.entry);
        const files = [...new Set(resolved.map(({ entry }) => findUnetLoader(entry.workflow)?.file).filter(Boolean))];
        if (!files.length) return null;
        // 编译产物不是可替换的底模，主模型覆盖不能套到它上面
        const bakeFiles = new Set((index?.resources || []).filter((item) => item.type === "bake").map((item) => resourceFile(item)).filter(Boolean));
        const overrideIds = resolved.filter(({ entry }) => !bakeFiles.has(findUnetLoader(entry.workflow)?.file || "")).map((item) => item.id);
        const selected = mainModels?.fileForPack?.(pack.id) || "";
        const selectedInstalled = Boolean(selected && installed.has(selected));
        const filter = resolved.map(({ entry }) => entry.baseModels?.filter).find(Boolean) || "";
        const matchesFamily = (file) => {
            if (!filter) return true;
            try {
                return new RegExp(filter, "i").test(file);
            } catch {
                return true;
            }
        };
        const options = new Map();
        for (const id of pack.resources || []) {
            const resource = index?.resources?.find((item) => item.id === id);
            if (!resource || resource.type === "bake" || !resourceFile(resource)) continue;
            let dir = "";
            try {
                dir = targetParts(resource.target).dir;
            } catch {
                continue;
            }
            if (dir !== "diffusion_models") continue;
            const file = resourceFile(resource);
            options.set(file, { file, label: resource.label || file, installed: installed.has(file), source: "pack", matches: true, resourceId: resource.id });
        }
        for (const file of installed) {
            if (options.has(file) || bakeFiles.has(file)) continue;
            options.set(file, { file, label: path.basename(file, path.extname(file)), installed: true, source: "local", matches: matchesFamily(file) });
        }
        if (selected && !options.has(selected)) {
            options.set(selected, { file: selected, label: path.basename(selected, path.extname(selected)), installed: false, source: "local" });
        }
        const defaultResource = (pack.resources || [])
            .map((id) => index?.resources?.find((item) => item.id === id))
            .find((resource) => resource && resourceFile(resource) === files[0]);
        return {
            workflowIds: overrideIds,
            files,
            defaultFile: files.find((file) => !bakeFiles.has(file)) || files[0],
            defaultLabel: files.length > 1 ? "各工作流原底模" : defaultResource?.label || path.basename(files[0], path.extname(files[0])),
            selected,
            selectedLabel: options.get(selected)?.label || "",
            selectedInstalled,
            options: [...options.values()].sort((a, b) => {
                if (a.source !== b.source) return a.source === "pack" ? -1 : 1;
                return a.label.localeCompare(b.label);
            }),
        };
    }

    function workflowMainModelInfo(pack, workflowId, installed) {
        const base = mainModelInfo(pack, installed);
        if (!base || !base.workflowIds.includes(workflowId)) return null;
        const entry = registry?.resolve?.(workflowId);
        const file = findUnetLoader(entry?.workflow)?.file || "";
        if (!file) return null;
        const raw = mainModels?.fileForWorkflow?.(workflowId) || "";
        const selected = raw === file ? "" : raw;
        const defaultResource = (index?.resources || []).find((resource) => resourceFile(resource) === file);
        return {
            workflowId,
            defaultFile: file,
            defaultLabel: defaultResource?.label || path.basename(file, path.extname(file)),
            selected,
            selectedLabel: base.options.find((option) => option.file === selected)?.label || "",
            selectedInstalled: Boolean(selected && installed.has(selected)),
            options: base.options.filter((option) => option.file !== file),
        };
    }

    const PROMPT_ENGINES = [
        {
            id: "qwen",
            label: "Qwen3.5-9B",
            resourceIds: ["prompt_qwen_gguf", "prompt_qwen_mmproj", "prompt_llama_node", "prompt_te_man", "prompt_llama_python"],
            nodeClasses: ["llama_cpp_model_loader", "llama_cpp_instruct_adv", "TE_text_display"],
        },
        {
            id: "florence",
            label: "Florence-2 PromptGen",
            resourceIds: ["prompt_florence_node", "prompt_florence_model", "prompt_te_man"],
            nodeClasses: ["DownloadAndLoadFlorence2Model", "Florence2Run", "TE_text_display"],
        },
        {
            id: "teMan",
            label: "本地提示词优化",
            resourceIds: ["prompt_te_man"],
            nodeClasses: ["TE_H3_Prompt_Enhancer", "TE_Qwen_Image_2_1_Prompt_Enhancer"],
        },
        {
            id: "imagePe",
            label: "本地生图提示词优化",
            resourceIds: ["prompt_te_man", "qwen3.5_9b_int8_convrot"],
            nodeClasses: ["TE_Qwen_Image_2_1_Prompt_Enhancer"],
        },
    ];

    function promptCapabilities(resources) {
        const byId = new Map((resources || []).map((item) => [item.id, item]));
        const reachable = Boolean(setup?.status?.().comfyReachable);
        const engines = {};
        for (const spec of PROMPT_ENGINES) {
            const missingResources = [];
            const missingNodes = [];
            const reasons = [];
            for (const id of spec.resourceIds) {
                const item = byId.get(id);
                if (!item) {
                    missingResources.push({ id, label: id });
                    reasons.push(`资源索引缺少 ${id}`);
                    continue;
                }
                if (item.status !== "present") {
                    missingResources.push({ id, label: item.label });
                    reasons.push(item.pipReason || `缺少 ${item.label}`);
                }
            }
            for (const classType of spec.nodeClasses) {
                if (!setup?.hasNodeClass?.(classType)) {
                    missingNodes.push(classType);
                    reasons.push(`缺少节点 ${classType}`);
                }
            }
            if (!reachable) reasons.unshift("ComfyUI 未连接");
            engines[spec.id] = {
                id: spec.id,
                label: spec.label,
                available: reachable && missingResources.length === 0 && missingNodes.length === 0,
                missingResources,
                missingNodes,
                reasons,
            };
        }
        return { packId: "prompt-local", comfyReachable: reachable, engines };
    }

    function status() {
        const root = comfyRoot();
        const installedModels = new Set(Array.isArray(setup?.loaderOptions?.()?.UNETLoader) ? setup.loaderOptions().UNETLoader : []);
        const packMainModels = new Map();
        const overriddenResources = new Map();
        for (const pack of index?.packs || []) {
            const info = mainModelInfo(pack, installedModels);
            if (!info) continue;
            packMainModels.set(pack.id, info);
            if (!info.selectedInstalled) continue;
            for (const resource of index?.resources || []) {
                let dir = "";
                try {
                    dir = targetParts(resource.target).dir;
                } catch {
                    continue;
                }
                if (dir === "diffusion_models" && resource.type !== "bake" && info.files.includes(resourceFile(resource))) overriddenResources.set(resource.id, info.selected);
            }
        }
        const resources = (index?.resources || []).map((resource) => {
            const item = resourceStatus(resource, root);
            const overriddenBy = overriddenResources.get(item.id);
            if (overriddenBy) Object.assign(item, { status: "present", present: true, overridden: true, overriddenBy });
            return item;
        });
        const byId = new Map(resources.map((resource) => [resource.id, resource]));
        const rawPackById = new Map((index?.packs || []).map((item) => [item.id, item]));
        const packs = (index?.packs || []).map((pack) => {
            const items = (pack.resources || []).map((id) => byId.get(id)).filter(Boolean);
            const optionalIds = new Set(pack.optionalResources || []);
            const requiredItems = items.filter((item) => !optionalIds.has(item.id));
            const optionalItems = items.filter((item) => optionalIds.has(item.id));
            const requiredMissing = requiredItems.filter((item) => item.status !== "present");
            const optionalMissing = optionalItems.filter((item) => item.status !== "present");
            const workflowDependencies = Object.entries(pack.workflowDependencies || {}).map(([workflowId, dependencyIds]) => {
                const dependencyItems = dependencyIds.map((id) => byId.get(id)).filter(Boolean);
                const missingItems = dependencyItems.filter((item) => item.status !== "present");
                const installIds = new Set();
                for (const item of missingItems) {
                    installIds.add(item.id);
                    if (item.type === "bake") {
                        for (const requiredId of item.requires || []) {
                            const required = byId.get(requiredId);
                            if (required && required.status !== "present") installIds.add(requiredId);
                        }
                    }
                }
                const availability = setup?.workflowStatus?.(workflowId) || { available: true, problems: [] };
                const entry = registry?.resolve?.(workflowId);
                return {
                    id: workflowId,
                    label: entry?.label || entry?.name || workflowId,
                    available: availability.available !== false,
                    enabled: !workflowVisibility?.isHidden?.(workflowId),
                    modelVisible: entry?.hidden !== true,
                    variantLabels: entry?.variantLabels || {},
                    problems: availability.problems || [],
                    recommended: false,
                    mainModel: workflowMainModelInfo(pack, workflowId, installedModels),
                    resources: dependencyItems,
                    missing: missingItems.length,
                    missingSize: missingItems.reduce((sum, item) => sum + (item.size || 0), 0),
                    installIds: [...installIds].filter((id) => byId.get(id)?.status !== "present"),
                };
            });
            const workflowMissingMap = new Map();
            for (const workflow of workflowDependencies) {
                for (const item of workflow.resources) {
                    if (item.status !== "present") workflowMissingMap.set(item.id, item);
                }
            }
            const workflowMissing = workflowMissingMap;
            const workflowMissingSize = [...workflowMissingMap.values()].reduce((sum, item) => sum + (item.size || 0), 0);
            const variants = (rawPackById.get(pack.id)?.variants || []).map((variant) => {
                const optionalIds = new Set(pack.optionalResources || []);
                const derived = [...new Set((variant.workflows || []).flatMap((workflowId) => (pack.workflowDependencies || {})[workflowId] || []))]
                    .filter((id) => !optionalIds.has(id));
                return {
                    id: variant.id,
                    label: variant.label || variant.id,
                    tier: variant.tier || pack.tier || "standard",
                    workflows: variant.workflows || [],
                    requiredIds: variant.requiredResources?.length ? variant.requiredResources : derived,
                    requirements: variant.requirements || null,
                    eligible: true,
                    recommended: false,
                    preferred: false,
                    offload: false,
                    resident: false,
                };
            });
            return {
                id: pack.id,
                label: pack.label || pack.id,
                description: pack.description || "",
                family: pack.family || pack.id,
                tier: pack.tier || "standard",
                optional: Boolean(pack.optional),
                optionalLabel: pack.optionalLabel || "",
                autoRecommend: pack.autoRecommend !== false,
                planned: Boolean(pack.planned),
                eligible: true,
                recommended: false,
                recommendedVariant: "",
                variants,
                preferred: false,
                offload: false,
                resident: false,
                workflows: pack.workflows || [],
                resourceIds: pack.resources || [],
                requiredIds: requiredItems.map((item) => item.id),
                optionalIds: optionalItems.map((item) => item.id),
                resources: items,
                requiredItems,
                optionalItems,
                mainModel: packMainModels.get(pack.id) || null,
                workflowDependencies,
                total: requiredItems.length,
                present: requiredItems.length - requiredMissing.length,
                missing: pack.planned ? 0 : requiredMissing.length,
                missingSize: requiredMissing.reduce((sum, item) => sum + (item.size || 0), 0),
                optionalTotal: optionalItems.length,
                optionalPresent: optionalItems.length - optionalMissing.length,
                optionalMissing: optionalMissing.length,
                optionalSize: optionalMissing.reduce((sum, item) => sum + (item.size || 0), 0),
            };
        });

        for (const pack of packs) {
            if (!pack.mainModel) continue;
            pack.mainModel.available = pack.mainModel.workflowIds.some((id) => setup?.workflowStatus?.(id)?.available);
        }

        const hardwareAvailable = Boolean(hardware?.gpuName && hardware.vramTotalMb > 0);
        const tierRank = { quality: 4, balanced: 3, standard: 2, lite: 1, core: 0 };
        if (hardwareAvailable) {
            const vramGb = hardware.vramTotalMb / 1024;
            const ramGb = hardware.ramTotalBytes / 1024 ** 3;
            const evaluate = (requirements, items) => {
                const floor = Number(requirements.vramFloorGb || 0);
                const weights = Number(requirements.weightsGb || 0);
                const usable = Math.max(0, vramGb - floor);
                const offloadGb = Math.max(0, weights - usable);
                let ramNeed = Number(requirements.ramBaseGb || 8) + offloadGb * (1 + Number(requirements.safety || 0.15));
                const bakeResource = (items || []).find((item) => item.type === "bake");
                const bakeNeeded = Boolean(bakeResource && bakeResource.status !== "present");
                if (requirements.installRamGb && bakeNeeded) ramNeed = Math.max(ramNeed, Number(requirements.installRamGb));
                const eligible = vramGb >= floor && ramGb >= ramNeed;
                const offload = eligible && weights > Math.max(0, usable - 2);
                return {
                    eligible,
                    preferred: eligible && vramGb >= Number(requirements.recommendVramGb || 0),
                    offload,
                    resident: eligible && !offload && ramGb >= Number(requirements.ramBaseGb || 8),
                };
            };
            const groups = new Map();
            for (const pack of packs) {
                if (pack.planned || pack.id === "core") continue;
                if (!pack.autoRecommend) continue;
                const requirements = rawPackById.get(pack.id)?.requirements;
                if (pack.variants.length) {
                    // 同一模型家族的 BF16/INT8 合并为一张卡，推荐档位在变体之间选。
                    let best = null;
                    for (const variant of pack.variants) {
                        const variantRequirements = variant.requirements || requirements;
                        if (!variantRequirements) {
                            variant.eligible = false;
                            continue;
                        }
                        Object.assign(variant, evaluate(variantRequirements, pack.resources));
                        if (variant.eligible && variant.preferred && (!best || (tierRank[variant.tier] || 0) > (tierRank[best.tier] || 0))) best = variant;
                    }
                    pack.eligible = pack.variants.some((variant) => variant.eligible);
                    if (best) {
                        best.recommended = true;
                        pack.recommended = true;
                        pack.recommendedVariant = best.id;
                        pack.preferred = true;
                        pack.offload = best.offload;
                        pack.resident = best.resident;
                    } else {
                        const fallback = pack.variants.find((variant) => variant.eligible && variant.offload) || pack.variants.find((variant) => variant.eligible);
                        pack.preferred = false;
                        pack.offload = Boolean(fallback?.offload);
                        pack.resident = Boolean(fallback?.resident);
                    }
                    continue;
                }
                if (!requirements) continue;
                Object.assign(pack, evaluate(requirements, pack.resources));
                if (!pack.eligible) continue;
                const list = groups.get(pack.family) || [];
                list.push({ pack, rank: tierRank[pack.tier] || 0, preferred: pack.preferred });
                groups.set(pack.family, list);
            }
            for (const list of groups.values()) {
                const preferred = list.filter((item) => item.preferred);
                preferred.sort((a, b) => b.rank - a.rank);
                if (preferred[0]) preferred[0].pack.recommended = true;
            }
            for (const pack of packs) {
                if (!pack.recommendedVariant) continue;
                const variant = pack.variants.find((item) => item.id === pack.recommendedVariant);
                if (!variant) continue;
                const requiredItems = variant.requiredIds.map((id) => byId.get(id)).filter(Boolean);
                const requiredMissing = requiredItems.filter((item) => item.status !== "present");
                pack.requiredItems = requiredItems;
                pack.requiredIds = requiredItems.map((item) => item.id);
                pack.total = requiredItems.length;
                pack.present = requiredItems.length - requiredMissing.length;
                for (const workflow of pack.workflowDependencies) {
                    workflow.recommended = variant.workflows.includes(workflow.id);
                }
            }
        }

        const workflowResourceIds = new Set();
        for (const pack of packs) {
            for (const workflow of pack.workflowDependencies || []) {
                for (const item of workflow.resources) {
                    workflowResourceIds.add(item.id);
                    for (const dep of item.requires || []) workflowResourceIds.add(dep);
                }
            }
        }
        for (const pack of packs) {
            if (pack.workflowDependencies?.length) continue;
            for (const item of pack.resources || []) workflowResourceIds.add(item.id);
        }
        const workflowResources = resources.filter((item) => workflowResourceIds.has(item.id));
        const workflowMissing = workflowResources.filter((item) => item.status !== "present");
        const recommendedPacks = packs.filter((pack) => pack.recommended);
        const recommendedIds = new Set(recommendedPacks.flatMap((pack) => pack.requiredIds || pack.resourceIds));
        const recommendedResources = resources.filter((resource) => recommendedIds.has(resource.id));
        const recommendedMissing = recommendedResources.filter((resource) => resource.status !== "present");
        return {
            ok: true,
            loadedAt,
            indexSource,
            indexError,
            indexWarning,
            indexVersion: index?.version || "",
            channel: index?.channel || "",
            comfyRoot: root,
            comfyPython: comfyPython(root),
            modelRoots: (() => {
                const map = {};
                for (const dir of MODEL_DIRS) {
                    const roots = modelRoots(dir, root).filter(isDir);
                    if (roots.length) map[dir] = roots;
                }
                return map;
            })(),
            comfyReachable: Boolean(setup?.status?.().comfyReachable),
            promptCapabilities: promptCapabilities(resources),
            hardware: hardware || null,
            recommendationAvailable: hardwareAvailable && recommendedPacks.length > 0,
            packs,
            resources,
            summary: {
                packs: packs.filter((pack) => !pack.planned).length,
                resources: workflowResources.length,
                present: workflowResources.length - workflowMissing.length,
                missing: workflowMissing.length,
                missingSize: workflowMissing.reduce((sum, item) => sum + (item.size || 0), 0),
                allResources: resources.length,
                recommendedPacks: recommendedPacks.length,
                recommendedResources: recommendedResources.length,
                recommendedPresent: recommendedResources.length - recommendedMissing.length,
                recommendedMissing: recommendedMissing.length,
                recommendedMissingSize: recommendedMissing.reduce((sum, item) => sum + (item.size || 0), 0),
            },
            lock: { installed: lock.installed || {}, updatedAt: lock.updatedAt || "" },
        };
    }

    async function setMainModel(packId, file) {
        const pack = index?.packs?.find((item) => item.id === packId);
        if (!pack) throw new Error("功能包不存在");
        if (!mainModels) throw new Error("主模型选择未启用");
        const installed = new Set(Array.isArray(setup?.loaderOptions?.()?.UNETLoader) ? setup.loaderOptions().UNETLoader : []);
        const info = mainModelInfo(pack, installed);
        if (!info) throw new Error("该功能包没有可切换的主模型");
        const raw = String(file || "").trim();
        const value = raw === info.defaultFile ? "" : raw;
        const bakeFiles = new Set((index?.resources || []).filter((item) => item.type === "bake").map((item) => resourceFile(item)).filter(Boolean));
        if (value && bakeFiles.has(value)) throw new Error("烘焙产物不能作为主模型");
        if (value && !installed.has(value)) throw new Error("所选主模型尚未安装");
        await mainModels.set(pack.id, { file: value, workflows: info.workflowIds });
        try {
            runtimeStatusCache.clear();
            await setup?.scan?.();
        } catch (error) {
            logger?.warn?.(`切换主模型后扫描失败：${error.message}`);
        }
        return status();
    }

    function jobSnapshot(job) {
        const items = job.items.map((item) => ({
            id: item.id,
            label: item.label,
            type: item.type,
            status: item.status,
            bytes: item.bytes,
            size: item.size,
            source: item.source,
            error: item.error,
            hint: item.hint || "",
            skipped: item.skipped,
        }));
        const known = items.filter((item) => item.size > 0 && item.status !== "skipped");
        const totalBytes = known.reduce((sum, item) => sum + item.size, 0);
        const doneBytes = known.reduce((sum, item) => sum + Math.min(item.bytes || 0, item.size), 0);
        const finished = items.filter((item) => ["done", "skipped", "error"].includes(item.status)).length;
        return {
            id: job.id,
            status: job.status,
            message: job.message,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            items,
            completed: finished,
            total: items.length,
            progress: totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : items.length ? Math.round((finished / items.length) * 100) : 100,
            error: job.error || "",
        };
    }

    function updateJob(job) {
        job.updatedAt = nowIso();
        jobs.set(job.id, job);
        while (jobs.size > JOB_LIMIT) {
            const oldest = [...jobs.keys()].find((id) => jobs.get(id)?.status !== "running");
            if (!oldest) break;
            jobs.delete(oldest);
        }
    }

    function resourceById(id) {
        return index?.resources?.find((resource) => resource.id === id) || null;
    }

    const runtimeStatusCache = new Map();

    function cachedResourceStatus(resource, root) {
        const key = `${resource.id}|${root}`;
        const cached = runtimeStatusCache.get(key);
        if (cached && Date.now() - cached.at < 30000) return cached.value;
        const value = resourceStatus(resource, root);
        runtimeStatusCache.set(key, { at: Date.now(), value });
        return value;
    }

    // VDN 需要整套目录（model + turbo/default adapter + config），不能只看 loader 里的文件名。
    function vdnResourcePresent(resource, root = comfyRoot()) {
        if (!root) return false;
        const { dir, file } = targetParts(resource.target);
        return modelRoots(dir, root).some((base) => isFile(path.join(base, file)));
    }

    // 可用性扫描补运行期依赖：pip 运行库、TRT 编译产物、自定义节点、VDN 整套目录。
    // 普通模型由 setup 的 loader 校验负责，这里不重复报。
    function runtimeProblemsFor(workflowId) {
        if (!index) return [];
        const ids = new Set();
        for (const pack of index.packs || []) {
            const deps = pack.workflowDependencies?.[workflowId];
            if (Array.isArray(deps)) for (const id of deps) ids.add(id);
        }
        const problems = [];
        const missingVdn = [];
        for (const id of ids) {
            const resource = resourceById(id);
            if (!resource) continue;
            if (String(id).startsWith("h3_vdn_stage_")) {
                if (!vdnResourcePresent(resource)) missingVdn.push(resource);
                continue;
            }
            const type = String(resource.type || "model");
            if (!["pip", "bake", "node"].includes(type)) continue;
            const state = cachedResourceStatus(resource, comfyRoot());
            if (state.present) continue;
            const blocked = state.missingRequires?.length ? `（先安装 ${state.missingRequires.join("、")}）` : "";
            problems.push({
                type: "runtime",
                message: `缺少运行期依赖：${state.label}${blocked}`,
                resourceId: id,
            });
        }
        if (missingVdn.length) {
            const stageB = missingVdn.find((resource) => resource.id === "h3_vdn_stage_default_adapter");
            problems.push({
                type: "model",
                resourceId: stageB ? stageB.id : missingVdn[0].id,
                message: stageB
                    ? "VDN 模型不完整：缺少 Stage-B 适配器（vdn/stage-dmd-step-250/adapters/default/adapter_model.safetensors）。请在资源中心重新下载完整的 stage-dmd-step-250 目录（保留内部结构），重启 ComfyUI 后重试。"
                    : `VDN 模型不完整：缺少 ${missingVdn.map((resource) => resource.label).join("、")}。请在资源中心重新下载完整的 stage-dmd-step-250 目录（保留内部结构），重启 ComfyUI 后重试。`,
            });
        }
        return problems;
    }

    function selectResources({ ids = [], packs = [] } = {}) {
        const selected = new Set();
        const add = (id) => {
            const resource = resourceById(id);
            if (!resource) throw new Error(`资源不存在：${id}`);
            selected.add(id);
            for (const dependency of resource.requires || []) add(dependency);
        };
        for (const id of ids) add(String(id));
        for (const packId of packs) {
            const pack = index?.packs?.find((item) => item.id === packId);
            if (!pack) throw new Error(`功能包不存在：${packId}`);
            for (const id of pack.resources || []) add(id);
        }
        // Dependencies first so bake jobs can run after their inputs.
        const ordered = [];
        const seen = new Set();
        const visit = (id) => {
            if (seen.has(id)) return;
            seen.add(id);
            const resource = resourceById(id);
            for (const dependency of resource?.requires || []) visit(dependency);
            ordered.push(resource);
        };
        for (const id of selected) visit(id);
        return ordered;
    }

    async function downloadSource(url, partPath, jobItem, signal, onBytes) {
        let offset = 0;
        try {
            offset = (await fsp.stat(partPath)).size;
        } catch {
            offset = 0;
        }
        const headers = { Accept: "*/*", "User-Agent": "ComfyUI-Workbench-ResourceManager/1.0" };
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason || new Error("已取消"));
        if (signal) signal.addEventListener("abort", abort, { once: true });
        const headerTimer = setTimeout(() => controller.abort(new Error("下载源响应超时")), 20000);
        let response;
        try {
            response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
        } finally {
            clearTimeout(headerTimer);
        }
        if (!response.ok) {
            if (response.status === 416 && offset > 0) return offset;
            throw new Error(`HTTP ${response.status}`);
        }
        if (!response.body) throw new Error("下载源没有响应体");
        const append = response.status === 206 && offset > 0;
        const writeStream = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
        let received = append ? offset : 0;
        let lastReport = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                const now = Date.now();
                if (now - lastReport > 250) {
                    lastReport = now;
                    onBytes?.(received);
                }
                callback(null, chunk);
            },
        });
        try {
            await pipeline(Readable.fromWeb(response.body), meter, writeStream);
        } catch (error) {
            if (signal?.aborted) throw new Error("已取消");
            throw error;
        } finally {
            if (signal) signal.removeEventListener("abort", abort);
        }
        onBytes?.(received);
        return received;
    }

    async function sha256File(file, signal) {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(file);
        try {
            for await (const chunk of stream) {
                if (signal?.aborted) throw new Error("已取消");
                hash.update(chunk);
            }
        } finally {
            stream.destroy();
        }
        return hash.digest("hex");
    }

    async function downloadResource(resource, jobItem, signal) {
        const root = comfyRoot();
        const existing = resourceStatus(resource, root);
        if (existing.status === "present") {
            jobItem.status = "skipped";
            jobItem.skipped = true;
            jobItem.bytes = existing.actualSize || 0;
            jobItem.size = jobItem.size || jobItem.bytes;
            return;
        }
        const target = targetPath(resource, root);
        const part = `${target}.part`;
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const sources = normalizeSources(resource);
        if (!sources.length) throw new Error("没有配置下载源");
        if (resource.size) {
            const free = await fsp.statfs(path.dirname(target)).catch(() => null);
            if (free && free.bavail * free.bsize < resource.size * 1.05) {
                throw new Error(`磁盘空间不足：需要约 ${(resource.size / 1024 ** 3).toFixed(1)}GB`);
            }
        }
        let lastError = null;
        let partSource = "";
        for (const source of sources) {
            let deletePart = false;
            const sourceKey = String(source.url || source.path || source.kind || "");
            try {
                if (partSource && sourceKey !== partSource && isFile(part)) {
                    await fsp.unlink(part).catch(() => {});
                    jobItem.bytes = 0;
                }
                partSource = sourceKey;
                jobItem.status = "downloading";
                jobItem.source = source.label || (source.url ? new URL(source.url).hostname : "内置");
                jobItem.bytes = 0;
                if (source.kind === "bundled" || source.path) {
                    await copyBundledSource(source, part, jobItem, signal);
                } else {
                    await downloadSource(source.url, part, jobItem, signal, (bytes) => {
                        jobItem.bytes = bytes;
                        updateJob(jobItem.job);
                    });
                }
                jobItem.status = "verifying";
                const actualSize = (await fsp.stat(part)).size;
                if (resource.size && actualSize !== resource.size) {
                    deletePart = true;
                    throw new Error(`大小不一致（${actualSize}/${resource.size}）`);
                }
                if (resource.sha256) {
                    const digest = await sha256File(part, signal);
                    if (digest.toLowerCase() !== String(resource.sha256).toLowerCase()) {
                        deletePart = true;
                        throw new Error("SHA256 校验失败");
                    }
                }
                await fsp.rename(part, target);
                lock.installed = lock.installed || {};
                lock.installed[resource.id] = { version: index?.version || "", target: resource.target, sha256: resource.sha256 || "", size: resource.size || actualSize, installedAt: nowIso() };
                lock.updatedAt = nowIso();
                await saveLock();
                jobItem.status = "done";
                jobItem.bytes = actualSize;
                return;
            } catch (error) {
                lastError = error;
                if (signal?.aborted) throw new Error("已取消");
                logger?.warn?.(`资源下载失败 ${resource.id} ← ${jobItem.source}: ${error.message}`);
                try {
                    if (deletePart && isFile(part)) await fsp.unlink(part);
                } catch {
                    // 保留可续传的临时文件；校验失败时下一轮会重新下载。
                }
            }
        }
        throw lastError || new Error("所有下载源均失败");
    }

    async function extractArchive(archive, destination) {
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.mkdir(destination, { recursive: true });
        const run = (file, args, options = {}) => new Promise((resolve, reject) => {
            const child = spawn(file, args, { windowsHide: true, ...options });
            let stderr = "";
            child.stderr.on("data", (data) => { stderr += String(data); });
            child.on("error", reject);
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `解压失败（exit ${code}）`))));
        });
        try {
            // archive 用 basename + cwd，避免 Git 的 GNU tar 把 C: 当远程主机；-C 用绝对路径，支持跨盘。
            await run("tar", ["-xf", path.basename(archive), "-C", destination.replace(/\\/g, "/")], { cwd: path.dirname(archive) });
        } catch (error) {
            const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
            const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`;
            await run(powershell, ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(destination)} -Force`]).catch(() => {
                throw new Error(`无法解压节点包：${error.message}`);
            });
        }
    }

    async function findNodeRoot(directory, depth = 0) {
        if (depth > 3) return "";
        if (isFile(path.join(directory, "__init__.py"))) return directory;
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(directory, entry.name);
            if (isFile(path.join(candidate, "__init__.py"))) return candidate;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const nested = await findNodeRoot(path.join(directory, entry.name), depth + 1);
            if (nested) return nested;
        }
        return "";
    }

    async function installNode(resource, jobItem, signal) {
        const root = comfyRoot();
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        const target = targetPath(resource, root);
        if (isDir(target)) {
            jobItem.status = "skipped";
            jobItem.skipped = true;
            return;
        }
        const sources = normalizeSources(resource);
        const bundleDir = resource.bundleDir ? path.resolve(config.rootDir, String(resource.bundleDir)) : "";
        if (bundleDir && !bundleDir.startsWith(`${path.resolve(config.rootDir)}${path.sep}`)) {
            throw new Error(`节点内置目录越界：${resource.bundleDir}`);
        }
        if (!sources.length && !(bundleDir && isDir(bundleDir))) throw new Error("没有配置节点下载源");
        if (bundleDir && isDir(bundleDir)) {
            const installRoot = path.join(root, ".canvas-install", `${resource.id}-${Date.now()}`);
            const temp = path.join(installRoot, "payload");
            try {
                jobItem.status = "copying";
                jobItem.source = "内置目录";
                jobItem.bytes = 0;
                updateJob(jobItem.job);
                await fsp.cp(bundleDir, temp, { recursive: true });
                const sourceDir = await findNodeRoot(temp);
                if (!sourceDir) throw new Error("内置目录里没有找到 __init__.py");
                await fsp.mkdir(path.dirname(target), { recursive: true });
                if (!isDir(target)) await fsp.rename(sourceDir, target);
                lock.installed = lock.installed || {};
                lock.installed[resource.id] = { version: index?.version || "", target: resource.target, size: resource.size || 0, installedAt: nowIso() };
                lock.updatedAt = nowIso();
                await saveLock();
                jobItem.status = "done";
                jobItem.bytes = resource.size || 0;
                await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
                return;
            } catch (error) {
                logger?.warn?.(`内置节点复制失败 ${resource.id}: ${error.message}，尝试下载源`);
                await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
            }
        }
        const tmpRoot = path.join(config.dataDir, "resource-downloads");
        await fsp.mkdir(tmpRoot, { recursive: true });
        const archive = path.join(tmpRoot, `${resource.id}.zip`);
        // 解压目录必须和 custom_nodes 同盘，rename 才是原子操作；跨盘 rename 在 Windows 会直接失败。
        const installRoot = path.join(root, ".canvas-install", `${resource.id}-${Date.now()}`);
        const extract = path.join(installRoot, "extract");
        await fsp.mkdir(installRoot, { recursive: true });
        let lastError = null;
        for (const source of sources) {
            try {
                if (source.kind === "bundled-dir") continue;
                await fsp.rm(archive, { force: true });
                jobItem.status = "downloading";
                jobItem.source = source.label || (source.url ? new URL(source.url).hostname : "内置");
                jobItem.bytes = 0;
                if (source.kind === "bundled" || source.path) {
                    await copyBundledSource(source, archive, jobItem, signal);
                } else {
                    await downloadSource(source.url, archive, jobItem, signal, (bytes) => {
                        jobItem.bytes = bytes;
                        updateJob(jobItem.job);
                    });
                }
                jobItem.status = "verifying";
                if (source.verify !== false) {
                    const expectedSize = Number(source.size ?? resource.size) || 0;
                    const expectedSha = String(source.sha256 ?? resource.sha256 ?? "");
                    if (expectedSize) {
                        const size = (await fsp.stat(archive)).size;
                        if (size !== expectedSize) throw new Error(`节点包大小不一致（${size}/${expectedSize}）`);
                    }
                    if (expectedSha) {
                        const digest = await sha256File(archive, signal);
                        if (digest.toLowerCase() !== expectedSha.toLowerCase()) throw new Error("节点包 SHA256 校验失败");
                    }
                }
                jobItem.status = "extracting";
                updateJob(jobItem.job);
                await extractArchive(archive, extract);
                const sourceDir = await findNodeRoot(extract);
                if (!sourceDir) throw new Error("节点包里没有找到 __init__.py");
                await fsp.mkdir(path.dirname(target), { recursive: true });
                const backup = path.join(installRoot, "backup");
                let movedBackup = false;
                if (isDir(target)) {
                    await fsp.rename(target, backup);
                    movedBackup = true;
                }
                try {
                    await fsp.rename(sourceDir, target);
                } catch (error) {
                    if (movedBackup) await fsp.rename(backup, target).catch(() => {});
                    throw error;
                }
                lock.installed = lock.installed || {};
                lock.installed[resource.id] = { version: index?.version || "", target: resource.target, size: resource.size || 0, installedAt: nowIso() };
                lock.updatedAt = nowIso();
                await saveLock();
                jobItem.status = "done";
                jobItem.bytes = resource.size || jobItem.bytes;
                await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
                return;
            } catch (error) {
                lastError = error;
                if (signal?.aborted) throw new Error("已取消");
                logger?.warn?.(`节点安装失败 ${resource.id} ← ${jobItem.source}: ${error.message}`);
            }
        }
        await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
        throw lastError || new Error("所有节点下载源均失败");
    }

    async function findConfigDir(directory, depth = 0) {
        if (depth > 2) return "";
        if (isFile(path.join(directory, "config.json"))) return directory;
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const found = await findConfigDir(path.join(directory, entry.name), depth + 1);
            if (found) return found;
        }
        return "";
    }

    // 目录型模型（如 Florence-2）以 zip 分发，解压后整体落到 models/LLM/<目录名>。
    async function installDirectoryResource(resource, jobItem, signal) {
        const root = comfyRoot();
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        const existing = resourceMatch(resource, root);
        if (existing.present) {
            jobItem.status = "skipped";
            jobItem.skipped = true;
            return;
        }
        const target = targetPath(resource, root);
        const installRoot = path.join(root, ".canvas-install", `${resource.id}-${Date.now()}`);
        const archive = path.join(installRoot, "payload.zip");
        const extract = path.join(installRoot, "extract");
        await fsp.mkdir(installRoot, { recursive: true });
        const sources = normalizeSources(resource);
        if (!sources.length) throw new Error("没有配置下载源");
        let lastError = null;
        for (const source of sources) {
            try {
                await fsp.rm(archive, { force: true });
                jobItem.status = "downloading";
                jobItem.source = source.label || (source.url ? new URL(source.url).hostname : "内置");
                jobItem.bytes = 0;
                if (source.kind === "bundled" || source.path) {
                    await copyBundledSource(source, archive, jobItem, signal);
                } else {
                    await downloadSource(source.url, archive, jobItem, signal, (bytes) => {
                        jobItem.bytes = bytes;
                        updateJob(jobItem.job);
                    });
                }
                jobItem.status = "verifying";
                if (source.verify !== false) {
                    const expectedSize = Number(source.size ?? resource.size) || 0;
                    const expectedSha = String(source.sha256 ?? resource.sha256 ?? "");
                    if (expectedSize) {
                        const size = (await fsp.stat(archive)).size;
                        if (size !== expectedSize) throw new Error(`模型包大小不一致（${size}/${expectedSize}）`);
                    }
                    if (expectedSha) {
                        const digest = await sha256File(archive, signal);
                        if (digest.toLowerCase() !== expectedSha.toLowerCase()) throw new Error("模型包 SHA256 校验失败");
                    }
                }
                jobItem.status = "extracting";
                updateJob(jobItem.job);
                await extractArchive(archive, extract);
                const sourceDir = await findConfigDir(extract);
                if (!sourceDir) throw new Error("模型包里没有找到 config.json");
                await fsp.mkdir(path.dirname(target), { recursive: true });
                const backup = path.join(installRoot, "backup");
                let movedBackup = false;
                if (isDir(target)) {
                    await fsp.rename(target, backup);
                    movedBackup = true;
                }
                try {
                    await fsp.rename(sourceDir, target);
                } catch (error) {
                    if (movedBackup) await fsp.rename(backup, target).catch(() => {});
                    throw error;
                }
                lock.installed = lock.installed || {};
                lock.installed[resource.id] = { version: index?.version || "", target: resource.target, size: resource.size || 0, installedAt: nowIso() };
                lock.updatedAt = nowIso();
                await saveLock();
                jobItem.status = "done";
                jobItem.bytes = resource.size || jobItem.bytes;
                await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
                return;
            } catch (error) {
                lastError = error;
                if (signal?.aborted) throw new Error("已取消");
                logger?.warn?.(`目录模型安装失败 ${resource.id} ← ${jobItem.source}: ${error.message}`);
            }
        }
        await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
        throw lastError || new Error("所有下载源均失败");
    }

    function pipSitePackages(python) {
        try {
            return String(
                execFileSync(python, ["-c", "import sysconfig;print(sysconfig.get_paths().get('purelib') or '')"], {
                    timeout: 10000,
                    windowsHide: true,
                    encoding: "utf8",
                }),
            ).trim();
        } catch {
            return "";
        }
    }

    function pipDistributionKey(value) {
        return String(value || "").toLowerCase().replace(/[-_.]+/g, "_");
    }

    function pipDistributionEntries(site, distribution) {
        const key = pipDistributionKey(distribution);
        if (!site || !isDir(site)) return [];
        return fs.readdirSync(site).filter((name) => name.toLowerCase().endsWith(".dist-info") && pipDistributionKey(name).startsWith(`${key}_`));
    }

    async function backupPipPackage(python, module, distribution) {
        const site = pipSitePackages(python);
        if (!site) return "";
        const packageDir = path.join(site, module);
        const distEntries = pipDistributionEntries(site, distribution);
        if (!isDir(packageDir) && !distEntries.length) return "";
        const backupDir = path.join(config.dataDir, "runtime-cache", `${module}-backup-${Date.now()}`);
        await fsp.mkdir(backupDir, { recursive: true });
        if (isDir(packageDir)) await fsp.cp(packageDir, path.join(backupDir, module), { recursive: true, force: true });
        for (const entry of distEntries) {
            await fsp.cp(path.join(site, entry), path.join(backupDir, entry), { recursive: true, force: true });
        }
        return backupDir;
    }

    async function restorePipBackup(python, module, distribution, backupDir) {
        if (!backupDir || !isDir(backupDir)) return false;
        const site = pipSitePackages(python);
        if (!site) return false;
        await fsp.rm(path.join(site, module), { recursive: true, force: true }).catch(() => {});
        for (const entry of pipDistributionEntries(site, distribution)) {
            await fsp.rm(path.join(site, entry), { recursive: true, force: true }).catch(() => {});
        }
        for (const entry of fs.readdirSync(backupDir)) {
            await fsp.cp(path.join(backupDir, entry), path.join(site, entry), { recursive: true, force: true });
        }
        return true;
    }

    async function revertPipInstall(python, module, distribution, backupDir) {
        if (backupDir) return restorePipBackup(python, module, distribution, backupDir);
        try {
            execFileSync(python, ["-m", "pip", "uninstall", "-y", distribution], {
                timeout: 60000,
                windowsHide: true,
                encoding: "utf8",
            });
        } catch {
            // 清理失败不覆盖原始安装错误。
        }
        return false;
    }

    function pipFailureHint({ resource, python, error, command = "", backupDir = "", distributionVersion = "" }) {
        const runtime = pipRuntimeFor(python);
        const distribution = String(resource?.pipName || resource?.module || resource?.label || "运行库").trim();
        const label = resource?.label || distribution;
        const lines = [
            `请在我的 ComfyUI 环境里修复「${label}」（${distribution}）。`,
            "要求：只处理这个运行库，不要升级或替换 torch、CUDA、ComfyUI 本体或其他包。",
            `环境：Python ${runtime.python || "?"} / Torch ${runtime.torch || "?"} / CUDA ${runtime.cuda || "?"}；ComfyUI Python：${python}`,
            distributionVersion ? `当前已安装版本：${distributionVersion}` : "",
            `遇到的问题：${truncate(String(error || "未知错误"), 400)}`,
            command ? `手动命令：${command}` : "",
            backupDir ? `旧包备份：${backupDir}` : "",
            "安装后验证：import sageattention；from sageattention.core import get_cuda_arch_versions；并重启 ComfyUI。",
            "如果仍然失败，请把完整报错、Python/Torch/CUDA 版本和显卡型号贴给我。",
        ];
        return lines.filter(Boolean).join("\n");
    }

    async function installPipResource(resource, jobItem, signal) {
        const root = comfyRoot();
        const python = comfyPythonForBake(root);
        if (!python) throw new Error("未找到 ComfyUI 的 Python，无法安装运行库；请先确认 ComfyUI 能正常启动");
        const module = String(resource.module || resource.importName || "").trim();
        if (!module) throw new Error("运行库资源缺少 module 字段");
        const distribution = String(resource.pipName || module).trim();
        const imported = pipImportStatus(python, module, { fresh: true, distribution });
        if (imported.present) {
            jobItem.status = "skipped";
            jobItem.skipped = true;
            return;
        }
        const installedVersion = pipDistributionVersion(python, distribution);
        const pipName = String(resource.pipName || module).trim();
        const manualCommand = `"${python}" -m pip install --no-deps ${pipName}`;
        if (installedVersion) {
            const error = new Error(`检测到已安装 ${distribution} ${installedVersion}，但无法导入。为保护环境，画布不会自动覆盖；请手动修复或交给 AI Agent。`);
            error.hint = pipFailureHint({ resource, python, error, command: manualCommand, distributionVersion: installedVersion });
            throw error;
        }
        const plan = pickPipWheel(resource, python);
        const runtimeLabel = [plan.runtime?.python ? `Python ${plan.runtime.python}` : "", plan.runtime?.torch ? `Torch ${plan.runtime.torch}` : "", plan.runtime?.cuda ? `CUDA ${plan.runtime.cuda}` : ""]
            .filter(Boolean)
            .join(" / ");
        if (!plan.url) {
            const error = new Error(
                `当前 ComfyUI 环境（${runtimeLabel || "版本未知"}）没有匹配的预编译运行库。` +
                    `画布不会自动安装或猜版本；请手动安装或交给 AI Agent。`,
            );
            error.hint = pipFailureHint({ resource, python, error, command: manualCommand, distributionVersion: installedVersion });
            throw error;
        }
        let wheel = plan.url;
        let wheelSize = plan.size || 0;
        if (plan.sha256) {
            const cacheDir = path.join(config.dataDir, "runtime-cache");
            await fsp.mkdir(cacheDir, { recursive: true });
            const fileName = decodeURIComponent(path.basename(new URL(plan.url).pathname)) || `${resource.id}.whl`;
            const cached = path.join(cacheDir, fileName);
            let valid = false;
            if (isFile(cached)) {
                const stat = fs.statSync(cached);
                valid =
                    (!plan.size || stat.size === plan.size) &&
                    (await sha256File(cached, signal)).toLowerCase() === plan.sha256.toLowerCase();
            }
            if (!valid) {
                jobItem.status = "downloading";
                jobItem.source = "Python 运行库";
                const response = await fetch(plan.url, { signal });
                if (!response.ok) throw new Error(`运行库下载失败：HTTP ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                if (signal?.aborted) throw new Error("已取消");
                if (plan.size && buffer.length !== plan.size) throw new Error(`运行库大小不一致（${buffer.length}/${plan.size}）`);
                const digest = crypto.createHash("sha256").update(buffer).digest("hex");
                if (digest.toLowerCase() !== plan.sha256.toLowerCase()) throw new Error("运行库 SHA256 校验失败");
                await fsp.writeFile(cached, buffer);
                wheelSize = buffer.length;
            } else {
                wheelSize = fs.statSync(cached).size;
            }
            wheel = cached;
        }
        const backupDir = Array.isArray(resource.wheelMatrix) ? await backupPipPackage(python, module, distribution) : "";
        const forceReinstall = Array.isArray(resource.wheelMatrix);
        const installCommand = `"${python}" -m pip install --no-deps ${forceReinstall ? "--force-reinstall " : ""}"${wheel}"`;
        jobItem.status = "installing";
        jobItem.source = "Python 运行库";
        jobItem.size = wheelSize || jobItem.size;
        const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
        if (forceReinstall) pipArgs.push("--force-reinstall", "--no-deps");
        pipArgs.push(wheel);
        try {
            await new Promise((resolve, reject) => {
                const child = spawn(python, pipArgs, {
                    windowsHide: true,
                    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
                });
                jobItem.child = child;
                let output = "";
                const onData = (data) => {
                    output += String(data);
                    if (output.length > 4000) output = output.slice(-4000);
                    logger?.info?.(`[pip] ${String(data).trim()}`);
                };
                child.stdout.on("data", onData);
                child.stderr.on("data", onData);
                child.on("error", reject);
                child.on("exit", (code) => {
                    jobItem.child = null;
                    if (signal?.aborted) return reject(new Error("已取消"));
                    if (code !== 0) return reject(new Error(`运行库安装失败（exit ${code}）${output ? `：${truncate(output, 400)}` : ""}`));
                    resolve();
                });
            });
        } catch (error) {
            await revertPipInstall(python, module, distribution, backupDir);
            pipCheckCache.delete(`${python}|${module}`.toLowerCase());
            error.hint = error.hint || pipFailureHint({ resource, python, error, command: installCommand, backupDir });
            throw error;
        }
        pipCheckCache.delete(`${python}|${module}`.toLowerCase());
        const recheck = pipImportStatus(python, module, { fresh: true, distribution });
        if (!recheck.present) {
            const error = new Error(`运行库安装后仍无法导入 ${module}：${recheck.reason || "未知原因"}`);
            await revertPipInstall(python, module, distribution, backupDir);
            error.hint = pipFailureHint({ resource, python, error, command: installCommand, backupDir });
            throw error;
        }
        if (module === "sageattention") {
            try {
                execFileSync(python, ["-c", "from sageattention.core import get_cuda_arch_versions as g;print(','.join(g()))"], {
                    timeout: 30000,
                    windowsHide: true,
                    encoding: "utf8",
                });
            } catch (cause) {
                const error = new Error(`SageAttention 安装后仍不可用：${truncate(String(cause?.stderr || cause?.message || cause), 300)}`);
                await revertPipInstall(python, module, distribution, backupDir);
                error.hint = pipFailureHint({ resource, python, error, command: installCommand, backupDir });
                throw error;
            }
        }
        lock.installed = lock.installed || {};
        lock.installed[resource.id] = { version: index?.version || "", target: resource.target, size: resource.size || 0, installedAt: nowIso() };
        lock.updatedAt = nowIso();
        await saveLock();
        jobItem.bytes = jobItem.size;
        if (resource.restartAfterInstall) {
            jobItem.restartRequired = true;
            const control = String(config.launcherControlUrl || "").replace(/\/+$/, "");
            if (control) {
                jobItem.status = "installing";
                jobItem.message = "正在重启 ComfyUI…";
                updateJob(jobItem.job);
                try {
                    const response = await fetch(`${control}/restart-comfy`, {
                        method: "POST",
                        signal: AbortSignal.timeout(360000),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    jobItem.restarted = true;
                } catch (cause) {
                    jobItem.restartError = truncate(cause?.message || String(cause), 200);
                    jobItem.hint = `运行库已安装，但自动重启 ComfyUI 失败：${jobItem.restartError}。请手动关闭并重新启动 start-local.bat，或把下面这段发给你的 AI Agent：\n请在我的 Windows 机器上重启 ComfyUI（安装目录 ${comfyRoot()}），检查 launcher.log 里的错误；不要重装 SageAttention。`;
                }
            } else {
                jobItem.message = "安装完成，请手动重启 ComfyUI";
            }
        }
        jobItem.status = "done";
    }

    async function runBake(resource, jobItem, signal) {
        const root = comfyRoot();
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        const python = comfyPythonForBake(root);
        if (!python) throw new Error("未找到 ComfyUI 的 Python");
        const target = targetPath(resource, root);
        const h3Trt = resource.builder?.kind === "h3-trt-vae";
        if (!h3Trt) throw new Error("不支持的本地编译类型");
        // 先写 .part，成功后再改名；避免取消或磁盘写满留下被当成已装的半成品 engine
        const bakeOutput = `${target}.part`;
        let args;
        let trtInput = "";
        let trtCompiler = "";
        const script = path.join(config.rootDir, "scripts", "build-h3-trt-vae.py");
        if (!isFile(script)) throw new Error("缺少编译脚本 scripts/build-h3-trt-vae.py");
        const inputResource = resourceById(resource.builder?.input || resource.requires?.[0]);
        if (!inputResource) throw new Error("TRT 编译缺少 ONNX 输入资源");
        const input = existingPath(inputResource, root);
        if (!input) throw new Error("TRT 编译依赖的 ONNX 尚未就绪");
        const compiler = path.join(root, "custom_nodes", "ComfyUI-H3VAE_TRT", "compile.py");
        if (!isFile(compiler)) throw new Error("缺少 ComfyUI-H3VAE_TRT/compile.py，请先安装 H3 TRT VAE 节点");
        trtInput = input;
        trtCompiler = compiler;
        args = [script, "--compiler", compiler, "--input", input, "--output", bakeOutput, "--device", String(resource.builder?.device ?? 0)];
        jobItem.status = "baking";
        jobItem.source = "本机编译 TRT Engine";
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rm(bakeOutput, { force: true }).catch(() => {});
        try {
            await new Promise((resolve, reject) => {
                const child = spawn(python, args, { cwd: config.rootDir, windowsHide: true });
                jobItem.child = child;
                let stderr = "";
                child.stdout.on("data", (data) => logger?.info?.(`[bake] ${String(data).trim()}`));
                child.stderr.on("data", (data) => {
                    stderr += String(data);
                    if (stderr.length > 4000) stderr = stderr.slice(-4000);
                });
                child.on("error", reject);
                child.on("exit", (code) => {
                    jobItem.child = null;
                    if (signal?.aborted) return reject(new Error("已取消"));
                    if (code !== 0 || !isFile(bakeOutput)) return reject(new Error(`烘焙失败（exit ${code}）${stderr ? `：${truncate(stderr, 500)}` : ""}`));
                    resolve();
                });
            });
            await fsp.rename(bakeOutput, target);
        } catch (error) {
            await fsp.rm(bakeOutput, { force: true }).catch(() => {});
            if (!signal?.aborted) {
                error.hint = buildTrtCompileHint({ python, compiler: trtCompiler, input: trtInput, output: target, device: resource.builder?.device ?? 0 });
            }
            throw error;
        }
        lock.installed = lock.installed || {};
        lock.installed[resource.id] = { version: index?.version || "", target: resource.target, size: resource.size || 0, installedAt: nowIso(), baked: true };
        lock.updatedAt = nowIso();
        await saveLock();
        jobItem.status = "done";
        jobItem.bytes = jobItem.size;
    }

    async function runJob(job) {
        const jobsToRun = job.items.filter((item) => item.status === "queued");
        const downloads = jobsToRun.filter((item) => !["bake", "node", "dir", "pip"].includes(item.type));
        const nodeJobs = jobsToRun.filter((item) => item.type === "node");
        const dirJobs = jobsToRun.filter((item) => item.type === "dir");
        const pipJobs = jobsToRun.filter((item) => item.type === "pip");
        const bakes = jobsToRun.filter((item) => item.type === "bake");
        const limit = Math.max(1, Number(config.resourceConcurrency) || 2);
        const queue = [...downloads];
        const worker = async () => {
            while (queue.length && job.status === "running") {
                const item = queue.shift();
                if (!item || item.status !== "queued") continue;
                const controller = new AbortController();
                item.job = job;
                job.controllers.set(item.id, controller);
                try {
                    const resource = resourceById(item.id);
                    await downloadResource(resource, item, controller.signal);
                } catch (error) {
                    item.status = "error";
                    item.error = truncate(error.message || String(error), 500);
                    logger?.warn?.(`资源安装失败 ${item.id}: ${item.error}`);
                } finally {
                    job.controllers.delete(item.id);
                    updateJob(job);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
        for (const item of nodeJobs) {
            if (job.status !== "running") break;
            const controller = new AbortController();
            item.job = job;
            job.controllers.set(item.id, controller);
            try {
                await installNode(resourceById(item.id), item, controller.signal);
            } catch (error) {
                item.status = "error";
                item.error = truncate(error.message || String(error), 500);
                logger?.warn?.(`节点安装失败 ${item.id}: ${item.error}`);
            } finally {
                job.controllers.delete(item.id);
                updateJob(job);
            }
        }
        for (const item of pipJobs) {
            if (job.status !== "running") break;
            const controller = new AbortController();
            item.job = job;
            job.controllers.set(item.id, controller);
            try {
                await installPipResource(resourceById(item.id), item, controller.signal);
            } catch (error) {
                item.status = "error";
                item.error = truncate(error.message || String(error), 500);
                if (error.hint) {
                    item.hint = error.hint;
                } else {
                    const resource = resourceById(item.id);
                    const python = comfyPythonForBake(comfyRoot());
                    item.hint = pipFailureHint({
                        resource,
                        python,
                        error: item.error,
                        command: `"${python || "python"}" -m pip install --no-deps ${resource?.pipName || resource?.module || item.id}`,
                    });
                }
                logger?.warn?.(`运行库安装失败 ${item.id}: ${item.error}`);
            } finally {
                job.controllers.delete(item.id);
                updateJob(job);
            }
        }
        for (const item of dirJobs) {
            if (job.status !== "running") break;
            const controller = new AbortController();
            item.job = job;
            job.controllers.set(item.id, controller);
            try {
                await installDirectoryResource(resourceById(item.id), item, controller.signal);
            } catch (error) {
                item.status = "error";
                item.error = truncate(error.message || String(error), 500);
                logger?.warn?.(`目录模型安装失败 ${item.id}: ${item.error}`);
            } finally {
                job.controllers.delete(item.id);
                updateJob(job);
            }
        }
        for (const item of bakes) {
            if (job.status !== "running") break;
            const controller = new AbortController();
            job.controllers.set(item.id, controller);
            try {
                const resource = resourceById(item.id);
                await runBake(resource, item, controller.signal);
            } catch (error) {
                item.status = "error";
                item.error = truncate(error.message || String(error), 500);
                if (error.hint) item.hint = error.hint;
                logger?.warn?.(`资源烘焙失败 ${item.id}: ${item.error}`);
            } finally {
                job.controllers.delete(item.id);
                updateJob(job);
            }
        }
        inventoryCache.clear();
        clearExtraModelPathsCache();
        if (job.status === "running") {
            const failed = job.items.filter((item) => item.status === "error").length;
            const hinted = job.items.some((item) => item.status === "error" && item.hint);
            job.status = failed ? "error" : "done";
            job.message = failed
                ? hinted
                    ? `${failed} 项失败，其中本机编译失败，请按提示交给 AI Agent 处理`
                    : `${failed} 项失败，请查看日志或用备用源重试`
                : "资源已就绪";
            job.error = failed ? "部分资源安装失败" : "";
        }
        updateJob(job);
        try {
            runtimeStatusCache.clear();
            await setup?.scan?.();
        } catch (error) {
            logger?.warn?.(`资源安装后重新扫描失败：${error.message}`);
        }
    }

    let activeJob = null;

    function install({ ids = [], packs = [] } = {}) {
        if (!index) throw new Error("资源索引尚未加载");
        // 双标签/双击同时安装会互相覆盖 .part 和锁文件，这里只允许一个安装任务。
        if (activeJob && activeJob.status === "running") {
            throw new Error(`已有安装任务在进行中（${activeJob.items.filter((item) => item.status !== "done").length} 项未完成），请等待完成或先终止`);
        }
        const selected = selectResources({ ids, packs });
        const root = comfyRoot();
        const missing = [];
        for (const resource of selected) {
            const statusItem = resourceStatus(resource, root);
            if (statusItem.status === "present") continue;
            if (resource.type === "bake" && statusItem.status === "blocked") {
                // Dependencies are added by selectResources; keep the bake queued.
            }
            missing.push(resource);
        }
        const job = {
            id: `res_${crypto.randomBytes(6).toString("hex")}`,
            status: "running",
            message: missing.length ? "安装中" : "资源已齐全",
            createdAt: nowIso(),
            updatedAt: nowIso(),
            items: missing.map((resource) => ({
                id: resource.id,
                label: resource.label || resource.id,
                type: resource.type || "model",
                status: "queued",
                bytes: 0,
                size: Number(resource.size) || 0,
                source: null,
                error: "",
                skipped: false,
            })),
            controllers: new Map(),
            error: "",
        };
        updateJob(job);
        if (!missing.length) {
            job.status = "done";
            job.message = "资源已齐全";
            updateJob(job);
            return jobSnapshot(job);
        }
        activeJob = job;
        void runJob(job)
            .catch((error) => {
                job.status = "error";
                job.error = truncate(error.message || String(error), 500);
                updateJob(job);
            })
            .finally(() => {
                if (activeJob === job) activeJob = null;
            });
        return jobSnapshot(job);
    }

    function getJob(id) {
        const job = jobs.get(String(id || ""));
        return job ? jobSnapshot(job) : null;
    }

    function cancelJob(id) {
        const job = jobs.get(String(id || ""));
        if (!job) return null;
        if (job.status !== "running") return jobSnapshot(job);
        job.status = "canceled";
        job.message = "已取消";
        for (const controller of job.controllers.values()) controller.abort(new Error("用户取消"));
        for (const item of job.items) {
            if (item.child) killChildTree(item.child);
            if (["queued", "downloading", "verifying", "baking"].includes(item.status)) item.status = "error", item.error = "已取消";
        }
        updateJob(job);
        return jobSnapshot(job);
    }

    async function refresh() {
        inventoryCache.clear();
        clearExtraModelPathsCache();
        if (!hardwareOverride) hardware = await probeHardware();
        await loadIndex({ forceRemote: true });
        try {
            runtimeStatusCache.clear();
            await setup?.scan?.();
        } catch (error) {
            logger?.warn?.(`资源刷新扫描失败：${error.message}`);
        }
        return status();
    }

    async function pruneMainModels() {
        if (!mainModels?.snapshot) return;
        const installed = new Set(Array.isArray(setup?.loaderOptions?.()?.UNETLoader) ? setup.loaderOptions().UNETLoader : []);
        const snapshot = mainModels.snapshot();
        for (const pack of index?.packs || []) {
            const stored = snapshot?.[pack.id];
            const file = String(stored?.file || "");
            if (!file) continue;
            const info = mainModelInfo(pack, installed);
            if (!info) continue;
            const current = Array.isArray(stored.workflows) ? stored.workflows : [];
            const same = current.length === info.workflowIds.length && current.every((id) => info.workflowIds.includes(id));
            if (!same) await mainModels.set(pack.id, { file, workflows: info.workflowIds });
        }
    }

    async function init() {
        if (!hardwareOverride) hardware = await probeHardware();
        await loadLock();
        await loadIndex();
        try {
            await pruneMainModels();
        } catch (error) {
            logger?.warn?.(`主模型覆盖范围校正失败：${error.message}`);
        }
        return status();
    }

    function invalidate() {
        inventoryCache.clear();
        clearExtraModelPathsCache();
        runtimeStatusCache.clear();
    }

    return { init, status, refresh, install, setMainModel, setResourceReplacement, pickResourceReplacement, getJob, cancelJob, invalidate, runtimeProblemsFor, comfyRoot, comfyPython, indexPath };
}
