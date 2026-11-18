import { Fragment, useMemo, useState, type DragEvent } from "react";
import { Input, Select } from "antd";
import { GripVertical, Settings2, X } from "lucide-react";

import { ParamControl } from "@/components/canvas/custom-workflow-params-section";
import { ImageSettingsTheme, SettingTitle } from "@/components/image-settings-panel";
import { workflowFieldLabel } from "@/lib/canvas/custom-workflow-fields";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam } from "@/services/api/free-workflow";
import type { CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

type AvailableInput = { node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput };

type CustomWorkflowBubblePanelProps = {
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

const TYPE_LABELS: Record<FreeWorkflowParam["type"], string> = {
    number: "数字",
    string: "文本",
    boolean: "开关",
    select: "下拉",
};

function spanOf(spans: Record<string, CustomWorkflowSpan>, key: string): CustomWorkflowSpan {
    return spans[key] || { w: 1, h: 1 };
}

export function CustomWorkflowBubblePanel({ fields, layout, spans, availableInputs, onAddInput, onRemoveField, onUpdateField, onReorderField, onSpanChange }: CustomWorkflowBubblePanelProps) {
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
    const expandedField = fields.find((field) => field.key === expandedKey) || null;
    const dragActive = Boolean(draggingKey || paletteDrag);
    const dragGhost = (event: DragEvent<HTMLElement>, label: string) => {
        const ghost = document.createElement("div");
        ghost.textContent = label;
        ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:8px 14px;border-radius:16px;background:#292524;color:#fafaf9;font:12px system-ui;border:1px solid #78716c;white-space:nowrap;";
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
        const key = onAddInput(item.node, item.input, visible.length);
        setExpandedKey(key);
    };
    const placeholder = <div className="min-h-[76px] rounded-2xl border-2 border-dashed border-emerald-400/70 bg-emerald-500/5" />;
    return (
        <ImageSettingsTheme theme={theme}>
            <div className="flex h-full min-h-0 flex-col rounded-xl border p-3" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                <div className="flex items-center justify-between gap-2">
                    <SettingTitle color={theme.node.muted}>参数披露</SettingTitle>
                    <span className="rounded-full px-2 text-[10px]" style={{ background: theme.node.fill, color: theme.node.muted }}>{ordered.length}</span>
                </div>
                <div className="mb-2 text-[10px] leading-4" style={{ color: theme.node.muted }}>像桌面图标一样：把参数泡泡拖到目标位置，其他泡泡会让位；点泡泡编辑。</div>
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
                                        dragGhost(event, workflowFieldLabel(item.node, item.input));
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
                    className="min-h-0 flex-1 overflow-y-auto rounded-xl"
                    onDragOver={(event) => {
                        event.preventDefault();
                        setOverIndex(visible.length);
                    }}
                    onDrop={(event) => {
                        event.preventDefault();
                        dropAt(visible.length);
                    }}
                >
                    {visible.length || dragActive ? (
                        <div className="grid grid-cols-2 gap-2">
                            {visible.map((field, index) => (
                                <Fragment key={field.key}>
                                    {dragActive && overIndex === index ? placeholder : null}
                                    <div
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
                                        draggable
                                        onDragStart={(event) => {
                                            setDraggingKey(field.key);
                                            event.dataTransfer.effectAllowed = "move";
                                            dragGhost(event, field.label);
                                        }}
                                        onDragEnd={() => {
                                            setDraggingKey("");
                                            setOverIndex(-1);
                                        }}
                                        onClick={() => setExpandedKey(field.key)}
                                        className="group flex min-h-[76px] cursor-grab flex-col justify-between rounded-2xl border p-2.5 transition-colors"
                                        style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                                    >
                                        <div className="flex items-start justify-between gap-1">
                                            <span className="line-clamp-2 text-xs leading-4" title={field.label}>{field.label}</span>
                                            <span className="shrink-0" style={{ color: theme.node.muted }}>
                                                <GripVertical className="size-3.5" />
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between gap-1 text-[10px]" style={{ color: theme.node.muted }}>
                                            <span className="min-w-0 truncate">{String(field.value ?? "—")}</span>
                                            <span className="shrink-0">{TYPE_LABELS[field.type]}</span>
                                            <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                <button type="button" className="rounded p-0.5 hover:text-stone-200" onClick={(event) => { event.stopPropagation(); setExpandedKey(field.key); }} aria-label="编辑参数"><Settings2 className="size-3" /></button>
                                                <button type="button" className="rounded p-0.5 hover:text-red-400" onClick={(event) => { event.stopPropagation(); onRemoveField(field.key); }} aria-label="移除参数"><X className="size-3" /></button>
                                            </span>
                                        </div>
                                    </div>
                                </Fragment>
                            ))}
                            {dragActive && overIndex === visible.length ? placeholder : null}
                        </div>
                    ) : (
                        <div className="rounded-lg border border-dashed px-3 py-8 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>把上方参数拖进来，或点左侧节点图里的星标。</div>
                    )}
                </div>
                {expandedField ? (
                    <div className="mt-2 shrink-0 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.node.text }}>{expandedField.label}</span>
                            <span className="text-[10px]" style={{ color: theme.node.muted }}>{expandedField.node}:{expandedField.input}</span>
                            <button type="button" className="rounded p-0.5" style={{ color: theme.node.muted }} onClick={() => setExpandedKey("")} aria-label="收起"><X className="size-3.5" /></button>
                        </div>
                        <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2">
                            <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>显示名</span><Input size="small" value={expandedField.label} onChange={(event) => onUpdateField(expandedField.key, { label: event.target.value })} /></label>
                            <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>默认值</span><ParamControl param={expandedField} value={expandedField.value} onChange={(value) => onUpdateField(expandedField.key, { value: value as FreeWorkflowParam["value"] })} theme={theme} /></label>
                            <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>类型</span><Select size="small" className="w-full" value={expandedField.type} options={[{ value: "number", label: "数字" }, { value: "select", label: "下拉" }, { value: "boolean", label: "开关" }, { value: "string", label: "文本" }]} onChange={(type) => onUpdateField(expandedField.key, { type: type as FreeWorkflowParam["type"] })} /></label>
                            {expandedField.type === "number" ? (
                                <>
                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>最小</span><Input size="small" type="number" value={expandedField.min ?? ""} onChange={(event) => onUpdateField(expandedField.key, { min: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>最大</span><Input size="small" type="number" value={expandedField.max ?? ""} onChange={(event) => onUpdateField(expandedField.key, { max: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                    <label className="space-y-0.5"><span style={{ color: theme.node.muted }}>步长</span><Input size="small" type="number" value={expandedField.step ?? ""} onChange={(event) => onUpdateField(expandedField.key, { step: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                </>
                            ) : null}
                            {expandedField.type === "select" ? <label className="space-y-0.5 sm:col-span-2"><span style={{ color: theme.node.muted }}>选项（逗号分隔）</span><Input size="small" value={(expandedField.options || []).join(", ")} onChange={(event) => onUpdateField(expandedField.key, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label> : null}
                            <div className="flex flex-wrap items-center gap-1 sm:col-span-2" style={{ color: theme.node.muted }}>
                                <span>宽 {spanOf(spans, expandedField.key).w}</span>
                                {[1, 2].map((w) => <button key={w} type="button" className={`rounded border px-1 ${spanOf(spans, expandedField.key).w === w ? "opacity-100" : "opacity-60"}`} style={{ borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onSpanChange(expandedField.key, { ...spanOf(spans, expandedField.key), w: w as 1 | 2 })}>{w}</button>)}
                                <span className="ml-1">高 {spanOf(spans, expandedField.key).h}</span>
                                {[1, 2].map((h) => <button key={h} type="button" className={`rounded border px-1 ${spanOf(spans, expandedField.key).h === h ? "opacity-100" : "opacity-60"}`} style={{ borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onSpanChange(expandedField.key, { ...spanOf(spans, expandedField.key), h: h as 1 | 2 })}>{h}</button>)}
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}
