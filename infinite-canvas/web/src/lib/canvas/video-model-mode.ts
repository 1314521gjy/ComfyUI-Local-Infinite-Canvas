import { channelModelOf, modelOptionName, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

const NO_VDN_SUFFIX = "-novdn";

export function videoWorkflowId(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.workflowId || modelOptionName(model);
}

export function isNoVdnWorkflowId(workflowId: string) {
    return String(workflowId || "").endsWith(NO_VDN_SUFFIX);
}

export function baseVideoWorkflowId(workflowId: string) {
    return String(workflowId || "").replace(/-novdn$/, "");
}

export function videoModelForWorkflow(config: AiConfig, workflowId: string, options?: { noVdn?: boolean }) {
    const optionsList = workflowModelOptions(config, "video");
    const target = options?.noVdn ? `${workflowId}${NO_VDN_SUFFIX}` : workflowId;
    const exact = optionsList.find((value) => videoWorkflowId(config, value) === target);
    if (exact) return exact;
    return optionsList.find((value) => videoWorkflowId(config, value) === workflowId) || "";
}

export function videoModelModePatch(config: AiConfig, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const workflowId = baseVideoWorkflowId(videoWorkflowId(config, model));
    if (workflowId === "video-h3-ref2va") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-character-swap") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-frames") return { model, videoMode: "frames" };
    if (workflowId === "video-h3-t2v") return { model, videoMode: "text" };
    return { model };
}