import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { gatewayFetch } from "@/services/api/gateway-status";

const GATEWAY_ROOT = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

export type Scene3DTaskState = {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    progress: number;
    url?: string | null;
    bytes?: number;
    error?: string | null;
};

const ERROR_TEXT: Record<string, string> = {
    missing_input_image: "缺少输入图片",
    missing_scene3d_workflow: "3D 场景工作流未注册，请检查资源",
    missing_scene3d_image_runtime: "3D 场景缺少图像处理环境",
    no_pano_image: "全景扩图没有返回图片",
    no_seam_image: "接缝修复没有返回图片",
    scene3d_quality_failed: "接缝或构图未通过质量检查，请更换图片重试",
};

async function readScene3DError(response: Response): Promise<Error> {
    if (response.status === 404) return new Error("3D 场景服务未接入，请更新网关后重试");
    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        // 非 JSON 错误体保留状态码。
    }
    const code = String(payload?.error?.code || payload?.code || "");
    const message = String(payload?.error?.message || payload?.error || payload?.message || ERROR_TEXT[code] || `HTTP ${response.status}`);
    return new Error(message);
}

export type Scene3DCreateResult = { taskId?: string; panoramaUrl?: string; width?: number; height?: number };
export type Scene3DOffset = { x: number; y: number };

export async function createScene3DJob(image: File, prompt: string, offset?: Scene3DOffset, signal?: AbortSignal): Promise<Scene3DCreateResult> {
    const form = new FormData();
    form.set("image", image, image.name || "scene.png");
    if (prompt.trim()) form.set("prompt", prompt.trim());
    if (offset) {
        form.set("offset_x", String(offset.x));
        form.set("offset_y", String(offset.y));
        form.set("offsetX", String(offset.x));
        form.set("offsetY", String(offset.y));
    }
    let response: Response;
    try {
        response = await gatewayFetch(`${GATEWAY_ROOT}/v1/images/scene3d`, { method: "POST", body: form, signal });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error("3D 场景服务未接入，请检查本地网关");
    }
    if (!response.ok) throw await readScene3DError(response);
    const data = (await response.json().catch(() => ({}))) as any;
    const id = String(data.id || data.taskId || data.task_id || "");
    if (id) return { taskId: id };
    const panoramaUrl = String(data.panorama?.url || "");
    if (panoramaUrl) return { panoramaUrl, width: Number(data.panorama?.width) || 0, height: Number(data.panorama?.height) || 0 };
    throw new Error("3D 场景服务没有返回任务");
}

export async function getScene3DTask(id: string, signal?: AbortSignal): Promise<Scene3DTaskState> {
    let response: Response;
    try {
        response = await gatewayFetch(`${GATEWAY_ROOT}/v1/tasks/${encodeURIComponent(id)}`, { signal });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error("无法连接本地网关");
    }
    if (!response.ok) throw await readScene3DError(response);
    const data = (await response.json().catch(() => ({}))) as any;
    const status = String(data.status || "failed") as Scene3DTaskState["status"];
    return {
        id,
        status,
        progress: Number(data.progress) || 0,
        url: data.url || data.panorama?.url || null,
        bytes: Number(data.bytes) || 0,
        error: typeof data.error === "string" ? data.error : data.error?.message || null,
    };
}

export async function cancelScene3DTask(id: string): Promise<void> {
    try {
        const response = await gatewayFetch(`${GATEWAY_ROOT}/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
        if (response.ok) return;
    } catch {
        // 兼容尚未提供 tasks 取消路由的网关。
    }
    try {
        await gatewayFetch(`${GATEWAY_ROOT}/v1/videos/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    } catch {
        // 停止只保证前端不再轮询；网关取消失败不阻塞。
    }
}
