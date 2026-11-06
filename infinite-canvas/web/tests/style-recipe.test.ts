import { afterAll, expect, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

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

const { defaultConfig } = await import("../src/stores/use-config-store");
const { buildStyleRecipeConfig, normalizeStyleRecipe, resolveStyleRecipeModel, styleRecipeModelLabel } = await import("../src/lib/canvas/style-recipe");
const { CanvasNodeType } = await import("../src/types/canvas");

const config: AiConfig = {
    ...defaultConfig,
    channelMode: "local",
    imageModel: "test::image-a",
    model: "test::image-a",
    channels: [
        {
            id: "test",
            name: "Test",
            baseUrl: "https://example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: [
                { name: "image-a", capability: "image", label: "Model A" },
                { name: "image-b", capability: "image", label: "Model B" },
                { name: "text-a", capability: "text", label: "Text A" },
            ],
        },
    ],
};

const imageNode = (model?: string): CanvasNodeData => ({
    id: "node-1",
    type: CanvasNodeType.Image,
    title: "Image",
    position: { x: 0, y: 0 },
    width: 320,
    height: 320,
    metadata: { content: "data:image/png;base64,AA==", ...(model ? { model } : {}) },
});

test("save and apply keep the exact model id", () => {
    const saved = buildStyleRecipeConfig(config, imageNode("test::image-a"));
    expect(saved.model).toBe("test::image-a");
    expect(saved.modelLabel).toBe("Model A");

    const resolved = resolveStyleRecipeModel(config, saved.model);
    expect(resolved.missing).toBe(false);
    expect(resolved.model).toBe("test::image-a");
    expect(resolved.label).toBe("Model A");
});

test("a missing model is not replaced by the current default", () => {
    const saved = buildStyleRecipeConfig(config, imageNode("removed::image-a"));
    expect(saved.model).toBe("removed::image-a");
    expect(saved.modelLabel).toBe("removed::image-a");
    expect(saved.modelLabel).not.toBe("Model A");

    const resolved = resolveStyleRecipeModel(config, saved.model);
    expect(resolved.missing).toBe(true);
    expect(resolved.model).toBe("removed::image-a");
});

test("a model of another capability is treated as missing", () => {
    const resolved = resolveStyleRecipeModel(config, "test::text-a");
    expect(resolved.missing).toBe(true);
    expect(resolved.model).toBe("test::text-a");
});

test("a node without its own model uses the effective image model", () => {
    const saved = buildStyleRecipeConfig(config, imageNode());
    expect(saved.model).toBe("test::image-a");
    expect(saved.modelLabel).toBe("Model A");
});

test("legacy recipes without config or loras fields remain readable", () => {
    const legacy = normalizeStyleRecipe({ id: "legacy", name: "Legacy", thumbAssetId: "asset", createdAt: "2026-01-01", model: "test::image-a" });
    expect(legacy).not.toBeNull();
    expect(legacy?.config.model).toBe("test::image-a");
    expect(legacy?.loras).toEqual([]);

    const empty = normalizeStyleRecipe({ id: "old", name: "Old", thumbAssetId: "asset", createdAt: "2026-01-01" });
    expect(empty).not.toBeNull();
    expect(empty?.config).toEqual({});
});

test("a missing model label shows the saved id instead of a fallback label", () => {
    expect(styleRecipeModelLabel(config, "removed::image-a", "Model A")).toBe("removed::image-a");
});
