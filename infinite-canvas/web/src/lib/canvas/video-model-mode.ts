import { channelModelOf, modelOptionName, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

export function videoWorkflowId(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.workflowId || modelOptionName(model);
}

export function videoModelForWorkflow(config: AiConfig, workflowId: string) {
    return workflowModelOptions(config, "video").find((value) => channelModelOf(config, value)?.model.workflowId === workflowId) || "";
}

export function videoModelModePatch(config: AiConfig, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const workflowId = videoWorkflowId(config, model);
    if (workflowId === "video-h3-ref2va") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-frames") return { model, videoMode: "frames" };
    if (workflowId === "video-h3-t2v") return { model, videoMode: "text" };
    return { model };
}
