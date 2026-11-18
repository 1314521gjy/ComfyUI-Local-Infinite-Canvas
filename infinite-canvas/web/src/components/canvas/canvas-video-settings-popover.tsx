import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoInterpolationLabel, videoModeLabel, videoResolutionLabel, videoSecondsLabel, videoSelfLiftLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { FreeCardWorkflowSection, type FreeCardWorkflowSectionProps } from "@/components/canvas/free-card-workflow-section";
import { CustomWorkflowBlockList } from "@/components/layout/custom-workflow-block-editor";
import { CustomWorkflowInlineDisclosure } from "@/components/layout/custom-workflow-inline-disclosure";
import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { refreshWorkflowFieldOptions } from "@/lib/canvas/workflow-field-refresh";
import type { AiConfig } from "@/stores/use-config-store";
import { customWorkflowModeLabels, customWorkflowView, useCustomWorkflowStore, type CustomWorkflow } from "@/stores/use-custom-workflow-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    customWorkflow?: CustomWorkflow | null;
    customParams?: Record<string, unknown>;
    onCustomParamsChange?: (params: Record<string, unknown>) => void;
    freeCardWorkflowSection?: Omit<FreeCardWorkflowSectionProps, "onEdit">;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    frameMode?: "first" | "last" | "both";
    onFrameModeChange?: (value: "first" | "last" | "both") => void;
    onModeChange?: (value: "text" | "frames" | "reference") => void;
    durationLocked?: boolean;
    sourceDurationSeconds?: number;
    referenceImageCount?: number;
    vigglePrep?: { phase?: "running" | "done" | "error"; frame?: number; pin?: string; similarity?: number };
    onPickSwapTarget?: () => void;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, customWorkflow, customParams, onCustomParamsChange, freeCardWorkflowSection, buttonClassName, placement = "topLeft", frameMode, onFrameModeChange, onModeChange, durationLocked = false, sourceDurationSeconds, referenceImageCount, vigglePrep, onPickSwapTarget }: CanvasVideoSettingsPopoverProps) {
    const theme = useCanvasTheme();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [disclosureOpen, setDisclosureOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.querySelector("[data-custom-workflow-disclosure='true']")) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} customWorkflow={customWorkflow} customParams={customParams} onCustomParamsChange={onCustomParamsChange} freeCardWorkflowSection={freeCardWorkflowSection} frameMode={frameMode} onFrameModeChange={onFrameModeChange} onModeChange={onModeChange} durationLocked={durationLocked} sourceDurationSeconds={sourceDurationSeconds} referenceImageCount={referenceImageCount} vigglePrep={vigglePrep} onPickSwapTarget={onPickSwapTarget} onEdit={() => setDisclosureOpen(true)} /> : null;
    const disclosure = disclosureOpen && customWorkflow ? (() => {
        const expandedWidth = Math.min(1280, window.innerWidth - 24);
        const expandedHeight = Math.min(860, window.innerHeight - 48);
        return createPortal(
            <div
                className="canvas-image-settings-popover"
                data-custom-workflow-disclosure="true"
                style={{ position: "fixed", zIndex: 1300, width: expandedWidth, left: Math.max(12, (window.innerWidth - expandedWidth) / 2), top: 24, height: expandedHeight, background: theme.toolbar.panel, border: `1px solid ${theme.toolbar.border}`, borderRadius: 18, boxShadow: "0 18px 54px rgba(28, 25, 23, 0.2)", padding: 16, overflow: "hidden", color: theme.node.text }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            >
                <CustomWorkflowInlineDisclosure config={config} onConfigChange={onConfigChange} workflow={customWorkflow} onClose={() => setDisclosureOpen(false)} />
            </div>,
            document.body,
        );
    })() : null;
    const durationSummary = durationLocked ? `${i18n.t("settingsPanels.video.followSource")}${sourceDurationSeconds != null ? ` · ${sourceDurationSeconds.toFixed(1)}s` : ""}` : videoSecondsLabel(config.videoSeconds);

    return (
        <>
            {disclosure}
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[220px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {customWorkflow ? `${customWorkflowModeLabels[customWorkflowView(customWorkflow).mode]} · ` : ""}
                        {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)} · {durationSummary} · {videoModeLabel(config.videoMode)}{videoInterpolationLabel(config.videoInterpolation) ? ` · ${videoInterpolationLabel(config.videoInterpolation)}` : ""}{videoSelfLiftLabel(config.videoSelfLiftMode) ? ` · ${videoSelfLiftLabel(config.videoSelfLiftMode)}` : ""}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    customWorkflow,
    customParams,
    onCustomParamsChange,
    freeCardWorkflowSection,
    frameMode,
    onFrameModeChange,
    onModeChange,
    durationLocked,
    sourceDurationSeconds,
    referenceImageCount,
    vigglePrep,
    onPickSwapTarget,
    onEdit,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    customWorkflow?: CustomWorkflow | null;
    customParams?: Record<string, unknown>;
    onCustomParamsChange?: (params: Record<string, unknown>) => void;
    freeCardWorkflowSection?: Omit<FreeCardWorkflowSectionProps, "onEdit">;
    frameMode?: "first" | "last" | "both";
    onFrameModeChange?: (value: "first" | "last" | "both") => void;
    onModeChange?: (value: "text" | "frames" | "reference") => void;
    durationLocked?: boolean;
    sourceDurationSeconds?: number;
    referenceImageCount?: number;
    vigglePrep?: { phase?: "running" | "done" | "error"; frame?: number; pin?: string; similarity?: number };
    onPickSwapTarget?: () => void;
    onEdit?: () => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const view = customWorkflow ? customWorkflowView(customWorkflow) : null;
    useEffect(() => {
        if (!customWorkflow) return;
        void refreshWorkflowFieldOptions(config, customWorkflow).catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customWorkflow?.id]);
    const updateCustomValue = (key: string, value: unknown) => {
        const next = { ...(customParams || {}) };
        if (value === "" || value === undefined || value === null) delete next[key];
        else next[key] = value;
        onCustomParamsChange?.(next);
    };
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {freeCardWorkflowSection ? (
                <div className="mb-3">
                    <FreeCardWorkflowSection {...freeCardWorkflowSection} onEdit={onEdit} />
                </div>
            ) : customWorkflow ? (
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold" title={customWorkflow.name}>工作流 · {customWorkflow.name}</span>
                    <Button size="small" type="text" icon={<Settings2 className="size-3.5" />} onClick={onEdit}>编辑</Button>
                </div>
            ) : null}
            {view ? (
                <CustomWorkflowBlockList
                    config={config}
                    onConfigChange={(key, value) => onConfigChange(key, value)}
                    fields={view.params}
                    values={customParams || {}}
                    blocks={view.blocks || []}
                    spans={view.spans}
                    stages={view.stages}
                    disabledStages={view.disabledStages}
                    enabledGroups={view.enabledGroups}
                    onToggleStage={(id, on) => {
                        if (!customWorkflow) return;
                        if (id.startsWith("group:")) {
                            const groups = view.enabledGroups || [];
                            useCustomWorkflowStore.getState().setEnabledGroups(customWorkflow.id, on ? [...groups.filter((x) => x !== id), id] : groups.filter((x) => x !== id));
                            return;
                        }
                        const current = view.disabledStages || [];
                        useCustomWorkflowStore.getState().setDisabledStages(customWorkflow.id, on ? current.filter((x) => x !== id) : [...current, id]);
                    }}
                    showTitle
                    title="视频设置"
                    kind="video"
                    frameMode={frameMode}
                    onFrameModeChange={onFrameModeChange}
                    onModeChange={onModeChange}
                    durationLocked={durationLocked}
                    sourceDurationSeconds={sourceDurationSeconds}
                    onValueChange={updateCustomValue}
                />
            ) : (
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" frameMode={frameMode} onFrameModeChange={onFrameModeChange} onModeChange={onModeChange} durationLocked={durationLocked} sourceDurationSeconds={sourceDurationSeconds} referenceImageCount={referenceImageCount} vigglePrep={vigglePrep} onPickSwapTarget={onPickSwapTarget} />
            )}
        </div>,
        document.body,
    );
}
