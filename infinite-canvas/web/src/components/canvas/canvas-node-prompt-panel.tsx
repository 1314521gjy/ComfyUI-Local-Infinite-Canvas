import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, LoaderCircle, Maximize2, ScanText, Sparkles, Square, X } from "lucide-react";
import { Button, message, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { BaseModelPicker, ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { channelModelOf, defaultConfig, modelImageInputs, modelOptionName, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { isPlainEnterKey } from "@/lib/keyboard-event";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { requestImageCaption, requestImagePromptOptimize, requestPromptOptimize, type ImageCaptionEngine, type PromptOptimizeMode } from "@/services/api/image";
import { videoModelForWorkflow, videoModelModePatch, baseVideoWorkflowId } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { PromptOptimizeOptions } from "./prompt-optimize-options";
import { abortCaptionJob, hasCaptionJob, registerCaptionJob, releaseCaptionJob } from "@/lib/canvas/caption-jobs";
import { abortPromptOptimizeJob, hasPromptOptimizeJob, registerPromptOptimizeJob, releasePromptOptimizeJob } from "@/lib/canvas/prompt-optimize-jobs";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, nodes, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], connectedNodes = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const theme = useCanvasTheme();
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
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
    const lastAutoPromptRef = useRef("");
    const imageReferences = mentionReferences.filter((reference) => reference.kind === "image");
    const referencePrompt = mentionReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const captionEngine = node.metadata?.captionEngine;
    const rawWorkflowId = channelModelOf(config, config.model)?.model.workflowId || modelOptionName(config.model);
    const workflowId = baseVideoWorkflowId(rawWorkflowId);
    const isNoVdnModel = rawWorkflowId !== workflowId;
    const isH3T2V = mode === "video" && workflowId === "video-h3-t2v";
    const isH3Reference = workflowId === "video-h3-ref2va" || workflowId === "video-h3-character-swap";
    const isCharacterSwap = workflowId === "video-h3-character-swap";
    const sourceVideoReference = mentionReferences.find((reference) => reference.kind === "video");
    const sourceVideoNode = sourceVideoReference ? nodes.find((item) => item.id === sourceVideoReference.nodeId) : undefined;
    const sourceVideoDurationSeconds = sourceVideoNode?.metadata?.durationMs && sourceVideoNode.metadata.durationMs > 0 ? sourceVideoNode.metadata.durationMs / 1000 : undefined;
    const isH3 = mode === "video" && (workflowId === "video-h3-t2v" || workflowId === "video-h3-frames" || isH3Reference);
    const isImage = mode === "image";
    const imageInputLimit = modelImageInputs(config, config.model || config.imageModel);
    const imageModeValue = String(config.imageMode || "").trim();
    const textOnlyImageMode = isImage && (imageModeValue === "t2i" || (!imageModeValue && workflowId === "image-qwen21"));
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
    const optimizeStatus = node.metadata?.promptOptimizeStatus;
    const optimizeRunning = optimizeStatus === "running";
    const optimizeResult = node.metadata?.promptOptimizePrompt || "";
    const optimizeError = node.metadata?.promptOptimizeError || "";
    const originalPrompt = node.metadata?.promptOptimizeSource?.trim() || "";
    const canOptimize = isH3 && Boolean(draft.trim()) && !isRunning && !optimizeRunning;
    const canOptimizeImage = isImage && Boolean(draft.trim()) && !isRunning && !optimizeRunning;
    const optimizeEngine = config.promptApiEngine === "cloud" ? "cloud" : "local";
    const optimizeCloudReady = Boolean((config.promptCloudBaseUrl || "").trim() && (config.promptCloudApiKey || "").trim() && (config.promptCloudModel || "").trim());
    const captionReady = mode === "text" && Boolean(captionEngine);
    const captionStatus = mode === "text" ? node.metadata?.captionStatus : undefined;
    const captionRunning = mode === "text" && captionStatus === "running";
    const captionResult = mode === "text" ? node.metadata?.captionPrompt || "" : "";
    const captionError = mode === "text" ? node.metadata?.captionError || "" : "";
    const captionEngineUsed = node.metadata?.captionEngineUsed || captionEngine || "qwen35";
    const canCaption = mode === "text" && Boolean(captionEngine) && imageReferences.length > 0 && !isRunning && !captionRunning;
    const hasMediaReferences = mentionReferences.some((reference) => reference.kind !== "text");
    const textVideoHasReferences = isH3T2V && hasMediaReferences;
    const frameMode: "first" | "last" | "both" =
        node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first"
            ? node.metadata.frameMode
            : imageReferences.length >= 2
              ? "both"
              : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        const baseId = value === "reference" ? "video-h3-ref2va" : value === "frames" ? "video-h3-frames" : "video-h3-t2v";
        const nextModel = videoModelForWorkflow(config, baseId, { noVdn: isNoVdnModel });
        onConfigChange(node.id, { ...(nextModel ? { model: nextModel } : {}), videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        const initial = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        setPrompt(initial);
        setDraft(initial);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const commitPrompt = (value = textareaRef.current?.value ?? draft) => {
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
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const applyPromptResult = (value: string) => {
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

    const submit = () => {
        const text = draft.trim();
        if (!text || isRunning) return;
        if (textVideoHasReferences) {
            message.warning(t("canvas.promptPanel.videoTextRefsWarning"));
            return;
        }
        commitPrompt(draft);
        if (mode === "image" && workflowId === "image-qwen21") {
            if (config.imageMode === "inpaint") {
                onOpenMaskEditor?.(node.id);
                return;
            }
            if (config.imageMode === "outpaint") {
                onOpenOutpaintEditor?.(node.id);
                return;
            }
        }
        onGenerate(node.id, mode, text);
    };

    const optimizeDefaults = () => {
        const refLimit = imageInputLimit ?? (isH3Reference ? 6 : 2);
        const selectedRefs = usesImageReferences ? imageReferences.slice(0, Math.max(1, refLimit)) : [];
        const videoCount = Math.min(1, mentionReferences.filter((reference) => reference.kind === "video").length);
        const audioCount = Math.min(2, mentionReferences.filter((reference) => reference.kind === "audio").length);
        const referenceNote =
            isH3Reference
                ? [`参考图片 ${selectedRefs.length} 张`, videoCount ? `参考视频 ${videoCount} 段` : "", audioCount ? `参考音频 ${audioCount} 段` : ""].filter(Boolean).join("；")
                : "";
        const taskType: PromptOptimizeMode =
            isH3Reference
                ? "全参考模式(Reference to Video)"
                : workflowId === "video-h3-t2v"
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
        if (optimizeEngine === "cloud" && !(cloud.baseUrl && cloud.apiKey && cloud.model)) {
            message.warning(t("canvas.promptPanel.optimizeCloudMissing"));
            return;
        }
        setOptimizeOptionsOpen(false);
        const controller = new AbortController();
        registerPromptOptimizeJob(node.id, controller);
        onConfigChange(node.id, { promptOptimizeStatus: "running", promptOptimizeKind: "h3", promptOptimizeSource: text, promptOptimizePrompt: undefined, promptOptimizeError: undefined });
        try {
            const images = defaults.selectedRefs.length ? await resolveCanvasReferenceImages(defaults.selectedRefs, nodes) : [];
            const result = await requestPromptOptimize(config, {
                prompt: text,
                mode: defaults.taskType,
                duration: defaults.duration,
                referenceNote: defaults.referenceNote,
                images,
                engine: optimizeEngine,
                cloud: optimizeEngine === "cloud" ? cloud : undefined,
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
        onConfigChange(node.id, { promptOptimizeStatus: "running", promptOptimizeKind: "image", promptOptimizeSource: text, promptOptimizePrompt: undefined, promptOptimizeError: undefined });
        try {
            const images = !useCloud && selectedRefs.length ? await resolveCanvasReferenceImages(selectedRefs, nodes) : [];
            const result = await requestImagePromptOptimize(config, {
                prompt: text,
                mode: selectedRefs.length ? "image" : "text",
                language: "zh",
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
            const result = await requestImageCaption(config, { images, language: "zh", engine: captionEngine }, { signal: controller.signal });
            onConfigChange(node.id, { captionStatus: "done", captionPrompt: result.prompt });
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

    const openExpandedEditor = () => {
        setExpanded(true);
    };

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
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} leadingNode={sourceImageReference ? node : undefined} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
            {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
            <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commitPrompt()}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (isPlainEnterKey(event)) {
                        event.preventDefault();
                        submit();
                    }
                }}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
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
                    {isImage ? (
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
                            <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                                onOpenMaskEditor={() => onOpenMaskEditor?.(node.id)}
                                onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)}
                                onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, videoModelModePatch(config, model))} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                            <CanvasVideoSettingsPopover
                                config={config}
                                buttonClassName="!h-10 !min-w-0 !max-w-[200px] !justify-start !rounded-full !px-2"
                                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                                frameMode={frameMode}
                                onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                                onModeChange={changeVideoMode}
                                durationLocked={isCharacterSwap}
                                sourceDurationSeconds={sourceVideoDurationSeconds}
                            />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker
                                config={config}
                                value={captionEngine ? `caption:${captionEngine}` : config.model}
                                onChange={(model) => {
                                    if (model === "caption:qwen35" || model === "caption:florence") onConfigChange(node.id, { captionEngine: model.slice(8) as ImageCaptionEngine });
                                    else onConfigChange(node.id, { model, captionEngine: undefined });
                                }}
                                capability="text"
                                extraOptions={[
                                    { value: "caption:qwen35", label: "反推 · Qwen3.5-9B" },
                                    { value: "caption:florence", label: "反推 · Florence-2 PromptGen" },
                                ]}
                                onMissingConfig={() => openConfigDialog(true)}
                                className="max-w-[190px]"
                            />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className={`ml-auto !h-10 shrink-0 !rounded-full ${isRunning || captionRunning ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                    danger={isRunning || captionRunning}
                    disabled={!isRunning && !captionRunning && !(captionReady ? imageReferences.length : draft.trim())}
                    title={captionRunning ? t("canvas.promptPanel.captionStop") : captionReady ? (imageReferences.length ? t("canvas.promptPanel.captionHint") : t("canvas.promptPanel.captionNoImage")) : isRunning ? t("canvas.promptPanel.stop") : undefined}
                    onClick={() => {
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
                    }}
                    aria-label={t(isRunning || captionRunning ? "canvas.promptPanel.captionStop" : captionReady ? "canvas.promptPanel.caption" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning || captionRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                            </>
                        ) : captionReady ? (
                            <ScanText className="size-4" />
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            {(isH3 || isImage) && optimizeOptionsOpen ? (
                <PromptOptimizeOptions
                    className="mt-2"
                    title={isImage ? t("canvas.promptPanel.optimizeImageTitle") : undefined}
                    engine={optimizeEngine}
                    cloudReady={optimizeCloudReady}
                    cloudModel={config.promptCloudModel}
                    onEngineChange={(engine) => updateConfig("promptApiEngine", engine)}
                    onOpenSettings={() => openConfigDialog(true, "cloud-api")}
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
                        <span className="text-xs font-medium">{t(isImage ? "canvas.promptPanel.optimizeImageTitle" : mode === "text" ? "canvas.promptPanel.captionTitle" : "canvas.promptPanel.optimizeTitle")}{mode === "text" ? ` · ${captionEngineUsed === "florence" ? "Florence" : "Qwen3.5-9B"}` : ""}</span>
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
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => { commitPrompt(); setExpanded(false); }} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} leadingNode={sourceImageReference ? node : undefined} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
                    {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commitPrompt()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (isPlainEnterKey(event)) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full resize-none rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
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

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
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
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
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

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
