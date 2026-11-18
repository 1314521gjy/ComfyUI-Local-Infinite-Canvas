import type { DramaRun } from "@/lib/short-drama/run-manifest";
import type { DramaScreenplay } from "@/lib/short-drama/storyboard";

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
    Automation = "automation",
    Drama = "short-drama",
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
    healthWarnings?: string[];
    archived?: boolean;
    snapshot?: boolean;
    snapshotPageLabel?: string;
    pageCount?: number;
};

export type CanvasDramaCardEpisode = {
    id: string;
    title: string;
    synopsis: string;
    shots: number;
    draft: boolean;
    script?: string;
    screenplay?: DramaScreenplay;
};

export type CanvasDramaAssetStage = {
    id: string;
    name: string;
    description: string;
    polishedPrompt?: string;
    prompt?: string;
    nodeId?: string;
    imageUrl?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasDramaAssetRecord = {
    id: string;
    kind: "character" | "scene" | "prop";
    name: string;
    nameEn?: string;
    role?: string;
    description: string;
    polishedPrompt?: string;
    prompt?: string;
    nodeId?: string;
    imageUrl?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
    stages?: CanvasDramaAssetStage[];
    location?: string;
    time?: string;
    variant?: string;
    locationKey?: string;
    refMode?: "auto" | "off";
    baseNodeId?: string;
    usedReference?: boolean;
};

export type CanvasDramaAssetLibrary = {
    characters: CanvasDramaAssetRecord[];
    scenes: CanvasDramaAssetRecord[];
    props: CanvasDramaAssetRecord[];
};

export type CanvasDramaStoryboardShot = {
    id?: string;
    shotNumber: number;
    title: string;
    segmentIndex: number;
    segmentTitle: string;
    location: string;
    time: string;
    shotType: string;
    cameraAngle: string;
    cameraMovement: string;
    lightingStyle: string;
    depthOfField: string;
    action: string;
    result: string;
    dialogue: string;
    emotion: string;
    emotionIntensity: number;
    duration?: number;
    beatIds?: string[];
    cutPoints?: string[];
    splitReason?: string;
    entryState?: string;
    exitState?: string;
    cameraPurpose?: string;
};

export type CanvasDramaCardData = {
    title: string;
    style: string;
    aspect: string;
    imageWorkflow?: string;
    videoWorkflow?: string;
    videoMode?: "frames" | "reference";
    vquality?: string;
    segmentSeconds?: number;
    paused?: boolean;
    activeTab: "characters" | "scenes" | "props";
    episodes: CanvasDramaCardEpisode[];
    assets?: CanvasDramaAssetLibrary;
    storyboards?: Record<string, CanvasDramaStoryboardShot[]>;
    runs?: Record<string, DramaRun>;
    progress?: { stage: string; current: number; total: number };
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    previewUrl?: string;
    previewStep?: number;
    previewTotal?: number;
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
    storyboardVersion?: number;
};

export type CanvasAutomationStage = "idle" | "script" | "planning" | "characters" | "scenes" | "images" | "videoPrompts" | "videos" | "done" | "error" | "stopped";

export type CanvasAutomationScene = {
    id: string;
    name: string;
    description?: string;
};

export type CanvasAutomationSceneSheet = {
    sceneId: string;
    name: string;
    nodeId: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationGrid = {
    rows: number;
    cols: number;
    panelCount: number;
};

export type CanvasAutomationCharacter = {
    id: string;
    name: string;
    species?: "human" | "animal";
    speciesLabel?: string;
    description?: string;
    appearanceLock?: string;
    outfitLock?: string;
    negativeLock?: string;
};

export type CanvasAutomationPanelSpec = {
    index: number;
    time?: string;
    description: string;
    storyboardDescription?: string;
    background?: string;
    beat?: "key" | "support";
    camera?: string;
    dialogue?: string[];
    characters?: string[];
};

export type CanvasAutomationShotGroup = {
    panels: number[];
    mode: "long_take" | "cut" | "insert";
    template?: string;
    reason?: string;
};

export type CanvasAutomationScriptLine = {
    speaker: string;
    text: string;
    performance?: string;
    channel?: "spoken" | "inner" | "system";
};

export type CanvasAutomationScriptBeat = {
    id: string;
    sceneId: string;
    action: string;
    dialogue?: CanvasAutomationScriptLine[];
};

export type CanvasAutomationScriptScene = {
    id: string;
    heading: string;
    description?: string;
};

export type CanvasAutomationScript = {
    level: "locked" | "performance" | "structural";
    logline?: string;
    scenes: CanvasAutomationScriptScene[];
    beats: CanvasAutomationScriptBeat[];
};

export type CanvasAutomationVideoSegment = {
    index: number;
    prompt?: string;
    promptVersion?: number;
    seconds: string;
    panelRange?: [number, number];
    nodeId?: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationPage = {
    index: number;
    title: string;
    narration?: string;
    sceneId?: string;
    scene?: string;
    sceneDescription?: string;
    dialogue?: string[];
    focus?: string;
    eventIds?: string[];
    shotGroups?: CanvasAutomationShotGroup[];
    videoHint?: string;
    videoPrompt?: string;
    videoPromptVersion?: number;
    videoTitle?: string;
    videoSegments?: CanvasAutomationVideoSegment[];
    segmentIndex?: number;
    segmentCount?: number;
    panelRange?: [number, number];
    grid?: CanvasAutomationGrid;
    panels?: CanvasAutomationPanelSpec[];
    style?: string;
    styleLock?: string;
    styleNegative?: string;
    videoSeconds?: string;
    characters?: CanvasAutomationCharacter[];
    layout: CanvasMossLayout;
    textNodeId?: string;
    imageNodeId?: string;
    videoNodeId?: string;
    imageState: "pending" | "loading" | "done" | "error";
    videoState: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationCharacterSheet = {
    characterId: string;
    nodeId: string;
    state: "pending" | "loading" | "done" | "error";
    error?: string;
};

export type CanvasAutomationSettings = {
    pageCount: number;
    pageCountAuto?: boolean;
    segmentation?: "short" | "long";
    grid: "2x2" | "2x3" | "3x3";
    style: string;
    aspect: string;
    mossSteps: "8" | "50";
    videoSeconds: string;
    videoVariant?: "auto" | "vdn" | "novdn";
    vquality: string;
    generateAudio: boolean;
    generateCharacterSheets?: boolean;
    generateSceneSheets?: boolean;
    storyboardWhiteModel?: boolean;
    textModel?: string;
};

export type CanvasAutomationState = {
    template: "novel-comic-video";
    stage: CanvasAutomationStage;
    sourceText: string;
    sourceUrl?: string;
    settings: CanvasAutomationSettings;
    script?: CanvasAutomationScript;
    scriptText?: string;
    style?: string;
    styleLock?: string;
    styleNegative?: string;
    characters?: CanvasAutomationCharacter[];
    characterSheets?: CanvasAutomationCharacterSheet[];
    scenes?: CanvasAutomationScene[];
    sceneSheets?: CanvasAutomationSceneSheet[];
    pages?: CanvasAutomationPage[];
    videoPromptVersion?: number;
    progress?: string;
    warnings?: string[];
    errors?: string[];
    fallbackNotice?: string;
    startedAt?: number;
    finishedAt?: number;
    updatedAt?: number;
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
    referenceAcceleration?: boolean;
    videoSelfLiftMode?: string;
    videoPins?: string;
    videoSegmentSeconds?: string;
    videoLongVideo?: boolean;
    previewPersist?: boolean;
    videoSage?: string;
    videoViggleMode?: string;
    videoSwapTarget?: string;
    videoSwapTargetBox?: string;
    frameMode?: "first" | "last" | "both";
    imageMode?: "t2i" | "i2i" | "edit" | "inpaint" | "outpaint" | "layout" | "remove";
    captionEngine?: "qwen35" | "florence" | "cloud";
    captionStatus?: "running" | "done" | "error";
    captionPrompt?: string;
    captionError?: string;
    fallbackNotice?: string;
    bare?: boolean;
    vigglePrep?: { phase: "running" | "done" | "error"; step?: string; error?: string; frame?: number; pin?: string; thumbUrl?: string; targetFrameUrl?: string; similarity?: number; candidates?: Array<{ frame: number; thumbUrl?: string }> };
    captionEngineUsed?: "qwen35" | "florence" | "cloud";
    promptOptimizeStatus?: "running" | "done" | "error";
    promptOptimizeKind?: "h3" | "image";
    promptOptimizePrompt?: string;
    promptOptimizeSource?: string;
    promptOptimizeTextKey?: string;
    promptOptimizeError?: string;
    customTexts?: Record<string, string>;
    customTextActive?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: CanvasMossLayout;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    audioMode?: "dialogue" | "song" | "voice";
    audioReferenceMode?: "reference" | "none";
    audioDuration?: string;
    audioBpm?: string;
    audioLanguage?: string;
    audioKeyscale?: string;
    audioVoiceDescription?: string;
    audioStyle?: string;
    audioGenre?: string;
    audioEmotion?: string;
    audioGender?: string;
    audioSeed?: string;
    audioSourceKey?: string;
    audioSourceName?: string;
    audioReferenceKey?: string;
    audioSongReferenceKey?: string;
    audioReferenceName?: string;
    audioSongReferenceName?: string;
    audioDialogueVoiceKey?: string;
    audioDialogueVoiceName?: string;
    audioDialogueSpeed?: string;
    audioDialogueTone?: string;
    audioStrength?: string;
    audioSongText?: string;
    audioDialogueText?: string;
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
    videoTaskProvider?: "openai" | "gemini" | "swap-chain";
    previewUrl?: string;
    previewMime?: string;
    previewStep?: number;
    previewTotal?: number;
    stepProgress?: { step: number; total: number; complete?: boolean };
    generationStartedAt?: number;
    generationDurationMs?: number;
    automation?: CanvasAutomationState;
    seed?: string;
    seedFixed?: string;
    aspectRatio?: string;
    freeCard?: CanvasFreeCardInfo;
    dramaCard?: CanvasDramaCardData;
    freeWorkflowId?: string;
    freeWorkflowOutputKey?: string;
    freeWorkflowOutputNodeId?: string;
    freeWorkflowOutputPreview?: boolean;
    freeWorkflowOriginNodeId?: string;
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    params?: Record<string, unknown>; // Per-node model params (e.g. LoRA stack).
    customMask?: { content: string; storageKey?: string; mimeType?: string; naturalWidth?: number; naturalHeight?: number; bytes?: number };
    model3d?: { url: string; bytes?: number; filename?: string; mode?: "synthetic" | "real"; steps?: number; format?: "ply" | "glb" };
    model3dEngine?: "idol" | "moge" | "panorama";
    scene3d?: {
        sourceUrl?: string;
        sourceStorageKey?: string;
        sourceName?: string;
        prompt?: string;
        taskId?: string;
        progress?: number;
        offsetX?: number;
        offsetY?: number;
        error?: string;
        panoramaUrl?: string;
        panoramaStorageKey?: string;
        panoramaBytes?: number;
        panoramaWidth?: number;
        panoramaHeight?: number;
        sceneJson?: { panorama?: string; rotation?: number; mode?: "panorama"; characterDistance?: number };
    };
    stage3d?: {
        scene: { url: string; filename?: string; bytes?: number };
        character?: { url: string; filename?: string; bytes?: number };
        characters?: Array<{ id?: string; url: string; filename?: string; bytes?: number; transform?: { x: number; y?: number; z: number; rotation: number; scale: number } }>;
        transform?: { x: number; y?: number; z: number; rotation: number; scale: number };
    };
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
    dashed?: boolean;
    role?: "lineage";
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
