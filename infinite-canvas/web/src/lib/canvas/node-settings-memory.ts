import { CanvasNodeType, type CanvasNodeMetadata, type CanvasNodeTypeId } from "@/types/canvas";

const INHERITABLE_FIELDS = new Set([
    "model",
    "reasoningEffort",
    "size",
    "quality",
    "background",
    "count",
    "seconds",
    "vquality",
    "generateAudio",
    "watermark",
    "videoMode",
    "videoSelfLiftMode",
    "videoPins",
    "videoSegmentSeconds",
    "videoSage",
    "videoViggleMode",
    "videoSwapTarget",
    "videoSwapTargetBox",
    "frameMode",
    "imageMode",
    "outpaint",
    "layout",
    "audioVoice",
    "audioFormat",
    "audioSpeed",
    "audioInstructions",
    "seed",
    "seedFixed",
    "aspectRatio",
    "params",
]);

const memory = new Map<string, CanvasNodeMetadata>();
const STORAGE_PREFIX = "infinite-canvas.node-settings:";
let currentScope = "";

function storageKey(scope = currentScope) {
    return `${STORAGE_PREFIX}${scope || "default"}`;
}

function persist() {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(memory)));
    } catch {
        // Persistence is best-effort.
    }
}

/** 每个画布独立记住“上一次新建卡片用的设置”，刷新后仍然继承。 */
export function setNodeSettingsScope(scope: string) {
    const next = String(scope || "default");
    if (next === currentScope) return;
    currentScope = next;
    memory.clear();
    if (typeof localStorage === "undefined") return;
    try {
        const raw = localStorage.getItem(storageKey(next));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object") {
            for (const [key, value] of Object.entries(parsed)) memory.set(key, value as CanvasNodeMetadata);
        }
    } catch {
        // Ignore corrupt storage.
    }
}

function settingsKey(type: CanvasNodeTypeId, metadata?: CanvasNodeMetadata) {
    const mode = type === CanvasNodeType.Config ? metadata?.generationMode || "image" : "";
    return `${type}:${mode}`;
}

function cloneValue<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isInheritableNodeField(key: string) {
    return INHERITABLE_FIELDS.has(key);
}

export function snapshotNodeSettings(metadata: CanvasNodeMetadata | undefined): CanvasNodeMetadata {
    const snapshot: CanvasNodeMetadata = {};
    const target = snapshot as unknown as Record<string, unknown>;
    for (const key of INHERITABLE_FIELDS) {
        if (metadata && key in metadata && metadata[key as keyof CanvasNodeMetadata] !== undefined) {
            target[key] = cloneValue(metadata[key as keyof CanvasNodeMetadata]);
        }
    }
    return snapshot;
}

export function rememberNodeSettings(type: CanvasNodeTypeId, metadata: CanvasNodeMetadata | undefined) {
    const snapshot = snapshotNodeSettings(metadata);
    if (!Object.keys(snapshot).length) return;
    memory.set(settingsKey(type, metadata), snapshot);
    persist();
}

export function recallNodeSettings(type: CanvasNodeTypeId, metadata?: CanvasNodeMetadata): CanvasNodeMetadata | undefined {
    const settings = memory.get(settingsKey(type, metadata));
    if (!settings) return undefined;
    return cloneValue(settings);
}

export function clearNodeSettingsMemory() {
    memory.clear();
    if (typeof localStorage !== "undefined") {
        try {
            localStorage.removeItem(storageKey());
        } catch {
            // Ignore.
        }
    }
}
