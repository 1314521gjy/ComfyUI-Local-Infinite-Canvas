import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, OptionPill, SettingTitle, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { channelModelOf } from "@/stores/use-config-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onParamsChange?: (params: Record<string, unknown>) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: () => void;
    onOpenOutpaintEditor?: () => void;
    onOpenMossLayoutEditor?: () => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
};

const qwenModeLabels: Record<string, string> = { t2i: "文生图", edit: "多图编辑", inpaint: "局部重绘", outpaint: "扩图" };
const qwenModeHints: Record<string, string> = {
    t2i: "纯文生图：不需要参考图，按提示词生成完整画面",
    edit: "接 1–4 张参考图，按提示词编辑或融合；可跟随首图或手动选画布比例",
    inpaint: "选择后自动打开蒙版，只修改蒙版覆盖区域",
    outpaint: "打开扩图画布，拖图 / 滚轮调整扩图范围",
};
const editRatioOptions = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] as const;

function qwenCanvasSize(resolution: string | number, ratio: string) {
    const value = Number(resolution);
    const area = value > 0 ? value : 1024;
    const [width, height] = ratio.split(":").map(Number);
    if (!width || !height) return "";
    const snap = (number: number) => Math.max(256, Math.round(number / 32) * 32);
    return `${snap(Math.sqrt(area * area * (width / height)))}x${snap(Math.sqrt(area * area * (height / width)))}`;
}

function mossModelInfo(config: AiConfig) {
    const workflowId = channelModelOf(config, config.model)?.model.workflowId || "";
    return workflowId.startsWith("image-moss-sft-") ? { label: workflowId.includes("50step") ? "MOSS-Image 50步" : "MOSS-Image 8步" } : null;
}

function qwenModelInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (model?.workflowId !== "image-qwen21") return null;
    const modes = model.variantModes?.length ? model.variantModes : ["t2i", "edit", "inpaint", "outpaint"];
    return { modes, labels: { ...qwenModeLabels, ...(model.variantLabels || {}) } };
}

export function CanvasImageSettingsPopover({ config, onConfigChange, onParamsChange, onOpenChange, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor, buttonClassName, placement = "topLeft" }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const qwen = qwenModelInfo(config);
    const editCanvasRatio = String((config.params as Record<string, unknown> | undefined)?.editCanvasRatio || "auto");
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
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
    }, [onOpenChange, open]);

    const panel = open && buttonRect ? <ImageSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} onParamsChange={onParamsChange} onOpenMaskEditor={onOpenMaskEditor} onOpenOutpaintEditor={onOpenOutpaintEditor} onOpenMossLayoutEditor={onOpenMossLayoutEditor} onClose={() => updateOpen(false)} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => updateOpen(!open)}>
                    <span className="truncate">
                        {qwen ? `${qwen.labels[String(config.imageMode || "t2i")] || qwen.labels.t2i || qwen.labels.edit}${String(config.imageMode || "t2i") === "t2i" ? "" : String(config.imageMode || "t2i") === "edit" ? ` · ${editCanvasRatio === "auto" ? "跟随首图" : editCanvasRatio}` : " · 跟随原图"}` : `${imageSizeLabel(activeSize)} · ${t("canvas.controls.images", { count })}`}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    onParamsChange,
    onOpenMaskEditor,
    onOpenOutpaintEditor,
    onOpenMossLayoutEditor,
    onClose,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onParamsChange?: (params: Record<string, unknown>) => void;
    onOpenMaskEditor?: () => void;
    onOpenOutpaintEditor?: () => void;
    onOpenMossLayoutEditor?: () => void;
    onClose: () => void;
}) {
    const qwen = qwenModelInfo(config);
    const moss = mossModelInfo(config);
    const qwenMode = String(config.imageMode || "t2i");
    const refResolution = String((config.params as Record<string, unknown> | undefined)?.resolution ?? 1024);
    const editCanvasRatio = String((config.params as Record<string, unknown> | undefined)?.editCanvasRatio || "auto");
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
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
            {qwen ? (
                <div className="space-y-4">
                    <div className="text-lg font-semibold">Qwen Image 2.1</div>
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>功能</SettingTitle>
                        <div className="grid grid-cols-2 gap-2.5">
                            {["t2i", "edit", "inpaint", "outpaint"].filter((mode) => qwen.modes.includes(mode)).map((mode) => (
                                <OptionPill
                                    key={mode}
                                    selected={qwenMode === mode}
                                    theme={theme}
                                    onClick={() => {
                                        onConfigChange("imageMode", mode);
                                        if (mode === "inpaint" || mode === "outpaint") onClose();
                                        if (mode === "inpaint") onOpenMaskEditor?.();
                                        if (mode === "outpaint") onOpenOutpaintEditor?.();
                                    }}
                                >
                                    {qwen.labels[mode] || mode}
                                </OptionPill>
                            ))}
                        </div>
                        <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                            {qwenModeHints[qwenMode] || qwenModeHints.t2i}
                        </div>
                        {qwenMode === "t2i" ? (
                            <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" maxCount={10} />
                        ) : qwenMode === "edit" ? (
                            <div className="space-y-3">
                                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                                    <SettingTitle color={theme.node.muted}>画布比例</SettingTitle>
                                    <div className="grid grid-cols-3 gap-2">
                                        <OptionPill selected={editCanvasRatio === "auto"} theme={theme} onClick={() => onParamsChange?.({ editCanvasRatio: "auto", editCanvasSize: "" })}>
                                            跟随首图
                                        </OptionPill>
                                        {editRatioOptions.map((ratio) => (
                                            <OptionPill
                                                key={ratio}
                                                selected={editCanvasRatio === ratio}
                                                theme={theme}
                                                onClick={() => onParamsChange?.({ editCanvasRatio: ratio, editCanvasSize: qwenCanvasSize(refResolution, ratio) })}
                                            >
                                                {ratio}
                                            </OptionPill>
                                        ))}
                                    </div>
                                    <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                        跟随首图保持原输出尺寸；手动比例按当前参考分辨率生成画布（原始按 1k）。
                                    </div>
                                </div>
                                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                                    <SettingTitle color={theme.node.muted}>参考分辨率</SettingTitle>
                                    <div className="grid grid-cols-4 gap-2">
                                        {[
                                            ["1024", "1k"],
                                            ["1536", "1.5k"],
                                            ["2048", "2k"],
                                            ["0", "原始"],
                                        ].map(([value, label]) => (
                                            <OptionPill key={value} selected={refResolution === value} theme={theme} onClick={() => onParamsChange?.({ resolution: Number(value), ...(editCanvasRatio !== "auto" ? { editCanvasSize: qwenCanvasSize(value, editCanvasRatio) } : {}) })}>
                                                {label}
                                            </OptionPill>
                                        ))}
                                    </div>
                                    <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                        多图尺寸不同时各自按比例缩放；输出尺寸默认跟随第一张参考图，原始表示不缩放。
                                    </div>
                                </div>
                                <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" maxCount={10} showSize={false} />
                            </div>
                        ) : (
                            <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between gap-3">
                                    <SettingTitle color={theme.node.muted}>透明背景</SettingTitle>
                                    <Switch size="small" checked={config.background === "transparent"} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                                </div>
                                <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                    仅 Qwen Image 2.1 支持；透明输出保存为 PNG，保留 alpha。
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    {moss && onOpenMossLayoutEditor ? (
                        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <SettingTitle color={theme.node.muted}>区域布局</SettingTitle>
                            {config.imageMode === "layout" && config.layout ? (
                                <>
                                    <button
                                        type="button"
                                        className="h-9 w-full cursor-pointer rounded-full border text-sm transition hover:opacity-80"
                                        style={{ background: "transparent", borderColor: theme.node.text, color: theme.node.text }}
                                        onClick={() => {
                                            onClose();
                                            onOpenMossLayoutEditor();
                                        }}
                                    >
                                        编辑区域布局（{config.layout.regions.length} 个区域）
                                    </button>
                                    <button
                                        type="button"
                                        className="h-8 w-full cursor-pointer rounded-full border text-xs transition hover:opacity-80"
                                        style={{ background: "transparent", borderColor: theme.node.stroke, color: theme.node.muted }}
                                        onClick={() => onConfigChange("imageMode", "edit")}
                                    >
                                        切换普通文生图
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className="h-9 w-full cursor-pointer rounded-full border text-sm transition hover:opacity-80"
                                    style={{ background: "transparent", borderColor: theme.node.text, color: theme.node.text }}
                                    onClick={() => {
                                        onConfigChange("imageMode", "layout");
                                        onClose();
                                        onOpenMossLayoutEditor();
                                    }}
                                >
                                    打开区域布局编辑器
                                </button>
                            )}
                            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                {moss.label} · 画框并为每个区域单独填写提示词；背景框先画，主体/文字后画。普通文生图不会使用旧布局。
                            </div>
                        </div>
                    ) : null}
                    <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" maxCount={10} />
                </div>
            )}
        </div>,
        document.body,
    );
}
