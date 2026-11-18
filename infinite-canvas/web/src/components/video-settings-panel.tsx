import { type ReactNode, useEffect } from "react";
import { Slider } from "antd";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme, SeedSetting } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { videoWorkflowId, baseVideoWorkflowId, isMultiModeVideoWorkflow } from "@/lib/canvas/video-model-mode";
import { clampVideoSeconds, computeVideoSize, draftLongSideSize, draftShortSideSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "videoInterpolation" | "videoSelfLiftMode" | "videoPins" | "videoSegmentSeconds" | "videoSage" | "videoViggleMode" | "videoSwapTarget" | "seedFixed" | "seed", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    frameMode?: "first" | "last" | "both";
    onFrameModeChange?: (value: "first" | "last" | "both") => void;
    onModeChange?: (value: "text" | "frames" | "reference") => void;
    durationLocked?: boolean;
    sourceDurationSeconds?: number;
    referenceImageCount?: number;
    vigglePrep?: { phase?: "running" | "done" | "error"; frame?: number; pin?: string; similarity?: number };
    onPickSwapTarget?: () => void;
};

const h3FrameModeOptions = [
    { value: "first" as const, labelKey: "firstFrame" },
    { value: "last" as const, labelKey: "lastFrame" },
    { value: "both" as const, labelKey: "bothFrames" },
];

// 设置面板和设置块共用同一份模式判断，避免两套逻辑走偏。
function videoPanelContext(config: AiConfig) {
    const workflowId = baseVideoWorkflowId(videoWorkflowId(config, config.model));
    const multiModeEntry = isMultiModeVideoWorkflow(workflowId);
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const isViggleSwap = workflowId === "video-h3-viggle-swap";
    const viggleMode = String(config.videoViggleMode || "swap") === "edit" ? "edit" : "swap";
    const isH3Reference = workflowId === "video-h3-character-swap" || isViggleSwap || (multiModeEntry && videoMode === "reference");
    const isFastH3 = workflowId === "video-h3-fast";
    const isH3Frames = isFastH3 || (multiModeEntry && videoMode === "frames");
    const isH3Text = multiModeEntry && videoMode === "text";
    const isH3 = multiModeEntry || isFastH3 || workflowId === "video-h3-character-swap";
    const h3ModeOptions = [
        { value: "text" as const, labelKey: "textH3" },
        { value: "frames" as const, labelKey: "framesH3" },
        { value: "reference" as const, labelKey: "referenceH3" },
    ];
    const modeOptions = isViggleSwap ? h3ModeOptions.filter((item) => item.value === "reference") : isH3 ? h3ModeOptions : videoModeOptions;
    return { isH3, isFastH3, isH3Frames, isH3Text, isH3Reference, isViggleSwap, viggleMode, multiModeEntry, videoMode, modeOptions };
}

type VideoControlProps = {
    config: AiConfig;
    onConfigChange: VideoSettingsPanelProps["onConfigChange"];
    theme: CanvasTheme;
};

export function VideoResolutionControl({ config, onConfigChange, theme }: VideoControlProps) {
    const resolution = parseVideoResolution(config.vquality);
    const ratio = inferVideoRatio(config.size || "auto");
    const select = (next: string) => {
        onConfigChange("vquality", next);
        if (ratio !== "auto") onConfigChange("size", computeVideoSize(next, ratio));
    };
    return (
        <div className="grid grid-cols-4 gap-2.5">
            {resolutionOptions.map((item) => (
                <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => select(item.value)}>
                    {item.label}
                </OptionPill>
            ))}
            <ResolutionInput value={resolution} theme={theme} onChange={select} />
        </div>
    );
}

export function VideoSizeControl({ config, onConfigChange, theme }: VideoControlProps) {
    const resolution = parseVideoResolution(config.vquality);
    const ratio = inferVideoRatio(config.size || "auto");
    const dimensions = readVideoDimensions(config.size || "auto", resolution, ratio);
    return (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
            <DimensionInput prefix="W" value={dimensions.width} disabled={ratio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
            <span className="text-lg opacity-45">↔</span>
            <DimensionInput prefix="H" value={dimensions.height} disabled={ratio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
        </div>
    );
}

export function VideoRatioControl({ config, onConfigChange, theme }: VideoControlProps) {
    const { t } = useTranslation();
    const resolution = parseVideoResolution(config.vquality);
    const ratio = inferVideoRatio(config.size || "auto");
    return (
        <div className="grid grid-cols-4 gap-2.5">
            {videoRatioOptions.map((item) => (
                <button
                    key={item.value}
                    type="button"
                    className="flex h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent text-xs transition hover:opacity-80"
                    style={{ borderColor: ratio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => {
                        onConfigChange("vquality", resolution);
                        onConfigChange("size", computeVideoSize(resolution, item.value));
                    }}
                >
                    <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                    <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                </button>
            ))}
        </div>
    );
}

export function VideoSecondsControl({ config, onConfigChange, theme, durationLocked = false, sourceDurationSeconds }: VideoControlProps & { durationLocked?: boolean; sourceDurationSeconds?: number }) {
    const { t } = useTranslation();
    const seconds = Number(clampVideoSeconds(config.videoSeconds || "6"));
    if (durationLocked) {
        return (
            <div className="flex h-8 items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                <Lock className="size-3.5" />
                <span>{t("settingsPanels.video.followSource")}{sourceDurationSeconds != null ? ` · ${sourceDurationSeconds.toFixed(1)}s` : ""}</span>
            </div>
        );
    }
    return (
        <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
            <Slider className="min-w-0 flex-1" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
            <SecondsInput value={seconds} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
            <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
        </div>
    );
}

export function VideoInterpolationControl({ config, onConfigChange, theme }: VideoControlProps) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-3 gap-2.5">
            {[
                { value: "off", labelKey: "interpolationOff" },
                { value: "2x", labelKey: "interpolation2x" },
                { value: "3x", labelKey: "interpolation3x" },
            ].map((item) => (
                <OptionPill key={item.value} selected={(config.videoInterpolation || "off") === item.value} theme={theme} onClick={() => onConfigChange("videoInterpolation", item.value)}>
                    {t(`settingsPanels.video.${item.labelKey}`)}
                </OptionPill>
            ))}
        </div>
    );
}

export function VideoSelfLiftControl({ config, onConfigChange, theme }: VideoControlProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
                {[
                    { value: "fast", labelKey: "selfLiftFast" },
                    { value: "quality", labelKey: "selfLiftQuality" },
                ].map((item) => (
                    <OptionPill key={item.value} selected={(config.videoSelfLiftMode || "fast") === item.value} theme={theme} onClick={() => onConfigChange("videoSelfLiftMode", item.value)}>
                        {t(`settingsPanels.video.${item.labelKey}`)}
                    </OptionPill>
                ))}
            </div>
            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>{t("settingsPanels.video.selfLiftHint")}</div>
        </div>
    );
}

export function VideoModeControl({ config, onConfigChange, theme, frameMode = "both", onFrameModeChange, onModeChange }: VideoControlProps & { frameMode?: "first" | "last" | "both"; onFrameModeChange?: (value: "first" | "last" | "both") => void; onModeChange?: (value: "text" | "frames" | "reference") => void }) {
    const { t } = useTranslation();
    const { isH3, isFastH3, isH3Frames, videoMode, modeOptions } = videoPanelContext(config);
    return (
        <div className="space-y-2.5">
            <div className={modeOptions.length > 1 ? "grid grid-cols-2 gap-2.5" : "grid grid-cols-1 gap-2.5"}>
                {modeOptions.map((item) => (
                    <OptionPill
                        key={item.value}
                        selected={videoMode === item.value}
                        theme={theme}
                        onClick={() => {
                            onConfigChange("videoMode", item.value);
                            if (isH3) onModeChange?.(item.value as "text" | "frames" | "reference");
                        }}
                    >
                        {t(`settingsPanels.video.modes.${item.labelKey}`)}
                    </OptionPill>
                ))}
            </div>
            {isH3 ? (
                <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                    {t(`settingsPanels.video.modes.${isFastH3 && videoMode === "reference" ? "fastReferenceHint" : videoMode === "text" ? "textHint" : videoMode === "frames" ? "framesHint" : "referenceHint"}`)}
                </div>
            ) : null}
            {isH3Frames && videoMode === "frames" && onFrameModeChange ? (
                <div className="space-y-2 pt-1">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("settingsPanels.video.modes.framePosition")}</div>
                    <div className="grid grid-cols-3 gap-2">
                        {h3FrameModeOptions.map((item) => (
                            <OptionPill key={item.value} selected={frameMode === item.value} theme={theme} onClick={() => onFrameModeChange(item.value)}>
                                {t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", frameMode = "both", onFrameModeChange, onModeChange, durationLocked = false, sourceDurationSeconds, referenceImageCount, vigglePrep, onPickSwapTarget }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const { isH3, isFastH3, isH3Frames, isH3Text, isH3Reference, isViggleSwap, viggleMode, multiModeEntry, videoMode } = videoPanelContext(config);
    const segmentSeconds = Number(config.videoSegmentSeconds ?? "12");
    const segmentInvalid = !Number.isFinite(segmentSeconds) || segmentSeconds < 3.75 || segmentSeconds > 14.4;
    const pinsText = String(config.videoPins || "").trim();
    const pinsCount = pinsText ? pinsText.split(/[,\s]+/).filter(Boolean).length : 0;
    const viggleEditMode = isViggleSwap && String(config.videoViggleMode || "swap") === "edit";
    const pinsMismatch = viggleEditMode && referenceImageCount !== undefined && Boolean(pinsText) && pinsCount !== referenceImageCount;
    const selectedRatio = inferVideoRatio(config.size || "auto");
    useEffect(() => {
        if (!isFastH3) return;
        const inferred = inferVideoRatio(config.size || "");
        const ratio = inferred === "auto" ? "9:16" : inferred;
        const tier = String(config.vquality || "") === "480" ? "480" : "448";
        const nextSize = tier === "448" ? draftLongSideSize(ratio, 448) : draftShortSideSize(ratio, 480);
        if (String(config.vquality || "") === tier && String(config.size || "") === nextSize) return;
        onConfigChange("vquality", tier);
        onConfigChange("size", nextSize);
    }, [config.size, config.vquality, isFastH3, onConfigChange]);
    useEffect(() => {
        if (isFastH3) return;
        const vquality = String(config.vquality || "");
        const pixelSize = /^\d+x\d+$/.test(String(config.size || ""));
        if (vquality === "448") {
            onConfigChange("vquality", "720");
            if (pixelSize) onConfigChange("size", "16:9");
        }
    }, [config.size, config.vquality, isFastH3, onConfigChange]);
    useEffect(() => {
        if (multiModeEntry) return;
        if (isH3Reference && videoMode !== "reference") onConfigChange("videoMode", "reference");
        else if (isH3Frames && !isFastH3 && videoMode !== "frames") onConfigChange("videoMode", "frames");
        else if (isH3Text && videoMode !== "text") onConfigChange("videoMode", "text");
        else if (isFastH3 && videoMode !== "text" && videoMode !== "frames" && videoMode !== "reference") onConfigChange("videoMode", "frames");
        else if (!isH3 && videoMode === "text") onConfigChange("videoMode", "frames");
    }, [multiModeEntry, isFastH3, isH3, isH3Frames, isH3Reference, isH3Text, onConfigChange, videoMode]);
    const applyFastRatio = (ratio: string) => {
        const tier = String(config.vquality || "") === "480" ? "480" : "448";
        const target = ratio === "auto" ? "16:9" : ratio;
        onConfigChange("size", tier === "448" ? draftLongSideSize(target, 448) : draftShortSideSize(target, 480));
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {isViggleSwap ? (
                    <SettingGroup title={t("settingsPanels.video.viggleMode", "功能")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            {[
                                { value: "swap", labelKey: "viggleSwap" },
                                { value: "edit", labelKey: "viggleEdit" },
                            ].map((item) => (
                                <OptionPill key={item.value} selected={viggleMode === item.value} theme={theme} onClick={() => onConfigChange("videoViggleMode", item.value)}>
                                    {t(`settingsPanels.video.${item.labelKey}`)}
                                </OptionPill>
                            ))}
                        </div>
                        <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                            {t(viggleMode === "edit" ? "settingsPanels.video.viggleEditHint" : "settingsPanels.video.viggleSwapHint")}
                        </div>
                    </SettingGroup>
                ) : null}
                {isFastH3 ? (
                    <>
                    <SettingGroup title={t("settingsPanels.video.speedTier")} color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            {[
                                { value: "448", labelKey: "speedTierTurbo" },
                                { value: "480", labelKey: "speedTierFast" },
                            ].map((item) => (
                                <OptionPill
                                    key={item.value}
                                    selected={(String(config.vquality || "") === "480" ? "480" : "448") === item.value}
                                    theme={theme}
                                    onClick={() => {
                                        const inferred = inferVideoRatio(config.size || "");
                                        const ratio = inferred === "auto" ? "9:16" : inferred;
                                        onConfigChange("vquality", item.value);
                                        onConfigChange("size", item.value === "448" ? draftLongSideSize(ratio, 448) : draftShortSideSize(ratio, 480));
                                    }}
                                >
                                    {t(`settingsPanels.video.${item.labelKey}`)}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                    <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {videoRatioOptions.map((item) => (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                    style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => applyFastRatio(item.value)}
                                >
                                    <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                    <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                                </button>
                            ))}
                        </div>
                    </SettingGroup>
                    </>
                ) : (
                    <>
                        <SettingGroup title={t("settingsPanels.video.resolution")} color={theme.node.muted}>
                            <VideoResolutionControl config={config} onConfigChange={onConfigChange} theme={theme} />
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                            <VideoSizeControl config={config} onConfigChange={onConfigChange} theme={theme} />
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                            <VideoRatioControl config={config} onConfigChange={onConfigChange} theme={theme} />
                        </SettingGroup>
                    </>
                )}
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <VideoSecondsControl config={config} onConfigChange={onConfigChange} theme={theme} durationLocked={durationLocked} sourceDurationSeconds={sourceDurationSeconds} />
                </SettingGroup>
                <SeedSetting fixed={config.seedFixed === "true"} seed={config.seed || ""} theme={theme} onChange={onConfigChange} />
                <SettingGroup title={t("settingsPanels.video.interpolation")} color={theme.node.muted}>
                    <VideoInterpolationControl config={config} onConfigChange={onConfigChange} theme={theme} />
                </SettingGroup>
                {isViggleSwap ? (
                    <SettingGroup title={t("settingsPanels.video.segmentSeconds", "分段长度（秒）")} color={theme.node.muted}>
                        <input
                            type="number"
                            min={3.75}
                            max={14.4}
                            step={0.1}
                            value={config.videoSegmentSeconds || "12"}
                            onChange={(event) => onConfigChange("videoSegmentSeconds", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                            style={{ borderColor: segmentInvalid ? "#ef4444" : theme.node.stroke, color: theme.node.text }}
                        />
                        <div className="text-xs leading-4" style={{ color: segmentInvalid ? "#ef4444" : theme.node.muted }}>
                            {segmentInvalid ? t("settingsPanels.video.segmentInvalid", "分段长度必须在 3.75–14.4 秒之间") : t("settingsPanels.video.segmentHint", "3.75–14.4 秒；自动按 17n+5 对齐，超长自动分段")}
                        </div>
                    </SettingGroup>
                ) : null}
                {isViggleSwap && viggleMode === "swap" ? (
                    <SettingGroup title="目标人物" color={theme.node.muted}>
                        <div className={`grid gap-2 ${onPickSwapTarget ? "grid-cols-4" : "grid-cols-3"}`}>
                            {[{ value: "auto", label: "自动" }, { value: "left", label: "左侧" }, { value: "right", label: "右侧" }, ...(onPickSwapTarget ? [{ value: "custom", label: "框选" }] : [])].map((item) => (
                                <OptionPill key={item.value} selected={String(config.videoSwapTarget || "auto") === item.value} theme={theme} onClick={() => (item.value === "custom" && onPickSwapTarget ? onPickSwapTarget() : onConfigChange("videoSwapTarget", item.value))}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                        {onPickSwapTarget && String(config.videoSwapTarget || "auto") === "custom" ? (
                            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                {config.videoSwapTargetBox ? "已框选目标区域；再次点「框选」可调整" : "点「框选」在源视频首帧上拖出目标人物"}
                            </div>
                        ) : null}
                    </SettingGroup>
                ) : null}
                {isViggleSwap ? (
                    <SettingGroup title={t("settingsPanels.video.pins", "钉源帧 pins")} color={theme.node.muted}>
                        {viggleEditMode ? (
                            <>
                                <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                    {config.videoPins ? `pins=${config.videoPins}` : "自动识别抽帧，生成时自动填入 pin"}
                                </div>
                                <details className="text-xs">
                                    <summary className="cursor-pointer select-none opacity-70" style={{ color: theme.node.muted }}>
                                        高级 / 手动指定帧
                                    </summary>
                                    <input
                                        value={config.videoPins || ""}
                                        onChange={(event) => onConfigChange("videoPins", event.target.value)}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        placeholder={t("settingsPanels.video.pinsPlaceholder", "留空=自动；每图一个帧号，例如 96 或 12,184")}
                                        className="mt-2 h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                                        style={{ borderColor: pinsMismatch ? "#f59e0b" : theme.node.stroke, color: theme.node.text }}
                                    />
                                </details>
                                <div className={`text-xs leading-4${pinsMismatch ? " text-amber-500" : ""}`} style={pinsMismatch ? undefined : { color: theme.node.muted }}>
                                    {referenceImageCount !== undefined ? `pins ${pinsCount} / 图 ${referenceImageCount}${pinsMismatch ? " · 数量不一致，生成会被阻止" : ""}` : t("settingsPanels.video.pinsHint", "数量须等于参考图数量")}
                                </div>
                            </>
                        ) : (
                            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                {vigglePrep?.phase === "done" && vigglePrep.pin ? `pins=${vigglePrep.pin}（自动选帧${vigglePrep.similarity != null ? ` · sim ${vigglePrep.similarity.toFixed(2)}` : ""}）` : "生成时自动选帧"}
                            </div>
                        )}
                    </SettingGroup>
                ) : null}
                {isH3 && !isFastH3 && !isViggleSwap ? (
                    <SettingGroup title={t("settingsPanels.video.selfLiftMode")} color={theme.node.muted}>
                        <VideoSelfLiftControl config={config} onConfigChange={onConfigChange} theme={theme} />
                    </SettingGroup>
                ) : null}
                {isViggleSwap ? null : (
                    <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                        <VideoModeControl config={config} onConfigChange={onConfigChange} theme={theme} frameMode={frameMode} onFrameModeChange={onFrameModeChange} onModeChange={onModeChange} />
                    </SettingGroup>
                )}
            </div>
        </ImageSettingsTheme>
    );
}


export function videoResolutionLabel(value: string) {
    return `${parseVideoResolution(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function videoInterpolationLabel(value: string | undefined) {
    if (value === "2x") return i18n.t("settingsPanels.video.interpolation2x");
    if (value === "3x") return i18n.t("settingsPanels.video.interpolation3x");
    return "";
}

export function videoSelfLiftLabel(value: string | undefined) {
    return value === "quality" ? i18n.t("settingsPanels.video.selfLiftQuality") : "";
}

export function normalizeVideoModeValue(value: string | undefined) {
    if (value === "reference" || value === "text") return value;
    return "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function SecondsInput({ value, theme, onCommit }: { value: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Number(clampVideoSeconds(input.value));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={VIDEO_SECONDS_MIN}
                max={VIDEO_SECONDS_MAX}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
