import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { nowIso, truncate, writeJsonAtomic } from "./util.js";

const LOADER_SPECS = [
    { classType: "CheckpointLoaderSimple", input: "ckpt_name", key: "checkpoints" },
    { classType: "UNETLoader", input: "unet_name", key: "unets" },
    { classType: "UpscaleModelLoader", input: "model_name", key: "upscaleModels" },
    { classType: "SeedVR2LoadDiTModel", input: "model", key: "seedvr2Dit" },
    { classType: "SeedVR2LoadVAEModel", input: "model", key: "seedvr2Vae" },
    { classType: "CLIPLoader", input: "clip_name", key: "clips" },
    { classType: "VAELoader", input: "vae_name", key: "vaes" },
    { classType: "LoraLoader", input: "lora_name", key: "loras" },
    { classType: "LoraLoaderModelOnly", input: "lora_name", key: "lorasModelOnly" },
    { classType: "ApplyVDNH3Advanced", input: "vdn_checkpoint", key: "vdn" },
];

function safeStat(file) {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

export function createSetupManager({ config, registry, comfy, logger } = {}) {
    const statusFile = path.join(config.dataDir, "setup-status.json");
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
        for (const entry of registry.list()) {
            const internal = registry.resolve(entry.id);
            const sourcePath = internal?.source?.path;
            if (sourcePath) importedComfyPaths.add(path.resolve(sourcePath));
        }
        const entries = await fsp.readdir(config.comfyWorkflowsDir);
        let imported = 0;
        let ui = 0;
        const samples = [];
        for (const name of entries) {
            if (!name.toLowerCase().endsWith(".json")) continue;
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
                if (hasBaseModelAlternative(entry, classType, loader.input, loader.options)) continue;
                problems.push({ type: "model", message: `缺少模型 ${classType}.${loader.input}=${value}` });
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
                state.comfyReachable = true;
                const classes = new Set(Object.keys(objectInfo || {}));
                const loaders = collectLoaderOptions(objectInfo);
                loaderCatalog = Object.fromEntries([...loaders.entries()].map(([classType, loader]) => [classType, [...loader.options].sort()]));
                const loraOptions = loaders.get("LoraLoaderModelOnly")?.options || loaders.get("LoraLoader")?.options || new Set();
                state.loras = [...loraOptions].sort();
                const gatewayScan = await registry.scan();
                const comfyScan = await importComfyWorkflows();
                registry.reloadIfChanged?.();
                const entries = registry.list().map((entry) => registry.resolve(entry.id)).filter(Boolean);
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

    return {
        state,
        scan,
        start,
        stop,
        isAvailable,
        workflowStatus,
        loraNames,
        loaderOptions,
        status: () => ({ ...state, scanning: Boolean(scanPromise) }),
    };
}
