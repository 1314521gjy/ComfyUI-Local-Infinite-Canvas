import { afterAll, expect, test } from "bun:test";
import type { CanvasNodeData, CanvasNodeImage } from "../src/types/canvas";

const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { clearStaleNodeErrors, resetInterruptedGeneration } = await import("../src/lib/canvas/canvas-generation-helpers");
const { removeBatchImage } = await import("../src/lib/canvas/canvas-node-factory");

function image(id: string): CanvasNodeImage {
    return { id, status: "success", content: `blob:${id}`, storageKey: `image:${id}`, naturalWidth: id === "one" ? 100 : 200, naturalHeight: 50, bytes: 12, mimeType: "image/png" };
}

function imageNode(images = [image("one"), image("two")]): CanvasNodeData {
    return {
        id: "node",
        type: "image",
        title: "Images",
        position: { x: 0, y: 0 },
        width: 100,
        height: 50,
        metadata: { ...images[0], images, primaryImageId: images[0].id, status: "loading" },
    };
}

test("interrupted generation remains retryable while unrelated stale errors are cleared", () => {
    const interrupted = resetInterruptedGeneration([imageNode()]);
    const stale = { ...imageNode(), metadata: { ...imageNode().metadata, status: "error" as const, errorDetails: "old failure" } };
    const restored = clearStaleNodeErrors([...interrupted, stale]);
    expect(restored[0].metadata?.status).toBe("error");
    expect(restored[0].metadata?.errorDetails).toBeTruthy();
    expect(restored[0].metadata?.images?.[0].status).toBe("success");
    expect(restored[1].metadata?.status).toBe("idle");
    expect(restored[1].metadata?.errorDetails).toBeUndefined();
});

test("deleting the primary batch image synchronizes all top-level media fields", () => {
    const result = removeBatchImage(imageNode(), "one");
    expect(result.metadata?.primaryImageId).toBe("two");
    expect(result.metadata?.content).toBe("blob:two");
    expect(result.metadata?.storageKey).toBe("image:two");
    expect(result.metadata?.naturalWidth).toBe(200);
    expect(result.metadata?.naturalHeight).toBe(50);
    expect(result.metadata?.bytes).toBe(12);
    expect(result.metadata?.mimeType).toBe("image/png");
    expect(result.metadata?.count).toBe(1);
});

test("deleting the last primary image leaves no reference to deleted media", () => {
    const result = removeBatchImage(imageNode([image("one")]), "one");
    expect(result.metadata?.primaryImageId).toBeUndefined();
    expect(result.metadata?.content).toBeUndefined();
    expect(result.metadata?.storageKey).toBeUndefined();
    expect(result.metadata?.naturalWidth).toBeUndefined();
    expect(result.metadata?.mimeType).toBeUndefined();
});
