import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Square, Upload, Video, Wand2, X } from "lucide-react";
import { Button, Dropdown, Segmented, Select, message } from "antd";
import { useTranslation } from "react-i18next";

import { BaseModelPicker, ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { CONFIG_COMPOSER_ENABLED } from "@/constant/canvas";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { requestLyricsOptimize } from "@/services/api/audio-pipeline";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { AUDIO_CONFIG_NODE_SIZE } from "@/lib/canvas/canvas-node-factory";
import { AUDIO_EMOTIONS, AUDIO_GENRES, AUDIO_MODES, AUDIO_STYLE_PRESETS, DEFAULT_AUDIO_EMOTION, DEFAULT_AUDIO_GENRE, audioModeLabel, audioStylePresetOf, composeAudioStyle, normalizeAudioStyle, songLyricsDuration } from "@/lib/canvas/audio-options";
import { videoModelModePatch } from "@/lib/canvas/video-model-mode";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    connectedAudioNames?: string[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string, prompt?: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, connectedAudioNames, onConfigChange, onGenerate, onStop, onComposerToggle, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor }: CanvasConfigNodePanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = useCanvasTheme();
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const frameMode: "first" | "last" | "both" =
        node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first"
            ? node.metadata.frameMode
            : inputSummary.imageCount >= 2
              ? "both"
              : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        onConfigChange(node.id, { videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const audioMode: string = config.audioMode === "song" ? "song" : "dialogue";
    const [mainText, setMainText] = useState(audioMainText(node.metadata, audioMode));
    const [optimizing, setOptimizing] = useState(false);
    const [styleDraft, setStyleDraft] = useState(config.audioStyle || "");
    const styleFocusedRef = useRef(false);
    const mainFocused = useRef(false);
    const lastNodeId = useRef(node.id);
    const sourceInputRef = useRef<HTMLInputElement>(null);
    const referenceInputRef = useRef<HTMLInputElement>(null);
    const dialogueVoiceInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const changedNode = lastNodeId.current !== node.id;
        lastNodeId.current = node.id;
        if (!changedNode && mainFocused.current) return;
        setMainText(audioMainText(node.metadata, audioMode));
    }, [node.id, audioMode, node.metadata?.audioSongText, node.metadata?.audioDialogueText, node.metadata?.composerContent, node.metadata?.prompt]);
    useEffect(() => {
        if (!styleFocusedRef.current) setStyleDraft(config.audioStyle || "");
    }, [config.audioStyle, node.id, audioMode]);
    useEffect(() => {
        if (mode !== "audio" || (node.width >= AUDIO_CONFIG_NODE_SIZE.width && node.height >= AUDIO_CONFIG_NODE_SIZE.height)) return;
        onConfigChange(node.id, { generationMode: "audio" });
    }, [mode, node.id, node.width, node.height, onConfigChange]);
    const wiredAudioNames = connectedAudioNames || [];
    const wiredAudioName = (index: number) => wiredAudioNames[index] || (inputSummary.audioCount > index ? `连线音频 ${index + 1}` : "");
    const audioSourceName = config.audioSourceKey ? config.audioSourceName || "已上传目标音频" : wiredAudioName(0);
    const audioReferenceName = config.audioReferenceKey ? config.audioReferenceName || "已上传音色参考" : wiredAudioName(config.audioSourceKey ? 0 : 1);
    const audioDialogueVoiceName = config.audioDialogueVoiceKey ? config.audioDialogueVoiceName || "已上传音色" : wiredAudioName(0);
    const audioSourceReady = Boolean(config.audioSourceKey) || inputSummary.audioCount >= 1;
    const audioReferenceReady = Boolean(config.audioReferenceKey) || inputSummary.audioCount >= (config.audioSourceKey ? 1 : 2);
    const audioVoiceReady = audioSourceReady && audioReferenceReady;
    const hasComposerContent = Boolean((mode === "audio" ? mainText : node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const hasStyleContent = mode === "audio" && audioMode === "song" && Boolean(styleDraft.trim() || config.audioStyle?.trim() || audioStylePresetOf(config.audioStyle));
    const audioSongHasContent = hasComposerContent || hasStyleContent;
    const canGenerate =
        mode === "audio"
            ? audioMode === "voice"
                ? audioVoiceReady
                : audioSongHasContent || inputSummary.textCount > 0
            : hasComposerContent || hasAnyInput;
    const commitMainText = (value = mainText) => {
        mainFocused.current = false;
        onConfigChange(node.id, {
            composerContent: value,
            prompt: value,
            ...(audioMode === "song" ? { audioSongText: value } : audioMode === "dialogue" ? { audioDialogueText: value } : {}),
        });
    };
    const commitStyle = (value = styleDraft) => {
        styleFocusedRef.current = false;
        onConfigChange(node.id, { audioStyle: value });
    };
    const changeAudioMode = (nextMode: "song" | "voice" | "dialogue") => {
        if (nextMode === audioMode) return;
        const currentTextPatch = audioMode === "song" ? { audioSongText: mainText } : audioMode === "dialogue" ? { audioDialogueText: mainText } : {};
        const nextText = nextMode === "song" ? node.metadata?.audioSongText ?? "" : nextMode === "dialogue" ? node.metadata?.audioDialogueText ?? "" : "";
        mainFocused.current = false;
        setMainText(nextText);
        onConfigChange(node.id, {
            ...currentTextPatch,
            audioMode: nextMode,
            ...(nextMode === "song" ? { audioSongText: nextText } : nextMode === "dialogue" ? { audioDialogueText: nextText } : {}),
            composerContent: nextText,
            prompt: nextText,
        });
    };
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
    const optimizeLyrics = async () => {
        const idea = mainText.trim();
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
        try {
            const lyrics = await requestLyricsOptimize(idea, composeAudioStyle(style, config.audioGenre || DEFAULT_AUDIO_GENRE, config.audioEmotion || DEFAULT_AUDIO_EMOTION), songLyricsDuration(config.audioDuration));
            const preset = audioStylePresetOf(style);
            const nextStyle = preset ? preset.tags : normalizeAudioStyle(style);
            setMainText(lyrics);
            commitMainText(lyrics);
            setStyleDraft(nextStyle);
            styleFocusedRef.current = false;
            onConfigChange(node.id, { audioStyle: nextStyle });
            message.success("提示词已优化");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提示词优化失败");
        } finally {
            setOptimizing(false);
        }
    };
    const fieldStyle = { borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text } as const;
    const textareaClass = "w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm leading-5 outline-none disabled:cursor-not-allowed disabled:opacity-60";
    const renderAudioImportRow = (label: string, name: string, uploaded: boolean, onUpload: () => void, storageKey: string, onClear: () => void) => (
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5" style={{ borderColor: theme.node.stroke }}>
            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>{label}</span>
            <span className="min-w-0 flex-1 truncate text-xs" title={name || "上传或拉线"} style={{ color: name ? theme.node.text : theme.node.muted }}>{name || "上传或拉线"}</span>
            <Button size="small" type="text" className="!h-6 !shrink-0 !px-1.5" icon={<Upload className="size-3.5" />} onClick={onUpload} title="上传音频" />
            {uploaded ? <Button size="small" type="text" className="!h-6 !shrink-0 !px-1.5" icon={<Play className="size-3.5" />} onClick={() => void previewAudio(storageKey)} title="试听" /> : null}
            {uploaded ? <Button size="small" type="text" className="!h-6 !shrink-0 !px-1.5" icon={<X className="size-3.5" />} onClick={onClear} title="清除上传" /> : null}
        </div>
    );

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">{t("canvas.configNode.title")}</div>
                <div className="cursor-default" style={{ "--canvas-node-text": theme.node.text } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode, ...(value === "audio" ? { model: resolveModelForCapability(globalConfig, undefined, "audio") } : {}) })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        {t("canvas.configNode.image")}
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        {t("canvas.configNode.text")}
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        {t("canvas.configNode.video")}
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        {t("canvas.configNode.audio")}
                                    </span>
                                ),
                            },
                        ].filter((option) => !LOCAL_ONLY || option.value === "image" || option.value === "video" || option.value === "audio")}
                    />
                </div>
            </div>

            <input ref={sourceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("source", event.target.files?.[0]); event.target.value = ""; }} />
            <input ref={referenceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("reference", event.target.files?.[0]); event.target.value = ""; }} />
            <input ref={dialogueVoiceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => { void uploadAudio("dialogue", event.target.files?.[0]); event.target.value = ""; }} />

            {mode === "audio" ? (
                <>
                    {audioMode === "song" ? (
                        <div className="mb-2 grid grid-cols-[2fr_1px_1fr]">
                            <div className="min-w-0 pr-2">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>歌词</span>
                                <textarea
                                    value={mainText}
                                    placeholder="输入歌词或主题（留空生成纯音乐）"
                                    className={textareaClass + " h-[78px]"}
                                    style={fieldStyle}
                                    onFocus={() => { mainFocused.current = true; }}
                                    onBlur={() => commitMainText()}
                                    onChange={(event) => setMainText(event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </div>
                            <div style={{ background: theme.node.stroke }} />
                            <div className="min-w-0 pl-2">
                                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>风格</span>
                                <textarea
                                    value={styleDraft}
                                    placeholder="风格"
                                    className={textareaClass + " h-[78px]"}
                                    style={fieldStyle}
                                    onFocus={() => { styleFocusedRef.current = true; }}
                                    onBlur={() => commitStyle()}
                                    onChange={(event) => setStyleDraft(event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </div>
                        </div>
                    ) : (
                        <textarea
                            value={mainText}
                            placeholder="输入台词"
                            className={textareaClass + " mb-2 h-[78px]"}
                            style={fieldStyle}
                            onFocus={() => { mainFocused.current = true; }}
                            onBlur={() => commitMainText()}
                            onChange={(event) => setMainText(event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    )}
                    {audioMode === "song" && mainText.trim() && (!/\[Verse\]/.test(mainText) || !/\[Chorus\]/.test(mainText)) ? (
                        <div className="mb-2 text-xs leading-4 text-[#f59e0b]">YuE2 歌词需要 [Verse] 和 [Chorus] 段落；请先让 AI 写词或按官方格式补齐</div>
                    ) : null}
                    {audioMode === "song" ? (
                        <div className="mb-2 grid grid-cols-3 gap-2" onMouseDown={(event) => event.stopPropagation()}>
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
                        <div className="mb-2 space-y-1.5" onMouseDown={(event) => event.stopPropagation()}>
                            {renderAudioImportRow("目标音频", audioSourceName, Boolean(config.audioSourceKey), () => sourceInputRef.current?.click(), config.audioSourceKey || "", () => onConfigChange(node.id, { audioSourceKey: "", audioSourceName: "" }))}
                            {renderAudioImportRow("音色参考", audioReferenceName, Boolean(config.audioReferenceKey), () => referenceInputRef.current?.click(), config.audioReferenceKey || "", () => onConfigChange(node.id, { audioReferenceKey: "", audioReferenceName: "" }))}
                        </div>
                    ) : null}
                    {audioMode === "dialogue" ? (
                        <div className="mb-2 space-y-2" onMouseDown={(event) => event.stopPropagation()}>
                            {renderAudioImportRow("音色参考", audioDialogueVoiceName, Boolean(config.audioDialogueVoiceKey), () => dialogueVoiceInputRef.current?.click(), config.audioDialogueVoiceKey || "", () => onConfigChange(node.id, { audioDialogueVoiceKey: "", audioDialogueVoiceName: "" }))}
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
                    <div className="mb-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="justify-self-start">
                            {audioMode === "song" ? (
                                <Button size="small" type="text" className="!h-8 !rounded-lg !px-2" icon={<Wand2 className="size-3.5" />} loading={optimizing} disabled={isRunning || optimizing || (!mainText.trim() && !styleDraft.trim())} title={!mainText.trim() && !styleDraft.trim() ? "先输入歌词或风格" : "同时整理歌词与风格"} onClick={() => void optimizeLyrics()}>提示词优化</Button>
                            ) : null}
                        </div>
                        <Dropdown trigger={["click"]} menu={{ items: AUDIO_MODES.map((item) => ({ key: item.value, label: item.label })), selectedKeys: [audioMode], onClick: ({ key }) => changeAudioMode(key as "song" | "voice" | "dialogue") }}>
                            <Button size="small" type="text" className="!h-8 !rounded-lg !px-2.5" style={{ color: theme.node.text }}>
                                <span className="inline-flex items-center gap-1">
                                    {audioModeLabel(audioMode)}
                                    <ChevronDown className="size-3.5" />
                                </span>
                            </Button>
                        </Dropdown>
                        <div className="justify-self-end">
                            <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="!h-8 !justify-center !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        <InputChip label={t("canvas.configNode.prompt")} value={t("canvas.configNode.items", { count: inputSummary.textCount })} style={chipStyle} />
                        <InputChip label={t("canvas.configNode.references")} value={t("canvas.configNode.images", { count: inputSummary.imageCount })} style={chipStyle} />
                        <InputChip label={t("canvas.configNode.videoReferences")} value={t("canvas.configNode.items", { count: inputSummary.videoCount })} style={chipStyle} />
                        {!LOCAL_ONLY ? <InputChip label={t("canvas.configNode.audioReferences")} value={t("canvas.configNode.items", { count: inputSummary.audioCount })} style={chipStyle} /> : null}
                        {CONFIG_COMPOSER_ENABLED ? (
                            <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                                <Settings2 className="size-3.5" />
                                {t("canvas.configNode.compose")}
                            </button>
                        ) : null}
                    </div>
                    <div className="mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_148px] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                        <div className="flex min-w-0 flex-col gap-1">
                            <WorkflowModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, mode === "video" ? videoModelModePatch(config, model) : { model })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                            <BaseModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} fullWidth />
                        </div>
                        {mode === "video" ? (
                            <CanvasVideoSettingsPopover
                                config={config}
                                placement="topRight"
                                buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                                frameMode={frameMode}
                                onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                                onModeChange={changeVideoMode}
                            />
                        ) : mode === "image" ? (
                            <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })} onOpenMaskEditor={() => onOpenMaskEditor?.(node.id)} onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)} onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)} />
                        ) : (
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        )}
                    </div>
                </>
            )}

            {isRunning && mode === "audio" && audioMode !== "dialogue" ? (
                <div className="mb-2 text-center text-[11px]" style={{ color: theme.node.muted }}>首次加载模型约 30–60s，请稍候</div>
            ) : null}
            <Button
                type="primary"
                className="mt-auto !h-9 !w-full !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id, mode === "audio" ? mainText : undefined))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>{t("canvas.configNode.stop")}</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-4" />
                            <span>{t("canvas.configNode.generate")}</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function audioMainText(metadata: CanvasNodeMetadata | undefined, mode: string) {
    if (mode === "song") return metadata?.audioSongText ?? metadata?.composerContent ?? metadata?.prompt ?? "";
    if (mode === "dialogue") return metadata?.audioDialogueText ?? metadata?.composerContent ?? metadata?.prompt ?? "";
    return "";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
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
        audioMode: node.metadata?.audioMode || (mode === "audio" ? "song" : globalConfig.audioMode) || "dialogue",
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
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string): Partial<CanvasNodeMetadata> {
    if (key === "audioBpm") return { audioBpm: value };
    if (key === "audioStrength") return { audioStrength: value };
    if (key === "audioStyle") return { audioStyle: value };
    if (key === "audioDuration") return { audioDuration: value };
    if (key === "audioGender") return { audioGender: value };
    if (key === "audioDialogueSpeed") return { audioDialogueSpeed: value };
    if (key === "audioDialogueTone") return { audioDialogueTone: value };
    return { audioSeed: value };
}
