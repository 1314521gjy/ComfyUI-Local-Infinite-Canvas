import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { MODEL_LOADER_SPECS as LOADER_SPECS } from "./model-loaders.js";
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

export function createSetupManager({ config, registry, comfy, logger, mainModelFile = () => "" } = {}) {
    const statusFile = path.join(config.dataDir, "setup-status.json");
    const aliasFile = path.join(config.dataDir, "model-aliases.json");
    let aliases = readAliasFile(aliasFile);
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
    let loaderCatalog = {};
    let folderPathCatalog = {};
    let nodeClasses = new Set();

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
        const importedComfyNames = new Set();
        for (const entry of registry.list()) {
            const internal = registry.resolve(entry.id);
            const sourcePath = internal?.source?.path;
            if (sourcePath) importedComfyPaths.add(path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(config.comfyWorkflowsDir, sourcePath));
            if (internal?.source?.kind === "comfyui" && internal.source.name) importedComfyNames.add(path.basename(String(internal.source.name)));
        }
        const entries = await fsp.readdir(config.comfyWorkflowsDir);
        let imported = 0;
        let ui = 0;
        const samples = [];
        for (const name of entries) {
            if (!name.toLowerCase().endsWith(".json")) continue;
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
                try {
                    await registry.importWorkflow({
                        path: file,
                        name: path.basename(name, ".json"),
                        overwrite: false,
                    });
                    importedComfyPaths.add(file);
                    imported += 1;
                } catch (error) {
                    logger?.warn?.(`自动导入 ComfyUI 工作流失败 ${name}: ${error.message}`);
                }
            } catch (error) {
                comfyFileCache.set(file, { signature, kind: "error" });
                logger?.warn?.(`读取 ComfyUI 工作流失败 ${name}: ${error.message}`);
            }
        }
        return { imported, ui, samples };
    }

    function collectLoaderOptions(objectInfo) {
        const loaders = new Map();
        for (const spec of LOADER_SPECS) {
            const definition = objectInfo?.[spec.classType]?.input?.required?.[spec.input];
            // 旧版 object_info 把选项放在 [0]，新版 COMBO 放在 ["COMBO", { options }]。
            const options = Array.isArray(definition?.[0]) ? definition[0] : Array.isArray(definition?.[1]?.options) ? definition[1].options : null;
            if (Array.isArray(options)) loaders.set(spec.classType, { ...spec, options: new Set(options) });
        }
        return loaders;
    }

    function loaderOptionsFor(classType) {
        const list = loaderCatalog?.[classType];
        return Array.isArray(list) ? list : [];
    }

    // 同 basename、不同子目录/路径的文件是同一个模型，可自动认；
    // 同名文件出现多份时不自动选，留给用户确认。
    function rebuildAutoAliases() {
        autoAliases.clear();
        for (const spec of LOADER_SPECS) {
            const options = loaderOptionsFor(spec.classType);
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
            autoAliases.set(spec.classType, map);
        }
    }

    function modelRootsForDir(dir) {
        return collectModelRoots({ dir, folderPaths: folderPathCatalog, comfyDir: config.comfyDir });
    }

    function findInstalledOption(classType, value) {
        const normalized = normalizeAliasValue(value);
        return loaderOptionsFor(classType).find((item) => isModelOption(item) && normalizeAliasValue(item) === normalized) || "";
    }

    function aliasTargetExists(classType, value) {
        if (findInstalledOption(classType, value)) return true;
        const normalized = normalizeAliasValue(value);
        if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) return false;
        const spec = LOADER_SPECS.find((item) => item.classType === classType);
        if (!spec) return false;
        return (spec.dirs || []).some((dir) => modelRootsForDir(dir).some((root) => safeStat(path.join(root, normalized))?.isFile()));
    }

    function modelAliasFor(classType, input, value) {
        if (!value) return "";
        const user = aliases[modelAliasKey(classType, input, value)] || "";
        if (user) {
            const actual = findInstalledOption(classType, user);
            if (actual) return actual;
            if (aliasTargetExists(classType, user)) return normalizeAliasValue(user);
        }
        const auto = autoAliases.get(classType)?.get(normalizeBaseName(value)) || "";
        if (auto && normalizeAliasValue(auto) !== normalizeAliasValue(value)) return auto;
        return "";
    }

    function modelCandidates(classType, value) {
        const base = normalizeBaseName(value);
        return loaderOptionsFor(classType)
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
            const spec = LOADER_SPECS.find((item) => item.classType === classType && item.input === input);
            if (!spec) throw new Error("不支持的模型输入");
            const source = String(entry?.from || "").trim();
            if (!source) throw new Error("缺少原模型名");
            const target = String(entry?.to || "").trim();
            const key = modelAliasKey(classType, input, source);
            if (!target || normalizeAliasValue(target) === normalizeAliasValue(source)) {
                delete aliases[key];
                continue;
            }
            const actual = findInstalledOption(classType, target);
            if (actual) {
                aliases[key] = actual;
                continue;
            }
            if (aliasTargetExists(classType, target)) {
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

    function hasBaseModelAlternative(entry, classType, input, options) {
        const config = entry?.baseModels;
        if (!config) return false;
        if ((config.classType || "UNETLoader") !== classType) return false;
        if ((config.input || "unet_name") !== input) return false;
        for (const file of options) {
            if (typeof file !== "string") continue;
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
            const loader = loaders.get(classType);
            if (!loader) continue;
            const value = node.inputs?.[loader.input];
            if (typeof value === "string" && value && !loader.options.has(value)) {
                const override = mainModelFile(entry?.id);
                if (override && classType === "UNETLoader" && loader.input === "unet_name" && loader.options.has(override)) continue;
                if (hasBaseModelAlternative(entry, classType, loader.input, loader.options)) continue;
                if (modelAliasFor(classType, loader.input, value)) continue;
                problems.push({
                    type: "model",
                    message: `缺少模型 ${classType}.${loader.input}=${value}`,
                    classType,
                    input: loader.input,
                    value,
                    candidates: modelCandidates(classType, value),
                });
            }
        }
        return problems;
    }

    async function scan() {
        if (scanPromise) return scanPromise;
        scanPromise = (async () => {
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
                const loaders = collectLoaderOptions(objectInfo);
                loaderCatalog = Object.fromEntries([...loaders.entries()].map(([classType, loader]) => [classType, [...loader.options].sort()]));
                rebuildAutoAliases();
                const loraOptions = loaders.get("LoraLoaderModelOnly")?.options || loaders.get("LoraLoader")?.options || new Set();
                state.loras = [...loraOptions].sort();
                const gatewayScan = await registry.scan();
                const comfyScan = await importComfyWorkflows();
                registry.reloadIfChanged?.();
                // hidden 工作流（如被画布复用的放大工具）不参与可用性统计，避免虚增“不可用”数量。
                const entries = registry.list().map((entry) => registry.resolve(entry.id)).filter((entry) => entry && !entry.hidden);
                const workflows = [];
                const missingModels = new Set();
                const missingNodes = new Set();
                availability.clear();
                for (const entry of entries) {
                    const variants = [entry.workflow, ...Object.values(entry.variants || {}).map((variant) => variant?.workflow)].filter(Boolean);
                    const problems = variants.flatMap((workflow) => validateWorkflow(workflow, classes, loaders, entry));
                    const unique = [];
                    for (const problem of problems) {
                        const key = `${problem.type}:${problem.message}`;
                        if (unique.some((item) => `${item.type}:${item.message}` === key)) continue;
                        unique.push(problem);
                        if (problem.type === "model") missingModels.add(problem.message);
                        if (problem.type === "node") missingNodes.add(problem.message);
                    }
                    const available = unique.length === 0;
                    availability.set(entry.id, { available, problems: unique });
                    workflows.push({ id: entry.id, name: entry.name, type: entry.type, available, problems: unique });
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
                    uiWorkflows: comfyScan.ui,
                    uiSamples: comfyScan.samples,
                };
                state.phase = "ready";
                state.scannedAt = nowIso();
                state.scanDurationMs = Date.now() - started;
                hasScanned = true;
                logger?.info?.(`setup scan ready: ${state.counts.available}/${state.counts.total} workflows, ${state.missing.uiWorkflows} UI workflow(s) skipped, ${state.scanDurationMs}ms`);
                if (gatewayScan.added.length || comfyScan.imported) {
                    logger?.info?.(`auto-imported workflows: gateway=${gatewayScan.added.length}, comfy=${comfyScan.imported}`);
                }
            } catch (error) {
                state.phase = "degraded";
                state.comfyReachable = false;
                state.lastError = truncate(error?.message || String(error), 500);
                state.scanDurationMs = Date.now() - started;
                state.scannedAt = nowIso();
                logger?.warn?.(`setup scan degraded: ${state.lastError}`);
            } finally {
                await persist();
                scanPromise = null;
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

    function start() {
        startWatchers();
        void scan().catch((error) => logger?.warn?.(`initial setup scan failed: ${error.message}`));
    }

    function stop() {
        watcher?.close();
        watcher = null;
        if (poller) clearInterval(poller);
        poller = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
    }

    function isAvailable(id) {
        if (!hasScanned) return true;
        const entry = availability.get(id);
        return entry ? entry.available : true;
    }

    function workflowStatus(id) {
        return availability.get(id) || { available: true, problems: [] };
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

    return {
        state,
        scan,
        start,
        stop,
        isAvailable,
        workflowStatus,
        hasNodeClass,
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
