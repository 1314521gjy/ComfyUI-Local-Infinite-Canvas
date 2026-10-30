import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { detectComfyLayout, loadDirectorySettings, normalizeDirectorySettings, writeManagedExtraPaths } from "./directories.js";
import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { findSimilarModel } from "./model-match.js";
import { MODEL_LOADER_SPECS as LOADER_SPECS, discoverModelLoaderSpecs } from "./model-loaders.js";
import { MODEL_DIR_KEYS, collectModelRoots, modelRelativePath } from "./model-paths.js";
import { nowIso, truncate, writeJsonAtomic } from "./util.js";

function safeStat(file) {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

const execFileAsync = promisify(execFile);

function normalizeAliasValue(value) {
    return String(value || "").replace(/\\/g, "/");
}

function normalizeBaseName(value) {
    const normalized = String(value || "").replace(/\\/g, "/");
    return (normalized.split("/").pop() || "").trim().toLowerCase();
}

function isModelOption(value) {
    return typeof value === "string" && Boolean(value.trim()) && !value.trim().startsWith("<");
}

function modelAliasKey(classType, input, from) {
    return `${classType}\u0000${input}\u0000${normalizeAliasValue(from)}`;
}

function readAliasFile(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        return parsed?.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {};
    } catch {
        return {};
    }
}

export function createSetupManager({ config, registry, comfy, logger, mainModelFile = () => "", onScanComplete = null } = {}) {
    const statusFile = path.join(config.dataDir, "setup-status.json");
    const aliasFile = path.join(config.dataDir, "model-aliases.json");
    let aliases = readAliasFile(aliasFile);
    const originalComfyDir = config.comfyDir || "";
    const originalWorkflowsDir = config.comfyWorkflowsDir || "";
    let directorySettings = loadDirectorySettings(config.dataDir);
    const autoAliases = new Map();
    const availability = new Map();
    const comfyFileCache = new Map();
    const importedComfyPaths = new Set();
    const state = {
        phase: "idle",
        comfyUrl: config.comfyUrl,
        comfyReachable: false,
        scanStartedAt: null,
        scannedAt: null,
        scanDurationMs: 0,
        lastError: null,
        counts: { available: 0, unavailable: 0, total: 0 },
        workflows: [],
        loras: [],
        missing: { models: [], nodes: [], uiWorkflows: 0, uiSamples: [] },
    };
    let scanPromise = null;
    let hasScanned = false;
    let watcher = null;
    let poller = null;
    let debounceTimer = null;
    let connectivityTimer = null;
    let connectivityChecking = false;
    let lastAutoScanAt = 0;
    let lastComfyBase = "";
    let loaderCatalog = {};
    let folderPathCatalog = {};
    let nodeClasses = new Set();
    let currentLoaderSpecs = LOADER_SPECS;
    let runtimeProblemProvider = null;
    const fuzzyAliasLogged = new Set();

    function applyDirectorySettings(input, { restoreAuto = true } = {}) {
        directorySettings = normalizeDirectorySettings(input);
        if (directorySettings.mode === "manual" && directorySettings.comfyDir) {
            config.comfyDir = directorySettings.comfyDir;
            const layout = detectComfyLayout(directorySettings.comfyDir);
            // 手动目录下没有 user/default/workflows 时不要再沿用旧树的用户工作流。
            config.comfyWorkflowsDir = layout?.workflowsDir || "";
        } else if (restoreAuto) {
            config.comfyDir = originalComfyDir;
            config.comfyWorkflowsDir = originalWorkflowsDir;
        }
        return directorySettings;
    }

    applyDirectorySettings(directorySettings);

    async function persist() {
        try {
            await writeJsonAtomic(statusFile, state);
        } catch (error) {
            logger?.warn?.(`保存 setup 状态失败：${error.message}`);
        }
    }

    function schedule(delay = config.scanDebounceMs || 800) {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void scan().catch((error) => logger?.warn?.(`后台扫描失败：${error.message}`));
        }, delay);
        if (typeof debounceTimer.unref === "function") debounceTimer.unref();
    }

    async function importComfyWorkflows() {
        if (!config.comfyWorkflowsDir || !fs.existsSync(config.comfyWorkflowsDir)) return { imported: 0, ui: 0, samples: [] };
        const comfyRoot = path.resolve(config.comfyWorkflowsDir);
        const importedComfyNames = new Set();
        const seenContent = new Map();
        // 有 source.path 的是自动导入/复制进 registry 的条目；官方条目 source 为空。
        // 官方条目优先保留，副本按内容去重，只移除 registry 登记，不删用户文件。
        const isAutoImport = (internal) => Boolean(internal?.source?.path);
        // 同一份 ComfyUI 工作流被保存成 image-2/image-2-2-2 时只保留一条；
        // 官方 workflow 优先，自动导入的重复副本只移除 registry 登记，不删用户文件。
        const existing = registry.list()
            .map((entry) => ({ entry, internal: registry.resolve(entry.id) }))
            .filter((item) => item.internal?.workflow);
        existing.sort((a, b) => Number(isAutoImport(a.internal)) - Number(isAutoImport(b.internal)));
        let removed = 0;
        const duplicateIds = [];
        for (const { entry, internal } of existing) {
            const key = JSON.stringify(internal.workflow);
            if (isAutoImport(internal) && seenContent.has(key)) {
                duplicateIds.push(entry.id);
                continue;
            }
            if (!seenContent.has(key)) seenContent.set(key, entry.id);
            const sourcePath = internal.source?.path;
            if (sourcePath) importedComfyPaths.add(path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(comfyRoot, sourcePath));
            if (internal.source?.kind === "comfyui" && internal.source.name) importedComfyNames.add(path.basename(String(internal.source.name)));
        }
        for (const id of duplicateIds) {
            await registry.remove(id);
            removed += 1;
        }
        const entries = await fsp.readdir(config.comfyWorkflowsDir);
        let imported = 0;
        let ui = 0;
        const samples = [];
        for (const name of entries) {
            if (!name.toLowerCase().endsWith(".json")) continue;
            // 草稿/测试/副本工作流不该出现在画布的模型列表里。
            if (isSkippedComfyWorkflow(name)) continue;
            if (importedComfyNames.has(path.basename(name))) continue;
            const file = path.join(config.comfyWorkflowsDir, name);
            const stat = safeStat(file);
            if (!stat?.isFile()) continue;
            const signature = `${stat.mtimeMs}:${stat.size}`;
            const cached = comfyFileCache.get(file);
            if (cached?.signature === signature) {
                if (cached.kind === "ui") ui += 1;
                continue;
            }
            try {
                const text = (await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "");
                if (Buffer.byteLength(text) > config.maxWorkflowBytes) {
                    comfyFileCache.set(file, { signature, kind: "too_large" });
                    continue;
                }
                const workflow = JSON.parse(text);
                if (isUiWorkflow(workflow)) {
                    comfyFileCache.set(file, { signature, kind: "ui" });
                    ui += 1;
                    if (samples.length < 5) samples.push(name);
                    continue;
                }
                if (!isApiWorkflow(workflow)) {
                    comfyFileCache.set(file, { signature, kind: "invalid" });
                    continue;
                }
                comfyFileCache.set(file, { signature, kind: "api" });
                if (importedComfyPaths.has(file)) continue;
                const contentKey = JSON.stringify(workflow);
                if (seenContent.has(contentKey)) {
                    importedComfyPaths.add(file);
                    continue;
                }
                try {
                    const result = await registry.importWorkflow({
                        path: file,
                        name: path.basename(name, ".json"),
                        overwrite: false,
                    });
                    importedComfyPaths.add(file);
                    seenContent.set(contentKey, result.workflow.id);
                    imported += 1;
                } catch (error) {
                    logger?.warn?.(`自动导入 ComfyUI 工作流失败 ${name}: ${error.message}`);
                }
            } catch (error) {
                comfyFileCache.set(file, { signature, kind: "error" });
                logger?.warn?.(`读取 ComfyUI 工作流失败 ${name}: ${error.message}`);
            }
        }
        // 之前版本已经把草稿导进 registry 的，这里顺手清掉（只移除登记，不动用户文件）。
        const comfyRootPrefix = path.resolve(config.comfyWorkflowsDir) + path.sep;
        for (const entry of registry.list()) {
            const internal = registry.resolve(entry.id);
            const sourcePath = internal?.source?.path || entry.source?.path;
            if (!sourcePath) continue;
            const absolute = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(config.comfyWorkflowsDir, sourcePath);
            if (!absolute.startsWith(comfyRootPrefix)) continue;
            if (!isSkippedComfyWorkflow(path.basename(absolute))) continue;
            if (await registry.remove(entry.id)) removed += 1;
        }
        return { imported, ui, samples, removed };
    }

    function isSkippedComfyWorkflow(name) {
        const base = path.basename(String(name || ""), path.extname(String(name || "")));
        return /(?:^|[-_.\s])(draft|test|tmp|temp|copy|bak|backup|副本|测试)(?:[-_.\s]?\d+)?$/i.test(base) || /^(draft|test|tmp|temp)[-_.\s]/i.test(base);
    }

    function collectLoaderOptions(objectInfo, specs = LOADER_SPECS) {
        const loaders = new Map();
        for (const spec of specs) {
            const definition = objectInfo?.[spec.classType]?.input?.required?.[spec.input];
            // 旧版 object_info 把选项放在 [0]，新版 COMBO 放在 ["COMBO", { options }]。
            const options = Array.isArray(definition?.[0]) ? definition[0] : Array.isArray(definition?.[1]?.options) ? definition[1].options : null;
            if (Array.isArray(options)) loaders.set(`${spec.classType}\u0000${spec.input}`, { ...spec, options: new Set(options) });
        }
        return loaders;
    }

    function loaderOptionsFor(classType, input = "") {
        const keyed = input ? loaderCatalog?.[`${classType}\u0000${input}`] : null;
        const list = Array.isArray(keyed) ? keyed : loaderCatalog?.[classType];
        return Array.isArray(list) ? list : [];
    }

    // 同 basename、不同子目录/路径的文件是同一个模型，可自动认；
    // 同名文件出现多份时不自动选，留给用户确认。
    function rebuildAutoAliases() {
        autoAliases.clear();
        for (const spec of currentLoaderSpecs) {
            const options = loaderOptionsFor(spec.classType, spec.input);
            if (!options.length) continue;
            const byBase = new Map();
            for (const option of options) {
                if (!isModelOption(option)) continue;
                const base = normalizeBaseName(option);
                const list = byBase.get(base) || [];
                list.push(option);
                byBase.set(base, list);
            }
            const map = new Map();
            for (const [base, list] of byBase) {
                if (list.length === 1) map.set(base, list[0]);
            }
            autoAliases.set(`${spec.classType}\u0000${spec.input}`, map);
        }
    }

    function modelRootsForDir(dir) {
        return collectModelRoots({ dir, folderPaths: folderPathCatalog, comfyDir: config.comfyDir });
    }

    const modelInventory = new Map();

    function listModelFilesForRoot(root) {
        const key = String(root || "").toLowerCase();
        const cached = modelInventory.get(key);
        if (cached && Date.now() - cached.at < 60000) return cached.files;
        const files = [];
        const stack = [{ dir: root, depth: 0 }];
        while (stack.length && files.length < 5000) {
            const current = stack.pop();
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
                    if (current.depth < 6) stack.push({ dir: full, depth: current.depth + 1 });
                    continue;
                }
                if (!entry.isFile() || !/\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i.test(entry.name)) continue;
                files.push(path.relative(root, full).split(path.sep).join("/"));
                if (files.length >= 5000) break;
            }
        }
        modelInventory.set(key, { at: Date.now(), files });
        return files;
    }

    // ComfyUI 未把文件列进 /object_info，但磁盘上已经有同名/相似模型：
    // 不是“缺模型”，而是需要重启 ComfyUI 重新加载。
    function pendingModelFile(classType, input, value) {
        const spec = currentLoaderSpecs.find((item) => item.classType === classType && item.input === input);
        if (!spec || !(spec.dirs || []).length) return null;
        for (const dir of spec.dirs) {
            for (const root of modelRootsForDir(dir)) {
                const similar = findSimilarModel(value, listModelFilesForRoot(root));
                if (similar.file) return { file: similar.file, score: similar.score, dir };
            }
        }
        return null;
    }

    function findInstalledOption(classType, value, input = "") {
        const normalized = normalizeAliasValue(value).toLowerCase();
        return loaderOptionsFor(classType, input).find((item) => isModelOption(item) && normalizeAliasValue(item).toLowerCase() === normalized) || "";
    }

    function aliasTargetExists(classType, value, input = "") {
        if (findInstalledOption(classType, value, input)) return true;
        const normalized = normalizeAliasValue(value);
        if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) return false;
        const spec = currentLoaderSpecs.find((item) => item.classType === classType && (!input || item.input === input));
        if (!spec || !(spec.dirs || []).length) return false;
        return (spec.dirs || []).some((dir) => modelRootsForDir(dir).some((root) => safeStat(path.join(root, normalized))?.isFile()));
    }

    // 只返回用户显式点过「自选替换」的别名；资源卡用它判断“已用自选”，
    // 自动/相似匹配不能伪造这个状态。
    function userModelAliasFor(classType, input, value) {
        if (!value) return "";
        const user = aliases[modelAliasKey(classType, input, value)] || "";
        if (!user) return "";
        // 只有 ComfyUI 当前 loader 列表里真有的文件才算生效；
        // 仅磁盘存在但未加载的文件交给 pendingModelFile 标“待重启”，不能伪造可用。
        return findInstalledOption(classType, user, input);
    }

    function modelAliasFor(classType, input, value) {
        if (!value) return "";
        // 用户显式「自选替换」优先：相似匹配只是没自选时的自动兜底，
        // 否则资源卡显示“已替换”，实际出图却仍走相似模型。
        const user = userModelAliasFor(classType, input, value);
        if (user) return user;
        // 原文件已经在 ComfyUI 列表里时绝不能再自动相似匹配；否则同族不同规格
        // （4B/8B、turbo/raw）会被互相顶替，工作流可能显示可用但运行时必崩。
        const installed = findInstalledOption(classType, value, input);
        if (installed) return installed === value ? "" : installed;
        const auto = autoAliases.get(`${classType}\u0000${input}`)?.get(normalizeBaseName(value)) || "";
        if (auto && normalizeAliasValue(auto) !== normalizeAliasValue(value)) return auto;
        // 模型放在更深子目录时，ComfyUI 的选项带路径前缀（a/b/x.safetensors）；
        // 唯一后缀匹配视为同一文件，避免“放深一层就检测不到”。
        const wanted = normalizeAliasValue(value).toLowerCase();
        const deep = loaderOptionsFor(classType, input).filter((item) => {
            if (!isModelOption(item)) return false;
            const normalized = normalizeAliasValue(item).toLowerCase();
            return normalized !== wanted && normalized.endsWith(`/${wanted}`);
        });
        if (deep.length === 1) return deep[0];
        // 格式相同、名称相似度 ≥50% 的同类模型（不同量化/版本）自动认；
        // 两个候选分数接近时不猜，留给资源卡「自选替换」。
        const similar = findSimilarModel(value, loaderOptionsFor(classType, input).filter(isModelOption));
        if (similar.file) {
            const key = `${classType}|${value}|${similar.file}`;
            if (!fuzzyAliasLogged.has(key)) {
                fuzzyAliasLogged.add(key);
                logger?.info?.(`模型相似匹配：${value} → ${similar.file}（${Math.round(similar.score * 100)}%）`);
            }
            return similar.file;
        }
        return "";
    }

    function modelCandidates(classType, value, input = "") {
        const base = normalizeBaseName(value);
        return loaderOptionsFor(classType, input)
            .filter((item) => isModelOption(item) && normalizeAliasValue(item) !== normalizeAliasValue(value))
            .sort((a, b) => {
                const aSame = normalizeBaseName(a) === base ? 0 : 1;
                const bSame = normalizeBaseName(b) === base ? 0 : 1;
                return aSame - bSame || a.localeCompare(b);
            });
    }

    async function setModelAliases(entries = []) {
        for (const entry of entries) {
            const classType = String(entry?.classType || "");
            const input = String(entry?.input || "");
            const spec = currentLoaderSpecs.find((item) => item.classType === classType && item.input === input);
            // 动态发现的第三方 loader 没有静态目录信息，但只要能枚举出模型文件就允许设别名。
            if (!spec && !loaderOptionsFor(classType, input).length) throw new Error("不支持的模型输入");
            const source = String(entry?.from || "").trim();
            if (!source) throw new Error("缺少原模型名");
            const target = String(entry?.to || "").trim();
            const key = modelAliasKey(classType, input, source);
            if (!target || normalizeAliasValue(target) === normalizeAliasValue(source)) {
                delete aliases[key];
                continue;
            }
            const actual = findInstalledOption(classType, target, input);
            if (actual) {
                aliases[key] = actual;
                continue;
            }
            if (aliasTargetExists(classType, target, input)) {
                aliases[key] = normalizeAliasValue(target);
                continue;
            }
            throw new Error(`所选模型尚未安装或不在 ComfyUI 列表中：${target}`);
        }
        await writeJsonAtomic(aliasFile, { version: 1, aliases, updatedAt: nowIso() });
        await scan();
        return state;
    }

    async function setModelAlias(entry) {
        return setModelAliases([entry]);
    }

    const MODEL_FILE_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|engine)$/i;

    // ComfyUI 常把 models/unet 放在 diffusion_models 前面但为空；优先选真正有内容的目录。
    function preferredModelRoot(roots) {
        for (const root of roots) {
            try {
                const names = fs.readdirSync(root, { withFileTypes: true });
                if (names.some((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || MODEL_FILE_EXTENSIONS.test(entry.name)))) return root;
            } catch {
                // 读不到就试下一个根目录。
            }
        }
        return roots[0];
    }

    async function pickModelFile({ dir } = {}) {
        if (!dir || !MODEL_DIR_KEYS[dir]) throw new Error("不支持的模型目录");
        const roots = modelRootsForDir(dir).filter((root) => safeStat(root)?.isDirectory());
        if (!roots.length) throw new Error("未找到 ComfyUI 的模型目录");
        const initial = preferredModelRoot(roots);
        const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
        const foregroundType = [
            'Add-Type @"',
            "using System;",
            "using System.Runtime.InteropServices;",
            "public class Win32Foreground {",
            '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
            '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);',
            '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);',
            '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
            '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
            '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
            '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
            "  public static void Force(IntPtr hWnd) {",
            "    if (hWnd == IntPtr.Zero) return;",
            "    IntPtr fg = GetForegroundWindow();",
            "    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);",
            "    uint myThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);",
            "    bool attached = false;",
            "    if (fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);",
            "    ShowWindow(hWnd, 9);",
            "    BringWindowToTop(hWnd);",
            "    SetForegroundWindow(hWnd);",
            "    if (attached) AttachThreadInput(fgThread, myThread, false);",
            "  }",
            "}",
            '"@',
        ].join("\n");
        const script = [
            "Add-Type -AssemblyName System.Windows.Forms",
            "Add-Type -AssemblyName System.Drawing",
            foregroundType,
            "$d = New-Object System.Windows.Forms.OpenFileDialog",
            "$d.Title = '选择模型文件'",
            `$d.InitialDirectory = ${quote(initial)}`,
            `$d.Filter = ${quote("模型文件|*.safetensors;*.sft;*.ckpt;*.pt;*.pth;*.bin;*.gguf;*.onnx;*.engine|所有文件|*.*")}`,
            "$d.Multiselect = $false",
            "$d.CheckFileExists = $true",
            "$d.CheckPathExists = $true",
            "$d.DereferenceLinks = $true",
            "$d.RestoreDirectory = $true",
            // 用置顶的极小宿主窗口，保证文件框从浏览器后面弹到最前面；
            // 网关是后台进程，拿不到前台权，还要 AttachThreadInput 强拉一次。
            "$owner = New-Object System.Windows.Forms.Form",
            "$owner.TopMost = $true",
            "$owner.ShowInTaskbar = $false",
            "$owner.FormBorderStyle = 'None'",
            "$owner.StartPosition = 'Manual'",
            "$owner.Location = New-Object System.Drawing.Point(-3000, -3000)",
            "$owner.Size = New-Object System.Drawing.Size(1, 1)",
            "$owner.Show()",
            "$owner.Activate()",
            "$script:tries = 0",
            "$timer = New-Object System.Windows.Forms.Timer",
            "$timer.Interval = 250",
            "$timer.Add_Tick({ $script:tries++; $h = [Win32Foreground]::FindWindow('#32770', '选择模型文件'); if ($h -ne [IntPtr]::Zero) { [Win32Foreground]::Force($h); $timer.Stop() } elseif ($script:tries -gt 40) { $timer.Stop() } })",
            "$timer.Start()",
            "$result = $d.ShowDialog($owner)",
            "$timer.Stop()",
            "$owner.Close()",
            // 控制台输出编码会按系统代码页走，中文路径会被读成 "?"；改用 UTF-8 Base64 回传。
            "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.FileName))) }",
        ].join("; ");
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        // -EncodedCommand 用 UTF-16LE，避免含中文的模型路径在不同控制台编码下丢失。
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        const { stdout } = await execFileAsync(powershell, ["-STA", "-NoProfile", "-EncodedCommand", encoded], {
            timeout: 300000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const encodedPath = String(stdout || "").trim();
        const selected = encodedPath ? Buffer.from(encodedPath, "base64").toString("utf8") : "";
        if (!selected) return null;
        const picked = modelRelativePath(roots, selected);
        if (!picked) {
            throw new Error(`所选文件不在 ComfyUI 的模型目录中，ComfyUI 看不到它。当前可用目录：${roots.join("、")}`);
        }
        return picked;
    }

    // VAE / CLIP / 文本编码器 / LoRA 等文件名里也常带底模家族名，
    // 以前用 filter 子串任意命中就算“底模存在”，会拿错架构的组件顶替。
    const NON_BASE_MODEL_ROLE = /(?:^|[_\-./])(vae|clip|text[_-]?encoder|t5|umt5|clip[_-]?vision|lora|controlnet|control[_-]?net|ipadapter|upscale|encoder|embedding|tokenizer)(?:[_\-.]|$)/i;

    function isBaseModelFile(file) {
        const base = normalizeBaseName(file);
        return Boolean(base) && !NON_BASE_MODEL_ROLE.test(base);
    }

    function hasBaseModelAlternative(entry, classType, input, options, requiredValue = "") {
        const config = entry?.baseModels;
        if (!config) return false;
        if ((config.classType || "UNETLoader") !== classType) return false;
        if ((config.input || "unet_name") !== input) return false;
        const requiredExt = path.extname(normalizeBaseName(requiredValue)).toLowerCase();
        const exact = Array.isArray(config.files) && config.files.length ? new Set(config.files.map((file) => normalizeAliasValue(file).toLowerCase())) : null;
        const names = Array.isArray(config.names) && config.names.length ? new Set(config.names.map((file) => normalizeBaseName(file))) : null;
        for (const file of options) {
            if (typeof file !== "string") continue;
            // 格式是红线：要求的底模是 .safetensors，就不能拿 .gguf/.ckpt 顶替。
            if (requiredExt && path.extname(normalizeBaseName(file)).toLowerCase() !== requiredExt) continue;
            if (exact) {
                if (exact.has(normalizeAliasValue(file).toLowerCase())) return true;
                continue;
            }
            if (names?.has(normalizeBaseName(file))) return true;
            if (!isBaseModelFile(file)) continue;
            if (config.filter) {
                try {
                    if (!new RegExp(config.filter, "i").test(file)) continue;
                } catch {
                    continue;
                }
            }
            if (config.exclude) {
                try {
                    if (new RegExp(config.exclude, "i").test(file)) continue;
                } catch {
                    continue;
                }
            }
            return true;
        }
        return false;
    }

    function validateWorkflow(workflow, classes, loaders, entry) {
        const problems = [];
        for (const [nodeId, node] of Object.entries(workflow || {})) {
            const classType = node?.class_type;
            if (!classType || !classes.has(classType)) {
                problems.push({ type: "node", message: `缺少节点 ${classType || "?"}（节点 ${nodeId}）` });
                continue;
            }
            const nodeLoaders = [...loaders.values()].filter((item) => item.classType === classType);
            for (const loader of nodeLoaders) {
                const value = node.inputs?.[loader.input];
                if (typeof value !== "string" || !value || loader.options.has(value)) continue;
                const override = mainModelFile(entry?.id);
                const overrideLower = normalizeAliasValue(override).toLowerCase();
                const overrideInstalled = Boolean(override) && [...loader.options].some((option) => normalizeAliasValue(option).toLowerCase() === overrideLower);
                if (override && classType === "UNETLoader" && loader.input === "unet_name" && overrideInstalled) continue;
                if (hasBaseModelAlternative(entry, classType, loader.input, loader.options, value)) continue;
                if (modelAliasFor(classType, loader.input, value)) continue;
                const pending = pendingModelFile(classType, loader.input, value);
                if (pending) {
                    problems.push({
                        type: "restart",
                        message: `模型已在本机（${pending.file}），但 ComfyUI 尚未加载；重启 ComfyUI 后生效。若重启后仍提示，请检查文件是否在 ComfyUI 模型目录、格式是否受支持，或点「自选替换」`,
                        classType,
                        input: loader.input,
                        value,
                        pendingFile: pending.file,
                    });
                    continue;
                }
                problems.push({
                    type: "model",
                    message: `缺少模型 ${classType}.${loader.input}=${value}`,
                    classType,
                    input: loader.input,
                    value,
                    candidates: modelCandidates(classType, value, loader.input),
                });
            }
        }
        return problems;
    }

    async function scan() {
        if (scanPromise) return scanPromise;
        scanPromise = (async () => {
            modelInventory.clear();
            state.phase = "scanning";
            state.scanStartedAt = nowIso();
            state.scannedAt = null;
            state.lastError = null;
            await persist();
            const started = Date.now();
            try {
                const stats = await comfy.systemStats();
                const objectInfo = await comfy.objectInfo();
                folderPathCatalog = typeof comfy.folderPaths === "function" ? await comfy.folderPaths() : {};
                state.comfyReachable = true;
                const classes = new Set(Object.keys(objectInfo || {}));
                nodeClasses = classes;
                currentLoaderSpecs = discoverModelLoaderSpecs(objectInfo);
                const loaders = collectLoaderOptions(objectInfo, currentLoaderSpecs);
                const catalog = {};
                for (const loader of loaders.values()) {
                    const sorted = [...loader.options].sort();
                    catalog[`${loader.classType}\u0000${loader.input}`] = sorted;
                    const aggregate = catalog[loader.classType] || [];
                    catalog[loader.classType] = [...new Set([...aggregate, ...sorted])].sort();
                }
                loaderCatalog = catalog;
                rebuildAutoAliases();
                const loraOptions = new Set([
                    ...(loaderOptionsFor("LoraLoaderModelOnly", "lora_name") || []),
                    ...(loaderOptionsFor("LoraLoader", "lora_name") || []),
                ]);
                state.loras = [...loraOptions].sort();
                const gatewayScan = await registry.scan();
                const comfyScan = await importComfyWorkflows();
                registry.reloadIfChanged?.();
                // hidden 工作流（如被画布复用的放大工具）不计入模型列表和“不可用”统计，
                // 但仍要计算可用性，否则超分等工具会被误判为不可用。
                const allEntries = registry.list().map((entry) => registry.resolve(entry.id)).filter(Boolean);
                const workflows = [];
                const missingModels = new Set();
                const missingNodes = new Set();
                const missingRuntime = new Set();
                const missingRestart = new Set();
                availability.clear();
                for (const entry of allEntries) {
                    const baseProblems = entry.workflow ? validateWorkflow(entry.workflow, classes, loaders, entry) : [];
                    const variantStatus = {};
                    for (const [mode, variant] of Object.entries(entry.variants || {})) {
                        if (!variant?.workflow) continue;
                        variantStatus[mode] = validateWorkflow(variant.workflow, classes, loaders, entry);
                    }
                    const variantProblems = Object.values(variantStatus).flat();
                    const runtimeProblems = typeof runtimeProblemProvider === "function" ? runtimeProblemProvider(entry.id) || [] : [];
                    const problems = [...baseProblems, ...variantProblems, ...runtimeProblems];
                    const unique = [];
                    for (const problem of problems) {
                        const key = `${problem.type}:${problem.message}`;
                        if (unique.some((item) => `${item.type}:${item.message}` === key)) continue;
                        unique.push(problem);
                    }
                    // 一个 variant 缺模型不应拖着整个入口“不可用”：
                    // 只要有任一 variant 可跑，入口就激活；具体哪档缺模型放在 variants 里。
                    const baseAvailable = baseProblems.length === 0;
                    const anyVariantAvailable = Object.values(variantStatus).some((list) => list.length === 0);
                    const available = runtimeProblems.length === 0 && (baseAvailable || anyVariantAvailable);
                    const variants = Object.fromEntries(Object.entries(variantStatus).map(([mode, list]) => [mode, { available: list.length === 0, problems: list }]));
                    availability.set(entry.id, { available, problems: unique, variants });
                    if (entry.hidden) continue;
                    for (const problem of unique) {
                        if (problem.type === "model") missingModels.add(problem.message);
                        if (problem.type === "node") missingNodes.add(problem.message);
                        if (problem.type === "runtime") missingRuntime.add(problem.message);
                        if (problem.type === "restart") missingRestart.add(problem.message);
                    }
                    workflows.push({ id: entry.id, name: entry.name, type: entry.type, available, problems: unique, variants });
                }
                state.workflows = workflows;
                state.counts = {
                    total: workflows.length,
                    available: workflows.filter((workflow) => workflow.available).length,
                    unavailable: workflows.filter((workflow) => !workflow.available).length,
                };
                state.missing = {
                    models: [...missingModels].sort(),
                    nodes: [...missingNodes].sort(),
                    runtime: [...missingRuntime].sort(),
                    restart: [...missingRestart].sort(),
                    uiWorkflows: comfyScan.ui,
                    uiSamples: comfyScan.samples,
                };
                state.phase = "ready";
                state.scannedAt = nowIso();
                state.scanDurationMs = Date.now() - started;
                hasScanned = true;
                logger?.info?.(`setup scan ready: ${state.counts.available}/${state.counts.total} workflows, ${state.missing.uiWorkflows} UI workflow(s) skipped, ${state.scanDurationMs}ms`);
                if (gatewayScan.added?.length || comfyScan.imported || comfyScan.removed) {
                    logger?.info?.(`auto-imported workflows: gateway=${gatewayScan.added?.length || 0}, comfy=${comfyScan.imported}, removed drafts=${comfyScan.removed || 0}`);
                }
            } catch (error) {
                state.phase = "degraded";
                state.comfyReachable = false;
                state.lastError = truncate(error?.message || String(error), 500);
                state.scanDurationMs = Date.now() - started;
                state.scannedAt = nowIso();
                logger?.warn?.(`setup scan degraded: ${state.lastError}`);
            } finally {
                if (typeof comfy.baseUrl === "function") lastComfyBase = comfy.baseUrl() || lastComfyBase;
                await persist();
                scanPromise = null;
                try {
                    onScanComplete?.(state);
                } catch (error) {
                    logger?.warn?.(`setup scan callback failed: ${error.message}`);
                }
            }
        })();
        return scanPromise;
    }

    function startWatchers() {
        if (!config.watchWorkflows) return;
        const watchDir = (dir, label) => {
            if (!dir || !fs.existsSync(dir)) return;
            try {
                const instance = fs.watch(dir, { persistent: false }, (event, filename) => {
                    if (!filename) return;
                    const name = String(filename);
                    if (label === "gateway" && (name === "registry.json" || name.endsWith(".tmp"))) return;
                    schedule();
                });
                instance.on("error", (error) => logger?.warn?.(`watch ${label} failed: ${error.message}`));
                watcher = instance;
                logger?.info?.(`watching ${label}: ${dir}`);
            } catch (error) {
                logger?.warn?.(`cannot watch ${label}: ${error.message}`);
            }
        };
        watchDir(config.workflowDir, "gateway");
        watchDir(config.comfyWorkflowsDir, "comfyui");
        poller = setInterval(() => {
            registry.reloadIfChanged?.();
        }, 30000);
        if (typeof poller.unref === "function") poller.unref();
    }

    // 启动器可能先起网关、后起 ComfyUI；或 ComfyUI 中途重启/换端口。
    // 只做连通性轮询，连上就重扫一次（区别于用户否决的目录 mtime 自动扫描）。
    async function checkConnectivity() {
        if (connectivityChecking || scanPromise) return;
        if (typeof comfy.isReachable !== "function") return;
        connectivityChecking = true;
        try {
            const reachable = await comfy.isReachable();
            const currentBase = typeof comfy.baseUrl === "function" ? comfy.baseUrl() : "";
            const addressChanged = Boolean(lastComfyBase && currentBase && currentBase !== lastComfyBase);
            if (!reachable) {
                if (state.comfyReachable || state.phase === "ready") {
                    state.comfyReachable = false;
                    state.phase = "degraded";
                    state.lastError = "ComfyUI 连接已断开，等待重连后自动重新扫描";
                    logger?.warn?.(state.lastError);
                    await persist();
                }
                return;
            }
            if (state.comfyReachable && state.phase === "ready" && !addressChanged) return;
            if (Date.now() - lastAutoScanAt < 10000) return;
            lastAutoScanAt = Date.now();
            logger?.info?.(addressChanged ? `ComfyUI 地址变化（${lastComfyBase} → ${currentBase}），自动重新扫描` : "ComfyUI 已连接，自动重新扫描工作流与模型");
            await scan();
        } catch (error) {
            logger?.warn?.(`ComfyUI 连通性检查失败：${error.message}`);
        } finally {
            connectivityChecking = false;
            const currentBase = typeof comfy.baseUrl === "function" ? comfy.baseUrl() : "";
            if (currentBase) lastComfyBase = currentBase;
        }
    }

    function startConnectivityWatch() {
        if (connectivityTimer) return;
        connectivityTimer = setInterval(() => void checkConnectivity(), 10000);
        if (typeof connectivityTimer.unref === "function") connectivityTimer.unref();
    }

    function start() {
        // 手动目录的托管块按当前映射规则重写一次（例如从“全类型 .”收敛到实际子目录）；
        // ComfyUI 运行中不会热加载 YAML，重启后才生效。
        if (directorySettings.mode === "manual") {
            const root = detectComfyLayout(directorySettings.comfyDir)?.root || directorySettings.comfyDir || config.comfyDir;
            if (root) {
                try {
                    const result = writeManagedExtraPaths(root, directorySettings);
                    if (result.changed) logger?.info?.(`手动目录配置已更新：${result.file}（重启 ComfyUI 后生效）`);
                } catch (error) {
                    logger?.warn?.(`更新手动目录配置失败：${error.message}`);
                }
            }
        }
        startWatchers();
        startConnectivityWatch();
        void scan().catch((error) => logger?.warn?.(`initial setup scan failed: ${error.message}`));
    }

    function stop() {
        watcher?.close();
        watcher = null;
        if (poller) clearInterval(poller);
        poller = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        if (connectivityTimer) clearInterval(connectivityTimer);
        connectivityTimer = null;
    }

    function isAvailable(id) {
        // ComfyUI 离线/扫描失败时不能再用旧结果假装可用。
        if (state.phase === "degraded") return false;
        if (!hasScanned) return state.phase === "idle" || state.phase === "scanning";
        const entry = availability.get(id);
        return entry ? entry.available : false;
    }

    function workflowStatus(id) {
        if (state.phase === "degraded") {
            return {
                available: false,
                stale: true,
                problems: [{ type: "offline", message: "ComfyUI 未连接，暂时无法确认工作流可用性" }],
            };
        }
        const entry = availability.get(id);
        if (entry) return entry;
        return { available: !hasScanned, problems: [] };
    }

    function loraNames() {
        return state.loras || [];
    }

    function loaderOptions() {
        return loaderCatalog;
    }

    function folderPaths() {
        return folderPathCatalog;
    }

    function hasNodeClass(name) {
        return nodeClasses.has(name);
    }

    function setRuntimeProblemProvider(provider) {
        runtimeProblemProvider = typeof provider === "function" ? provider : null;
    }

    function modelLoaderSpecs() {
        return currentLoaderSpecs;
    }

    function setDirectorySettings(input) {
        return applyDirectorySettings(input);
    }

    function getDirectorySettings() {
        return { ...directorySettings, comfyDir: config.comfyDir || directorySettings.comfyDir };
    }

    function comfyRootForScan() {
        return config.comfyDir || "";
    }

    return {
        state,
        scan,
        start,
        stop,
        isAvailable,
        workflowStatus,
        hasNodeClass,
        setRuntimeProblemProvider,
        modelLoaderSpecs,
        setDirectorySettings,
        getDirectorySettings,
        comfyRootForScan,
        userModelAliasFor,
        modelAliasFor,
        setModelAlias,
        setModelAliases,
        pickModelFile,
        modelCandidates,
        loraNames,
        loaderOptions,
        folderPaths,
        status: () => ({ ...state, scanning: Boolean(scanPromise) }),
    };
}
