import { channelModelOf, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildGenerationConfig } from "./canvas-generation-helpers";

export type StyleRecipeLora = { name: string; strength: number };

export type StyleRecipeConfig = {
    model?: string;
    modelLabel?: string;
};

export type StyleRecipe = {
    id: string;
    name: string;
    thumbAssetId: string;
    createdAt: string;
    loras: StyleRecipeLora[];
    config: StyleRecipeConfig;
    /** image (default for legacy recipes) or video. */
    kind?: "image" | "video";
};

export function normalizeStyleRecipeLoras(value: unknown): StyleRecipeLora[] {
    if (!Array.isArray(value)) return [];
    const result: StyleRecipeLora[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim() : "";
        const strength = Number((item as { strength?: unknown }).strength);
        if (!name || !Number.isFinite(strength)) continue;
        result.push({ name, strength });
    }
    return result;
}

export function normalizeStyleRecipeConfig(value: unknown): StyleRecipeConfig {
    if (!value || typeof value !== "object") return {};
    const item = value as { model?: unknown; modelLabel?: unknown };
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const modelLabel = typeof item.modelLabel === "string" ? item.modelLabel.trim() : "";
    return {
        ...(model ? { model } : {}),
        ...(modelLabel ? { modelLabel } : {}),
    };
}

/** 兼容早期没有 config / loras 字段的配方；只在读取时补全，不写回用户数据。 */
export function normalizeStyleRecipe(value: unknown): StyleRecipe | null {
    if (!value || typeof value !== "object") return null;
    const item = value as { id?: unknown; name?: unknown; thumbAssetId?: unknown; createdAt?: unknown; loras?: unknown; config?: unknown; model?: unknown; modelLabel?: unknown; kind?: unknown };
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (!id || !name) return null;
    const config = normalizeStyleRecipeConfig(item.config);
    const legacyModel = typeof item.model === "string" ? item.model.trim() : "";
    const legacyLabel = typeof item.modelLabel === "string" ? item.modelLabel.trim() : "";
    return {
        id,
        name,
        thumbAssetId: typeof item.thumbAssetId === "string" ? item.thumbAssetId : "",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        loras: normalizeStyleRecipeLoras(item.loras),
        config: {
            ...(config.model || legacyModel ? { model: config.model || legacyModel } : {}),
            ...(config.modelLabel || legacyLabel ? { modelLabel: config.modelLabel || legacyLabel } : {}),
        },
        ...(item.kind === "video" || item.kind === "image" ? { kind: item.kind as "image" | "video" } : {}),
    };
}

/** 显示标签只跟随传入的 model id，避免模型缺失时借用当前默认模型的标签。 */
export function styleRecipeModelLabel(config: AiConfig, model?: string, fallbackLabel?: string) {
    const value = (model || "").trim();
    if (value) {
        const found = channelModelOf(config, value);
        if (found) return found.model.label || found.model.name;
    }
    return value || (fallbackLabel || "").trim() || "-";
}

/** 保存配方时，model 与 modelLabel 必须来自同一个卡片模型。 */
export function buildStyleRecipeConfig(config: AiConfig, node: CanvasNodeData): StyleRecipeConfig {
    const mode = node.type === CanvasNodeType.Video ? "video" : "image";
    const model = (node.metadata?.model || buildGenerationConfig(config, node, mode).model || "").trim();
    return model ? { model, modelLabel: styleRecipeModelLabel(config, model) } : {};
}

/** 套用配方时按 id 精确解析；缺失或能力不符只报缺模型，不回退到默认模型。 */
export function resolveStyleRecipeModel(config: AiConfig, model?: string, kind: "image" | "video" = "image") {
    const value = (model || "").trim();
    const found = value ? channelModelOf(config, value) : null;
    return {
        model: value,
        label: found ? found.model.label || found.model.name : value,
        missing: !found || found.model.capability !== kind,
    };
}

export function styleRecipeKind(recipe: Pick<StyleRecipe, "kind">) {
    return recipe.kind === "video" ? ("video" as const) : ("image" as const);
}

/** 二级分组键：底模显示名；无法解析时回退配方自带的 modelLabel。 */
export function styleRecipeBaseModelGroup(config: AiConfig, model?: string, fallbackLabel?: string) {
    const found = (model || "").trim() ? channelModelOf(config, model) : null;
    const entry = found?.model;
    if (!entry) return (fallbackLabel || "").trim() || "-";
    const base = (entry.baseModelLabel || entry.baseModel || "").trim();
    return base || entry.label || entry.name || "-";
}
