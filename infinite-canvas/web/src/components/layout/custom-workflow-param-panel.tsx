import { useMemo, useState, type DragEvent } from "react";
import { Input, Select } from "antd";
import { GripVertical, Settings2, X } from "lucide-react";

import { ParamControl } from "@/components/canvas/custom-workflow-params-section";
import { ImageSettingsTheme, SettingTitle } from "@/components/image-settings-panel";
import { workflowFieldLabel } from "@/lib/canvas/custom-workflow-fields";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam } from "@/services/api/free-workflow";
import type { CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

type AvailableInput = { node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput };

type CustomWorkflowParamPanelProps = {
    fields: FreeWorkflowParam[];
    layout: string[];
    spans: Record<string, CustomWorkflowSpan>;
    availableInputs: AvailableInput[];
    onAddInput: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => string;
    onRemoveField: (key: string) => void;
    onUpdateField: (key: string, patch: Partial<FreeWorkflowParam>) => void;
    onReorderField: (key: string, index: number) => void;
    onSpanChange: (key: string, span: CustomWorkflowSpan) => void;
};

function spanOf(spans: Record<string, CustomWorkflowSpan>, key: string): CustomWorkflowSpan {
    return spans[key] || { w: 1, h: 1 };
}

export function CustomWorkflowParamPanel({ fields, layout, spans, availableInputs, onAddInput, onRemoveField, onUpdateField, onReorderField, onSpanChange }: CustomWorkflowParamPanelProps) {
    const theme = useCanvasTheme();
    const [expandedKey, setExpandedKey] = useState("");
    const [draggingKey, setDraggingKey] = useState("");
    const [paletteDrag, setPaletteDrag] = useState<AvailableInput | null>(null);
    const [overIndex, setOverIndex] = useState(-1);
    const fieldsByKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
    const ordered = useMemo(() => {
        const seen = new Set<string>();
        const result: FreeWorkflowParam[] = [];
        for (const key of layout) {
            const field = fieldsByKey.get(key);
            if (field && !seen.has(key)) {
                seen.add(key);
                result.push(field);
            }
        }
        for (const field of fields) if (!seen.has(field.key)) result.push(field);
        return result;
    }, [fields, fieldsByKey, layout]);
    const visible = draggingKey ? ordered.filter((field) => field.key !== draggingKey) : ordered;
    const dragGhost = (event: DragEvent<HTMLElement>, width = 180) => {
        const ghost = event.currentTarget.cloneNode(true) as HTMLElement;
        ghost.style.position = "fixed";
        ghost.style.top = "-1000px";
        ghost.style.left = "-1000px";
        ghost.style.width = `${width}px`;
        ghost.style.opacity = "0.9";
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 16, 16);
        window.setTimeout(() => ghost.remove(), 0);
    };
    const dragPillGhost = (event: DragEvent<HTMLElement>, label: string) => {
        const ghost = document.createElement("div");
        ghost.textContent = label;
        ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;border-radius:999px;background:#292524;color:#fafaf9;font:12px system-ui;border:1px solid #78716c;white-space:nowrap;";
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 14, 14);
        window.setTimeout(() => ghost.remove(), 0);
    };
    const dropAt = (index: number) => {
        if (paletteDrag) {
            const key = onAddInput(paletteDrag.node, paletteDrag.input, index);
            setExpandedKey(key);
            setPaletteDrag(null);
        } else if (draggingKey) {
            onReorderField(draggingKey, index);
            setExpandedKey(draggingKey);
            setDraggingKey("");
        }
        setOverIndex(-1);
    };
    const addFromPalette = (item: AvailableInput) => {
        const key = onAddInput(item.node, item.input, ordered.length);
        setExpandedKey(key);
    };
    return (
        <ImageSettingsTheme theme={theme}>
            <div className="flex h-full min-h-0 flex-col rounded-xl border p-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                <div className="flex items-center justify-between gap-2">
                    <SettingTitle color={theme.node.muted}>参数披露</SettingTitle>
                    <span className="rounded-full px-2 text-[10px]" style={{ background: theme.node.fill, color: theme.node.muted }}>{ordered.length}</span>
                </div>
                <div className="mb-2 text-[10px] leading-4" style={{ color: theme.node.muted }}>提示词、画幅、分辨率、尺寸、张数、种子由主卡接管。特殊参数拖进下方后会占位并挤开其他参数块。</div>
                <div className="mb-2 space-y-1.5">
                    <div className="text-[10px]" style={{ color: theme.node.muted }}>可披露参数</div>
                    {availableInputs.length ? (
                        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-0.5">
                            {availableInputs.map((item) => (
                                <div
                                    key={`${item.node.id}-${item.input.name}`}
                                    draggable
                                    onDragStart={(event) => {
                                        setPaletteDrag(item);
                                        event.dataTransfer.effectAllowed = "copy";
                                        dragGhost(event);
                                    }}
                                    onDragEnd={() => {
                                        setPaletteDrag(null);
                                        setOverIndex(-1);
                                    }}
                                    onClick={() => addFromPalette(item)}
                                    className="flex cursor-grab items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
                                    style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                                    title="拖到下方，或点一下加入"
                                >
                                    <GripVertical className="size-3" style={{ color: theme.node.muted }} />
                                    <span className="max-w-[120px] truncate">{workflowFieldLabel(item.node, item.input)}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-[10px]" style={{ color: theme.node.muted }}>常用特殊参数已加入，或在左侧节点图点星标添加。</div>
                    )}
                </div>
                <div
                    className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-xl p-1"
                    onDragOver={(event) => {
                        event.preventDefault();
                        setOverIndex(visible.length);
                    }}
                    onDrop={(event) => {
                        event.preventDefault();
                        dropAt(visible.length);
                    }}
                >
                    {visible.length || draggingKey || paletteDrag ? visible.map((field, index) => {
                        const span = spanOf(spans, field.key);
                        const expanded = expandedKey === field.key;
                        return (
                            <div
                                key={field.key}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setOverIndex(index);
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    dropAt(index);
                                }}
                            >
                                {(draggingKey || paletteDrag) && overIndex === index ? <div className="min-h-[46px] rounded-xl border-2 border-dashed border-emerald-400/70 bg-emerald-500/5" /> : null}
                                <div className="rounded-xl px-2.5 py-1.5" style={{ background: theme.node.fill, color: theme.node.text }}>
                                    <div className="flex items-center gap-2">
                                        <span
                                            draggable
                                            onDragStart={(event) => {
                                                setDraggingKey(field.key);
                                                event.dataTransfer.effectAllowed = "move";
                                                dragPillGhost(event, field.label);
                                            }}
                                            onDragEnd={() => {
                                                setDraggingKey("");
                                                setOverIndex(-1);
                                            }}
                                            className="shrink-0 cursor-grab"
                                        >
                                            <GripVertical className="size-3.5" style={{ color: theme.node.muted }} />
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.node.muted }} title={field.label}>{field.label}</span>
                                        <ParamControl param={field} value={field.value} onChange={(value) => onUpdateField(field.key, { value: value as FreeWorkflowParam["value"] })} theme={theme} />
                                        <button type="button" className="shrink-0 rounded p-0.5" style={{ color: theme.node.muted }} onClick={() => setExpandedKey(expanded ? "" : field.key)} aria-label="编辑参数"><Settings2 className="size-3.5" /></button>
                                        <button type="button" className="shrink-0 rounded p-0.5" style={{ color: theme.node.muted }} onClick={() => onRemoveField(field.key)} aria-label="移除参数"><X className="size-3.5" /></button>
                                    </div>
                                    {expanded ? (
                                        <div className="mt-2 grid gap-2 border-t pt-2 text-[11px] sm:grid-cols-2" style={{ borderColor: theme.node.stroke }}>
                                            <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>显示名</span><Input size="small" value={field.label} onChange={(event) => onUpdateField(field.key, { label: event.target.value })} /></label>
                                            <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>类型</span><Select size="small" className="w-full" value={field.type} options={[{ value: "number", label: "数字" }, { value: "select", label: "下拉" }, { value: "boolean", label: "开关" }, { value: "string", label: "文本" }]} onChange={(type) => onUpdateField(field.key, { type: type as FreeWorkflowParam["type"] })} /></label>
                                            {field.type === "number" ? (
                                                <>
                                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>最小</span><Input size="small" type="number" value={field.min ?? ""} onChange={(event) => onUpdateField(field.key, { min: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>最大</span><Input size="small" type="number" value={field.max ?? ""} onChange={(event) => onUpdateField(field.key, { max: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>步长</span><Input size="small" type="number" value={field.step ?? ""} onChange={(event) => onUpdateField(field.key, { step: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                                </>
                                            ) : null}
                                            {field.type === "select" ? <label className="space-y-0.5 sm:col-span-2"><span style={{ color: theme.node.muted }}>选项（逗号分隔）</span><Input size="small" value={(field.options || []).join(", ")} onChange={(event) => onUpdateField(field.key, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label> : null}
                                            <div className="flex flex-wrap items-center gap-1 sm:col-span-2" style={{ color: theme.node.muted }}>
                                                <span>宽 {span.w}</span>
                                                {[1, 2].map((w) => <button key={w} type="button" className={`rounded border px-1 ${span.w === w ? "opacity-100" : "opacity-60"}`} style={{ borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onSpanChange(field.key, { ...span, w: w as 1 | 2 })}>{w}</button>)}
                                                <span className="ml-1">高 {span.h}</span>
                                                {[1, 2].map((h) => <button key={h} type="button" className={`rounded border px-1 ${span.h === h ? "opacity-100" : "opacity-60"}`} style={{ borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onSpanChange(field.key, { ...span, h: h as 1 | 2 })}>{h}</button>)}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        );
                    }) : (
                        <div className="rounded-lg border border-dashed px-3 py-8 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>把上方参数拖进来，或点左侧节点图里的星标。</div>
                    )}
                    {(draggingKey || paletteDrag) && overIndex === visible.length ? <div className="min-h-[46px] rounded-xl border-2 border-dashed border-emerald-400/70 bg-emerald-500/5" /> : null}
                </div>
            </div>
        </ImageSettingsTheme>
    );
}
