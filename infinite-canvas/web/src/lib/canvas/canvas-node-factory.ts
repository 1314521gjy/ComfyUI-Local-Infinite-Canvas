import { getNodeSpec, NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { isInheritableNodeField, recallNodeSettings, rememberNodeSettings } from "@/lib/canvas/node-settings-memory";
import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export const AUDIO_CONFIG_NODE_SIZE = { width: 380, height: 440 };

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

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
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
        audioMode: config.audioMode === "dialogue" ? "dialogue" : "song",
        audioReferenceMode: config.audioReferenceMode === "none" ? "none" : "reference",
        audioDuration: config.audioDuration || "120",
        audioBpm: config.audioBpm || "120",
        audioLanguage: config.audioLanguage || "zh",
        audioKeyscale: config.audioKeyscale || "E minor",
        audioVoiceDescription: config.audioVoiceDescription || "",
        audioStyle: config.audioStyle || "",
        audioGenre: config.audioGenre || "",
        audioEmotion: config.audioEmotion || "",
        audioSeed: config.audioSeed || "",
        audioSourceKey: config.audioSourceKey || "",
        audioSourceName: config.audioSourceName || "",
        audioReferenceKey: config.audioReferenceKey || "",
        audioSongReferenceKey: config.audioSongReferenceKey || "",
        audioReferenceName: config.audioReferenceName || "",
        audioSongReferenceName: config.audioSongReferenceName || "",
        audioDialogueVoiceKey: config.audioDialogueVoiceKey || "",
        audioDialogueVoiceName: config.audioDialogueVoiceName || "",
        audioDialogueSpeed: config.audioDialogueSpeed || "",
        audioDialogueTone: config.audioDialogueTone || "",
        audioStrength: config.audioStrength || "1",
    };
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    if (Object.keys(safePatch).some(isInheritableNodeField)) rememberNodeSettings(next.type, next.metadata);
    if (node.type === CanvasNodeType.Config && safePatch.generationMode) {
        const size = safePatch.generationMode === "audio" ? AUDIO_CONFIG_NODE_SIZE : NODE_DEFAULT_SIZE[CanvasNodeType.Config];
        return { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } };
    }
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}
