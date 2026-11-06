import { afterAll, expect, test } from "bun:test";
import type { CanvasNodeData, CanvasNodeImage } from "../src/types/canvas";

const originalLocalStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
});

afterAll(() => {
    if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { applyEmbeddedWorkflowRecovery, inferCanvasPromptFromComfyPrompt, inferCanvasWorkflowFromComfyPrompt } = await import("../src/lib/canvas/canvas-image-workflow-recovery");
const { normalizeCreatedNodeConnection, normalizeConnection } = await import("../src/lib/canvas/canvas-node-geometry");
const { normalizeCanvasImageItems, restorePrimaryImageGeneration } = await import("../src/lib/canvas/canvas-node-factory");
const { buildNodeGenerationReferences, findCanvasReferenceSourceNodeIds } = await import("../src/lib/canvas/canvas-resource-references");
const { CanvasNodeType } = await import("../src/types/canvas");

function image(id: string): CanvasNodeImage {
    return { id, status: "success", content: `blob:${id}`, storageKey: `image:${id}`, naturalWidth: 100, naturalHeight: 50, bytes: 12, mimeType: "image/png" };
}

function imageNode(id: string, storageKey = `image:${id}`): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        metadata: { content: storageKey, storageKey },
    };
}

test("each image version restores its own workflow and prompt", () => {
    const first = { ...image("one"), generationInfo: { sourceType: "workflow" as const, sourceId: "image-moss", sourceName: "MOSS", prompt: "first prompt" } };
    const second = { ...image("two"), generationInfo: { sourceType: "free-node" as const, sourceId: "free-card", sourceName: "Poster", prompt: "second prompt" } };
    const node = { ...imageNode("result"), metadata: { ...imageNode("result").metadata, images: [first, second], primaryImageId: first.id } };

    const restoredFirst = restorePrimaryImageGeneration(node, (workflowId) => `local-gateway::${workflowId}`);
    expect(restoredFirst.metadata?.model).toBe("local-gateway::image-moss");
    expect(restoredFirst.metadata?.prompt).toBe("first prompt");

    const restoredSecond = restorePrimaryImageGeneration({ ...node, metadata: { ...node.metadata, primaryImageId: second.id } });
    expect(restoredSecond.metadata?.prompt).toBe("second prompt");
    expect(restoredSecond.metadata?.model).toBeUndefined();
});

test("legacy single-image nodes are normalized without inventing history", () => {
    const normalized = normalizeCanvasImageItems(imageNode("legacy"));
    expect(normalized.metadata?.images?.[0].storageKey).toBe("image:legacy");
    expect(normalized.metadata?.images?.[0].generationInfo).toBeUndefined();
});

test("only current incoming connections count as generation references", () => {
    const source = imageNode("source");
    const target = { ...imageNode("target"), metadata: { ...imageNode("target").metadata, references: ["image:source"] } };
    expect(buildNodeGenerationReferences(target, [source, target], [])).toEqual([]);
    expect(buildNodeGenerationReferences(target, [source, target], [{ id: "line", fromNodeId: source.id, toNodeId: target.id }])).toHaveLength(1);
    expect(findCanvasReferenceSourceNodeIds([{ id: "source", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,source", storageKey: "image:source" }], [source])).toEqual(["source"]);
});

test("connection direction follows the handle while image creation stays downstream", () => {
    const card = imageNode("card");
    const text: CanvasNodeData = { id: "text", type: CanvasNodeType.Text, title: "Text", position: { x: 0, y: 0 }, width: 240, height: 160 };
    const generated = imageNode("generated");
    expect(normalizeConnection(card.id, text.id, [card, text], "target")).toEqual({ fromNodeId: text.id, toNodeId: card.id });
    expect(normalizeCreatedNodeConnection(card.id, generated.id, [card, generated], "target")).toEqual({ fromNodeId: card.id, toNodeId: generated.id });
});

test("embedded Comfy metadata recovers MOSS workflow and positive prompt", () => {
    const prompt = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "moss_image_sft_bf16.safetensors" } },
        "4": { class_type: "CLIPTextEncode", _meta: { title: "Negative Prompt" }, inputs: { text: "bad image" } },
        "5": { class_type: "CLIPTextEncode", _meta: { title: "Positive Prompt" }, inputs: { text: "empty subway, no people" } },
        "8": { class_type: "KSampler", inputs: { steps: 8, cfg: 1 } },
    };
    expect(inferCanvasWorkflowFromComfyPrompt(prompt)).toBe("local-gateway::image-moss-sft-8step");
    expect(inferCanvasPromptFromComfyPrompt(prompt)).toBe("empty subway, no people");

    const recovered = applyEmbeddedWorkflowRecovery({ ...imageNode("result"), metadata: { ...imageNode("result").metadata, images: [image("one")], primaryImageId: "one" } }, "local-gateway::image-moss-sft-8step", "empty subway, no people");
    expect(recovered.metadata?.images?.[0].generationInfo).toEqual({ sourceType: "workflow", sourceId: "image-moss-sft-8step", sourceName: "MOSS-Image 极速 8步", prompt: "empty subway, no people" });
});
