import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { findUnetLoader } from "./base-models.js";
import { nowIso, truncate, writeJsonAtomic } from "./util.js";

const MODEL_DIRS = new Set(["diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "upscale_models", "latent_upscale_models", "vdn", "clip_vision"]);
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
        "C:\ComfyUI",
        "D:\ComfyUI",
        "E:\ComfyUI",
        "E:\ComfyUI_windows_portable",
        "E:\ComfyUI\ComfyUI",
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

function resolveComfyPython(config, root) {
    const candidates = [];
    if (root) {
        candidates.push(path.join(path.dirname(root), "python_embeded", "python.exe"));
        candidates.push(path.join(path.dirname(root), "python_embeded", "python.exe"));
        candidates.push(path.join(root, "python_embeded", "python.exe"));
        candidates.push(path.join(root, "venv", "Scripts", "python.exe"));
        candidates.push(path.join(root, ".venv", "Scripts", "python.exe"));
    }
    if (config.comfyDir) {
        candidates.push(path.join(config.comfyDir, "python_embeded", "python.exe"));
        candidates.push(path.join(config.comfyDir, "venv", "Scripts", "python.exe"));
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

export function createResourceManager({ config, setup, registry, logger, workflowVisibility = null, mainModels = null, hardware: hardwareOverride = null } = {}) {
    const indexPath = path.join(config.rootDir, "resources", "index.json");
    const lockPath = path.join(config.dataDir, "resource-lock.json");
    const jobs = new Map();
    let index = null;
    let hardware = hardwareOverride;
    let indexSource = "local";
    let indexError = "";
    let lock = { version: 1, installed: {} };
    let loadedAt = null;

    function comfyRoot() {
        return resolveComfyRoot(config);
    }

    function comfyPython(root = comfyRoot()) {
        return resolveComfyPython(config, root);
    }

    function targetPath(resource, root = comfyRoot()) {
        const { dir, file } = targetParts(resource.target);
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        if (dir === "custom_nodes") return path.join(root, "custom_nodes", file);
        return path.join(root, "models", dir, file);
    }

    async function loadLock() {
        const data = readJson(lockPath);
        if (data && data.version === 1 && data.installed && typeof data.installed === "object") lock = data;
    }

    async function saveLock() {
        await writeJsonAtomic(lockPath, lock);
    }

    async function loadIndex() {
        indexError = "";
        indexSource = "local";
        let local = null;
        try {
            local = validateIndex(readJson(indexPath));
        } catch (error) {
            indexError = `本地索引不可用：${error.message}`;
        }
        const remoteUrls = [config.resourcesIndexUrl, config.resourcesIndexUrlBackup].filter(Boolean);
        if (remoteUrls.length) {
            let lastError = null;
            let remoteLoaded = false;
            for (const [urlIndex, url] of remoteUrls.entries()) {
                try {
                    const response = await fetch(url, {
                        signal: AbortSignal.timeout(config.resourcesFetchTimeoutMs || 8000),
                        headers: { Accept: "application/json" },
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    index = validateIndex(await response.json());
                    indexSource = urlIndex === 0 && config.resourcesIndexUrl ? "remote" : "remote-backup";
                    indexError = "";
                    remoteLoaded = true;
                    break;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!remoteLoaded) {
                index = local;
                indexSource = local ? "local" : "none";
                indexError = `远端索引不可用：${lastError?.message || "未知错误"}`;
            }
        } else {
            index = local;
            indexSource = local ? "local" : "none";
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

    function registeredModel(modelDir, file) {
        const spec = LOADER_BY_DIR[modelDir];
        if (!spec) return false;
        const options = setup?.loaderOptions?.() || {};
        const list = Array.isArray(options[spec.classType]) ? options[spec.classType] : [];
        return list.includes(file);
    }

    function resourceStatus(resource, root) {
        const { dir, file } = targetParts(resource.target);
        const target = root ? targetPath(resource, root) : "";
        const isNode = dir === "custom_nodes" || resource.type === "node";
        const exists = Boolean(target && (isNode ? isDir(target) : isFile(target)));
        let size = 0;
        try {
            size = exists ? fs.statSync(target).size : 0;
        } catch {
            size = 0;
        }
        const registered = dir !== "custom_nodes" ? registeredModel(dir, file) : false;
        const isBake = resource.type === "bake";
        const missingRequires = isBake ? (resource.requires || []).filter((id) => {
            const dependency = index?.resources?.find((item) => item.id === id);
            if (!dependency) return true;
            return !isFile(targetPath(dependency, root));
        }) : [];
        const status = isBake
            ? (exists ? "present" : missingRequires.length ? "blocked" : "missing")
            : isNode
              ? exists ? "present" : "missing"
              : exists || registered
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
            actualSize: size,
            installed,
            missingRequires,
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
        const entries = workflowIds.map((id) => registry?.resolve?.(id)).filter(Boolean);
        const files = [...new Set(entries.map((entry) => findUnetLoader(entry.workflow)?.file).filter(Boolean))];
        if (!files.length) return null;
        const selected = mainModels?.fileForPack?.(pack.id) || "";
        const selectedInstalled = Boolean(selected && installed.has(selected));
        const filter = entries.map((entry) => entry.baseModels?.filter).find(Boolean) || "";
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
            if (!resource || !resourceFile(resource)) continue;
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
            if (options.has(file)) continue;
            options.set(file, { file, label: path.basename(file, path.extname(file)), installed: true, source: "local", matches: matchesFamily(file) });
        }
        if (selected && !options.has(selected)) {
            options.set(selected, { file: selected, label: path.basename(selected, path.extname(selected)), installed: false, source: "local" });
        }
        const defaultResource = (pack.resources || [])
            .map((id) => index?.resources?.find((item) => item.id === id))
            .find((resource) => resource && resourceFile(resource) === files[0]);
        return {
            workflowIds,
            files,
            defaultFile: files[0],
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
                if (dir === "diffusion_models" && info.files.includes(resourceFile(resource))) overriddenResources.set(resource.id, info.selected);
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
                    resources: dependencyItems,
                    missing: missingItems.length,
                    missingSize: missingItems.reduce((sum, item) => sum + (item.size || 0), 0),
                    installIds: [...installIds].filter((id) => byId.get(id)?.status !== "present"),
                };
            });
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
                pack.missing = requiredMissing.length;
                pack.missingSize = requiredMissing.reduce((sum, item) => sum + (item.size || 0), 0);
                for (const workflow of pack.workflowDependencies) {
                    workflow.recommended = variant.workflows.includes(workflow.id);
                }
            }
        }

        const recommendedPacks = packs.filter((pack) => pack.recommended);
        const recommendedIds = new Set(recommendedPacks.flatMap((pack) => pack.requiredIds || pack.resourceIds));
        const recommendedResources = resources.filter((resource) => recommendedIds.has(resource.id));
        const recommendedMissing = recommendedResources.filter((resource) => resource.status !== "present");
        const missingResources = resources.filter((resource) => resource.status !== "present");
        return {
            ok: true,
            loadedAt,
            indexSource,
            indexError,
            indexVersion: index?.version || "",
            channel: index?.channel || "",
            comfyRoot: root,
            comfyPython: comfyPython(root),
            comfyReachable: Boolean(setup?.status?.().comfyReachable),
            hardware: hardware || null,
            recommendationAvailable: hardwareAvailable && recommendedPacks.length > 0,
            packs,
            resources,
            summary: {
                packs: packs.filter((pack) => !pack.planned).length,
                resources: resources.length,
                present: resources.length - missingResources.length,
                missing: missingResources.length,
                missingSize: missingResources.reduce((sum, item) => sum + (item.size || 0), 0),
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
        if (value && !installed.has(value)) throw new Error("所选主模型尚未安装");
        await mainModels.set(pack.id, { file: value, workflows: info.workflowIds });
        try {
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
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        const target = targetPath(resource, root);
        if (isFile(target)) {
            jobItem.status = "skipped";
            jobItem.skipped = true;
            jobItem.bytes = fs.statSync(target).size;
            jobItem.size = jobItem.size || jobItem.bytes;
            return;
        }
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

    async function runBake(resource, jobItem, signal) {
        const root = comfyRoot();
        if (!root) throw new Error("未找到 ComfyUI 安装目录");
        const python = comfyPython(root);
        if (!python) throw new Error("未找到 ComfyUI 的 Python");
        const target = targetPath(resource, root);
        const h3Trt = resource.builder?.kind === "h3-trt-vae";
        let args;
        let trtInput = "";
        let trtCompiler = "";
        if (h3Trt) {
            const script = path.join(config.rootDir, "scripts", "build-h3-trt-vae.py");
            if (!isFile(script)) throw new Error("缺少编译脚本 scripts/build-h3-trt-vae.py");
            const inputResource = resourceById(resource.builder?.input || resource.requires?.[0]);
            if (!inputResource) throw new Error("TRT 编译缺少 ONNX 输入资源");
            const input = targetPath(inputResource, root);
            if (!isFile(input)) throw new Error("TRT 编译依赖的 ONNX 尚未就绪");
            const compiler = path.join(root, "custom_nodes", "ComfyUI-H3VAE_TRT", "compile.py");
            if (!isFile(compiler)) throw new Error("缺少 ComfyUI-H3VAE_TRT/compile.py，请先安装 H3 TRT VAE 节点");
            trtInput = input;
            trtCompiler = compiler;
            args = [script, "--compiler", compiler, "--input", input, "--output", target, "--device", String(resource.builder?.device ?? 0)];
        } else {
            const script = path.join(config.rootDir, "scripts", "bake-moss-preset.py");
            if (!isFile(script)) throw new Error("缺少烘焙脚本 scripts/bake-moss-preset.py");
            const baseResource = resourceById(resource.requires?.[0]);
            const sftResource = resourceById(resource.requires?.[1]);
            if (!baseResource || !sftResource) throw new Error("烘焙缺少 Base/SFT 依赖");
            const basePath = targetPath(baseResource, root);
            const sftPath = targetPath(sftResource, root);
            if (!isFile(basePath) || !isFile(sftPath)) throw new Error("烘焙依赖的 Base/SFT 尚未就绪");
            args = [script, "--base", basePath, "--sft", sftPath, "--out", target, "--preset", resource.builder?.preset || "Balanced", "--strength", String(resource.builder?.strength ?? 1)];
        }
        jobItem.status = "baking";
        jobItem.source = h3Trt ? "本机编译 TRT Engine" : "本地烘焙";
        await fsp.mkdir(path.dirname(target), { recursive: true });
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
                    if (code !== 0 || !isFile(target)) return reject(new Error(`烘焙失败（exit ${code}）${stderr ? `：${truncate(stderr, 500)}` : ""}`));
                    resolve();
                });
            });
        } catch (error) {
            if (h3Trt && !signal?.aborted) {
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
        const downloads = jobsToRun.filter((item) => item.type !== "bake" && item.type !== "node");
        const nodeJobs = jobsToRun.filter((item) => item.type === "node");
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
        const failed = job.items.filter((item) => item.status === "error").length;
        const hinted = job.items.some((item) => item.status === "error" && item.hint);
        job.status = failed ? "error" : "done";
        job.message = failed
            ? hinted
                ? `${failed} 项失败，其中本机编译失败，请按提示交给 AI Agent 处理`
                : `${failed} 项失败，请查看日志或用备用源重试`
            : "资源已就绪";
        job.error = failed ? "部分资源安装失败" : "";
        updateJob(job);
        try {
            await setup?.scan?.();
        } catch (error) {
            logger?.warn?.(`资源安装后重新扫描失败：${error.message}`);
        }
    }

    function install({ ids = [], packs = [] } = {}) {
        if (!index) throw new Error("资源索引尚未加载");
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
        void runJob(job).catch((error) => {
            job.status = "error";
            job.error = truncate(error.message || String(error), 500);
            updateJob(job);
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
        job.status = "canceled";
        job.message = "已取消";
        for (const controller of job.controllers.values()) controller.abort(new Error("用户取消"));
        for (const item of job.items) {
            if (item.child) {
                try {
                    item.child.kill();
                } catch {
                    // 忽略子进程已退出。
                }
            }
            if (["queued", "downloading", "verifying", "baking"].includes(item.status)) item.status = "error", item.error = "已取消";
        }
        updateJob(job);
        return jobSnapshot(job);
    }

    async function refresh() {
        if (!hardwareOverride) hardware = await probeHardware();
        await loadIndex();
        try {
            await setup?.scan?.();
        } catch (error) {
            logger?.warn?.(`资源刷新扫描失败：${error.message}`);
        }
        return status();
    }

    async function init() {
        if (!hardwareOverride) hardware = await probeHardware();
        await loadLock();
        await loadIndex();
        return status();
    }

    return { init, status, refresh, install, setMainModel, getJob, cancelJob, comfyRoot, comfyPython, indexPath };
}
