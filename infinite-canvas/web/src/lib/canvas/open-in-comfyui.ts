import { openFreeWorkflow, type FreeWorkflowOpenTarget } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";

export const COMFY_WORKFLOW_WINDOW_NAME = "local-canvas-comfyui";

function isBlankWindow(win: Window) {
    try {
        return win.location.href === "about:blank";
    } catch {
        return false;
    }
}

export async function openWorkflowInComfyUI(config: AiConfig, freeId: string): Promise<FreeWorkflowOpenTarget> {
    // 必须在点击同步阶段占位，否则 await 后 window.open 会被浏览器拦截。
    const popup = window.open("", COMFY_WORKFLOW_WINDOW_NAME);
    popup?.focus();
    try {
        const target = await openFreeWorkflow(config, freeId);
        if (popup) {
            popup.location.href = target.url;
            popup.focus();
        } else {
            const opened = window.open(target.url, COMFY_WORKFLOW_WINDOW_NAME);
            if (!opened) throw new Error("浏览器拦截了 ComfyUI 窗口，请允许本站弹出窗口");
        }
        return target;
    } catch (error) {
        if (popup && isBlankWindow(popup)) popup.close();
        throw error;
    }
}
