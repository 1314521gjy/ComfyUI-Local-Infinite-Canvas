import { getNodeSpec, NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { isInheritableNodeField, recallNodeSettings, rememberNodeSettings } from "@/lib/canvas/node-settings-memory";
import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import { nanoid } from "nanoid";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasImageGenerationInfo, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeImage, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export function createCanvasNode(type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata, options?: { remember?: boolean; inherit?: boolean }): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const inherited = options?.inherit === false ? undefined : recallNodeSettings(type, metadata);
    const finalMetadata = { ...spec.metadata, ...(inherited || {}), ...metadata };
    if (options?.remember !== false) rememberNodeSettings(type, finalMetadata);

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: finalMetadata,
    };
}

export function canvasImageItem(image: UploadedImage, generationInfo?: CanvasImageGenerationInfo, id = nanoid()): CanvasNodeImage {
    return { id, status: "success", content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, ...(generationInfo ? { generationInfo } : {}) };
}

export function imageMetadata(image: UploadedImage, generationInfo?: CanvasImageGenerationInfo, imageId = nanoid()): CanvasNodeMetadata {
    const item = canvasImageItem(image, generationInfo, imageId);
    return {
        content: item.content,
        storageKey: item.storageKey,
        status: item.status,
        naturalWidth: item.naturalWidth,
        naturalHeight: item.naturalHeight,
        bytes: item.bytes,
        mimeType: item.mimeType,
        images: [item],
        primaryImageId: item.id,
    };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

export function normalizeCanvasImageItems(node: CanvasNodeData): CanvasNodeData {
    if (node.type !== CanvasNodeType.Image || node.metadata?.images?.length || !node.metadata?.content) return node;
    const image: CanvasNodeImage = {
        id: node.metadata.primaryImageId || node.metadata.storageKey || node.id,
        status: node.metadata.status || "success",
        errorDetails: node.metadata.errorDetails,
        content: node.metadata.content,
        storageKey: node.metadata.storageKey,
        naturalWidth: node.metadata.naturalWidth || 0,
        naturalHeight: node.metadata.naturalHeight || 0,
        bytes: node.metadata.bytes || 0,
        mimeType: node.metadata.mimeType || "image/png",
    };
    return { ...node, metadata: { ...node.metadata, images: [image], primaryImageId: image.id } };
}

export function restorePrimaryImageGeneration(node: CanvasNodeData, workflowModelForId?: (workflowId: string) => string | undefined): CanvasNodeData {
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === node.metadata?.primaryImageId) || images[0];
    const info = primary?.generationInfo;
    if (!info) return node;
    const model = info.sourceType === "workflow" ? workflowModelForId?.(info.sourceId) : undefined;
    if (node.metadata?.prompt === info.prompt && node.metadata?.composerContent === info.prompt && (!model || node.metadata?.model === model)) return node;
    return { ...node, metadata: { ...node.metadata, prompt: info.prompt, composerContent: info.prompt, ...(model ? { model } : {}) } };
}

export function removeBatchImage(node: CanvasNodeData, imageId: string): CanvasNodeData {
    const previousImages = node.metadata?.images || [];
    const primaryImageId = node.metadata?.primaryImageId || previousImages[0]?.id;
    const images = previousImages.filter((image) => image.id !== imageId);
    const removingPrimary = primaryImageId === imageId;
    const primary = removingPrimary ? images[0] : images.find((image) => image.id === primaryImageId);
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(removingPrimary
                ? {
                      ...(primary?.generationInfo?.prompt !== undefined ? { prompt: primary.generationInfo.prompt, composerContent: primary.generationInfo.prompt } : {}),
                      content: primary?.content,
                      storageKey: primary?.storageKey,
                      naturalWidth: primary?.naturalWidth,
                      naturalHeight: primary?.naturalHeight,
                      bytes: primary?.bytes,
                      mimeType: primary?.mimeType,
                  }
                : {}),
            images,
            count: images.length,
            primaryImageId: removingPrimary ? primary?.id : primaryImageId,
        },
    };
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        ...(config.background ? { background: config.background } : {}),
        ...(config.imageMode ? { imageMode: config.imageMode as CanvasNodeMetadata["imageMode"] } : {}),
        ...(config.imageMode === "layout" && config.layout ? { layout: config.layout } : {}),
        ...(config.outpaint ? { outpaint: config.outpaint } : {}),
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    if (Object.keys(safePatch).some(isInheritableNodeField)) rememberNodeSettings(next.type, next.metadata);
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}
