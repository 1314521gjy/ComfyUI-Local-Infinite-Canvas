import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, ScanText, Sparkles, Square, X } from "lucide-react";
import { Button, message, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { BaseModelPicker, ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { channelModelOf, defaultConfig, modelOptionName, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { isPlainEnterKey } from "@/lib/keyboard-event";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { requestImageCaption, requestImagePromptOptimize, requestPromptOptimize, type ImageCaptionEngine, type PromptOptimizeMode } from "@/services/api/image";
import { videoModelForWorkflow, videoModelModePatch } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";

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
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
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
    const [optimizing, setOptimizing] = useState(false);
    const [optimizedPrompt, setOptimizedPrompt] = useState("");
    const [optimizeError, setOptimizeError] = useState("");
    const [captionEngineUsed, setCaptionEngineUsed] = useState<ImageCaptionEngine>("qwen35");
    const captionAbortRef = useRef<AbortController | null>(null);
    const lastAutoPromptRef = useRef("");
    const imageReferences = mentionReferences.filter((reference) => reference.kind === "image");
    const referencePrompt = mentionReferences
        .filter((reference) => reference.kind === "text" && reference.text?.trim())
        .map((reference) => reference.text!.trim())
        .join("\n\n");
    const captionEngine = node.metadata?.captionEngine;
    const workflowId = channelModelOf(config, config.model)?.model.workflowId || modelOptionName(config.model);
    const isH3T2V = mode === "video" && workflowId === "video-h3-t2v";
    const isH3 = mode === "video" && (workflowId === "video-h3-t2v" || workflowId === "video-h3-frames" || workflowId === "video-h3-ref2va");
    const isImage = mode === "image";
    const canOptimize = isH3 && Boolean(draft.trim()) && !isRunning && !optimizing;
    const canOptimizeImage = isImage && Boolean(draft.trim()) && !isRunning && !optimizing;
    const canCaption = mode === "text" && Boolean(captionEngine) && imageReferences.length > 0 && !isRunning && !optimizing;
    const hasMediaReferences = mentionReferences.some((reference) => reference.kind !== "text");
    const textVideoHasReferences = isH3T2V && hasMediaReferences;
    const frameMode: "first" | "last" | "both" =
        node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first"
            ? node.metadata.frameMode
            : imageReferences.length >= 2
              ? "both"
              : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        const workflowId = value === "reference" ? "video-h3-ref2va" : value === "frames" ? "video-h3-frames" : "video-h3-t2v";
        const nextModel = videoModelForWorkflow(config, workflowId);
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

    const optimizePrompt = async () => {
        const text = draft.trim();
        if (!text || optimizing) return;
        commitPrompt(draft);
        const selectedRefs =
            workflowId === "video-h3-ref2va"
                ? imageReferences.slice(0, 6)
                : workflowId === "video-h3-t2v"
                  ? []
                  : imageReferences.slice(0, 2);
        const videoCount = Math.min(1, mentionReferences.filter((reference) => reference.kind === "video").length);
        const audioCount = Math.min(2, mentionReferences.filter((reference) => reference.kind === "audio").length);
        const referenceNote =
            workflowId === "video-h3-ref2va"
                ? [`参考图片 ${selectedRefs.length} 张`, videoCount ? `参考视频 ${videoCount} 段` : "", audioCount ? `参考音频 ${audioCount} 段` : ""].filter(Boolean).join("；")
                : "";
        const taskType: PromptOptimizeMode =
            workflowId === "video-h3-ref2va"
                ? "全参考模式(Reference to Video)"
                : workflowId === "video-h3-t2v"
                  ? "文生视频(T2VA)"
                  : frameMode === "last"
                    ? "尾帧图生视频(L2VA)"
                    : frameMode === "both" && selectedRefs.length >= 2
                      ? "首尾帧视频(FL2VA)"
                      : "首帧图生视频(I2VA)";
        setOptimizing(true);
        setOptimizeError("");
        setOptimizedPrompt("");
        try {
            const images = selectedRefs.length ? await resolveCanvasReferenceImages(selectedRefs, nodes) : [];
            const result = await requestPromptOptimize(config, {
                prompt: text,
                mode: taskType,
                duration: Number(config.videoSeconds) || 5,
                referenceNote,
                images,
            });
            setOptimizedPrompt(result.prompt);
        } catch (error) {
            setOptimizeError(error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed"));
        } finally {
            setOptimizing(false);
        }
    };

    const optimizeImagePrompt = async () => {
        const text = draft.trim();
        if (!text || optimizing) return;
        commitPrompt(draft);
        const selectedRefs = imageReferences.slice(0, 8);
        setOptimizing(true);
        setOptimizeError("");
        setOptimizedPrompt("");
        try {
            const images = selectedRefs.length ? await resolveCanvasReferenceImages(selectedRefs, nodes) : [];
            const result = await requestImagePromptOptimize(config, {
                prompt: text,
                mode: images.length ? "image" : "text",
                language: "zh",
                images,
            });
            setOptimizedPrompt(result.prompt);
        } catch (error) {
            setOptimizeError(error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed"));
        } finally {
            setOptimizing(false);
        }
    };

    const captionPrompt = async () => {
        if (!captionEngine || !canCaption) return;
        const controller = new AbortController();
        captionAbortRef.current = controller;
        setOptimizing(true);
        setOptimizeError("");
        setOptimizedPrompt("");
        setCaptionEngineUsed(captionEngine);
        try {
            const images = await resolveCanvasReferenceImages(imageReferences.slice(0, 1), nodes);
            if (!images.length) throw new Error(t("canvas.promptPanel.captionNoImage"));
            const result = await requestImageCaption(config, { images, language: "zh", engine: captionEngine }, { signal: controller.signal });
            setOptimizedPrompt(result.prompt);
        } catch (error) {
            if (!controller.signal.aborted) setOptimizeError(error instanceof Error ? error.message : t("canvas.promptPanel.optimizeFailed"));
        } finally {
            if (captionAbortRef.current === controller) captionAbortRef.current = null;
            setOptimizing(false);
        }
    };

    const stopCaption = () => {
        captionAbortRef.current?.abort();
    };

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
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
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
                                icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                disabled={!canOptimize}
                                onClick={() => void optimizePrompt()}
                                aria-label={t("canvas.promptPanel.optimize")}
                            >
                                {optimizing ? t("canvas.promptPanel.optimizing") : t("canvas.promptPanel.optimize")}
                            </Button>
                        </Tooltip>
                    ) : null}
                    {isImage ? (
                        <Tooltip title={t("canvas.promptPanel.optimizeImageHint")}>
                            <Button
                                type="text"
                                className="!h-8 shrink-0 !rounded-full !px-2 text-xs"
                                style={{ color: theme.node.text }}
                                icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                disabled={!canOptimizeImage}
                                onClick={() => void optimizeImagePrompt()}
                                aria-label={t("canvas.promptPanel.optimizeImage")}
                            >
                                {optimizing ? t("canvas.promptPanel.optimizing") : t("canvas.promptPanel.optimizeImage")}
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
                            />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            {optimizing ? (
                                <Button size="small" danger className="!h-9 !rounded-full !px-2" onClick={stopCaption} icon={<Square className="size-3.5 fill-current" />}>
                                    {t("canvas.promptPanel.captionStop")}
                                </Button>
                            ) : (
                                <Tooltip title={!captionEngine ? t("canvas.promptPanel.captionSelectEngine") : imageReferences.length ? t("canvas.promptPanel.captionHint") : t("canvas.promptPanel.captionNoImage")}>
                                    <Button size="small" type="text" className="!h-9 !rounded-full !px-2" disabled={!canCaption} onClick={() => void captionPrompt()} icon={<ScanText className="size-4" />}>
                                        {t("canvas.promptPanel.caption")}
                                    </Button>
                                </Tooltip>
                            )}
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
                    className={`ml-auto !h-10 shrink-0 !rounded-full ${isRunning ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                    danger={isRunning}
                    disabled={!isRunning && !draft.trim()}
                    title={isRunning ? t("canvas.promptPanel.stop") : undefined}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            {optimizing || optimizedPrompt || optimizeError ? (
                <div className="mt-2 rounded-xl border p-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{t(isImage ? "canvas.promptPanel.optimizeImageTitle" : mode === "text" ? "canvas.promptPanel.captionTitle" : "canvas.promptPanel.optimizeTitle")}{mode === "text" ? ` · ${captionEngineUsed === "florence" ? "Florence" : "Qwen3.5-9B"}` : ""}</span>
                        <Button
                            type="text"
                            size="small"
                            className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                            icon={<X className="size-3.5" />}
                            onClick={() => {
                                if (optimizing) {
                                    stopCaption();
                                    return;
                                }
                                setOptimizedPrompt("");
                                setOptimizeError("");
                            }}
                            aria-label={t(optimizing ? "canvas.promptPanel.captionStop" : "canvas.promptPanel.optimizeCancel")}
                        />
                    </div>
                    {optimizing ? (
                        <div className="flex items-center gap-2 text-xs opacity-70">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            <span>{t(mode === "text" ? "canvas.promptPanel.captioning" : "canvas.promptPanel.optimizing")}</span>
                        </div>
                    ) : null}
                    {optimizeError ? <div className="text-xs text-[#ef4444]">{optimizeError}</div> : null}
                    {optimizedPrompt ? (
                        <>
                            <textarea
                                readOnly
                                value={optimizedPrompt}
                                className="thin-scrollbar mt-2 h-40 w-full resize-none rounded-lg border p-2 text-xs leading-5 outline-none"
                                style={{ borderColor: theme.toolbar.border, background: "transparent", color: theme.node.text }}
                                onWheel={(event) => event.stopPropagation()}
                            />
                            <div className="mt-2 flex justify-end gap-2">
                                <Button
                                    size="small"
                                    onClick={() => {
                                        setOptimizedPrompt("");
                                        setOptimizeError("");
                                    }}
                                >
                                    {t("canvas.promptPanel.optimizeCancel")}
                                </Button>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        applyPromptResult(draft.trim() ? `${draft.trim()}\n\n${optimizedPrompt}` : optimizedPrompt);
                                        setOptimizedPrompt("");
                                        setOptimizeError("");
                                    }}
                                >
                                    {t("canvas.promptPanel.appendPrompt")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    onClick={() => {
                                        applyPromptResult(optimizedPrompt);
                                        setOptimizedPrompt("");
                                        setOptimizeError("");
                                    }}
                                >
                                    {t("canvas.promptPanel.replacePrompt")}
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : null}
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => { commitPrompt(); setExpanded(false); }} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} addDisabled={isH3T2V} addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")} />
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
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        params: node.metadata?.params || globalConfig.params,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
