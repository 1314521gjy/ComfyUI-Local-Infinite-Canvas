import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { App, Button, Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, OptionPill, SettingTitle, imageSizeLabel } from "@/components/image-settings-panel";
import { CustomWorkflowParamsSection } from "@/components/canvas/custom-workflow-params-section";
import { FreeCardWorkflowSection, type FreeCardWorkflowSectionProps } from "@/components/canvas/free-card-workflow-section";
import { CustomWorkflowBlockList } from "@/components/layout/custom-workflow-block-editor";
import { CustomWorkflowInlineDisclosure } from "@/components/layout/custom-workflow-inline-disclosure";
import { canvasThemes } from "@/lib/canvas-theme";
import { refreshWorkflowFieldOptions } from "@/lib/canvas/workflow-field-refresh";
import { inferMediaRatio, inferMediaScale, mediaRatioOptions, parsePixelSize, sizeForPixelBudget } from "@/lib/media-size";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { channelModelOf } from "@/stores/use-config-store";
import type { AiConfig } from "@/stores/use-config-store";
import { customWorkflowModeLabels, customWorkflowView, useCustomWorkflowStore, type CustomWorkflow, type CustomWorkflowMode } from "@/stores/use-custom-workflow-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onParamsChange?: (params: Record<string, unknown>) => void;
    customWorkflow?: CustomWorkflow | null;
    template?: string[];
    customParams?: Record<string, unknown>;
    onCustomParamsChange?: (params: Record<string, unknown>) => void;
    maskApplied?: boolean;
    maskSourceUrl?: string;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (sourceUrl?: string) => void;
    onOpenOutpaintEditor?: () => void;
    onOpenMossLayoutEditor?: () => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    freeCardWorkflowSection?: Omit<FreeCardWorkflowSectionProps, "onEdit">;
    hideMaskActions?: boolean;
};

const qwenModeLabels: Record<string, string> = { t2i: "文生图", edit: "多图编辑", inpaint: "局部重绘", outpaint: "扩图", remove: "元素移除" };
const qwenModeHints: Record<string, string> = {
    t2i: "纯文生图：不需要参考图，按提示词生成完整画面",
    edit: "接 1–10 张参考图，按提示词编辑或融合；可跟随首图或手动选画布比例",
    inpaint: "选择后自动打开蒙版，只修改蒙版覆盖区域",
    outpaint: "打开扩图画布，拖图 / 滚轮调整扩图范围",
    remove: "选择后自动打开蒙版；蒙版覆盖的物体整块移除",
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

function krea2ModeInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (model?.workflowId !== "image-krea2-turbo") return null;
    const raw = String((config.params as Record<string, unknown> | undefined)?.krea2Mode || "fast");
    return { mode: ["fast", "quality", "ultra"].includes(raw) ? raw : "fast" };
}

function zimageAccelInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (model?.workflowId !== "image-z-image-turbo") return null;
    const scale = inferMediaScale(config.size || "");
    return { scale, available: scale === "2k" || scale === "4k" };
}

function mossModelInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (model?.workflowId !== "image-moss-image") return null;
    const params = (config.params || {}) as Record<string, unknown>;
    const tier = ["fast", "quality", "ultra"].includes(String(params.mossTier)) ? String(params.mossTier) : "fast";
    const rawPrecision = String(params.mossPrecision || "").trim().toLowerCase();
    const precision = rawPrecision === "on" || rawPrecision === "int8" ? "on" : "off";
    return {
        model,
        label: "MOSS-Image",
        tier,
        precision,
        rawPrecision,
        tiers: model.moss?.tiers || {},
        precisionAvailability: model.moss?.precision || { bf16: true, int8: true },
    };
}

function qwenModelInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    const workflowId = model?.workflowId || "";
    if (!["image-qwen21", "image-qwen21-old"].includes(workflowId)) return null;
    const modes = model?.variantModes?.length ? model.variantModes : ["t2i", "edit", "inpaint", "outpaint"];
    return { modes, title: model?.label || "", labels: { ...qwenModeLabels, ...(model?.variantLabels || {}) } };
}

function qwenHybridModeInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (model?.workflowId !== "image-qwen21") return null;
    if (!["t2i", "edit"].includes(String(config.imageMode || "t2i"))) return null;
    const raw = String((config.params as Record<string, unknown> | undefined)?.qwenT2iMode || "fast");
    return { mode: ["fast", "quality", "ultra"].includes(raw) ? raw : "fast" };
}

const genericModeLabels: Record<string, string> = { t2i: "文生图", edit: "指令编辑" };

/** 任何在网关注册了多个功能变体的工作流都走这里，不再按 workflowId 逐个硬编码。 */
function variantModeInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    if (!model?.workflowId || model.workflowId === "image-qwen21") return null;
    const modes = (model.variantModes || []).filter(Boolean);
    if (modes.length < 2) return null;
    const active = String(config.imageMode || model.defaultMode || modes[0]);
    return { modes, active, labels: { ...genericModeLabels, ...(model.variantLabels || {}) }, descriptions: model.variantDescriptions || {} };
}

/** 档位像素受画布全局上限约束（最长边 3840、总像素 ≤ 8294400），超了就按 32 步往下收。 */
function tierSize(pixels: number, ratio: string, model?: { workflowId?: string }) {
    const h3Image = model?.workflowId === "image-h3image";
    return sizeForPixelBudget(pixels, ratio, 4194304, h3Image ? { maxPixels: 16777216, maxEdge: 8192 } : undefined);
}

/** 网关工作流声明了 resolutionTiers 时，分辨率只给这几档，画布比例仍然可选。 */
function resolutionTierInfo(config: AiConfig) {
    const model = channelModelOf(config, config.model)?.model;
    const tiers = model?.resolutionTiers || [];
    if (!model || tiers.length < 2) return null;
    const pixels = parsePixelSize(config.size || "");
    const area = pixels ? pixels.width * pixels.height : 0;
    const defaultTier = model.workflowId === "image-h3image" && config.imageMode === "edit" ? "4MP" : model.defaultTier;
    const fallback = tiers.find((tier) => tier.label === defaultTier) || tiers[tiers.length - 1];
    const active = area ? tiers.reduce((best, tier) => (Math.abs((tier.pixels || 0) - area) < Math.abs((best.pixels || 0) - area) ? tier : best), tiers[0]) : fallback;
    const ratio = inferMediaRatio(config.size || "", "1:1");
    return { tiers, active, ratio, sizes: (tier: (typeof tiers)[number]) => tierSize(tier.pixels || 4194304, ratio, model) };
}

export function CanvasImageSettingsPopover({ config, onConfigChange, onParamsChange, customWorkflow, template, customParams, onCustomParamsChange, maskApplied, maskSourceUrl, onOpenChange, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor, buttonClassName, placement = "topLeft", freeCardWorkflowSection, hideMaskActions }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const qwen = qwenModelInfo(config);
    const variant = variantModeInfo(config);
    const tierInfo = resolutionTierInfo(config);
    const editCanvasRatio = String((config.params as Record<string, unknown> | undefined)?.editCanvasRatio || "auto");
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (document.querySelector("[data-custom-workflow-disclosure='true']")) return;
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            // antd 下拉/弹层挂在 body 上、不在面板内，点选项不应关闭设置面板
            if (target instanceof Element && target.closest(".ant-select-dropdown, .ant-popover, .ant-dropdown, .ant-picker-dropdown, .ant-cascader-dropdown, .ant-modal-wrap, .ant-image-preview-wrap, .ant-tooltip, .ant-message, .ant-notification")) return;
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

    const panel = open && buttonRect ? <ImageSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} onParamsChange={onParamsChange} customWorkflow={customWorkflow} template={template} customParams={customParams} onCustomParamsChange={onCustomParamsChange} maskApplied={maskApplied} maskSourceUrl={maskSourceUrl} onOpenMaskEditor={onOpenMaskEditor} onOpenOutpaintEditor={onOpenOutpaintEditor} onOpenMossLayoutEditor={onOpenMossLayoutEditor} freeCardWorkflowSection={freeCardWorkflowSection} hideMaskActions={hideMaskActions} onClose={() => updateOpen(false)} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => updateOpen(!open)}>
                    <span className="truncate">
                        {customWorkflow ? `${customWorkflowModeLabels[customWorkflowView(customWorkflow).mode]} · ${imageSizeLabel(activeSize)} · ${t("canvas.controls.images", { count })}` : qwen ? `${qwen.labels[String(config.imageMode || "t2i")] || qwen.labels.t2i || qwen.labels.edit}${String(config.imageMode || "t2i") === "t2i" ? "" : String(config.imageMode || "t2i") === "edit" ? ` · ${editCanvasRatio === "auto" ? "跟随首图" : editCanvasRatio}` : " · 跟随原图"}` : variant || tierInfo ? `${[variant?.labels[variant.active], tierInfo?.active.label].filter(Boolean).join(" · ")} · ${t("canvas.controls.images", { count })}` : `${imageSizeLabel(activeSize)} · ${t("canvas.controls.images", { count })}`}
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
    customWorkflow,
    template,
    customParams,
    onCustomParamsChange,
    maskApplied,
    maskSourceUrl,
    onOpenMaskEditor,
    onOpenOutpaintEditor,
    onOpenMossLayoutEditor,
    freeCardWorkflowSection,
    hideMaskActions,
    onClose,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onParamsChange?: (params: Record<string, unknown>) => void;
    customWorkflow?: CustomWorkflow | null;
    template?: string[];
    customParams?: Record<string, unknown>;
    onCustomParamsChange?: (params: Record<string, unknown>) => void;
    maskApplied?: boolean;
    maskSourceUrl?: string;
    onOpenMaskEditor?: (sourceUrl?: string) => void;
    onOpenOutpaintEditor?: () => void;
    onOpenMossLayoutEditor?: () => void;
    freeCardWorkflowSection?: Omit<FreeCardWorkflowSectionProps, "onEdit">;
    hideMaskActions?: boolean;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    useEffect(() => {
        if (!customWorkflow) return;
        void refreshWorkflowFieldOptions(config, customWorkflow).catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customWorkflow?.id]);
    const [disclosureOpen, setDisclosureOpen] = useState(false);
    const qwen = qwenModelInfo(config);
    const qwenHybrid = qwenHybridModeInfo(config);
    const moss = mossModelInfo(config);
    const mossCanBf16 = moss?.precisionAvailability.bf16 !== false;
    const mossCanInt8 = moss?.precisionAvailability.int8 !== false;
    const mossPrecisionBoth = mossCanBf16 && mossCanInt8;
    const mossPrecisionNone = Boolean(moss) && !mossCanBf16 && !mossCanInt8;
    const mossPrecisionForced = mossPrecisionBoth || mossPrecisionNone ? null : mossCanInt8 ? "on" : "off";
    const mossPrecisionValue = mossPrecisionForced || moss?.precision || "off";
    const mossPrecisionIndex = mossPrecisionValue === "on" ? 1 : 0;
    useEffect(() => {
        if (!moss || mossPrecisionNone) return;
        const desired = mossPrecisionForced || moss.precision;
        if (moss.rawPrecision !== desired) onParamsChange?.({ mossPrecision: desired });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [moss?.rawPrecision, moss?.precision, mossPrecisionForced, mossPrecisionNone]);
    const variant = variantModeInfo(config);
    const tiers = resolutionTierInfo(config);
    const qwenMode = String(config.imageMode || "t2i");
    const refResolution = String((config.params as Record<string, unknown> | undefined)?.resolution ?? 1024);
    const zimageAccel = zimageAccelInfo(config);
    const krea2 = krea2ModeInfo(config);
    const rawKrea2Accel = Number((config.params as Record<string, unknown> | undefined)?.krea2AccelT);
    const krea2AccelIndex = rawKrea2Accel === 5 ? 1 : rawKrea2Accel === 6 ? 2 : rawKrea2Accel === 7 ? 3 : 0;
    const rawAccelT = Number((config.params as Record<string, unknown> | undefined)?.zimageAccelT);
    const zimageAccelOn = rawAccelT === 5 || rawAccelT === 6 || rawAccelT === 7;
    const editCanvasRatio = String((config.params as Record<string, unknown> | undefined)?.editCanvasRatio || "auto");
    const includesModule = (id: string) => !template || template.includes(id);
    const editWorkflowAction = customWorkflow && !freeCardWorkflowSection ? <Button size="small" type="text" icon={<Settings2 className="size-3.5" />} onClick={() => setDisclosureOpen(true)}>编辑</Button> : undefined;
    const updateCustomValue = (key: string, value: unknown) => {
        const next = { ...(customParams || {}) };
        if (value === "" || value === undefined || value === null) delete next[key];
        else next[key] = value;
        onCustomParamsChange?.(next);
    };
    const hybridTiers = qwenHybrid ? (
        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
            <div className="grid grid-cols-3 gap-2.5">
                {([["fast", "快速"], ["quality", "质量"], ["ultra", "极致"]] as const).map(([value, label]) => (
                    <OptionPill key={value} selected={qwenHybrid.mode === value} theme={theme} onClick={() => onParamsChange?.({ qwenT2iMode: value })}>
                        {label}
                    </OptionPill>
                ))}
            </div>
        </div>
    ) : null;
    const workflowPageSelector = customWorkflow && customWorkflow.kind === "image" && customWorkflow.flows && customWorkflow.flows.length > 1 ? (
        <div className="grid grid-cols-2 gap-2">
            {customWorkflow.flows.map((flow) => {
                const active = (customWorkflow.flowId || customWorkflow.flows?.find((item) => item.main)?.id) === flow.id;
                return (
                    <span key={flow.id} className="block min-w-0 [&>button]:w-full [&>button]:overflow-hidden [&>button]:whitespace-nowrap [&>button]:px-3" title={flow.label || flow.id}>
                        <OptionPill
                            selected={active}
                            theme={theme}
                            onClick={() => {
                                useCustomWorkflowStore.getState().setFlowId(customWorkflow.id, flow.id);
                                if (hideMaskActions || !flow.maskInputs) return;
                                if (!maskSourceUrl) {
                                    message.warning("这张卡片还没有底图：先连接或生成一张图，再做局部编辑");
                                    return;
                                }
                                useCustomWorkflowStore.getState().setPageMode(customWorkflow.id, flow.id, "edit");
                                onClose();
                                onOpenMaskEditor?.(maskSourceUrl);
                            }}
                        >
                            <span className="block min-w-0 overflow-hidden text-ellipsis">{flow.label || flow.id}</span>
                        </OptionPill>
                    </span>
                );
            })}
        </div>
    ) : null;
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

    if (disclosureOpen && customWorkflow) {
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
    }

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {freeCardWorkflowSection ? <div className="mb-3"><FreeCardWorkflowSection {...freeCardWorkflowSection} pageSelector={workflowPageSelector} onEdit={() => setDisclosureOpen(true)} /></div> : null}
            {qwen ? (
                <div className="space-y-4">
                    <div className="text-lg font-semibold">{qwen.title || "Qwen Image 2.1"}</div>
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>功能</SettingTitle>
                        <div className="grid grid-cols-2 gap-2.5">
                            {["t2i", "edit", "inpaint", "outpaint", "remove"].filter((mode) => qwen.modes.includes(mode)).map((mode) => (
                                <OptionPill
                                    key={mode}
                                    selected={qwenMode === mode}
                                    theme={theme}
                                    onClick={() => {
                                        onConfigChange("imageMode", mode);
                                        if (mode === "inpaint" || mode === "outpaint" || mode === "remove") onClose();
                                        if (mode === "inpaint" || mode === "remove") onOpenMaskEditor?.();
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
                            <>
                                {hybridTiers}
                                <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} params={config.params} onParamsChange={onParamsChange} theme={theme} className="space-y-4" maxCount={10} />
                            </>
                        ) : qwenMode === "edit" ? (
                            <div className="space-y-3">
                                {hybridTiers}
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
                                <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} params={config.params} onParamsChange={onParamsChange} theme={theme} className="space-y-4" maxCount={10} showSize={false} />
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
                    {moss ? (
                        <>
                            <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                                <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
                                <div className="grid grid-cols-3 gap-2.5">
                                    {([
                                        ["fast", "快速"],
                                        ["quality", "质量"],
                                        ["ultra", "极致"],
                                    ] as const).map(([value, label]) => {
                                        const status = moss.tiers[value];
                                        return (
                                            <OptionPill key={value} selected={moss.tier === value} disabled={status?.available === false} theme={theme} onClick={() => onParamsChange?.({ mossTier: value })}>
                                                {label}
                                            </OptionPill>
                                        );
                                    })}
                                </div>
                                {moss.tiers.quality?.available === false ? <div className="text-xs leading-4" style={{ color: theme.node.muted }}>{moss.tiers.quality.reason || "12步加速 LoRA 未安装"}</div> : null}
                                {moss.tiers.quality?.available === true ? <div className="text-xs leading-4" style={{ color: theme.node.muted }}>质量档 12 步：资源就绪，画质与显存待真跑验证</div> : null}
                            </div>
                            {mossPrecisionNone ? (
                                <div className="rounded-xl border p-3 text-xs leading-4" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                    MOSS 精度模型未安装（bf16/int8 均缺），无法选择关闭/开启
                                </div>
                            ) : (
                                <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                                    <SettingTitle color={theme.node.muted}>加速</SettingTitle>
                                    <Slider
                                        min={0}
                                        max={1}
                                        step={1}
                                        value={mossPrecisionIndex}
                                        disabled={!mossPrecisionBoth}
                                        onChange={(value) => onParamsChange?.({ mossPrecision: value === 1 ? "on" : "off" })}
                                        marks={{ 0: "关闭", 1: "开启" }}
                                        tooltip={{ formatter: (value) => (value === 1 ? "开启：使用 int8 精度" : "关闭：使用 bf16 精度") }}
                                    />
                                    {mossPrecisionForced === "off" ? <div className="text-xs leading-4" style={{ color: theme.node.muted }}>int8 精度模型未安装，无法开启（当前使用 bf16）</div> : null}
                                    {mossPrecisionForced === "on" ? <div className="text-xs leading-4" style={{ color: theme.node.muted }}>bf16 精度模型未安装，无法关闭（当前使用 int8）</div> : null}
                                </div>
                            )}
                        </>
                    ) : null}
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
                    {variant ? (
                        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <SettingTitle color={theme.node.muted}>功能</SettingTitle>
                            <div className="grid grid-cols-2 gap-2.5">
                                {variant.modes.map((mode) => (
                                    <OptionPill key={mode} selected={variant.active === mode} theme={theme} onClick={() => onConfigChange("imageMode", mode)}>
                                        {variant.labels[mode] || mode}
                                    </OptionPill>
                                ))}
                            </div>
                            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                {variant.descriptions[variant.active] || "切换后按对应链路生成；参考图会作为编辑输入。"}
                            </div>
                        </div>
                    ) : null}
                    {tiers ? (
                        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <SettingTitle color={theme.node.muted}>分辨率</SettingTitle>
                            <div className="grid grid-cols-2 gap-2.5">
                                {tiers.tiers.map((tier) => (
                                    <OptionPill key={tier.label} selected={tiers.active.label === tier.label} theme={theme} onClick={() => onConfigChange("size", tiers.sizes(tier))}>
                                        {tier.label}
                                    </OptionPill>
                                ))}
                            </div>
                            <SettingTitle color={theme.node.muted}>画布比例</SettingTitle>
                            <div className="grid grid-cols-4 gap-2">
                                {mediaRatioOptions
                                    .filter((item) => item.value !== "auto")
                                    .map((item) => (
                                        <OptionPill key={item.value} selected={tiers.ratio === item.value} theme={theme} onClick={() => onConfigChange("size", tierSize(tiers.active.pixels || 4194304, item.value))}>
                                            {item.value}
                                        </OptionPill>
                                    ))}
                            </div>
                            <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                {`${tiers.active.label} ≈ ${tiers.active.anchor || ""} · ${tiers.active.seconds || ""} · 当前 ${tiers.sizes(tiers.active)}`}
                            </div>
                        </div>
                    ) : null}
                    {customWorkflow && customWorkflow.kind === "image" && !freeCardWorkflowSection ? (
                        <div className="mb-2 space-y-2.5">
                            <SettingTitle color={theme.node.muted}>工作流</SettingTitle>
                            {workflowPageSelector}
                        </div>
                    ) : null}
                    {customWorkflow?.blocks?.length ? (
                        <CustomWorkflowBlockList
                            config={config}
                            onConfigChange={(key, value) => onConfigChange(key, value)}
                            fields={customWorkflowView(customWorkflow).params}
                            values={customParams || {}}
                            blocks={customWorkflowView(customWorkflow).blocks || []}
                            spans={customWorkflowView(customWorkflow).spans}
                            stages={customWorkflowView(customWorkflow).stages}
                            disabledStages={customWorkflowView(customWorkflow).disabledStages}
                            enabledGroups={customWorkflowView(customWorkflow).enabledGroups}
                            onToggleStage={(id, on) => {
                                if (id.startsWith("group:")) {
                                    const groups = customWorkflowView(customWorkflow).enabledGroups || [];
                                    useCustomWorkflowStore.getState().setEnabledGroups(customWorkflow.id, on ? [...groups.filter((x) => x !== id), id] : groups.filter((x) => x !== id));
                                    return;
                                }
                                const current = customWorkflowView(customWorkflow).disabledStages || [];
                                useCustomWorkflowStore.getState().setDisabledStages(customWorkflow.id, on ? current.filter((x) => x !== id) : [...current, id]);
                            }}
                            showTitle
                            headerAction={editWorkflowAction}
                            onValueChange={updateCustomValue}
                        />
                    ) : (
                        <>
                        {krea2 && !customWorkflow?.blocks?.length ? (
                            <div className="space-y-2.5">
                                <SettingTitle color={theme.node.muted}>生成档位</SettingTitle>
                                <div className="grid grid-cols-3 gap-2.5">
                                    {([["fast", "快速"], ["quality", "质量"], ["ultra", "极致"]] as const).map(([value, label]) => (
                                        <OptionPill key={value} selected={krea2.mode === value} theme={theme} onClick={() => onParamsChange?.({ krea2Mode: value })}>
                                            {label}
                                        </OptionPill>
                                    ))}
                                </div>
                                <SettingTitle color={theme.node.muted}>生成加速</SettingTitle>
                                <Slider
                                    min={0}
                                    max={3}
                                    step={1}
                                    value={krea2AccelIndex}
                                    onChange={(value) => onParamsChange?.({ krea2AccelT: [0, 5, 6, 7][value] ?? 0 })}
                                    marks={{ 0: "关闭", 1: "低", 2: "中", 3: "高" }}
                                    tooltip={{ formatter: (value) => ["关闭", "低", "中", "高"][value ?? 0] }}
                                />
                            </div>
                        ) : null}
                        <ImageSettingsPanel
                            config={config}
                            onConfigChange={(key, value) => onConfigChange(key, value)}
                            params={config.params}
                            onParamsChange={onParamsChange}
                            theme={theme}
                            className="space-y-4"
                            maxCount={10}
                            showSize={!tiers && includesModule("settings:size")}
                            showResolution={template ? includesModule("settings:resolution") : undefined}
                            showRatio={template ? includesModule("settings:ratio") : undefined}
                            showTransparent={template ? includesModule("settings:transparent") : undefined}
                            showCount={template ? includesModule("settings:count") : undefined}
                            showSeed={template ? includesModule("settings:seed") : undefined}
                            headerAction={editWorkflowAction}
                        />
                        </>
                    )}
                    {zimageAccel && !customWorkflow?.blocks?.length ? (
                        <div className="space-y-2.5 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <SettingTitle color={theme.node.muted}>生图加速</SettingTitle>
                            <Slider
                                min={0}
                                max={1}
                                step={1}
                                value={zimageAccelOn ? 1 : 0}
                                disabled={!zimageAccel.available}
                                onChange={(value) => onParamsChange?.({ zimageAccelT: value === 1 ? 5 : 0 })}
                                marks={{ 0: "关闭", 1: "开启" }}
                                tooltip={{ formatter: (value) => (value === 1 ? "开启" : "关闭") }}
                            />
                        </div>
                    ) : null}
                    {customWorkflow && !customWorkflow.blocks?.length ? (
                        <CustomWorkflowParamsSection workflow={customWorkflow} values={customParams || {}} theme={theme} onChange={onCustomParamsChange || (() => undefined)} />
                    ) : null}
                </div>
            )}
        </div>,
        document.body,
    );
}
