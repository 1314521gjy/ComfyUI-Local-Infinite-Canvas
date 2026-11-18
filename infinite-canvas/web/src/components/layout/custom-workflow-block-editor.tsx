import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Input, Switch } from "antd";
import { GripVertical, X } from "lucide-react";
import { motion } from "motion/react";

import { ParamControl } from "@/components/canvas/custom-workflow-params-section";
import { ImageSettingsTheme, OptionPill, SettingTitle } from "@/components/image-settings-panel";
import { VideoInterpolationControl, VideoModeControl, VideoRatioControl, VideoResolutionControl, VideoSecondsControl, VideoSelfLiftControl, VideoSizeControl } from "@/components/video-settings-panel";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parsePixelSize } from "@/lib/media-size";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { CW_INPUT_MIME, workflowFieldLabel, zhNodeTitle } from "@/lib/canvas/custom-workflow-fields";
import type { FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";
import { IMAGE_GENERAL_BLOCKS, type CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

const GENERAL_LABELS: Record<string, string> = {
    "setting:size": "尺寸",
    "setting:resolution": "分辨率",
    "setting:ratio": "宽高比",
    "setting:transparent": "透明背景",
    "setting:count": "生成张数",
    "setting:seed": "固定种子",
    "setting:seconds": "秒数",
    "setting:interpolation": "插帧",
    "setting:mode": "模式",
    "setting:selflift": "精修",
};

const PLACEHOLDER_ID = "__cw_placeholder__";

type RailItem = { id: string; label: string };

type CustomWorkflowBlockListProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    fields: FreeWorkflowParam[];
    values: Record<string, unknown>;
    blocks: string[];
    spans?: Record<string, CustomWorkflowSpan>;
    editable?: boolean;
    railItems?: RailItem[];
    showTitle?: boolean;
    title?: string;
    kind?: "image" | "video";
    headerAction?: ReactNode;
    onValueChange?: (key: string, value: unknown) => void;
    onRemoveBlock?: (blockId: string) => void;
    onMoveBlock?: (blockId: string, index: number) => void;
    onAddRail?: (railId: string, index: number) => void;
    onAddInput?: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => void;
    stages?: Array<{ id: string; label: string; nodes: string[]; defaultOff?: boolean }>;
    disabledStages?: string[];
    enabledGroups?: string[];
    onToggleStage?: (id: string, enabled: boolean) => void;
    frameMode?: "first" | "last" | "both";
    onFrameModeChange?: (value: "first" | "last" | "both") => void;
    onModeChange?: (value: "text" | "frames" | "reference") => void;
    durationLocked?: boolean;
    sourceDurationSeconds?: number;
};

export function CustomWorkflowBlockList({ config, onConfigChange, fields, values, blocks, spans = {}, editable = false, railItems = [], showTitle = false, title, kind = "image", headerAction, onValueChange, onRemoveBlock, onMoveBlock, onAddRail, onAddInput, stages = [], disabledStages = [], enabledGroups = [], onToggleStage, frameMode, onFrameModeChange, onModeChange, durationLocked = false, sourceDurationSeconds }: CustomWorkflowBlockListProps) {
    const theme = useCanvasTheme();
    const [draggingId, setDraggingId] = useState("");
    const [railDrag, setRailDrag] = useState<RailItem | null>(null);
    const [externalDrag, setExternalDrag] = useState(false);
    const [overIndex, setOverIndex] = useState(-1);
    const overTimer = useRef<number | null>(null);
    const pendingOver = useRef(-1);
    const baseRects = useRef<Array<{ i: number; top: number; bottom: number; left: number; right: number }> | null>(null);
    const clearOverTimer = () => {
        if (overTimer.current !== null) {
            window.clearTimeout(overTimer.current);
            overTimer.current = null;
        }
        pendingOver.current = -1;
        baseRects.current = null;
    };
    // 停留 0.2s 才认定挤占位置，避免光标掠过边界时卡片弹来弹去。
    const scheduleOver = (index: number) => {
        if (pendingOver.current === index && overTimer.current !== null) return;
        if (overTimer.current !== null) window.clearTimeout(overTimer.current);
        pendingOver.current = index;
        overTimer.current = window.setTimeout(() => {
            overTimer.current = null;
            setOverIndex(index);
        }, 200);
    };
    const fieldMap = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
    const stageIds = useMemo(() => new Set(stages.map((stage) => `stage:${stage.id}`)), [stages]);
    const knownBlocks = useMemo(() => blocks.filter((id) => !id.startsWith("stage:") || stageIds.has(id)), [blocks, stageIds]);
    // 被拖块保留在原位（半透明），不卸载：dragend 必须能在源节点上触发，取消/Esc 才能恢复。
    const visible = knownBlocks;
    const dragActive = Boolean(draggingId || railDrag || externalDrag);
    useEffect(() => {
        if (!dragActive) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            setDraggingId("");
            setRailDrag(null);
            setExternalDrag(false);
            clearOverTimer();
            setOverIndex(-1);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dragActive]);
    const widthOf = (blockId: string) => {
        if (blockId.startsWith("stage:")) return 1;
        if (!blockId.startsWith("field:")) return 2;
        const key = blockId.slice("field:".length);
        const field = fieldMap.get(key);
        return spans[key]?.w ?? (field?.type === "string" ? 2 : 1);
    };
    // 拖拽预览：把占位符插进序列里一起参与弹性配对，落到块右侧时占位符与该块并排，把整行块压成半行。
    const preview = useMemo(() => {
        const items = visible.map((id, i) => ({ id, visibleIndex: i }));
        if (!dragActive) return items;
        const idx = Math.max(0, Math.min(overIndex < 0 ? visible.length : overIndex, visible.length));
        items.splice(idx, 0, { id: PLACEHOLDER_ID, visibleIndex: -1 });
        return items;
    }, [visible, dragActive, overIndex]);
    const baseWidth = (id: string) => (id === PLACEHOLDER_ID ? 1 : widthOf(id));
    // 弹性占位：相邻两个小参数共占一行；落单的小参数撑满整行。固定模板块恒为整行不被挤。
    const effectiveSpans = useMemo(() => {
        const result: number[] = [];
        let i = 0;
        while (i < preview.length) {
            if (baseWidth(preview[i].id) === 2) {
                result[i] = 2;
                i += 1;
            } else if (i + 1 < preview.length && baseWidth(preview[i + 1].id) === 1) {
                result[i] = 1;
                result[i + 1] = 1;
                i += 2;
            } else {
                result[i] = 2;
                i += 1;
            }
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preview, spans, fieldMap]);
    const dragPill = (event: DragEvent<HTMLElement>, label: string) => {
        const ghost = document.createElement("div");
        ghost.textContent = label;
        ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;border-radius:999px;background:#292524;color:#fafaf9;font:12px system-ui;border:1px solid #78716c;white-space:nowrap;";
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 14, 14);
        window.setTimeout(() => ghost.remove(), 0);
    };
    const dropAt = (index: number) => {
        if (railDrag) {
            onAddRail?.(railDrag.id, index);
            setRailDrag(null);
        } else if (draggingId) {
            // 源块还在 visible 里；向下拖时目标下标要减一，moveBlock 会先移除源块再插入。
            const sourceIndex = visible.findIndex((id) => id === draggingId);
            const target = sourceIndex >= 0 && sourceIndex < index ? index - 1 : index;
            onMoveBlock?.(draggingId, target);
            setDraggingId("");
        }
        setExternalDrag(false);
        clearOverTimer();
        setOverIndex(-1);
    };
    const readBlockRects = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>("[data-cw-block]")]
        .map((el) => {
            const r = el.getBoundingClientRect();
            return { i: Number(el.dataset.cwBlock), top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);
    const handleDragOver = (event: DragEvent<HTMLElement>, index: number) => {
        event.preventDefault();
        // 内部排序是 move；rail/节点图拖入是 copy。两者不匹配时浏览器会拒绝 drop。
        const external = event.dataTransfer.types.includes(CW_INPUT_MIME);
        event.dataTransfer.dropEffect = draggingId ? "move" : "copy";
        if (external) {
            // 外部拖入没有源块，占位符要立即跟随光标，不能等 200ms 或沿用旧矩形。
            setExternalDrag(true);
            if (overTimer.current !== null) {
                window.clearTimeout(overTimer.current);
                overTimer.current = null;
            }
            pendingOver.current = -1;
            setOverIndex(index);
        } else {
            scheduleOver(index);
        }
    };
    // 内部排序用拖动开始时冻结的矩形，避免占位符插入后块移动造成命中反馈振荡。
    // 外部拖入每次按实时矩形计算：没有源块要追踪，旧的冻结矩形/滚动只会把落点带到底部。
    const computeIndex = (event: DragEvent<HTMLElement>) => {
        const grid = event.currentTarget;
        const external = event.dataTransfer.types.includes(CW_INPUT_MIME);
        const rects = external ? readBlockRects(grid) : (baseRects.current ??= readBlockRects(grid));
        const x = event.clientX;
        const y = event.clientY;
        if (!rects.length) return 0;
        if (y < rects[0].top) return rects[0].i;
        const inRow = rects.filter((r) => y >= r.top && y <= r.bottom);
        if (inRow.length) {
            const target = inRow.find((r) => x >= r.left && x <= r.right)
                || inRow.reduce((best, r) => (Math.abs((r.left + r.right) / 2 - x) < Math.abs((best.left + best.right) / 2 - x) ? r : best), inRow[0]);
            return target.i + (x > (target.left + target.right) / 2 ? 1 : 0);
        }
        const below = rects.find((r) => r.top > y);
        return below ? below.i : visible.length;
    };
    const handleDrop = (event: DragEvent<HTMLElement>, index: number) => {
        event.preventDefault();
        event.stopPropagation();
        const raw = event.dataTransfer.getData(CW_INPUT_MIME);
        if (raw) {
            try {
                const payload = JSON.parse(raw) as { node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput };
                onAddInput?.(payload.node, payload.input, index);
            } catch {
                // 非法 payload 直接忽略
            }
            setExternalDrag(false);
            clearOverTimer();
            setOverIndex(-1);
            return;
        }
        dropAt(index);
    };
    const placeholder = <div className="min-h-[56px] rounded-xl border-2 border-dashed border-emerald-400/70 bg-emerald-500/5" />;
    const renderBlock = (blockId: string) => {
        if (blockId.startsWith("stage:")) {
            const stage = stages.find((item) => `stage:${item.id}` === blockId);
            if (!stage) return null;
            const checked = stage.defaultOff ? enabledGroups.includes(stage.id) : !disabledStages.includes(stage.id);
            return (
                <BlockShell key={blockId} label={stage.label} theme={theme} editable={editable} onRemove={() => onRemoveBlock?.(blockId)} onDragStart={(event) => { setDraggingId(blockId); event.dataTransfer.effectAllowed = "move"; dragPill(event, stage.label); }} onDragEnd={() => { setDraggingId(""); clearOverTimer(); setOverIndex(-1); }}>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px]" style={{ color: theme.node.muted }}>{checked ? "已启用" : "已关闭"}</span>
                        <Switch size="small" checked={checked} onChange={(on) => onToggleStage?.(stage.id, on)} />
                    </div>
                </BlockShell>
            );
        }
        if (blockId.startsWith("field:")) {
            const key = blockId.slice("field:".length);
            const field = fieldMap.get(key);
            if (!field) return null;
            return (
                <BlockShell key={blockId} label={fieldDisplayLabel(field)} theme={theme} editable={editable} onRemove={() => onRemoveBlock?.(blockId)} onDragStart={(event) => { setDraggingId(blockId); event.dataTransfer.effectAllowed = "move"; dragPill(event, fieldDisplayLabel(field)); }} onDragEnd={() => { setDraggingId(""); clearOverTimer(); setOverIndex(-1); }}>
                    <ParamControl param={field} value={values[key] ?? field.value} onChange={(value) => onValueChange?.(key, value)} theme={theme} />
                </BlockShell>
            );
        }
        const label = GENERAL_LABELS[blockId];
        if (!label) return null;
        return (
            <BlockShell key={blockId} label={label} theme={theme} editable={editable} onRemove={() => onRemoveBlock?.(blockId)} onDragStart={(event) => { setDraggingId(blockId); event.dataTransfer.effectAllowed = "move"; dragPill(event, label); }} onDragEnd={() => { setDraggingId(""); clearOverTimer(); setOverIndex(-1); }}>
                <GeneralBlock blockId={blockId} config={config} onConfigChange={onConfigChange} theme={theme} kind={kind} frameMode={frameMode} onFrameModeChange={onFrameModeChange} onModeChange={onModeChange} durationLocked={durationLocked} sourceDurationSeconds={sourceDurationSeconds} />
            </BlockShell>
        );
    };
    return (
        <ImageSettingsTheme theme={theme}>
            <div className="flex h-full min-h-0 flex-col gap-2" style={{ color: theme.node.text }}>
                {showTitle ? (
                    <div className="flex items-center justify-between gap-2">
                        <div className="text-lg font-semibold">{title || "图像设置"}</div>
                        {headerAction}
                    </div>
                ) : null}
                <div className="flex min-h-0 flex-1 gap-2">
                    <div
                        className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto pr-1"
                        onDragOver={(event) => handleDragOver(event, computeIndex(event))}
                        onDrop={(event) => handleDrop(event, computeIndex(event))}
                        onDragLeave={(event) => {
                            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                            setExternalDrag(false);
                            clearOverTimer();
                            setOverIndex(-1);
                        }}
                    >
                        {preview.length ? preview.map((item, index) => item.id === PLACEHOLDER_ID ? (
                            <motion.div
                                key={PLACEHOLDER_ID}
                                layout
                                transition={{ layout: { duration: 0.18, ease: "easeOut" } }}
                                className="min-w-0"
                                style={{ gridColumn: `span ${effectiveSpans[index] ?? 1}` }}
                            >
                                {placeholder}
                            </motion.div>
                        ) : (
                            <motion.div
                                key={item.id}
                                data-cw-block={item.visibleIndex}
                                data-cw-dragging={item.id === draggingId ? "true" : undefined}
                                layout={baseWidth(item.id) === 1}
                                transition={{ layout: { duration: 0.18, ease: "easeOut" } }}
                                className={`min-w-0 ${item.id === draggingId ? "opacity-40" : ""}`}
                                style={{ gridColumn: `span ${effectiveSpans[index] ?? 2}`, ...(item.id === draggingId ? { pointerEvents: "none" as const } : {}) }}
                            >
                                {renderBlock(item.id)}
                            </motion.div>
                        )) : (
                            <div className="col-span-2 rounded-xl border border-dashed px-3 py-8 text-center text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>从竖栏或节点图拖入参数</div>
                        )}
                    </div>
                    {editable ? (
                        <div className="flex w-20 shrink-0 flex-col items-stretch gap-1.5 overflow-y-auto" onDragOver={(event) => handleDragOver(event, visible.length)} onDrop={(event) => handleDrop(event, visible.length)}>
                            <div className="text-center text-[10px]" style={{ color: theme.node.muted }}>竖栏</div>
                            {railItems.map((item) => (
                                <div
                                    key={item.id}
                                    draggable
                                    onDragStart={(event) => {
                                        setRailDrag(item);
                                        event.dataTransfer.effectAllowed = "copy";
                                        dragPill(event, item.label);
                                    }}
                                    onDragEnd={() => {
                                        setRailDrag(null);
                                        clearOverTimer();
                                        setOverIndex(-1);
                                    }}
                                    onClick={() => onAddRail?.(item.id, blocks.length)}
                                    className="cursor-grab truncate rounded-full border px-2 py-1 text-center text-[10px]"
                                    style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                                    title={item.label}
                                >
                                    {item.label}
                                </div>
                            ))}
                            {!railItems.length ? <div className="text-center text-[10px]" style={{ color: theme.node.muted }}>空</div> : null}
                        </div>
                    ) : null}
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

function BlockShell({ label, theme, editable, onRemove, onDragStart, onDragEnd, children }: { label: string; theme: ReturnType<typeof useCanvasTheme>; editable: boolean; onRemove: () => void; onDragStart: (event: DragEvent<HTMLElement>) => void; onDragEnd: () => void; children: ReactNode }) {
    return (
        <div className="min-w-0 select-none rounded-xl border p-3" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}>
            <div className="mb-2 flex items-center gap-2">
                {editable ? <span draggable onDragStart={onDragStart} onDragEnd={onDragEnd} className="shrink-0 cursor-grab" style={{ color: theme.node.muted }}><GripVertical className="size-3.5" /></span> : null}
                <span className="min-w-0 flex-1 truncate"><SettingTitle color={theme.node.muted}>{label}</SettingTitle></span>
                {editable ? <button type="button" className="shrink-0 rounded p-0.5" style={{ color: theme.node.muted }} onClick={onRemove} aria-label={`移除 ${label}`}><X className="size-3.5" /></button> : null}
            </div>
            {children}
        </div>
    );
}

type GeneralBlockProps = {
    blockId: string;
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    theme: ReturnType<typeof useCanvasTheme>;
    kind: "image" | "video";
    frameMode?: "first" | "last" | "both";
    onFrameModeChange?: (value: "first" | "last" | "both") => void;
    onModeChange?: (value: "text" | "frames" | "reference") => void;
    durationLocked?: boolean;
    sourceDurationSeconds?: number;
};

function GeneralBlock({ blockId, config, onConfigChange, theme, kind, frameMode, onFrameModeChange, onModeChange, durationLocked, sourceDurationSeconds }: GeneralBlockProps) {
    if (kind === "video") {
        if (blockId === "setting:resolution") return <VideoResolutionControl config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:size") return <VideoSizeControl config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:ratio") return <VideoRatioControl config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:seconds") return <VideoSecondsControl config={config} onConfigChange={onConfigChange} theme={theme} durationLocked={durationLocked} sourceDurationSeconds={sourceDurationSeconds} />;
        if (blockId === "setting:seed") return <SeedBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:interpolation") return <VideoInterpolationControl config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:selflift") return <VideoSelfLiftControl config={config} onConfigChange={onConfigChange} theme={theme} />;
        if (blockId === "setting:mode") return <VideoModeControl config={config} onConfigChange={onConfigChange} theme={theme} frameMode={frameMode} onFrameModeChange={onFrameModeChange} onModeChange={onModeChange} />;
        return null;
    }
    if (blockId === "setting:size") return <SizeBlock config={config} onConfigChange={onConfigChange} />;
    if (blockId === "setting:resolution") return <ResolutionBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
    if (blockId === "setting:ratio") return <RatioBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
    if (blockId === "setting:transparent") return <TransparentBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
    if (blockId === "setting:count") return <CountBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
    if (blockId === "setting:seed") return <SeedBlock config={config} onConfigChange={onConfigChange} theme={theme} />;
    return null;
}

function SizeBlock({ config, onConfigChange }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void }) {
    const [snap, setSnap] = useState(true);
    const size = parsePixelSize(config.size || "") || { width: 1024, height: 1024 };
    const setDimension = (width: number, height: number) => {
        const align = (value: number) => (snap ? Math.max(16, Math.round(value / 16) * 16) : Math.max(1, Math.floor(value)));
        onConfigChange("size", `${align(width)}x${align(height)}`);
    };
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px]"><span style={{ color: "var(--block-muted, #a8a29e)" }}>16 倍数对齐</span><Switch size="small" checked={snap} onChange={setSnap} /></div>
            <div className="flex items-center gap-2">
                <span className="text-xs opacity-60">W</span>
                <Input size="small" type="number" value={size.width} onChange={(event) => setDimension(Number(event.target.value) || 1, size.height)} />
                <span className="opacity-50">↔</span>
                <span className="text-xs opacity-60">H</span>
                <Input size="small" type="number" value={size.height} onChange={(event) => setDimension(size.width, Number(event.target.value) || 1)} />
            </div>
        </div>
    );
}

function ResolutionBlock({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    const ratio = inferMediaRatio(config.size || "", "1:1");
    const selected = inferMediaScale(config.size || "");
    return <div className="grid grid-cols-4 gap-2">{mediaScaleOptions.map((scale) => <OptionPill key={scale} selected={selected === scale} theme={theme} onClick={() => onConfigChange("size", computeMediaSize(scale, ratio === "auto" ? "1:1" : ratio))}>{scale === "auto" ? "自动" : scale}</OptionPill>)}</div>;
}

function RatioBlock({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    const scale = inferMediaScale(config.size || "");
    const selected = inferMediaRatio(config.size || "", "1:1");
    return (
        <div className="grid grid-cols-4 gap-2">
            {mediaRatioOptions.map((item) => (
                <button key={item.value} type="button" className="flex h-[64px] flex-col items-center justify-center gap-1 rounded-xl border text-xs" style={{ borderColor: selected === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }} onClick={() => onConfigChange("size", item.value === "auto" ? "auto" : computeMediaSize(scale === "auto" ? "1k" : scale, item.value))}>
                    {item.value === "auto" ? <span>自动</span> : (
                        <>
                            <span className="block border" style={{ width: item.width >= item.height ? 24 : 24 * (item.width / item.height), height: item.height >= item.width ? 24 : 24 * (item.height / item.width), borderColor: theme.node.text }} />
                            <span>{item.value}</span>
                        </>
                    )}
                </button>
            ))}
        </div>
    );
}

function TransparentBlock({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-[11px]" style={{ color: theme.node.muted }}>透明背景（部分模型）</span>
            <Switch size="small" checked={config.background === "transparent"} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
        </div>
    );
}

function CountBlock({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-4 gap-2">{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>{value} 张</OptionPill>)}</div>
            <Input size="small" type="number" min={1} max={15} value={count} onChange={(event) => onConfigChange("count", String(Math.max(1, Math.min(15, Number(event.target.value) || 1))))} />
        </div>
    );
}

function SeedBlock({ config, onConfigChange, theme }: { config: AiConfig; onConfigChange: (key: keyof AiConfig, value: string) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    const fixed = String(config.seedFixed || "") === "true";
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[11px]" style={{ color: theme.node.muted }}>关闭随机，开启用下方种子</span>
                <Switch size="small" checked={fixed} onChange={(checked) => onConfigChange("seedFixed", checked ? "true" : "false")} />
            </div>
            {fixed ? <Input size="small" value={config.seed || ""} onChange={(event) => onConfigChange("seed", event.target.value.replace(/[^\d]/g, "").slice(0, 10))} placeholder="种子" /> : null}
        </div>
    );
}

export function buildRailItems(fields: FreeWorkflowParam[], blocks: string[], availableInputs: Array<{ node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput }>, general: string[] = IMAGE_GENERAL_BLOCKS, stages: Array<{ id: string; label: string }> = []): RailItem[] {
    const active = new Set(blocks);
    const generalItems = general.filter((id) => !active.has(id)).map((id) => ({ id, label: GENERAL_LABELS[id] }));
    const stageItems = stages.filter((stage) => !active.has(`stage:${stage.id}`)).map((stage) => ({ id: `stage:${stage.id}`, label: stage.label }));
    const inactive = fields.filter((field) => !active.has(`field:${field.key}`)).map((field) => ({ id: `field:${field.key}`, label: fieldDisplayLabel(field) }));
    const known = new Set(fields.map((field) => `${field.node}:${field.input}`));
    const inputs = availableInputs
        .filter((item) => !known.has(`${item.node.id}:${item.input.name}`))
        .map((item) => ({ id: `input:${item.node.id}:${item.input.name}`, label: `${workflowFieldLabel(item.node, item.input)} · ${zhNodeTitle(item.node.title)} #${item.node.id}` }));
    return [...generalItems, ...stageItems, ...inactive, ...inputs];
}

function fieldDisplayLabel(field: FreeWorkflowParam) {
    const group = String(field.group || "").trim();
    const nodeTitle = group ? zhNodeTitle(group) : "";
    return `${field.label}${nodeTitle ? ` · ${nodeTitle}` : ""} · #${field.node}`;
}
