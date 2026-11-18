import { useMemo, useState, type DragEvent } from "react";
import { Input, Select, Tag } from "antd";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";

import type { FreeWorkflowParam } from "@/services/api/free-workflow";
import type { CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

type CustomWorkflowCapsulePanelProps = {
    fields: FreeWorkflowParam[];
    layout: string[];
    spans: Record<string, CustomWorkflowSpan>;
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

export function CustomWorkflowCapsulePanel({ fields, layout, spans, onRemoveField, onUpdateField, onReorderField, onSpanChange }: CustomWorkflowCapsulePanelProps) {
    const [expandedKey, setExpandedKey] = useState("");
    const [draggingKey, setDraggingKey] = useState("");
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
    const dragStart = (event: DragEvent<HTMLDivElement>, field: FreeWorkflowParam) => {
        setDraggingKey(field.key);
        event.dataTransfer.effectAllowed = "move";
        const ghost = event.currentTarget.cloneNode(true) as HTMLElement;
        ghost.style.position = "fixed";
        ghost.style.top = "-1000px";
        ghost.style.left = "-1000px";
        ghost.style.width = "180px";
        ghost.style.opacity = "0.9";
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 16, 16);
        window.setTimeout(() => ghost.remove(), 0);
    };
    const dropAt = (index: number) => {
        if (!draggingKey) return;
        onReorderField(draggingKey, index);
        setExpandedKey(draggingKey);
        setDraggingKey("");
        setOverIndex(-1);
    };
    return (
        <div className="flex h-full min-h-0 flex-col rounded-xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-stone-500">参数释放区</div>
                <Tag>{ordered.length}</Tag>
            </div>
            <div className="mb-2 text-[10px] leading-4 text-stone-400 dark:text-stone-500">参数以胶囊展示；按住拖动会变成小胶囊，放到目标位置后展开成参数块。点胶囊也可展开。</div>
            <div
                className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1"
                onDragOver={(event) => {
                    event.preventDefault();
                    setOverIndex(ordered.length);
                }}
                onDrop={(event) => {
                    event.preventDefault();
                    dropAt(ordered.length);
                }}
            >
                {ordered.length ? ordered.map((field, index) => {
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
                            {draggingKey && overIndex === index ? <div className="mb-1 h-0.5 rounded bg-emerald-400" /> : null}
                            {expanded ? (
                                <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 p-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/10">
                                    <div className="flex items-center gap-1.5">
                                        <GripVertical className="size-3.5 shrink-0 cursor-grab text-stone-400" />
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={field.label}>{field.label}</span>
                                        <span className="shrink-0 text-[10px] text-stone-400">{field.node}:{field.input}</span>
                                        <button type="button" className="shrink-0 rounded p-0.5 text-stone-400 hover:text-stone-600" onClick={() => setExpandedKey("")} aria-label="收起"><ChevronUp className="size-3.5" /></button>
                                        <button type="button" className="shrink-0 rounded p-0.5 text-stone-400 hover:text-red-500" onClick={() => onRemoveField(field.key)} aria-label="移除"><X className="size-3.5" /></button>
                                    </div>
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-stone-400">
                                        <span>宽 {span.w}</span>
                                        {[1, 2].map((w) => <button key={w} type="button" className={`rounded border px-1 ${span.w === w ? "border-stone-500 text-stone-700 dark:border-stone-300 dark:text-stone-100" : "border-stone-200 dark:border-stone-700"}`} onClick={() => onSpanChange(field.key, { ...span, w: w as 1 | 2 })}>{w}</button>)}
                                        <span className="ml-1">高 {span.h}</span>
                                        {[1, 2].map((h) => <button key={h} type="button" className={`rounded border px-1 ${span.h === h ? "border-stone-500 text-stone-700 dark:border-stone-300 dark:text-stone-100" : "border-stone-200 dark:border-stone-700"}`} onClick={() => onSpanChange(field.key, { ...span, h: h as 1 | 2 })}>{h}</button>)}
                                    </div>
                                    <div className="mt-2 grid gap-2 border-t border-stone-200 pt-2 text-[11px] dark:border-stone-800 sm:grid-cols-2">
                                        <label className="space-y-0.5"><span className="text-stone-400">显示名</span><Input size="small" value={field.label} onChange={(event) => onUpdateField(field.key, { label: event.target.value })} /></label>
                                        <label className="space-y-0.5"><span className="text-stone-400">类型</span><Select size="small" className="w-full" value={field.type} options={[{ value: "number", label: "数字" }, { value: "select", label: "下拉" }, { value: "boolean", label: "开关" }, { value: "string", label: "文本" }]} onChange={(type) => onUpdateField(field.key, { type: type as FreeWorkflowParam["type"] })} /></label>
                                        <label className="space-y-0.5 sm:col-span-2"><span className="text-stone-400">默认值</span>
                                            {field.type === "boolean" ? <input type="checkbox" className="size-4 accent-emerald-600" checked={Boolean(field.value)} onChange={(event) => onUpdateField(field.key, { value: event.target.checked })} /> : field.type === "select" ? <Select size="small" className="w-full" value={String(field.value ?? "")} options={(field.options || []).map((option) => ({ value: option, label: option }))} onChange={(value) => onUpdateField(field.key, { value })} /> : <Input size="small" type={field.type === "number" ? "number" : "text"} value={String(field.value ?? "")} onChange={(event) => onUpdateField(field.key, { value: event.target.value })} />}
                                        </label>
                                        {field.type === "number" ? (
                                            <>
                                                <label className="space-y-0.5"><span className="text-stone-400">最小</span><Input size="small" type="number" value={field.min ?? ""} onChange={(event) => onUpdateField(field.key, { min: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                                <label className="space-y-0.5"><span className="text-stone-400">最大</span><Input size="small" type="number" value={field.max ?? ""} onChange={(event) => onUpdateField(field.key, { max: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                                <label className="space-y-0.5"><span className="text-stone-400">步长</span><Input size="small" type="number" value={field.step ?? ""} onChange={(event) => onUpdateField(field.key, { step: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                            </>
                                        ) : null}
                                        {field.type === "select" ? <label className="space-y-0.5 sm:col-span-2"><span className="text-stone-400">选项（逗号分隔）</span><Input size="small" value={(field.options || []).join(", ")} onChange={(event) => onUpdateField(field.key, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label> : null}
                                    </div>
                                </div>
                            ) : (
                                <div
                                    draggable
                                    onDragStart={(event) => dragStart(event, field)}
                                    onDragEnd={() => {
                                        setDraggingKey("");
                                        setOverIndex(-1);
                                    }}
                                    onClick={() => setExpandedKey(field.key)}
                                    className={`flex cursor-grab items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50/70 px-3 py-1.5 text-xs transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 dark:border-stone-700 dark:bg-white/[.04] dark:hover:border-emerald-800 dark:hover:bg-emerald-950/20 ${draggingKey === field.key ? "opacity-50" : ""}`}
                                >
                                    <GripVertical className="size-3.5 shrink-0 text-stone-400" />
                                    <span className="min-w-0 flex-1 truncate" title={field.label}>{field.label}</span>
                                    <span className="shrink-0 rounded-full bg-stone-100 px-1.5 text-[9px] text-stone-400 dark:bg-white/10">{TYPE_LABELS[field.type]}</span>
                                    <button type="button" className="shrink-0 rounded p-0.5 text-stone-300 hover:text-red-500" onClick={(event) => { event.stopPropagation(); onRemoveField(field.key); }} aria-label="移除"><X className="size-3" /></button>
                                </div>
                            )}
                        </div>
                    );
                }) : (
                    <div className="rounded-lg border border-dashed border-stone-200 px-3 py-10 text-center text-xs text-stone-400 dark:border-stone-700 dark:text-stone-500">还没有参数胶囊。点左侧节点里的星标，参数会出现在这里。</div>
                )}
                {draggingKey && overIndex === ordered.length ? <div className="h-0.5 rounded bg-emerald-400" /> : null}
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-stone-400"><span>拖动胶囊调整顺序</span><button type="button" className="inline-flex items-center gap-0.5 hover:text-stone-600" onClick={() => setExpandedKey(expandedKey ? "" : ordered[0]?.key || "")}>{expandedKey ? <><ChevronUp className="size-3" />全部收起</> : <><ChevronDown className="size-3" />展开第一个</>}</button></div>
        </div>
    );
}
