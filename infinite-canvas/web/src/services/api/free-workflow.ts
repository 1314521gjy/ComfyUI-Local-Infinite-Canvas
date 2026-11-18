import axios from "axios";
import { nanoid } from "nanoid";

import { attachLocalCancel, attachLocalProgress, localGatewayRoot } from "@/services/api/image";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type FreeWorkflowSource = {
    id: string;
    name: string;
    folder: string;
    relative: string;
    format: "ui" | "api" | "invalid";
    updatedAt: string;
};

export type FreeWorkflowPreset = {
    size?: string;
    aspectRatio?: string;
    count?: number;
    seed?: string;
    seedFixed?: string;
};

export type FreeWorkflowParam = {
    key: string;
    node: string;
    input: string;
    label: string;
    group: string;
    type: "number" | "select" | "boolean" | "string";
    value: string | number | boolean;
    options?: string[];
    min?: number;
    max?: number;
    step?: number;
};

export type FreeWorkflowGraphInput = {
    name: string;
    label: string;
    linked: boolean;
    literal: boolean;
    value: string | number | boolean | null;
    type: "number" | "select" | "boolean" | "string" | "json" | "linked";
    options: string[];
};

export type FreeWorkflowGraphNode = {
    id: string;
    class_type: string;
    title: string;
    pos: { x: number; y: number } | null;
    size: { width: number; height: number } | null;
    inputs: FreeWorkflowGraphInput[];
};

export type FreeWorkflowGraph = {
    id: string;
    name: string;
    sourceFormat: "ui" | "api";
    nodes: FreeWorkflowGraphNode[];
    links: Array<{ from: string; to: string; toInput: string }>;
    params: FreeWorkflowParam[];
    warnings: string[];
    problems: FreeWorkflowProblem[];
    comfyUrl?: string;
};

export type FreeWorkflowPass = { index: number; node: string; label: string; steps: number | null };

export type FreeWorkflowSelfLift = { node: string; lowSteps: number | null; totalSteps: number | null; highSteps: number | null };

export type FreeWorkflowProblem = { node: string; title: string; input: string; reason: string };

export type FreeWorkflowTextInput = {
    node: string;
    input: string;
    label: string;
    default: string;
    role: string;
};

export type FreeWorkflowTextBinding = { node: string; input: string; label?: string };

export type FreeWorkflowOpenTarget = {
    url: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    bridge: boolean;
    bridgeReason?: string;
};

export type FreeWorkflowSummary = {
    id: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    outputType: "image" | "video" | null;
    kind?: "image" | "video" | "other";
    mode?: "t2i" | "i2i" | "edit" | "text" | "frames" | "reference" | "generic";
    archived: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
    sourceChanged: boolean;
    sourceMissing?: boolean;
    prompt: boolean;
    primaryText?: FreeWorkflowTextBinding | null;
    textInputs?: FreeWorkflowTextInput[];
    imageInputs: number;
    maskInputs?: number;
    maskMode?: "separate" | "alpha" | null;
    maskRequired?: boolean;
    size: { width: number; height: number } | null;
    aspectRatio?: string | null;
    aspectRatios?: string[];
    count: number | null;
    hasSeed: boolean;
    seed: string | null;
    preset?: FreeWorkflowPreset | null;
    snapshot?: boolean;
    snapshotOf?: string | null;
    snapshotAt?: string | null;
    snapshotPageId?: string;
    snapshotPageLabel?: string;
    pageCount?: number;
    textLabels?: string[];
    snapshotCard?: {
        prompt?: string;
        customTexts?: Record<string, string>;
        customTextActive?: string;
        size?: string;
        aspectRatio?: string;
        count?: number;
        seed?: string;
        seedFixed?: string;
    } | null;
    params?: FreeWorkflowParam[];
    selfLift?: FreeWorkflowSelfLift | null;
    passes?: FreeWorkflowPass[];
    stages?: Array<{ id: string; label: string; nodes: string[]; defaultOff?: boolean }>;
    flows?: Array<{ id: string; label?: string; nodeIds: string[]; outputs: string[]; main: boolean; maskInputs?: number; stages?: Array<{ id: string; label: string; nodes: string[]; defaultOff?: boolean }>; problems?: FreeWorkflowProblem[]; textInputs?: FreeWorkflowTextInput[]; primaryText?: FreeWorkflowTextBinding | null }>;
    problems?: FreeWorkflowProblem[];
    warnings: string[];
};

export type FreeWorkflowHealth = {
    id: string;
    flowId: string;
    objectInfoReady: boolean;
    issues: Array<{ node: string; title: string; input: string; reason: string }>;
    missingNodes: string[];
    missingModels: Array<{ node: string; input: string; value: string; classType: string; options: string[] }>;
    reachableOutputs: Array<{ node: string; title: string; classType: string }>;
    warnings: string[];
};

export type FreeWorkflowValidation = {
    valid: boolean;
    errors: Array<{ node?: string; input?: string; reason: string }>;
    request: {
        entryId: string;
        flowId: string;
        nodeCount: number;
        outputs: Array<{ node: string; title: string; classType: string }>;
        prompt: string;
        texts: Array<{ node: string; input: string; value: string }>;
        primaryText: FreeWorkflowTextBinding | null;
        size: string;
        seed: unknown;
        count: unknown;
        images: string[];
    };
};

export type FreeWorkflowOutputEntry = {
    filename: string;
    subfolder: string;
    mimeType: string;
    b64_json?: string;
    url?: string;
    dataUrl: string;
};

export type FreeWorkflowOutputGroup = {
    nodeId: string;
    title: string;
    type: "output" | "temp";
    preview: boolean;
    kind: "image" | "video" | "audio";
    entries: FreeWorkflowOutputEntry[];
};

export type FreeWorkflowImageResult = {
    outputs: FreeWorkflowOutputGroup[];
    images: Array<{ id: string; dataUrl: string }>;
    primaryNodeId: string;
    previewFallback: boolean;
    warnings: string[];
};

export type FreeWorkflowRequest = {
    prompt: string;
    size?: string;
    ratio?: string;
    count?: number;
    seed?: string;
    seedFixed?: boolean;
    params?: Record<string, unknown>;
    loras?: Array<{ name: string; strength?: number; enabled?: boolean }>;
    bypassStages?: string[];
    enableGroups?: string[];
    flowId?: string;
    fields?: FreeWorkflowParam[];
    texts?: Array<{ node: string; input: string; value: string }>;
    primaryText?: FreeWorkflowTextBinding | null;
    images?: ReferenceImage[];
    mask?: ReferenceImage;
    signal?: AbortSignal;
};

function gatewayRoot(config: AiConfig) {
    const root = localGatewayRoot(config.baseUrl);
    if (!root) throw new Error("自由卡片只支持本地网关");
    return root;
}

function readError(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as { error?: { message?: string }; message?: string; msg?: string } | undefined;
        return data?.error?.message || data?.message || data?.msg || error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

export async function fetchFreeWorkflowSources(config: AiConfig): Promise<FreeWorkflowSource[]> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ sources?: FreeWorkflowSource[] }>(`${root}/api/free-workflows/sources`, { timeout: 30000 });
    return Array.isArray(response.data?.sources) ? response.data.sources : [];
}

export async function fetchFreeWorkflows(config: AiConfig, archived = false): Promise<FreeWorkflowSummary[]> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ workflows?: FreeWorkflowSummary[] }>(`${root}/api/free-workflows${archived ? "?archived=1" : ""}`, { timeout: 30000 });
    return Array.isArray(response.data?.workflows) ? response.data.workflows : [];
}

export async function fetchFreeWorkflow(config: AiConfig, id: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { timeout: 30000 });
    if (!response.data?.workflow) throw new Error("自由卡片读取失败");
    return response.data.workflow;
}

export async function fetchFreeWorkflowGraph(config: AiConfig, id: string, flowId = ""): Promise<FreeWorkflowGraph> {
    const root = gatewayRoot(config);
    const response = await axios.get<FreeWorkflowGraph>(`${root}/api/free-workflows/${encodeURIComponent(id)}/graph`, { params: flowId ? { flowId } : undefined, timeout: 120000 });
    if (!response.data?.nodes) throw new Error("读取工作流节点失败");
    return response.data;
}

/** 只读体检：节点/模型是否在库、是否有可达输出；不提交 ComfyUI。 */
export async function fetchFreeWorkflowHealth(config: AiConfig, id: string, flowId = ""): Promise<FreeWorkflowHealth> {
    const root = gatewayRoot(config);
    const response = await axios.get<FreeWorkflowHealth>(`${root}/api/free-workflows/${encodeURIComponent(id)}/health`, { params: flowId ? { flowId } : undefined, timeout: 60000 });
    return response.data;
}

/** G6 干跑：组装并校验请求体；不提交、不跑 GPU。 */
export async function validateFreeWorkflowRequest(config: AiConfig, id: string, request: Record<string, unknown>): Promise<FreeWorkflowValidation> {
    const root = gatewayRoot(config);
    const response = await axios.post<FreeWorkflowValidation>(`${root}/api/free-workflows/${encodeURIComponent(id)}/validate`, request, { timeout: 60000 });
    return response.data;
}

export async function openFreeWorkflow(config: AiConfig, id: string): Promise<FreeWorkflowOpenTarget> {
    const root = gatewayRoot(config);
    const response = await axios.get<FreeWorkflowOpenTarget>(`${root}/api/free-workflows/${encodeURIComponent(id)}/open`, { timeout: 30000 });
    if (!response.data?.url) throw new Error("无法获取 ComfyUI 工作流地址");
    return response.data;
}

export async function saveFreeWorkflowParams(config: AiConfig, id: string, params: FreeWorkflowParam[]): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.put<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/params`, { params }, { timeout: 30000 });
    if (!response.data?.workflow) throw new Error("保存参数失败");
    return response.data.workflow;
}

export async function importFreeWorkflow(config: AiConfig, relative: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/import`, { path: relative }, { timeout: 120000 });
        if (!response.data?.workflow) throw new Error("自由卡片导入失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "自由卡片导入失败"));
    }
}

export async function importUploadedFreeWorkflow(config: AiConfig, name: string, content: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/import-upload`, { name, content }, { timeout: 120000 });
        if (!response.data?.workflow) throw new Error("工作流导入失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "工作流导入失败"));
    }
}

export async function syncFreeWorkflow(config: AiConfig, id: string, force = false): Promise<{ changed: boolean; workflow: FreeWorkflowSummary }> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ changed?: boolean; workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/sync${force ? "?force=1" : ""}`, {}, { timeout: 120000 });
        if (!response.data?.workflow) throw new Error("同步工作流失败");
        return { changed: Boolean(response.data.changed), workflow: response.data.workflow };
    } catch (error) {
        throw new Error(readError(error, "同步工作流失败"));
    }
}

export async function archiveFreeWorkflow(config: AiConfig, id: string, archived = true, preset?: FreeWorkflowPreset): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.patch<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { archived, preset }, { timeout: 30000 });
    if (!response.data?.workflow) throw new Error("归档自由卡片失败");
    return response.data.workflow;
}

export type FreeWorkflowSnapshotPayload = {
    name?: string;
    config: unknown;
    card: NonNullable<FreeWorkflowSummary["snapshotCard"]>;
    mode?: string;
    flowId?: string;
};

export type FreeWorkflowSnapshotDetail = {
    id: string;
    snapshotOf: string | null;
    snapshotAt: string | null;
    pageId: string;
    config: unknown;
    card: FreeWorkflowSnapshotPayload["card"] | null;
};

export async function createFreeWorkflowSnapshot(config: AiConfig, id: string, payload: FreeWorkflowSnapshotPayload): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    const response = await axios.post<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/snapshots`, payload, { timeout: 120000 });
    if (!response.data?.workflow) throw new Error("归档自由卡片失败");
    return response.data.workflow;
}

export async function fetchFreeWorkflowSnapshot(config: AiConfig, id: string): Promise<FreeWorkflowSnapshotDetail> {
    const root = gatewayRoot(config);
    const response = await axios.get<FreeWorkflowSnapshotDetail>(`${root}/api/free-workflows/${encodeURIComponent(id)}/snapshot`, { timeout: 30000 });
    if (!response.data?.config) throw new Error("归档快照读取失败");
    return response.data;
}

export async function deleteFreeWorkflow(config: AiConfig, id: string): Promise<void> {
    const root = gatewayRoot(config);
    try {
        await axios.delete(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { timeout: 30000 });
    } catch (error) {
        throw new Error(readError(error, "删除自由卡片失败"));
    }
}

export async function renameFreeWorkflow(config: AiConfig, id: string, name: string): Promise<FreeWorkflowSummary> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.patch<{ workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}`, { name }, { timeout: 30000 });
        if (!response.data?.workflow) throw new Error("重命名自由卡片失败");
        return response.data.workflow;
    } catch (error) {
        throw new Error(readError(error, "重命名自由卡片失败"));
    }
}

export async function freeWorkflowComfyUrl(config: AiConfig, id: string): Promise<{ url: string; name: string; sourceRel: string; sourceFormat: "ui" | "api"; bridge: boolean; bridgeReason?: string }> {
    const root = gatewayRoot(config);
    const response = await axios.get<{ url?: string; name?: string; sourceRel?: string; sourceFormat?: "ui" | "api"; bridge?: boolean; bridgeReason?: string }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/open`, { timeout: 15000 });
    if (!response.data?.url) throw new Error("无法获取 ComfyUI 地址");
    return {
        url: response.data.url,
        name: response.data.name || "",
        sourceRel: response.data.sourceRel || "",
        sourceFormat: response.data.sourceFormat || "ui",
        bridge: Boolean(response.data.bridge),
        bridgeReason: response.data.bridgeReason,
    };
}

async function buildFormData(config: AiConfig, request: FreeWorkflowRequest) {
    const formData = new FormData();
    formData.set("prompt", request.prompt);
    if (request.size) formData.set("size", request.size);
    if (request.ratio) formData.set("ratio", request.ratio);
    if (request.count) formData.set("n", String(request.count));
    if (request.seed) formData.set("seed", request.seed);
    formData.set("seedFixed", request.seedFixed ? "true" : "false");
    if (request.params && Object.keys(request.params).length) formData.set("params", JSON.stringify(request.params));
    if (request.loras?.length) formData.set("loras", JSON.stringify(request.loras));
    if (request.bypassStages?.length) formData.set("bypassStages", JSON.stringify(request.bypassStages));
    if (request.enableGroups?.length) formData.set("enableGroups", JSON.stringify(request.enableGroups));
    if (request.flowId) formData.set("flowId", request.flowId);
    if (request.fields?.length) formData.set("fields", JSON.stringify(request.fields));
    if (request.texts?.length) formData.set("texts", JSON.stringify(request.texts));
    if (request.primaryText) formData.set("primaryText", JSON.stringify(request.primaryText));
    formData.set("response_format", "b64_json");
    const images = request.images || [];
    const files = await Promise.all(images.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file, index) => formData.append(index === 0 ? "image" : `image${index + 1}`, file, file.name));
    if (request.mask) {
        const maskFile = await dataUrlToFile({ ...request.mask, dataUrl: await imageToDataUrl(request.mask) });
        formData.append("mask", maskFile, maskFile.name);
    }
    return formData;
}

export async function requestFreeWorkflowImage(config: AiConfig, id: string, request: FreeWorkflowRequest): Promise<FreeWorkflowImageResult> {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    const requestId = `free_${nanoid()}`;
    const detachCancel = attachLocalCancel(config, requestId, request.signal);
    const detachProgress = attachLocalProgress(config, requestId, request.signal);
    try {
        const response = await axios.post<{
            data?: Array<{ b64_json?: string; url?: string }>;
            outputs?: Array<{
                nodeId?: string;
                title?: string;
                type?: "output" | "temp";
                preview?: boolean;
                kind?: "image" | "video" | "audio";
                entries?: Array<{ filename?: string; subfolder?: string; mimeType?: string; b64_json?: string; url?: string }>;
            }>;
            primaryNodeId?: string;
            previewFallback?: boolean;
            warnings?: string[];
        }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/images`, formData, {
            headers: { "X-Request-Id": requestId },
            signal: request.signal,
            timeout: 10 * 60 * 1000,
        });
        const toDataUrl = (entry: { b64_json?: string; url?: string; mimeType?: string }) =>
            entry.b64_json ? `data:${entry.mimeType || "image/png"};base64,${entry.b64_json}` : entry.url || "";
        const outputs: FreeWorkflowOutputGroup[] = (response.data?.outputs || [])
            .map((group) => ({
                nodeId: String(group.nodeId || ""),
                title: String(group.title || group.nodeId || "输出"),
                type: group.type === "temp" ? ("temp" as const) : ("output" as const),
                preview: Boolean(group.preview),
                kind: group.kind === "video" ? ("video" as const) : group.kind === "audio" ? ("audio" as const) : ("image" as const),
                entries: (group.entries || [])
                    .map((entry) => ({
                        ...entry,
                        filename: String(entry.filename || ""),
                        subfolder: entry.subfolder || "",
                        mimeType: entry.mimeType || "image/png",
                        dataUrl: toDataUrl(entry),
                    }))
                    .filter((entry) => entry.dataUrl),
            }))
            .filter((group) => group.entries.length);
        if (!outputs.length) {
            const legacy = (response.data?.data || [])
                .map((entry, index) => ({
                    filename: `output_${index}`,
                    subfolder: "",
                    mimeType: "image/png",
                    ...entry,
                    dataUrl: toDataUrl(entry),
                }))
                .filter((entry) => entry.dataUrl);
            if (legacy.length) outputs.push({ nodeId: "output", title: "输出", type: "output", preview: false, kind: "image", entries: legacy });
        }
        if (!outputs.length) throw new Error("自由工作流没有返回图片");
        const images = outputs.flatMap((group) => group.entries).map((entry) => ({ id: nanoid(), dataUrl: entry.dataUrl }));
        return {
            outputs,
            images,
            primaryNodeId: String(response.data?.primaryNodeId || outputs[0]?.nodeId || ""),
            previewFallback: Boolean(response.data?.previewFallback),
            warnings: Array.isArray(response.data?.warnings) ? response.data.warnings.map(String) : [],
        };
    } catch (error) {
        throw new Error(readError(error, "自由工作流生成失败"));
    } finally {
        detachCancel?.();
        detachProgress?.();
    }
}

export async function createFreeWorkflowVideoTask(config: AiConfig, id: string, request: FreeWorkflowRequest) {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    try {
        const response = await axios.post<{ id?: string }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/videos`, formData, {
            signal: request.signal,
            timeout: 120000,
        });
        if (!response.data?.id) throw new Error("自由工作流没有返回视频任务");
        return response.data.id;
    } catch (error) {
        throw new Error(readError(error, "自由工作流视频任务创建失败"));
    }
}
