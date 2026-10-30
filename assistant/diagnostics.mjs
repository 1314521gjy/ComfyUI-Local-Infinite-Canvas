import { Type } from "@mariozechner/pi-ai";

const DEFAULT_GATEWAY = "http://127.0.0.1:8291";
const REQUEST_TIMEOUT_MS = 12000;
const TEXT_LIMIT = 14000;

export function normalizeGatewayUrl(value) {
    let url;
    try {
        url = new URL(String(value || DEFAULT_GATEWAY));
    } catch {
        return DEFAULT_GATEWAY;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_GATEWAY;
    const host = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return DEFAULT_GATEWAY;
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
    return `${url.protocol}//${url.host}${pathname}`;
}

async function fetchJson(gatewayUrl, path) {
    const base = normalizeGatewayUrl(gatewayUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${base}${path}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function postJson(gatewayUrl, path, body, timeoutMs = 390000) {
    const base = normalizeGatewayUrl(gatewayUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${base}${path}`, {
            method: "POST",
            signal: controller.signal,
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `HTTP ${response.status}`);
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

function capList(list, size) {
    return Array.isArray(list) ? list.slice(0, size) : [];
}

function problemText(problem) {
    if (!problem || typeof problem !== "object") return String(problem || "");
    return [problem.type, problem.message || problem.label || problem.id].filter(Boolean).join(": ");
}

function summarizeProblems(problems) {
    return capList(problems, 8).map(problemText).filter(Boolean);
}

function summarizeVariantProblems(variants) {
    return Object.entries(variants || {})
        .filter(([, value]) => value && (value.available === false || (Array.isArray(value.problems) && value.problems.length)))
        .map(([name, value]) => ({ variant: name, available: value.available !== false, problems: summarizeProblems(value.problems) }));
}

function summarizeHealth(payload) {
    return {
        status: payload?.status,
        version: payload?.version,
        comfy: payload?.comfy,
        workflows: payload?.workflows,
        setup: payload?.setup,
        tasks: payload?.tasks,
        uptimeSeconds: payload?.uptimeSeconds,
    };
}

function summarizeSetup(payload) {
    const status = payload?.status || {};
    const workflows = Array.isArray(status.workflows) ? status.workflows : [];
    return {
        ok: payload?.ok,
        phase: status.phase,
        comfyUrl: status.comfyUrl || payload?.comfyUrl,
        comfyReachable: status.comfyReachable,
        scanStartedAt: status.scanStartedAt,
        scannedAt: status.scannedAt,
        scanDurationMs: status.scanDurationMs,
        lastError: status.lastError,
        counts: status.counts,
        unavailable: workflows
            .filter((item) => item.available === false)
            .map((item) => ({ id: item.id, name: item.name, type: item.type, problems: summarizeProblems(item.problems) })),
        variantProblems: workflows
            .map((item) => ({ id: item.id, variants: summarizeVariantProblems(item.variants) }))
            .filter((item) => item.variants.length),
    };
}

function summarizeWorkflows(payload, params = {}) {
    const wanted = String(params.workflow || "").trim().toLowerCase();
    const onlyProblems = params.onlyProblems === true;
    const list = (payload?.workflows || [])
        .filter((item) => {
            if (!wanted) return true;
            return [item.id, item.name, item.label].some((value) => String(value || "").toLowerCase() === wanted);
        })
        .map((item) => {
            const availability = item.availability || {};
            return {
                id: item.id,
                label: item.label || item.name,
                type: item.type,
                hidden: item.hidden === true,
                enabled: item.enabled !== false,
                available: availability.available !== false,
                stale: availability.stale === true,
                problems: summarizeProblems(availability.problems),
                variantProblems: summarizeVariantProblems(availability.variants),
            };
        })
        .filter((item) => (onlyProblems ? !item.available || item.problems.length || item.variantProblems.length || !item.enabled : true));
    return { total: payload?.workflows?.length || 0, workflows: list };
}

function summarizeResourceItem(item) {
    if (!item || typeof item !== "object") return null;
    return {
        id: item.id,
        label: item.label,
        type: item.type,
        target: item.target,
        status: item.status,
        matchedBy: item.matchedBy || "",
        matchedFile: item.matchedFile || "",
        present: item.present === true,
        note: item.note || "",
    };
}

function summarizeResources(payload, params = {}) {
    const packs = Array.isArray(payload?.packs) ? payload.packs : [];
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    const packSummaries = packs
        .map((pack) => ({
            id: pack.id,
            label: pack.label,
            recommended: pack.recommended === true,
            total: pack.total,
            present: pack.present,
            missing: pack.missing,
            missingSize: pack.missingSize,
            optionalMissing: pack.optionalMissing,
            requiredMissing: capList(pack.requiredItems, 30)
                .filter((item) => item.status !== "present")
                .map(summarizeResourceItem),
        }))
        .filter((pack) => pack.missing > 0 || pack.requiredMissing.length || params.onlyProblems === true);
    const dependencies = packs
        .flatMap((pack) => (Array.isArray(pack.workflowDependencies) ? pack.workflowDependencies.map((item) => ({ pack: pack.id, ...item })) : []))
        .filter((item) => item.available === false || (Array.isArray(item.problems) && item.problems.length))
        .map((item) => ({
            pack: item.pack,
            workflowId: item.workflowId || item.id,
            label: item.label,
            available: item.available !== false,
            enabled: item.enabled !== false,
            problems: summarizeProblems(item.problems),
        }));
    const missing = resources
        .filter((item) => item.status !== "present")
        .map(summarizeResourceItem)
        .filter(Boolean);
    const aliases = resources
        .filter((item) => item.matchedBy === "alias" || item.overridden === true)
        .map((item) => ({
            id: item.id,
            label: item.label,
            target: item.target,
            matchedBy: item.matchedBy || "alias",
            overriddenBy: item.overriddenBy || item.matchedFile || "",
        }));
    const summary = {
        ok: payload?.ok,
        indexSource: payload?.indexSource,
        indexVersion: payload?.indexVersion,
        indexError: payload?.indexError || "",
        indexWarning: payload?.indexWarning || "",
        comfyRoot: payload?.comfyRoot,
        comfyPython: payload?.comfyPython,
        comfyReachable: payload?.comfyReachable,
        hardware: payload?.hardware
            ? {
                  gpuName: payload.hardware.gpuName,
                  vramTotalMb: payload.hardware.vramTotalMb,
                  ramTotalBytes: payload.hardware.ramTotalBytes,
                  ramFreeBytes: payload.hardware.ramFreeBytes,
              }
            : null,
        counts: payload?.summary,
        packs: packSummaries,
        workflowDependencies: dependencies,
        missingResources: missing,
        aliases,
    };
    if (params.includeRoots === true) summary.modelRoots = payload?.modelRoots;
    if (params.includeAll === true) summary.allResources = resources.map(summarizeResourceItem).filter(Boolean);
    return summary;
}

function summarizeDirectories(payload) {
    const settings = payload?.settings || {};
    return {
        ok: payload?.ok,
        mode: settings.mode,
        comfyDir: settings.comfyDir,
        modelDirs: settings.modelDirs,
        loraDirs: settings.loraDirs,
        customNodesDirs: settings.customNodesDirs,
        updatedAt: settings.updatedAt,
        comfyRoot: payload?.comfyRoot,
        auto: payload?.auto,
        loadReport: payload?.loadReport,
        setup: payload?.setup,
    };
}

function summarizeSystem(payload) {
    return {
        ok: payload?.ok,
        at: payload?.at,
        gpu: capList(payload?.gpu, 4).map((gpu) => ({
            index: gpu.index,
            name: gpu.name,
            memoryUsedMb: gpu.memoryUsedMb,
            memoryTotalMb: gpu.memoryTotalMb,
            utilization: gpu.utilization,
            temperature: gpu.temperature,
        })),
        gpuError: payload?.gpuError || "",
        ram: payload?.ram,
        comfy: payload?.comfy,
        setup: payload?.setup,
        restartAvailable: payload?.restartAvailable,
        lastOOM: payload?.lastOOM || null,
    };
}

function summarizeReplacement(payload, resourceId) {
    const status = payload?.status || {};
    const resource = (Array.isArray(status.resources) ? status.resources : []).find((item) => item.id === resourceId) || null;
    return {
        ok: payload?.ok,
        resourceId,
        resource: resource
            ? {
                  label: resource.label,
                  status: resource.status,
                  present: resource.present,
                  matchedBy: resource.matchedBy,
                  matchedFile: resource.matchedFile,
                  overridden: resource.overridden,
                  overriddenBy: resource.overriddenBy,
                  note: resource.note,
              }
            : null,
        counts: status.summary || null,
    };
}

function textResult(value, gatewayUrl) {
    const text = JSON.stringify(value, null, 2);
    return {
        content: [{ type: "text", text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…（已截断）` : text }],
        details: { gatewayUrl },
    };
}

export function createDiagnosticTools({ gatewayUrl } = {}) {
    const base = normalizeGatewayUrl(gatewayUrl);
    return [
        {
            name: "gateway_health",
            label: "网关健康",
            description: "读取网关 /health：版本、ComfyUI 是否可达、工作流计数、扫描阶段、任务数、运行时长。",
            parameters: Type.Object({}),
            execute: async () => textResult(summarizeHealth(await fetchJson(base, "/health")), base),
        },
        {
            name: "setup_status",
            label: "扫描状态",
            description: "读取 /api/setup/status：扫描阶段、可用计数、失败工作流和 variant 问题。不返回 LoRA 列表。",
            parameters: Type.Object({}),
            execute: async () => textResult(summarizeSetup(await fetchJson(base, "/api/setup/status")), base),
        },
        {
            name: "workflow_status",
            label: "工作流状态",
            description: "读取 /api/workflows：每个工作流是否启用/隐藏/可用、问题列表和 variant 掉档。可用 workflow 参数按 id/名称过滤。",
            parameters: Type.Object({
                workflow: Type.Optional(Type.String({ description: "工作流 id 或名称；留空返回全部" })),
                onlyProblems: Type.Optional(Type.Boolean({ description: "只返回不可用、被禁用或有问题的工作流" })),
            }),
            execute: async (_toolCallId, params) => textResult(summarizeWorkflows(await fetchJson(base, "/api/workflows"), params), base),
        },
        {
            name: "resource_status",
            label: "资源状态",
            description: "读取 /api/resources/status：缺失资源、缺失工作流依赖、模型匹配方式（含相似匹配和用户自选替换）、目录根、硬件。",
            parameters: Type.Object({
                onlyProblems: Type.Optional(Type.Boolean({ description: "只返回缺失/有问题的 pack 和依赖" })),
                includeRoots: Type.Optional(Type.Boolean({ description: "是否返回各模型目录的根路径映射" })),
                includeAll: Type.Optional(Type.Boolean({ description: "是否返回全部资源的 id/label/target/status，用于定位要替换的资源" })),
            }),
            execute: async (_toolCallId, params) => textResult(summarizeResources(await fetchJson(base, "/api/resources/status"), params), base),
        },
        {
            name: "directory_settings",
            label: "目录设置",
            description: "读取 /api/setup/directories：ComfyUI 根目录、模型/LoRA/自定义节点目录、是否需要重启 ComfyUI。",
            parameters: Type.Object({}),
            execute: async () => textResult(summarizeDirectories(await fetchJson(base, "/api/setup/directories")), base),
        },
        {
            name: "system_stats",
            label: "系统状态",
            description: "读取 /api/system/stats：GPU 显存占用、内存、ComfyUI 可达性、最近一次 OOM。生成失败/OOM 时使用。",
            parameters: Type.Object({}),
            execute: async () => textResult(summarizeSystem(await fetchJson(base, "/api/system/stats")), base),
        },
        {
            name: "restart_comfy",
            label: "启动/重启 ComfyUI",
            description: "调用启动器重启或启动 ComfyUI。只在用户明确要求「启动/重启 ComfyUI」时调用；需要启动器控制接口可用。",
            parameters: Type.Object({}),
            execute: async () => {
                const payload = await postJson(base, "/api/system/restart-comfy", {});
                return textResult({ ok: payload?.ok !== false, result: payload }, base);
            },
        },
        {
            name: "replace_model",
            label: "替换模型",
            description: "把资源卡里的模型替换为用户指定的已安装文件（等价于资源卡「自选替换」）。只在用户明确给出资源 id 和目标文件、并确认要替换时调用；不要猜文件名。",
            parameters: Type.Object({
                resourceId: Type.String({ description: "资源 id，例如 h3_tiny_vae" }),
                file: Type.String({ description: "ComfyUI loader 中已安装的目标文件名" }),
            }),
            execute: async (_toolCallId, params) => {
                const resourceId = String(params.resourceId || "").trim();
                const file = String(params.file || "").trim();
                if (!resourceId || !file) throw new Error("resourceId 和 file 都不能为空");
                const payload = await postJson(base, "/api/resources/replacement", { resourceId, file });
                return textResult(summarizeReplacement(payload, resourceId), base);
            },
        },
    ];
}

export async function collectSnapshot(gatewayUrl) {
    const base = normalizeGatewayUrl(gatewayUrl);
    const result = { gatewayUrl: base, ok: false, health: null, error: "" };
    try {
        result.health = summarizeHealth(await fetchJson(base, "/health"));
        result.ok = true;
    } catch (error) {
        result.error = error?.name === "AbortError" ? "网关请求超时" : String(error?.message || error);
    }
    return result;
}
