import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Box, ChevronLeft, ChevronRight, Group, Mountain, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageAngle, requestImageFourView, requestImageQuestion, requestImageTo3D, requestSceneTo3D, requestUpscale } from "@/services/api/image";
import { createFreeWorkflowVideoTask, fetchFreeWorkflowSnapshot, fetchFreeWorkflows, requestFreeWorkflowImage, type FreeWorkflowOutputGroup, type FreeWorkflowSummary } from "@/services/api/free-workflow";
import { bindStepProgress, unbindStepProgress, type GenerationStepProgress } from "@/services/api/step-progress";
import { requestAudioGeneration, requestDialogueSpeech, storeGeneratedAudio } from "@/services/api/audio";
import { loadAudioBlob, requestVoiceConversion, requestYue2Song } from "@/services/api/audio-pipeline";
import { createViggleEditPrep } from "@/lib/canvas/viggle-edit-prep";
import { createGatewayPrepAdapter } from "@/lib/canvas/viggle-edit-prep-gateway";
import { autoPinSimilarity, createVideoGenerationTask, createVideoInterpolateTask, createVideoUpscaleTask, isVideoTaskFailed, readVideoTaskResumeInfo, storeGeneratedVideo, waitForVideoGenerationTask, type VideoPreview } from "@/services/api/video";
import { activePromptCloudApi, channelModelOf, defaultConfig, selectableModelsByCapability, useConfigStore, useEffectiveConfig, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import { customWorkflowModelValue, customWorkflowView, findCustomWorkflow, isCustomWorkflowModel, useCustomWorkflowStore, type CustomWorkflow } from "@/stores/use-custom-workflow-store";
import { buildCustomTextRequest } from "@/lib/canvas/custom-workflow-texts";
import { ensureImagePreview, imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { dataUrlToFile, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { MODEL3D_DEFAULT_SIZE, MODEL3D_NODE_TYPE, SCENE3D_DEFAULT_SIZE, STAGE3D_DEFAULT_SIZE, STAGE3D_NODE_TYPE } from "@/lib/canvas/model3d";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl } from "@/lib/canvas/canvas-image-data";
import { composeImageWithAlphaMask } from "@/lib/canvas/compose-mask";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { setNodeSettingsScope } from "@/lib/canvas/node-settings-memory";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { App, Button, Modal } from "antd";
import { CONFIG_COMPOSER_ENABLED, NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeOutpaintDialog, type CanvasOutpaintPayload } from "@/components/canvas/canvas-node-outpaint-dialog";
import { CanvasNodeMossLayoutDialog, type CanvasMossLayoutPayload } from "@/components/canvas/canvas-node-moss-layout-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeSuperResolveDialog, type CanvasSuperResolveParams } from "@/components/canvas/canvas-node-super-resolve-dialog";
import { CanvasNodeVideoUpscaleDialog, type CanvasVideoUpscaleParams } from "@/components/canvas/canvas-node-video-upscale-dialog";
import { CanvasVideoEditPopup } from "@/components/canvas/canvas-video-edit-popup";
import { CanvasImageCompareModal } from "@/components/canvas/canvas-image-compare-modal";
import { CanvasVideoEditModal } from "@/components/canvas/canvas-video-edit-modal";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { draftLongSideSize } from "@/lib/media-size";
import { videoModelForWorkflow, videoWorkflowId } from "@/lib/canvas/video-model-mode";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { CanvasSaveStyleModal, type StyleRecipeDraft } from "@/components/canvas/canvas-save-style-modal";
import { buildStyleRecipeConfig, resolveStyleRecipeModel, styleRecipeModelLabel } from "@/lib/canvas/style-recipe";
import { normalizeStyleRecipeLoras, useStyleRecipeStore, type StyleRecipe } from "@/stores/use-style-recipe-store";
import { fetchAvailableLoras } from "@/services/api/loras";
import { CanvasSelectionToolbar } from "@/components/canvas/canvas-selection-toolbar";
import { CanvasGenerationTimer } from "@/components/canvas/canvas-generation-timer";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { freeCardInfoFromSummary } from "@/lib/canvas/free-card-workflow";
import { CanvasFreeCardShellPanel } from "@/components/canvas/canvas-free-card-shell-panel";
import { ShortDramaCard } from "@/components/canvas/short-drama-card";
import { findDramaStyle } from "@/lib/short-drama/styles";
import { buildDeterministicH3Prompt, buildH3BasePrompt, buildH3CompileMessages, buildRef2VAPrompt, buildScreenplayAdaptationMessages, buildShotPlanMessages, elasticPackShots, estimateShotSeconds, expandShotsForVideo, fallbackBeatsFromScript, fallbackShotPlan, normalizeH3Prompt, normalizeScreenplay, normalizeShotPlan, parseDialogueLines, planToShots, repairStoryboardPlan, sanityCheckPackedShots, storyboardCardContent, validateStoryboardPlan, type DramaBeat, type DramaScreenplay, type DramaShotPlan } from "@/lib/short-drama/storyboard";
import { buildDramaResumePlan, createDramaRun, markDramaRunStoryboardsDone, updateDramaRunItem, type DramaRun } from "@/lib/short-drama/run-manifest";
import { buildCharacterExtractionMessages, buildPropExtractionMessages, buildPropPolishMessages, buildRolePolishMessages, buildSceneExtractionMessages, buildScenePolishMessages, characterAssetPrompt, deriveSceneVariant, frameReferencePrompt, isMajorSceneChange, isSameSceneKey, normalizeCharacters, normalizeLocationKey, normalizeProps, normalizeScenes, propAssetPrompt, sceneAssetPrompt, sceneReferencePrompt, sharesSceneBase } from "@/lib/short-drama/assets";
import { CanvasAutomationPanel, type CanvasAutomationStartInput } from "@/components/canvas/canvas-automation-panel";
import { AUTOMATION_VIDEO_PROMPT_VERSION, STORYBOARD_NEGATIVE_PROMPT, STORYBOARD_PROMPT_VERSION, applyComicFrameworkHints, automationCharacterSheetPrompt, buildAutomationVideoReference, buildComicFrameworkMessages, buildComicToVideoMessages, buildGridMoss, buildNovelToComicMessages, buildScriptAdaptationMessages, cameraMoveCount, collectAutomationScenes, duplicatePageEvents, extractJson, formatPageCard, formatScriptForPlanning, isCrowdCharacterName, isRef2VAPrompt, mergeAutomationScripts, mergeComicPlans, missingPageEvents, normalizeComicPlan, normalizeMossLayout, normalizeScript, normalizeVideoPrompts, pageSpeechSeconds, resolvePageVideoSeconds, reviewComicPlan, sanitizePageDialogue, scriptStats, splitAutomationSource, splitPageVideoSegments, splitScriptIntoBatches } from "@/lib/automation/skills";
import { automationImageSize, computeAutomationLayout } from "@/lib/automation/layout";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasOnboarding } from "@/components/onboarding/canvas-onboarding";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, getGroupResourceNodes, isCanvasReferenceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { HIDE_UNRELEASED_FEATURES } from "@/lib/release-flags";
import { dedupeReferenceImages } from "@/lib/canvas/reference-dedupe";
import { DRAFT_REFERENCE_MAX, prepareDraftReferenceImages } from "@/lib/canvas/draft-references";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { composeAudioStyle, composeDialogueInstruction, DEFAULT_AUDIO_EMOTION, DEFAULT_AUDIO_GENRE } from "@/lib/canvas/audio-options";
import { recallNodeSettings } from "@/lib/canvas/node-settings-memory";
import { applyGroupSelection, applyUngroupSelection, canGroupSelectedNodes, canUngroupSelectedNodes, collectGroupMemberNodes, findContainingGroupId, findGroupDropTarget, focusViewportForNode, getConnectionTargetAnchor, getGroupWrapRect, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hasResumableVideoTask,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    clearStaleNodeErrors,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, isRegisteredNodeType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { inferVideoRatio, normalizePixelSize, parsePixelSize } from "@/lib/media-size";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasAutomationCharacter,
    type CanvasAutomationCharacterSheet,
    type CanvasAutomationGrid,
    type CanvasAutomationPage,
    type CanvasAutomationPanelSpec,
    type CanvasAutomationScript,
    type CanvasAutomationSceneSheet,
    type CanvasAutomationSettings,
    type CanvasAutomationState,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeText,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const FOUR_VIEW_PROMPT =
    "Convert the character in the image to a Character Sheet showing a face close-up, front full body, side full body and back full body views";
const FAST_H3_DRAFT_PRESET = "fp4-mlp-fused-fasth3-v2-4step-vsa20-kitchen034-b1";
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

function updateDramaCardProgress(
    setNodes: (updater: (prev: CanvasNodeData[]) => CanvasNodeData[]) => void,
    nodeId: string,
    stage: string | null,
    current: number,
    total: number,
) {
    setNodes((prev) =>
        prev.map((node) => {
            if (node.id !== nodeId || !node.metadata?.dramaCard) return node;
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    status: stage ? NODE_STATUS_LOADING : NODE_STATUS_SUCCESS,
                    stepProgress: total > 0 ? { step: current, total, complete: !stage } : undefined,
                    dramaCard: { ...node.metadata.dramaCard, progress: stage ? { stage, current, total } : undefined },
                },
            };
        }),
    );
}

async function requestLocalAudioPipeline(
    config: AiConfig,
    prompt: string,
    context: { referenceAudios?: Array<{ url: string; storageKey?: string; name?: string }> } | undefined,
    signal: AbortSignal,
): Promise<Blob> {
    const mode = config.audioMode || "dialogue";
    if (mode === "song") {
        const style = composeAudioStyle(config.audioStyle, config.audioGenre || DEFAULT_AUDIO_GENRE, config.audioEmotion || DEFAULT_AUDIO_EMOTION);
        return requestYue2Song(prompt, style, config.audioSeed || "", config.audioDuration || "120", { signal, bpm: config.audioBpm, language: config.audioLanguage, keyscale: config.audioKeyscale, gender: config.audioGender });
    }
    const connected = context?.referenceAudios || [];
    if (mode === "voice") {
        const uploadedSource = config.audioSourceKey ? { storageKey: config.audioSourceKey, name: config.audioSourceName } : undefined;
        const uploadedReference = config.audioReferenceKey ? { storageKey: config.audioReferenceKey, name: config.audioReferenceName } : undefined;
        const sourceRef = uploadedSource || connected[0];
        const referenceRef = uploadedReference || (uploadedSource ? connected[0] : connected[1]);
        if (!sourceRef) throw new Error("换音色需要目标音频：请拉线音频节点或上传目标音频");
        if (!referenceRef) throw new Error("换音色需要音色参考：请拉线第二个音频节点或上传参考音频");
        const [source, reference] = await Promise.all([loadAudioBlob(sourceRef, signal), loadAudioBlob(referenceRef, signal)]);
        if (!source || !reference) throw new Error("换音色音频读取失败");
        return requestVoiceConversion(source, reference, config.audioStrength || "1", config.audioSeed || "", { signal });
    }
    const voiceRef = config.audioDialogueVoiceKey ? { storageKey: config.audioDialogueVoiceKey, name: config.audioDialogueVoiceName } : connected[0];
    const voice = voiceRef ? await loadAudioBlob(voiceRef, signal) : null;
    const instruction = composeDialogueInstruction(config.audioDialogueSpeed, config.audioDialogueTone, config.audioInstructions);
    return requestDialogueSpeech(config, prompt, instruction, voice, config.audioSeed || "", { signal });
}

function resolveDramaTextConfig(config: AiConfig): AiConfig | null {    const textModel = config.textModel || selectableModelsByCapability(config, "text")[0];
    if (textModel) return { ...config, model: textModel };
    const cloudApi = activePromptCloudApi(config);
    if (!cloudApi) return null;
    const channelId = `prompt-cloud-${cloudApi.id || "active"}`;
    const modelValue = `${channelId}::${cloudApi.model}`;
    return {
        ...config,
        channels: [
            { id: channelId, name: cloudApi.name || "Cloud", baseUrl: cloudApi.baseUrl, apiKey: cloudApi.apiKey, apiFormat: "openai" as const, models: [{ name: cloudApi.model, capability: "text" as const }] },
            ...config.channels,
        ],
        model: modelValue,
        textModel: modelValue,
    };
}

async function requestH3CompileAnswer(config: AiConfig, messages: Parameters<typeof requestImageQuestion>[1]) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort("timeout"), 120000);
    try {
        return await requestImageQuestion(config, messages, () => undefined, { signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
}

function ensureSpokenDialogue(prompt: string, dialogue: string) {
    const lines = parseDialogueLines(dialogue);
    if (!lines.length) return prompt;
    const norm = (s: string) => s.replace(/[\s“”「」"'，,。.!！?？…：:；;（）()<>\/\[\]a-zA-Z-]/g, "");
    const spoken = [...prompt.matchAll(/<d>([\s\S]*?)<\/d>/gi)].map((m) => norm(m[1]));
    const missing = lines.filter((line) => {
        const core = norm(line.text);
        return core.length > 0 && !spoken.some((s) => s.includes(core));
    });
    if (!missing.length) return prompt;
    const injected = missing.map((line) => {
        const cue = line.channel === "inner"
            ? `${line.speaker || "S1"} (inner voice, lips remain completely closed, no lip-sync): `
            : line.channel === "system"
              ? "SYS (off-screen system voice, no visible speaker): "
              : "";
        return `${cue}<d>[Chinese] ${line.text}</d>`;
    }).join(" ");
    return /overall_soundscape\s*:/i.test(prompt) ? prompt.replace(/(\n\s*overall_soundscape\s*:)/i, `\n${injected}\n$1`) : `${prompt}\n${injected}`;
}

const dramaRunGuards = new Set<string>();

function stepPreviewUrl(url: string | undefined, step: number | undefined, previousUrl: string | undefined, previousStep: number | undefined) {
    if (!url || step == null) return url;
    if (step === previousStep || url !== previousUrl) return url;
    return `${url}${url.includes("?") ? "&" : "?"}s=${step}`;
}

function primaryImageContentOf(node: CanvasNodeData) {
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === node.metadata?.primaryImageId) || images[0];
    return primary?.content || node.metadata?.content || "";
}

function applyGeneratedVideo(item: CanvasNodeData, video: UploadedFile, extra: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    const videoSize = fitNodeSize(video.width || item.width, video.height || item.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
    return {
        ...item,
        width: videoSize.width,
        height: videoSize.height,
        position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
        // 出片即任务终结：清掉 videoTaskId，避免已完成任务被 hasResumableVideoTask 反复重新轮询。
        metadata: { ...item.metadata, ...videoMetadata(video), ...extra, videoTaskId: undefined, videoTaskProvider: undefined },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function measureFocusFrame(container: HTMLDivElement | null, nodeId: string) {
    if (!container) return {};
    const nodeRect = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.getBoundingClientRect();
    const panelRect = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] [data-node-panel]`)?.getBoundingClientRect();
    const toolbarRect = document.querySelector<HTMLElement>(`[data-node-toolbar="${nodeId}"]`)?.getBoundingClientRect();
    const dockRect = document.querySelector<HTMLElement>("[data-canvas-bottom-toolbar]")?.getBoundingClientRect();
    const below = nodeRect && panelRect ? panelRect.bottom - nodeRect.bottom : 0;
    const above = nodeRect && toolbarRect ? nodeRect.top - toolbarRect.top : 0;
    return { above, below, bottomInset: dockRect && below > 0 ? Math.max(0, container.getBoundingClientRect().bottom - dockRect.top) : 0 };
}

type BatchDownloadDirectory = {
    getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
        createWritable: () => Promise<{
            write: (data: Blob) => Promise<void>;
            close: () => Promise<void>;
        }>;
    }>;
};

type WindowWithDirectoryPicker = Window & {
    showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<BatchDownloadDirectory>;
};

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const projectId = params.id || "";
    useEffect(() => {
        setNodeSettingsScope(projectId);
    }, [projectId]);
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        // Keyed by node id so drag frames look positions up in O(1) instead of scanning the array per node.
        initialSelectedNodes: Map<string, { x: number; y: number }>;
        movedIds: Set<string>;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: new Map(),
        movedIds: new Set(),
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [automationRunningIds, setAutomationRunningIds] = useState<Set<string>>(new Set());
    const automationControllersRef = useRef(new Map<string, AbortController>());
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [onboardingOpen, setOnboardingOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);

    useEffect(() => {
        if (!projectLoaded || !nodesRef.current.some((node) => node.metadata?.freeCard)) return;
        let canceled = false;
        void fetchFreeWorkflows(effectiveConfig)
            .then((items) => {
                if (canceled) return;
                const outputTypes = new Map<string, "image" | "video" | "other">(items.map((item) => [item.id, item.outputType === "video" ? "video" : item.outputType === "image" ? "image" : "other"]));
                setNodes((prev) => {
                    let changed = false;
                    const next = prev.map((node) => {
                        const card = node.metadata?.freeCard;
                        if (!card) return node;
                        const outputType = outputTypes.get(card.id);
                        if (!outputType || outputType === card.outputType) return node;
                        changed = true;
                        return { ...node, metadata: { ...node.metadata, freeCard: { ...card, outputType } } };
                    });
                    return changed ? next : prev;
                });
            })
            .catch(() => {});
        return () => {
            canceled = true;
        };
    }, [effectiveConfig, projectLoaded]);
    useEffect(() => {
        if (!projectLoaded) return;
        setConnections((prev) => {
            let changed = false;
            const next = prev.map((connection) => {
                if (connection.role !== "lineage" || !connection.toNodeId.startsWith("drama-video-")) return connection;
                if (!/^drama-(frame|character|scene|prop)-/.test(connection.fromNodeId)) return connection;
                changed = true;
                return { ...connection, role: undefined };
            });
            return changed ? next : prev;
        });
        setNodes((prev) => {
            let changed = false;
            const next = prev.map((node) => {
                if (!node.metadata?.dramaCard?.progress) return node;
                changed = true;
                return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, stepProgress: undefined, dramaCard: { ...node.metadata.dramaCard, progress: undefined } } };
            });
            return changed ? next : prev;
        });
    }, [projectLoaded, setConnections, setNodes]);
    useEffect(() => {
        if (!projectLoaded || searchParams.get("guide") !== "1") return;
        setOnboardingOpen(true);
        const next = new URLSearchParams(searchParams);
        next.delete("guide");
        setSearchParams(next, { replace: true });
    }, [projectLoaded, searchParams, setSearchParams]);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [to3dChoiceNodeId, setTo3dChoiceNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const lastPanelNodeIdRef = useRef<string | null>(null);
    useEffect(() => {
        const openMask = () => {
            const id = lastPanelNodeIdRef.current;
            const node = id ? nodesRef.current.find((item) => item.id === id) : null;
            if (!node) return;
            if (!node.metadata?.content) {
                message.warning("这张卡片还没有底图：先连接或生成一张图，再做局部编辑");
                return;
            }
            setMaskEditSourceUrl(null);
            setMaskEditNodeId(node.id);
        };
        window.addEventListener("cw:open-mask-editor", openMask);
        return () => window.removeEventListener("cw:open-mask-editor", openMask);
    }, [message]);
    const [maskEditSourceUrl, setMaskEditSourceUrl] = useState<string | null>(null);
    const [styleRecipeDraft, setStyleRecipeDraft] = useState<StyleRecipeDraft | null>(null);
    const [blockedStyleRecipe, setBlockedStyleRecipe] = useState<{ recipe: StyleRecipe; missingModel: boolean; missingLoras: string[] } | null>(null);
    const [outpaintNodeId, setOutpaintNodeId] = useState<string | null>(null);
    const [mossLayoutNodeId, setMossLayoutNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [videoUpscaleNodeId, setVideoUpscaleNodeId] = useState<string | null>(null);
    const [videoEditNodeId, setVideoEditNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [compareNodeIds, setCompareNodeIds] = useState<[string, string] | null>(null);
    const [editVideoNodes, setEditVideoNodes] = useState<CanvasNodeData[]>([]);
    const previewVideoRef = useRef<HTMLVideoElement | null>(null);
    const [hoverPreviewNodeId, setHoverPreviewNodeId] = useState<string | null>(null);
    const [hoverPreviewImageId, setHoverPreviewImageId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedBatchNodeIds, setExpandedBatchNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const stageMergeArmedRef = useRef<Set<string> | null>(null);

    // 3D 台触发：拖拽角色卡到场景卡→建台；拖拽角色卡到已有 3D 台→追加角色。
    // 只处理本次拖拽的卡片，源卡片保留；这样从台里删掉模型后不会被自动加回。
    useEffect(() => {
        if (HIDE_UNRELEASED_FEATURES || isNodeDragging) return;
        const armed = stageMergeArmedRef.current;
        if (!armed || !armed.size) return;
        stageMergeArmedRef.current = null;
        const stageCharacters = (meta: any) => {
            if (!meta) return [];
            if (Array.isArray(meta.characters) && meta.characters.length) return meta.characters;
            if (meta.character?.url) return [{ id: "legacy", ...meta.character, transform: meta.transform }];
            return [];
        };
        const overlaps = (a: CanvasNodeData, b: CanvasNodeData) =>
            a.position.x < b.position.x + b.width + 16 &&
            a.position.x + a.width + 16 > b.position.x &&
            a.position.y < b.position.y + b.height + 16 &&
            a.position.y + a.height + 16 > b.position.y;
        const modelOf = (node: CanvasNodeData) => node.metadata?.model3d;
        const stages = nodes.filter((node) => node.type === STAGE3D_NODE_TYPE && node.metadata?.stage3d?.scene?.url);
        const characters = nodes.filter((node) => node.type === MODEL3D_NODE_TYPE && modelOf(node)?.url && modelOf(node)?.format !== "glb");
        for (const character of characters) {
            if (!armed.has(character.id)) continue;
            const stage = stages.find((candidate) => overlaps(candidate, character));
            if (!stage) continue;
            const meta = stage.metadata?.stage3d;
            const existing = stageCharacters(meta);
            const model = modelOf(character)!;
            if (existing.some((item: any) => item.url === model.url)) return;
            const nextCharacter = { id: nanoid(), url: model.url, filename: model.filename, bytes: model.bytes };
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === stage.id
                        ? { ...node, metadata: { ...node.metadata, stage3d: { ...(meta || { scene: { url: "" } }), characters: [...existing, nextCharacter] } } }
                        : node,
                ),
            );
            setSelectedNodeIds(new Set([stage.id]));
            return;
        }
        const scene = nodes.find((node) => node.type === MODEL3D_NODE_TYPE && modelOf(node)?.url && modelOf(node)?.format === "glb");
        if (!scene) return;
        const character = characters.find((candidate) => overlaps(scene, candidate));
        if (!character) return;
        if (!armed.has(scene.id) && !armed.has(character.id)) return;
        const sceneModel = modelOf(scene)!;
        const characterModel = modelOf(character)!;
        if (stages.some((stage) => stage.metadata?.stage3d?.scene?.url === sceneModel.url && stageCharacters(stage.metadata?.stage3d).some((item: any) => item.url === characterModel.url))) return;
        const stageId = nanoid();
        const stageNode: CanvasNodeData = {
            id: stageId,
            type: STAGE3D_NODE_TYPE,
            title: t("canvas.model3d.stageTitle"),
            position: { x: scene.position.x, y: scene.position.y },
            width: STAGE3D_DEFAULT_SIZE.width,
            height: STAGE3D_DEFAULT_SIZE.height,
            metadata: {
                status: NODE_STATUS_SUCCESS,
                interactive: true,
                content: scene.metadata?.content || sceneModel.url,
                stage3d: {
                    scene: { url: sceneModel.url, filename: sceneModel.filename, bytes: sceneModel.bytes },
                    characters: [{ id: nanoid(), url: characterModel.url, filename: characterModel.filename, bytes: characterModel.bytes }],
                },
            },
        };
        // 合并只新增 3D 台，场景卡和角色卡保留在画布上。
        setNodes((prev) => [...prev, stageNode]);
        setSelectedNodeIds(new Set([stageId]));
        setSelectedConnectionId(null);
        window.setTimeout(() => focusNodeRef.current?.(stageId), 200);
    }, [isNodeDragging, nodes, t]);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const dramaPauseRef = useRef(new Set<string>());
    const generationStartedAtRef = useRef(new Map<string, number>());
    const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
    const generationStepTimersRef = useRef(new Map<string, number>());
    const generationStepTracksRef = useRef(new Map<string, Map<string, { step: number; total: number }>>());
    const videoPollIdsRef = useRef(new Set<string>());

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const refreshGenerationTimer = useCallback(() => {
        const starts = [...generationStartedAtRef.current.values()];
        setGenerationStartedAt(starts.length ? Math.min(...starts) : null);
    }, []);

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController(), expectedProgressCount = 1) => {
        if (!generationStartedAtRef.current.has(targetNodeId)) {
            // 恢复视频任务时沿用节点里持久化的开始时间；新任务才从此刻计时。
            const persistedStartedAt = nodesRef.current.find((item) => item.id === targetNodeId)?.metadata?.generationStartedAt;
            const startedAt = typeof persistedStartedAt === "number" && persistedStartedAt > 0 ? persistedStartedAt : Date.now();
            generationStartedAtRef.current.set(targetNodeId, startedAt);
            refreshGenerationTimer();
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, generationStartedAt: startedAt, generationDurationMs: undefined } } : item)));
        }
        // 复用节点时构造新对象会整体替换 metadata；ref 仍是同一任务，补回本节点开始时间，不回退全局。
        const activeStartedAt = generationStartedAtRef.current.get(targetNodeId);
        if (activeStartedAt !== undefined) {
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId && item.metadata?.generationStartedAt !== activeStartedAt ? { ...item, metadata: { ...item.metadata, generationStartedAt: activeStartedAt } } : item)));
        }
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort("user-stop");
        const pendingClear = generationStepTimersRef.current.get(targetNodeId);
        if (pendingClear) {
            window.clearTimeout(pendingClear);
            generationStepTimersRef.current.delete(targetNodeId);
        }
        generationStepTracksRef.current.delete(targetNodeId);
        setNodes((prev) =>
            prev.map((item) =>
                item.id === targetNodeId && (item.metadata?.stepProgress || (item.metadata?.previewUrl && !item.metadata?.previewPersist))
                    ? { ...item, metadata: { ...item.metadata, stepProgress: undefined, ...(item.metadata?.previewPersist ? {} : { previewUrl: undefined, previewMime: undefined }), previewStep: undefined, previewTotal: undefined } }
                    : item,
            ),
        );
        bindStepProgress(controller.signal, (progress) => {
            if (progress.previewUrl && expectedProgressCount <= 1) {
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== targetNodeId) return item;
                        const previewUrl = stepPreviewUrl(progress.previewUrl, progress.step, item.metadata?.previewUrl, item.metadata?.previewStep);
                        return { ...item, metadata: { ...item.metadata, previewUrl, previewMime: progress.previewMime || "image/jpeg", previewStep: progress.step || undefined, previewTotal: progress.total || undefined } };
                    }),
                );
            }
            const tracks = generationStepTracksRef.current.get(targetNodeId) || new Map<string, { step: number; total: number }>();
            generationStepTracksRef.current.set(targetNodeId, tracks);
            if (progress.requestId) tracks.set(progress.requestId, { step: progress.step, total: progress.total });
            const values = [...tracks.values()].filter((item) => item.total > 0);
            if (!values.length) return;
            const perTotal = Math.max(...values.map((item) => item.total));
            const count = Math.max(expectedProgressCount, tracks.size, 1);
            const completed = values.filter((item) => item.step >= item.total).length;
            const active = values.filter((item) => item.step < item.total).reduce((max, item) => Math.max(max, item.step), 0);
            const total = perTotal * count;
            const step = Math.min(total, completed * perTotal + active);
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, stepProgress: { step, total } } } : item)));
        });
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, [refreshGenerationTimer]);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller !== controller) return;
        generationRequestsRef.current.delete(targetNodeId);
        const startedAt = generationStartedAtRef.current.get(targetNodeId);
        if (startedAt !== undefined) {
            generationStartedAtRef.current.delete(targetNodeId);
            const duration = Math.max(0, Date.now() - startedAt);
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, generationStartedAt: undefined, generationDurationMs: duration } } : item)));
            refreshGenerationTimer();
        }
        generationStepTracksRef.current.delete(targetNodeId);
        unbindStepProgress(controller.signal);
        if (!nodesRef.current.some((item) => item.id === targetNodeId && item.metadata?.stepProgress)) return;
        // Let the last segment light up and glow briefly before the ring fades out.
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== targetNodeId || !item.metadata?.stepProgress) return item;
                const total = item.metadata.stepProgress.total;
                return { ...item, metadata: { ...item.metadata, stepProgress: { step: total, total, complete: true } } };
            }),
        );
        const timer = window.setTimeout(() => {
            generationStepTimersRef.current.delete(targetNodeId);
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId && item.metadata?.stepProgress ? { ...item, metadata: { ...item.metadata, stepProgress: undefined } } : item)));
        }, 1450);
        generationStepTimersRef.current.set(targetNodeId, timer);
    }, [refreshGenerationTimer]);

    const updateVideoPreview = useCallback((nodeId: string, preview: VideoPreview | null) => {
        if (preview && useConfigStore.getState().config.videoPreviewEnabled === false) return;
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const stepProgress = preview?.step != null && preview.total
                    ? { step: preview.step, total: preview.total }
                    : item.metadata?.stepProgress;
                // 网关按 updatedAt 给预览 URL，但同一 URL 可能被浏览器缓存成旧位图；步数变了就加一个穿透参数。
                const previewUrl = preview?.url && preview.step != null && preview.step !== item.metadata?.previewStep && preview.url === item.metadata?.previewUrl
                    ? `${preview.url}${preview.url.includes("?") ? "&" : "?"}s=${preview.step}`
                    : preview?.url;
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        previewUrl,
                        previewMime: preview?.mime,
                        previewStep: preview?.step,
                        previewTotal: preview?.total,
                        stepProgress,
                    },
                };
            }),
        );
    }, []);

    const updateVideoSteps = useCallback((nodeId: string, steps: { step: number; total: number }) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, stepProgress: steps } } : item)));
    }, []);

    // 降级提示由网关在仅降级时给出，只展示、不阻断。
    const updateVideoFallback = useCallback((nodeId: string, notice: string | undefined) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, fallbackNotice: notice || undefined } } : item)));
    }, []);

    // 视频编辑自动制备：抽帧 → 改图 → 把 P 作为裸图像对象注入参考槽（可删可换）。
    const handleVigglePrepare = useCallback(async (nodeId: string) => {
        const videoNode = nodesRef.current.find((item) => item.id === nodeId);
        if (!videoNode) return;
        const connection = connectionsRef.current.find((item) => {
            if (item.toNodeId !== nodeId || item.role === "lineage") return false;
            const candidate = nodesRef.current.find((node) => node.id === item.fromNodeId);
            return candidate?.type === CanvasNodeType.Video && Boolean(candidate.metadata?.content);
        });
        const source = connection ? nodesRef.current.find((item) => item.id === connection.fromNodeId) : undefined;
        const videoUrl = String(source?.metadata?.content || videoNode.metadata?.content || "");
        const instruction = String(videoNode.metadata?.prompt || "").trim();
        if (!videoUrl) return message.error("缺少源视频：请先连接一段源视频，或给当前视频卡上传视频");
        if (!instruction) return message.error("先填写编辑指令，再点生成");
        const setPrep = (patch: { phase: "running" | "done" | "error"; step?: string; error?: string } | undefined) =>
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, vigglePrep: patch } } : item)));
        const machine = createViggleEditPrep(createGatewayPrepAdapter(() => effectiveConfig));
        machine.subscribe((state) => {
            if (state.phase === "running") setPrep({ phase: "running", step: state.step });
        });
        try {
            const sourceBlob = await fetch(videoUrl).then((response) => response.blob());
            const file = new File([sourceBlob], `source-${nodeId}.mp4`, { type: sourceBlob.type || "video/mp4" });
            const result = await machine.run({ sourceVideoUrl: videoUrl, videoFile: file, instruction });
            const imageBlob = await fetch(result.imageUrl).then((response) => response.blob());
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error("读取制备图失败"));
                reader.readAsDataURL(imageBlob);
            });
            const stored = await uploadImage(dataUrl);
            const imageId = nanoid();
            setNodes((prev) => [
                ...prev,
                {
                    id: imageId,
                    type: CanvasNodeType.Image,
                    title: "制备参考",
                    position: { x: videoNode.position.x - 320, y: videoNode.position.y },
                    width: stored.width,
                    height: stored.height,
                    metadata: { status: "idle", bare: true, content: stored.url, storageKey: stored.storageKey, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: imageId, toNodeId: nodeId }]);
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, videoPins: String(result.pins), vigglePrep: { phase: "done", frame: result.frameNumber, pin: String(result.pins), thumbUrl: result.thumbUrl || result.imageUrl, targetFrameUrl: result.targetFrameUrl, candidates: result.candidates } } } : item)));
            message.success(`已注入参考帧（pins=${result.pins}），确认后可点生成`);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            setPrep({ phase: "error", error: text });
            message.error("自动制备失败，请按提示手动抽帧后上传");
        }
    }, [effectiveConfig, message]);

    const selfVideoReference = (node: CanvasNodeData | undefined): ReferenceVideo | undefined =>
        node?.type === CanvasNodeType.Video && node.metadata?.content
            ? {
                  id: `self:${node.id}`,
                  name: `source-${node.id}.mp4`,
                  type: node.metadata.mimeType || "video/mp4",
                  url: String(node.metadata.content),
                  storageKey: node.metadata.storageKey,
                  bytes: node.metadata.bytes,
                  width: node.metadata.naturalWidth,
                  height: node.metadata.naturalHeight,
              }
            : undefined;

    const completeVideoNodeTask = useCallback(
        async (nodeId: string, config: Parameters<typeof buildGenerationConfig>[0], prompt: string, images: Parameters<typeof createVideoGenerationTask>[2], signal: AbortSignal, extra: CanvasNodeData["metadata"] = {}, videos: ReferenceVideo[] = [], audios: ReferenceAudio[] = []) => {
            const currentNode = nodesRef.current.find((node) => node.id === nodeId);
            const selfVideo = videoWorkflowId(config, config.model) === "video-h3-viggle-swap" ? selfVideoReference(currentNode) : undefined;
            const taskVideos = selfVideo && !videos.some((video) => video.url || video.storageKey) ? [selfVideo, ...videos] : videos;
            const task = await createVideoGenerationTask(config, prompt, images, { signal, videos: taskVideos, audios });
            const compiledPrompt = task.compiledPrompt;
            const effectivePrompt = compiledPrompt || prompt;
            if (task.provider !== "plugin") {
                setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: task.provider === "swap-chain" ? "swap-chain" : task.provider === "gemini" ? "gemini" : "openai", model: config.model, params: config.params, ...(compiledPrompt ? { prompt: compiledPrompt } : {}), previewStep: undefined, previewTotal: undefined } } : item)));
            }
            if (task.fallbackNotice) updateVideoFallback(nodeId, task.fallbackNotice);
            if (task.autoPins?.frame != null) setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, videoPins: String(task.autoPins?.frame), vigglePrep: { phase: "done", frame: task.autoPins?.frame, pin: String(task.autoPins?.frame), similarity: autoPinSimilarity(task.autoPins) } } } : item)));
            const video = await storeGeneratedVideo(await waitForVideoGenerationTask(config, task, { signal, onPreview: (preview) => updateVideoPreview(nodeId, preview), onSteps: (steps) => updateVideoSteps(nodeId, steps), onFallbackNotice: (notice) => updateVideoFallback(nodeId, notice) }));
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? applyGeneratedVideo(item, video, { prompt: effectivePrompt, model: config.model, ...extra, previewUrl: undefined, previewMime: undefined, previewStep: undefined, previewTotal: undefined }) : item)));
        },
        [updateVideoPreview, updateVideoSteps],
    );

    const pollVideoNodeTask = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            const taskId = node.metadata?.videoTaskId;
            if (!taskId || node.metadata?.content || generationRequestsRef.current.has(node.id) || videoPollIdsRef.current.has(node.id)) return;
            videoPollIdsRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
                const clearResumedTimer = () => {
                    if (generationStartedAtRef.current.delete(node.id)) refreshGenerationTimer();
                    setNodes((prev) => prev.map((item) => (item.id === node.id && item.metadata?.generationStartedAt !== undefined ? { ...item, metadata: { ...item.metadata, generationStartedAt: undefined } } : item)));
                };
                if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                    // 无法继续轮询就没有“正在跑”的任务，不能留下幽灵计时。
                    clearResumedTimer();
                    if (silent) {
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: t("workbench.configFirst") } } : item)));
                        return;
                    }
                    openConfigDialog(true);
                    return;
                }
                setRunningNodeId(node.id);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
                controller = startGenerationRequest(node.id, node.id, node.id);
                try {
                    const resumeInfo = await readVideoTaskResumeInfo(generationConfig, { id: taskId, provider: node.metadata?.videoTaskProvider === "swap-chain" ? "swap-chain" : node.metadata?.videoTaskProvider === "gemini" ? "gemini" : "openai", model: generationConfig.model });
                    if (resumeInfo?.status === "not_found") {
                        // 网关重启后旧任务已不存在：停止轮询、清掉任务 id 与幽灵计时，节点回到可重新生成的空闲态。
                        generationStartedAtRef.current.delete(node.id);
                        refreshGenerationTimer();
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, videoTaskId: undefined, videoTaskProvider: undefined, status: NODE_STATUS_IDLE, errorDetails: undefined, generationStartedAt: undefined, previewUrl: undefined, previewMime: undefined, previewStep: undefined, previewTotal: undefined } } : item)));
                        return;
                    }
                    const terminal = resumeInfo?.status === "completed" || resumeInfo?.status === "failed" || resumeInfo?.status === "cancelled";
                    if (terminal) {
                        // 网关说任务已经结束：不能拿旧开始时间算时长，否则会留下幽灵计时。
                        const exactDuration = resumeInfo?.createdAtMs != null && resumeInfo?.completedAtMs != null ? Math.max(0, resumeInfo.completedAtMs - resumeInfo.createdAtMs) : undefined;
                        generationStartedAtRef.current.delete(node.id);
                        refreshGenerationTimer();
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, generationStartedAt: undefined, ...(exactDuration !== undefined ? { generationDurationMs: exactDuration } : {}) } } : item)));
                    } else if (resumeInfo?.createdAtMs && resumeInfo.createdAtMs <= Date.now() && generationStartedAtRef.current.has(node.id)) {
                        // 网关的 createdAt 比本地持久化更准（例如换机器/清缓存后恢复）。
                        const gatewayStartedAt = resumeInfo.createdAtMs;
                        generationStartedAtRef.current.set(node.id, gatewayStartedAt);
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, generationStartedAt: gatewayStartedAt } } : item)));
                        refreshGenerationTimer();
                    }
                } catch {
                    // 任务查询失败：沿用本地时间，由随后的轮询给出最终结果。
                }
                const video = await storeGeneratedVideo(await waitForVideoGenerationTask(generationConfig, { id: taskId, provider: node.metadata?.videoTaskProvider === "swap-chain" ? "swap-chain" : node.metadata?.videoTaskProvider === "gemini" ? "gemini" : "openai", model: generationConfig.model }, { signal: controller.signal, onPreview: (preview) => updateVideoPreview(node.id, preview), onSteps: (steps) => updateVideoSteps(node.id, steps), onFallbackNotice: (notice) => updateVideoFallback(node.id, notice) }));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? applyGeneratedVideo(item, video, {
                                  prompt: item.metadata?.prompt,
                                  model: generationConfig.model,
                                  size: generationConfig.size,
                                  seconds: generationConfig.videoSeconds,
                                  vquality: generationConfig.vquality,
                                  generateAudio: generationConfig.videoGenerateAudio,
                                  watermark: generationConfig.videoWatermark,
                                  videoMode: generationConfig.videoMode,
                                  previewUrl: undefined,
                                  previewMime: undefined,
                                  previewStep: undefined,
                                  previewTotal: undefined,
                              })
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      ...(isVideoTaskFailed(error) ? { videoTaskId: undefined } : {}),
                                      previewUrl: undefined,
                                      previewMime: undefined,
                                      previewStep: undefined,
                                      previewTotal: undefined,
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                videoPollIdsRef.current.delete(node.id);
                if (controller) {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                }
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, refreshGenerationTimer, startGenerationRequest, t, updateVideoPreview, updateVideoSteps],
    );

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        const finishedDurations = new Map<string, number>();
        const stoppedAt = Date.now();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId && request.originNodeId !== runningId && request.targetNodeId !== runningId) return;
            request.controller.abort("user-stop");
            generationRequestsRef.current.delete(request.targetNodeId);
            unbindStepProgress(request.controller.signal);
            generationStepTracksRef.current.delete(request.targetNodeId);
            const startedAt = generationStartedAtRef.current.get(request.targetNodeId);
            if (startedAt !== undefined) {
                generationStartedAtRef.current.delete(request.targetNodeId);
                finishedDurations.set(request.targetNodeId, Math.max(0, stoppedAt - startedAt));
            }
            const pendingClear = generationStepTimersRef.current.get(request.targetNodeId);
            if (pendingClear) {
                window.clearTimeout(pendingClear);
                generationStepTimersRef.current.delete(request.targetNodeId);
            }
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        if (finishedDurations.size) refreshGenerationTimer();
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (!affectedNodeIds.has(node.id)) return node;
                const duration = finishedDurations.get(node.id);
                const timerPatch =
                    duration !== undefined
                        ? { generationStartedAt: undefined, generationDurationMs: duration }
                        : node.metadata?.generationStartedAt !== undefined
                          ? { generationStartedAt: undefined }
                          : null;
                if (node.metadata?.status !== NODE_STATUS_LOADING) {
                    return timerPatch ? { ...node, metadata: { ...node.metadata, ...timerPatch } } : node;
                }
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: NODE_STATUS_IDLE,
                        errorDetails: undefined,
                        stepProgress: undefined,
                        images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                        texts: node.metadata.texts?.map((text) => (text.status === NODE_STATUS_LOADING ? { ...text, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : text)),
                        ...(timerPatch ?? {}),
                    },
                };
            }),
        );
    }, [refreshGenerationTimer, t]);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            navigate("/canvas", { replace: true });
            return;
        }

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(clearStaleNodeErrors(resetInterruptedGeneration(project.nodes)));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, navigate, openProject, projectId]);

    useEffect(() => {
        if (!projectLoaded) return;
        const resumable = nodes.filter(hasResumableVideoTask);
        const resumableIds = new Set(resumable.map((node) => node.id));
        let seeded = false;
        for (const node of resumable) {
            const startedAt = node.metadata?.generationStartedAt;
            if (typeof startedAt === "number" && startedAt > 0 && !generationStartedAtRef.current.has(node.id)) {
                generationStartedAtRef.current.set(node.id, startedAt);
                seeded = true;
            }
        }
        if (seeded) refreshGenerationTimer();
        if (nodes.some((node) => !resumableIds.has(node.id) && node.metadata?.generationStartedAt !== undefined)) {
            setNodes((prev) => prev.map((node) => (!resumableIds.has(node.id) && node.metadata?.generationStartedAt !== undefined ? { ...node, metadata: { ...node.metadata, generationStartedAt: undefined } } : node)));
        }
        resumable.forEach((node) => void pollVideoNodeTask(node, true));
        // Resume once after the current canvas is restored, not on later config identity changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);
    const canvasToScreen = useCallback((x: number, y: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        return { x: (rect?.left || 0) + x * currentViewport.k + currentViewport.x, y: (rect?.top || 0) + y * currentViewport.k + currentViewport.y };
    }, []);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: string, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count), ...(recallNodeSettings(type) || {}) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const insertBefore = Boolean(getNodeDefinition(type)?.insertBefore);
            // 注入型插件（如 LoRA 卡）应位于当前节点上游，而不是把当前节点当作它的上游。
            const connection = insertBefore
                ? normalizeConnection(newNode.id, pending.connection.nodeId, [...nodesRef.current, newNode], "source")
                : normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (insertBefore || (type !== CanvasNodeType.Text && (type !== CanvasNodeType.Config || CONFIG_COMPOSER_ENABLED))) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const viewBounds = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const left = -viewport.x / viewport.k - padding;
        const top = -viewport.y / viewport.k - padding;
        return { left, top, right: left + width / viewport.k + padding * 2, bottom: top + height / viewport.k + padding * 2 };
        // `nodes` keeps the container rect re-read on node changes, matching the previous behaviour when the container resizes without a size update.
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const visibleNodes = useMemo(
        () => nodes.filter((node) => node.position.x + node.width > viewBounds.left && node.position.x < viewBounds.right && node.position.y + node.height > viewBounds.top && node.position.y < viewBounds.bottom),
        [nodes, viewBounds],
    );

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

    // Connections are culled like nodes; a cubic curve stays inside its control-point hull, so endpoint bounds widened by the curvature is a safe test.
    const visibleConnections = useMemo(
        () =>
            connections.flatMap((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                if (!from || !to) return [];
                const startX = from.position.x + from.width;
                const startY = from.position.y + from.height / 2;
                const endX = to.position.x;
                const endY = to.position.y + to.height / 2;
                const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
                const inView =
                    Math.max(startX + curvature, endX) > viewBounds.left && Math.min(startX, endX - curvature) < viewBounds.right && Math.max(startY, endY) > viewBounds.top && Math.min(startY, endY) < viewBounds.bottom;
                return inView ? [{ connection, from, to }] : [];
            }),
        [connections, nodeById, viewBounds],
    );
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const outpaintNode = outpaintNodeId ? nodeById.get(outpaintNodeId) || null : null;
    const mossLayoutNode = mossLayoutNodeId ? nodeById.get(mossLayoutNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const videoUpscaleNode = videoUpscaleNodeId ? nodeById.get(videoUpscaleNodeId) || null : null;
    const videoEditNode = videoEditNodeId ? nodeById.get(videoEditNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewImages = Array.isArray(previewNode?.metadata?.images) ? previewNode.metadata.images : [];
    const previewPrimaryImageId = previewNode?.metadata?.primaryImageId || previewImages[0]?.id;
    const previewPrimaryIndex = Math.max(0, previewImages.findIndex((image) => image.id === previewPrimaryImageId));
    const previewRequestedIndex = previewImageId ? previewImages.findIndex((image) => image.id === previewImageId) : previewPrimaryIndex;
    const previewImageIndex = previewImages.length ? Math.max(0, Math.min(previewImages.length - 1, previewRequestedIndex < 0 ? previewPrimaryIndex : previewRequestedIndex)) : 0;
    const previewImage = previewImages[previewImageIndex];
    const previewContent = previewImage?.content || ((!previewImageId || !previewImages.length) ? previewNode?.metadata?.content : undefined);
    const canSwitchPreviewImage = previewNode?.type === CanvasNodeType.Image && previewImages.length > 1 && Boolean(previewContent);
    const goPreviewImage = (offset: -1 | 1) => {
        const nextIndex = previewImageIndex + offset;
        const next = previewImages[nextIndex];
        if (!canSwitchPreviewImage || !next || nextIndex < 0 || nextIndex >= previewImages.length) return;
        setPreviewImageId(next.id);
    };
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const selectedNodes = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id)), [nodes, selectedNodeIds]);
    const selectedVideoNodes = selectedNodes.filter((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content));
    const selectedMediaNodes = selectedNodes.filter((node) => (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content));
    const canBatchDownloadSelection = selectedMediaNodes.length >= 2;
    const selectedCompareNodes = useMemo(() => selectedNodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(primaryImageContentOf(node))), [selectedNodes]);
    const canCompareSelection = selectedCompareNodes.length === 2;
    const openImageCompare = useCallback(() => {
        if (selectedCompareNodes.length !== 2) return;
        const ordered = [...selectedCompareNodes].sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x);
        setCompareNodeIds([ordered[0].id, ordered[1].id]);
    }, [selectedCompareNodes]);
    const compareItems = useMemo(
        () =>
            (compareNodeIds || [])
                .map((id) => nodeById.get(id))
                .filter((node): node is CanvasNodeData => Boolean(node))
                .map((node) => ({ id: node.id, title: node.title, src: primaryImageContentOf(node) })),
        [compareNodeIds, nodeById],
    );
    const syncPlaySelectedVideos = () => {
        const ids = new Set(selectedVideoNodes.map((node) => node.id));
        const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).filter((video) => ids.has(video.dataset.canvasVideo || ""));
        if (!videos.length) return;
        for (const video of videos) {
            video.muted = true;
            try {
                video.currentTime = 0;
            } catch {
                // Ignore videos whose metadata is not ready yet.
            }
        }
        requestAnimationFrame(() => {
            for (const video of videos) void video.play().catch(() => undefined);
        });
    };
    const canGroupSelection = canGroupSelectedNodes(selectedNodeIds, nodes);
    const canUngroupSelection = canUngroupSelectedNodes(selectedNodeIds, nodes);
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) nodes.forEach((node) => node.metadata?.groupId === nodeId && nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections, nodeById, nodes]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const connectedNodesByNodeId = useMemo(() => {
        const map = new Map<string, CanvasNodeData[]>();
        connections.forEach((connection) => {
            if (connection.role === "lineage") return;
            const source = nodeById.get(connection.fromNodeId);
            if (!source) return;
            const connected = map.get(connection.toNodeId);
            if (connected) connected.push(source);
            else map.set(connection.toNodeId, [source]);
        });
        return map;
    }, [connections, nodeById]);
    const referenceConnectedNodeIds = useMemo(() => new Set([referencePickerNodeId, ...(referencePickerNodeId ? connectedNodesByNodeId.get(referencePickerNodeId)?.flatMap((node) => node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes).map((child) => child.id)] : [node.id]) || [] : [])].filter((id): id is string => Boolean(id))), [connectedNodesByNodeId, nodes, referencePickerNodeId]);
    const agentViewportFocusRef = useRef<((nodeId: string) => void) | null>(null);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        getCanvasCenter,
        canvasToScreen,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
        focusNodeRef: agentViewportFocusRef,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const center = getCanvasCenter();
            const freeCardCount = type === CanvasNodeType.FreeCard ? nodesRef.current.filter((node) => node.type === CanvasNodeType.FreeCard).length : 0;
            const targetPosition = position || (freeCardCount ? { x: center.x + (freeCardCount % 8) * 48, y: center.y + (freeCardCount % 8) * 36 } : center);
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                          ...(recallNodeSettings(type) || {}),
                      }
                    : undefined;
            const audioMetadata =
                type === CanvasNodeType.Audio
                    ? {
                          audioMode: "song" as const,
                          prompt: "",
                          composerContent: "",
                          model: effectiveConfig.audioModel,
                          audioStyle: effectiveConfig.audioStyle,
                          audioGenre: effectiveConfig.audioGenre || DEFAULT_AUDIO_GENRE,
                          audioEmotion: effectiveConfig.audioEmotion || DEFAULT_AUDIO_EMOTION,
                          audioSeed: effectiveConfig.audioSeed,
                          audioSongText: "",
                          audioDialogueText: "",
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata ?? audioMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Group;
            if (wantsPanel && (type !== CanvasNodeType.Config || CONFIG_COMPOSER_ENABLED)) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.audioEmotion, effectiveConfig.audioGenre, effectiveConfig.audioModel, effectiveConfig.audioSeed, effectiveConfig.audioStyle, effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const addAudioCard = useCallback(() => {
        const newNode = createCanvasNode(CanvasNodeType.Audio, getCanvasCenter(), {
            audioMode: "song",
            prompt: "",
            composerContent: "",
            model: effectiveConfig.audioModel,
            audioStyle: effectiveConfig.audioStyle,
            audioGenre: effectiveConfig.audioGenre || DEFAULT_AUDIO_GENRE,
            audioEmotion: effectiveConfig.audioEmotion || DEFAULT_AUDIO_EMOTION,
            audioSeed: effectiveConfig.audioSeed,
            audioSongText: "",
            audioDialogueText: "",
        });
        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([newNode.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(newNode.id);
    }, [effectiveConfig.audioModel, effectiveConfig.audioGenre, effectiveConfig.audioEmotion, effectiveConfig.audioSeed, effectiveConfig.audioStyle, getCanvasCenter]);

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setReferencePickerNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedBatchNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const groupSelection = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        const members = collectGroupMemberNodes(selectedIds, nodesRef.current);
        if (members.length < 2) return;
        const rect = getGroupWrapRect(members);
        const created = createCanvasNode(CanvasNodeType.Group, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        const result = applyGroupSelection(selectedIds, nodesRef.current, connectionsRef.current, { ...created, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height });
        if (!result) return;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds[0] || null);
        setDialogNodeId(null);
        setContextMenu(null);
    }, []);

    const ungroupSelection = useCallback((ids?: Set<string>) => {
        const result = applyUngroupSelection(ids || selectedNodeIdsRef.current, nodesRef.current, connectionsRef.current);
        if (!result) return;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds.length === 1 ? result.selectedIds[0] : null);
        setDialogNodeId(null);
        setContextMenu(null);
    }, []);

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, []);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    const selectNodeReference = useCallback((fromNodeId: string) => {
        if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
        const source = nodesRef.current.find((node) => node.id === fromNodeId);
        if (!source || !isCanvasReferenceNode(source, nodesRef.current)) return;
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId }]);
    }, [referenceConnectedNodeIds, referencePickerNodeId]);

    useEffect(() => {
        if (!referencePickerNodeId) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitNodeReferenceSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitNodeReferenceSelection, referencePickerNodeId]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };
        const referenceConnections = connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => ({ ...connection, id: nanoid(), toNodeId: id }));

        setNodes((prev) => [...prev, next]);
        setConnections((prev) => [...prev, ...referenceConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const toNodeId = idMap.get(connection.toNodeId);
            if (!toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId: idMap.get(connection.fromNodeId) ?? connection.fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            setHoverPreviewNodeId(null);
            const target = focusViewportForNode(node, size, measureFocusFrame(containerRef.current, nodeId));
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    const panToNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const current = { ...viewportRef.current };
            const center = getCanvasCenter();
            const target = {
                x: current.x + (center.x - (node.position.x + node.width / 2)) * current.k,
                y: current.y + (center.y - (node.position.y + node.height / 2)) * current.k,
                k: current.k,
            };
            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const duration = 320;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: current.x + (target.x - current.x) * t, y: current.y + (target.y - current.y) * t, k: current.k });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [getCanvasCenter],
    );
    agentViewportFocusRef.current = panToNode;

    const focusNodeRef = useRef(focusNode);
    useEffect(() => {
        focusNodeRef.current = focusNode;
    }, [focusNode]);

    const focusSelectedNode = useCallback(() => {
        const nodeId = selectedNodeIdsRef.current.values().next().value;
        if (nodeId) focusNode(nodeId);
    }, [focusNode]);

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        stageMergeArmedRef.current = null;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        const initialSelectedNodes = new Map(currentNodes.filter((node) => dragIds.has(node.id)).map((node): [string, { x: number; y: number }] => [node.id, { x: node.position.x, y: node.position.y }]));
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes,
            movedIds: new Set(initialSelectedNodes.keys()),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.size === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes.keys().next().value;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;
        const movedIds = dragRef.current.movedIds;
        stageMergeArmedRef.current = dragRef.current.hasMoved ? new Set(movedIds) : null;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.get(node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = new Map();
        dragRef.current.movedIds = new Set();
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
                if (useConfigStore.getState().config.autoFocusOnSelect) {
                    // Wait for the generation panel to render so centering accounts for it.
                    requestAnimationFrame(() => focusNodeRef.current(clickedNodeId));
                }
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                const movedIds = dragRef.current.movedIds;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                // Drop-target detection and node updates both run once per frame; mousemove can fire far more often than the display refreshes.
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    const previewNodes = nodesRef.current.map((node) => {
                        const initial = initialPositions.get(node.id);
                        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                    });
                    setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.get(node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
            // 视频/音频元素自带 data-canvas-no-zoom（避免滚轮缩放），但不该吞掉删除键。
            const mediaDelete = (event.target instanceof HTMLVideoElement || event.target instanceof HTMLAudioElement) && (event.key === "Delete" || event.key === "Backspace");
            if (!mediaDelete && target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                if (event.shiftKey) {
                    if (canUngroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                        event.preventDefault();
                        ungroupSelection();
                    }
                    return;
                }
                if (canGroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                    event.preventDefault();
                    groupSelection();
                }
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, groupSelection, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas, ungroupSelection]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? { ...node, metadata: { ...node.metadata, content, texts: node.metadata?.texts?.map((text) => (text.id === node.metadata?.primaryTextId ? { ...text, content } : text)) } }
                    : node,
            ),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedBatchNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, itemId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                if (node.type === CanvasNodeType.Text) {
                    const text = node.metadata?.texts?.find((item) => item.id === itemId);
                    return text?.content ? { ...node, metadata: { ...node.metadata, content: text.content, primaryTextId: text.id } } : node;
                }
                const image = node.metadata?.images?.find((item) => item.id === itemId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]> = {}) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const clearError = node.metadata?.status === NODE_STATUS_ERROR && patch.status === undefined ? { status: NODE_STATUS_IDLE, errorDetails: undefined } : {};
                return applyNodeConfigPatch(node, { ...patch, ...clearError });
            }),
        );
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const downloadBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        saveAs(image.content, `canvas-image-${node.id}-${image.id}.${imageExtension(image.content)}`);
    }, []);

    const downloadSelectedMedia = useCallback(async () => {
        if (!selectedMediaNodes.length) {
            message.info(t("canvas.batchDownloadEmpty"));
            return;
        }
        const items = selectedMediaNodes.map((node, index) => {
            const content = node.metadata?.content || "";
            const mimeType = node.metadata?.mimeType || "";
            const extension = node.type === CanvasNodeType.Video ? (mimeType.includes("webm") ? "webm" : "mp4") : imageExtension(content);
            const title = (node.title || node.id).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || node.id;
            const baseName = `${String(index + 1).padStart(2, "0")}-${title}`;
            return { content, name: title.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? baseName : `${baseName}.${extension}` };
        });
        const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
        if (picker) {
            try {
                const directory = await picker({ mode: "readwrite" });
                let saved = 0;
                let failed = 0;
                for (const item of items) {
                    try {
                        const response = await fetch(item.content);
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const file = await directory.getFileHandle(item.name, { create: true });
                        const writable = await file.createWritable();
                        await writable.write(await response.blob());
                        await writable.close();
                        saved += 1;
                    } catch {
                        try {
                            saveAs(item.content, item.name);
                            saved += 1;
                        } catch {
                            failed += 1;
                        }
                    }
                }
                if (failed) message.warning(t("canvas.batchDownloadPartial", { count: saved, failed }));
                else message.success(t("canvas.batchDownloaded", { count: saved }));
                return;
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") return;
            }
        }
        let saved = 0;
        let failed = 0;
        for (const item of items) {
            try {
                saveAs(item.content, item.name);
                saved += 1;
            } catch {
                failed += 1;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 160));
        }
        if (failed) message.warning(t("canvas.batchDownloadPartial", { count: saved, failed }));
        else message.success(t("canvas.batchDownloaded", { count: saved }));
    }, [message, selectedMediaNodes, t]);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return message.error(t("canvas.videoFrames.failed"));
            try {
                const image = await uploadImage(await captureVideoFrame(node.metadata.content, position, video.currentTime));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: t(`canvas.videoFrames.${position}Title`, { name: node.title || t("assets.kinds.video") }),
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoFrames.captured"));
            } catch {
                message.error(t("canvas.videoFrames.failed"));
            }
        },
        [message, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            const primaryImage = node.metadata?.images?.find((image) => image.id === node.metadata?.primaryImageId) || node.metadata?.images?.[0];
            const imageContent = primaryImage?.content || node.metadata?.content || "";
            const imageStorageKey = primaryImage?.storageKey || node.metadata?.storageKey;
            if (!imageContent) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = imageStorageKey ? "" : imageContent;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: imageContent,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: imageStorageKey,
                    width: primaryImage?.naturalWidth || node.metadata?.naturalWidth || node.width,
                    height: primaryImage?.naturalHeight || node.metadata?.naturalHeight || node.height,
                    bytes: primaryImage?.bytes || node.metadata?.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: primaryImage?.mimeType || node.metadata?.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, t],
    );

    const stageNodeStyle = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image) return;
            const primaryImage = node.metadata?.images?.find((image) => image.id === node.metadata?.primaryImageId) || node.metadata?.images?.[0];
            const imageContent = primaryImage?.content || node.metadata?.content || "";
            if (!imageContent) {
                message.error(t("canvas.projectPage.noImageToSave"));
                return;
            }
            const imageStorageKey = primaryImage?.storageKey || node.metadata?.storageKey;
            const dataUrl = imageStorageKey ? "" : imageContent;
            const thumbAssetId = addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: imageContent,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: imageStorageKey,
                    width: primaryImage?.naturalWidth || node.metadata?.naturalWidth || node.width,
                    height: primaryImage?.naturalHeight || node.metadata?.naturalHeight || node.height,
                    bytes: primaryImage?.bytes || node.metadata?.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: primaryImage?.mimeType || node.metadata?.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            const prompt = node.metadata?.prompt?.trim() || "";
            const context = buildNodeGenerationContext(node.id, nodesRef.current, connectionsRef.current, prompt);
            const params = (node.metadata?.params || {}) as Record<string, unknown>;
            const storedLoras = normalizeStyleRecipeLoras(params.loras);
            const loras = storedLoras.length ? storedLoras : normalizeStyleRecipeLoras(context.loras);
            setStyleRecipeDraft({
                thumbAssetId,
                loras,
                config: buildStyleRecipeConfig(effectiveConfig, node),
                defaultName: t("canvas.styleRecipes.defaultName"),
            });
        },
        [addAsset, effectiveConfig, message, t],
    );

    const createStyleRecipeCard = useCallback(
        (recipe: StyleRecipe) => {
            const loras = normalizeStyleRecipeLoras(recipe.loras);
            let imageNode = createCanvasNode(CanvasNodeType.Image, getCanvasCenter(), {
                model: recipe.config.model,
            }, { remember: false, inherit: false });
            let loraNode: CanvasNodeData | null = null;
            if (loras.length && isRegisteredNodeType("comfyui-lora:lora")) {
                try {
                    loraNode = createCanvasNode("comfyui-lora:lora" as CanvasNodeTypeId, getCanvasCenter(), {
                        params: { loras },
                    }, { remember: false, inherit: false });
                } catch {
                    imageNode = { ...imageNode, metadata: { ...imageNode.metadata, params: { ...(imageNode.metadata?.params || {}), loras } } };
                }
            } else if (loras.length) {
                imageNode = { ...imageNode, metadata: { ...imageNode.metadata, params: { ...(imageNode.metadata?.params || {}), loras } } };
            }
            if (loraNode) {
                const gap = 32;
                const placedLora = {
                    ...loraNode,
                    position: {
                        x: imageNode.position.x - gap - loraNode.width,
                        y: imageNode.position.y + (imageNode.height - loraNode.height) / 2,
                    },
                };
                setNodes((prev) => [...prev, imageNode, placedLora]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: placedLora.id, toNodeId: imageNode.id }]);
            } else {
                setNodes((prev) => [...prev, imageNode]);
            }
            setSelectedNodeIds(new Set([imageNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(imageNode.id);
            message.success(t("canvas.styleRecipes.applied", { name: recipe.name }));
        },
        [getCanvasCenter, message, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, t],
    );

    const applyStyleRecipe = useCallback(
        (recipe: StyleRecipe) => {
            const loras = normalizeStyleRecipeLoras(recipe.loras);
            const resolved = resolveStyleRecipeModel(effectiveConfig, recipe.config.model);
            const modelMissing = resolved.missing;
            const finish = (missingLoras: string[]) => {
                if (modelMissing || missingLoras.length) {
                    setBlockedStyleRecipe({ recipe: { ...recipe, loras }, missingModel: modelMissing, missingLoras });
                    return;
                }
                const stored = useStyleRecipeStore.getState().recipes.find((item) => item.id === recipe.id);
                if (stored && !stored.loras.length && loras.length) {
                    useStyleRecipeStore.setState((state) => ({ recipes: state.recipes.map((item) => (item.id === recipe.id ? { ...item, loras } : item)) }));
                }
                createStyleRecipeCard({ ...recipe, loras, config: { ...recipe.config, model: resolved.model, modelLabel: resolved.label } });
            };
            if (!loras.length) {
                finish([]);
                return;
            }
            void fetchAvailableLoras().then((available) => {
                if (available === null) {
                    message.error(t("canvas.styleRecipes.loraListUnavailable"));
                    return;
                }
                finish(loras.filter((lora) => !available.includes(lora.name)).map((lora) => lora.name));
            });
        },
        [createStyleRecipeCard, effectiveConfig, message, t],
    );

    const deleteBlockedStyleRecipe = useCallback(() => {
        if (!blockedStyleRecipe) return;
        useStyleRecipeStore.getState().removeRecipe(blockedStyleRecipe.recipe.id);
        message.success(t("canvas.styleRecipes.removed", { name: blockedStyleRecipe.recipe.name }));
        setBlockedStyleRecipe(null);
    }, [blockedStyleRecipe, message, t]);

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            const customWorkflow = isCustomWorkflowModel(node.metadata?.model || "") ? findCustomWorkflow(node.metadata?.model || "") : null;
            const workflowMode = customWorkflow ? customWorkflowView(customWorkflow).mode : "";
            if (!node.metadata?.content && workflowMode !== "edit") return;
            if (workflowMode === "edit" && customWorkflow) {
                if (!customWorkflowView(customWorkflow).maskInputs) {
                    message.error("这个自选工作流没有蒙版输入，不能做局部编辑");
                    return;
                }
                const maskImage = await uploadImage(payload.binaryMaskDataUrl || payload.maskDataUrl);
                const prompt = payload.prompt.trim();
                const nextNodes = nodesRef.current.map((item) => {
                    if (item.id !== node.id) return item;
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata,
                            ...(prompt ? { prompt, composerContent: prompt } : {}),
                            customMask: {
                                content: maskImage.url,
                                storageKey: maskImage.storageKey,
                                mimeType: maskImage.mimeType,
                                naturalWidth: maskImage.width,
                                naturalHeight: maskImage.height,
                                bytes: maskImage.bytes,
                            },
                        },
                    };
                });
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
                setMaskEditNodeId(null);
                setMaskEditSourceUrl(null);
                if (payload.generate) {
                    void handleGenerateNode(node.id, "image", prompt || node.metadata?.prompt || node.metadata?.composerContent || "");
                } else {
                    message.success("蒙版已保存");
                }
                return;
            }
            const maskWorkflowId = channelModelOf(effectiveConfig, buildGenerationConfig(effectiveConfig, node, "image").model)?.model.workflowId;
            const isQwenImage = maskWorkflowId === "image-qwen21" || maskWorkflowId === "image-qwen21-old";
            const baseGenerationConfig = buildGenerationConfig(effectiveConfig, node, "image");
            const generationConfig = {
                ...baseGenerationConfig,
                count: "1",
                size: node.metadata?.size || "auto",
                ...(isQwenImage ? { imageMode: baseGenerationConfig.imageMode === "remove" ? "remove" : "inpaint" } : {}),
            };
            if (payload.generate && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = isQwenImage ? userPrompt : t("canvas.projectPage.maskPrompt", { source: imageReferenceLabel(0), mask: imageReferenceLabel(1), prompt: userPrompt });
            setMaskEditNodeId(null);
            const maskImage = await uploadImage(payload.maskDataUrl);
            const generationMask = isQwenImage ? await uploadImage(payload.binaryMaskDataUrl) : null;
            const maskNodeId = nanoid();
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: node.metadata?.content || "", storageKey: node.metadata?.storageKey };
            const maskSource = { id: maskNodeId, name: "mask.png", type: maskImage.mimeType || "image/png", dataUrl: maskImage.url, storageKey: maskImage.storageKey };
            const references = [source, generationMask ? { ...maskSource, dataUrl: generationMask.url, storageKey: generationMask.storageKey } : maskSource];
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            const childMetadata = payload.generate ? { prompt, status: NODE_STATUS_LOADING, ...generationMetadata } : { prompt };
            setNodes((prev) => [
                ...prev,
                {
                    id: maskNodeId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.projectPage.maskNodeTitle"),
                    position: { x: node.position.x, y: node.position.y + node.height + 96 },
                    width: node.width,
                    height: node.height,
                    metadata: imageMetadata(maskImage),
                },
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: childMetadata,
                },
            ]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: node.id, toNodeId: childId },
                { id: nanoid(), fromNodeId: maskNodeId, toNodeId: childId },
            ]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            if (!payload.generate) return;
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, references, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const outpaintImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasOutpaintPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: "auto",
                imageMode: "outpaint",
                outpaint: { left: payload.left, top: payload.top, right: payload.right, bottom: payload.bottom, width: payload.width, height: payload.height },
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            setOutpaintNodeId(null);
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: node.metadata?.content || "", storageKey: node.metadata?.storageKey };
            const references = [source];
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: payload.prompt.slice(0, 32) || "扩图结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt: payload.prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, payload.prompt, references, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt: payload.prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "扩图失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest],
    );

    const mossLayoutImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasMossLayoutPayload) => {
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: `${payload.width || 1024}x${payload.height || 1024}`,
                imageMode: "layout",
                layout: payload,
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            setMossLayoutNodeId(null);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, imageMode: "layout", layout: payload } } : item)));
            const childId = nanoid();
            const generationMetadata = buildImageGenerationMetadata("generation", generationConfig, 1, []);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: payload.summary.slice(0, 32) || "MOSS 布局结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt: payload.summary, status: NODE_STATUS_LOADING, layout: payload, ...generationMetadata },
                },
            ]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestGeneration(generationConfig, payload.summary, { signal: controller.signal }).then((items) => items[0]);
                if (!image) throw new Error("MOSS 布局生成没有返回图片");
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt: payload.summary, layout: payload, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "MOSS 布局生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest],
    );

    const superResolveImageNode = useCallback(async (node: CanvasNodeData, params: CanvasSuperResolveParams,
        title: string,
    ) => {
        if (!node.metadata?.content) return;
        const childId = nanoid();
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        setRunningNodeId(childId);
        setNodes((prev) => [
            ...prev,
            {
                id: childId,
                type: CanvasNodeType.Image,
                title,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: imageConfig.width,
                height: imageConfig.height,
                metadata: { prompt: node.metadata?.prompt, status: NODE_STATUS_LOADING },
            },
        ]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        const controller = startGenerationRequest(childId, node.id, childId);
        try {
            const image = await requestUpscale(
                effectiveConfig,
                {
                    id: node.id,
                    name: `${node.title || node.id}.png`,
                    type: node.metadata.mimeType || "image/png",
                    dataUrl: node.metadata.content,
                    storageKey: node.metadata.storageKey,
                },
                { workflowId: params.workflowId, params: params.params, signal: controller.signal },
            ).then((items) => items[0]);
            const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
            const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === childId
                        ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS } }
                        : item,
                ),
            );
        } catch (error) {
            if (isGenerationCanceled(error)) return;
            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
            setNodes((prev) =>
                prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)),
            );
        } finally {
            finishGenerationRequest(childId, controller);
            setRunningNodeId(null);
        }
    }, [effectiveConfig, finishGenerationRequest, startGenerationRequest, t]);

    const runSuperResolve = useCallback(
        (node: CanvasNodeData, params: CanvasSuperResolveParams) => superResolveImageNode(node, params, t("canvas.superResolve.title")),
        [superResolveImageNode, t],
    );
    const runFastUpscale = useCallback(
        (node: CanvasNodeData, params: CanvasSuperResolveParams) => superResolveImageNode(node, params, t("canvas.superResolve.fastTitle")),
        [superResolveImageNode, t],
    );

    const upscaleVideoNode = useCallback(
        async (node: CanvasNodeData, params: CanvasVideoUpscaleParams) => {
            if (!node.metadata?.content) return;
            const childId = nanoid();
            const sourceWidth = node.metadata?.naturalWidth || node.width;
            const sourceHeight = node.metadata?.naturalHeight || node.height;
            const size = fitNodeSize(sourceWidth, sourceHeight, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Video,
                    title: params.engine === "relayvsr" ? "RelayVSR 超分" : "SeedVR2 超分",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: { prompt: node.metadata?.prompt, status: NODE_STATUS_LOADING },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId, dashed: true }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const task = await createVideoUpscaleTask(
                    effectiveConfig,
                    {
                        name: `${node.title || node.id}.mp4`,
                        type: node.metadata?.mimeType || "video/mp4",
                        url: node.metadata?.content,
                        storageKey: node.metadata?.storageKey,
                    },
                    { model: params.model, scale: params.scale, resolution: params.resolution, fps: params.fps },
                    { signal: controller.signal },
                );
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: "openai", model: task.model, params: { scale: params.scale, resolution: params.resolution } } }
                            : item,
                    ),
                );
                const video = await storeGeneratedVideo(await waitForVideoGenerationTask(effectiveConfig, task, { signal: controller.signal }));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? applyGeneratedVideo(item, video, {
                                  prompt: node.metadata?.prompt,
                                  model: params.model,
                                  videoMode: "upscale",
                                  previewUrl: undefined,
                                  previewMime: undefined,
                                  previewStep: undefined,
                                  previewTotal: undefined,
                              })
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId((current) => (current === childId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const interpolateVideoNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const childId = nanoid();
            const sourceWidth = node.metadata?.naturalWidth || node.width;
            const sourceHeight = node.metadata?.naturalHeight || node.height;
            const size = fitNodeSize(sourceWidth, sourceHeight, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Video,
                    title: t("canvas.nodeToolbar.interpolateTitle"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: { prompt: node.metadata?.prompt, status: NODE_STATUS_LOADING },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const task = await createVideoInterpolateTask(
                    effectiveConfig,
                    {
                        name: `${node.title || node.id}.mp4`,
                        type: node.metadata?.mimeType || "video/mp4",
                        url: node.metadata?.content,
                        storageKey: node.metadata?.storageKey,
                    },
                    { multiplier: 2 },
                    { signal: controller.signal },
                );
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: "openai", model: "video-rife", params: { multiplier: 2 } } }
                            : item,
                    ),
                );
                const video = await storeGeneratedVideo(await waitForVideoGenerationTask(effectiveConfig, task, { signal: controller.signal }));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? applyGeneratedVideo(item, video, {
                                  prompt: node.metadata?.prompt,
                                  model: "video-rife",
                                  videoMode: "interpolate",
                                  previewUrl: undefined,
                                  previewMime: undefined,
                                  previewStep: undefined,
                                  previewTotal: undefined,
                              })
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId((current) => (current === childId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const draftVideoNode = useCallback(
        async (node: CanvasNodeData) => {
            const basePrompt = (node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim();
            if (!basePrompt) {
                message.warning(t("canvas.nodeToolbar.noPrompt"));
                return;
            }
            const fastModel = videoModelForWorkflow(effectiveConfig, "video-h3-fast");
            if (!fastModel) {
                message.error(t("canvas.nodeToolbar.draftUnavailable"));
                return;
            }
            const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(node.id, nodesRef.current, connectionsRef.current, basePrompt));
            const baseConfig = buildGenerationConfig(effectiveConfig, node, "video");
            const parentMode = String(baseConfig.videoMode || "frames");
            const hasImages = context.referenceImages.length > 0;
            if (parentMode === "reference" && !hasImages) {
                message.warning(t("canvas.nodeToolbar.draftReferenceNeedsImage"));
                return;
            }
            if (parentMode === "reference") {
                if (context.referenceVideos.length || context.referenceAudios.length) {
                    message.info(t("canvas.nodeToolbar.draftReferenceIgnoresMedia"));
                }
            } else if (context.referenceVideos.length || context.referenceAudios.length) {
                message.info(t("canvas.nodeToolbar.draftIgnoresMedia"));
            }
            const draftMode = parentMode === "text" ? "text" : parentMode === "reference" ? "reference" : hasImages ? "frames" : "text";
            let draftImages = draftMode === "reference" ? context.referenceImages.slice(0, DRAFT_REFERENCE_MAX) : draftMode === "frames" ? context.referenceImages.slice(0, 2) : [];
            const parentFrameMode = baseConfig.frameMode;
            const draftFrameMode = draftMode === "frames"
                ? parentFrameMode === "first" || parentFrameMode === "last" || parentFrameMode === "both"
                    ? parentFrameMode
                    : draftImages.length >= 2 ? ("both" as const) : ("first" as const)
                : undefined;
            if (draftMode === "reference" && draftImages.length) {
                const referenceCount = draftImages.length;
                try {
                    draftImages = await prepareDraftReferenceImages(draftImages, draftMode);
                    message.info(referenceCount > 1
                        ? t("canvas.nodeToolbar.draftReferencesStitched", { count: referenceCount })
                        : t("canvas.nodeToolbar.draftReferenceCompressed"));
                } catch (error) {
                    console.warn("draft reference compression failed", error);
                }
            }
            const sourceSize = node.metadata?.naturalWidth && node.metadata?.naturalHeight
                ? `${node.metadata.naturalWidth}x${node.metadata.naturalHeight}`
                : String(baseConfig.size || "9:16");
            const ratio = inferVideoRatio(sourceSize);
            const draftSize = draftLongSideSize(ratio === "auto" ? "9:16" : ratio, 448);
            const draftConfig = {
                ...baseConfig,
                model: fastModel,
                vquality: "448",
                size: draftSize,
                videoMode: draftMode,
                frameMode: draftFrameMode,
                videoSelfLiftMode: "fast",
                // 比例/模式跟主卡；像素和部署始终走 FastH3 极速档，不继承主卡的模型参数。
                params: {
                    ...(baseConfig.params?.seed !== undefined ? { seed: baseConfig.params.seed } : {}),
                    contract: "pdmd-2step",
                    preset: FAST_H3_DRAFT_PRESET,
                    vsaRatio: 0,
                    compile: true,
                    outputBackend: "nvenc",
                    decoderMode: "fused_ff_qk_rope",
                },
            };
            const pixels = parsePixelSize(draftSize) || { width: 256, height: 448 };
            const size = fitNodeSize(pixels.width, pixels.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            const childId = nanoid();
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Video,
                    title: t("canvas.nodeToolbar.draftTitle"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: {
                        prompt: context.prompt,
                        status: NODE_STATUS_LOADING,
                        model: fastModel,
                        vquality: "448",
                        size: draftSize,
                        seconds: draftConfig.videoSeconds,
                        videoMode: draftMode,
                        frameMode: draftFrameMode,
                        videoSelfLiftMode: "fast",
                        params: draftConfig.params,
                    },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                await completeVideoNodeTask(childId, draftConfig, context.prompt, draftImages, controller.signal, {
                    videoMode: draftMode,
                    frameMode: draftFrameMode,
                    size: draftSize,
                    seconds: draftConfig.videoSeconds,
                    vquality: "448",
                    model: draftConfig.model,
                    videoSelfLiftMode: "fast",
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId((current) => (current === childId ? null : current));
            }
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const sourceReference = {
                id: node.id,
                name: `${node.title || node.id}.png`,
                type: node.metadata.mimeType || "image/png",
                dataUrl: node.metadata.content,
                storageKey: node.metadata.storageKey,
            };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [sourceReference]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestImageAngle(generationConfig, prompt, params, [sourceReference], { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, openConfigDialog, startGenerationRequest, t],
    );

    const fourViewImageNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const sourceReference = {
                id: node.id,
                name: `${node.title || node.id}.png`,
                type: node.metadata.mimeType || "image/png",
                dataUrl: node.metadata.content,
                storageKey: node.metadata.storageKey,
            };
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), model: "image-krea2-four-view", count: "1" as const };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [sourceReference]);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.imageTools.fourView"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: FOUR_VIEW_PROMPT, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestImageFourView(effectiveConfig, FOUR_VIEW_PROMPT, [sourceReference], { signal: controller.signal }).then((items) => items[0]);
                if (!image) throw new Error(t("canvas.projectPage.generationFailed"));
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt: FOUR_VIEW_PROMPT, status: NODE_STATUS_SUCCESS, ...generationMetadata } }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId((current) => (current === childId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const runImageTo3D = useCallback(
        async (targetId: string, sourceNode: CanvasNodeData) => {
            if (!sourceNode.metadata?.content) return;
            const mode = sourceNode.metadata?.generationType || sourceNode.metadata?.model || sourceNode.metadata?.freeWorkflowId ? "synthetic" : "real";
            setRunningNodeId(targetId);
            setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const controller = startGenerationRequest(targetId, sourceNode.id, targetId);
            try {
                const dataUrl = await imageToDataUrl({ url: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey });
                const file = dataUrlToFile({
                    id: sourceNode.id,
                    name: `${sourceNode.title || sourceNode.id}.png`,
                    type: sourceNode.metadata.mimeType || "image/png",
                    dataUrl,
                });
                if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                const result = await requestImageTo3D(effectiveConfig, file, { mode, steps: 50 }, { signal: controller.signal });
                if (controller.signal.aborted) return;
                const preview = result.previewUrl ? await uploadImage(result.previewUrl, { signal: controller.signal }) : null;
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === targetId
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      ...(preview
                                          ? { content: preview.url, storageKey: preview.storageKey, mimeType: preview.mimeType, bytes: preview.bytes, naturalWidth: preview.width, naturalHeight: preview.height }
                                          : {}),
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                      model3d: { url: result.modelUrl, bytes: result.modelBytes, filename: result.fileName, mode: result.mode, steps: 50, format: "ply" },
                                      model3dEngine: "idol",
                                      seed: result.seed != null ? String(result.seed) : undefined,
                                  },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: item.metadata?.model3d ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE } } : item)));
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(targetId, controller);
                setRunningNodeId((current) => (current === targetId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const to3DImageNode = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            if ((node.metadata?.images?.length || 0) > 1) message.info(t("canvas.model3d.batchHint"));
            const childId = nanoid();
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: MODEL3D_NODE_TYPE,
                    title: t("canvas.model3d.title"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: MODEL3D_DEFAULT_SIZE.width,
                    height: MODEL3D_DEFAULT_SIZE.height,
                    metadata: { status: NODE_STATUS_LOADING, interactive: true, model3dEngine: "idol" },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            // 等节点进入 nodesRef 后再把视口移到新节点，避免 3D 展示台生成在屏幕外。
            window.setTimeout(() => focusNodeRef.current?.(childId), 120);
            void runImageTo3D(childId, node);
        },
        [message, runImageTo3D, t],
    );

    const scene3DImageNode = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            if ((node.metadata?.images?.length || 0) > 1) message.info(t("canvas.model3d.batchHint"));
            const childId = nanoid();
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: MODEL3D_NODE_TYPE,
                    title: t("canvas.scene3d.title"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: SCENE3D_DEFAULT_SIZE.width,
                    height: SCENE3D_DEFAULT_SIZE.height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        interactive: true,
                        model3dEngine: "panorama",
                        scene3d: { sourceUrl: node.metadata?.content, sourceStorageKey: node.metadata?.storageKey, sourceName: `${node.title || "scene"}.png` },
                    },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            window.setTimeout(() => focusNodeRef.current?.(childId), 120);
        },
        [message, t],
    );

    const runSceneTo3D = useCallback(
        async (targetId: string, sourceNode: CanvasNodeData) => {
            if (!sourceNode.metadata?.content) return;
            setRunningNodeId(targetId);
            setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const controller = startGenerationRequest(targetId, sourceNode.id, targetId);
            try {
                const dataUrl = await imageToDataUrl({ url: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey });
                const file = dataUrlToFile({
                    id: sourceNode.id,
                    name: `${sourceNode.title || sourceNode.id}.png`,
                    type: sourceNode.metadata.mimeType || "image/png",
                    dataUrl,
                });
                if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                const result = await requestSceneTo3D(effectiveConfig, file, { resolution: 6, decimation: 2 }, { signal: controller.signal });
                if (controller.signal.aborted) return;
                const preview = result.previewUrl ? await uploadImage(result.previewUrl, { signal: controller.signal }) : null;
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === targetId
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      ...(preview
                                          ? { content: preview.url, storageKey: preview.storageKey, mimeType: preview.mimeType, bytes: preview.bytes, naturalWidth: preview.width, naturalHeight: preview.height }
                                          : {}),
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                      model3d: { url: result.modelUrl, bytes: result.modelBytes, filename: result.fileName, format: "glb", steps: result.resolution },
                                      model3dEngine: "moge",
                                  },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: item.metadata?.model3d ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE } } : item)));
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(targetId, controller);
                setRunningNodeId((current) => (current === targetId ? null : current));
            }
        },
        [effectiveConfig, finishGenerationRequest, message, startGenerationRequest, t],
    );

    const sceneTo3DImageNode = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            if ((node.metadata?.images?.length || 0) > 1) message.info(t("canvas.model3d.sceneBatchHint"));
            const childId = nanoid();
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: MODEL3D_NODE_TYPE,
                    title: t("canvas.model3d.sceneTitle"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: MODEL3D_DEFAULT_SIZE.width,
                    height: MODEL3D_DEFAULT_SIZE.height,
                    metadata: { status: NODE_STATUS_LOADING, interactive: true, model3dEngine: "moge" },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            window.setTimeout(() => focusNodeRef.current?.(childId), 120);
            void runSceneTo3D(childId, node);
        },
        [message, runSceneTo3D, t],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const targetNode = target?.nodeId ? nodesRef.current.find((node) => node.id === target.nodeId) : null;
            if (targetNode?.type === CanvasNodeType.FreeCard) {
                const imageFile = files.find((file) => file.type.startsWith("image/"));
                if (!imageFile) {
                    message.warning("自由卡片只支持上传图片");
                    uploadTargetRef.current = null;
                    event.target.value = "";
                    return;
                }
                const image = await uploadImage(imageFile);
                const s = fitNodeSize(image.width, image.height, targetNode.width || 320, targetNode.height || 320);
                const imageId = nanoid();
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === targetNode.id
                            ? {
                                  ...node,
                                  position: { x: node.position.x + node.width / 2 - s.width / 2, y: node.position.y + node.height / 2 - s.height / 2 },
                                  width: s.width,
                                  height: s.height,
                                  metadata: {
                                      ...node.metadata,
                                      ...imageMetadata(image),
                                      status: NODE_STATUS_SUCCESS,
                                      errorDetails: undefined,
                                      images: [{ id: imageId, status: NODE_STATUS_SUCCESS, content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType }],
                                      primaryImageId: imageId,
                                      freeResize: false,
                                  },
                              }
                            : node,
                    ),
                );
                setSelectedNodeIds(new Set([targetNode.id]));
                setSelectedConnectionId(null);
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter(
                (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const createImageOutputCards = useCallback(
        async (args: {
            groups: FreeWorkflowOutputGroup[];
            basePosition: { x: number; y: number };
            originNodeId: string;
            freeWorkflowId: string;
            prompt: string;
            model: string;
            size: string;
            generationType: "generation" | "edit";
            signal?: AbortSignal;
        }): Promise<{ childIds: string[]; primaryUploaded: Awaited<ReturnType<typeof uploadImage>> | null }> => {
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const childIds: string[] = [];
            let primaryUploaded: Awaited<ReturnType<typeof uploadImage>> | null = null;
            let rowIndex = 0;
            try {
                for (const group of args.groups) {
                    for (let index = 0; index < group.entries.length; index += 1) {
                        const entry = group.entries[index];
                        if (!entry.dataUrl) continue;
                        const outputKey = `${group.nodeId}:${index}`;
                        const uploaded = await uploadImage(entry.dataUrl, { signal: args.signal });
                        if (!primaryUploaded) primaryUploaded = uploaded;
                        const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                        const title = `${group.title} · ${index + 1}${group.preview ? " · 预览" : ""}`;
                        const cardMetadata = {
                            prompt: args.prompt,
                            status: NODE_STATUS_SUCCESS,
                            model: args.model,
                            size: args.size,
                            generationType: args.generationType,
                            count: 1,
                            freeWorkflowId: args.freeWorkflowId,
                            freeWorkflowOutputNodeId: group.nodeId,
                            freeWorkflowOutputPreview: group.preview,
                            freeWorkflowOutputKey: outputKey,
                            freeWorkflowOriginNodeId: args.originNodeId,
                            ...imageMetadata(uploaded),
                        };
                        const existing = nodesRef.current.find((node) => node.type === CanvasNodeType.Image && node.metadata?.freeWorkflowId === args.freeWorkflowId && node.metadata?.freeWorkflowOriginNodeId === args.originNodeId && node.metadata?.freeWorkflowOutputKey === outputKey);
                        if (existing) {
                            childIds.push(existing.id);
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === existing.id
                                        ? { ...node, title, width: imageSize.width, height: imageSize.height, position: { x: node.position.x + node.width / 2 - imageSize.width / 2, y: node.position.y + node.height / 2 - imageSize.height / 2 }, metadata: { ...node.metadata, ...cardMetadata } }
                                        : node,
                                ),
                            );
                        } else {
                            const childId = nanoid();
                            childIds.push(childId);
                            const position = { x: args.basePosition.x, y: args.basePosition.y + rowIndex * (imageConfig.height + 24) };
                            rowIndex += 1;
                            setNodes((prev) => [...prev, { id: childId, type: CanvasNodeType.Image, title, position, width: imageSize.width, height: imageSize.height, metadata: cardMetadata }]);
                            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: args.originNodeId, toNodeId: childId }]);
                        }
                    }
                }
                const newNodeIds = new Set(args.groups.map((group) => group.nodeId));
                const newKeys = new Set(args.groups.flatMap((group) => group.entries.map((_entry, index) => `${group.nodeId}:${index}`)));
                const stale = nodesRef.current.filter((node) => {
                    const outputNodeId = node.metadata?.freeWorkflowOutputNodeId;
                    const outputKey = node.metadata?.freeWorkflowOutputKey;
                    if (!outputNodeId || !outputKey) return false;
                    return node.type === CanvasNodeType.Image && node.metadata?.freeWorkflowId === args.freeWorkflowId && node.metadata?.freeWorkflowOriginNodeId === args.originNodeId && newNodeIds.has(outputNodeId) && !newKeys.has(outputKey);
                });
                const staleIdsAll = new Set(stale.map((node) => node.id));
                const outgoing = new Set(connectionsRef.current.filter((connection) => staleIdsAll.has(connection.fromNodeId)).map((connection) => connection.fromNodeId));
                const staleIds = new Set([...staleIdsAll].filter((id) => !outgoing.has(id)));
                if (staleIds.size) {
                    setNodes((prev) => prev.filter((node) => !staleIds.has(node.id)));
                    setConnections((prev) => prev.filter((connection) => !staleIds.has(connection.toNodeId) && !staleIds.has(connection.fromNodeId)));
                }
            } catch (error) {
                if (childIds.length) {
                    const childIdSet = new Set(childIds);
                    if (isGenerationCanceled(error)) {
                        setNodes((prev) => prev.filter((node) => !childIdSet.has(node.id)));
                        setConnections((prev) => prev.filter((connection) => !childIdSet.has(connection.toNodeId)));
                    } else {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        setNodes((prev) => prev.map((node) => (childIdSet.has(node.id) ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                }
                throw error;
            }
            return { childIds, primaryUploaded };
        },
        [isGenerationCanceled, setNodes, setConnections, nodesRef, t],
    );

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            const requestedModel = sourceNode?.metadata?.model || "";
            const customWorkflow = isCustomWorkflowModel(requestedModel) ? findCustomWorkflow(requestedModel) : null;
            if (isCustomWorkflowModel(requestedModel) && !customWorkflow) {
                message.error("自选工作流不存在，请重新选择");
                return;
            }
            if (customWorkflow && customWorkflow.enabled === false) {
                message.error("该自选工作流已停用，请到资源中心重新启用");
                return;
            }
            if (!customWorkflow && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt));
                    if (context.loras.length) generationConfig.params = { ...(generationConfig.params || {}), loras: context.loras };
                    const refs = context.referenceImages;
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, context.prompt, refs, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, context.prompt, { signal: controller.signal }).then((items) => items[0]);
                    const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, params: generationConfig.params, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const overwriteExisting = effectiveConfig.nodeRegenerateBehavior === "overwrite";
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
            );
            if (generationContext.loras.length) generationConfig.params = { ...(generationConfig.params || {}), loras: generationContext.loras };
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && mode === "text") {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            if (!effectivePrompt && mode === "audio" && generationConfig.audioMode !== "song") {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), params: generationConfig.params, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const reuseImageNode = isImageNode && (overwriteExisting || isEmptyImageNode);
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content && !overwriteExisting && !generationContext.referenceImages.length
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = dedupeReferenceImages<ReferenceImage>(sourceReference, generationContext.referenceImages);
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = reuseImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: reuseImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: reuseImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: reuseImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            primaryImageId: undefined,
                            ...generationMetadata,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : reuseImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, content: undefined, storageKey: undefined, naturalWidth: undefined, naturalHeight: undefined, bytes: undefined, mimeType: undefined, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(reuseImageNode ? [] : [rootNode]),
                    ]);
                    if (!reuseImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = startGenerationRequest(rootId, nodeId, nodeId, runController, count);
                    const customParams = (generationConfig.params?.customParams as Record<string, unknown> | undefined) || {};
                    const sizeValue = String(generationConfig.size || "");
                    const customMask = sourceNode?.metadata?.customMask;
                    const requestCustomImage = async () => {
                        if (!customWorkflow) throw new Error("自选工作流不存在");
                        let requestImages = referenceImages;
                        let requestMask = customMask ? { id: `${sourceNode?.id || "mask"}-mask`, name: "mask.png", type: customMask.mimeType || "image/png", dataUrl: customMask.content, storageKey: customMask.storageKey } : undefined;
                        if (customWorkflow.maskMode === "alpha" && customMask) {
                            const source = referenceImages[0];
                            if (!source) throw new Error("局部编辑需要原图");
                            const composed = await composeImageWithAlphaMask(source.dataUrl, customMask.content);
                            requestImages = [{ ...source, name: "masked.png", type: "image/png", dataUrl: composed }, ...referenceImages.slice(1)];
                            requestMask = undefined;
                        }
                        return await requestFreeWorkflowImage(effectiveConfig, customWorkflow.freeId, {
                            prompt: effectivePrompt,
                            ...buildCustomTextRequest(customWorkflow, sourceNode?.metadata?.customTexts),
                            size: /^\d+x\d+$/i.test(sizeValue) ? sizeValue : undefined,
                            ratio: /^\d+:\d+$/.test(sizeValue) ? sizeValue : undefined,
                            count: 1,
                            seed: generationConfig.seed,
                            seedFixed: generationConfig.seedFixed === "true",
                            images: requestImages,
                            mask: requestMask,
                            params: customParams,
                            loras: (generationConfig.params?.loras as Array<{ name: string; strength?: number; enabled?: boolean }> | undefined) || [],
                            bypassStages: customWorkflowView(customWorkflow).disabledStages || [],
                            enableGroups: customWorkflowView(customWorkflow).enabledGroups || [],
                            flowId: customWorkflow.flowId || "",
                            fields: customWorkflowView(customWorkflow).params,
                            signal: controller.signal,
                        });
                    };
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    await Promise.all(
                        imageIds.map(async (imageId) => {
                            const onImageProgress = (progress: GenerationStepProgress) => {
                                if (!progress.previewUrl) return;
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === rootId
                                            ? {
                                                  ...node,
                                                  metadata: {
                                                      ...node.metadata,
                                                      images: (node.metadata?.images || []).map((image) => (image.id === imageId ? { ...image, previewUrl: stepPreviewUrl(progress.previewUrl, progress.step, image.previewUrl, image.previewStep), previewStep: progress.step, previewTotal: progress.total } : image)),
                                                  },
                                              }
                                            : node,
                                    ),
                                );
                            };
                            try {
                                const imageResult = customWorkflow
                                    ? await requestCustomImage()
                                    : referenceImages.length
                                      ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, { signal: controller.signal, onProgress: onImageProgress }).then((items) => items[0])
                                      : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal, onProgress: onImageProgress }).then((items) => items[0]);
                                const image = "images" in imageResult ? imageResult.images[0] : imageResult;
                                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                                if ("images" in imageResult) {
                                    const primaryGroup = imageResult.outputs.find((group) => group.nodeId === imageResult.primaryNodeId) || imageResult.outputs[0];
                                    const siblingGroups = imageResult.outputs
                                        .map((group) => (group === primaryGroup ? { ...group, entries: group.entries.slice(1) } : group))
                                        .filter((group) => group.entries.length > 0);
                                    if (siblingGroups.length) {
                                        const created = await createImageOutputCards({
                                            groups: siblingGroups,
                                            basePosition: rootNode.position,
                                            originNodeId: nodeId,
                                            freeWorkflowId: customWorkflow?.freeId || "",
                                            prompt: effectivePrompt,
                                            model: customWorkflow?.name || "",
                                            size: sizeValue,
                                            generationType,
                                            signal: controller.signal,
                                        });
                                        pendingChildIds.push(...created.childIds);
                                    }
                                }
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails, previewUrl: undefined, previewStep: undefined, previewTotal: undefined } : image)) } } : node)));
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.allFailed") } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video" && customWorkflow) {
                    const customView = customWorkflowView(customWorkflow);
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const reuseVideoNode = sourceNode?.type === CanvasNodeType.Video && (overwriteExisting || isEmptyVideoNode);
                    const videoId = reuseVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || customWorkflow.name,
                        position: reuseVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: reuseVideoNode ? sourceNode.width : spec.width,
                        height: reuseVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            videoMode: generationConfig.videoMode,
                            references: generationReferenceUrls(generationContext),
                            freeWorkflowId: customWorkflow.freeId,
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        reuseVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!reuseVideoNode) {
                        const inheritedInputs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current).filter(
                            (input) => input.type === "image" || input.type === "video" || input.type === "audio" || input.type === "group" || input.type === "lora",
                        );
                        const inheritedConnections = [...new Map(inheritedInputs.map((input) => [input.nodeId, input])).values()].map((input) => ({
                            id: nanoid(),
                            fromNodeId: input.nodeId,
                            toNodeId: videoId,
                        }));
                        setConnections((prev) => [...prev, ...inheritedConnections, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId, role: "lineage" as const }]);
                    }
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const sizeValue = String(generationConfig.size || "");
                        const customParams = (sourceNode?.metadata?.params?.customParams as Record<string, unknown> | undefined) || {};
                        const taskId = await createFreeWorkflowVideoTask(effectiveConfig, customWorkflow.freeId, {
                            prompt: effectivePrompt,
                            size: /^\d+x\d+$/i.test(sizeValue) ? sizeValue : undefined,
                            ratio: /^\d+:\d+$/.test(sizeValue) ? sizeValue : undefined,
                            count: 1,
                            seed: generationConfig.seed,
                            seedFixed: generationConfig.seedFixed === "true",
                            images: generationContext.referenceImages,
                            loras: (generationConfig.params?.loras as Array<{ name: string; strength?: number; enabled?: boolean }> | undefined) || [],
                            params: customParams,
                            fields: customView.params,
                            flowId: customWorkflow.flowId || "",
                            bypassStages: customView.disabledStages || [],
                            enableGroups: customView.enabledGroups || [],
                            ...buildCustomTextRequest(customWorkflow, sourceNode?.metadata?.customTexts),
                            signal: controller.signal,
                        });
                        setNodes((prev) => prev.map((item) => (item.id === videoId ? { ...item, metadata: { ...item.metadata, videoTaskId: taskId, videoTaskProvider: "openai" } } : item)));
                        const localVideoModel = effectiveConfig.videoModel || effectiveConfig.model;
                        const video = await storeGeneratedVideo(
                            await waitForVideoGenerationTask(
                                effectiveConfig,
                                { id: taskId, provider: "openai", model: localVideoModel },
                                { signal: controller.signal, onPreview: (preview) => updateVideoPreview(videoId, preview), onSteps: (steps) => updateVideoSteps(videoId, steps), onFallbackNotice: (notice) => updateVideoFallback(videoId, notice) },
                            ),
                        );
                        setNodes((prev) =>
                            prev.map((item) =>
                                item.id === videoId
                                    ? applyGeneratedVideo(item, video, { prompt: effectivePrompt, model: generationConfig.model, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality, generateAudio: generationConfig.videoGenerateAudio, watermark: generationConfig.videoWatermark, videoMode: generationConfig.videoMode, freeWorkflowId: customWorkflow.freeId, previewUrl: undefined, previewMime: undefined, previewStep: undefined, previewTotal: undefined })
                                    : item,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const reuseVideoNode = sourceNode?.type === CanvasNodeType.Video && (overwriteExisting || isEmptyVideoNode);
                    const videoId = reuseVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoSettings = {
                        videoMode: generationConfig.videoMode,
                        videoViggleMode: generationConfig.videoViggleMode,
                        videoSwapTarget: generationConfig.videoSwapTarget,
                        videoSwapTargetBox: generationConfig.videoSwapTargetBox,
                        videoPins: generationConfig.videoPins,
                        videoSegmentSeconds: generationConfig.videoSegmentSeconds,
                        videoLongVideo: generationConfig.videoLongVideo,
                        videoSage: generationConfig.videoSage,
                        videoInterpolation: generationConfig.videoInterpolation,
                        videoSelfLiftMode: generationConfig.videoSelfLiftMode,
                        frameMode: generationConfig.frameMode,
                    };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: reuseVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: reuseVideoNode ? sourceNode.width : spec.width,
                        height: reuseVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            // 弹卡带入的 painted preview 在生成启动时不能被清掉：生成中卡要显示这张图。
                            ...(sourceNode?.metadata?.previewPersist && sourceNode.metadata?.previewUrl
                                ? { previewUrl: sourceNode.metadata.previewUrl, previewMime: sourceNode.metadata.previewMime, previewPersist: true }
                                : {}),
                            // 优化前的原提示词常驻：复用卡重建 metadata 不能把「原提示词」清掉（FB-16）。
                            ...(sourceNode?.metadata?.promptOptimizeSource ? { promptOptimizeSource: sourceNode.metadata.promptOptimizeSource } : {}),
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            ...videoSettings,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        reuseVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!reuseVideoNode) {
                        const inheritedInputs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current).filter(
                            (input) => input.type === "image" || input.type === "video" || input.type === "audio" || input.type === "group" || input.type === "lora",
                        );
                        const inheritedConnections = [...new Map(inheritedInputs.map((input) => [input.nodeId, input])).values()].map((input) => ({
                            id: nanoid(),
                            fromNodeId: input.nodeId,
                            toNodeId: videoId,
                        }));
                        setConnections((prev) => [...prev, ...inheritedConnections, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId, role: "lineage" as const }]);
                    }
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    const selfSourceVideo = videoWorkflowId(generationConfig, generationConfig.model) === "video-h3-viggle-swap" ? selfVideoReference(sourceNode) : undefined;
                    const sourceVideos = selfSourceVideo && !generationContext.referenceVideos.length ? [selfSourceVideo] : generationContext.referenceVideos;
                    try {
                        await completeVideoNodeTask(videoId, generationConfig, effectivePrompt, generationContext.referenceImages, controller.signal, {
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            ...videoSettings,
                            references: generationReferenceUrls(generationContext),
                        }, sourceVideos, generationContext.referenceAudios);
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const reuseAudioNode = sourceNode?.type === CanvasNodeType.Audio && (overwriteExisting || isEmptyAudioNode);
                    const audioId = reuseAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: reuseAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: reuseAudioNode ? sourceNode.width : spec.width,
                        height: reuseAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        reuseAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!reuseAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const wiredReference = generationContext.referenceAudios[0];
                        const audio = generationConfig.channelMode === "local"
                            ? await storeGeneratedAudio(
                                await requestLocalAudioPipeline(generationConfig, effectivePrompt, generationContext, controller.signal),
                                generationConfig.audioMode === "song" ? "flac" : "wav",
                            )
                            : await storeGeneratedAudio(
                                await requestAudioGeneration(generationConfig, effectivePrompt, {
                                    signal: controller.signal,
                                    referenceAudio: wiredReference ? { url: wiredReference.url, storageKey: wiredReference.storageKey, name: wiredReference.name } : undefined,
                                }),
                                generationConfig.audioFormat,
                            );
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const isEmptyTextNode = sourceNode?.type === CanvasNodeType.Text && !sourceTextContent;
                const reuseTextNode = sourceNode?.type === CanvasNodeType.Text && (overwriteExisting || isEmptyTextNode);
                const rootId = reuseTextNode ? nodeId : nanoid();
                const textIds = Array.from({ length: textCount }, () => nanoid());
                const rootNode: CanvasNodeData = {
                    id: rootId,
                    type: CanvasNodeType.Text,
                    title: effectivePrompt.slice(0, 32) || "Generated Text",
                    position: reuseTextNode ? sourceNode.position : { x: parentPosition.x + parentConfig.width + 96, y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 },
                    width: reuseTextNode ? sourceNode.width : textConfig.width,
                    height: reuseTextNode ? sourceNode.height : textConfig.height,
                    metadata: {
                        prompt: effectivePrompt,
                        status: NODE_STATUS_LOADING,
                        fontSize: 14,
                        model: generationConfig.model,
                        reasoningEffort: generationConfig.reasoningEffort,
                        textCount,
                        texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })),
                        primaryTextId: textIds[0],
                    },
                };
                pendingChildIds = [rootId];
                setNodes((prev) =>
                    reuseTextNode
                        ? prev.map((node) => (node.id === nodeId ? { ...node, ...rootNode } : node))
                        : [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), rootNode],
                );
                if (!reuseTextNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(nodeId);

                const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                const results = await Promise.all(
                    textIds.map(async (textId): Promise<CanvasNodeText | null> => {
                        let streamed = "";
                        try {
                            const answer = await requestImageQuestion(
                                generationConfig,
                                buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                                (text) => {
                                    streamed = text;
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                },
                                { signal: controller.signal },
                            );
                            const content = answer || streamed;
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === rootId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                                  texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS } : item)),
                                              },
                                          }
                                        : node,
                                ),
                            );
                            return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                        } catch (error) {
                            if (isGenerationCanceled(error)) return null;
                            const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                            setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)));
                            return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                        }
                    }),
                );
                if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                if (controller.signal.aborted) return;
                const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
                const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
                const firstText = completedTexts[0];
                if (completedTexts.length <= 1) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== rootId)));
                if (failedTexts.length) message.error(firstText ? t("canvas.projectPage.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.projectPage.generationFailed"));
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === rootId) {
                            const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: primaryText?.content || "",
                                    texts: completedTexts,
                                    primaryTextId: primaryText?.id,
                                    status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: primaryText ? undefined : t("canvas.projectPage.generationFailed"),
                                },
                            };
                        }
                        return node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: firstText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: firstText ? undefined : t("canvas.projectPage.generationFailed") } } : node;
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId || pendingChildIds.includes(node.id)
                            ? node.id === nodeId && !markSourceStatus
                                ? node
                                : {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          status: NODE_STATUS_ERROR,
                                          errorDetails,
                                          ...(isVideoTaskFailed(error) && node.type === CanvasNodeType.Video ? { videoTaskId: undefined } : {}),
                                      },
                                  }
                            : node,
                    ),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [completeVideoNodeTask, createImageOutputCards, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    // 视频编辑弹卡「生成视频」：固定预览图 → 裸图像对象 + 新视频卡（源视频连线）→ 走视频卡现有生成链。
    const handleVideoEditGenerate = useCallback(
        async (payload: { previewUrl: string; mode: "swap" | "edit"; prompt: string; frame: number; model: string; longVideo: boolean; segmentSeconds: number }) => {
            const source = videoEditNodeId ? nodesRef.current.find((node) => node.id === videoEditNodeId) : undefined;
            if (!source || source.type !== CanvasNodeType.Video) throw new Error("源视频卡不可用，请重新打开编辑");
            if (!source.metadata?.content) throw new Error("源视频卡没有可用的视频");
            if (!payload.model) throw new Error("当前没有可用的人物替换模型");
            let blob: Blob;
            try {
                const response = await fetch(payload.previewUrl);
                if (!response.ok) throw new Error();
                blob = await response.blob();
            } catch {
                throw new Error("读取预览图失败");
            }
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = () => reject(new Error("读取预览图失败"));
                reader.readAsDataURL(blob);
            });
            const stored = await uploadImage(dataUrl);
            const meta = source.metadata;
            const imageId = nanoid();
            const videoId = nanoid();
            const rightX = source.position.x + source.width + 96;
            const imageNode: CanvasNodeData = {
                id: imageId,
                type: CanvasNodeType.Image,
                title: "编辑预览",
                position: { x: rightX, y: source.position.y },
                width: source.width,
                height: source.height,
                metadata: { status: NODE_STATUS_IDLE, bare: true, content: stored.url, storageKey: stored.storageKey, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            };
            const videoNode: CanvasNodeData = {
                id: videoId,
                type: CanvasNodeType.Video,
                title: "编辑视频",
                position: { x: rightX + source.width + 96, y: source.position.y },
                width: source.width,
                height: source.height,
                metadata: {
                    status: NODE_STATUS_IDLE,
                    prompt: payload.prompt,
                    // 首帧采样到达前先显示 painted 预览；用网关 URL 而不是 blob，刷新后仍有效。
                    previewUrl: /^https?:/i.test(payload.previewUrl) ? payload.previewUrl : stored.url,
                    previewMime: stored.mimeType || "image/png",
                    previewPersist: true,
                    model: payload.model,
                    videoMode: "reference",
                    videoViggleMode: payload.mode,
                    videoPins: payload.mode === "edit" ? String(Math.max(1, Math.round(payload.frame))) : "",
                    size: meta.size,
                    seconds: meta.seconds,
                    vquality: meta.vquality,
                    generateAudio: meta.generateAudio,
                    watermark: meta.watermark,
                    videoInterpolation: meta.videoInterpolation,
                    videoSegmentSeconds: String(payload.segmentSeconds),
                    videoLongVideo: payload.longVideo,
                    videoSage: meta.videoSage,
                },
            };
            setNodes((prev) => [...prev, imageNode, videoNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: imageId, toNodeId: videoId }, { id: nanoid(), fromNodeId: source.id, toNodeId: videoId }]);
            // nodesRef 在 layout effect 里同步，等一帧再触发生成，确保 handleGenerateNode 拿得到新卡。
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            void handleGenerateNode(videoId, "video", payload.prompt);
        },
        [handleGenerateNode, videoEditNodeId],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            if (node.type === MODEL3D_NODE_TYPE) {
                const connection = connectionsRef.current.find((item) => item.toNodeId === node.id);
                const source = connection ? nodesRef.current.find((item) => item.id === connection.fromNodeId) : null;
                if (!source?.metadata?.content) {
                    message.error(t("canvas.projectPage.referenceMissing"));
                    return;
                }
                if (node.metadata?.model3dEngine === "panorama") return;
                if (node.metadata?.model3dEngine === "moge") await runSceneTo3D(node.id, source);
                else await runImageTo3D(node.id, source);
                return;
            }
            if (hasResumableVideoTask(node)) {
                await pollVideoNodeTask(node);
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          params: savedImageMetadata.params,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            if (context?.loras.length) generationConfig.params = { ...(generationConfig.params || {}), loras: context.loras };
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const savedRetryReferences = hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : null;
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata
                    ? savedRetryReferences
                        ? dedupeReferenceImages<ReferenceImage>(savedRetryReferences)
                        : null
                    : useReferenceImages
                      ? dedupeReferenceImages<ReferenceImage>(context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode))
                      : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"), images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)) } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];

            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)) } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const sourceVideo = videoWorkflowId(generationConfig, generationConfig.model) === "video-h3-viggle-swap" ? selfVideoReference(sourceNode) : undefined;
                    const taskVideos = sourceVideo && !(context?.referenceVideos || []).length ? [sourceVideo] : context?.referenceVideos || [];
                    await completeVideoNodeTask(node.id, generationConfig, prompt, retryImages, controller.signal, {
                        size: generationConfig.size,
                        seconds: generationConfig.videoSeconds,
                        vquality: generationConfig.vquality,
                        generateAudio: generationConfig.videoGenerateAudio,
                        watermark: generationConfig.videoWatermark,
                        videoMode: generationConfig.videoMode,
                        videoViggleMode: generationConfig.videoViggleMode,
                        videoSwapTarget: generationConfig.videoSwapTarget,
                        videoSwapTargetBox: generationConfig.videoSwapTargetBox,
                    }, taskVideos, context?.referenceAudios || []);
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = generationConfig.channelMode === "local"
                        ? await storeGeneratedAudio(
                            await requestLocalAudioPipeline(generationConfig, prompt, context ?? undefined, controller.signal),
                            generationConfig.audioMode === "song" ? "flac" : "wav",
                        )
                        : await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, { signal: controller.signal }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploadedImage = await uploadImage(image.dataUrl, { signal: controller.signal });
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: imageId || node.metadata?.primaryImageId || nanoid(),
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                      ...(isVideoTaskFailed(error) && item.type === CanvasNodeType.Video ? { videoTaskId: undefined } : {}),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, pollVideoNodeTask, runImageTo3D, runSceneTo3D, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                    ...(recallNodeSettings(CanvasNodeType.Config) || {}),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl || (await resolveImageUrl(image.storageKey)), storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            if (!storedImage.url) {
                message.error(t("assets.downloadFailed"));
                return;
            }
            await ensureImagePreview(storedImage.storageKey);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [message, screenToCanvas, size.height, size.width, t],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const generateFreeCard = useCallback(
        async (nodeId: string, prompt: string) => {
            const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
            const info = sourceNode?.metadata?.freeCard;
            if (!sourceNode || !info) return;
            if (info.outputType === "other") {
                message.warning(t("canvas.freeCard.otherWorkflowHint"));
                return;
            }
            const effectivePrompt = prompt.trim();
            if (info.prompt && !effectivePrompt) {
                message.warning(t("canvas.freeCard.needPrompt"));
                return;
            }
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, info.outputType === "video" ? "video" : "image");
            const customWorkflow = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.freeId === info.id) || findCustomWorkflow(sourceNode.metadata?.model || "") || null;
            const customView = customWorkflow ? customWorkflowView(customWorkflow) : null;
            const customParams = (sourceNode.metadata?.params?.customParams as Record<string, unknown> | undefined) || {};
            const customRequest = customView && customWorkflow
                ? { params: customParams, fields: customView.params, flowId: customWorkflow.flowId || "", bypassStages: customView.disabledStages || [], enableGroups: customView.enabledGroups || [] }
                : { params: customParams };
            if (!customWorkflow && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            setRunningNodeId(nodeId);
            setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, prompt: effectivePrompt, composerContent: effectivePrompt } } : item)));
            let childId = "";
            try {
                const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, effectivePrompt));
                if (runController.signal.aborted) return;
                const references = context.referenceImages.slice(0, Math.max(0, info.imageInputs));
                const count = info.count != null ? Math.max(1, Math.min(15, Math.floor(Number(sourceNode.metadata?.count ?? info.count) || 1))) : 1;
                const size = normalizePixelSize(sourceNode.metadata?.size || (info.size ? `${info.size.width}x${info.size.height}` : undefined));
                const ratio = sourceNode.metadata?.aspectRatio || info.aspectRatio || "";
                const seed = sourceNode.metadata?.seed || info.seed || "";
                const seedFixed = (sourceNode.metadata?.seedFixed || "false") === "true";

                if (info.outputType === "video") {
                    childId = nanoid();
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const videoNode: CanvasNodeData = {
                        id: childId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || info.name,
                        position: { x: sourceNode.position.x + sourceNode.width + 96, y: sourceNode.position.y },
                        width: spec.width,
                        height: spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: effectiveConfig.videoModel || effectiveConfig.model,
                            size,
                            freeWorkflowId: info.id,
                            // 自由卡产出卡沿用来源卡的「原提示词」，生成后仍可展开核对（FB-16）。
                            ...(sourceNode.metadata?.promptOptimizeSource ? { promptOptimizeSource: sourceNode.metadata.promptOptimizeSource } : {}),
                        },
                    };
                    setNodes((prev) => [...prev, videoNode]);
                    setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: childId }]);
                    const controller = startGenerationRequest(childId, nodeId, nodeId, runController);
                    const taskId = await createFreeWorkflowVideoTask(effectiveConfig, info.id, { prompt: effectivePrompt, size, ratio, count, seed, seedFixed, images: references, loras: context.loras, ...customRequest, ...(customWorkflow ? buildCustomTextRequest(customWorkflow, sourceNode.metadata?.customTexts) : {}), signal: controller.signal });
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, videoTaskId: taskId, videoTaskProvider: "openai" } } : item)));
                    const localVideoModel = effectiveConfig.videoModel || effectiveConfig.model;
                    const video = await storeGeneratedVideo(
                        await waitForVideoGenerationTask(
                            effectiveConfig,
                            { id: taskId, provider: "openai", model: localVideoModel },
                            {
                                signal: controller.signal,
                                onPreview: (preview) => updateVideoPreview(childId, preview),
                                onFallbackNotice: (notice) => updateVideoFallback(childId, notice),
                                onSteps: (steps) => updateVideoSteps(childId, steps),
                            },
                        ),
                    );
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === childId
                                ? applyGeneratedVideo(item, video, { prompt: effectivePrompt, model: localVideoModel, size, freeWorkflowId: info.id, previewUrl: undefined, previewMime: undefined, previewStep: undefined, previewTotal: undefined })
                                : item.id === nodeId
                                  ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } }
                                  : item,
                        ),
                    );
                } else {
                    childId = nanoid();
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const controller = startGenerationRequest(childId, nodeId, nodeId, runController);
                    const imageResult = await requestFreeWorkflowImage(effectiveConfig, info.id, { prompt: effectivePrompt, size, ratio, count, seed, seedFixed, images: references, ...customRequest, ...(customWorkflow ? buildCustomTextRequest(customWorkflow, sourceNode.metadata?.customTexts) : {}), signal: controller.signal });
                    await createImageOutputCards({
                        groups: imageResult.outputs,
                        basePosition: { x: sourceNode.position.x + sourceNode.width + 96, y: sourceNode.position.y + sourceNode.height / 2 - imageConfig.height / 2 },
                        originNodeId: nodeId,
                        freeWorkflowId: info.id,
                        prompt: effectivePrompt,
                        model: info.name,
                        size: size || "",
                        generationType: "generation",
                        signal: controller.signal,
                    });
                    setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)));
                }
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : item)));
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === nodeId
                            ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } }
                            : item.id === childId
                              ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } }
                              : item,
                    ),
                );
            } finally {
                finishGenerationRequest(childId, runController);
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [createImageOutputCards, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t, updateVideoPreview, updateVideoSteps],
    );

    const addFreeCardFromLibrary = useCallback(
        async (workflow: FreeWorkflowSummary) => {
            const card = freeCardInfoFromSummary(workflow);
            const preset = workflow.preset || {};
            const cardState = workflow.snapshotCard || {};
            let storeWorkflow = useCustomWorkflowStore.getState().workflows.find((item) => item.freeId === workflow.id);
            if (workflow.snapshot && !storeWorkflow) {
                try {
                    const detail = await fetchFreeWorkflowSnapshot(effectiveConfig, workflow.id);
                    if (detail.config) {
                        useCustomWorkflowStore.getState().addSnapshotWorkflow(workflow, detail.config as CustomWorkflow);
                        storeWorkflow = useCustomWorkflowStore.getState().workflows.find((item) => item.freeId === workflow.id);
                    }
                } catch {
                    message.warning("归档快照配置读取失败，已按摘要恢复");
                }
            }
            const node = createCanvasNode(CanvasNodeType.FreeCard, getCanvasCenter(), {
                freeCard: card,
                freeWorkflowId: workflow.id,
                model: storeWorkflow ? customWorkflowModelValue(storeWorkflow.id) : undefined,
                size: cardState.size || preset.size || (workflow.size ? `${workflow.size.width}x${workflow.size.height}` : undefined),
                aspectRatio: cardState.aspectRatio || preset.aspectRatio || workflow.aspectRatio || undefined,
                count: cardState.count ?? preset.count ?? workflow.count ?? 1,
                seed: cardState.seed || preset.seed || workflow.seed || "",
                seedFixed: cardState.seedFixed || preset.seedFixed || "false",
                prompt: cardState.prompt || "",
                composerContent: cardState.prompt || undefined,
                customTexts: cardState.customTexts || undefined,
                customTextActive: cardState.customTextActive || undefined,
            });
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(node.id);
        },
        [effectiveConfig, getCanvasCenter, message],
    );

    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleVideoDimensions = useCallback((nodeId: string, width: number, height: number) => {
        if (!width || !height) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId || node.type !== CanvasNodeType.Video) return node;
                const next = fitNodeSize(width, height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const sameSize = Math.abs(node.width - next.width) < 0.5 && Math.abs(node.height - next.height) < 0.5;
                const sameMeta = node.metadata?.naturalWidth === width && node.metadata?.naturalHeight === height;
                if (sameSize && sameMeta) return node;
                return {
                    ...node,
                    width: next.width,
                    height: next.height,
                    position: { x: node.position.x + node.width / 2 - next.width / 2, y: node.position.y + node.height / 2 - next.height / 2 },
                    metadata: { ...node.metadata, naturalWidth: width, naturalHeight: height },
                };
            }),
        );
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const pauseCanvasVideos = useCallback(() => {
        document.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]").forEach((video) => video.pause());
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        pauseCanvasVideos();
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, [pauseCanvasVideos]);
    const handleSidebarHoverNode = useCallback((nodeId: string | null) => {
        setHoverPreviewNodeId(nodeId);
        setHoverPreviewImageId(null);
    }, []);
    const handleSidebarHoverImage = useCallback((nodeId: string, imageId: string | null) => {
        setHoverPreviewNodeId(nodeId);
        setHoverPreviewImageId(imageId);
    }, []);
    const handleSidebarPreviewImage = useCallback((nodeId: string, imageId: string) => {
        pauseCanvasVideos();
        setPreviewNodeId(nodeId);
        setPreviewImageId(imageId);
    }, [pauseCanvasVideos]);
    const handleNodeRetry = useCallback(
        (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text && (node.metadata?.textCount || 1) > 1) {
                void generateNodeRef.current?.(node.id, "text", node.metadata?.prompt || "");
                return;
            }
            void handleRetryNode(node);
        },
        [handleRetryNode],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedNodeIds((current) => (current.has(nodeId) ? current : new Set([nodeId])));
        setSelectedConnectionId(null);
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const hasActiveGeneration = useCallback(
        (nodeId: string) => {
            if (runningNodeId === nodeId) return true;
            for (const request of generationRequestsRef.current.values()) {
                if (request.targetNodeId === nodeId || request.originNodeId === nodeId || request.runningNodeId === nodeId) return true;
            }
            return false;
        },
        [runningNodeId],
    );

    const waitAutomationRender = useCallback(() => new Promise<void>((resolve) => window.setTimeout(resolve, 80)), []);

    const clearDramaPause = useCallback(
        (dramaNode: CanvasNodeData) => {
            dramaPauseRef.current.delete(dramaNode.id);
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === dramaNode.id && node.metadata?.dramaCard?.paused ? { ...node, metadata: { ...node.metadata, dramaCard: { ...node.metadata.dramaCard, paused: false } } } : node,
                ),
            );
        },
        [setNodes],
    );

    const pauseDramaCreation = useCallback(
        (dramaNode: CanvasNodeData) => {
            dramaPauseRef.current.add(dramaNode.id);
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === dramaNode.id && node.metadata?.dramaCard ? { ...node, metadata: { ...node.metadata, dramaCard: { ...node.metadata.dramaCard, paused: true } } } : node,
                ),
            );
            message.info("当前步骤完成后暂停");
        },
        [message, setNodes],
    );

    const saveDramaRun = useCallback(
        (dramaNode: CanvasNodeData, episodeId: string, run: DramaRun) => {
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === dramaNode.id && node.metadata?.dramaCard
                        ? { ...node, metadata: { ...node.metadata, dramaCard: { ...node.metadata.dramaCard, runs: { ...(node.metadata.dramaCard.runs || {}), [episodeId]: run } } } }
                        : node,
                ),
            );
        },
        [setNodes],
    );

    const resumeDramaStoryboards = useCallback(
        async (dramaNode: CanvasNodeData, episodeId: string) => {
            const liveNode = nodesRef.current.find((node) => node.id === dramaNode.id) || dramaNode;
            const data = liveNode.metadata?.dramaCard;
            const episode = data?.episodes.find((item) => item.id === episodeId);
            const run = data?.runs?.[episodeId];
            if (!data || !episode) throw new Error("分集不存在");
            if (!run?.storyboardsDone || !run.items.length) throw new Error("没有可继续的分镜");
            const shots = data.storyboards?.[episodeId]?.length ? data.storyboards[episodeId] : run.items.map((item) => item.shot);
            if (!shots.length) throw new Error("没有可继续的分镜");
            const textConfig = resolveDramaTextConfig(effectiveConfig);
            if (!textConfig) throw new Error("未配置文本模型");
            const style = findDramaStyle(data.style);
            const stylePrompt = style?.prompt || style?.promptEn || data.style;
            const library = data.assets || { characters: [], scenes: [], props: [] };
            const useReference = true;
            const imageModel = data.imageWorkflow || "local-gateway::image-qwen21";
            const imageRefLimit = Math.max(0, channelModelOf(effectiveConfig, imageModel)?.model.imageInputs ?? (imageModel.endsWith("::image-qwen21") ? 4 : 0));
            const allAssetRecords = [...library.characters, ...library.scenes, ...library.props];
            const resolveAssetNode = (name: string) => {
                const record = allAssetRecords.find((candidate) => candidate.name === name);
                if (!record?.nodeId) return undefined;
                const node = nodesRef.current.find((candidate) => candidate.id === record.nodeId && Boolean(candidate.metadata?.content));
                if (!node) console.warn(`参考资产缺图，已跳过：${name}`);
                return node;
            };
            const frameRefsFor = (shot: (typeof shots)[number]) => {
                const shotText = `${shot.title} ${shot.location} ${shot.action} ${shot.dialogue} ${shot.result}`;
                const shotLocationKey = shot.location ? normalizeLocationKey(shot.location) : "";
                const sceneMatched = library.scenes.filter((record) => {
                    if (!record.nodeId) return false;
                    const recordKey = record.locationKey || normalizeLocationKey(record.location || record.name);
                    const locationHit = Boolean(shotLocationKey) && (recordKey === shotLocationKey || isSameSceneKey(recordKey, shotLocationKey) || sharesSceneBase(recordKey, shotLocationKey));
                    return locationHit || shotText.includes(record.name) || Boolean(record.location && shotText.includes(record.location));
                });
                const scenePicks = (sceneMatched.length ? sceneMatched : library.scenes.filter((record) => record.nodeId)).slice(0, 1);
                const characterMatched = library.characters.filter((record) => record.nodeId && shotText.includes(record.name));
                const characterPool = library.characters.filter((record) => record.nodeId);
                const primary = characterPool.slice(0, 1);
                const characterPicks = [...primary, ...characterMatched.filter((record) => !primary.includes(record)), ...characterPool.filter((record) => !primary.includes(record) && !characterMatched.includes(record))];
                const slots = Math.max(0, imageRefLimit - scenePicks.length);
                return imageRefLimit
                    ? [
                          ...scenePicks.map((record) => ({ name: record.name, kind: "scene" as const })),
                          ...characterPicks.slice(0, slots).map((record) => ({ name: record.name, kind: "character" as const })),
                      ].slice(0, imageRefLimit)
                    : [];
            };
            const videoRefsFor = (shot: (typeof shots)[number]) => {
                const text = `${shot.action} ${shot.dialogue} ${shot.result} ${shot.title}`;
                const recordOf = (name: string) => allAssetRecords.find((candidate) => candidate.name === name);
                const scenes = library.scenes.map((record) => record.name);
                const characters = library.characters.map((record) => record.name);
                const props = library.props.map((record) => record.name);
                const matchedOf = (names: string[]) => names.filter((name) => text.includes(name));
                // Picture 1 固定给场景，其后角色（最多 3），最后道具——必须与提示词里的 <Picture N> 顺序一致。
                const scene = matchedOf(scenes)[0] || scenes[0];
                const characterNames = [...new Set([...matchedOf(characters), ...characters])].slice(0, 3);
                const propNames = matchedOf(props).slice(0, 2);
                const chosen = [...new Set([scene, ...characterNames, ...propNames].filter((name): name is string => Boolean(name)))].slice(0, 6);
                return chosen.map((name) => {
                    const record = recordOf(name);
                    return { name, kind: (record?.kind || "character") as "character" | "scene" | "prop", description: record?.description || record?.prompt || "" };
                });
            };
            const plan = buildDramaResumePlan({ run, shots, nodes: nodesRef.current, useReference });
            if (plan.complete) {
                saveDramaRun(dramaNode, episodeId, { ...run, updatedAt: new Date().toISOString(), items: run.items.map((item) => ({ ...item, done: true, lastError: undefined })) });
                message.info("这一集已经生成完成");
                return;
            }
            const assetNodeIds = new Set(allAssetRecords.map((record) => record.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)));
            const assetRight = nodesRef.current.filter((node) => assetNodeIds.has(node.id)).reduce((max, node) => Math.max(max, node.position.x + node.width), dramaNode.position.x + dramaNode.width + 120);
            const baseX = assetRight + 120;
            const width = 360;
            const height = 240;
            const gap = 18;
            const frameSize =
                data.aspect === "9:16"
                    ? { width: 216, height: 387, size: "928x1664" }
                    : data.aspect === "4:3"
                      ? { width: 320, height: 240, size: "1472x1104" }
                      : data.aspect === "3:4"
                        ? { width: 240, height: 320, size: "1104x1472" }
                        : data.aspect === "1:1"
                          ? { width: 280, height: 280, size: "1328x1328" }
                          : { width: 384, height: 214, size: "1664x928" };
            const frameX = baseX + width + 100;
            const videoX = frameX + frameSize.width + 100;
            const isPaused = () => dramaPauseRef.current.has(dramaNode.id);
            const setProgress = (stage: string | null, current: number, total: number) => updateDramaCardProgress(setNodes, dramaNode.id, stage, current, total);
            let current = { ...run, items: run.items.map((item) => ({ ...item })) };
            const save = (next: DramaRun) => {
                current = next;
                saveDramaRun(dramaNode, episodeId, next);
            };
            const tasks = plan.items.map((planItem, index) => {
                const item = current.items.find((candidate) => candidate.shotNumber === planItem.shot.shotNumber);
                const storyNode = item?.storyNodeId ? nodesRef.current.find((node) => node.id === item.storyNodeId) : undefined;
                const frameNode = item?.frameNodeId ? nodesRef.current.find((node) => node.id === item.frameNodeId) : undefined;
                const videoNode = item?.videoNodeId ? nodesRef.current.find((node) => node.id === item.videoNodeId) : undefined;
                return { planItem, item, shot: planItem.shot, storyNode, frameNode, videoNode, index };
            });
            for (const planItem of plan.items) {
                if (planItem.videoAction.kind === "skip" && !current.items.find((item) => item.shotNumber === planItem.shot.shotNumber)?.done) {
                    current = updateDramaRunItem(current, planItem.shot.shotNumber, { done: true, lastError: undefined });
                }
            }
            save(current);
            const newNodes: CanvasNodeData[] = [];
            const newConnections: CanvasConnection[] = [];
            for (const task of tasks) {
                if (task.storyNode) continue;
                const shot = task.shot;
                const content = storyboardCardContent(shot);
                const storyNode: CanvasNodeData = {
                    id: `drama-shot-${nanoid()}`,
                    type: CanvasNodeType.Text,
                    title: `分镜 ${shot.shotNumber} · ${shot.title}`,
                    position: { x: baseX, y: dramaNode.position.y + task.index * (height + gap) },
                    width,
                    height,
                    metadata: { content, prompt: content, status: NODE_STATUS_SUCCESS, fontSize: 13 },
                };
                task.storyNode = storyNode;
                newNodes.push(storyNode);
                newConnections.push({ id: nanoid(), fromNodeId: dramaNode.id, toNodeId: storyNode.id, role: "lineage" });
                save(updateDramaRunItem(current, shot.shotNumber, { storyNodeId: storyNode.id, lastError: undefined }));
            }
            for (const task of tasks) {
                if (useReference || task.frameNode || task.planItem.frameAction.kind !== "generate" || task.planItem.videoAction.kind === "skip") continue;
                const shot = task.shot;
                const visual = [stylePrompt, shot.shotType, shot.cameraAngle, shot.location && `地点：${shot.location}`, shot.time && `时间：${shot.time}`, shot.action, shot.result].filter(Boolean).join("；");
                const frameNode: CanvasNodeData = {
                    id: `drama-frame-${nanoid()}`,
                    type: CanvasNodeType.Image,
                    title: `首帧 ${shot.shotNumber} · ${shot.title}`,
                    position: { x: frameX, y: task.storyNode ? task.storyNode.position.y : dramaNode.position.y + task.index * (height + gap) },
                    width: frameSize.width,
                    height: frameSize.height,
                    metadata: { status: NODE_STATUS_IDLE, generationType: "generation", imageMode: "t2i", model: imageModel, size: frameSize.size, count: 1, prompt: `${visual}。画面中不要出现字幕、标题或水印。` },
                };
                task.frameNode = frameNode;
                newNodes.push(frameNode);
                newConnections.push({ id: nanoid(), fromNodeId: task.storyNode!.id, toNodeId: frameNode.id, role: "lineage" });
                for (const ref of frameRefsFor(shot)) {
                    const node = resolveAssetNode(ref.name);
                    if (node) newConnections.push({ id: nanoid(), fromNodeId: node.id, toNodeId: frameNode.id });
                }
                save(updateDramaRunItem(current, shot.shotNumber, { frameNodeId: frameNode.id }));
            }
            if (newNodes.length) {
                setNodes((prev) => [...prev, ...newNodes]);
                setConnections((prev) => [...prev, ...newConnections]);
                await waitAutomationRender();
                newNodes.length = 0;
                newConnections.length = 0;
            }
            setProgress("续跑", 0, tasks.length);
            for (let index = 0; index < tasks.length; index += 1) {
                const task = tasks[index];
                const { planItem, shot, storyNode, frameNode } = task;
                if (!storyNode) continue;
                if (!frameNode || planItem.frameAction.kind !== "generate") continue;
                if (isPaused()) {
                    setProgress(null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                setProgress("续跑首帧", index + 1, tasks.length);
                let frameController: AbortController | undefined;
                try {
                    const refs = frameRefsFor(shot).flatMap((ref) => {
                        const node = resolveAssetNode(ref.name);
                        return node ? [{ name: ref.name, kind: ref.kind, node }] : [];
                    });
                    const frameConfig = { ...buildGenerationConfig(effectiveConfig, frameNode, "image"), model: imageModel, count: "1", size: frameSize.size, imageMode: "t2i" as const };
                    if (!isAiConfigReady(frameConfig, frameConfig.model)) throw new Error("生图工作流不可用");
                    setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                    const controller = startGenerationRequest(frameNode.id, dramaNode.id, frameNode.id);
                    frameController = controller;
                    const framePrompt = refs.length ? frameReferencePrompt(frameNode.metadata?.prompt || "", refs) : frameNode.metadata?.prompt || "";
                    const image = refs.length
                        ? await requestEdit(
                              { ...frameConfig, imageMode: "edit" as const },
                              framePrompt,
                              refs.map((item) => ({ id: item.node.id, name: `${item.name}.png`, type: item.node.metadata?.mimeType || "image/png", dataUrl: "", url: item.node.metadata?.content || "", storageKey: item.node.metadata?.storageKey })),
                              { signal: controller.signal },
                          ).then((items) => items[0])
                        : await requestGeneration(frameConfig, framePrompt, { signal: controller.signal }).then((items) => items[0]);
                    if (!image) throw new Error("首帧没有返回图片");
                    const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                    setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                    finishGenerationRequest(frameNode.id, controller);
                    save(updateDramaRunItem(current, shot.shotNumber, { frameNodeId: frameNode.id, lastError: undefined }));
                    await waitAutomationRender();
                } catch (error) {
                    if (frameController) finishGenerationRequest(frameNode.id, frameController);
                    if (isGenerationCanceled(error)) {
                        setProgress(null, 0, 0);
                        message.info("已暂停");
                        return;
                    }
                    const text = error instanceof Error ? error.message : "首帧生成失败";
                    setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: text } } : node)));
                    save(updateDramaRunItem(current, shot.shotNumber, { lastError: text }));
                    message.error(`第 ${shot.shotNumber} 镜首帧：${text}`);
                }
            }
            const preparedPrompts = new Map<string, string>();
            for (const task of tasks) {
                const { planItem, shot, item, storyNode, frameNode } = task;
                if (!storyNode || planItem.videoAction.kind === "skip") continue;
                if (isPaused()) {
                    setProgress(null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                let videoNode = task.videoNode;
                if (!videoNode) {
                    if (!useReference && !frameNode?.metadata?.content) {
                        save(updateDramaRunItem(current, shot.shotNumber, { lastError: "首帧未生成，跳过视频" }));
                        continue;
                    }
                    const videoRefs = useReference ? videoRefsFor(shot) : [];
                    const resolvedRefs = videoRefs.flatMap((ref) => {
                        const node = resolveAssetNode(ref.name);
                        return node ? [{ ...ref, node }] : [];
                    });
                    const createdVideo: CanvasNodeData = {
                        id: `drama-video-${nanoid()}`,
                        type: CanvasNodeType.Video,
                        title: `视频 ${shot.shotNumber} · ${shot.title}`,
                        position: { x: useReference ? frameX : videoX, y: storyNode.position.y },
                        width: frameSize.width,
                        height: frameSize.height,
                        metadata: {
                            status: NODE_STATUS_IDLE,
                            model: data.videoWorkflow || "local-gateway::video-h3-ref2va",
                            videoMode: useReference ? "reference" : "frames",
                            ...(useReference ? {} : { frameMode: "first" }),
                            size: data.aspect,
                            seconds: String(estimateShotSeconds(shot)),
                            vquality: data.vquality || "720",
                            generateAudio: "true",
                            referenceAcceleration: false,
                            count: 1,
                            prompt: "",
                        },
                    };
                    videoNode = createdVideo;
                    task.videoNode = createdVideo;
                    newNodes.push(createdVideo);
                    newConnections.push(
                        { id: nanoid(), fromNodeId: storyNode.id, toNodeId: createdVideo.id, role: "lineage" },
                        ...(frameNode ? [{ id: nanoid(), fromNodeId: frameNode.id, toNodeId: createdVideo.id }] : resolvedRefs.map((ref) => ({ id: nanoid(), fromNodeId: ref.node.id, toNodeId: createdVideo.id }))),
                    );
                    save(updateDramaRunItem(current, shot.shotNumber, { videoNodeId: createdVideo.id }));
                }
                if (!videoNode) continue;
            }
            if (newNodes.length) setNodes((prev) => [...prev, ...newNodes]);
            if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
            await waitAutomationRender();
            for (const task of tasks) {
                const { planItem, shot, item, videoNode } = task;
                if (!videoNode || planItem.videoAction.kind === "skip" || planItem.videoAction.kind === "resume") continue;
                if (item?.compiledPrompt) {
                    preparedPrompts.set(videoNode.id, item.compiledPrompt);
                    continue;
                }
                if (isPaused()) {
                    setProgress(null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                setProgress("续跑提示词", task.index + 1, tasks.length);
                const promptMode = useReference ? ("reference" as const) : ("frames" as const);
                const compileRefs = useReference ? videoRefsFor(shot).filter((ref) => Boolean(resolveAssetNode(ref.name))) : [];
                const fallbackPrompt = useReference ? buildRef2VAPrompt(shot, compileRefs, stylePrompt) : buildH3BasePrompt(shot, stylePrompt);
                let compiledPrompt = fallbackPrompt;
                try {
                    const subjects = useReference
                        ? []
                        : frameRefsFor(shot)
                              .filter((ref) => ref.kind === "character")
                              .map((ref, subjectIndex) => {
                                  const record = library.characters.find((candidate) => candidate.name === ref.name);
                                  return { name: ref.name, kind: "character" as const, description: record?.description || "", primary: subjectIndex === 0 };
                              });
                    const compileImages: string[] = [];
                    try {
                        if (useReference) {
                            for (const ref of compileRefs) {
                                const node = resolveAssetNode(ref.name);
                                if (node?.metadata?.content) compileImages.push(await imageToDataUrl({ storageKey: node.metadata.storageKey, url: node.metadata.content }));
                            }
                        } else if (task.frameNode?.metadata?.content) {
                            compileImages.push(await imageToDataUrl({ storageKey: task.frameNode.metadata.storageKey, url: task.frameNode.metadata.content }));
                        }
                    } catch {
                        compileImages.length = 0;
                    }
                    const messagesWithImages = buildH3CompileMessages({ shot, style: stylePrompt, aspect: data.aspect, duration: estimateShotSeconds(shot), mode: promptMode, refs: compileRefs, subjects, images: compileImages });
                    const messagesTextOnly = buildH3CompileMessages({ shot, style: stylePrompt, aspect: data.aspect, duration: estimateShotSeconds(shot), mode: promptMode, refs: compileRefs, subjects });
                    let answer = "";
                    try {
                        answer = await requestH3CompileAnswer(textConfig, messagesWithImages as Parameters<typeof requestImageQuestion>[1]);
                    } catch {
                        answer = await requestH3CompileAnswer(textConfig, messagesTextOnly as Parameters<typeof requestImageQuestion>[1]);
                    }
                    compiledPrompt = ensureSpokenDialogue(normalizeH3Prompt(answer, promptMode, useReference ? compileRefs.length : 1) || fallbackPrompt, shot.dialogue);
                } catch {
                    compiledPrompt = fallbackPrompt;
                }
                setNodes((prev) => prev.map((node) => (node.id === videoNode.id ? { ...node, metadata: { ...node.metadata, prompt: compiledPrompt } } : node)));
                save(updateDramaRunItem(current, shot.shotNumber, { compiledPrompt }));
                preparedPrompts.set(videoNode.id, compiledPrompt);
            }
            const resumeVideos = tasks.filter((task) => task.planItem.videoAction.kind === "resume" && task.videoNode);
            for (const task of resumeVideos) {
                try {
                    const resumeId = task.videoNode!.id;
                    await pollVideoNodeTask(task.videoNode!);
                    if (nodesRef.current.find((node) => node.id === resumeId)?.metadata?.content) save(updateDramaRunItem(current, task.planItem.shot.shotNumber, { done: true, lastError: undefined }));
                } catch (error) {
                    save(updateDramaRunItem(current, task.planItem.shot.shotNumber, { lastError: error instanceof Error ? error.message : "视频续接失败" }));
                }
            }
            for (let index = 0; index < tasks.length; index += 1) {
                const task = tasks[index];
                const { planItem, shot, videoNode } = task;
                if (!videoNode || planItem.videoAction.kind !== "generate") continue;
                const compiledPrompt = preparedPrompts.get(videoNode.id);
                if (!compiledPrompt) continue;
                if (isPaused()) {
                    setProgress(null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                setProgress(useReference ? "续跑多参视频" : "续跑视频", index + 1, tasks.length);
                try {
                    await handleGenerateNode(videoNode.id, "video", compiledPrompt);
                    await waitAutomationRender();
                    const ok = nodesRef.current.find((node) => node.id === videoNode.id)?.metadata?.content;
                    save(updateDramaRunItem(current, shot.shotNumber, ok ? { done: true, lastError: undefined } : { lastError: "视频生成失败" }));
                    setNodes((prev) => prev.map((node) => (node.id === videoNode.id ? { ...node, title: `视频 ${shot.shotNumber} · ${shot.title}`, metadata: { ...node.metadata, ...(useReference ? {} : { frameMode: "first" as const }) } } : node)));
                } catch (error) {
                    if (isGenerationCanceled(error)) {
                        setProgress(null, 0, 0);
                        message.info("已暂停");
                        return;
                    }
                    const text = error instanceof Error ? error.message : "视频生成失败";
                    save(updateDramaRunItem(current, shot.shotNumber, { lastError: text }));
                    message.error(`第 ${shot.shotNumber} 镜视频：${text}`);
                }
            }
            setProgress(null, tasks.length, tasks.length);
            const pending = current.items.filter((item) => !item.done).length;
            if (pending) message.warning(`续跑完成，还有 ${pending} 镜未完成`);
            else message.success("续跑完成");
        },
        [buildDramaResumePlan, effectiveConfig, handleGenerateNode, isAiConfigReady, message, nodesRef, pollVideoNodeTask, saveDramaRun, setConnections, setNodes, startGenerationRequest, waitAutomationRender],
    );

    const generateDramaStoryboards = useCallback(
        async (dramaNode: CanvasNodeData, episodeId: string, options?: { fromScratch?: boolean }) => {
            const liveNode = nodesRef.current.find((node) => node.id === dramaNode.id) || dramaNode;
            const data = liveNode.metadata?.dramaCard;
            const episode = data?.episodes.find((item) => item.id === episodeId);
            if (!data || !episode) throw new Error("分集不存在");
            const existingRun = data.runs?.[episodeId];
            if (!options?.fromScratch && existingRun?.storyboardsDone && existingRun.items.some((item) => !item.done)) {
                return resumeDramaStoryboards(dramaNode, episodeId);
            }
            const script = (episode.script || "").trim();
            if (!script) throw new Error("这一集还没有剧本");
            const textConfig = resolveDramaTextConfig(effectiveConfig);
            if (!textConfig) throw new Error("未配置文本模型");
            const style = findDramaStyle(data.style);
            const stylePrompt = style?.prompt || style?.promptEn || data.style;
            const library = data.assets || { characters: [], scenes: [], props: [] };
            const pendingAssets = [...library.characters, ...library.scenes, ...library.props].filter((record) => record.nodeId && nodesRef.current.find((node) => node.id === record.nodeId)?.metadata?.status === NODE_STATUS_LOADING);
            if (pendingAssets.length) throw new Error("资产图还在生成，请等资产完成后再生成分镜");
            const runGuardKey = `${dramaNode.id}:${episodeId}`;
            if (dramaRunGuards.has(runGuardKey)) { console.warn("该集生成正在进行中，忽略重复触发"); return; }
            dramaRunGuards.add(runGuardKey);
            window.setTimeout(() => dramaRunGuards.delete(runGuardKey), 10 * 60 * 1000);
            const isPaused = () => dramaPauseRef.current.has(dramaNode.id);
            const setDramaProgress = (stage: string | null, current: number, total: number) => updateDramaCardProgress(setNodes, dramaNode.id, stage, current, total);
            setDramaProgress("分镜", 0, 0);
            const controller = new AbortController();
            const requestDramaText = async (messages: Parameters<typeof requestImageQuestion>[1], timeoutMs: number, label: string) => {
                const request = new AbortController();
                const forwardAbort = () => request.abort(controller.signal.reason);
                if (controller.signal.aborted) forwardAbort();
                else controller.signal.addEventListener("abort", forwardAbort, { once: true });
                let timedOut = false;
                const timer = window.setTimeout(() => {
                    timedOut = true;
                    request.abort("timeout");
                }, timeoutMs);
                try {
                    return await requestImageQuestion(textConfig, messages, () => undefined, { signal: request.signal });
                } catch (error) {
                    if (timedOut && !controller.signal.aborted) throw new Error(`${label}超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已中止`);
                    throw error;
                } finally {
                    window.clearTimeout(timer);
                    controller.signal.removeEventListener("abort", forwardAbort);
                }
            };
            const segmentSeconds = Math.max(2, Math.min(15, Math.round(Number(data.segmentSeconds) || 15)));
            const screenplayMessages = buildScreenplayAdaptationMessages({
                script,
                title: episode.title,
                characters: library.characters.map((record) => record.name),
                scenes: library.scenes.map((record) => record.name),
                props: library.props.map((record) => record.name),
                adaptationLevel: "performance",
                segmentSeconds,
            });
            let screenplayRecord: DramaScreenplay | undefined;
            let beats: DramaBeat[] = [];
            try {
                setDramaProgress("分镜·剧本", 0, 0);
                const screenplayAnswer = await requestDramaText(screenplayMessages as Parameters<typeof requestImageQuestion>[1], 120000, "剧本改写");
                const normalized = normalizeScreenplay(extractJson(screenplayAnswer), script);
                if (normalized.beats.length) {
                    screenplayRecord = normalized.screenplay;
                    beats = normalized.beats;
                    if (normalized.warnings.length) console.warn("剧本改写来源提示", normalized.warnings);
                } else {
                    console.warn("剧本改写没有产出 beats，改用确定性拆分");
                }
            } catch (error) {
                if (controller.signal.aborted) throw error;
                console.warn("剧本改写失败，改用确定性拆分", error);
            }
            if (screenplayRecord?.coverage?.requiredMissing.length) {
                setDramaProgress(null, 0, 0);
                throw new Error(`剧情关键事件未覆盖（required source_units 丢失，禁止出片）：${screenplayRecord.coverage.requiredMissing.slice(0, 3).map((unit) => unit.text).join("；")}`);
            }
            if (!beats.length) beats = fallbackBeatsFromScript(script);
            const shotMessages = buildShotPlanMessages({
                beats,
                style: stylePrompt,
                aspect: data.aspect,
                targetShots: episode.shots || 0,
                characters: library.characters.map((record) => record.name),
                scenes: library.scenes.map((record) => record.name),
                props: library.props.map((record) => record.name),
            });
            let plan: DramaShotPlan[] = [];
            try {
                setDramaProgress("分镜·Shot", 0, 0);
                const shotAnswer = await requestDramaText(shotMessages as Parameters<typeof requestImageQuestion>[1], 180000, "Shot 规划");
                plan = normalizeShotPlan(extractJson(shotAnswer), beats);
            } catch (error) {
                if (controller.signal.aborted) throw error;
                console.warn("Shot 规划失败，改用确定性兜底", error);
            }
            let validation = validateStoryboardPlan(plan, beats, segmentSeconds);
            if (!validation.ok) {
                const repaired = repairStoryboardPlan(plan, segmentSeconds);
                const repairedValidation = validateStoryboardPlan(repaired, beats, segmentSeconds);
                if (repairedValidation.ok) {
                    plan = repaired;
                    validation = repairedValidation;
                } else {
                    console.warn("Shot 规划校验失败，改用确定性兜底", repairedValidation.errors);
                    plan = fallbackShotPlan(beats, segmentSeconds);
                    validation = validateStoryboardPlan(plan, beats, segmentSeconds);
                }
            }
            if (!validation.ok) {
                setDramaProgress(null, 0, 0);
                throw new Error(`分镜规划校验失败：${validation.errors.slice(0, 3).join("；")}`);
            }
            if (validation.warnings?.length) console.warn("分镜软提示（不影响继续）", validation.warnings);
            const shots = elasticPackShots(planToShots(plan), segmentSeconds);
            const packedIssues = sanityCheckPackedShots(shots);
            if (packedIssues.length) console.warn("打包后结构提示（不影响出卡）", packedIssues);
            if (!shots.length) {
                setDramaProgress(null, 0, 0);
                throw new Error("没有从返回内容里解析出分镜");
            }
            setDramaProgress("分镜", shots.length, shots.length);
            const assetNodeIds = new Set(
                [...library.characters, ...library.scenes, ...library.props]
                    .map((record) => record.nodeId)
                    .filter((nodeId): nodeId is string => Boolean(nodeId)),
            );
            const assetRight = nodesRef.current
                .filter((node) => assetNodeIds.has(node.id))
                .reduce((max, node) => Math.max(max, node.position.x + node.width), dramaNode.position.x + dramaNode.width + 120);
            const baseX = assetRight + 120;
            const baseY = dramaNode.position.y;
            const width = 360;
            const height = 240;
            const gap = 18;
            const nodesToAdd: CanvasNodeData[] = shots.map((shot, index) => {
                const content = storyboardCardContent(shot);
                return {
                    id: `drama-shot-${nanoid()}`,
                    type: CanvasNodeType.Text,
                    title: `分镜 ${shot.shotNumber} · ${shot.title}`,
                    position: { x: baseX, y: baseY + index * (height + gap) },
                    width,
                    height,
                    metadata: { content, prompt: content, status: NODE_STATUS_SUCCESS, fontSize: 13 },
                };
            });
            const connectionsToAdd: CanvasConnection[] = nodesToAdd.map((node) => ({ id: nanoid(), fromNodeId: dramaNode.id, toNodeId: node.id, role: "lineage" }));
            let run = markDramaRunStoryboardsDone(
                createDramaRun(episodeId, shots),
                Object.fromEntries(nodesToAdd.map((node, index) => [shots[index].shotNumber, node.id])),
            );
            const frameSize =
                data.aspect === "9:16"
                    ? { width: 216, height: 387, size: "928x1664" }
                    : data.aspect === "4:3"
                      ? { width: 320, height: 240, size: "1472x1104" }
                      : data.aspect === "3:4"
                        ? { width: 240, height: 320, size: "1104x1472" }
                        : data.aspect === "1:1"
                          ? { width: 280, height: 280, size: "1328x1328" }
                          : { width: 384, height: 214, size: "1664x928" };
            const frameX = baseX + width + 100;
            const videoX = frameX + frameSize.width + 100;
            const extraNodes: CanvasNodeData[] = [];
            const extraConnections: CanvasConnection[] = [];
            const useReference = true;
            const imageModel = data.imageWorkflow || "local-gateway::image-qwen21";
            const imageRefLimit = Math.max(0, channelModelOf(effectiveConfig, imageModel)?.model.imageInputs ?? (imageModel.endsWith("::image-qwen21") ? 4 : 0));
            const allAssetRecords = [...library.characters, ...library.scenes, ...library.props];
            const resolveAssetNode = (name: string) => {
                const record = allAssetRecords.find((candidate) => candidate.name === name);
                if (!record?.nodeId) return undefined;
                const node = nodesRef.current.find((candidate) => candidate.id === record.nodeId && Boolean(candidate.metadata?.content));
                if (!node) console.warn(`参考资产缺图，已跳过：${name}`);
                return node;
            };
            const assetNames = [...library.characters, ...library.scenes, ...library.props].map((record) => record.name);
            const tasks: {
                shot: (typeof shots)[number];
                storyNode: CanvasNodeData;
                videoId: string;
                videoPrompt: string;
                frame?: CanvasNodeData;
                frameRefs: { name: string; kind: "character" | "scene" }[];
                videoRefs: { name: string; kind: "character" | "scene" | "prop"; description?: string }[];
            }[] = [];
            shots.forEach((shot, index) => {
                const storyNode = nodesToAdd[index];
                if (!storyNode) return;
                const visual = [
                    stylePrompt,
                    shot.shotType,
                    shot.cameraAngle,
                    shot.location && `地点：${shot.location}`,
                    shot.time && `时间：${shot.time}`,
                    shot.action,
                    shot.result,
                ]
                    .filter(Boolean)
                    .join("；");
                const videoPrompt = [visual, shot.cameraMovement].filter(Boolean).join("；");
                const videoId = `drama-video-${nanoid()}`;
                if (useReference) {
                    const text = `${shot.action} ${shot.dialogue} ${shot.result} ${shot.title}`;
                    const matched = assetNames.filter((name) => text.includes(name));
                    const chosen = [...new Set([assetNames[0], ...matched, ...assetNames].filter((name): name is string => Boolean(name)))].slice(0, 6);
                    let characterCount = 0;
                    const videoRefs = chosen
                        .map((name) => {
                            const record = allAssetRecords.find((candidate) => candidate.name === name);
                            return { name, kind: (record?.kind || "character") as "character" | "scene" | "prop", description: record?.description || record?.prompt || "" };
                        })
                        .filter((ref) => {
                            if (ref.kind !== "character") return true;
                            if (characterCount >= 3) return false;
                            characterCount += 1;
                            return true;
                        });
                    tasks.push({ shot, storyNode, videoId, videoPrompt, frameRefs: [], videoRefs });
                    return;
                }
                const frameNode: CanvasNodeData = {
                    id: `drama-frame-${nanoid()}`,
                    type: CanvasNodeType.Image,
                    title: `首帧 ${shot.shotNumber} · ${shot.title}`,
                    position: { x: frameX, y: storyNode.position.y },
                    width: frameSize.width,
                    height: frameSize.height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        generationType: "generation",
                        imageMode: "t2i",
                        model: imageModel,
                        size: frameSize.size,
                        count: 1,
                        prompt: `${visual}。画面中不要出现字幕、标题或水印。`,
                    },
                };
                extraNodes.push(frameNode);
                const shotText = `${shot.title} ${shot.location} ${shot.action} ${shot.dialogue} ${shot.result}`;
                const shotLocationKey = shot.location ? normalizeLocationKey(shot.location) : "";
                const sceneMatched = library.scenes.filter((record) => {
                    if (!record.nodeId) return false;
                    const recordKey = record.locationKey || normalizeLocationKey(record.location || record.name);
                    const locationHit = Boolean(shotLocationKey) && (recordKey === shotLocationKey || isSameSceneKey(recordKey, shotLocationKey));
                    return locationHit || shotText.includes(record.name) || Boolean(record.location && shotText.includes(record.location));
                });
                const characterMatched = library.characters.filter((record) => record.nodeId && shotText.includes(record.name));
                const scenePicks = (sceneMatched.length ? sceneMatched : library.scenes.filter((record) => record.nodeId)).slice(0, 1);
                const characterPool = library.characters.filter((record) => record.nodeId);
                const primaryCharacter = characterPool.slice(0, 1);
                const characterPicks = [
                    ...primaryCharacter,
                    ...characterMatched.filter((record) => !primaryCharacter.includes(record)),
                    ...characterPool.filter((record) => !primaryCharacter.includes(record) && !characterMatched.includes(record)),
                ];
                const characterSlots = Math.max(0, imageRefLimit - scenePicks.length);
                const frameRefs = imageRefLimit
                    ? [
                          ...scenePicks.map((record) => ({ name: record.name, kind: "scene" as const })),
                          ...characterPicks.slice(0, characterSlots).map((record) => ({ name: record.name, kind: "character" as const })),
                      ].slice(0, imageRefLimit)
                    : [];
                extraConnections.push(
                    { id: nanoid(), fromNodeId: storyNode.id, toNodeId: frameNode.id, role: "lineage" },
                    ...frameRefs.flatMap((ref) => {
                        const record = allAssetRecords.find((candidate) => candidate.name === ref.name);
                        return record?.nodeId && nodesRef.current.some((node) => node.id === record.nodeId) ? [{ id: nanoid(), fromNodeId: record.nodeId, toNodeId: frameNode.id }] : [];
                    }),
                );
                tasks.push({ shot, storyNode, videoId, videoPrompt, frame: frameNode, frameRefs, videoRefs: [] });
            });
            setNodes((prev) => [...prev, ...nodesToAdd, ...extraNodes]);
            setConnections((prev) => [...prev, ...connectionsToAdd, ...extraConnections]);
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== dramaNode.id || !node.metadata?.dramaCard) return node;
                    const card = node.metadata.dramaCard;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            dramaCard: {
                                ...card,
                                storyboards: { ...(card.storyboards || {}), [episodeId]: shots },
                                episodes: card.episodes.map((item) => (item.id === episodeId ? { ...item, shots: shots.length, screenplay: screenplayRecord } : item)),
                            },
                        },
                    };
                }),
            );
            message.info(useReference ? `分镜已生成，开始批量生成 ${shots.length} 组多参视频…` : `分镜已生成，先批量生成 ${shots.length} 张首帧…`);
            await waitAutomationRender();
            saveDramaRun(dramaNode, episodeId, run);
            const waitForNode = async (nodeId: string, ready?: (node: CanvasNodeData) => boolean) => {
                for (let attempt = 0; attempt < 30; attempt += 1) {
                    const node = nodesRef.current.find((item) => item.id === nodeId);
                    if (node && (!ready || ready(node))) return;
                    await waitAutomationRender();
                }
            };
            let failedTasks = 0;
            const failedShots = new Set<number>();

            if (!useReference) {
                for (let index = 0; index < tasks.length; index += 1) {
                    const task = tasks[index];
                    const { shot, frame: frameNode } = task;
                    if (!frameNode) continue;
                    if (isPaused()) {
                        setDramaProgress(null, 0, 0);
                        message.info("已暂停");
                        return;
                    }
                    setDramaProgress("首帧", index + 1, tasks.length);
                    let frameController: AbortController | undefined;
                    try {
                        const refs = task.frameRefs.flatMap((ref) => {
                            const node = resolveAssetNode(ref.name);
                            return node ? [{ name: ref.name, kind: ref.kind, node }] : [];
                        });
                        const frameConfig = { ...buildGenerationConfig(effectiveConfig, frameNode, "image"), model: imageModel, count: "1", size: frameSize.size, imageMode: "t2i" as const };
                        if (!isAiConfigReady(frameConfig, frameConfig.model)) throw new Error("生图工作流不可用");
                        setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                        const controller = startGenerationRequest(frameNode.id, dramaNode.id, frameNode.id);
                        frameController = controller;
                        const framePrompt = refs.length ? frameReferencePrompt(frameNode.metadata?.prompt || "", refs) : frameNode.metadata?.prompt || "";
                        const image = refs.length
                            ? await requestEdit(
                                  { ...frameConfig, imageMode: "edit" as const },
                                  framePrompt,
                                  refs.map((item) => ({ id: item.node.id, name: `${item.name}.png`, type: item.node.metadata?.mimeType || "image/png", dataUrl: "", url: item.node.metadata?.content || "", storageKey: item.node.metadata?.storageKey })),
                                  { signal: controller.signal },
                              ).then((items) => items[0])
                            : await requestGeneration(frameConfig, framePrompt, { signal: controller.signal }).then((items) => items[0]);
                        if (!image) throw new Error("首帧没有返回图片");
                        const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                        setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                        finishGenerationRequest(frameNode.id, controller);
                        run = updateDramaRunItem(run, shot.shotNumber, { frameNodeId: frameNode.id, lastError: undefined });
                        saveDramaRun(dramaNode, episodeId, run);
                        await waitForNode(frameNode.id, (node) => Boolean(node.metadata?.content));
                        if (!nodesRef.current.find((node) => node.id === frameNode.id)?.metadata?.content) throw new Error("首帧未写回画布，已停止后续视频");
                    } catch (error) {
                        if (frameController) finishGenerationRequest(frameNode.id, frameController);
                        if (isGenerationCanceled(error)) {
                            setDramaProgress(null, 0, 0);
                            message.info("已停止生成");
                            return;
                        }
                        const text = error instanceof Error ? error.message : "首帧生成失败";
                        failedTasks += 1;
                        failedShots.add(shot.shotNumber);
                        run = updateDramaRunItem(run, shot.shotNumber, { lastError: text });
                        saveDramaRun(dramaNode, episodeId, run);
                        setNodes((prev) => prev.map((node) => (node.id === frameNode.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: text } } : node)));
                        message.error(`第 ${shot.shotNumber || index + 1} 镜首帧：${text}`);
                    }
                }
            }

            const videoRefsById = new Map<string, { name: string; kind: "character" | "scene" | "prop"; description?: string }[]>();
            const newVideoNodes: CanvasNodeData[] = [];
            const newVideoConnections: CanvasConnection[] = [];
            for (let index = 0; index < tasks.length; index += 1) {
                const task = tasks[index];
                const { shot, storyNode, videoId, frame: frameNode } = task;
                if (failedShots.has(shot.shotNumber)) continue;
                if (isPaused()) {
                    setDramaProgress(null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                const videoRefs = task.videoRefs.flatMap((ref) => {
                    const node = resolveAssetNode(ref.name);
                    return node ? [{ ...ref, node }] : [];
                });
                videoRefsById.set(videoId, videoRefs.map((ref) => ({ name: ref.name, kind: ref.kind, description: ref.description })));
                if (nodesRef.current.some((node) => node.id === videoId)) continue;
                setDramaProgress("视频卡", index + 1, tasks.length);
                const createdVideo: CanvasNodeData = {
                    id: videoId,
                    type: CanvasNodeType.Video,
                    title: `视频 ${shot.shotNumber} · ${shot.title}`,
                    position: { x: useReference ? frameX : videoX, y: storyNode.position.y },
                    width: frameSize.width,
                    height: frameSize.height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        model: data.videoWorkflow || "local-gateway::video-h3-ref2va",
                        videoMode: useReference ? "reference" : "frames",
                        ...(useReference ? {} : { frameMode: "first" }),
                        size: data.aspect,
                        seconds: String(estimateShotSeconds(shot)),
                        vquality: data.vquality || "720",
                        generateAudio: "true",
                        referenceAcceleration: false,
                        count: 1,
                        prompt: "",
                    },
                };
                newVideoNodes.push(createdVideo);
                newVideoConnections.push(
                    { id: nanoid(), fromNodeId: storyNode.id, toNodeId: videoId, role: "lineage" as const },
                    ...(frameNode ? [{ id: nanoid(), fromNodeId: frameNode.id, toNodeId: videoId }] : videoRefs.map((ref) => ({ id: nanoid(), fromNodeId: ref.node.id, toNodeId: videoId }))),
                );
                run = updateDramaRunItem(run, shot.shotNumber, { videoNodeId: videoId });
                saveDramaRun(dramaNode, episodeId, run);
            }
            if (newVideoNodes.length) {
                setNodes((prev) => [...prev, ...newVideoNodes]);
                setConnections((prev) => [...prev, ...newVideoConnections]);
                await waitAutomationRender();
            }
            // 流水线：编译完第 N 个提示词立即排队跑第 N 个视频，同时继续编译第 N+1 个。
            // 视频生成串行（单卡 GPU），提示词编译（文本/云）与视频生成并行，减少等待。
            let videoChain: Promise<void> = Promise.resolve();
            for (let index = 0; index < tasks.length; index += 1) {
                const task = tasks[index];
                const { shot, videoId } = task;
                if (failedShots.has(shot.shotNumber)) continue;
                if (!nodesRef.current.some((node) => node.id === videoId)) continue;
                if (isPaused()) break;
                setDramaProgress("视频提示词", index + 1, tasks.length);
                let compiledPrompt = "";
                try {
                    const videoRefs = videoRefsById.get(videoId) || [];
                    const promptMode = useReference ? ("reference" as const) : ("frames" as const);
                    const compileRefs = useReference ? videoRefs : [];
                    const fallbackPrompt = useReference ? buildRef2VAPrompt(shot, compileRefs, stylePrompt) : buildH3BasePrompt(shot, stylePrompt);
                    compiledPrompt = fallbackPrompt;
                    try {
                        // 字段确定性生成：段内时间表（先声后画）+ 参考图绑定全部由 shot 字段拼装，不再让 LLM 自由改写。
                        compiledPrompt = ensureSpokenDialogue(
                            buildDeterministicH3Prompt({ shot, mode: promptMode, refs: compileRefs, style: stylePrompt, aspect: data.aspect, duration: estimateShotSeconds(shot) }),
                            shot.dialogue,
                        );
                    } catch {
                        compiledPrompt = fallbackPrompt;
                    }
                    setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, prompt: compiledPrompt } } : node)));
                    run = updateDramaRunItem(run, shot.shotNumber, { compiledPrompt });
                    saveDramaRun(dramaNode, episodeId, run);
                } catch (error) {
                    if (isGenerationCanceled(error)) {
                        setDramaProgress(null, 0, 0);
                        message.info("已停止生成");
                        await videoChain;
                        return;
                    }
                    const text = error instanceof Error ? error.message : "视频提示词生成失败";
                    failedTasks += 1;
                    failedShots.add(shot.shotNumber);
                    setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: text } } : node)));
                    message.error(`第 ${shot.shotNumber || index + 1} 镜提示词：${text}`);
                    continue;
                }
                const promptForVideo = compiledPrompt;
                const shotNo = shot.shotNumber;
                const pos = index;
                videoChain = videoChain.then(async () => {
                    if (isPaused()) return;
                    setDramaProgress(useReference ? "多参视频" : "视频", pos + 1, tasks.length);
                    try {
                        await handleGenerateNode(videoId, "video", promptForVideo);
                        await waitAutomationRender();
                        const videoState = nodesRef.current.find((node) => node.id === videoId);
                        const videoFailed = videoState?.metadata?.status === NODE_STATUS_ERROR;
                        const videoDone = Boolean(videoState?.metadata?.content);
                        if (videoFailed || !videoDone) failedTasks += 1;
                        run = updateDramaRunItem(run, shotNo, videoDone ? { done: true, lastError: undefined } : { lastError: videoFailed ? "视频生成失败" : "视频未生成" });
                        saveDramaRun(dramaNode, episodeId, run);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId ? { ...node, title: `视频 ${shotNo} · ${shot.title}`, metadata: { ...node.metadata, ...(useReference ? {} : { frameMode: "first" as const }) } } : node,
                            ),
                        );
                    } catch (error) {
                        if (isGenerationCanceled(error)) return;
                        const text = error instanceof Error ? error.message : "自动生成失败";
                        failedTasks += 1;
                        run = updateDramaRunItem(run, shotNo, { lastError: text });
                        saveDramaRun(dramaNode, episodeId, run);
                        setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: text } } : node)));
                        message.error(`第 ${shotNo} 镜视频：${text}`);
                    }
                });
            }
            await videoChain;
            if (isPaused()) {
                setDramaProgress(null, 0, 0);
                message.info("已暂停");
                return;
            }
            setDramaProgress(null, shots.length, shots.length);
            if (failedTasks) message.warning(`分镜已生成，${failedTasks} 镜自动生成失败`);
            else message.success(useReference ? `已生成 ${shots.length} 条分镜，并自动出多参视频` : `已生成 ${shots.length} 条分镜，并自动出首帧和视频`);
        },
        [effectiveConfig, handleGenerateNode, nodesRef, pollVideoNodeTask, resumeDramaStoryboards, saveDramaRun, setConnections, setNodes, waitAutomationRender],
    );

    const startDramaCreation = useCallback(
        async (dramaNode: CanvasNodeData, episodeId: string) => {
            const data = dramaNode.metadata?.dramaCard;
            const episode = data?.episodes.find((item) => item.id === episodeId);
            if (!data || !episode) throw new Error("分集不存在");
            const script = (episode.script || "").trim();
            if (!script) throw new Error("这一集还没有剧本，先导入 TXT 或粘贴剧本");
            const textConfig = resolveDramaTextConfig(effectiveConfig);
            if (!textConfig) throw new Error("未配置文本模型，无法拆解人物和场景");
            const style = findDramaStyle(data.style);
            const stylePrompt = style?.prompt || style?.promptEn || "";
            const runText = async (messages: Parameters<typeof requestImageQuestion>[1], timeoutMs: number, label: string) => {
                const controller = new AbortController();
                const timer = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
                try {
                    return await requestImageQuestion(textConfig, messages, () => undefined, { signal: controller.signal });
                } catch (error) {
                    const canceled = error instanceof DOMException && error.name === "AbortError";
                    throw new Error(canceled ? `${label}超时，请检查文本模型网络` : error instanceof Error ? error.message : `${label}失败`);
                } finally {
                    window.clearTimeout(timer);
                }
            };
            const [charactersAnswer, scenesAnswer, propsAnswer] = await Promise.all([
                runText(buildCharacterExtractionMessages(script, episode.title, style?.label || "", stylePrompt, data.aspect), 120000, "角色提取"),
                runText(buildSceneExtractionMessages(script, episode.title, style?.label || "", stylePrompt, data.aspect), 120000, "场景提取"),
                runText(buildPropExtractionMessages(script, episode.title, style?.label || "", stylePrompt, data.aspect), 120000, "道具提取").catch(() => "[]"),
            ]);
            const characters = normalizeCharacters(extractJson(charactersAnswer));
            const scenes = normalizeScenes(extractJson(scenesAnswer));
            const props = normalizeProps(extractJson(propsAnswer));
            if (!characters.length && !scenes.length && !props.length) throw new Error("没有从剧本里识别出人物、场景或道具");
            const rawPromptFor = (kind: "character" | "scene" | "prop", asset: (typeof characters)[number]) =>
                kind === "character" ? characterAssetPrompt(stylePrompt, asset, "") : kind === "scene" ? sceneAssetPrompt(stylePrompt, asset, "") : propAssetPrompt(stylePrompt, asset, "");

            const imageModel = data.imageWorkflow || "local-gateway::image-qwen21";
            const gap = 24;
            const baseX = dramaNode.position.x + dramaNode.width + 120;
            const baseY = dramaNode.position.y;
            const assetDims =
                data.aspect === "9:16"
                    ? { width: 216, height: 387, size: "928x1664" }
                    : data.aspect === "4:3"
                      ? { width: 320, height: 240, size: "1472x1104" }
                      : data.aspect === "3:4"
                        ? { width: 240, height: 320, size: "1104x1472" }
                        : data.aspect === "1:1"
                          ? { width: 280, height: 280, size: "1328x1328" }
                          : { width: 384, height: 214, size: "1664x928" };
            const kindKey = { character: "characters", scene: "scenes", prop: "props" } as const;
            const kindTitle = { character: "角色", scene: "场景", prop: "道具" } as const;
            const library = data.assets || { characters: [], scenes: [], props: [] };
            const nextLibrary = { characters: [...library.characters], scenes: [...library.scenes], props: [...library.props] };
            const sceneGroups: { key: string; scenes: typeof scenes }[] = [];
            for (const scene of scenes) {
                const key = normalizeLocationKey(scene.location || scene.name);
                const group = sceneGroups.find((candidate) => candidate.key === key) || sceneGroups.find((candidate) => isSameSceneKey(candidate.key, key)) || sceneGroups.find((candidate) => sharesSceneBase(candidate.key, key));
                if (group) {
                    if (key.length > group.key.length) group.key = key;
                    group.scenes.push(scene);
                } else {
                    sceneGroups.push({ key, scenes: [scene] });
                }
            }
            const sceneMetaByName = new Map<string, { locationKey: string; variant: string; time?: string; baseName?: string }>();
            for (const group of sceneGroups) {
                const first = group.scenes[0];
                const currentNames = new Set(group.scenes.map((scene) => scene.name));
                const existingBase = nextLibrary.scenes.find((record) => {
                    if (currentNames.has(record.name)) return false;
                    const recordKey = record.locationKey || normalizeLocationKey(record.location || record.name);
                    return (recordKey === group.key || isSameSceneKey(recordKey, group.key) || sharesSceneBase(recordKey, group.key)) && Boolean(record.imageUrl) && Boolean(record.nodeId);
                });
                if (existingBase) {
                    const baseKey = existingBase.locationKey || normalizeLocationKey(existingBase.location || existingBase.name);
                    if (baseKey.length > group.key.length) group.key = baseKey;
                }
                group.scenes.forEach((scene, index) => {
                    sceneMetaByName.set(scene.name, {
                        locationKey: group.key,
                        variant: deriveSceneVariant(scene.location || scene.name, scene.time || "", group.key),
                        time: scene.time,
                        baseName: existingBase?.name || (index > 0 ? first.name : undefined),
                    });
                });
            }
            const combined = [
                ...characters.map((asset) => ({ asset, kind: "character" as const })),
                ...sceneGroups.flatMap((group) => group.scenes).map((asset) => ({ asset, kind: "scene" as const })),
                ...props.map((asset) => ({ asset, kind: "prop" as const })),
            ];
            const created: {
                kind: "character" | "scene" | "prop";
                name: string;
                node: CanvasNodeData;
                prompt: string;
                asset: (typeof characters)[number];
                needPolish: boolean;
                baseName?: string;
                baseNodeId?: string;
                refMode?: "auto" | "off";
            }[] = [];
            const nodesToAdd: CanvasNodeData[] = [];
            const connectionsToAdd: CanvasConnection[] = [];
            let newSlot = 0;
            for (const item of combined) {
                const key = kindKey[item.kind];
                const list = nextLibrary[key];
                const existing = list.find((record) => record.name === item.asset.name);
                const prompt = existing?.polishedPrompt?.trim() || rawPromptFor(item.kind, item.asset);
                let node = existing?.nodeId ? nodesRef.current.find((candidate) => candidate.id === existing.nodeId) : undefined;
                if (!node) {
                    node = {
                        id: `drama-${item.kind}-${nanoid()}`,
                        type: CanvasNodeType.Image,
                        title: `${kindTitle[item.kind]} · ${item.asset.name}`,
                        position: { x: baseX, y: baseY + newSlot * (assetDims.height + gap) },
                        width: assetDims.width,
                        height: assetDims.height,
                        metadata: { status: NODE_STATUS_IDLE, generationType: "generation", imageMode: "t2i", model: imageModel, size: assetDims.size, count: 1, prompt },
                    };
                    newSlot += 1;
                    nodesToAdd.push(node);
                    connectionsToAdd.push({ id: nanoid(), fromNodeId: dramaNode.id, toNodeId: node.id, role: "lineage" });
                }
                const sceneInfo = item.kind === "scene" ? sceneMetaByName.get(item.asset.name) : undefined;
                const baseRecord = sceneInfo?.baseName ? nextLibrary.scenes.find((candidate) => candidate.name === sceneInfo.baseName) : undefined;
                const baseNodeId = baseRecord?.nodeId;
                const record = {
                    id: existing?.id || `drama-asset-${nanoid()}`,
                    kind: item.kind,
                    name: item.asset.name,
                    nameEn: item.asset.nameEn,
                    role: item.asset.role,
                    description: item.asset.description,
                    polishedPrompt: existing?.polishedPrompt,
                    prompt,
                    nodeId: node.id,
                    imageUrl: existing?.imageUrl,
                    state: existing?.state === "done" ? ("done" as const) : ("pending" as const),
                    error: undefined,
                    stages: existing?.stages,
                    location: item.kind === "scene" ? item.asset.location : undefined,
                    time: item.kind === "scene" ? item.asset.time : undefined,
                    variant: sceneInfo?.variant,
                    locationKey: sceneInfo?.locationKey,
                    refMode: item.kind === "scene" ? existing?.refMode || ("auto" as const) : undefined,
                    baseNodeId,
                    usedReference: sceneInfo?.baseName ? existing?.usedReference : false,
                };
                const index = list.findIndex((candidate) => candidate.name === item.asset.name);
                if (index >= 0) list[index] = record;
                else list.push(record);
                created.push({
                    kind: item.kind,
                    name: item.asset.name,
                    node,
                    prompt,
                    asset: item.asset,
                    needPolish: !existing?.polishedPrompt?.trim(),
                    baseName: sceneInfo?.baseName,
                    baseNodeId,
                    refMode: record.refMode,
                });
            }
            const setAssetRecord = (kind: "character" | "scene" | "prop", name: string, patch: Record<string, unknown>) => {
                setNodes((prev) =>
                    prev.map((candidate) => {
                        if (candidate.id !== dramaNode.id) return candidate;
                        const current = candidate.metadata?.dramaCard;
                        if (!current?.assets) return candidate;
                        const key = kindKey[kind];
                        return {
                            ...candidate,
                            metadata: {
                                ...candidate.metadata,
                                dramaCard: { ...current, assets: { ...current.assets, [key]: current.assets[key].map((record) => (record.name === name ? { ...record, ...patch } : record)) } },
                            },
                        };
                    }),
                );
            };
            if (!created.length) throw new Error("没有可创建的资产卡");
            setNodes((prev) => [
                ...prev.map((candidate) =>
                    candidate.id === dramaNode.id && candidate.metadata?.dramaCard
                        ? { ...candidate, metadata: { ...candidate.metadata, dramaCard: { ...candidate.metadata.dramaCard, assets: nextLibrary } } }
                        : candidate,
                ),
                ...nodesToAdd,
            ]);
            setConnections((prev) => [...prev, ...connectionsToAdd]);
            await waitAutomationRender();

            const assetImageByName = new Map<string, { url: string; storageKey?: string; mimeType?: string; nodeId: string }>();
            for (const key of ["characters", "scenes", "props"] as const) {
                for (const record of nextLibrary[key]) {
                    if (!record.imageUrl || !record.nodeId) continue;
                    const node = nodesRef.current.find((candidate) => candidate.id === record.nodeId);
                    if (!node?.metadata?.content && !node?.metadata?.storageKey) continue;
                    assetImageByName.set(record.name, {
                        url: node?.metadata?.content || record.imageUrl,
                        storageKey: node?.metadata?.storageKey,
                        mimeType: node?.metadata?.mimeType,
                        nodeId: record.nodeId,
                    });
                }
            }
            const supportsReference = (channelModelOf(effectiveConfig, imageModel)?.model.imageInputs ?? (imageModel.endsWith("::image-qwen21") ? 4 : 0)) > 0;

            let failed = 0;
            let assetDone = 0;
            const polishSlots = 3;
            let polishActive = 0;
            const polishWaiters: (() => void)[] = [];
            const polishPromises = new Map<string, Promise<void>>();
            const polishItem = async (item: (typeof created)[number]) => {
                const messages =
                    item.kind === "character"
                        ? buildRolePolishMessages(item.asset, stylePrompt, data.aspect)
                        : item.kind === "scene"
                          ? buildScenePolishMessages(item.asset, stylePrompt, data.aspect)
                          : buildPropPolishMessages(item.asset, stylePrompt, data.aspect);
                let polished = "";
                try {
                    polished = await runText(messages, 90000, `${kindTitle[item.kind]}「${item.name}」润色`);
                } catch {
                    polished = "";
                }
                if (!polished) return;
                item.prompt =
                    item.kind === "character"
                        ? characterAssetPrompt(stylePrompt, item.asset, polished)
                        : item.kind === "scene"
                          ? sceneAssetPrompt(stylePrompt, item.asset, polished)
                          : propAssetPrompt(stylePrompt, item.asset, polished);
                setAssetRecord(item.kind, item.name, { prompt: item.prompt, polishedPrompt: item.prompt });
                setNodes((prev) => prev.map((node) => (node.id === item.node.id ? { ...node, metadata: { ...node.metadata, prompt: item.prompt } } : node)));
            };
            const ensurePolish = (item: (typeof created)[number]) => {
                if (!item.needPolish) return Promise.resolve();
                const existing = polishPromises.get(item.node.id);
                if (existing) return existing;
                const run = async () => {
                    if (polishActive >= polishSlots) await new Promise<void>((resolve) => polishWaiters.push(resolve));
                    polishActive += 1;
                    try {
                        await polishItem(item);
                    } finally {
                        polishActive -= 1;
                        polishWaiters.shift()?.();
                    }
                };
                const promise = run();
                polishPromises.set(item.node.id, promise);
                return promise;
            };
            created.slice(0, polishSlots).forEach((item) => void ensurePolish(item));
            updateDramaCardProgress(setNodes, dramaNode.id, "资产", 0, created.length);
            for (const item of created) {
                if (dramaPauseRef.current.has(dramaNode.id)) {
                    updateDramaCardProgress(setNodes, dramaNode.id, null, 0, 0);
                    message.info("已暂停");
                    return;
                }
                let assetController: AbortController | undefined;
                try {
                    await ensurePolish(item);
                    const imageConfig = { ...buildGenerationConfig(effectiveConfig, item.node, "image"), model: imageModel, count: "1", size: assetDims.size, imageMode: "t2i" as const };
                    if (!isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("生图工作流不可用");
                    const baseImage = item.baseName ? assetImageByName.get(item.baseName) : undefined;
                    const referenceEligible = Boolean(
                        item.kind === "scene" &&
                            item.baseName &&
                            item.baseNodeId !== item.node.id &&
                            item.refMode !== "off" &&
                            supportsReference &&
                            baseImage &&
                            !isMajorSceneChange(`${item.asset.name} ${item.asset.description} ${item.prompt}`),
                    );
                    assetImageByName.delete(item.name);
                    setAssetRecord(item.kind, item.name, { state: "loading", error: undefined, prompt: item.prompt, ...(item.kind === "scene" ? { usedReference: undefined } : {}) });
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === item.node.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, model: imageModel, size: imageConfig.size, prompt: item.prompt } } : node,
                        ),
                    );
                    const controller = startGenerationRequest(item.node.id, dramaNode.id, item.node.id);
                    assetController = controller;
                    let image: { id: string; dataUrl: string } | undefined;
                    let usedReference = false;
                    if (referenceEligible && baseImage) {
                        try {
                            usedReference = true;
                            image = await requestEdit(
                                { ...imageConfig, imageMode: "edit" as const },
                                sceneReferencePrompt(item.prompt),
                                [{ id: baseImage.nodeId, name: `${item.baseName}.png`, type: baseImage.mimeType || "image/png", dataUrl: "", url: baseImage.url, storageKey: baseImage.storageKey }],
                                { signal: controller.signal },
                            ).then((items) => items[0]);
                            if (!image) throw new Error("没有返回图片");
                        } catch (error) {
                            if (isGenerationCanceled(error)) throw error;
                            usedReference = false;
                            message.warning(`场景「${item.name}」参考图生成失败，已改用文生图`);
                            image = await requestGeneration(imageConfig, item.prompt, { signal: controller.signal }).then((items) => items[0]);
                        }
                    } else {
                        image = await requestGeneration(imageConfig, item.prompt, { signal: controller.signal }).then((items) => items[0]);
                    }
                    if (!image) throw new Error("没有返回图片");
                    const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                    assetImageByName.set(item.name, { url: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, nodeId: item.node.id });
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === item.node.id
                                ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS, generationType: "generation", imageMode: "t2i", model: imageModel, size: imageConfig.size, prompt: item.prompt } }
                                : node,
                        ),
                    );
                    setAssetRecord(item.kind, item.name, { state: "done", error: undefined, imageUrl: uploaded.url, prompt: item.prompt, polishedPrompt: item.prompt, ...(item.kind === "scene" ? { usedReference } : {}) });
                    finishGenerationRequest(item.node.id, controller);
                } catch (error) {
                    failed += 1;
                    if (assetController) finishGenerationRequest(item.node.id, assetController);
                    setNodes((prev) => prev.map((node) => (node.id === item.node.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: error instanceof Error ? error.message : "资产生成失败" } } : node)));
                    setAssetRecord(item.kind, item.name, { state: "error", error: error instanceof Error ? error.message : "资产生成失败" });
                }
                assetDone += 1;
                updateDramaCardProgress(setNodes, dramaNode.id, "资产", assetDone, created.length);
            }
            if (failed) message.warning(`已建立 ${created.length} 张资产卡，${failed} 张生成失败`);
            else message.success(`已建立 ${created.length} 张资产卡并完成生成`);
            if (dramaPauseRef.current.has(dramaNode.id)) {
                updateDramaCardProgress(setNodes, dramaNode.id, null, 0, 0);
                message.info("已暂停");
                return;
            }
            if (failed < created.length) {
                await waitAutomationRender();
                const latestNode = nodesRef.current.find((node) => node.id === dramaNode.id) || dramaNode;
                try {
                    await generateDramaStoryboards(latestNode, episodeId);
                } catch (error) {
                    updateDramaCardProgress(setNodes, dramaNode.id, null, 0, 0);
                    message.error(error instanceof Error ? error.message : "分镜生成失败");
                }
            } else {
                updateDramaCardProgress(setNodes, dramaNode.id, null, 0, 0);
            }
        },
        [effectiveConfig, finishGenerationRequest, generateDramaStoryboards, isAiConfigReady, message, startGenerationRequest, waitAutomationRender],
    );

    const addDramaStage = useCallback(
        async (dramaNode: CanvasNodeData, characterName: string, stageName: string, description: string) => {
            const data = dramaNode.metadata?.dramaCard;
            const record = data?.assets?.characters.find((item) => item.name === characterName);
            if (!data || !record) throw new Error("角色不存在");
            const style = findDramaStyle(data.style);
            const stylePrompt = style?.prompt || style?.promptEn || "";
            const imageModel = data.imageWorkflow || "local-gateway::image-qwen21";
            const dims =
                data.aspect === "9:16"
                    ? { width: 216, height: 387, size: "928x1664" }
                    : data.aspect === "4:3"
                      ? { width: 320, height: 240, size: "1472x1104" }
                      : data.aspect === "3:4"
                        ? { width: 240, height: 320, size: "1104x1472" }
                        : data.aspect === "1:1"
                          ? { width: 280, height: 280, size: "1328x1328" }
                          : { width: 384, height: 214, size: "1664x928" };
            const prompt = characterAssetPrompt(stylePrompt, { ...record, name: `${record.name} ${stageName}`, description }, "");
            const assetNodeCount = ["characters", "scenes", "props"].reduce((sum, key) => sum + (data.assets?.[key as "characters" | "scenes" | "props"] || []).filter((item) => item.nodeId).length, 0);
            const node: CanvasNodeData = {
                id: `drama-stage-${nanoid()}`,
                type: CanvasNodeType.Image,
                title: `角色 · ${record.name} · ${stageName}`,
                position: { x: dramaNode.position.x + dramaNode.width + 120, y: dramaNode.position.y + assetNodeCount * (dims.height + 24) },
                width: dims.width,
                height: dims.height,
                metadata: { status: NODE_STATUS_IDLE, generationType: "generation", imageMode: "t2i", model: imageModel, size: dims.size, count: 1, prompt },
            };
            setNodes((prev) => [
                ...prev.map((candidate) => {
                    if (candidate.id !== dramaNode.id) return candidate;
                    const current = candidate.metadata?.dramaCard;
                    if (!current?.assets) return candidate;
                    return {
                        ...candidate,
                        metadata: {
                            ...candidate.metadata,
                            dramaCard: {
                                ...current,
                                assets: {
                                    ...current.assets,
                                    characters: current.assets.characters.map((item) =>
                                        item.name === characterName ? { ...item, stages: [...(item.stages || []), { id: `stage-${nanoid()}`, name: stageName, description, prompt, nodeId: node.id, state: "pending" as const }] } : item,
                                    ),
                                },
                            },
                        },
                    };
                }),
                node,
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: dramaNode.id, toNodeId: node.id, role: "lineage" }]);
            await waitAutomationRender();
            const setStageState = (patch: Record<string, unknown>) => {
                setNodes((prev) =>
                    prev.map((candidate) => {
                        const current = candidate.id === dramaNode.id ? candidate.metadata?.dramaCard : null;
                        if (!current?.assets) return candidate;
                        return {
                            ...candidate,
                            metadata: {
                                ...candidate.metadata,
                                dramaCard: {
                                    ...current,
                                    assets: {
                                        ...current.assets,
                                        characters: current.assets.characters.map((item) =>
                                            item.name === characterName ? { ...item, stages: (item.stages || []).map((stageItem) => (stageItem.nodeId === node.id ? { ...stageItem, ...patch } : stageItem)) } : item,
                                        ),
                                    },
                                },
                            },
                        };
                    }),
                );
            };
            try {
                const imageConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), model: imageModel, count: "1", size: dims.size, imageMode: "t2i" as const };
                if (!isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("生图工作流不可用");
                setStageState({ state: "loading" });
                setNodes((prev) => prev.map((candidate) => (candidate.id === node.id ? { ...candidate, metadata: { ...candidate.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : candidate)));
                const controller = startGenerationRequest(node.id, dramaNode.id, node.id);
                const image = await requestGeneration(imageConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                if (!image) throw new Error("没有返回图片");
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                setNodes((prev) => prev.map((candidate) => (candidate.id === node.id ? { ...candidate, metadata: { ...candidate.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS } } : candidate)));
                setStageState({ state: "done", error: undefined, imageUrl: uploaded.url });
                finishGenerationRequest(node.id, controller);
            } catch (error) {
                setNodes((prev) => prev.map((candidate) => (candidate.id === node.id ? { ...candidate, metadata: { ...candidate.metadata, status: NODE_STATUS_ERROR, errorDetails: error instanceof Error ? error.message : "造型生成失败" } } : candidate)));
                setStageState({ state: "error", error: error instanceof Error ? error.message : "造型生成失败" });
                throw error;
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, startGenerationRequest, waitAutomationRender],
    );

    const setDramaSceneRefMode = useCallback((dramaNode: CanvasNodeData, name: string, refMode: "auto" | "off") => {
        setNodes((prev) =>
            prev.map((candidate) => {
                if (candidate.id !== dramaNode.id) return candidate;
                const current = candidate.metadata?.dramaCard;
                if (!current?.assets) return candidate;
                return {
                    ...candidate,
                    metadata: {
                        ...candidate.metadata,
                        dramaCard: {
                            ...current,
                            assets: {
                                ...current.assets,
                                scenes: current.assets.scenes.map((record) => (record.name === name ? { ...record, refMode } : record)),
                            },
                        },
                    },
                };
            }),
        );
    }, []);

    const syncAutomation = useCallback((nodeId: string, state: CanvasAutomationState, status?: CanvasNodeMetadata["status"], errorDetails?: string) => {
        const pages = state.pages || [];
        const sheets = state.characterSheets || [];
        const sceneSheets = state.sceneSheets || [];
        const sheetDone = sheets.filter((sheet) => sheet.state === "done").length;
        const sceneDone = sceneSheets.filter((sheet) => sheet.state === "done").length;
        const sheetActive = sheets.some((sheet) => sheet.state === "loading") || sceneSheets.some((sheet) => sheet.state === "loading");
        const total = pages.length * 2 + sheets.length + sceneSheets.length;
        const done = pages.reduce((sum, page) => sum + (page.imageState === "done" ? 1 : 0) + (page.videoState === "done" ? 1 : 0), 0) + sheetDone + sceneDone;
        const active = sheetActive || pages.some((page) => page.imageState === "loading" || page.videoState === "loading");
        const stepProgress = status === "loading" && total > 0 ? { step: Math.min(total, done + (active ? 1 : 0)), total, complete: false } : undefined;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              ...(status ? { status } : {}),
                              ...(status === "error" ? { errorDetails } : { errorDetails: undefined }),
                              stepProgress,
                              automation: state,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const resolveAutomationModels = useCallback(
        (settings: CanvasAutomationSettings) => {
            const buildTextConfig = (value: string) => {
                if (value.startsWith("prompt-cloud::")) {
                    const id = value.slice("prompt-cloud::".length);
                    const api = (effectiveConfig.promptCloudApis || []).find((item) => item.id === id) || activePromptCloudApi(effectiveConfig);
                    if (!api) throw new Error(t("canvas.automation.textModelRequired"));
                    const channelId = `prompt-cloud-${api.id || "active"}`;
                    const modelValue = `${channelId}::${api.model}`;
                    return {
                        textModel: modelValue,
                        textConfig: {
                            ...effectiveConfig,
                            channels: [{ id: channelId, name: api.name || "Cloud", baseUrl: api.baseUrl, apiKey: api.apiKey, apiFormat: "openai" as const, models: [{ name: api.model, capability: "text" as const }] }, ...effectiveConfig.channels],
                            model: modelValue,
                            textModel: modelValue,
                        },
                    };
                }
                const textModel = value || effectiveConfig.textModel;
                if (textModel) return { textModel, textConfig: { ...effectiveConfig, model: textModel } };
                const cloud = activePromptCloudApi(effectiveConfig);
                if (cloud) return buildTextConfig(`prompt-cloud::${cloud.id || "active"}`);
                throw new Error(t("canvas.automation.textModelRequired"));
            };
            const { textModel, textConfig } = buildTextConfig(settings.textModel || "");
            const imageOptions = workflowModelOptions(effectiveConfig, "image");
            const imageList = imageOptions.length ? imageOptions : selectableModelsByCapability(effectiveConfig, "image");
            const mossModel = imageList.find((value) => channelModelOf(effectiveConfig, value)?.model.workflowId === "image-moss-image") || "";
            if (!mossModel) throw new Error("未找到 MOSS 模型，请先安装 MOSS 资源包");
            const mossMeta = channelModelOf(effectiveConfig, mossModel)?.model.moss;
            const mossTier = settings.mossSteps === "50" ? "ultra" : "fast";
            if (mossMeta?.tiers?.[mossTier]?.available === false) throw new Error(mossMeta.tiers[mossTier].reason || `MOSS ${settings.mossSteps}步档不可用`);
            const storyboardModel = imageList.find((value) => {
                const model = channelModelOf(effectiveConfig, value)?.model;
                const text = `${model?.name || value} ${model?.workflowId || ""}`.toLowerCase();
                return model?.workflowId === "image-qwen21" || text.includes("qwen21") || text.includes("qwen image 2.1");
            });
            if (!storyboardModel) throw new Error("未找到 Qwen Image 2.1 故事板模型，请在设置中启用 Qwen Image 2.1");
            const configuredVideo = effectiveConfig.videoModel || effectiveConfig.model;
            const configuredWorkflow = configuredVideo ? videoWorkflowId(effectiveConfig, configuredVideo) : "";
            const vdnModel = videoModelForWorkflow(effectiveConfig, "video-h3-ref2va");
            const noVdnModel = videoModelForWorkflow(effectiveConfig, "video-h3-ref2va", { noVdn: true });
            const variant = settings.videoVariant || "auto";
            const videoModel =
                variant === "vdn"
                    ? vdnModel || noVdnModel
                    : variant === "novdn"
                      ? noVdnModel || vdnModel
                      : configuredWorkflow === "video-h3-ref2va" || configuredWorkflow === "video-h3-ref2va-novdn"
                        ? configuredVideo
                        : noVdnModel || vdnModel;
            if (!videoModel) throw new Error("未找到 H3 多参视频模型，请安装 video-h3-ref2va 资源");
            return { textConfig, textModel, mossModel, storyboardModel, videoModel };
        },
        [effectiveConfig, t],
    );

    const createAutomationChildren = useCallback(async (parent: CanvasNodeData, pages: CanvasAutomationPage[], settings: CanvasAutomationSettings, storyboardModel: string, leftOffset = 0) => {
        const slots = computeAutomationLayout(parent, pages.length, settings.aspect, settings.grid, leftOffset);
        const existingNodes = new Set(nodesRef.current.map((node) => node.id));
        const existingConnections = new Set(connectionsRef.current.map((connection) => `${connection.fromNodeId}->${connection.toNodeId}`));
        const newNodes: CanvasNodeData[] = [];
        const newConnections: CanvasConnection[] = [];
        const nextPages = pages.map((page, index) => {
            const textSlot = slots.texts[index];
            const imageSlot = slots.images[index];
            const currentImage = page.imageNodeId ? nodesRef.current.find((node) => node.id === page.imageNodeId) : undefined;
            let textNodeId = page.textNodeId;
            if (!textNodeId || !existingNodes.has(textNodeId)) {
                textNodeId = `automation-text-${nanoid()}`;
                newNodes.push({
                    id: textNodeId,
                    type: CanvasNodeType.Text,
                    title: `第 ${index + 1} 页 · ${page.title}`,
                    position: { x: textSlot.x, y: textSlot.y },
                    width: textSlot.width,
                    height: textSlot.height,
                    metadata: { content: formatPageCard(page), prompt: page.layout.summary, status: NODE_STATUS_SUCCESS, fontSize: 12 },
                });
            }
            let imageNodeId = page.imageNodeId;
            if (!imageNodeId || !existingNodes.has(imageNodeId)) {
                imageNodeId = `automation-image-${nanoid()}`;
                newNodes.push({
                    id: imageNodeId,
                    type: CanvasNodeType.Image,
                    title: `第 ${index + 1} 页 · 漫画`,
                    position: { x: imageSlot.x, y: imageSlot.y },
                    width: imageSlot.width,
                    height: imageSlot.height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        generationType: "generation",
                        imageMode: "t2i",
                        layout: page.layout,
                        model: storyboardModel,
                        size: `${page.layout.width || 1024}x${page.layout.height || 1024}`,
                        count: 1,
                        prompt: page.layout.summary,
                    },
                });
            }
            const parentLink = `${parent.id}->${textNodeId}`;
            if (!existingConnections.has(parentLink)) {
                newConnections.push({ id: nanoid(), fromNodeId: parent.id, toNodeId: textNodeId, role: "lineage" });
                existingConnections.add(parentLink);
            }
            const imageLink = `${textNodeId}->${imageNodeId}`;
            if (!existingConnections.has(imageLink)) {
                newConnections.push({ id: nanoid(), fromNodeId: textNodeId, toNodeId: imageNodeId, role: "lineage" });
                existingConnections.add(imageLink);
            }
            return {
                ...page,
                textNodeId,
                imageNodeId,
                imageState: currentImage?.metadata?.content ? ("done" as const) : page.imageState,
            };
        });
        if (newNodes.length) setNodes((prev) => [...prev, ...newNodes]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        return nextPages;
    }, []);

    const createAutomationCharacterSheets = useCallback(async (parent: CanvasNodeData, characters: CanvasAutomationCharacter[], existingSheets: CanvasAutomationCharacterSheet[], settings: CanvasAutomationSettings, mossModel: string) => {
        const existingNodes = new Set(nodesRef.current.map((node) => node.id));
        const existingConnections = new Set(connectionsRef.current.map((connection) => `${connection.fromNodeId}->${connection.toNodeId}`));
        const newNodes: CanvasNodeData[] = [];
        const newConnections: CanvasConnection[] = [];
        const positionUpdates = new Map<string, { x: number; y: number }>();
        const width = 320;
        const height = 240;
        const gap = 24;
        const startX = parent.position.x + parent.width + 120;
        const startY = parent.position.y;
        const nextSheets = characters.slice(0, 4).map((character, index) => {
            const existing = existingSheets.find((sheet) => sheet.characterId === character.id);
            let nodeId = existing?.nodeId;
            if (!nodeId || !existingNodes.has(nodeId)) {
                nodeId = `automation-character-${nanoid()}`;
                newNodes.push({
                    id: nodeId,
                    type: CanvasNodeType.Image,
                    title: `角色设定 · ${character.name}`,
                    position: { x: startX, y: startY + index * (height + gap) },
                    width,
                    height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        generationType: "generation",
                        model: mossModel,
                        size: "1024x768",
                        count: 1,
                        prompt: automationCharacterSheetPrompt(character, settings.style),
                    },
                });
            }
            const link = `${parent.id}->${nodeId}`;
            if (!existingConnections.has(link)) {
                newConnections.push({ id: nanoid(), fromNodeId: parent.id, toNodeId: nodeId, role: "lineage" });
                existingConnections.add(link);
            }
            if (existingNodes.has(nodeId)) positionUpdates.set(nodeId, { x: startX, y: startY + index * (height + gap) });
            const node = nodesRef.current.find((item) => item.id === nodeId);
            return {
                characterId: character.id,
                nodeId,
                state: node?.metadata?.content ? ("done" as const) : existing?.state === "error" ? ("pending" as const) : existing?.state || ("pending" as const),
                error: existing?.error,
            };
        });
        if (newNodes.length) setNodes((prev) => [...prev, ...newNodes]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        if (positionUpdates.size) setNodes((prev) => prev.map((node) => (positionUpdates.has(node.id) ? { ...node, position: positionUpdates.get(node.id)! } : node)));
        return nextSheets;
    }, []);

    const createAutomationSceneSheets = useCallback(async (parent: CanvasNodeData, scenes: { id: string; name: string; description?: string }[], existingSheets: CanvasAutomationSceneSheet[], settings: CanvasAutomationSettings, mossModel: string, characterCount: number) => {
        const existingNodes = new Set(nodesRef.current.map((node) => node.id));
        const existingConnections = new Set(connectionsRef.current.map((connection) => `${connection.fromNodeId}->${connection.toNodeId}`));
        const newNodes: CanvasNodeData[] = [];
        const newConnections: CanvasConnection[] = [];
        const positionUpdates = new Map<string, { x: number; y: number }>();
        const width = 320;
        const height = 180;
        const gap = 24;
        const startX = parent.position.x + parent.width + 120;
        const startY = parent.position.y + characterCount * (240 + gap);
        const nextSheets = scenes.map((scene, index) => {
            const existing = existingSheets.find((sheet) => sheet.sceneId === scene.id);
            let nodeId = existing?.nodeId;
            const position = { x: startX, y: startY + index * (height + gap) };
            if (!nodeId || !existingNodes.has(nodeId)) {
                nodeId = `automation-scene-${nanoid()}`;
                newNodes.push({
                    id: nodeId,
                    type: CanvasNodeType.Image,
                    title: `场景设定 · ${scene.name}`,
                    position,
                    width,
                    height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        generationType: "generation",
                        model: mossModel,
                        size: "1280x720",
                        count: 1,
                        prompt: `场景概念图/背景设定图，无人物、无文字、无边框，展示空间布局、光线、材质和关键道具；${scene.description || scene.name}；画风：${settings.style}`,
                    },
                });
            } else {
                positionUpdates.set(nodeId, position);
            }
            const link = `${parent.id}->${nodeId}`;
            if (!existingConnections.has(link)) {
                newConnections.push({ id: nanoid(), fromNodeId: parent.id, toNodeId: nodeId, role: "lineage" });
                existingConnections.add(link);
            }
            const node = nodesRef.current.find((item) => item.id === nodeId);
            return {
                sceneId: scene.id,
                name: scene.name,
                nodeId,
                state: node?.metadata?.content ? ("done" as const) : existing?.state === "error" ? ("pending" as const) : existing?.state || ("pending" as const),
                error: existing?.error,
            };
        });
        if (newNodes.length) setNodes((prev) => [...prev, ...newNodes]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        if (positionUpdates.size) setNodes((prev) => prev.map((node) => (positionUpdates.has(node.id) ? { ...node, position: positionUpdates.get(node.id)! } : node)));
        return nextSheets;
    }, []);

    const runAutomationSceneSheet = useCallback(
        async (parentId: string, scene: { id: string; name: string; description?: string }, sheet: CanvasAutomationSceneSheet, settings: CanvasAutomationSettings, mossModel: string, signal: AbortSignal) => {
            const node = nodesRef.current.find((item) => item.id === sheet.nodeId);
            if (!node) throw new Error(`场景设定卡不存在：${scene.name}`);
            const prompt = node.metadata?.prompt || `场景概念图/背景设定图，无人物、无文字、无边框；${scene.description || scene.name}；画风：${settings.style}`;
            const baseImageConfig = buildGenerationConfig(effectiveConfig, node, "image");
            const imageConfig = { ...baseImageConfig, model: mossModel, count: "1", size: "1280x720", params: { ...(baseImageConfig.params || {}), mossTier: settings.mossSteps === "50" ? "ultra" : "fast", mossPrecision: "auto" } };
            if (!isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("MOSS 模型不可用，无法生成场景图");
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, prompt, model: mossModel, size: "1280x720" } } : item)));
            const controller = startGenerationRequest(node.id, parentId, node.id);
            const abortGeneration = () => controller.abort("user-stop");
            if (signal.aborted) abortGeneration();
            else signal.addEventListener("abort", abortGeneration, { once: true });
            try {
                const image = await requestGeneration(imageConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                if (!image) throw new Error("MOSS 没有返回场景图");
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? { ...item, metadata: { ...item.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS, generationType: "generation", model: mossModel, size: "1280x720", prompt } }
                            : item,
                    ),
                );
            } catch (error) {
                const canceled = isGenerationCanceled(error);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id && !item.metadata?.content
                            ? { ...item, metadata: { ...item.metadata, status: canceled ? NODE_STATUS_IDLE : NODE_STATUS_ERROR, errorDetails: canceled ? undefined : error instanceof Error ? error.message : "场景图生成失败" } }
                            : item,
                    ),
                );
                throw error;
            } finally {
                signal.removeEventListener("abort", abortGeneration);
                finishGenerationRequest(node.id, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, startGenerationRequest],
    );

    const createAutomationVideoNodes = useCallback(async (parent: CanvasNodeData, pages: CanvasAutomationPage[], settings: CanvasAutomationSettings, videoModel: string, sheets: CanvasAutomationCharacterSheet[], sceneSheets: CanvasAutomationSceneSheet[]) => {
        const slots = computeAutomationLayout(parent, pages.length, settings.aspect, settings.grid);
        const existingNodes = new Set(nodesRef.current.map((node) => node.id));
        const existingConnections = new Set(connectionsRef.current.map((connection) => `${connection.fromNodeId}->${connection.toNodeId}`));
        const newNodes: CanvasNodeData[] = [];
        const newConnections: CanvasConnection[] = [];
        const updates = new Map<string, Partial<CanvasNodeMetadata>>();
        const layoutUpdates = new Map<string, { position: { x: number; y: number }; width: number; height: number }>();
        const nextPages = pages.map((page, index) => {
            const baseIndex = pages.findIndex((item) => item.imageNodeId && item.imageNodeId === page.imageNodeId);
            const layoutIndex = baseIndex >= 0 ? baseIndex : index;
            const idealImage = slots.images[layoutIndex] || slots.images[index];
            const videoBase = slots.videos[layoutIndex] || slots.videos[index];
            const imageNode = page.imageNodeId ? nodesRef.current.find((node) => node.id === page.imageNodeId) : undefined;
            const imageAnchor = imageNode?.position || idealImage;
            const segmentOffset = page.segmentIndex || 0;
            // Anchor video slots to the real image cards so moving the agent card cannot shift the video queue away from its image.
            const videoSlot = {
                ...videoBase,
                x: imageAnchor.x + (videoBase.x - idealImage.x),
                y: imageAnchor.y + (videoBase.y - idealImage.y) + segmentOffset * (videoBase.height + 24),
            };
            const prompt = page.videoPrompt || page.videoHint || "";
            const seconds = resolvePageVideoSeconds(page, settings);
            let videoNodeId = page.videoNodeId;
            if (!videoNodeId || !existingNodes.has(videoNodeId)) {
                videoNodeId = `automation-video-${nanoid()}`;
                newNodes.push({
                    id: videoNodeId,
                    type: CanvasNodeType.Video,
                    title: page.videoTitle || `第 ${layoutIndex + 1} 页 · 视频`,
                    position: { x: videoSlot.x, y: videoSlot.y },
                    width: videoSlot.width,
                    height: videoSlot.height,
                    metadata: {
                        status: NODE_STATUS_IDLE,
                        model: videoModel,
                        videoMode: "reference",
                        size: settings.aspect,
                        seconds,
                        vquality: settings.vquality,
                        generateAudio: settings.generateAudio ? "true" : "false",
                        count: 1,
                        prompt,
                    },
                });
            } else {
                updates.set(videoNodeId, { prompt, model: videoModel, videoMode: "reference", frameMode: undefined, size: settings.aspect, seconds, vquality: settings.vquality, generateAudio: settings.generateAudio ? "true" : "false" });
                layoutUpdates.set(videoNodeId, { position: { x: videoSlot.x, y: videoSlot.y }, width: videoSlot.width, height: videoSlot.height });
            }
            const videoManifest = buildAutomationVideoReference(page, sheets, sceneSheets);
            videoManifest.characters.forEach((reference) => {
                const link = `${reference.nodeId}->${videoNodeId}`;
                if (existingConnections.has(link)) return;
                newConnections.push({ id: nanoid(), fromNodeId: reference.nodeId, toNodeId: videoNodeId });
                existingConnections.add(link);
            });
            if (videoManifest.scene) {
                const sceneLink = `${videoManifest.scene.nodeId}->${videoNodeId}`;
                if (!existingConnections.has(sceneLink)) {
                    newConnections.push({ id: nanoid(), fromNodeId: videoManifest.scene.nodeId, toNodeId: videoNodeId });
                    existingConnections.add(sceneLink);
                }
            }
            if (page.imageNodeId) {
                const link = `${page.imageNodeId}->${videoNodeId}`;
                if (!existingConnections.has(link)) {
                    newConnections.push({ id: nanoid(), fromNodeId: page.imageNodeId, toNodeId: videoNodeId });
                    existingConnections.add(link);
                }
            }
            return { ...page, videoSeconds: seconds, videoNodeId };
        });
        if (newNodes.length) setNodes((prev) => [...prev, ...newNodes]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        if (updates.size) {
            setNodes((prev) =>
                prev.map((node) => {
                    if (!updates.has(node.id)) return node;
                    const layout = layoutUpdates.get(node.id);
                    return { ...node, ...(layout ? layout : {}), metadata: { ...node.metadata, ...updates.get(node.id) } };
                }),
            );
        }
        return nextPages;
    }, []);

    const runAutomationCharacterSheet = useCallback(
        async (parentId: string, character: CanvasAutomationCharacter, sheet: CanvasAutomationCharacterSheet, settings: CanvasAutomationSettings, mossModel: string, signal: AbortSignal) => {
            const node = nodesRef.current.find((item) => item.id === sheet.nodeId);
            if (!node) throw new Error(`角色设定卡不存在：${character.name}`);
            const prompt = node.metadata?.prompt || automationCharacterSheetPrompt(character, settings.style);
            const baseImageConfig = buildGenerationConfig(effectiveConfig, node, "image");
            const imageConfig = { ...baseImageConfig, model: mossModel, count: "1", size: "1024x768", params: { ...(baseImageConfig.params || {}), mossTier: settings.mossSteps === "50" ? "ultra" : "fast", mossPrecision: "auto" } };
            if (!isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("MOSS 模型不可用，无法生成角色四视图");
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, prompt, model: mossModel, size: "1024x768" } } : item)));
            const controller = startGenerationRequest(node.id, parentId, node.id);
            const abortGeneration = () => controller.abort("user-stop");
            if (signal.aborted) abortGeneration();
            else signal.addEventListener("abort", abortGeneration, { once: true });
            try {
                const image = await requestGeneration(imageConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                if (!image) throw new Error("MOSS 没有返回角色四视图");
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? { ...item, metadata: { ...item.metadata, ...imageMetadata(uploaded), status: NODE_STATUS_SUCCESS, generationType: "generation", model: mossModel, size: "1024x768", prompt } }
                            : item,
                    ),
                );
            } catch (error) {
                const canceled = isGenerationCanceled(error);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id && !item.metadata?.content
                            ? { ...item, metadata: { ...item.metadata, status: canceled ? NODE_STATUS_IDLE : NODE_STATUS_ERROR, errorDetails: canceled ? undefined : error instanceof Error ? error.message : "角色四视图生成失败" } }
                            : item,
                    ),
                );
                throw error;
            } finally {
                signal.removeEventListener("abort", abortGeneration);
                finishGenerationRequest(node.id, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, startGenerationRequest],
    );


    const runAutomationImage = useCallback(
        async (parentId: string, page: CanvasAutomationPage, settings: CanvasAutomationSettings, storyboardModel: string, signal: AbortSignal) => {
            const imageNode = nodesRef.current.find((node) => node.id === page.imageNodeId);
            if (!imageNode) throw new Error(`第 ${page.index + 1} 页漫画卡不存在`);
            let layout = page.layout;
            const textNode = nodesRef.current.find((node) => node.id === page.textNodeId);
            if (textNode?.metadata?.content) {
                try {
                    const parsed = JSON.parse(textNode.metadata.content) as {
                        moss?: unknown;
                        layout?: unknown;
                        style?: string;
                        styleLock?: string;
                        styleNegative?: string;
                        grid?: CanvasAutomationGrid;
                        panels?: CanvasAutomationPanelSpec[];
                        characters?: CanvasAutomationCharacter[];
                    };
                    if (Array.isArray(parsed.panels) && parsed.panels.length && parsed.grid) {
                        layout = buildGridMoss({
                            style: parsed.style || page.style || settings.style,
                            styleLock: parsed.styleLock || page.styleLock,
                            styleNegative: parsed.styleNegative || page.styleNegative,
                            characters: parsed.characters || page.characters || [],
                            panels: parsed.panels,
                            grid: parsed.grid,
                            aspect: settings.aspect,
                            storyboard: settings.storyboardWhiteModel !== false,
                        });
                    } else {
                        const raw = parsed.moss || parsed.layout;
                        if (raw) layout = normalizeMossLayout(raw, settings.aspect);
                    }
                } catch {
                    // The text card may be edited mid-write; keep the last valid layout.
                }
            }
            if (settings.storyboardWhiteModel !== false && layout.storyboardVersion !== STORYBOARD_PROMPT_VERSION) {
                throw new Error("当前页的故事板仍是旧版白模提示词，请新建自动化任务后再生成");
            }
            const imageConfig = {
                ...buildGenerationConfig(effectiveConfig, imageNode, "image"),
                model: storyboardModel,
                count: "1",
                size: `${layout.width || 1024}x${layout.height || 1024}`,
                imageMode: "t2i" as const,
            };
            if (!isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("Qwen Image 2.1 故事板模型不可用，请检查本地 ComfyUI");
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === imageNode.id
                        ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, imageMode: "t2i", layout, model: imageConfig.model, size: imageConfig.size, prompt: layout.summary } }
                        : node,
                ),
            );
            const controller = startGenerationRequest(imageNode.id, parentId, imageNode.id);
            const abortGeneration = () => controller.abort("user-stop");
            if (signal.aborted) abortGeneration();
            else signal.addEventListener("abort", abortGeneration, { once: true });
            try {
                const image = await requestGeneration(imageConfig, layout.summary, { signal: controller.signal, negative: STORYBOARD_NEGATIVE_PROMPT }).then((items) => items[0]);
                if (!image) throw new Error("Qwen Image 2.1 没有返回故事板");
                const uploaded = await uploadImage(image.dataUrl, { signal: controller.signal });
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === imageNode.id
                            ? {
                                  ...node,
                                  width: imageNode.width,
                                  height: imageNode.height,
                                  position: imageNode.position,
                                  metadata: { ...node.metadata, ...imageMetadata(uploaded), generationType: "generation", imageMode: "t2i", layout, model: imageConfig.model, size: imageConfig.size, prompt: layout.summary },
                              }
                            : node,
                    ),
                );
            } catch (error) {
                const canceled = isGenerationCanceled(error);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === imageNode.id && !node.metadata?.content
                            ? { ...node, metadata: { ...node.metadata, status: canceled ? NODE_STATUS_IDLE : NODE_STATUS_ERROR, errorDetails: canceled ? undefined : error instanceof Error ? error.message : "故事板生成失败" } }
                            : node,
                    ),
                );
                throw error;
            } finally {
                signal.removeEventListener("abort", abortGeneration);
                finishGenerationRequest(imageNode.id, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, startGenerationRequest],
    );

    const runAutomationVideo = useCallback(
        async (parentId: string, page: CanvasAutomationPage, settings: CanvasAutomationSettings, videoModel: string, sheets: CanvasAutomationCharacterSheet[], sceneSheets: CanvasAutomationSceneSheet[], signal: AbortSignal) => {
            const imageNode = nodesRef.current.find((node) => node.id === page.imageNodeId);
            const videoNode = nodesRef.current.find((node) => node.id === page.videoNodeId);
            if (!imageNode?.metadata?.content) throw new Error(`第 ${page.index + 1} 页漫画图不存在`);
            if (!videoNode) throw new Error(`第 ${page.index + 1} 页视频卡不存在`);
            const prompt = page.videoPrompt || "";
            if (!isRef2VAPrompt(prompt)) throw new Error(`第 ${page.index + 1} 页缺少 Ref2VA 多参提示词，请先重新生成提示词`);
            const speechSeconds = pageSpeechSeconds(page);
            if (speechSeconds > 25) throw new Error(`第 ${page.index + 1} 页台词约 ${Math.ceil(speechSeconds)} 秒，超过 25 秒硬上限；不会删改台词，请拆页后重试。`);
            const seconds = resolvePageVideoSeconds(page, settings);
            const videoConfig = {
                ...buildGenerationConfig(effectiveConfig, videoNode, "video"),
                model: videoModel,
                count: "1",
                size: settings.aspect,
                videoSeconds: seconds,
                vquality: settings.vquality,
                videoGenerateAudio: settings.generateAudio ? "true" : "false",
                videoMode: "reference" as const,
            };
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === videoNode.id
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                                  prompt,
                                  model: videoModel,
                                  size: settings.aspect,
                                  seconds,
                                  vquality: settings.vquality,
                                  generateAudio: settings.generateAudio ? "true" : "false",
                                  videoMode: "reference",
                                  frameMode: undefined,
                              },
                          }
                        : node,
                ),
            );
            const controller = startGenerationRequest(videoNode.id, parentId, videoNode.id);
            const abortGeneration = () => controller.abort("user-stop");
            if (signal.aborted) abortGeneration();
            else signal.addEventListener("abort", abortGeneration, { once: true });
            const videoTimeout = window.setTimeout(() => controller.abort("user-stop"), 10 * 60_000);
            try {
                const dataUrl = await imageToDataUrl({ url: imageNode.metadata.content, storageKey: imageNode.metadata.storageKey });
                if (!dataUrl) throw new Error("无法读取漫画图作为多参故事板");
                const manifest = buildAutomationVideoReference(page, sheets, sceneSheets);
                const references: ReferenceImage[] = [];
                for (const reference of manifest.characters) {
                    const sheetNode = nodesRef.current.find((node) => node.id === reference.nodeId);
                    if (!sheetNode?.metadata?.content) throw new Error(`第 ${page.index + 1} 页角色参考图缺失：${reference.name}`);
                    const sheetDataUrl = await imageToDataUrl({ url: sheetNode.metadata.content, storageKey: sheetNode.metadata.storageKey });
                    if (!sheetDataUrl) throw new Error(`无法读取角色参考图：${reference.name}`);
                    references.push({
                        id: sheetNode.id,
                        name: `${reference.name}-四视图.png`,
                        type: sheetNode.metadata.mimeType || "image/png",
                        dataUrl: sheetDataUrl,
                        url: sheetDataUrl,
                        storageKey: sheetNode.metadata.storageKey,
                    });
                }
                if (manifest.scene) {
                    const sceneNode = nodesRef.current.find((node) => node.id === manifest.scene?.nodeId);
                    if (!sceneNode?.metadata?.content) throw new Error(`第 ${page.index + 1} 页场景参考图缺失：${manifest.scene.name}`);
                    const sceneDataUrl = await imageToDataUrl({ url: sceneNode.metadata.content, storageKey: sceneNode.metadata.storageKey });
                    if (!sceneDataUrl) throw new Error(`无法读取场景参考图：${manifest.scene.name}`);
                    references.push({
                        id: sceneNode.id,
                        name: `${manifest.scene.name}-场景.png`,
                        type: sceneNode.metadata.mimeType || "image/png",
                        dataUrl: sceneDataUrl,
                        url: sceneDataUrl,
                        storageKey: sceneNode.metadata.storageKey,
                    });
                }
                references.push({
                    id: imageNode.id,
                    name: `${page.title || `page-${page.index + 1}`}.png`,
                    type: imageNode.metadata.mimeType || "image/png",
                    dataUrl,
                    url: dataUrl,
                    storageKey: imageNode.metadata.storageKey,
                });
                await completeVideoNodeTask(videoNode.id, videoConfig, prompt, references, controller.signal, {
                    videoMode: "reference",
                    size: settings.aspect,
                    seconds,
                    vquality: settings.vquality,
                    model: videoModel,
                    generateAudio: settings.generateAudio ? "true" : "false",
                });
                // Keep the video card in its storyboard slot so rows stay aligned with the comic page.
                const slot = automationImageSize(settings.aspect);
                setNodes((prev) => prev.map((node) => (node.id === videoNode.id ? { ...node, width: slot.width, height: slot.height } : node)));
            } catch (error) {
                const canceled = isGenerationCanceled(error);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === videoNode.id && !node.metadata?.content
                            ? { ...node, metadata: { ...node.metadata, status: canceled ? NODE_STATUS_IDLE : NODE_STATUS_ERROR, errorDetails: canceled ? undefined : error instanceof Error ? error.message : "视频生成失败" } }
                            : node,
                    ),
                );
                throw error;
            } finally {
                window.clearTimeout(videoTimeout);
                signal.removeEventListener("abort", abortGeneration);
                finishGenerationRequest(videoNode.id, controller);
            }
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, startGenerationRequest],
    );

    const startAutomation = useCallback(
        async (parentId: string, input: CanvasAutomationStartInput) => {
            if (automationControllersRef.current.has(parentId)) return;
            const parent = nodesRef.current.find((node) => node.id === parentId);
            if (!parent || parent.type !== CanvasNodeType.Automation) return;
            const settings = input.settings;
            const controller = new AbortController();
            automationControllersRef.current.set(parentId, controller);
            setAutomationRunningIds((prev) => new Set(prev).add(parentId));
            const existing = parent.metadata?.automation;
            // 旧任务可能保存了未拆分的长事件；重跑时先按当前规则重新拆事件，避免一直复用同一个 16 秒页。
            let existingScript: CanvasAutomationScript | undefined;
            try {
                existingScript = existing?.script ? normalizeScript(existing.script) : undefined;
            } catch {
                existingScript = existing?.script;
            }
            const resumeCharacters = (existing?.characters || []).filter((character) => !isCrowdCharacterName(character.name)).slice(0, 4);
            const resumeCharacterIds = new Set(resumeCharacters.map((character) => character.id));
            const removedCharacter = (existing?.characters || []).some((character) => !resumeCharacterIds.has(character.id));
            const resumeSheets = (existing?.characterSheets || []).filter((sheet) => resumeCharacterIds.has(sheet.characterId));
            const resumePages = existing?.pages?.length
                ? existing.pages.map((page) => ({
                      ...page,
                      characters: (page.characters || []).filter((character) => resumeCharacterIds.has(character.id)),
                      panels: (page.panels || []).map((panel) => ({
                          ...panel,
                          characters: (panel.characters || []).filter((id) => resumeCharacterIds.has(id)),
                      })),
                  }))
                : [];
            let state: CanvasAutomationState = {
                template: "novel-comic-video",
                stage: resumePages.length ? "images" : "planning",
                sourceText: input.sourceText,
                sourceUrl: input.sourceUrl,
                settings,
                script: existingScript,
                scriptText: existingScript ? formatScriptForPlanning(existingScript) : existing?.scriptText,
                style: existing?.style,
                characters: resumeCharacters,
                characterSheets: resumeSheets,
                scenes: existing?.scenes,
                sceneSheets: existing?.sceneSheets,
                pages: resumePages,
                videoPromptVersion: removedCharacter ? 0 : existing?.videoPromptVersion,
                warnings: [],
                errors: [],
                startedAt: existing?.startedAt || Date.now(),
                updatedAt: Date.now(),
            };
            syncAutomation(parentId, state, NODE_STATUS_LOADING);
            try {
                const models = resolveAutomationModels(settings);
                const runText = async (messages: Parameters<typeof requestImageQuestion>[1], timeoutMs: number, label: string) => {
                    const request = new AbortController();
                    const forwardAbort = () => request.abort(controller.signal.reason);
                    if (controller.signal.aborted) forwardAbort();
                    else controller.signal.addEventListener("abort", forwardAbort, { once: true });
                    let timedOut = false;
                    const timer = window.setTimeout(() => {
                        timedOut = true;
                        request.abort("timeout");
                    }, timeoutMs);
                    try {
                        return await requestImageQuestion(models.textConfig, messages, () => undefined, { signal: request.signal });
                    } catch (error) {
                        if (timedOut && !controller.signal.aborted) throw new Error(`${label}超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已中止；请检查文本模型网络或降低分镜页数后重试。`);
                        throw error;
                    } finally {
                        window.clearTimeout(timer);
                        controller.signal.removeEventListener("abort", forwardAbort);
                    }
                };
                const overflowMessage = (pages: CanvasAutomationPage[], pageCount: number, resumed: boolean) =>
                    `第 ${pages.map((page) => `${page.index + 1}（约 ${Math.ceil(pageSpeechSeconds(page))} 秒）`).join("、")} 页台词超过 25 秒硬上限，不会删改台词。${
                        resumed ? "当前任务已有生成卡片，请新建自动化任务并提高分镜页数。" : `已尝试拆页到 ${pageCount} 页仍超出，请提高分镜页数或拆分正文后分多次任务生成。`
                    }`;
                if (!resumePages.length) {
                    let script: CanvasAutomationScript | undefined = state.script;
                    if (!script) {
                        state.stage = "script";
                        state.progress = "第 1 轮：改写剧本与剧情结构…";
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        const sourceChunks = splitAutomationSource(input.sourceText);
                        const adaptedParts: CanvasAutomationScript[] = [];
                        let adaptationError: unknown;
                        for (let chunkIndex = 0; chunkIndex < sourceChunks.length; chunkIndex += 1) {
                            const adaptationMessages = buildScriptAdaptationMessages(sourceChunks[chunkIndex]);
                            let part: CanvasAutomationScript | undefined;
                            for (let attempt = 0; attempt < 2; attempt += 1) {
                                try {
                                    const answer = await runText(adaptationMessages, 120000, `剧本改写（${chunkIndex + 1}/${sourceChunks.length}）`);
                                    part = normalizeScript(extractJson(answer));
                                    adaptationError = undefined;
                                    break;
                                } catch (error) {
                                    adaptationError = error;
                                    if (controller.signal.aborted) throw error;
                                    if (attempt === 1 || (error instanceof Error && error.message.includes("没有返回"))) break;
                                    console.info("剧本改写返回格式不正确，自动重试一次");
                                    adaptationMessages.push({ role: "user", content: "上一次没有返回可解析的 JSON。请严格按系统消息的结构只输出 JSON，不要解释、不要 markdown。" });
                                }
                            }
                            if (!part) {
                                adaptationError = new Error(`第 ${chunkIndex + 1} 段剧本改写失败`);
                                break;
                            }
                            adaptedParts.push(part);
                        }
                        if (adaptedParts.length && adaptedParts.length === sourceChunks.length) {
                            script = mergeAutomationScripts(adaptedParts);
                        }
                        if (!script) {
                            const detail = adaptationError instanceof Error ? adaptationError.message : "剧本改写失败";
                            state.warnings = [...(state.warnings || []), `剧本改写失败（${detail}），已直接用原文拆分`];
                            state.script = undefined;
                            state.scriptText = input.sourceText;
                            console.warn("剧本改写失败，已改用原文继续拆分");
                        } else {
                            state.script = script;
                            state.scriptText = formatScriptForPlanning(script);
                            const stats = scriptStats(script);
                            console.info(`剧本改写完成：${script.beats.length} 个事件，约 ${Math.ceil(stats.dialogueSeconds)} 秒台词`);
                        }
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    } else if (!state.scriptText) {
                        state.scriptText = script ? formatScriptForPlanning(script) : input.sourceText;
                    }
                    const planningSource = state.scriptText || (script ? formatScriptForPlanning(script) : input.sourceText);
                    state.stage = "planning";
                    state.progress = "正在拆分分镜…";
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    let planSettings = settings;
                    let parsed: ReturnType<typeof normalizeComicPlan> | null = null;
                    const planningBatches = script && planningSource.length > 60000
                        ? splitScriptIntoBatches(script, 50000).map((batchScript) => ({ source: formatScriptForPlanning(batchScript), script: batchScript }))
                        : [{ source: planningSource, script }];
                    if (planningBatches.length > 1) {
                        const batchPlans: ReturnType<typeof normalizeComicPlan>[] = [];
                        for (let batchIndex = 0; batchIndex < planningBatches.length; batchIndex += 1) {
                            const batch = planningBatches[batchIndex];
                            const batchSettings = { ...planSettings, pageCountAuto: true };
                            state.progress = `第 2 轮：设计分镜框架（${batchIndex + 1}/${planningBatches.length}）…`;
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                            let batchFramework: unknown;
                            try {
                                batchFramework = extractJson(await runText(buildComicFrameworkMessages(batch.source, batchSettings, batch.script), 120000, `分镜框架（${batchIndex + 1}/${planningBatches.length}）`));
                            } catch (error) {
                                if (controller.signal.aborted) throw error;
                                batchFramework = undefined;
                                console.warn(`第 ${batchIndex + 1} 批分镜框架失败，继续下一批`);
                            }
                            state.progress = `第 3 轮：补全分镜细节（${batchIndex + 1}/${planningBatches.length}）…`;
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                            let raw: unknown = batchFramework;
                            try {
                                raw = extractJson(await runText(buildNovelToComicMessages(batch.source, batchSettings, batch.script, false, [], batchFramework), 180000, `分镜细节（${batchIndex + 1}/${planningBatches.length}）`));
                            } catch (error) {
                                if (controller.signal.aborted) throw error;
                                if (!batchFramework) {
                                    console.warn(`第 ${batchIndex + 1} 批分镜细节失败，跳过`);
                                    continue;
                                }
                                console.warn(`第 ${batchIndex + 1} 批细节失败，使用框架保底`);
                            }
                            let batchPlan: ReturnType<typeof normalizeComicPlan>;
                            try {
                                batchPlan = normalizeComicPlan(raw, batchSettings);
                            } catch (error) {
                                if (!batchFramework) {
                                    console.warn(`第 ${batchIndex + 1} 批分镜无法解析，跳过`);
                                    continue;
                                }
                                batchPlan = normalizeComicPlan(batchFramework, batchSettings);
                            }
                            batchPlans.push(applyComicFrameworkHints(batchPlan, batchFramework));
                        }
                        if (!batchPlans.length) throw new Error("长剧本分批分镜失败");
                        parsed = mergeComicPlans(batchPlans, planSettings);
                        state.progress = "第 4 轮：查错…";
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        const review = reviewComicPlan(parsed, planSettings, script);
                        const freshWarnings = review.warnings.filter((warning) => !(state.warnings || []).includes(warning));
                        if (freshWarnings.length) state.warnings = [...(state.warnings || []), ...freshWarnings];
                    } else {
                    let strictEvents = false;
                    let reviewRetried = false;
                    let overlongPages: number[] = [];
                    let framework: unknown;
                    for (let attempt = 0; attempt < 2; attempt += 1) {
                        if (!framework) {
                            state.progress = `第 2 轮：设计分镜框架（第 ${attempt + 1} 次）…`;
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                            try {
                                const frameworkAnswer = await runText(buildComicFrameworkMessages(planningSource, planSettings, script, strictEvents, overlongPages), 120000, `分镜框架（第 ${attempt + 1} 次）`);
                                framework = extractJson(frameworkAnswer);
                            } catch (error) {
                                if (controller.signal.aborted) throw error;
                                framework = undefined;
                                state.warnings = [...(state.warnings || []), `第 2 轮分镜框架失败，已回退到一次性分镜：${error instanceof Error ? error.message : "未知错误"}`];
                                console.warn("分镜框架生成失败，回退到一次性分镜");
                                syncAutomation(parentId, state, NODE_STATUS_LOADING);
                            }
                        }
                        if (framework) {
                            state.progress = `第 3 轮：补全分镜细节（第 ${attempt + 1} 次）…`;
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        }
                        let answer: string;
                        try {
                            answer = await runText(buildNovelToComicMessages(planningSource, planSettings, script, strictEvents, overlongPages, framework), 180000, `分镜细节（第 ${attempt + 1} 次）`);
                        } catch (error) {
                            if (controller.signal.aborted) throw error;
                            if (parsed) {
                                state.warnings = [...(state.warnings || []), `分镜第 ${attempt + 1} 次请求失败，沿用上一版分镜`];
                                break;
                            }
                            throw error;
                        }
                        try {
                            parsed = normalizeComicPlan(extractJson(answer), planSettings);
                        } catch (error) {
                            if (!framework) throw error;
                            parsed = normalizeComicPlan(framework, planSettings);
                            state.warnings = [...(state.warnings || []), `第 3 轮细节返回不完整，已用第 2 轮框架保底：${error instanceof Error ? error.message : "未知错误"}`];
                        }
                        parsed = applyComicFrameworkHints(parsed, framework);
                        state.progress = "第 4 轮：查错…";
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        const review = reviewComicPlan(parsed, planSettings, script, framework);
                        const freshWarnings = review.warnings.filter((warning) => !(state.warnings || []).includes(warning));
                        if (freshWarnings.length) state.warnings = [...(state.warnings || []), ...freshWarnings];
                        const duplicates = duplicatePageEvents(parsed.pages);
                        const missing = script ? missingPageEvents(parsed.pages, script) : [];
                        const overlong = parsed.pages.filter((page) => pageSpeechSeconds(page) > 25).map((page) => page.index);
                        if ((review.needsRetry || duplicates.length || missing.length || overlong.length) && !reviewRetried) {
                            reviewRetried = true;
                            strictEvents = true;
                            overlongPages = overlong;
                            framework = undefined;
                            console.info("第 4 轮查错发现问题，正在重做一次框架和细节");
                            continue;
                        }
                        if (duplicates.length) state.warnings = [...(state.warnings || []), `分镜页重复了事件：${duplicates.join("、")}，已继续生成`];
                        if (missing.length) state.warnings = [...(state.warnings || []), `分镜漏掉事件：${missing.join("、")}`];
                        break;
                    }
                    }
                    if (!parsed) throw new Error("模型没有返回分镜页");
                    state = { ...state, settings: planSettings, style: parsed.style, styleNegative: parsed.styleNegative, characters: parsed.characters, scenes: parsed.scenes, pages: parsed.pages, stage: "images", progress: undefined, updatedAt: Date.now() };
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                } else {
                    state.pages = resumePages.map(sanitizePageDialogue);
                }
                const characters = state.characters || [];
                state.pages = (state.pages || []).map((page) => {
                    const cleaned = sanitizePageDialogue(page);
                    if (cleaned.grid && cleaned.panels?.length) {
                        cleaned.layout = buildGridMoss({
                            style: cleaned.style || state.style || settings.style,
                            styleLock: cleaned.styleLock,
                            styleNegative: cleaned.styleNegative,
                            characters: cleaned.characters || [],
                            panels: cleaned.panels,
                            grid: cleaned.grid,
                            aspect: settings.aspect,
                            storyboard: settings.storyboardWhiteModel !== false,
                        });
                    }
                    return cleaned;
                });
                if (settings.generateCharacterSheets !== false && characters.length) {
                    state.stage = "characters";
                    state.progress = "正在生成角色四视图…";
                    state.characterSheets = await createAutomationCharacterSheets(parent, characters, state.characterSheets || [], settings, models.mossModel);
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    await waitAutomationRender();
                    for (const sheet of state.characterSheets) {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const node = nodesRef.current.find((item) => item.id === sheet.nodeId);
                        if (sheet.state === "done" && node?.metadata?.content) continue;
                        const character = characters.find((item) => item.id === sheet.characterId);
                        if (!character) continue;
                        sheet.state = "loading";
                        sheet.error = undefined;
                        state.progress = `生成角色四视图：${character.name}`;
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        try {
                            await runAutomationCharacterSheet(parentId, character, sheet, settings, models.mossModel, controller.signal);
                            sheet.state = "done";
                        } catch (error) {
                            if (controller.signal.aborted) throw error;
                            sheet.state = "error";
                            sheet.error = error instanceof Error ? error.message : "角色四视图生成失败";
                            state.warnings = [...(state.warnings || []), `角色 ${character.name}：${sheet.error}（已跳过）`];
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        }
                        state.updatedAt = Date.now();
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    }
                }
                const scenes = state.scenes?.length ? state.scenes : collectAutomationScenes(state.pages || []);
                state.scenes = scenes;
                state.progress = undefined;
                if (settings.generateSceneSheets !== false && scenes.length) {
                    state.stage = "scenes";
                    state.progress = "正在生成场景图…";
                    state.sceneSheets = await createAutomationSceneSheets(parent, scenes, state.sceneSheets || [], settings, models.mossModel, state.characterSheets?.length || 0);
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    await waitAutomationRender();
                    for (const sheet of state.sceneSheets) {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const node = nodesRef.current.find((item) => item.id === sheet.nodeId);
                        if (sheet.state === "done" && node?.metadata?.content) continue;
                        const scene = scenes.find((item) => item.id === sheet.sceneId);
                        if (!scene) continue;
                        sheet.state = "loading";
                        sheet.error = undefined;
                        state.progress = `生成场景图：${scene.name}`;
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        try {
                            await runAutomationSceneSheet(parentId, scene, sheet, settings, models.mossModel, controller.signal);
                            sheet.state = "done";
                        } catch (error) {
                            if (controller.signal.aborted) throw error;
                            sheet.state = "error";
                            sheet.error = error instanceof Error ? error.message : "场景图生成失败";
                            state.warnings = [...(state.warnings || []), `场景 ${scene.name}：${sheet.error}（已跳过）`];
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        }
                        state.updatedAt = Date.now();
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    }
                }
                if (settings.generateCharacterSheets !== false) {
                    const missing = (state.pages || []).flatMap((page) => buildAutomationVideoReference(page, state.characterSheets || []).missing.map((name) => `第 ${page.index + 1} 页 ${name}`));
                    if (missing.length) state.warnings = [...(state.warnings || []), `多参视频缺少角色参考图：${missing.slice(0, 8).join("、")}（已跳过缺失参考，继续生成）`];
                }
                const sheetColumnOffset = (settings.generateCharacterSheets !== false && (state.characterSheets?.length || 0) > 0) || (settings.generateSceneSheets !== false && (state.sceneSheets?.length || 0) > 0) ? 320 + 120 : 0;
                state.pages = await createAutomationChildren(parent, state.pages || [], settings, models.storyboardModel, sheetColumnOffset);
                const textPages = new Map(state.pages.filter((page) => page.textNodeId).map((page) => [page.textNodeId, page]));
                const imagePages = new Map(state.pages.filter((page) => page.imageNodeId).map((page) => [page.imageNodeId, page]));
                setNodes((prev) =>
                    prev.map((node) => {
                        const textPage = textPages.get(node.id);
                        if (textPage) return { ...node, metadata: { ...node.metadata, content: formatPageCard(textPage), prompt: textPage.layout.summary } };
                        const imagePage = imagePages.get(node.id);
                        if (imagePage) return { ...node, metadata: { ...node.metadata, layout: imagePage.layout, prompt: imagePage.layout.summary } };
                        return node;
                    }),
                );
                syncAutomation(parentId, state, NODE_STATUS_LOADING);
                await waitAutomationRender();
                state.stage = "images";
                syncAutomation(parentId, state, NODE_STATUS_LOADING);
                for (const page of state.pages) {
                    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                    const imageNode = nodesRef.current.find((node) => node.id === page.imageNodeId);
                    if (page.imageState === "done" && imageNode?.metadata?.content) continue;
                    page.imageState = "loading";
                    page.error = undefined;
                    state.progress = `生成漫画：第 ${page.index + 1}/${state.pages.length} 页`;
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    try {
                        await runAutomationImage(parentId, page, settings, models.storyboardModel, controller.signal);
                        page.imageState = "done";
                    } catch (error) {
                        if (controller.signal.aborted) throw error;
                        page.imageState = "error";
                        page.error = error instanceof Error ? error.message : "漫画生成失败";
                        state.warnings = [...(state.warnings || []), `第 ${page.index + 1} 页漫画：${page.error}（已跳过）`];
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    }
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                }
                state.progress = undefined;
                const expandedPages: CanvasAutomationPage[] = [];
                for (const page of state.pages) {
                    if (pageSpeechSeconds(page) <= 25) {
                        expandedPages.push(page);
                        continue;
                    }
                    const drafts = splitPageVideoSegments(page, settings.grid, 25);
                    if (!drafts.length) {
                        state.warnings = [...(state.warnings || []), `第 ${page.index + 1} 页超过 25 秒且无法按镜头拆分视频段，将保留单段`];
                        expandedPages.push(page);
                        continue;
                    }
                    drafts.forEach((draft, segmentIndex) => {
                        expandedPages.push({
                            ...page,
                            index: 0,
                            title: `${page.title} · 视频段 ${segmentIndex + 1}/${drafts.length}`,
                            videoTitle: `第 ${page.index + 1} 页 · 视频段 ${segmentIndex + 1}/${drafts.length}`,
                            panels: draft.panels,
                            dialogue: draft.dialogue,
                            shotGroups: draft.shotGroups,
                            videoSeconds: draft.seconds,
                            panelRange: draft.panelRange,
                            segmentIndex,
                            segmentCount: drafts.length,
                            videoPrompt: undefined,
                            videoPromptVersion: 0,
                            videoNodeId: undefined,
                            videoSegments: undefined,
                            textNodeId: undefined,
                            imageState: "done",
                            videoState: "pending",
                            error: undefined,
                        });
                    });
                    console.info(`第 ${page.index + 1} 页超过 25 秒，已拆成 ${drafts.length} 个视频段共用同一张故事板`);
                }
                if (expandedPages.some((page) => page.segmentCount)) {
                    state.pages = expandedPages.map((page, index) => ({ ...page, index }));
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    await waitAutomationRender();
                }
                const pendingPages = state.pages.filter((page) => !page.videoPrompt || !isRef2VAPrompt(page.videoPrompt) || (page.videoPromptVersion || state.videoPromptVersion || 0) < AUTOMATION_VIDEO_PROMPT_VERSION);
                if (pendingPages.length) {
                    state.stage = "videoPrompts";
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    let promptReasons: Record<number, string> = {};
                    const promptError = (indices: number[]) => {
                        const detail = [...new Set(indices.map((index) => promptReasons[index]).filter(Boolean))].join("；");
                        return `H3 视频提示词生成失败：第 ${indices.map((index) => index + 1).join("、")} 页${detail ? `（${detail}）` : ""}`;
                    };
                    const applyPromptResult = (normalized: ReturnType<typeof normalizeVideoPrompts>) => {
                        normalized.pages.forEach((page) => {
                            const target = state.pages?.find((item) => item.index === page.index);
                            if (target && page.videoPrompt) {
                                target.videoPrompt = page.videoPrompt;
                                target.videoPromptVersion = AUTOMATION_VIDEO_PROMPT_VERSION;
                            }
                        });
                        promptReasons = { ...promptReasons, ...normalized.reasons };
                        const freshWarnings = normalized.warnings.filter((warning) => !(state.warnings || []).includes(warning));
                        if (freshWarnings.length) state.warnings = [...(state.warnings || []), ...freshWarnings];
                        return normalized.failed;
                    };
                    const generatePromptBatch = async (batch: CanvasAutomationPage[], strictCamera: boolean, timeoutMs: number) => {
                        const label = `第 ${batch[0].index + 1}–${batch[batch.length - 1].index + 1} 页 H3 提示词`;
                        const answer = await runText(buildComicToVideoMessages(batch, state.style || settings.style, settings, state.characterSheets || [], state.sceneSheets || [], strictCamera), timeoutMs, label);
                        let raw: unknown = { pages: [] };
                        try {
                            raw = extractJson(answer);
                        } catch (error) {
                            state.warnings = [...(state.warnings || []), `${label} JSON 解析失败，已使用保底提示词`];
                        }
                        return applyPromptResult(normalizeVideoPrompts(raw, batch, state.characterSheets || [], state.sceneSheets || []));
                    };
                    const generatePromptChunk = async (batch: CanvasAutomationPage[], strictCamera = false): Promise<number[]> => {
                        try {
                            let failed = await generatePromptBatch(batch, strictCamera, batch.length > 1 ? 180000 : 90000);
                            if (failed.length) {
                                if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                                const retryPages = (state.pages || []).filter((page) => failed.includes(page.index));
                                failed = await generatePromptBatch(retryPages, strictCamera, 90000);
                            }
                            return failed;
                        } catch (error) {
                            if (controller.signal.aborted) throw error;
                            if (batch.length <= 1) {
                                console.warn(`第 ${batch[0].index + 1} 页提示词请求失败，使用保底提示词`);
                                return applyPromptResult(normalizeVideoPrompts({ pages: [] }, batch, state.characterSheets || [], state.sceneSheets || []));
                            }
                            const mid = Math.ceil(batch.length / 2);
                            console.warn(`第 ${batch[0].index + 1}–${batch[batch.length - 1].index + 1} 页提示词批次失败，拆成小批重试`);
                            const left = await generatePromptChunk(batch.slice(0, mid), strictCamera);
                            const right = await generatePromptChunk(batch.slice(mid), strictCamera);
                            return [...left, ...right];
                        }
                    };
                    const chunkSize = 3;
                    const chunks: CanvasAutomationPage[][] = [];
                    for (let start = 0; start < pendingPages.length; start += chunkSize) chunks.push(pendingPages.slice(start, start + chunkSize));
                    let failed: number[] = [];
                    for (let index = 0; index < chunks.length; index += 1) {
                        const batch = chunks[index];
                        state.progress = `生成 H3 提示词：第 ${batch[0].index + 1}–${batch[batch.length - 1].index + 1} 页（${index + 1}/${chunks.length} 批）`;
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                        failed = [...failed, ...await generatePromptChunk(batch)];
                        state.updatedAt = Date.now();
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    }
                    if (failed.length) state.warnings = [...(state.warnings || []), promptError(failed)];
                    const promptPages = pendingPages.filter((page) => page.videoPrompt);
                    const movingPages = promptPages.filter((page) => cameraMoveCount(page.videoPrompt || "") > 0).length;
                    if (movingPages > Math.max(1, Math.ceil(promptPages.length / 2))) {
                        console.info(`运镜页 ${movingPages}/${promptPages.length} 偏多，按短剧切镜头重写一次`);
                        for (let start = 0; start < promptPages.length; start += chunkSize) {
                            const batch = promptPages.slice(start, start + chunkSize);
                            state.progress = `重写镜头：第 ${batch[0].index + 1}–${batch[batch.length - 1].index + 1} 页`;
                            syncAutomation(parentId, state, NODE_STATUS_LOADING);
                            failed = await generatePromptChunk(batch, true);
                            if (failed.length) state.warnings = [...(state.warnings || []), promptError(failed)];
                        }
                        const stillMoving = pendingPages.filter((page) => page.videoPrompt && cameraMoveCount(page.videoPrompt) > 0).length;
                        if (stillMoving > Math.max(1, Math.ceil(pendingPages.length / 2))) {
                            state.warnings = [...(state.warnings || []), `运镜页仍偏多：${stillMoving}/${pendingPages.length}，已按切镜头重写一次`];
                        }
                    }
                    state.videoPromptVersion = AUTOMATION_VIDEO_PROMPT_VERSION;
                    state.progress = undefined;
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                }
                state.pages = await createAutomationVideoNodes(parent, state.pages, settings, models.videoModel, state.characterSheets || [], state.sceneSheets || []);
                state.stage = "videos";
                syncAutomation(parentId, state, NODE_STATUS_LOADING);
                await waitAutomationRender();
                for (const page of state.pages) {
                    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                    const videoNode = nodesRef.current.find((node) => node.id === page.videoNodeId);
                    if (page.videoState === "done" && videoNode?.metadata?.content) continue;
                    page.videoState = "loading";
                    page.error = undefined;
                    state.progress = `生成视频：第 ${page.index + 1}/${state.pages.length} 页`;
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    try {
                        await runAutomationVideo(parentId, page, settings, models.videoModel, state.characterSheets || [], state.sceneSheets || [], controller.signal);
                        page.videoState = "done";
                    } catch (error) {
                        if (controller.signal.aborted) throw error;
                        page.videoState = "error";
                        page.error = error instanceof Error ? error.message : "视频生成失败";
                        state.warnings = [...(state.warnings || []), `第 ${page.index + 1} 页视频：${page.error}（已跳过）`];
                        syncAutomation(parentId, state, NODE_STATUS_LOADING);
                    }
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_LOADING);
                }
                state.stage = "done";
                state.progress = undefined;
                state.finishedAt = Date.now();
                state.updatedAt = Date.now();
                const failedPages = (state.pages || []).filter((page) => page.imageState === "error" || page.videoState === "error");
                const failedSheets = [...(state.characterSheets || []), ...(state.sceneSheets || [])].filter((sheet) => sheet.state === "error");
                const unfinished = failedPages.length + failedSheets.length;
                if (unfinished) {
                    state.warnings = [...(state.warnings || []), `有 ${unfinished} 项未完成，可点“重试失败页”继续`];
                    console.warn(`任务已跑完，但有 ${unfinished} 项未完成`);
                } else {
                    console.info(t("canvas.automation.stage.done"));
                }
                syncAutomation(parentId, state, NODE_STATUS_SUCCESS);
            } catch (error) {
                state.progress = undefined;
                if (controller.signal.aborted) {
                    state.stage = "stopped";
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_IDLE);
                    message.info(t("canvas.automation.stage.stopped"));
                } else {
                    state.stage = "error";
                    const detail = error instanceof Error ? error.message : "自动化失败";
                    state.errors = [...(state.errors || []), detail];
                    state.updatedAt = Date.now();
                    syncAutomation(parentId, state, NODE_STATUS_ERROR, detail);
                    message.error(detail);
                }
            } finally {
                automationControllersRef.current.delete(parentId);
                setAutomationRunningIds((prev) => {
                    const next = new Set(prev);
                    next.delete(parentId);
                    return next;
                });
            }
        },
        [createAutomationCharacterSheets, createAutomationChildren, createAutomationVideoNodes, message, resolveAutomationModels, runAutomationCharacterSheet, runAutomationImage, runAutomationVideo, syncAutomation, t, waitAutomationRender],
    );

    const stopAutomation = useCallback((parentId: string) => {
        automationControllersRef.current.get(parentId)?.abort("user-stop");
    }, []);

    const retryAutomation = useCallback(
        async (parentId: string) => {
            const parent = nodesRef.current.find((node) => node.id === parentId);
            const current = parent?.metadata?.automation;
            if (!current || !parent) return;
            if (current.pages?.length || current.characterSheets?.length || current.sceneSheets?.length) {
                const pages = (current.pages || []).map((page) => ({
                    ...page,
                    imageState: page.imageState === "error" ? ("pending" as const) : page.imageState,
                    videoState: page.videoState === "error" ? ("pending" as const) : page.videoState,
                    error: undefined,
                }));
                const characterSheets = (current.characterSheets || []).map((sheet) => ({
                    ...sheet,
                    state: sheet.state === "error" ? ("pending" as const) : sheet.state,
                    error: undefined,
                }));
                const sceneSheets = (current.sceneSheets || []).map((sheet) => ({
                    ...sheet,
                    state: sheet.state === "error" ? ("pending" as const) : sheet.state,
                    error: undefined,
                }));
                setNodes((prev) => prev.map((node) => (node.id === parentId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined, automation: { ...current, pages, characterSheets, sceneSheets, errors: [] } } } : node)));
                await waitAutomationRender();
            }
            await startAutomation(parentId, { sourceText: current.sourceText, sourceUrl: current.sourceUrl, settings: current.settings });
        },
        [startAutomation, waitAutomationRender],
    );

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            lastPanelNodeIdRef.current = panelNode.id;
            return getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Automation ? (
                <CanvasAutomationPanel
                    node={panelNode}
                    isRunning={automationRunningIds.has(panelNode.id)}
                    onChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                    onStart={(input) => void startAutomation(panelNode.id, input)}
                    onStop={() => stopAutomation(panelNode.id)}
                    onRetry={() => void retryAutomation(panelNode.id)}
                />
            ) : panelNode.type === CanvasNodeType.FreeCard ? (
                <CanvasFreeCardShellPanel
                    node={panelNode}
                    nodes={nodes}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    isRunning={hasActiveGeneration(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    onChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                    onConfigChange={handleConfigNodeChange}
                    onPromptChange={handleNodePromptChange}
                    onGenerate={(nodeId, prompt) => void generateFreeCard(nodeId, prompt)}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                />
            ) : panelNode.type === CanvasNodeType.Config ? (
                CONFIG_COMPOSER_ENABLED ? (
                    <CanvasConfigComposer
                        nodeId={panelNode.id}
                        nodes={nodes}
                        value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                        inputs={configInputsById.get(panelNode.id) || []}
                        connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                        onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                        onClose={() => setDialogNodeId(null)}
                        onDisconnectReference={disconnectNodeReference}
                        onStartReferenceSelection={startNodeReferenceSelection}
                    />
                ) : null
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    nodes={nodes}
                    isRunning={hasActiveGeneration(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onVigglePrepare={handleVigglePrepare}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    onOpenMaskEditor={(nodeId, sourceUrl) => { setMaskEditSourceUrl(sourceUrl || null); setMaskEditNodeId(nodeId); }}
                    onOpenOutpaintEditor={(nodeId) => setOutpaintNodeId(nodeId)}
                    onOpenMossLayoutEditor={(nodeId) => setMossLayoutNodeId(nodeId)}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            );
        },
        [automationRunningIds, configInputsById, confirmStopGeneration, connectedNodesByNodeId, disconnectNodeReference, effectiveConfig, generateFreeCard, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, hasActiveGeneration, mentionReferencesByNodeId, nodes, renderPluginPanel, retryAutomation, startAutomation, startNodeReferenceSelection, stopAutomation],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) =>
            contentNode.type === CanvasNodeType.Drama ? (
                <ShortDramaCard
                    node={contentNode}
                    onChange={(patch) => handleConfigNodeChange(contentNode.id, patch)}
                    onStartCreation={async (episodeId) => {
                        clearDramaPause(contentNode);
                        try {
                            await startDramaCreation(contentNode, episodeId);
                        } finally {
                            updateDramaCardProgress(setNodes, contentNode.id, null, 0, 0);
                        }
                    }}
                    onGenerateStoryboard={async (episodeId, options) => {
                        clearDramaPause(contentNode);
                        try {
                            await generateDramaStoryboards(contentNode, episodeId, options);
                        } finally {
                            updateDramaCardProgress(setNodes, contentNode.id, null, 0, 0);
                        }
                    }}
                    onPauseCreation={() => pauseDramaCreation(contentNode)}
                    onFocusAsset={(nodeId) => focusNode(nodeId)}
                    onAddStage={(characterName, stageName, description) => addDramaStage(contentNode, characterName, stageName, description)}
                    onSetSceneRefMode={(name, mode) => setDramaSceneRefMode(contentNode, name, mode)}
                />
            ) : (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={hasActiveGeneration(contentNode.id)}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                connectedAudioNames={connectedAudioNamesOf(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onOpenMaskEditor={(nodeId) => { setMaskEditSourceUrl(null); setMaskEditNodeId(nodeId); }}
                onOpenOutpaintEditor={(nodeId) => setOutpaintNodeId(nodeId)}
                onOpenMossLayoutEditor={(nodeId) => setMossLayoutNodeId(nodeId)}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId, prompt) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", prompt ?? target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
            ),
        [addDramaStage, clearDramaPause, configInputsById, confirmStopGeneration, focusNode, generateDramaStoryboards, handleConfigNodeChange, handleGenerateNode, hasActiveGeneration, pauseDramaCreation, setDramaSceneRefMode, setNodes, startDramaCreation],
    );

    const hoverPreviewNode = hoverPreviewNodeId ? nodeById.get(hoverPreviewNodeId) || null : null;
    const hoverImages = hoverPreviewNode?.metadata?.images || [];
    const hoverPrimaryImage = hoverImages.find((image) => image.id === hoverPreviewNode?.metadata?.primaryImageId) || hoverImages[0];
    const hoverImage = (hoverPreviewImageId ? hoverImages.find((image) => image.id === hoverPreviewImageId) : undefined) || hoverPrimaryImage;
    const hoverImageIndex = hoverImage ? hoverImages.findIndex((image) => image.id === hoverImage.id) + 1 : 0;
    const hoverImageTitle = hoverPreviewNode && hoverImages.length > 1 && hoverImageIndex
        ? `${hoverPreviewNode.title || t("assets.kinds.image")} · ${hoverImageIndex}/${hoverImages.length}`
        : hoverPreviewNode?.title || "";
    const hoverPreviewMedia =
        hoverPreviewNode && (hoverPreviewNode.type === CanvasNodeType.Image || hoverPreviewNode.type === CanvasNodeType.Video) && (hoverImage?.content || hoverPreviewNode.metadata?.content)
            ? {
                  video: hoverPreviewNode.type === CanvasNodeType.Video,
                  src: hoverImage?.content || hoverPreviewNode.metadata!.content!,
                  width: hoverImage?.naturalWidth || hoverPreviewNode.metadata?.naturalWidth || hoverPreviewNode.width,
                  height: hoverImage?.naturalHeight || hoverPreviewNode.metadata?.naturalHeight || hoverPreviewNode.height,
                  title: hoverImageTitle,
              }
            : null;
    const showHoverPreview = Boolean(hoverPreviewMedia);
    const retainedPreviewRef = useRef<{ video: boolean; src: string; title: string; width: number; height: number } | null>(null);
    // Written during render on purpose: the overlay stays mounted while it fades out, so the last preview has to be
    // retained after the hovered node clears. Sizing reuses the measured container size instead of reading layout here.
    if (hoverPreviewMedia) {
        const previewSize = fitNodeSize(hoverPreviewMedia.width, hoverPreviewMedia.height, size.width * 0.9, size.height * 0.9);
        retainedPreviewRef.current = { video: hoverPreviewMedia.video, src: hoverPreviewMedia.src, title: hoverPreviewMedia.title, width: previewSize.width, height: previewSize.height };
    }
    const retainedPreview = retainedPreviewRef.current;

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onPreviewImage={handleSidebarPreviewImage} onHoverNode={handleSidebarHoverNode} onHoverImage={handleSidebarHoverImage} onInsertAsset={handleAssetInsert} onAddFreeCard={addFreeCardFromLibrary} onApplyStyleRecipe={applyStyleRecipe} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={exportCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onOpenPlugins={() => setPluginManagerOpen(true)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    agentOpen={agentPanelOpen}
                    compactAgentStatus={{ connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity }}
                    onToggleAgent={toggleAgentPanel}
                />

                <CanvasGenerationTimer startedAt={generationStartedAt} />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={(event) => {
                        if (!referencePickerNodeId) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={referencePickerNodeId ? undefined : deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        if (referencePickerNodeId) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnections.map(({ connection, from, to }) => (
                            <ConnectionPath
                                key={connection.id}
                                connection={connection}
                                from={from}
                                to={to}
                                active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                onSelect={() => {
                                    setSelectedConnectionId(connection.id);
                                    setSelectedNodeIds(new Set());
                                    setContextMenu(null);
                                }}
                                onContextMenu={(event) => {
                                    setSelectedConnectionId(connection.id);
                                    setSelectedNodeIds(new Set());
                                    setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                }}
                            />
                        ))}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            referenceSelectionState={!referencePickerNodeId ? undefined : node.id === referencePickerNodeId ? "target" : referenceConnectedNodeIds.has(node.id) || !isCanvasReferenceNode(node, nodes) ? "disabled" : "available"}
                            showPanel={!isNodeResizing && dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            generationStartedAt={typeof node.metadata?.generationStartedAt === "number" ? node.metadata.generationStartedAt : null}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedBatchNodeIds.has(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onVideoDimensions={handleVideoDimensions}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onViewImage={handleNodeViewImage}
                            onSelectReference={selectNodeReference}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} scale={viewport.k} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            scale={viewport.k}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                {referencePickerNodeId ? <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitNodeReferenceSelection}>{t("canvas.references.selectingHint")}</button> : null}

                <div
                    className="pointer-events-none absolute inset-0 z-[80] flex items-center justify-center transition-opacity duration-200 ease-out"
                    style={{ background: `color-mix(in srgb, ${theme.canvas.background} 76%, transparent)`, opacity: showHoverPreview ? 1 : 0 }}
                >
                    <div
                        className="flex flex-col overflow-hidden rounded-2xl border transition-transform duration-200 ease-out"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, boxShadow: "0 24px 60px rgba(0,0,0,.32)", transform: showHoverPreview ? "scale(1)" : "scale(0.95)" }}
                    >
                        {retainedPreview ? (
                            <>
                                <div className="max-w-full truncate px-3.5 py-2 text-sm font-medium" style={{ color: theme.node.text }}>
                                    {retainedPreview.title || t(retainedPreview.video ? "assets.kinds.video" : "assets.kinds.image")}
                                </div>
                                <div className="overflow-hidden" style={{ width: retainedPreview.width, height: retainedPreview.height }}>
                                    {retainedPreview.video ? <video src={retainedPreview.src} muted playsInline preload="metadata" className="size-full object-contain" /> : <img src={retainedPreview.src} alt={retainedPreview.title} className="size-full object-contain" />}
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || Boolean(referencePickerNodeId) || expandedBatchNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onVideoUpscale={(node) => setVideoUpscaleNodeId(node.id)}
                    onVideoEdit={(node) => setVideoEditNodeId(node.id)}
                    onDraftVideo={(node) => void draftVideoNode(node)}
                    onInterpolateVideo={(node) => void interpolateVideoNode(node)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onSaveStyle={(node) => void stageNodeStyle(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onFourView={(node) => void fourViewImageNode(node)}
                    onTo3D={(node) => setTo3dChoiceNodeId(node.id)}
                    onSceneTo3D={(node) => sceneTo3DImageNode(node)}
                    onScene3D={(node) => scene3DImageNode(node)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                    onUngroup={(node) => ungroupSelection(new Set([node.id]))}
                />

                {hasMultipleSelectedNodes && !selectionBox ? (
                    <CanvasSelectionToolbar
                        nodes={selectedNodes}
                        viewport={viewport}
                        showToolbar={!isNodeDragging && !isNodeResizing}
                        canCompare={canCompareSelection}
                        canGroup={canGroupSelection}
                        canUngroup={canUngroupSelection}
                        canSyncPlay={selectedVideoNodes.length >= 2}
                        canBatchDownload={canBatchDownloadSelection}
                        canEdit={selectedVideoNodes.length >= 2}
                        onCompare={openImageCompare}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                        onSyncPlay={syncPlaySelectedVideos}
                        onBatchDownload={() => void downloadSelectedMedia()}
                        onEdit={() => setEditVideoNodes(selectedVideoNodes)}
                    />
                ) : null}

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    onFocusSelected={focusSelectedNode}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={addAudioCard}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddFreeCard={() => createNode(CanvasNodeType.FreeCard)}
                    onAddDrama={() => createNode(CanvasNodeType.Drama)}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />
                <CanvasOnboarding
                    open={onboardingOpen}
                    onClose={() => setOnboardingOpen(false)}
                    nodes={nodes}
                    imageModel={effectiveConfig.imageModel || effectiveConfig.model}
                    hasActiveGeneration={hasActiveGeneration}
                    onCreateImageNode={() => createNode(CanvasNodeType.Image)}
                />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        canGroup={contextMenu.type === "node" && canGroupSelection}
                        canUngroup={contextMenu.type === "node" && canUngroupSelection}
                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <Modal
                    open={Boolean(to3dChoiceNodeId)}
                    title={t("canvas.model3d.chooseTitle")}
                    onCancel={() => setTo3dChoiceNodeId(null)}
                    footer={null}
                    width={460}
                    centered
                >
                    <div className="flex flex-col gap-2">
                        {([
                            { kind: "object" as const, icon: <Box className="mt-0.5 size-5 shrink-0" />, title: t("canvas.model3d.chooseObject"), desc: t("canvas.model3d.chooseObjectDesc") },
                            { kind: "scene" as const, icon: <Mountain className="mt-0.5 size-5 shrink-0" />, title: t("canvas.model3d.chooseScene"), desc: t("canvas.model3d.chooseSceneDesc") },
                        ]).map((option) => (
                            <button
                                key={option.kind}
                                type="button"
                                className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition hover:opacity-80"
                                style={{ borderColor: "rgba(128,128,128,.28)" }}
                                onClick={() => {
                                    const node = to3dChoiceNodeId ? nodesRef.current.find((item) => item.id === to3dChoiceNodeId) : null;
                                    setTo3dChoiceNodeId(null);
                                    if (!node) return;
                                    if (option.kind === "scene") sceneTo3DImageNode(node);
                                    else to3DImageNode(node);
                                }}
                            >
                                {option.icon}
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium">{option.title}</span>
                                    <span className="mt-0.5 block text-xs opacity-60">{option.desc}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                    <p className="mt-3 text-xs opacity-50">{t("canvas.model3d.chooseAutoHint")}</p>
                </Modal>

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditSourceUrl || maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => { setMaskEditNodeId(null); setMaskEditSourceUrl(null); }} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                <CanvasSaveStyleModal open={Boolean(styleRecipeDraft)} draft={styleRecipeDraft} onClose={() => setStyleRecipeDraft(null)} />

                <Modal
                    open={Boolean(blockedStyleRecipe)}
                    title={t("canvas.styleRecipes.missingTitle")}
                    onCancel={() => setBlockedStyleRecipe(null)}
                    onOk={deleteBlockedStyleRecipe}
                    okText={t("canvas.styleRecipes.missingDelete")}
                    cancelText={t("common.cancel")}
                    okButtonProps={{ danger: true }}
                >
                    {blockedStyleRecipe ? (
                        <div className="space-y-3 text-sm">
                            <div>{t("canvas.styleRecipes.missingDescription", { name: blockedStyleRecipe.recipe.name })}</div>
                            {blockedStyleRecipe.missingModel ? (
                                <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700">
                                    <div className="text-xs opacity-45">{t("canvas.styleRecipes.missingModel")}</div>
                                    <div className="truncate" title={styleRecipeModelLabel(effectiveConfig, blockedStyleRecipe.recipe.config.model, blockedStyleRecipe.recipe.config.modelLabel)}>
                                        {styleRecipeModelLabel(effectiveConfig, blockedStyleRecipe.recipe.config.model, blockedStyleRecipe.recipe.config.modelLabel)}
                                    </div>
                                </div>
                            ) : null}
                            {blockedStyleRecipe.missingLoras.length ? (
                                <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700">
                                    <div className="text-xs opacity-45">{t("canvas.styleRecipes.missingLoras")}</div>
                                    <div className="space-y-1">
                                        {blockedStyleRecipe.missingLoras.map((name) => (
                                            <div key={name} className="truncate" title={name}>{name}</div>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </Modal>

                {outpaintNode?.metadata?.content ? (
                    <CanvasNodeOutpaintDialog
                        dataUrl={outpaintNode.metadata.content}
                        open={Boolean(outpaintNode)}
                        promptDefault={outpaintNode.metadata.composerContent ?? outpaintNode.metadata.prompt ?? ""}
                        onClose={() => setOutpaintNodeId(null)}
                        onConfirm={(payload) => void outpaintImageNode(outpaintNode!, payload)}
                    />
                ) : null}

                {mossLayoutNode ? (
                    <CanvasNodeMossLayoutDialog
                        open={Boolean(mossLayoutNode)}
                        dataUrl={mossLayoutNode.metadata?.content}
                        promptDefault={mossLayoutNode.metadata?.composerContent ?? mossLayoutNode.metadata?.prompt ?? ""}
                        size={mossLayoutNode.metadata?.size}
                        modelLabel="MOSS-Image"
                        layout={mossLayoutNode.metadata?.layout}
                        onClose={() => setMossLayoutNodeId(null)}
                        onConfirm={(payload) => void mossLayoutImageNode(mossLayoutNode, payload)}
                    />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeSuperResolveDialog
                        dataUrl={upscaleNode.metadata.content}
                        open={Boolean(upscaleNode)}
                        config={effectiveConfig}
                        preferredWorkflowId="image-esrgan-upscale"
                        title={t("canvas.superResolve.fastTitle")}
                        actionLabel={t("canvas.editors.upscale")}
                        note={t("canvas.superResolve.fastNote")}
                        onClose={() => setUpscaleNodeId(null)}
                        onConfirm={(params) => {
                            setUpscaleNodeId(null);
                            if (upscaleNode) void runFastUpscale(upscaleNode, params);
                        }}
                    />
                ) : null}

                <CanvasNodeSuperResolveDialog
                    dataUrl={superResolveNode?.metadata?.content || ""}
                    open={Boolean(superResolveNode)}
                    config={effectiveConfig}
                    onClose={() => setSuperResolveNodeId(null)}
                    onConfirm={(params) => {
                        setSuperResolveNodeId(null);
                        if (superResolveNode) void runSuperResolve(superResolveNode, params);
                    }}
                />

                <CanvasVideoEditPopup open={Boolean(videoEditNode)} node={videoEditNode} onClose={() => setVideoEditNodeId(null)} onGenerateVideo={handleVideoEditGenerate} />
                <CanvasNodeVideoUpscaleDialog
                    open={Boolean(videoUpscaleNode)}
                    node={videoUpscaleNode}
                    onClose={() => setVideoUpscaleNodeId(null)}
                    onConfirm={(params) => {
                        const target = videoUpscaleNode;
                        setVideoUpscaleNodeId(null);
                        if (target) void upscaleVideoNode(target, params);
                    }}
                />

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <CanvasImageCompareModal open={Boolean(compareNodeIds)} items={compareItems} onClose={() => setCompareNodeIds(null)} />
                <CanvasVideoEditModal open={editVideoNodes.length > 0} videos={editVideoNodes} onClose={() => setEditVideoNodes([])} />

                <Modal
                    title={previewNode?.type === CanvasNodeType.Video ? t("canvas.projectPage.videoDetails") : t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewContent)}
                    centered
                    onCancel={() => {
                        const video = previewVideoRef.current;
                        if (video) {
                            video.pause();
                            video.removeAttribute("src");
                            video.load();
                        }
                        pauseCanvasVideos();
                        setPreviewNodeId(null);
                        setPreviewImageId(null);
                    }}
                    destroyOnHidden
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewContent ? (
                        previewNode?.type === CanvasNodeType.Video ? (
                            <video
                                ref={previewVideoRef}
                                src={previewContent}
                                controls
                                autoPlay
                                playsInline
                                style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }}
                                data-testid="canvas-video-preview"
                            />
                        ) : (
                            <div style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", maxWidth: "100%", maxHeight: "80vh" }}>
                                <img src={previewContent} alt={previewNode?.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                                {canSwitchPreviewImage ? (
                                    <>
                                        <Button
                                            aria-label={t("canvas.projectPage.previousImage")}
                                            data-testid="canvas-image-preview-prev"
                                            disabled={previewImageIndex <= 0}
                                            onClick={() => goPreviewImage(-1)}
                                            style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: 999, zIndex: 2, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText, boxShadow: "0 6px 18px rgba(0,0,0,.2)" }}
                                        >
                                            <ChevronLeft className="size-5" />
                                        </Button>
                                        <Button
                                            aria-label={t("canvas.projectPage.nextImage")}
                                            data-testid="canvas-image-preview-next"
                                            disabled={previewImageIndex >= previewImages.length - 1}
                                            onClick={() => goPreviewImage(1)}
                                            style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", width: 36, height: 36, minWidth: 36, padding: 0, borderRadius: 999, zIndex: 2, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText, boxShadow: "0 6px 18px rgba(0,0,0,.2)" }}
                                        >
                                            <ChevronRight className="size-5" />
                                        </Button>
                                        <div
                                            data-testid="canvas-image-preview-index"
                                            style={{ position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)", zIndex: 2, padding: "4px 10px", borderRadius: 999, border: `1px solid ${theme.toolbar.border}`, background: theme.toolbar.panel, color: theme.toolbar.activeText, fontSize: 12, lineHeight: 1.2, pointerEvents: "none" }}
                                        >
                                            {previewImageIndex + 1}/{previewImages.length}
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        )
                    ) : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}

function connectedAudioNamesOf(inputs: NodeGenerationInput[]): string[] {
    return inputs
        .flatMap((input) => (input.type === "group" ? input.children : [input]))
        .map((resource) => resource.audio?.name || "");
}
