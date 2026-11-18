import type { NavigateFunction } from "react-router-dom";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { fetchFreeWorkflow, fetchFreeWorkflowGraph, fetchFreeWorkflowHealth, fetchFreeWorkflowSources, fetchFreeWorkflows, importFreeWorkflow, renameFreeWorkflow, saveFreeWorkflowParams, syncFreeWorkflow, validateFreeWorkflowRequest, type FreeWorkflowParam, type FreeWorkflowSummary } from "@/services/api/free-workflow";
import { uploadImage } from "@/services/image-storage";
import { imageAspectOptions, imageQualityOptions, imageScaleOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions, videoSecondsRange, videoSizeOptions } from "@/components/video-settings-panel";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { ensureFreeCardWorkflowEntry, freeCardMetadataPatch } from "@/lib/canvas/free-card-workflow";
import { clampVideoSeconds } from "@/lib/media-size";
import { CanvasNodeType } from "@/types/canvas";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { customWorkflowView, useCustomWorkflowStore, type CustomWorkflowMode } from "@/stores/use-custom-workflow-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

// Execute site-level Agent tools in the browser, including canvas lists, workbench generation, prompt search, and asset operations.
// Their data lives locally in the browser through localforage and Zustand, so this module accesses the relevant stores directly.

export const SITE_TOOL_NAMES = [
    "canvas_list_projects",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "free_workflow_list_sources",
    "free_workflow_import",
    "free_workflow_graph",
    "free_workflow_health",
    "free_workflow_set_params",
    "free_workflow_configure",
    "free_workflow_sync",
    "free_workflow_rename",
    "free_workflow_build_request",
    "free_workflow_create_card",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get canvas_list_projects() { return siteText("canvasList"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get prompts_search() { return siteText("promptSearch"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
    get free_workflow_list_sources() { return "列出工作流源"; },
    get free_workflow_import() { return "导入工作流"; },
    get free_workflow_graph() { return "读取工作流图"; },
    get free_workflow_health() { return "工作流体检"; },
    get free_workflow_set_params() { return "写入披露参数"; },
    get free_workflow_configure() { return "配置页名/文本/模式"; },
    get free_workflow_sync() { return "同步工作流"; },
    get free_workflow_rename() { return "重命名工作流"; },
    get free_workflow_build_request() { return "干跑校验请求"; },
    get free_workflow_create_card() { return "创建自由卡片"; },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = { canvasSnapshot?: CanvasAgentSnapshot | null };
type GenerationStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
type GenerationStatusItem = { id: string; source: "canvas" | "image" | "video"; status: GenerationStatus; kind?: string; title?: string; prompt?: string; projectId?: string; createdAt?: string; updatedAt?: string; successCount?: number; failCount?: number; error?: string };

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}): Promise<unknown> {
    switch (name) {
        case "canvas_list_projects":
            return listCanvasProjects(input);
        case "generation_get_status":
            return getGenerationStatus(input, context.canvasSnapshot);
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_list":
            return listAssets(input);
        case "assets_add":
            return addAsset(input);
        case "free_workflow_list_sources":
            return listFreeWorkflowSources(input);
        case "free_workflow_import":
            return importFreeWorkflowTool(input);
        case "free_workflow_graph":
            return graphFreeWorkflow(input);
        case "free_workflow_health":
            return healthFreeWorkflow(input);
        case "free_workflow_set_params":
            return setFreeWorkflowParams(input);
        case "free_workflow_configure":
            return configureFreeWorkflow(input);
        case "free_workflow_sync":
            return syncFreeWorkflowTool(input);
        case "free_workflow_rename":
            return renameFreeWorkflowTool(input);
        case "free_workflow_build_request":
            return buildFreeWorkflowRequest(input);
        case "free_workflow_create_card":
            return createFreeWorkflowCard(input);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

function getGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" ? input.scope : "all";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const includeCanvas = (scope === "all" || scope === "canvas") && (!taskId || nodeIds.size > 0);
    const includeWorkbench = !nodeIds.size || Boolean(taskId);

    if (includeCanvas && canvasSnapshot) {
        canvasSnapshot.nodes.forEach((node) => {
            const status = normalizeCanvasGenerationStatus(node.metadata?.status);
            if (!status || (nodeIds.size && !nodeIds.has(node.id))) return;
            const metadata = node.metadata || {};
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            tasks.push({ id: node.id, source: "canvas", status, kind: metadata.generationMode || node.type, title: node.title, prompt: compactPrompt(metadata.prompt || metadata.composerContent), projectId: canvasSnapshot.projectId, error: metadata.errorDetails });
        });
    }

    if (includeWorkbench) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if ((scope === "image" || scope === "video") && task.kind !== scope) return;
            if (scope === "canvas" || (taskId && task.id !== taskId)) return;
            tasks.push({ ...task, source: task.kind, prompt: compactPrompt(task.prompt) });
        });
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    return { total: tasks.length, summary, tasks: tasks.slice(0, limit) };
}

function generationStatusOrder(status: GenerationStatus) {
    return status === "running" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function listCanvasProjects(input: SiteToolInput) {
    const { projects, hydrated } = useCanvasStore.getState();
    if (!hydrated) throw new Error(siteText("canvasLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = keyword ? projects.filter((project) => project.title.toLowerCase().includes(keyword)) : projects;
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((project) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
    }));
    return { total: filtered.length, page, pageSize, items, hint: siteText("canvasHint") };
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    return {
        current: { model, modelName: modelOptionName(model), quality: config.quality || "auto", size: config.size || "1:1", count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        qualityOptions: imageQualityOptions,
        scaleOptions: imageScaleOptions,
        sizeOptions: imageAspectOptions,
        countRange: { min: 1, max: 15 },
    };
}

function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/image");
    const taskId = useWorkbenchAgentStore.getState().dispatchImage({ prompt, run });
    return { ok: true, navigated: "/image", prompt, run, taskId, applied, note: siteText(run ? "imageGenerationStarted" : "imageConfigApplied") };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            size: config.size || "1280x720",
            seconds: config.videoSeconds || "6",
            resolution: config.vquality || "720",
            generateAudio: config.videoGenerateAudio !== "false",
            watermark: config.videoWatermark === "true",
            mode: config.videoMode === "reference" || config.videoMode === "text" ? config.videoMode : "frames",
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        sizeOptions: videoSizeOptions,
        secondsRange: videoSecondsRange,
        resolutionOptions: videoResolutionOptions,
        modeOptions: [
            { value: "frames", label: i18n.t("settingsPanels.video.modes.frames") },
            { value: "reference", label: i18n.t("settingsPanels.video.modes.reference") },
        ],
    };
}

function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.seconds != null && String(input.seconds).trim()) {
        const seconds = clampVideoSeconds(String(input.seconds));
        configStore.updateConfig("videoSeconds", seconds);
        applied.seconds = seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    if (input.mode === "frames" || input.mode === "reference") {
        configStore.updateConfig("videoMode", input.mode);
        applied.mode = input.mode;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/video");
    const taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt, run });
    return { ok: true, navigated: "/video", prompt, run, taskId, applied, note: siteText(run ? "videoGenerationStarted" : "videoConfigApplied") };
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}

function listAssets(input: SiteToolInput) {
    const { assets, hydrated } = useAssetStore.getState();
    if (!hydrated) throw new Error(siteText("assetsLoading"));
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" ? input.kind : "all";
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = assets.filter((asset) => {
        if (kind !== "all" && asset.kind !== kind) return false;
        if (!keyword) return true;
        return [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        coverUrl: asset.coverUrl || undefined,
        content: asset.kind === "text" ? asset.data.content : undefined,
    }));
    return { total: filtered.length, page, pageSize, items };
}

async function addAsset(input: SiteToolInput) {
    const kind = input.kind;
    const title = String(input.title || "").trim();
    if (!title) throw new Error(siteText("assetTitleRequired"));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const source = typeof input.source === "string" ? input.source : "Agent";
    const note = typeof input.note === "string" ? input.note : undefined;
    const store = useAssetStore.getState();
    if (kind === "text") {
        const content = String(input.content || "").trim();
        if (!content) throw new Error(siteText("textContentRequired"));
        const id = store.addAsset({ kind: "text", title, coverUrl: "", tags, source, note, data: { content } });
        return { ok: true, id, kind: "text" };
    }
    if (kind === "image") {
        const imageUrl = String(input.imageUrl || "").trim();
        if (!imageUrl) throw new Error(siteText("imageUrlRequired"));
        let stored;
        try {
            stored = await uploadImage(imageUrl);
        } catch {
            throw new Error(siteText("imageReadFailed"));
        }
        const id = store.addAsset({ kind: "image", title, coverUrl: stored.url, tags, source, note, data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
        return { ok: true, id, kind: "image" };
    }
    throw new Error(siteText("assetKindUnsupported"));
}

function freeWorkflowConfig() {
    return useConfigStore.getState().config;
}

function compactFreeWorkflow(summary: FreeWorkflowSummary) {
    return {
        id: summary.id,
        name: summary.name,
        sourceRel: summary.sourceRel,
        sourceFormat: summary.sourceFormat,
        outputType: summary.outputType,
        pageCount: summary.pageCount ?? 1,
        size: summary.size,
        aspectRatio: summary.aspectRatio,
        count: summary.count,
        hasSeed: summary.hasSeed,
        seed: summary.seed,
        textInputs: summary.textInputs || [],
        primaryText: summary.primaryText || null,
        flows: (summary.flows || []).map((flow) => ({ id: flow.id, label: flow.label, main: flow.main, outputs: flow.outputs, textInputs: flow.textInputs || [], primaryText: flow.primaryText || null })),
        params: summary.params || [],
        warnings: summary.warnings || [],
    };
}

function compactStoreEntry(entry: { id: string; freeId: string; name: string; outputType: string; kind: string; mode: string; flowId?: string; flowNames?: Record<string, string>; textSelection?: string[]; textNames?: Record<string, string>; blocks?: string[]; layout?: string[] }) {
    const view = customWorkflowView(entry as never);
    return { id: view.id, freeId: view.freeId, name: view.name, outputType: view.outputType, kind: view.kind, mode: view.mode, flowId: view.flowId || "", flowNames: view.flowNames || {}, textSelection: view.textSelection || [], textNames: view.textNames || {}, blocks: view.blocks || [], layout: view.layout || [] };
}

async function listFreeWorkflowSources(input: SiteToolInput) {
    const sources = await fetchFreeWorkflowSources(freeWorkflowConfig());
    const query = String(input.query || "").trim().toLowerCase();
    const kind = String(input.kind || "").trim();
    const filtered = sources.filter((source) => !query || `${source.name} ${source.relative}`.toLowerCase().includes(query));
    return { kind, total: filtered.length, sources: filtered.map((source) => ({ rel: source.relative, name: source.name, folder: source.folder, format: source.format, signature: source.updatedAt || "", updatedAt: source.updatedAt || "" })) };
}

async function importFreeWorkflowTool(input: SiteToolInput) {
    const config = freeWorkflowConfig();
    const sourceRel = String(input.sourceRel || "").trim();
    if (!sourceRel) throw new Error("sourceRel 不能为空");
    const name = String(input.name || "").trim();
    const existing = (await fetchFreeWorkflows(config)).find((workflow) => workflow.sourceRel === sourceRel && !workflow.snapshot);
    let summary: FreeWorkflowSummary;
    let mode = "imported";
    if (existing) {
        try {
            const result = await syncFreeWorkflow(config, existing.id, true);
            summary = result.workflow;
            mode = result.changed ? "synced" : "reused";
        } catch {
            summary = existing;
            mode = "reused";
        }
    } else {
        summary = await importFreeWorkflow(config, sourceRel);
    }
    if (name && summary.name !== name) summary = await renameFreeWorkflow(config, summary.id, name);
    const storeEntry = await ensureFreeCardWorkflowEntry(summary, { params: summary.params || [] });
    return { mode, existing: Boolean(existing), requestedKind: String(input.kind || ""), entry: { ...compactFreeWorkflow(summary), storeId: storeEntry.id } };
}

async function graphFreeWorkflow(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    return fetchFreeWorkflowGraph(freeWorkflowConfig(), id, String(input.flowId || ""));
}

async function healthFreeWorkflow(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    return fetchFreeWorkflowHealth(freeWorkflowConfig(), id, String(input.flowId || ""));
}

async function setFreeWorkflowParams(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    const params = Array.isArray(input.params) ? input.params : [];
    if (!id) throw new Error("id 不能为空");
    if (!params.length) throw new Error("params 不能为空");
    const summary = await saveFreeWorkflowParams(freeWorkflowConfig(), id, params as FreeWorkflowParam[]);
    const entry = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.freeId === id || workflow.id === id);
    if (entry) {
        const view = customWorkflowView(entry);
        useCustomWorkflowStore.getState().setParams(entry.id, params as FreeWorkflowParam[], (params as FreeWorkflowParam[]).map((param) => param.key), view.spans || {}, view.blocks || []);
    }
    return { entry: compactFreeWorkflow(summary) };
}

function configureFreeWorkflow(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    const store = useCustomWorkflowStore.getState();
    const entry = store.workflows.find((workflow) => workflow.freeId === id || workflow.id === id);
    if (!entry) throw new Error("工作流条目不存在");
    const view = customWorkflowView(entry);
    const flowId = String(input.flowId || view.flowId || "");
    if (input.flowNames && typeof input.flowNames === "object") {
        for (const [target, value] of Object.entries(input.flowNames as Record<string, unknown>)) store.setFlowName(entry.id, target, String(value || ""));
    }
    const primary = input.primaryText && typeof input.primaryText === "object" ? (input.primaryText as { node?: unknown; input?: unknown }) : null;
    const textInputs = view.textInputs || [];
    const normalizeTextKey = (value: string) => {
        if (value.includes("\u0000")) return value;
        const match = textInputs.find((item) => `${item.node}:${item.input}` === value);
        return match ? `${match.node}\u0000${match.input}` : value;
    };
    let selection = Array.isArray(input.textSelection) ? input.textSelection.map((key) => normalizeTextKey(String(key))).filter(Boolean).slice(0, 4) : null;
    if (primary?.node && primary.input) {
        const key = `${String(primary.node)}\u0000${String(primary.input)}`;
        selection = [...new Set([key, ...(selection || view.textSelection || []).map((item) => normalizeTextKey(String(item)))])].slice(0, 4);
    } else if (selection) {
        selection = [...new Set(selection)].slice(0, 4);
    }
    if (selection) store.setTextSelection(entry.id, flowId, selection);
    if (input.textNames && typeof input.textNames === "object") {
        for (const [key, value] of Object.entries(input.textNames as Record<string, unknown>)) store.setTextName(entry.id, flowId, normalizeTextKey(String(key)), String(value || ""));
    }
    if (input.mode) store.setPageMode(entry.id, flowId, String(input.mode) as CustomWorkflowMode);
    if (Array.isArray(input.blocks) || Array.isArray(input.layout)) {
        const current = customWorkflowView(entry);
        store.setParams(entry.id, current.params, Array.isArray(input.layout) ? input.layout.map(String) : current.layout || [], current.spans || {}, Array.isArray(input.blocks) ? input.blocks.map(String) : current.blocks || []);
    }
    const updated = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.id === entry.id) || entry;
    return { entry: compactStoreEntry(updated) };
}

async function syncFreeWorkflowTool(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    const result = await syncFreeWorkflow(freeWorkflowConfig(), id, Boolean(input.force));
    const entry = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.freeId === id || workflow.id === id);
    if (entry) useCustomWorkflowStore.getState().applySourceUpdate(entry.id, result.workflow);
    return { changed: result.changed, entry: compactFreeWorkflow(result.workflow) };
}

async function renameFreeWorkflowTool(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    const name = String(input.name || "").trim();
    if (!id || !name) throw new Error("id 和 name 不能为空");
    const summary = await renameFreeWorkflow(freeWorkflowConfig(), id, name);
    const entry = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.freeId === id || workflow.id === id);
    if (entry) useCustomWorkflowStore.getState().renameWorkflow(entry.id, name);
    return { entry: compactFreeWorkflow(summary) };
}

async function buildFreeWorkflowRequest(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    return validateFreeWorkflowRequest(freeWorkflowConfig(), id, {
        flowId: input.flowId,
        prompt: input.prompt,
        texts: input.texts,
        primaryText: input.primaryText,
        size: input.size,
        seed: input.seed,
        count: input.count,
        seedFixed: input.seedFixed,
        ratio: input.ratio,
        images: input.images,
        enableGroups: input.enableGroups,
    });
}

async function createFreeWorkflowCard(input: SiteToolInput) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("id 不能为空");
    const config = freeWorkflowConfig();
    const summary = await fetchFreeWorkflow(config, id);
    if (summary.outputType !== "image" && summary.outputType !== "video") throw new Error("自由卡片目前只接图片/视频工作流；其他请用标准卡");
    const entry = await ensureFreeCardWorkflowEntry(summary, { params: summary.params || [] });
    const context = useAgentStore.getState().canvasContext;
    if (!context) throw new Error("当前不在画布页面，无法建卡");
    const patch = freeCardMetadataPatch(summary, entry.id, true);
    const refs = Array.isArray(input.refs) ? input.refs.filter((item): item is string => typeof item === "string") : [];
    const requested = String(input.nodeId || "").trim();
    const target = requested ? context.snapshot.nodes.find((node) => node.id === requested && node.type === CanvasNodeType.FreeCard) : undefined;
    const nodeId = target?.id || `free-card-${Date.now()}`;
    const ops: CanvasAgentOp[] = target
        ? [{ type: "update_node", id: nodeId, metadata: patch }]
        : [{ type: "add_node", id: nodeId, nodeType: CanvasNodeType.FreeCard, metadata: patch }];
    refs.forEach((fromNodeId) => ops.push({ type: "connect_nodes", fromNodeId, toNodeId: nodeId }));
    ops.push({ type: "select_nodes", ids: [nodeId] });
    context.applyOps(ops);
    const stored = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.id === entry.id);
    return {
        ok: true,
        nodeId,
        reusedCard: Boolean(target),
        entryId: entry.id,
        workflow: compactFreeWorkflow(summary),
        entry: stored ? compactStoreEntry(stored) : null,
        next: "卡片已建好；真实生成需用户确认后再触发。",
    };
}

function paginate(input: SiteToolInput, total: number, defaultSize: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || defaultSize));
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(input.page)) || 1));
    const start = (page - 1) * pageSize;
    return { page, pageSize, start, end: start + pageSize };
}
