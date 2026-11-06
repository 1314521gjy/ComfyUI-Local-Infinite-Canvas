import { getImageBlob } from "@/services/image-storage";
import type { CanvasImageGenerationInfo, CanvasNodeData, CanvasNodeImage } from "@/types/canvas";

type ComfyPromptNode = {
    class_type?: string;
    inputs?: Record<string, unknown>;
    _meta?: { title?: string };
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function inferCanvasWorkflowFromComfyPrompt(prompt: Record<string, ComfyPromptNode>): string | null {
    const nodes = Object.values(prompt || {});
    const unet = nodes.find((node) => node.class_type === "UNETLoader")?.inputs?.unet_name;
    const unetName = typeof unet === "string" ? unet.toLowerCase() : "";
    if (!unetName.includes("moss_image_sft")) return null;

    const int8 = unetName.includes("int8");
    const eightStep = nodes.some((node) => {
        const inputs = node.inputs || {};
        const lora = typeof inputs.lora_name === "string" ? inputs.lora_name.toLowerCase() : "";
        return lora.includes("moss-image-sft-8-steps") || (node.class_type === "KSampler" && Number(inputs.steps) === 8 && Number(inputs.cfg) === 1);
    });
    return `local-gateway::image-moss-sft-${int8 ? "int8-" : ""}${eightStep ? "8step" : "50step"}`;
}

export function workflowGenerationName(workflow: string) {
    const id = workflow.split("::").pop() || workflow;
    const names: Record<string, string> = {
        "image-moss-sft-8step": "MOSS-Image 极速 8步",
        "image-moss-sft-50step": "MOSS-Image 高质量 50步",
        "image-moss-sft-int8-8step": "MOSS-Image INT8 极速 8步",
        "image-moss-sft-int8-50step": "MOSS-Image INT8 高质量 50步",
    };
    return names[id] || id;
}

export async function embeddedGenerationForImage(image?: CanvasNodeImage): Promise<{ workflow: string; prompt: string } | null> {
    if (image?.generationInfo || !image?.storageKey || image.mimeType !== "image/png") return null;
    const blob = await getImageBlob(image.storageKey).catch(() => null);
    if (!blob) return null;
    return inferCanvasGenerationFromPng(blob).catch(() => null);
}

export function inferCanvasPromptFromComfyPrompt(prompt: Record<string, ComfyPromptNode>): string {
    const candidates = Object.values(prompt || {}).flatMap((node) => {
        const title = String(node._meta?.title || "").toLowerCase();
        if (title.includes("negative") || title.includes("负面")) return [];
        return ["prompt", "text", "positive", "positive_prompt"].flatMap((key) => {
            const value = node.inputs?.[key];
            return typeof value === "string" && value.trim() ? [{ value: value.trim(), score: (key === "prompt" || key === "positive_prompt" ? 1000 : 0) + (title.includes("positive") || title.includes("正面") ? 500 : 0) + value.length }] : [];
        });
    });
    return candidates.sort((a, b) => b.score - a.score)[0]?.value || "";
}

export async function inferCanvasGenerationFromPng(blob: Blob): Promise<{ workflow: string; prompt: string } | null> {
    const comfyPrompt = await readComfyPrompt(blob);
    if (!comfyPrompt) return null;
    const workflow = inferCanvasWorkflowFromComfyPrompt(comfyPrompt);
    return workflow ? { workflow, prompt: inferCanvasPromptFromComfyPrompt(comfyPrompt) } : null;
}

export function applyEmbeddedWorkflowRecovery(node: CanvasNodeData, workflow: string, embeddedPrompt = ""): CanvasNodeData {
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === node.metadata?.primaryImageId) || images[0];
    if (!primary || primary.generationInfo) return node;
    const generationInfo: CanvasImageGenerationInfo = {
        sourceType: "workflow",
        sourceId: workflow.split("::").pop() || workflow,
        sourceName: workflowGenerationName(workflow),
        prompt: embeddedPrompt,
    };
    return { ...node, metadata: { ...node.metadata, images: images.map((image) => (image.id === primary.id ? { ...image, generationInfo } : image)) } };
}

async function readComfyPrompt(blob: Blob): Promise<Record<string, ComfyPromptNode> | null> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = PNG_SIGNATURE.length;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) return null;
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (type === "tEXt") {
            const separator = bytes.subarray(dataStart, dataEnd).indexOf(0);
            if (separator >= 0) {
                const keyword = new TextDecoder("latin1").decode(bytes.subarray(dataStart, dataStart + separator));
                if (keyword === "prompt") {
                    const text = new TextDecoder("utf-8").decode(bytes.subarray(dataStart + separator + 1, dataEnd));
                    return JSON.parse(text) as Record<string, ComfyPromptNode>;
                }
            }
        }
        if (type === "IEND") break;
        offset = dataEnd + 4;
    }
    return null;
}
