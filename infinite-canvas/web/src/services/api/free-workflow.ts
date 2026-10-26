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

export type FreeWorkflowSummary = {
    id: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    outputType: "image" | "video" | null;
    archived: boolean;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
    sourceChanged: boolean;
    sourceMissing?: boolean;
    prompt: boolean;
    imageInputs: number;
    size: { width: number; height: number } | null;
    aspectRatio?: string | null;
    aspectRatios?: string[];
    count: number | null;
    hasSeed: boolean;
    seed: string | null;
    preset?: FreeWorkflowPreset | null;
    warnings: string[];
};

export type FreeWorkflowRequest = {
    prompt: string;
    size?: string;
    ratio?: string;
    count?: number;
    seed?: string;
    seedFixed?: boolean;
    images?: ReferenceImage[];
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

export async function syncFreeWorkflow(config: AiConfig, id: string): Promise<{ changed: boolean; workflow: FreeWorkflowSummary }> {
    const root = gatewayRoot(config);
    try {
        const response = await axios.post<{ changed?: boolean; workflow?: FreeWorkflowSummary }>(`${root}/api/free-workflows/${encodeURIComponent(id)}/sync`, {}, { timeout: 120000 });
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
    formData.set("response_format", "b64_json");
    const images = request.images || [];
    const files = await Promise.all(images.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file, index) => formData.append(index === 0 ? "image" : `image${index + 1}`, file, file.name));
    return formData;
}

export async function requestFreeWorkflowImage(config: AiConfig, id: string, request: FreeWorkflowRequest) {
    const root = gatewayRoot(config);
    const formData = await buildFormData(config, request);
    const requestId = `free_${nanoid()}`;
    const detachCancel = attachLocalCancel(config, requestId, request.signal);
    const detachProgress = attachLocalProgress(config, requestId, request.signal);
    try {
        const response = await axios.post<{ data?: Array<{ b64_json?: string; url?: string }> }>(`${root}/v1/free-workflows/${encodeURIComponent(id)}/images`, formData, {
            headers: { "X-Request-Id": requestId },
            signal: request.signal,
            timeout: 10 * 60 * 1000,
        });
        const items = response.data?.data || [];
        const images = items
            .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url || ""))
            .filter(Boolean)
            .map((dataUrl) => ({ id: nanoid(), dataUrl }));
        if (!images.length) throw new Error("自由工作流没有返回图片");
        return images;
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
