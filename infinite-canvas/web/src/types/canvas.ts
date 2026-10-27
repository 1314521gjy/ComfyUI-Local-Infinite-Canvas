export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    FreeCard = "free-card",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasFreeCardInfo = {
    id: string;
    name: string;
    sourceRel: string;
    sourceFormat: "ui" | "api";
    outputType: "image" | "video" | "other";
    prompt: boolean;
    imageInputs: number;
    size?: { width: number; height: number } | null;
    aspectRatio?: string | null;
    aspectRatios?: string[];
    count?: number | null;
    hasSeed?: boolean;
    seed?: string | null;
    warnings?: string[];
    archived?: boolean;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasMossLayoutRegion = {
    id: string;
    label: "object" | "character" | "text";
    caption: string;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CanvasMossLayout = {
    summary: string;
    regions: CanvasMossLayoutRegion[];
    width?: number;
    height?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    videoInterpolation?: string;
    videoSelfLiftMode?: string;
    frameMode?: "first" | "last" | "both";
    imageMode?: "t2i" | "edit" | "inpaint" | "outpaint" | "layout";
    captionEngine?: "qwen35" | "florence" | "cloud";
    captionStatus?: "running" | "done" | "error";
    captionPrompt?: string;
    captionError?: string;
    captionEngineUsed?: "qwen35" | "florence" | "cloud";
    promptOptimizeStatus?: "running" | "done" | "error";
    promptOptimizeKind?: "h3" | "image";
    promptOptimizePrompt?: string;
    promptOptimizeSource?: string;
    promptOptimizeError?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: CanvasMossLayout;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    previewUrl?: string;
    previewMime?: string;
    previewStep?: number;
    previewTotal?: number;
    stepProgress?: { step: number; total: number; complete?: boolean };
    seed?: string;
    seedFixed?: string;
    aspectRatio?: string;
    freeCard?: CanvasFreeCardInfo;
    freeWorkflowId?: string;
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    params?: Record<string, unknown>; // Per-node model params (e.g. LoRA stack).
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
