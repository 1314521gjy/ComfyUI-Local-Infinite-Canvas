import { channelModelOf, modelOptionName, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

const NO_VDN_SUFFIX = "-novdn";
const HYPERFLOW_FAMILY = /^video-hyperflow-(t2v|frames|ref2va)-6p2$/;

export function videoWorkflowId(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.workflowId || modelOptionName(model);
}

export function isNoVdnWorkflowId(workflowId: string) {
    return String(workflowId || "").endsWith(NO_VDN_SUFFIX);
}

export function isFastH3Model(config: AiConfig, model: string) {
    return baseVideoWorkflowId(videoWorkflowId(config, model)) === "video-h3-fast";
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

export function hyperflowModeOf(workflowId: string): "text" | "frames" | "reference" | undefined {
    const match = HYPERFLOW_FAMILY.exec(baseVideoWorkflowId(workflowId));
    if (!match) return undefined;
    return match[1] === "t2v" ? "text" : match[1] === "frames" ? "frames" : "reference";
}

const H3_MULTI_MODE_IDS = new Set(["video-h3-ref2va"]);

export function isMultiModeVideoWorkflow(workflowId: string) {
    const base = baseVideoWorkflowId(workflowId);
    return H3_MULTI_MODE_IDS.has(base) || Boolean(hyperflowModeOf(base));
}

export function videoModelModePatch(config: AiConfig, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const workflowId = baseVideoWorkflowId(videoWorkflowId(config, model));
    if (isMultiModeVideoWorkflow(workflowId)) return { model };
    if (workflowId === "video-h3-character-swap" || workflowId === "video-h3-viggle-swap") return { model, videoMode: "reference" };
    if (workflowId === "video-h3-fast") return { model, videoMode: "frames" };
    return { model };
}