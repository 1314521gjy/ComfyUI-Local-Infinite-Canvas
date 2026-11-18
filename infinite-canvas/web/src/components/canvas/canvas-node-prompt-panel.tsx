import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowUp, ChevronDown, ChevronRight, LoaderCircle, Maximize2, Play, ScanText, Sparkles, Square, Upload, Wand2, Workflow, X } from "lucide-react";
import { Button, Dropdown, message, Modal, Select, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { BaseModelPicker, ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { type FreeCardWorkflowSectionProps } from "@/components/canvas/free-card-workflow-section";
import { channelModelOf, defaultConfig, modelImageInputs, modelOptionName, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { customWorkflowLocalId, customWorkflowView, findCustomWorkflow, isCustomWorkflowModel, rescanStaleCustomWorkflows, useCustomWorkflowStore } from "@/stores/use-custom-workflow-store";
import { requestLyricsOptimize } from "@/services/api/audio-pipeline";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { useCopyText } from "@/hooks/use-copy-text";
import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { AUDIO_EMOTIONS, AUDIO_GENRES, AUDIO_MODES, AUDIO_STYLE_PRESETS, DEFAULT_AUDIO_EMOTION, DEFAULT_AUDIO_GENRE, audioModeLabel, audioStylePresetOf, composeAudioStyle, normalizeAudioStyle, songLyricsDuration } from "@/lib/canvas/audio-options";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { captureVideoFrame } from "@/lib/canvas/canvas-video-frame";
import { CanvasNodeCropDialog } from "./canvas-node-crop-dialog";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { extractVideoFrames } from "@/lib/canvas/video-frames";
import { requestImageCaption, requestImagePromptOptimize, requestPromptOptimize, type ImageCaptionEngine, type PromptOptimizeMode } from "@/services/api/image";
import { videoModelModePatch, baseVideoWorkflowId, isMultiModeVideoWorkflow } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { PromptOptimizeOptions } from "./prompt-optimize-options";
import { abortCaptionJob, hasCaptionJob, registerCaptionJob, releaseCaptionJob } from "@/lib/canvas/caption-jobs";
import { abortPromptOptimizeJob, hasPromptOptimizeJob, registerPromptOptimizeJob, releasePromptOptimizeJob } from "@/lib/canvas/prompt-optimize-jobs";
import { usePromptCapabilities } from "@/hooks/use-prompt-capabilities";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onVigglePrepare?: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (nodeId: string, sourceUrl?: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
    freeCardWorkflow?: { name: string };
    freeCardWorkflowSection?: Omit<FreeCardWorkflowSectionProps, "onEdit">;
    hideMaskActions?: boolean;
};

export function CanvasNodePromptPanel({ node, nodes, isRunning, onPromptChange, onConfigChange, onGenerate, onVigglePrepare, onStop, mentionReferences = [], connectedNodes = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor, modeOverride, freeCardWorkflow, freeCardWorkflowSection, hideMaskActions }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const { capabilities, engineAvailable } = usePromptCapabilities();
    const theme = useCanvasTheme();
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const inheritedReferenceNodes = useMemo(() => {
        const references = node.metadata?.references || [];
        if (!references.length) return [];
        const keys = new Set(references);
        return nodes.filter((candidate) => {
            if (candidate.id === node.id) return false;
            const candidateKeys = [candidate.metadata?.storageKey, candidate.metadata?.content, ...(candidate.metadata?.images || []).flatMap((image) => [image.storageKey, image.content])].filter((key): key is string => Boolean(key));
            return candidateKeys.some((key) => keys.has(key));
        });
    }, [node.id, node.metadata?.references, nodes]);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [draft, setDraft] = useState(prompt);
    const draftRef = useRef(draft);
    const promptRef = useRef(prompt);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    draftRef.current = draft;
    promptRef.current = prompt;
    const [expanded, setExpanded] = useState(false);
    const [optimizeOptionsOpen, setOptimizeOptionsOpen] = useState(false);
    const [swapTargetFrameUrl, setSwapTargetFrameUrl] = useState("");
    const swapTargetFrameRef = useRef("");
    const lastAutoPromptRef = useRef("");
    const imageReferences = mentionReferences.filter((reference) => reference.kind === "image");
    const videoReferences = mentionReferences.filter((reference) => reference.kind === "video");
    const customWorkflow = useCustomWorkflowStore((state) => {
        const id = customWorkflowLocalId(config.model);
        return id ? state.workflows.find((workflow) => workflow.id === id) || null : null;
    });
    const customView = useMemo(() => (customWorkflow ? customWorkflowView(customWorkflow) : null), [customWorkflow]);
    const textKeyOf = (item: { node: string; input: string }) => `${item.node}\u0000${item.input}`;
    const textCandidates = customView?.textInputs || [];
    const textSelection = customView?.textSelection || [];
    const textNames = customView?.textNames || {};
    const selectedTextTabs = textSelection
        .map((key) => textCandidates.find((item) => textKeyOf(item) === key))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const defaultTextTab = customView?.primaryText
        ? textCandidates.find((item) => textKeyOf(item) === textKeyOf(customView.primaryText!))
        : undefined;
    const textTabs = selectedTextTabs.length ? selectedTextTabs : defaultTextTab ? [defaultTextTab] : textCandidates.slice(0, 1);
    const hasCustomTextTabs = Boolean(customWorkflow && textSelection.length > 0 && textTabs.length);
    const showTextTabs = hasCustomTextTabs && textTabs.length > 1;
    const textPrimaryKey = textSelection[0] || (defaultTextTab ? textKeyOf(defaultTextTab) : textTabs[0] ? textKeyOf(textTabs[0]) : "");
    const textTabsSignature = textTabs.map(textKeyOf).join("|");
    const customTexts = node.metadata?.customTexts || {};
    const textValueOf = (item: (typeof textTabs)[number] | undefined) => item ? String(customTexts[textKeyOf(item)] ?? item.default ?? "") : "";
    const textNameOf = (item: (typeof textTabs)[number]) => textNames[textKeyOf(item)] || item.label || "文本输入";
    const [activeTextKey, setActiveTextKey] = useState("");
    const [editingTextTab, setEditingTextTab] = useState<string | null>(null);
    const [textTabDraft, setTextTabDraft] = useState("");
    const textTabCancelRef = useRef(false);
    useEffect(() => {
        void rescanStaleCustomWorkflows(globalConfig);
    }, [globalConfig]);
    useEffect(() => () => {
        if (swapTargetFrameRef.current) URL.revokeObjectURL(swapTargetFrameRef.current);
    }, []);
    const customWorkflowDisabled = Boolean(customWorkflow && customWorkflow.enabled === false);
    const referencePrompt = mentionReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const captionEngine = node.metadata?.captionEngine;
    const rawWorkflowId = channelModelOf(config, config.model)?.model.workflowId || modelOptionName(config.model);
    const workflowId = baseVideoWorkflowId(rawWorkflowId);
    const multiModeEntry = isMultiModeVideoWorkflow(workflowId);
    const currentVideoMode = String(config.videoMode || "");
    const isH3T2V = mode === "video" && multiModeEntry && currentVideoMode === "text";
    const isViggleSwap = workflowId === "video-h3-viggle-swap";
    const vigglePinsText = String(config.videoPins || "").trim();
    const vigglePinsCount = vigglePinsText ? vigglePinsText.split(/[,\s]+/).filter(Boolean).length : 0;
    const viggleReferenceCount = Math.min(4, imageReferences.length);
    const viggleEditMode = isViggleSwap && String(config.videoViggleMode || "swap") === "edit";
    const vigglePinsMismatch = viggleEditMode && viggleReferenceCount > 0 && Boolean(vigglePinsText) && vigglePinsCount !== viggleReferenceCount;
    const vigglePinsMismatchText = vigglePinsMismatch ? `pins ${vigglePinsCount} / 参考图 ${viggleReferenceCount} 数量不一致，请修正后再生成` : "";
    const sourceVideoMention = mentionReferences.find((reference) => reference.kind === "video");
    const selfVideoSource = node.type === CanvasNodeType.Video && Boolean(node.metadata?.content);
    const hasEditSourceVideo = Boolean(sourceVideoMention) || selfVideoSource;
    const viggleEditNoRefs = viggleEditMode && imageReferences.length === 0 && hasEditSourceVideo;
    const viggleEditMissingSource = viggleEditMode && !hasEditSourceVideo;
    const vigglePrep = node.metadata?.vigglePrep;
    const vigglePreparing = vigglePrep?.phase === "running";
    const viggleHint = vigglePreparing
        ? `制备中：${vigglePrep?.step === "selfproduce" ? "自产目标帧" : vigglePrep?.step === "edit" ? "改图" : vigglePrep?.step === "inject" ? "注入" : "抽帧"}…`
        : vigglePrep?.phase === "error"
          ? `自动制备失败（${vigglePrep.error || "未知错误"}）：请手动抽帧 → 图像编辑改好 → 上传为参考图，pins 填对应帧号`
          : isViggleSwap && !viggleEditMode
        ? "一次产片：点生成后先编译六段式提示词，再一次生成；pins 可留空（网关自动选帧）"
        : viggleEditMissingSource
        ? "视频编辑需要源视频：先连接一段源视频；也可以直接上传编辑参考图"
        : viggleEditNoRefs
        ? "已连源视频：填写编辑指令后点生成，会自动抽帧 → 改图 → 注入参考，无需手动上传参考图"
        : "";
    const isH3Reference = workflowId === "video-h3-character-swap" || isViggleSwap || (multiModeEntry && currentVideoMode === "reference");
    const isCharacterSwap = workflowId === "video-h3-character-swap" || isViggleSwap;
    const sourceVideoReference = mentionReferences.find((reference) => reference.kind === "video");
    const sourceVideoNode = sourceVideoReference ? nodes.find((item) => item.id === sourceVideoReference.nodeId) : selfVideoSource ? node : undefined;
    const sourceVideoDurationSeconds = sourceVideoNode?.metadata?.durationMs && sourceVideoNode.metadata.durationMs > 0 ? sourceVideoNode.metadata.durationMs / 1000 : undefined;
    const isH3 = mode === "video" && (workflowId === "video-h3-fast" || isH3Reference || multiModeEntry);
    const closeSwapTargetPicker = () => {
        if (swapTargetFrameRef.current) URL.revokeObjectURL(swapTargetFrameRef.current);
        swapTargetFrameRef.current = "";
        setSwapTargetFrameUrl("");
    };
    const openSwapTargetPicker = async () => {
        const sourceUrl = String(sourceVideoNode?.metadata?.content || "").trim();
        if (!sourceUrl) {
            message.warning("先连接一段源视频，再框选目标人物");
            return;
        }
        try {
            const blob = await captureVideoFrame(await resolveMediaUrl(sourceUrl), "first", 0);
            if (swapTargetFrameRef.current) URL.revokeObjectURL(swapTargetFrameRef.current);
            const objectUrl = URL.createObjectURL(blob);
            swapTargetFrameRef.current = objectUrl;
            setSwapTargetFrameUrl(objectUrl);
        } catch {
            message.error("读取源视频首帧失败：请确认源视频可播放后重试");
        }
    };
    const isImage = mode === "image";
    const isCustomVideo = mode === "video" && Boolean(customWorkflow) && isCustomWorkflowModel(workflowId);
    const imageInputLimit = modelImageInputs(config, config.model || config.imageModel);
    const imageModeValue = String(config.imageMode || "").trim();
    const defaultImageMode = channelModelOf(config, config.model || config.imageModel)?.model.defaultMode || "";
    const textOnlyImageMode = isImage && ((imageModeValue || defaultImageMode) === "t2i" || imageInputLimit === 0);
    const usesImageReferences = textOnlyImageMode ? false : imageInputLimit === undefined ? !isH3T2V : imageInputLimit > 0;
    const sourceImageReference: CanvasResourceReference | null =
        usesImageReferences && node.type === CanvasNodeType.Image && node.metadata?.content && config.nodeRegenerateBehavior !== "overwrite" && !imageReferences.length
            ? {
                  id: `canvas:${node.id}`,
                  nodeId: node.id,
                  kind: "image",
                  label: t("canvas.references.source"),
                  title: node.title || t("canvas.references.source"),
                  previewUrl: node.metadata.content,
                  active: true,
              }
            : null;
    const promptImageReferences = sourceImageReference ? [sourceImageReference, ...imageReferences.filter((reference) => reference.nodeId !== node.id)] : imageReferences;
    const maskSourceReference = promptImageReferences[0];
    const maskSourceNode = maskSourceReference?.nodeId ? nodes.find((item) => item.id === maskSourceReference.nodeId) : null;
    const maskSourceImage = maskSourceNode?.metadata?.images?.find((image) => image.id === maskSourceNode.metadata?.primaryImageId) || maskSourceNode?.metadata?.images?.[0];
    const maskSourceUrl = maskSourceReference?.previewUrl || maskSourceNode?.metadata?.content || maskSourceImage?.content;
    const customWorkflowNeedsImage = Boolean(customWorkflow && (customWorkflowView(customWorkflow).mode === "i2i" || customWorkflowView(customWorkflow).mode === "edit") && !promptImageReferences.length);
    const optimizeStatus = node.metadata?.promptOptimizeStatus;
    const optimizeRunning = optimizeStatus === "running";
    const optimizeResult = node.metadata?.promptOptimizePrompt || "";
    const optimizeError = node.metadata?.promptOptimizeError || "";
    const originalPrompt = node.metadata?.promptOptimizeSource?.trim() || "";
    const canOptimize = isH3 && Boolean(draft.trim()) && !isRunning && !optimizeRunning;
    const canOptimizeImage = (isImage || isCustomVideo) && Boolean(draft.trim()) && !isRunning && !optimizeRunning;
    const optimizeEngine = config.promptApiEngine === "cloud" ? "cloud" : "local";
    const optimizeLanguage = config.promptOptimizeLanguage === "en" ? "en" : "zh";
    const optimizeCloudReady = Boolean((config.promptCloudBaseUrl || "").trim() && (config.promptCloudApiKey || "").trim() && (config.promptCloudModel || "").trim());
    const captionReady = mode === "text" && Boolean(captionEngine);
    const captionStatus = mode === "text" ? node.metadata?.captionStatus : undefined;
    const captionRunning = mode === "text" && captionStatus === "running";
    const captionResult = mode === "text" ? node.metadata?.captionPrompt || "" : "";
    const captionError = mode === "text" ? node.metadata?.captionError || "" : "";
    const captionEngineUsed = node.metadata?.captionEngineUsed || captionEngine || "qwen35";
    const captionQwenReady = engineAvailable("qwen");
    const captionFlorenceReady = engineAvailable("florence");
    const captionLocalCapability = captionEngine === "qwen35" ? capabilities?.engines.qwen : captionEngine === "florence" ? capabilities?.engines.florence : null;
    const captionLocalReady = captionEngine === "cloud" ? true : captionEngine === "qwen35" ? captionQwenReady : captionEngine === "florence" ? captionFlorenceReady : true;
    const canCaption = mode === "text" && Boolean(captionEngine) && captionLocalReady && (captionEngine !== "cloud" || optimizeCloudReady) && imageReferences.length > 0 && !isRunning && !captionRunning;
    const hasExternalMediaReferences = mentionReferences.some((reference) => reference.nodeId !== node.id && reference.kind !== "text");
    const hasSelfMediaReference = mentionReferences.some((reference) => reference.nodeId === node.id && reference.kind !== "text");
    const textVideoHasReferences = isH3T2V && hasExternalMediaReferences;
    const textVideoSelfMediaHint = isH3T2V && hasSelfMediaReference;
    const frameMode: "first" | "last" | "both" =
        node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first"
            ? node.metadata.frameMode
            : imageReferences.length >= 2
              ? "both"
              : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        onConfigChange(node.id, { videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };

    // 文本输入标签：节点或标签集合变化时，回到上次标签/第一个标签。
    useEffect(() => {
        if (!textTabs.length) {
            setActiveTextKey("");
            return;
        }
        const preferred = textTabs.find((item) => textKeyOf(item) === node.metadata?.customTextActive) || textTabs[0];
        const key = textKeyOf(preferred);
        setActiveTextKey(key);
        setDraft(textValueOf(preferred));
        setPrompt(node.metadata?.prompt ?? textValueOf(preferred));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, textTabsSignature]);

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        if (hasCustomTextTabs) return;
        const initial = mode === "audio" ? audioTextForMode(node.metadata, config.audioMode) : node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        setPrompt(initial);
        setDraft(initial);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const commitTextTabs = (value = draft, key = activeTextKey) => {
        if (!hasCustomTextTabs || !key) return;
        const next = { ...(node.metadata?.customTexts || {}), [key]: value };
        const primaryTab = textTabs.find((item) => textKeyOf(item) === textPrimaryKey);
        const primaryValue = key === textPrimaryKey ? value : String(next[textPrimaryKey] ?? primaryTab?.default ?? "");
        setPrompt(primaryValue);
        onConfigChange(node.id, {
            customTexts: next,
            customTextActive: key,
            prompt: primaryValue,
            ...(isEditingExistingContent ? { composerContent: primaryValue } : {}),
        });
    };

    const commitPrompt = (value = textareaRef.current?.value ?? draft) => {
        if (hasCustomTextTabs) {
            commitTextTabs(value, activeTextKey);
            return;
        }
        if (value === promptRef.current) return;
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const commitPromptRef = useRef(commitPrompt);
    commitPromptRef.current = commitPrompt;

    useEffect(() => {
        const commitOnOutsidePointer = (event: PointerEvent) => {
            if (panelRef.current?.contains(event.target as Node)) return;
            commitPromptRef.current();
        };
        document.addEventListener("pointerdown", commitOnOutsidePointer, true);
        return () => document.removeEventListener("pointerdown", commitOnOutsidePointer, true);
    }, []);

    const updatePrompt = (value: string) => {
        setDraft(value);
        setPrompt(value);
        if (hasCustomTextTabs) {
            const next = { ...(node.metadata?.customTexts || {}), [textPrimaryKey]: value };
            if (activeTextKey !== textPrimaryKey) setDraft(textValueOf(textTabs.find((item) => textKeyOf(item) === activeTextKey)));
            onConfigChange(node.id, { customTexts: next, prompt: value, ...(isEditingExistingContent ? { composerContent: value } : {}) });
            return;
        }
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const applyPromptResult = (value: string) => {
        if (hasCustomTextTabs) {
            const key = node.metadata?.promptOptimizeTextKey || activeTextKey;
            const next = { ...(node.metadata?.customTexts || {}), [key]: value };
            const primaryTab = textTabs.find((item) => textKeyOf(item) === textPrimaryKey);
            const primaryValue = key === textPrimaryKey ? value : String(next[textPrimaryKey] ?? primaryTab?.default ?? "");
            setPrompt(primaryValue);
            setDraft(key === activeTextKey ? value : textValueOf(textTabs.find((item) => textKeyOf(item) === activeTextKey)));
            onConfigChange(node.id, { customTexts: next, prompt: primaryValue, ...(isEditingExistingContent ? { composerContent: primaryValue } : {}) });
            return;
        }
        setDraft(value);
        setPrompt(value);
        if (mode === "text" && node.type === CanvasNodeType.Text) {
            const texts = node.metadata?.texts || [];
            const primaryId = node.metadata?.primaryTextId || texts[0]?.id;
            const nextTexts = texts.length ? texts.map((text) => (text.id === primaryId ? { ...text, content: value } : text)) : undefined;
            onConfigChange(node.id, { content: value, prompt: value, composerContent: value, ...(nextTexts ? { texts: nextTexts } : {}) });
            return;
        }
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    useEffect(() => {
        if (mode !== "image" && mode !== "video") return;
        const next = referencePrompt.trim();
        if (!next) return;
        const previous = lastAutoPromptRef.current;
        if (next === previous) return;
        const current = draftRef.current.trim();
        lastAutoPromptRef.current = next;
        if (!current) {
            updatePrompt(next);
            return;
        }
        if (previous && current.includes(previous)) {
            updatePrompt(current.replace(previous, next));
            return;
        }
        if (!current.includes(next)) updatePrompt(`${current}\n\n${next}`);
        // Sync on connection and when the source text changes, without dropping manual additions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, referencePrompt]);

    const audioVoice = false;
    const audioMode: string = config.audioMode === "song" ? "song" : "dialogue";
    const connectedAudioNodes = connectedNodes.filter((item) => item.type === CanvasNodeType.Audio && Boolean(item.metadata?.content));
    const wiredAudioName = (index: number) => connectedAudioNodes[index]?.title || connectedAudioNodes[index]?.metadata?.prompt || (connectedAudioNodes[index] ? `连线音频 ${index + 1}` : "");
    const audioSourceName = config.audioSourceKey ? config.audioSourceName || "已上传目标音频" : wiredAudioName(0);
    const audioReferenceName = config.audioReferenceKey ? config.audioReferenceName || "已上传音色参考" : wiredAudioName(config.audioSourceKey ? 0 : 1);
    const audioDialogueVoiceName = config.audioDialogueVoiceKey ? config.audioDialogueVoiceName || "已上传音色" : wiredAudioName(0);
    const audioSourceReady = Boolean(config.audioSourceKey) || connectedAudioNodes.length >= 1;
    const audioReferenceReady = Boolean(config.audioReferenceKey) || connectedAudioNodes.length >= (config.audioSourceKey ? 1 : 2);
    const audioVoiceReady = audioSourceReady && audioReferenceReady;
    const [optimizing, setOptimizing] = useState(false);
    const [lyricsError, setLyricsError] = useState("");
    const [styleDraft, setStyleDraft] = useState(config.audioStyle || "");
    const styleFocusedRef = useRef(false);
    useEffect(() => {
        if (!styleFocusedRef.current) setStyleDraft(config.audioStyle || "");
    }, [config.audioStyle, node.id, audioMode]);
    const copyText = useCopyText();
    const audioSourceInputRef = useRef<HTMLInputElement>(null);
    const audioReferenceInputRef = useRef<HTMLInputElement>(null);
    const audioDialogueVoiceInputRef = useRef<HTMLInputElement>(null);
    const uploadAudio = async (target: "source" | "reference" | "dialogue", file?: File | null) => {
        if (!file) return;
        try {
            const uploaded = await uploadMediaFile(file, "audio");
            if (target === "source") onConfigChange(node.id, { audioSourceKey: uploaded.storageKey, audioSourceName: file.name });
            else if (target === "reference") onConfigChange(node.id, { audioReferenceKey: uploaded.storageKey, audioReferenceName: file.name });
            else onConfigChange(node.id, { audioDialogueVoiceKey: uploaded.storageKey, audioDialogueVoiceName: file.name });
        } catch {
            message.error("音频上传失败");
        }
    };
    const previewAudio = async (key: string) => {
        try {
            await new Audio(await resolveMediaUrl(key)).play();
        } catch {
            message.error("试听失败");
        }
    };
    const changeAudioMode = (nextMode: "song" | "voice" | "dialogue") => {
        if (nextMode === audioMode) return;
        const currentTextPatch = audioMode === "song" ? { audioSongText: draft } : audioMode === "dialogue" ? { audioDialogueText: draft } : {};
        const nextText = nextMode === "song" ? node.metadata?.audioSongText ?? "" : nextMode === "dialogue" ? node.metadata?.audioDialogueText ?? "" : "";
        setDraft(nextText);
        setPrompt(nextText);
        onConfigChange(node.id, {
            ...currentTextPatch,
            audioMode: nextMode,
            ...(nextMode === "song" ? { audioSongText: nextText } : nextMode === "dialogue" ? { audioDialogueText: nextText } : {}),
            composerContent: nextText,
            prompt: nextText,
        });
    };
    const buildAgentHint = (detail: string, extra: string) => `${detail}\n${extra}\n请检查本地网关（${LOCAL_GATEWAY_ORIGIN}/health）与 ComfyUI 是否运行；修复后点卡片上的「重试」或重新执行该操作。`;
    const optimizeLyrics = async () => {
        const idea = draft.trim();
        const style = styleDraft.trim() || config.audioStyle || "";
        if (!idea && !style) {
            message.warning("先写歌词或风格");
            return;
        }
        if (!idea) {
            const preset = audioStylePresetOf(style);
            const nextStyle = preset ? preset.tags : normalizeAudioStyle(style);
            setStyleDraft(nextStyle);
            styleFocusedRef.current = false;
            onConfigChange(node.id, { audioStyle: nextStyle });
            message.success("风格已整理");
            return;
        }
        setOptimizing(true);
        setLyricsError("");
        try {
            const lyrics = await requestLyricsOptimize(idea, composeAudioStyle(style, config.audioGenre || DEFAULT_AUDIO_GENRE, config.audioEmotion || DEFAULT_AUDIO_EMOTION), songLyricsDuration(config.audioDuration));
            const preset = audioStylePresetOf(style);
            const nextStyle = preset ? preset.tags : normalizeAudioStyle(style);
            setDraft(lyrics);
            setPrompt(lyrics);
            setStyleDraft(nextStyle);
            styleFocusedRef.current = false;
            onConfigChange(node.id, { audioSongText: lyrics, composerContent: lyrics, prompt: lyrics, audioStyle: nextStyle });
            message.success("提示词已优化");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "提示词优化失败";
            const hint = buildAgentHint(detail, "提示词优化依赖服务端文本 API（assistant/agent-provider.json）。");
            setLyricsError(hint);
            message.error(detail);
        } finally {
            setOptimizing(false);
        }
    };
    const fieldStyle = { borderColor: theme.toolbar.border, color: theme.node.text, WebkitTextFillColor: theme.node.text } as const;
    const textareaClass = "w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm leading-5 outline-none";
    const renderAudioImportRow = (label: string, name: string, uploaded: boolean, onUpload: () => void, storageKey: string, onClear: () => void) => (
        <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-dashed px-3 transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.toolbar.border }}>
            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>{label}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={name || "上传或拉线"} style={{ color: name ? theme.node.text : theme.node.placeholder }}>{name || "上传或拉线"}</span>
            {uploaded ? <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !shrink-0 !rounded-full !p-0" icon={<Play className="size-3.5" />} onClick={() => void previewAudio(storageKey)} title="试听" /> : null}
            {uploaded ? <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !shrink-0 !rounded-full !p-0" icon={<X className="size-3.5" />} onClick={onClear} title="清除上传" /> : null}
            <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !shrink-0 !rounded-full !p-0" icon={<Upload className="size-3.5" />} onClick={onUpload} title="上传音频" />
        </div>
    );
    const submit = () => {
        const primaryTab = textTabs.find((item) => textKeyOf(item) === textPrimaryKey);
        const text = (hasCustomTextTabs
            ? activeTextKey === textPrimaryKey
                ? draft
                : String(customTexts[textPrimaryKey] ?? primaryTab?.default ?? "")
            : draft
        ).trim();
        if (isRunning) return;
        const allowStyleOnly = mode === "audio" && audioMode === "song" && Boolean(styleDraft.trim() || config.audioStyle?.trim() || audioStylePresetOf(config.audioStyle));
        if (!text && !allowStyleOnly) return;
        if (textVideoHasReferences) {
            message.warning(t("canvas.promptPanel.videoTextRefsWarning"));
            return;
        }
        if (vigglePinsMismatch) {
            message.warning(vigglePinsMismatchText);
            return;
        }
        if (!audioVoice) {
            if (hasCustomTextTabs) commitTextTabs(draft, activeTextKey);
            else commitPrompt(draft);
        }
        if (mode === "image" && isCustomWorkflowModel(workflowId)) {
            const customWorkflow = findCustomWorkflow(workflowId);
            if (customWorkflow && customWorkflowView(customWorkflow).mode === "edit") {
                onOpenMaskEditor?.(node.id);
                return;
            }
        }
        if (mode === "image" && (workflowId === "image-qwen21" || workflowId === "image-qwen21-old")) {
            if (config.imageMode === "inpaint" || config.imageMode === "remove") {
                onOpenMaskEditor?.(node.id);
                return;
            }
            if (config.imageMode === "outpaint") {
                onOpenOutpaintEditor?.(node.id);
                return;
            }
        }
        if (isViggleSwap && node.metadata?.vigglePrep) onConfigChange(node.id, { vigglePrep: undefined });
        onGenerate(node.id, mode, text);
    };

    const optimizeDefaults = () => {
        const refLimit = isViggleSwap ? 4 : isH3Reference ? 6 : imageInputLimit ?? 2;
        const selectedRefs = usesImageReferences ? imageReferences.slice(0, Math.max(1, refLimit)) : [];
        const videoCount = Math.min(1, mentionReferences.filter((reference) => reference.kind === "video").length);
        const audioCount = Math.min(2, mentionReferences.filter((reference) => reference.kind === "audio").length);
        const referenceNote =
            isViggleSwap
                ? [
                      `功能：${String(config.videoViggleMode || "swap") === "edit" ? "视频编辑" : "人物替换"}`,
                      `参考图片 ${selectedRefs.length} 张`,
                      `源视频 ${videoCount} 段${sourceVideoDurationSeconds ? `（${sourceVideoDurationSeconds.toFixed(2)} 秒）` : ""}`,
                      String(config.videoPins || "").trim() ? `pins ${String(config.videoPins || "").trim()}` : "",
                  ].filter(Boolean).join("；")
                : isH3Reference
                  ? [`参考图片 ${selectedRefs.length} 张`, videoCount ? `参考视频 ${videoCount} 段` : "", audioCount ? `参考音频 ${audioCount} 段` : ""].filter(Boolean).join("；")
                  : "";
        const taskType: PromptOptimizeMode =
            isViggleSwap
                ? "Viggle"
                : isH3Reference
                  ? "全参考模式(Reference to Video)"
                  : multiModeEntry && currentVideoMode === "text"
                    ? "文生视频(T2VA)"
                    : frameMode === "last"
                      ? "尾帧图生视频(L2VA)"
                      : frameMode === "both" && selectedRefs.length >= 2
                        ? "首尾帧视频(FL2VA)"
                        : "首帧图生视频(I2VA)";
        return { selectedRefs, referenceNote, taskType, duration: isCharacterSwap ? sourceVideoDurationSeconds ?? (Number(config.videoSeconds) || 5) : Number(config.videoSeconds) || 5 };
    };

    const openOptimizeOptions = () => {
        setOptimizeOptionsOpen(true);
    };

    const optimizePrompt = async () => {
        const text = draft.trim();
        if (!text || optimizeRunning) return;
        commitPrompt(draft);
        const defaults = optimizeDefaults();
        const cloud = {
            baseUrl: (config.promptCloudBaseUrl || "").trim(),
            apiKey: (config.promptCloudApiKey || "").trim(),
            model: (config.promptCloudModel || "").trim(),
        };
        const needsCloud = isViggleSwap || optimizeEngine === "cloud";
        if (needsCloud && !(cloud.baseUrl && cloud.apiKey && cloud.model)) {
            message.warning(t("canvas.promptPanel.optimizeCloudMissing"));
            return;
        }
        setOptimizeOptionsOpen(false);
        const controller = new AbortController();
        registerPromptOptimizeJob(node.id, controller);
        onConfigChange(node.id, { promptOptimizeStatus: "running", promptOptimizeKind: "h3", promptOptimizeSource: text, promptOptimizePrompt: undefined, promptOptimizeError: undefined, ...(hasCustomTextTabs ? { promptOptimizeTextKey: activeTextKey } : {}) });
        try {
            const referenceImages = defaults.selectedRefs.length ? await resolveCanvasReferenceImages(defaults.selectedRefs, nodes) : [];
            const sourceFrames = isViggleSwap && sourceVideoNode
                ? await extractVideoFrames(sourceVideoNode.metadata?.content || sourceVideoReference?.previewUrl || "", 5).catch(() => [])
                : [];
            const images = [...referenceImages, ...sourceFrames];
            const result = await requestPromptOptimize(config, {
                prompt: text,
                mode: defaults.taskType,
                duration: defaults.duration,
                referenceNote: defaults.referenceNote,
                language: optimizeLanguage,
                images,
                viggleMode: isViggleSwap ? (String(config.videoViggleMode || "swap") === "edit" ? "edit" : "swap") : undefined,
                engine: needsCloud ? "cloud" : optimizeEngine,
                cloud: needsCloud ? cloud : undefined,
            }, { signal: controller.signal });
            onConfigChange(node.id, { promptOptimizeStatus: "done", promptOptimizePrompt: result.prompt });
        } catch (error) {
            if (controller.signal.aborted) clearOptimizePreview();
            else onConfigChange(node.id, { promptOptimizeStatus: "error", promptOptimizeError: error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed") });
        } finally {
            releasePromptOptimizeJob(node.id, controller);
        }
    };

    const optimizeImagePrompt = async () => {
        const text = draft.trim();
        if (!text || optimizeRunning) return;
        commitPrompt(draft);
        setOptimizeOptionsOpen(false);
        const selectedRefs = usesImageReferences ? promptImageReferences.slice(0, Math.max(1, imageInputLimit ?? 8)) : [];
        const useCloud = optimizeEngine === "cloud";
        const controller = new AbortController();
        registerPromptOptimizeJob(node.id, controller);
        onConfigChange(node.id, { promptOptimizeStatus: "running", promptOptimizeKind: "image", promptOptimizeSource: text, promptOptimizePrompt: undefined, promptOptimizeError: undefined, ...(hasCustomTextTabs ? { promptOptimizeTextKey: activeTextKey } : {}) });
        try {
            const images = !useCloud && selectedRefs.length ? await resolveCanvasReferenceImages(selectedRefs, nodes) : [];
            const result = await requestImagePromptOptimize(config, {
                prompt: text,
                mode: selectedRefs.length ? "image" : "text",
                language: optimizeLanguage,
                images,
                imageCount: selectedRefs.length,
                engine: optimizeEngine,
                cloud: useCloud
                    ? {
                          baseUrl: (config.promptCloudBaseUrl || "").trim(),
                          apiKey: (config.promptCloudApiKey || "").trim(),
                          model: (config.promptCloudModel || "").trim(),
                      }
                    : undefined,
            }, { signal: controller.signal });
            onConfigChange(node.id, { promptOptimizeStatus: "done", promptOptimizePrompt: result.prompt });
        } catch (error) {
            if (controller.signal.aborted) clearOptimizePreview();
            else onConfigChange(node.id, { promptOptimizeStatus: "error", promptOptimizeError: error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed") });
        } finally {
            releasePromptOptimizeJob(node.id, controller);
        }
    };

    useEffect(() => {
        if (node.metadata?.promptOptimizeStatus !== "running" || hasPromptOptimizeJob(node.id)) return;
        clearOptimizePreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, node.metadata?.promptOptimizeStatus]);

    const clearCaptionPreview = () => {
        onConfigChange(node.id, { captionStatus: undefined, captionPrompt: undefined, captionError: undefined });
    };

    const clearOptimizePreview = (keepSource = false) => {
        onConfigChange(node.id, {
            promptOptimizeStatus: undefined,
            promptOptimizeKind: undefined,
            promptOptimizePrompt: undefined,
            promptOptimizeTextKey: undefined,
            promptOptimizeError: undefined,
            ...(keepSource ? {} : { promptOptimizeSource: undefined }),
        });
    };

    const stopOptimize = () => {
        abortPromptOptimizeJob(node.id);
        clearOptimizePreview();
    };

    const captionPrompt = async () => {
        if (!captionEngine || !canCaption) return;
        const controller = new AbortController();
        registerCaptionJob(node.id, controller);
        onConfigChange(node.id, { captionStatus: "running", captionEngineUsed: captionEngine, captionPrompt: undefined, captionError: undefined });
        try {
            const images = await resolveCanvasReferenceImages(imageReferences.slice(0, 1), nodes);
            if (!images.length) throw new Error(t("canvas.promptPanel.captionNoImage"));
            const result = await requestImageCaption(config, { images, language: "zh", engine: captionEngine, cloud: captionEngine === "cloud" ? { baseUrl: (config.promptCloudBaseUrl || "").trim(), apiKey: (config.promptCloudApiKey || "").trim(), model: (config.promptCloudModel || "").trim() } : undefined }, { signal: controller.signal });
            onConfigChange(node.id, { captionStatus: "done", captionPrompt: result.prompt, captionEngineUsed: result.engine || captionEngine });
        } catch (error) {
            if (controller.signal.aborted) clearCaptionPreview();
            else onConfigChange(node.id, { captionStatus: "error", captionError: error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed") });
        } finally {
            releaseCaptionJob(node.id, controller);
        }
    };

    const stopCaption = () => {
        abortCaptionJob(node.id);
        clearCaptionPreview();
    };

    useEffect(() => {
        if (mode !== "text" || node.metadata?.captionStatus !== "running" || hasCaptionJob(node.id)) return;
        // A page reload loses the in-memory controller; do not leave a stale running state.
        clearCaptionPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, node.id, node.metadata?.captionStatus]);

    const switchTextTab = (key: string) => {
        if (key === activeTextKey) return;
        commitTextTabs(draft, activeTextKey);
        const nextTab = textTabs.find((item) => textKeyOf(item) === key);
        setActiveTextKey(key);
        setDraft(textValueOf(nextTab));
        onConfigChange(node.id, { customTextActive: key });
    };

    const startTextTabRename = (key: string) => {
        const tab = textTabs.find((item) => textKeyOf(item) === key);
        setEditingTextTab(key);
        setTextTabDraft(textNames[key] || tab?.label || "");
        textTabCancelRef.current = false;
    };

    const commitTextTabRename = () => {
        const key = editingTextTab;
        if (key && customWorkflow && !textTabCancelRef.current) {
            useCustomWorkflowStore.getState().setTextName(customWorkflow.id, customWorkflow.flowId || "", key, textTabDraft);
        }
        textTabCancelRef.current = false;
        setEditingTextTab(null);
        setTextTabDraft("");
    };

    const renderTextTabs = () => {
        if (!showTextTabs) return null;
        return (
            <div className="mb-2 flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "none" }} onMouseDown={(event) => event.stopPropagation()}>
                {textTabs.map((tab) => {
                    const key = textKeyOf(tab);
                    const active = key === activeTextKey;
                    if (editingTextTab === key) {
                        return (
                            <input
                                key={key}
                                autoFocus
                                value={textTabDraft}
                                maxLength={16}
                                onChange={(event) => setTextTabDraft(event.target.value)}
                                onBlur={commitTextTabRename}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Enter") commitTextTabRename();
                                    if (event.key === "Escape") {
                                        textTabCancelRef.current = true;
                                        setEditingTextTab(null);
                                        setTextTabDraft("");
                                    }
                                }}
                                className="h-7 w-24 shrink-0 rounded-full border px-2 text-[11px] outline-none"
                                style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}
                            />
                        );
                    }
                    return (
                        <button
                            key={key}
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => switchTextTab(key)}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                startTextTabRename(key);
                            }}
                            title={`${textNameOf(tab)} · 双击重命名`}
                            className={`h-7 shrink-0 whitespace-nowrap rounded-full px-2.5 text-[11px] transition-colors ${active ? "border" : "border border-transparent"}`}
                            style={active ? { borderColor: theme.node.stroke, background: theme.toolbar.activeBg, color: theme.node.text } : { color: theme.node.muted }}
                        >
                            {textNameOf(tab)}
                        </button>
                    );
                })}
            </div>
        );
    };

    const primaryTab = textTabs.find((item) => textKeyOf(item) === textPrimaryKey);
    const submitText = (hasCustomTextTabs
        ? activeTextKey === textPrimaryKey
            ? draft
            : String(customTexts[textPrimaryKey] ?? primaryTab?.default ?? "")
        : draft
    ).trim();

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    const hasStyleContent = mode === "audio" && audioMode === "song" && Boolean(styleDraft.trim() || config.audioStyle?.trim() || audioStylePresetOf(config.audioStyle));
    const audioSongHasContent = Boolean(submitText) || hasStyleContent;
    const songLyricsMissingStructure = mode === "audio" && audioMode === "song" && Boolean(submitText) && (!/\[Verse\]/.test(submitText) || !/\[Chorus\]/.test(submitText));
    const generateDisabled = !isRunning && !captionRunning && (customWorkflowDisabled || !(captionReady ? imageReferences.length : mode === "audio" ? (audioMode === "song" ? audioSongHasContent : submitText) : submitText) || vigglePinsMismatch || viggleEditMissingSource);
    const audioEmptyHint = mode === "audio" && !audioVoice && !audioSongHasContent ? (audioMode === "song" ? "先输入歌词或风格" : "先输入台词") : "";
    // 写歌/换声是同步接口：fetch 期间只给 loading 文案，取消走停止按钮（AbortController→网关 kill 进程树），不做进度条。
    const audioLoadingHint = mode === "audio" && isRunning && audioMode !== "dialogue" ? "首次加载模型约 30–60s，请稍候" : "";
    const audioActionHint = audioLoadingHint || audioEmptyHint;
    const generateTitle = viggleHint && !isRunning ? viggleHint : vigglePinsMismatch && !isRunning ? vigglePinsMismatchText : customWorkflowDisabled ? "该自选工作流已停用" : mode === "audio" && audioVoice && !audioVoiceReady ? "先导入目标音频和音色参考" : mode === "audio" && !audioVoice && !audioSongHasContent ? (audioMode === "song" ? "先输入歌词或风格" : "先输入台词") : captionRunning ? t("canvas.promptPanel.captionStop") : captionReady ? (imageReferences.length ? t("canvas.promptPanel.captionHint") : t("canvas.promptPanel.captionNoImage")) : isRunning ? (mode === "audio" ? "取消生成" : t("canvas.promptPanel.stop")) : undefined;
    const generateAriaLabel = t(captionRunning ? "canvas.promptPanel.captionStop" : isRunning ? "canvas.promptPanel.stop" : captionReady ? "canvas.promptPanel.caption" : "canvas.promptPanel.generate");
    const generateIcon = isRunning || captionRunning ? (
        <>
            <LoaderCircle className="size-4 animate-spin" />
            <Square className="size-3.5 fill-current" />
        </>
    ) : captionReady ? (
        <ScanText className="size-4" />
    ) : (
        <ArrowUp className="size-4" />
    );
    const handleGenerateClick = () => {
        if (isRunning) {
            onStop(node.id);
            return;
        }
        if (captionRunning) {
            stopCaption();
            return;
        }
        if (captionReady) {
            void captionPrompt();
            return;
        }
        submit();
    };

    const commitStyle = (value = styleDraft) => {
        styleFocusedRef.current = false;
        onConfigChange(node.id, { audioStyle: value });
    };
    const lyricsInput = (
        <CanvasResourceMentionTextarea
            ref={textareaRef}
            value={draft}
            references={mentionReferences}
            highlightLabels
            disabled={audioVoice}
            onChange={(value) => setDraft(value)}
            onBlur={() => commitPrompt()}
            onSubmit={submit}
            onKeyDown={(event) => event.stopPropagation()}
            className={`thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none disabled:cursor-not-allowed disabled:opacity-100 ${mode === "audio" ? "[&::placeholder]:text-[color:var(--canvas-audio-placeholder)] [&::placeholder]:opacity-100" : ""}`}
            style={{ background: "transparent", color: theme.node.text, "--canvas-audio-placeholder": theme.node.placeholder } as CSSProperties}
            placeholder={mode === "audio" ? (audioMode === "song" ? "输入歌词或主题（留空生成纯音乐）" : "输入台词") : t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            onWheel={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
        />
    );

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <input ref={audioSourceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("source", event.target.files?.[0]); event.target.value = ""; }} />
            <input ref={audioReferenceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("reference", event.target.files?.[0]); event.target.value = ""; }} />
            <input ref={audioDialogueVoiceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("dialogue", event.target.files?.[0]); event.target.value = ""; }} />
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} leadingNode={sourceImageReference ? node : undefined} inheritedNodes={inheritedReferenceNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
            {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
            {textVideoSelfMediaHint ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">文生模式不使用已上传素材；如需参考请切全能参考/首尾帧</div> : null}
            {isViggleSwap && videoReferences.length > 1 ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">{t("canvas.promptPanel.viggleVideoLimit")}</div> : null}
            {isViggleSwap && imageReferences.length > 4 ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">{t("canvas.promptPanel.viggleImageLimit")}</div> : null}
            {isViggleSwap && vigglePinsMismatch ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">{vigglePinsMismatchText}</div> : null}
            {songLyricsMissingStructure ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">YuE2 歌词需要 [Verse] 和 [Chorus] 段落；请先让 AI 写词或按官方格式补齐</div> : null}
            {renderTextTabs()}
            {mode === "audio" && audioMode === "song" ? (
                <div className="grid grid-cols-[2fr_1px_1fr]">
                    <div className="min-w-0 pr-2">
                        <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>歌词</span>
                        {lyricsInput}
                    </div>
                    <div style={{ background: theme.node.stroke }} />
                    <div className="min-w-0 pl-2">
                        <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>风格</span>
                        <textarea
                            value={styleDraft}
                            placeholder="风格"
                            className="thin-scrollbar h-40 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={fieldStyle}
                            onFocus={() => {
                                styleFocusedRef.current = true;
                            }}
                            onBlur={() => commitStyle()}
                            onChange={(event) => setStyleDraft(event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                            onWheel={(event) => event.stopPropagation()}
                        />
                    </div>
                </div>
            ) : (
                lyricsInput
            )}

            {mode === "audio" ? (
                <div className="mt-2 space-y-2" onMouseDown={(event) => event.stopPropagation()}>
                    {audioMode === "song" ? (
                        <div className="grid grid-cols-3 gap-2">
                            <label className="block min-w-0">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>曲风</span>
                                <Select size="small" className="w-full" value={config.audioGenre || DEFAULT_AUDIO_GENRE} options={AUDIO_GENRES.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => onConfigChange(node.id, { audioGenre: value })} popupMatchSelectWidth={false} />
                            </label>
                            <label className="block min-w-0">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>情感</span>
                                <Select size="small" className="w-full" value={config.audioEmotion || DEFAULT_AUDIO_EMOTION} options={AUDIO_EMOTIONS.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => onConfigChange(node.id, { audioEmotion: value })} popupMatchSelectWidth={false} />
                            </label>
                            <label className="block min-w-0">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>风格预设</span>
                                <Select size="small" className="w-full" placeholder="自定义" value={audioStylePresetOf(config.audioStyle)?.value} options={AUDIO_STYLE_PRESETS.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => onConfigChange(node.id, { audioStyle: AUDIO_STYLE_PRESETS.find((item) => item.value === value)?.tags || "" })} popupMatchSelectWidth={false} />
                            </label>
                        </div>
                    ) : null}
                    {audioMode === "voice" ? (
                        <div className="space-y-2">
                            {renderAudioImportRow("目标音频", audioSourceName, Boolean(config.audioSourceKey), () => audioSourceInputRef.current?.click(), config.audioSourceKey || "", () => onConfigChange(node.id, { audioSourceKey: "", audioSourceName: "" }))}
                            {renderAudioImportRow("音色参考", audioReferenceName, Boolean(config.audioReferenceKey), () => audioReferenceInputRef.current?.click(), config.audioReferenceKey || "", () => onConfigChange(node.id, { audioReferenceKey: "", audioReferenceName: "" }))}
                        </div>
                    ) : null}
                    {audioMode === "dialogue" ? (
                        <div className="space-y-2">
                            {renderAudioImportRow("音色参考", audioDialogueVoiceName, Boolean(config.audioDialogueVoiceKey), () => audioDialogueVoiceInputRef.current?.click(), config.audioDialogueVoiceKey || "", () => onConfigChange(node.id, { audioDialogueVoiceKey: "", audioDialogueVoiceName: "" }))}
                            <label className="block">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>导演指令</span>
                                <textarea
                                    value={config.audioInstructions || ""}
                                    placeholder="语气、语速、停顿，例如：压着火，语速偏快"
                                    className={textareaClass + " h-[52px]"}
                                    style={fieldStyle}
                                    onChange={(event) => onConfigChange(node.id, { audioInstructions: event.target.value })}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </label>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="mt-2 flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {mode === "audio" ? (
                        <>
                            {audioMode === "song" ? (
                                <Button type="text" className="!h-10 shrink-0 !rounded-full !px-2 text-xs" style={{ color: theme.node.text }} icon={<Wand2 className="size-3.5" />} loading={optimizing} disabled={isRunning || optimizing || (!draft.trim() && !styleDraft.trim())} title={!draft.trim() && !styleDraft.trim() ? "先输入歌词或风格" : "同时整理歌词与风格"} onClick={() => void optimizeLyrics()}>
                                    提示词优化
                                </Button>
                            ) : null}
                            <Dropdown trigger={["click"]} menu={{ items: AUDIO_MODES.map((item) => ({ key: item.value, label: item.label })), selectedKeys: [audioMode], onClick: ({ key }) => changeAudioMode(key as "song" | "voice" | "dialogue") }}>
                                <Button type="text" className="!h-10 shrink-0 !rounded-full !px-3 text-xs" style={{ color: theme.node.text }}>
                                    <span className="inline-flex items-center gap-1">
                                        {audioModeLabel(audioMode)}
                                        <ChevronDown className="size-3.5" />
                                    </span>
                                </Button>
                            </Dropdown>
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[200px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    {isH3 ? (
                        <Tooltip title={t("canvas.promptPanel.optimizeHint")}>
                            <Button
                                type="text"
                                className="!h-8 shrink-0 !rounded-full !px-2 text-xs"
                                style={{ color: theme.node.text }}
                                icon={optimizeRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                disabled={!canOptimize}
                                onClick={() => (optimizeOptionsOpen ? setOptimizeOptionsOpen(false) : openOptimizeOptions())}
                                aria-label={t("canvas.promptPanel.optimize")}
                            >
                                {optimizeRunning ? t("canvas.promptPanel.optimizing") : t("canvas.promptPanel.optimize")}
                            </Button>
                        </Tooltip>
                    ) : null}
                    {isImage || isCustomVideo ? (
                        <Tooltip title={t("canvas.promptPanel.optimizeImageHint")}>
                            <Button
                                type="text"
                                className="!h-8 shrink-0 !rounded-full !px-2 text-xs"
                                style={{ color: theme.node.text }}
                                icon={optimizeRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                disabled={!canOptimizeImage}
                                onClick={() => (optimizeOptionsOpen ? setOptimizeOptionsOpen(false) : openOptimizeOptions())}
                                aria-label={t("canvas.promptPanel.optimizeImage")}
                            >
                                {optimizeRunning ? t("canvas.promptPanel.optimizing") : t("canvas.promptPanel.optimizeImage")}
                            </Button>
                        </Tooltip>
                    ) : null}
                    {mode === "image" ? (
                        <>
                            {freeCardWorkflow ? (
                                <span className="inline-flex h-10 max-w-[210px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }} title={freeCardWorkflow.name}>
                                    <Workflow className="size-3.5 shrink-0 opacity-60" />
                                    <span className="truncate">{freeCardWorkflow.name}</span>
                                </span>
                            ) : (
                                <>
                                    <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                                    <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                                </>
                            )}
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[190px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })}
                                customWorkflow={customWorkflow}
                                template={customWorkflow?.template}
                                customParams={(node.metadata?.params?.customParams as Record<string, unknown> | undefined) || {}}
                                onCustomParamsChange={(customParams) => onConfigChange(node.id, { params: { ...node.metadata?.params, customParams } })}
                                maskApplied={Boolean((node.metadata as Record<string, unknown> | undefined)?.customMask)}
                                maskSourceUrl={customWorkflow ? maskSourceUrl : undefined}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                                freeCardWorkflowSection={freeCardWorkflowSection}
                                hideMaskActions={hideMaskActions}
                                onOpenMaskEditor={(sourceUrl) => {
                                    if (!node.metadata?.content && !sourceUrl) {
                                        message.warning("这张卡片还没有底图：先连接或生成一张图，再做局部编辑");
                                        return;
                                    }
                                    onOpenMaskEditor?.(node.id, sourceUrl);
                                }}
                                onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)}
                                onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)}
                            />
                            {customWorkflow && (customWorkflowDisabled || customWorkflowNeedsImage) ? (
                                <div className="w-full space-y-1">
                                    {customWorkflowDisabled ? <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">该自选工作流已停用，请到资源中心重新启用。</div> : null}
                                    {!customWorkflowDisabled && customWorkflowNeedsImage ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">未识别到参考图；仍可生成，由 ComfyUI 校验工作流输入。</div> : null}
                                </div>
                            ) : null}
                        </>
                    ) : mode === "video" ? (
                        <>
                            {freeCardWorkflow ? (
                                <span className="inline-flex h-10 max-w-[210px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }} title={freeCardWorkflow.name}>
                                    <Workflow className="size-3.5 shrink-0 opacity-60" />
                                    <span className="truncate">{freeCardWorkflow.name}</span>
                                </span>
                            ) : (
                                <>
                                    <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, videoModelModePatch(config, model))} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                                    <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                                </>
                            )}
                            <CanvasVideoSettingsPopover
                                config={config}
                                buttonClassName="!h-10 !min-w-0 !max-w-[200px] !justify-start !rounded-full !px-2"
                                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                                customWorkflow={customWorkflow}
                                customParams={(node.metadata?.params?.customParams as Record<string, unknown> | undefined) || {}}
                                onCustomParamsChange={(customParams) => onConfigChange(node.id, { params: { ...node.metadata?.params, customParams } })}
                                freeCardWorkflowSection={freeCardWorkflowSection}
                                frameMode={frameMode}
                                onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                                onModeChange={changeVideoMode}
                                durationLocked={isCharacterSwap}
                                sourceDurationSeconds={sourceVideoDurationSeconds}
                                referenceImageCount={isViggleSwap ? viggleReferenceCount : undefined}
                                vigglePrep={isViggleSwap ? vigglePrep : undefined}
                                onPickSwapTarget={isViggleSwap && !viggleEditMode ? openSwapTargetPicker : undefined}
                            />
                            {customWorkflowDisabled ? <div className="w-full"><div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">该自选工作流已停用，请到资源中心重新启用。</div></div> : null}
                        </>
                    ) : (
                        <>
                            <ModelPicker
                                config={config}
                                value={captionEngine ? `caption:${captionEngine}` : config.model}
                                onChange={(model) => {
                                    if (model === "caption:qwen35" || model === "caption:florence" || model === "caption:cloud") onConfigChange(node.id, { captionEngine: model.slice(8) as ImageCaptionEngine });
                                    else onConfigChange(node.id, { model, captionEngine: undefined });
                                }}
                                capability="text"
                                extraOptions={[
                                    { value: "caption:qwen35", label: `反推 · Qwen3.5-9B${captionQwenReady ? "" : `（${t("canvas.promptPanel.captionNotInstalled")}）`}`, disabled: !captionQwenReady },
                                    { value: "caption:florence", label: `反推 · Florence-2 PromptGen${captionFlorenceReady ? "" : `（${t("canvas.promptPanel.captionNotInstalled")}）`}`, disabled: !captionFlorenceReady },
                                    ...(optimizeCloudReady ? [{ value: "caption:cloud", label: `反推 · ${t("canvas.promptPanel.optimizeEngineCloud")}（${config.promptCloudModel}）` }] : []),
                                ]}
                                onMissingConfig={() => openConfigDialog(true)}
                                className="max-w-[190px]"
                            />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                        </>
                    )}
                </div>
                {audioActionHint ? (
                    <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                        {audioActionHint}
                    </span>
                ) : null}
                {viggleHint && !isRunning ? (
                    <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: theme.node.muted }} title={viggleHint}>
                        {viggleHint}
                    </span>
                ) : null}
                {vigglePrep?.phase === "done" && vigglePrep.candidates?.length ? (
                    <details className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                        <summary className="cursor-pointer select-none opacity-70">高级 / 手动指定帧</summary>
                        <div className="mt-1 flex max-w-[260px] gap-1 overflow-x-auto">
                            {vigglePrep.candidates.map((candidate) => (
                                <button
                                    key={candidate.frame}
                                    type="button"
                                    className="shrink-0 rounded border p-0.5"
                                    style={{ borderColor: String(vigglePrep.pin) === String(candidate.frame) ? theme.node.text : theme.node.stroke }}
                                    title={`帧 ${candidate.frame}`}
                                    onClick={() => onConfigChange(node.id, { videoPins: String(candidate.frame) })}
                                >
                                    {candidate.thumbUrl ? <img src={candidate.thumbUrl} alt="" className="h-8 w-8 rounded object-cover" /> : <span className="grid h-8 w-8 place-items-center">{candidate.frame}</span>}
                                </button>
                            ))}
                        </div>
                    </details>
                ) : null}
                {vigglePrep?.phase === "done" && vigglePrep.pin ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }} title={`已自动选择源帧 ${vigglePrep.frame ?? ""}`}>
                        {vigglePrep.targetFrameUrl || vigglePrep.thumbUrl ? <img src={vigglePrep.targetFrameUrl || vigglePrep.thumbUrl} alt="" className="size-5 rounded object-cover" /> : null}
                        自动 pins={vigglePrep.pin}{vigglePrep.similarity != null ? ` · sim ${vigglePrep.similarity.toFixed(2)}` : ""}
                    </span>
                ) : null}
                {mode === "audio" ? (
                    <button
                        type="button"
                        className="ml-auto grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full border transition-opacity outline-none hover:opacity-90 disabled:cursor-not-allowed"
                        style={{ marginLeft: "auto", background: generateDisabled ? theme.node.fill : theme.node.activeStroke, color: generateDisabled ? theme.node.muted : theme.node.panel, borderColor: theme.toolbar.border }}
                        disabled={generateDisabled}
                        onClick={handleGenerateClick}
                        aria-label={generateAriaLabel}
                        title={generateTitle}
                    >
                        <span className="flex items-center gap-1.5">{generateIcon}</span>
                    </button>
                ) : (
                    <Button
                        type="primary"
                        className={`!h-10 shrink-0 !rounded-full ${isRunning || captionRunning ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                        danger={isRunning || captionRunning}
                        disabled={generateDisabled}
                        title={generateTitle}
                        onClick={handleGenerateClick}
                        aria-label={generateAriaLabel}
                    >
                        <span className="flex items-center gap-1.5">{generateIcon}</span>
                    </Button>
                )}
            </div>
            {mode === "audio" && node.metadata?.errorDetails ? (() => {
                const hint = buildAgentHint(node.metadata.errorDetails!, "如为显存不足，请释放显存后重试；如为网络/服务错误，请检查网关与 ComfyUI。");
                return (
                    <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-4 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{hint}</span>
                        <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => copyText(hint, "已复制，直接发给你的 AI Agent")}>复制给 AI Agent</button>
                    </div>
                );
            })() : null}
            {mode === "audio" && lyricsError ? (
                <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-4 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{lyricsError}</span>
                    <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => copyText(lyricsError, "已复制，直接发给你的 AI Agent")}>复制给 AI Agent</button>
                </div>
            ) : null}
            {mode === "text" && captionEngine && captionEngine !== "cloud" && captionLocalCapability && !captionLocalCapability.available ? (
                <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    <span className="min-w-0 truncate" title={captionLocalCapability.reasons.join("；")}>
                        {t("canvas.promptPanel.captionLocalMissing")}
                    </span>
                    <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => openConfigDialog(false, "resources")}>
                        {t("canvas.promptPanel.captionInstall")}
                    </button>
                </div>
            ) : null}
            {(isH3 || isImage || isCustomVideo) && optimizeOptionsOpen ? (
                <PromptOptimizeOptions
                    className="mt-2"
                    title={isImage ? t("canvas.promptPanel.optimizeImageTitle") : undefined}
                    engine={isViggleSwap ? "cloud" : optimizeEngine}
                    forceCloud={isViggleSwap}
                    forceCloudReason={isViggleSwap ? "Viggle 优化仅云端（六段式需云端模型）" : undefined}
                    language={optimizeLanguage}
                    cloudReady={optimizeCloudReady}
                    cloudModel={config.promptCloudModel}
                    localReady={isImage ? engineAvailable("imagePe") : engineAvailable("teMan")}
                    onEngineChange={(engine) => updateConfig("promptApiEngine", engine)}
                    onLanguageChange={(language) => updateConfig("promptOptimizeLanguage", language)}
                    onOpenSettings={() => openConfigDialog(true, "cloud-api")}
                    onOpenLocalSettings={() => openConfigDialog(false, "resources")}
                    onStart={() => (isH3 ? void optimizePrompt() : void optimizeImagePrompt())}
                    onClose={() => setOptimizeOptionsOpen(false)}
                />
            ) : null}
            {(() => {
                const previewRunning = mode === "text" ? captionRunning : optimizeRunning;
                const previewPrompt = mode === "text" ? captionResult : optimizeResult;
                const previewError = mode === "text" ? captionError : optimizeError;
                const previewVisible = Boolean(previewRunning || previewPrompt || previewError) && !(mode !== "text" && optimizeOptionsOpen);
                if (!previewVisible) return null;
                const clearPreview = (keepSource = false) => {
                    if (mode === "text") clearCaptionPreview();
                    else clearOptimizePreview(keepSource);
                };
                return (
                <div className="mt-2 rounded-xl border p-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{t(isImage ? "canvas.promptPanel.optimizeImageTitle" : mode === "text" ? "canvas.promptPanel.captionTitle" : "canvas.promptPanel.optimizeTitle")}{mode === "text" ? ` · ${captionEngineUsed === "florence" ? "Florence" : captionEngineUsed === "cloud" ? t("canvas.promptPanel.optimizeEngineCloud") : "Qwen3.5-9B"}` : ""}</span>
                        <Button
                            type="text"
                            size="small"
                            className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                            icon={<X className="size-3.5" />}
                            onClick={() => {
                                if (mode === "text" && captionRunning) stopCaption();
                                else if (mode !== "text" && optimizeRunning) stopOptimize();
                                else clearPreview();
                            }}
                            aria-label={t(mode === "text" && captionRunning ? "canvas.promptPanel.captionStop" : "canvas.promptPanel.optimizeCancel")}
                        />
                    </div>
                    {previewRunning ? (
                        <div className="flex items-center gap-2 text-xs opacity-70">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            <span>{t(mode === "text" ? "canvas.promptPanel.captioning" : "canvas.promptPanel.optimizing")}</span>
                        </div>
                    ) : null}
                    {previewError ? <div className="text-xs text-[#ef4444]">{previewError}</div> : null}
                    {mode !== "text" && originalPrompt ? <OriginalPromptDisclosure text={originalPrompt} label={t("canvas.promptPanel.originalPrompt")} hint={t("canvas.promptPanel.originalPromptHint")} theme={theme} /> : null}
                    {previewPrompt ? (
                        <>
                            <textarea
                                readOnly
                                value={previewPrompt}
                                className="thin-scrollbar mt-2 h-40 w-full resize-none rounded-lg border p-2 text-xs leading-5 outline-none"
                                style={{ borderColor: theme.toolbar.border, background: "transparent", color: theme.node.text }}
                                onWheel={(event) => event.stopPropagation()}
                            />
                            <div className="mt-2 flex justify-end gap-2">
                                <Button
                                    size="small"
                                    onClick={() => clearPreview()}
                                >
                                    {t("canvas.promptPanel.optimizeCancel")}
                                </Button>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        applyPromptResult(draft.trim() ? `${draft.trim()}\n\n${previewPrompt}` : previewPrompt);
                                        clearPreview(true);
                                    }}
                                >
                                    {t("canvas.promptPanel.appendPrompt")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    onClick={() => {
                                        applyPromptResult(previewPrompt);
                                        clearPreview(true);
                                    }}
                                >
                                    {t("canvas.promptPanel.replacePrompt")}
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
                );
            })()}
            {mode !== "text" && originalPrompt && !optimizeRunning && !optimizeResult && !optimizeError ? (
                <OriginalPromptDisclosure key={`${node.id}:${originalPrompt}`} text={originalPrompt} label={t("canvas.promptPanel.originalPrompt")} hint={t("canvas.promptPanel.originalPromptHint")} theme={theme} />
            ) : null}
            <CanvasNodeCropDialog
                dataUrl={swapTargetFrameUrl}
                open={Boolean(swapTargetFrameUrl)}
                title="框选目标人物"
                confirmText="使用此框选"
                onClose={closeSwapTargetPicker}
                onConfirm={(box) => {
                    onConfigChange(node.id, { videoSwapTarget: "custom", videoSwapTargetBox: JSON.stringify(box) });
                    closeSwapTargetPicker();
                    message.success("已框选目标区域");
                }}
            />
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => { commitPrompt(); setExpanded(false); }} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} leadingNode={sourceImageReference ? node : undefined} inheritedNodes={inheritedReferenceNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
                    {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
            {textVideoSelfMediaHint ? <div className="mb-2 text-xs leading-4 text-[#f59e0b]">文生模式不使用已上传素材；如需参考请切全能参考/首尾帧</div> : null}
                    {renderTextTabs()}
                    <CanvasResourceMentionTextarea
                        value={draft}
                        references={mentionReferences}
                        highlightLabels
                        onChange={(value) => setDraft(value)}
                        onBlur={() => commitPrompt()}
                        onSubmit={submit}
                        onKeyDown={(event) => event.stopPropagation()}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full resize-none rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode === "audio" && config.audioMode === "song" ? "audioSong" : mode}`)}
                        onWheel={(event) => event.stopPropagation()}
                    />
                </div>
            </Modal>
        </div>
    );
}

function OriginalPromptDisclosure({ text, label, hint, theme }: { text: string; label: string; hint: string; theme: ReturnType<typeof useCanvasTheme> }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="mt-2 rounded-lg border" style={{ borderColor: theme.toolbar.border }}>
            <button type="button" className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] font-medium" style={{ color: theme.node.muted }} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
                <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
                <span>{label}</span>
                <span className="ml-auto text-[10px] font-normal opacity-60">{hint}</span>
            </button>
            {open ? (
                <textarea
                    readOnly
                    value={text}
                    className="thin-scrollbar h-28 w-full resize-none border-t bg-transparent p-2 text-xs leading-5 outline-none"
                    style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : null}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function audioTextForMode(metadata: CanvasNodeData["metadata"], mode: string | undefined) {
    if (mode === "song") return metadata?.audioSongText ?? metadata?.composerContent ?? metadata?.prompt ?? "";
    if (mode === "dialogue") return metadata?.audioDialogueText ?? metadata?.composerContent ?? metadata?.prompt ?? "";
    return "";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: node.metadata?.model && isCustomWorkflowModel(node.metadata.model) ? node.metadata.model : resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? "",
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        videoInterpolation: node.metadata?.videoInterpolation || globalConfig.videoInterpolation || "off",
        videoSelfLiftMode: node.metadata?.videoSelfLiftMode || globalConfig.videoSelfLiftMode || "fast",
        videoPins: node.metadata?.videoPins ?? globalConfig.videoPins ?? defaultConfig.videoPins,
        videoSegmentSeconds: node.metadata?.videoSegmentSeconds ?? globalConfig.videoSegmentSeconds ?? defaultConfig.videoSegmentSeconds,
        videoSage: node.metadata?.videoSage ?? globalConfig.videoSage ?? defaultConfig.videoSage,
        videoViggleMode: node.metadata?.videoViggleMode ?? globalConfig.videoViggleMode ?? defaultConfig.videoViggleMode,
        videoSwapTarget: node.metadata?.videoSwapTarget ?? globalConfig.videoSwapTarget ?? defaultConfig.videoSwapTarget,
        videoSwapTargetBox: node.metadata?.videoSwapTargetBox ?? globalConfig.videoSwapTargetBox ?? defaultConfig.videoSwapTargetBox,
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        audioMode: node.metadata?.audioMode || (node.type === CanvasNodeType.Audio ? "song" : globalConfig.audioMode) || "dialogue",
        audioReferenceMode: node.metadata?.audioReferenceMode || globalConfig.audioReferenceMode || "reference",
        audioDuration: node.metadata?.audioDuration || globalConfig.audioDuration || "120",
        audioBpm: node.metadata?.audioBpm || globalConfig.audioBpm || "120",
        audioGender: node.metadata?.audioGender || globalConfig.audioGender || "auto",
        audioLanguage: node.metadata?.audioLanguage || globalConfig.audioLanguage || "zh",
        audioKeyscale: node.metadata?.audioKeyscale || globalConfig.audioKeyscale || "E minor",
        audioVoiceDescription: node.metadata?.audioVoiceDescription || globalConfig.audioVoiceDescription || "",
        audioStyle: node.metadata?.audioStyle || globalConfig.audioStyle || "",
        audioGenre: node.metadata?.audioGenre || globalConfig.audioGenre || defaultConfig.audioGenre || DEFAULT_AUDIO_GENRE,
        audioEmotion: node.metadata?.audioEmotion || globalConfig.audioEmotion || defaultConfig.audioEmotion || DEFAULT_AUDIO_EMOTION,
        audioSeed: node.metadata?.audioSeed || globalConfig.audioSeed || "",
        audioSourceKey: node.metadata?.audioSourceKey || globalConfig.audioSourceKey || "",
        audioSourceName: node.metadata?.audioSourceName || globalConfig.audioSourceName || "",
        audioReferenceKey: node.metadata?.audioReferenceKey || globalConfig.audioReferenceKey || "",
        audioSongReferenceKey: node.metadata?.audioSongReferenceKey || globalConfig.audioSongReferenceKey || "",
        audioReferenceName: node.metadata?.audioReferenceName || globalConfig.audioReferenceName || "",
        audioSongReferenceName: node.metadata?.audioSongReferenceName || globalConfig.audioSongReferenceName || "",
        audioDialogueVoiceKey: node.metadata?.audioDialogueVoiceKey || globalConfig.audioDialogueVoiceKey || "",
        audioDialogueVoiceName: node.metadata?.audioDialogueVoiceName || globalConfig.audioDialogueVoiceName || "",
        audioDialogueSpeed: node.metadata?.audioDialogueSpeed || globalConfig.audioDialogueSpeed || defaultConfig.audioDialogueSpeed || "中速",
        audioDialogueTone: node.metadata?.audioDialogueTone || globalConfig.audioDialogueTone || defaultConfig.audioDialogueTone || "自然",
        audioStrength: node.metadata?.audioStrength || globalConfig.audioStrength || defaultConfig.audioStrength || "1",
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        seed: node.metadata?.seed || globalConfig.seed || "",
        seedFixed: node.metadata?.seedFixed ?? globalConfig.seedFixed ?? "false",
        params: node.metadata?.params || globalConfig.params,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    if (key === "videoInterpolation") return { videoInterpolation: value };
    if (key === "videoSelfLiftMode") return { videoSelfLiftMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string): Partial<CanvasNodeData["metadata"]> {
    if (key === "audioBpm") return { audioBpm: value };
    if (key === "audioStrength") return { audioStrength: value };
    if (key === "audioStyle") return { audioStyle: value };
    if (key === "audioDuration") return { audioDuration: value };
    if (key === "audioGender") return { audioGender: value };
    if (key === "audioDialogueSpeed") return { audioDialogueSpeed: value };
    if (key === "audioDialogueTone") return { audioDialogueTone: value };
    return { audioSeed: value };
}
