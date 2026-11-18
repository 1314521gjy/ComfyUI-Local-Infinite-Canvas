import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Input, Select, Tag } from "antd";
import { GripVertical, Minus, Plus, Search, Settings2, Star, X } from "lucide-react";

import { CW_INPUT_MIME, graphInputMinZoom, isCardManagedInput, zhInputLabel, zhNodeTitle } from "@/lib/canvas/custom-workflow-fields";
import type { FreeWorkflowGraph, FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam, FreeWorkflowProblem, FreeWorkflowTextBinding, FreeWorkflowTextInput } from "@/services/api/free-workflow";
import type { CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

const NODE_WIDTH = 236;
const NODE_HEIGHT = 186;
const COLUMN_GAP = 92;
const ROW_GAP = 26;

type CustomWorkflowGraphPanelProps = {
    graph: FreeWorkflowGraph | null;
    loading: boolean;
    fields: FreeWorkflowParam[];
    onToggleField: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => void;
    interactive?: boolean;
    panZoom?: boolean;
    draggableInputs?: boolean;
    searchable?: boolean;
    problems?: FreeWorkflowProblem[];
    textInputs?: FreeWorkflowTextInput[];
    textSelection?: string[];
    textNames?: Record<string, string>;
    textPrimary?: FreeWorkflowTextBinding | null;
    onToggleTextInput?: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => void;
};

type CustomWorkflowFieldsPanelProps = {
    fields: FreeWorkflowParam[];
    layout: string[];
    spans: Record<string, CustomWorkflowSpan>;
    onRemoveField: (key: string) => void;
    onUpdateField: (key: string, patch: Partial<FreeWorkflowParam>) => void;
    onMoveField: (from: string, to: string) => void;
    onSpanChange: (key: string, span: CustomWorkflowSpan) => void;
};

function displayValue(value: FreeWorkflowGraphInput["value"]) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") return value.length > 24 ? `${value.slice(0, 24)}…` : value;
    return String(value);
}

function fieldFor(fields: FreeWorkflowParam[], node: string, input: string) {
    return fields.find((field) => field.node === node && field.input === input);
}

function spanOf(spans: Record<string, CustomWorkflowSpan>, key: string): CustomWorkflowSpan {
    return spans[key] || { w: 1, h: 1 };
}

function nodeOrder(node: FreeWorkflowGraphNode) {
    return node.pos?.y ?? (Number(node.id) || 0);
}

function buildLayout(nodes: FreeWorkflowGraphNode[], links: FreeWorkflowGraph["links"], zoom: number, heightOf: (node: FreeWorkflowGraphNode) => number = () => NODE_HEIGHT) {
    const ids = new Set(nodes.map((node) => node.id));
    const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
    const incoming = new Map(nodes.map((node) => [node.id, 0]));
    for (const link of links) {
        if (!ids.has(link.from) || !ids.has(link.to)) continue;
        adjacency.get(link.from)?.push(link.to);
        incoming.set(link.to, (incoming.get(link.to) || 0) + 1);
    }
    const roots = nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
    const level = new Map(nodes.map((node) => [node.id, 0]));
    const queue = roots.length ? [...roots] : nodes.slice(0, 1).map((node) => node.id);
    const seen = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const next of adjacency.get(id) || []) {
            level.set(next, Math.max(level.get(next) || 0, (level.get(id) || 0) + 1));
            queue.push(next);
        }
    }
    const maxLevel = Math.max(0, ...nodes.map((node) => level.get(node.id) || 0));
    for (const node of nodes) {
        if (!seen.has(node.id) && incoming.get(node.id) === 0) level.set(node.id, maxLevel + 1);
    }
    const columns = new Map<number, FreeWorkflowGraphNode[]>();
    for (const node of nodes) {
        const column = level.get(node.id) || 0;
        columns.set(column, [...(columns.get(column) || []), node]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    let height = 0;
    for (const [column, items] of [...columns.entries()].sort(([a], [b]) => a - b)) {
        let offset = 0;
        for (const node of [...items].sort((a, b) => nodeOrder(a) - nodeOrder(b) || a.id.localeCompare(b.id))) {
            positions.set(node.id, { x: column * (NODE_WIDTH + COLUMN_GAP), y: offset });
            offset += heightOf(node) + ROW_GAP;
        }
        height = Math.max(height, offset);
    }
    const width = (Math.max(...columns.keys(), 0) + 1) * (NODE_WIDTH + COLUMN_GAP);
    return { positions, width: Math.max(width, NODE_WIDTH) * zoom, height: Math.max(height, NODE_HEIGHT) * zoom };
}

export function CustomWorkflowGraphPanel({ graph, loading, fields, onToggleField, interactive = false, panZoom = false, draggableInputs = false, searchable = false, problems, textInputs = [], textSelection = [], textNames = {}, textPrimary = null, onToggleTextInput }: CustomWorkflowGraphPanelProps) {
    const [search, setSearch] = useState("");
    const [highlightId, setHighlightId] = useState("");
    const [zoom, setZoom] = useState(0.92);
    const [pan, setPan] = useState({ x: 16, y: 16 });
    const [panning, setPanning] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const panRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
    const viewRef = useRef({ zoom, pan });
    viewRef.current = { zoom, pan };
    const minZoomRef = useRef(graphInputMinZoom());
    const userZoomedRef = useRef(false);
    const query = search.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!graph) return { nodes: [] as FreeWorkflowGraphNode[], links: [] as FreeWorkflowGraph["links"] };
        if (!query || searchable) return { nodes: graph.nodes, links: graph.links };
        const nodes = graph.nodes.filter((node) => `${node.title} ${node.class_type}`.toLowerCase().includes(query) || node.inputs.some((input) => `${input.name} ${input.label}`.toLowerCase().includes(query)));
        const ids = new Set(nodes.map((node) => node.id));
        return { nodes, links: graph.links.filter((link) => ids.has(link.from) && ids.has(link.to)) };
    }, [graph, query, searchable]);
    const searchResults = useMemo(() => {
        if (!searchable || !graph || !query) return [] as FreeWorkflowGraphNode[];
        return graph.nodes
            .filter((node) => `${node.title} ${node.class_type} ${zhNodeTitle(node.title)}`.toLowerCase().includes(query) || node.inputs.some((input) => `${input.name} ${input.label} ${zhInputLabel(input.name, input.label)}`.toLowerCase().includes(query)))
            .slice(0, 10);
    }, [graph, query, searchable]);
    const heightOf = useMemo(() => (panZoom ? (node: FreeWorkflowGraphNode) => 52 + node.inputs.length * 22 : () => NODE_HEIGHT), [panZoom]);
    const layout = useMemo(() => buildLayout(filtered.nodes, filtered.links, panZoom ? 1 : zoom, heightOf), [filtered, zoom, panZoom, heightOf]);
    const linkScale = panZoom ? 1 : zoom;

    const fitToView = useCallback(() => {
        const container = containerRef.current;
        if (!panZoom || !graph || !container) return;
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (!width || !height) return;
        const full = buildLayout(graph.nodes, graph.links, 1, heightOf);
        const fit = Math.min(1, (width - 32) / full.width, (height - 32) / full.height);
        minZoomRef.current = Math.max(0.05, Math.min(graphInputMinZoom(), fit) * 0.85);
        const next = Math.max(minZoomRef.current, fit);
        setZoom(next);
        setPan({ x: Math.max(16, (width - full.width * next) / 2), y: Math.max(16, (height - full.height * next) / 2) });
    }, [graph, panZoom, heightOf]);

    const focusNode = useCallback((node: FreeWorkflowGraphNode) => {
        const container = containerRef.current;
        if (!container || !graph) return;
        const full = buildLayout(graph.nodes, graph.links, 1, heightOf);
        const position = full.positions.get(node.id);
        if (!position) return;
        userZoomedRef.current = true;
        const nextZoom = Math.max(0.55, Math.min(1, zoom));
        const width = container.clientWidth;
        const height = container.clientHeight;
        setZoom(nextZoom);
        setPan({ x: width / 2 - (position.x + NODE_WIDTH / 2) * nextZoom, y: height / 2 - (position.y + heightOf(node) / 2) * nextZoom });
        setHighlightId(node.id);
        setSearch("");
    }, [graph, heightOf, zoom]);

    useEffect(() => {
        if (!panZoom || !graph) return;
        userZoomedRef.current = false;
        fitToView();
        const container = containerRef.current;
        if (!container || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (!userZoomedRef.current) fitToView();
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [graph, panZoom, fitToView]);

    const clampZoom = (value: number) => Math.max(minZoomRef.current, Math.min(2, Number(value.toFixed(2))));

    useEffect(() => {
        if (!panZoom) return;
        const container = containerRef.current;
        if (!container) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = container.getBoundingClientRect();
            const cx = event.clientX - rect.left;
            const cy = event.clientY - rect.top;
            const current = viewRef.current;
            const next = clampZoom(current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
            userZoomedRef.current = true;
            setZoom(next);
            setPan({ x: cx - ((cx - current.pan.x) * next) / current.zoom, y: cy - ((cy - current.pan.y) * next) / current.zoom });
        };
        container.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => container.removeEventListener("wheel", onWheel, { capture: true });
    }, [panZoom, graph, loading]);
    const problemByNode = useMemo(() => {
        const byNode = new Map<string, string[]>();
        for (const problem of problems || []) {
            const reasons = byNode.get(problem.node) || [];
            reasons.push(problem.input ? `${problem.input}：${problem.reason}` : problem.reason);
            byNode.set(problem.node, reasons);
        }
        return byNode;
    }, [problems]);
    const textKeyOf = (nodeId: string, inputName: string) => `${nodeId}\u0000${inputName}`;
    const textKeySet = useMemo(() => new Set(textInputs.map((item) => textKeyOf(item.node, item.input))), [textInputs]);
    const selectedTextKeySet = useMemo(() => new Set(textSelection), [textSelection]);
    const primaryTextKey = textPrimary ? textKeyOf(textPrimary.node, textPrimary.input) : "";

    return (
        <div className="flex h-full min-h-0 flex-col rounded-xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="text-xs font-medium text-stone-500">节点缩略图</div>
                    {graph ? <Tag>{filtered.nodes.length}/{graph.nodes.length} 节点 · {filtered.links.length} 连线</Tag> : null}
                    {problemByNode.size ? <span className="rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">{problemByNode.size} 个问题节点</span> : null}
                    {panZoom && graph ? <span className="text-[11px] text-stone-400 dark:text-stone-500">拖拽平移 · 滚轮缩放；100% 后可拖参数</span> : null}
                </div>
                {interactive || panZoom || searchable ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {interactive && !searchable ? <Input size="small" allowClear value={search} onChange={(event) => setSearch(event.target.value)} prefix={<Search className="size-3.5 text-stone-400" />} placeholder="搜索节点或参数" className="!w-48" /> : null}
                        {searchable ? (
                            <div className="relative">
                                <Input size="small" allowClear value={search} onChange={(event) => setSearch(event.target.value)} prefix={<Search className="size-3.5 text-stone-400" />} placeholder="搜索节点或参数" className="!w-52" />
                                {query ? (
                                    <div className="absolute right-0 top-full z-30 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900">
                                        {searchResults.length ? searchResults.map((node) => (
                                            <button
                                                key={node.id}
                                                type="button"
                                                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-stone-100 dark:hover:bg-white/10"
                                                onClick={() => focusNode(node)}
                                            >
                                                <span className="min-w-0 truncate text-stone-700 dark:text-stone-200">{zhNodeTitle(node.title)}</span>
                                                <span className="shrink-0 text-[9px] text-stone-400">{node.class_type} · #{node.id}</span>
                                            </button>
                                        )) : <div className="px-2 py-2 text-[11px] text-stone-400">没有匹配的节点</div>}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        <div className="flex items-center gap-0.5">
                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6 !p-0" icon={<Minus className="size-3.5" />} onClick={() => { userZoomedRef.current = true; setZoom((value) => clampZoom(value - 0.08)); }} />
                            <span className="w-10 text-center text-[10px] text-stone-400">{Math.round(zoom * 100)}%</span>
                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6 !p-0" icon={<Plus className="size-3.5" />} onClick={() => { userZoomedRef.current = true; setZoom((value) => clampZoom(value + 0.08)); }} />
                            {panZoom ? <Button size="small" type="text" className="!h-6 !px-1.5 !text-[10px]" onClick={() => { userZoomedRef.current = false; fitToView(); }}>适应全图</Button> : null}
                        </div>
                    </div>
                ) : null}
            </div>
            {textInputs.length ? (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-stone-500 dark:text-stone-400">
                    <span className="rounded-full border border-cyan-300/60 bg-cyan-50/50 px-1.5 py-0.5 text-cyan-700 dark:border-cyan-800/60 dark:bg-cyan-950/20 dark:text-cyan-300">
                        文本输入 {textSelection.length}/4
                    </span>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">青色框=卡片输入，顺序即标签顺序</span>
                </div>
            ) : null}
            {loading ? (
                <div className="flex flex-1 items-center justify-center text-xs text-stone-400">正在扫描工作流并读取节点…</div>
            ) : !graph?.nodes.length ? (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-stone-200 text-xs text-stone-400 dark:border-stone-700">选择工作流后自动扫描</div>
            ) : !filtered.nodes.length ? (
                <div className="flex flex-1 items-center justify-center text-xs text-stone-400">没有匹配的节点</div>
            ) : (
                <div
                    ref={containerRef}
                    className={`relative min-h-0 flex-1 select-none rounded-lg bg-stone-50/60 dark:bg-white/[.02] ${panZoom ? `overflow-hidden ${panning ? "cursor-grabbing" : "cursor-grab"}` : "overflow-auto p-2"}`}
                    onPointerDown={(event) => {
                        if (!panZoom || event.button !== 0) return;
                        const target = event.target as HTMLElement;
                        if (target.closest("[data-cw-drag],button,input,select,textarea,a")) return;
                        event.preventDefault();
                        panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setPanning(true);
                    }}
                    onPointerMove={(event) => {
                        const active = panRef.current;
                        if (!active || active.pointerId !== event.pointerId) return;
                        setPan({ x: active.panX + event.clientX - active.startX, y: active.panY + event.clientY - active.startY });
                    }}
                    onPointerUp={(event) => {
                        if (panRef.current?.pointerId !== event.pointerId) return;
                        panRef.current = null;
                        setPanning(false);
                    }}
                    onPointerCancel={(event) => {
                        if (panRef.current?.pointerId !== event.pointerId) return;
                        panRef.current = null;
                        setPanning(false);
                    }}
                >
                    <div className="relative" style={{ width: layout.width, height: layout.height, ...(panZoom ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" } : {}) }}>
                        <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height}>
                            <defs>
                                <marker id="custom-workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#a8a29e" />
                                </marker>
                            </defs>
                            {filtered.links.map((link, index) => {
                                const from = layout.positions.get(link.from);
                                const to = layout.positions.get(link.to);
                                const fromNode = filtered.nodes.find((node) => node.id === link.from);
                                const toNode = filtered.nodes.find((node) => node.id === link.to);
                                if (!from || !to || !fromNode || !toNode) return null;
                                const x1 = (from.x + NODE_WIDTH) * linkScale;
                                const y1 = (from.y + heightOf(fromNode) / 2) * linkScale;
                                const x2 = to.x * linkScale;
                                const y2 = (to.y + heightOf(toNode) / 2) * linkScale;
                                const bend = Math.max(36, Math.abs(x2 - x1) * 0.45);
                                return <path key={`${link.from}-${link.to}-${link.toInput}-${index}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} fill="none" stroke="#a8a29e" strokeWidth="1.2" markerEnd="url(#custom-workflow-arrow)" opacity="0.7" />;
                            })}
                        </svg>
                        {filtered.nodes.map((node) => {
                            const position = layout.positions.get(node.id);
                            if (!position) return null;
                            return <NodeCard key={node.id} node={node} fields={fields} onToggleField={onToggleField} interactive={interactive} draggableInputs={draggableInputs && zoom >= 1} adaptiveHeight={panZoom} highlighted={highlightId === node.id} problems={problemByNode.get(node.id)} textKeys={textKeySet} selectedTextKeys={selectedTextKeySet} textNames={textNames} primaryTextKey={primaryTextKey} onToggleTextInput={onToggleTextInput} style={{ position: "absolute", left: position.x * linkScale, top: position.y * linkScale, width: NODE_WIDTH * linkScale, height: heightOf(node) * linkScale }} zoom={panZoom ? 1 : zoom} screenZoom={zoom} />;
                        })}
                    </div>
                    {problemByNode.size ? (
                        <div className="pointer-events-none absolute inset-0">
                            {filtered.nodes.filter((node) => problemByNode.has(node.id)).map((node) => {
                                const position = layout.positions.get(node.id);
                                if (!position) return null;
                                const offX = panZoom ? pan.x : 8;
                                const offY = panZoom ? pan.y : 8;
                                return <span key={`problem-${node.id}`} title={`${zhNodeTitle(node.title)} #${node.id}：${(problemByNode.get(node.id) || []).join("；")}`} className="absolute flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white shadow-[0_0_8px_rgba(239,68,68,.9)]" style={{ left: offX + (position.x + NODE_WIDTH) * zoom - 8, top: offY + position.y * zoom - 8 }}>!</span>;
                            })}
                        </div>
                    ) : null}
                </div>
            )}
            {graph?.warnings?.length ? <div className="mt-2 max-h-10 space-y-0.5 overflow-auto text-[10px] leading-4 text-amber-600 dark:text-amber-400">{graph.warnings.slice(0, 4).map((warning) => <div key={warning}>{warning}</div>)}</div> : null}
        </div>
    );
}

export function CustomWorkflowFieldsPanel({ fields, layout, spans, onRemoveField, onUpdateField, onMoveField, onSpanChange }: CustomWorkflowFieldsPanelProps) {
    const [editing, setEditing] = useState("");
    const [dragKey, setDragKey] = useState("");
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
    return (
        <div className="min-w-0 rounded-xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-stone-500">已暴露参数</div>
                <Tag>{ordered.length}</Tag>
            </div>
            <div className="mb-2 text-[11px] leading-4 text-stone-400 dark:text-stone-500">点节点星标加入；块可拖动排序/调整宽高</div>
            {ordered.length ? (
                <div className="space-y-2">
                    {ordered.map((field) => {
                        const span = spanOf(spans, field.key);
                        const isEditing = editing === field.key;
                        return (
                            <div
                                key={field.key}
                                draggable
                                onDragStart={() => setDragKey(field.key)}
                                onDragEnd={() => setDragKey("")}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (dragKey && dragKey !== field.key) onMoveField(dragKey, field.key);
                                    setDragKey("");
                                }}
                                className={`rounded-lg border px-2.5 py-2 transition-colors ${dragKey === field.key ? "border-emerald-300 bg-emerald-50/40 dark:border-emerald-800/60 dark:bg-emerald-950/20" : "border-stone-200 bg-stone-50/60 dark:border-stone-800 dark:bg-white/[.03]"}`}
                            >
                                <div className="flex items-center gap-1.5">
                                    <GripVertical className="size-3.5 shrink-0 cursor-grab text-stone-400" />
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium" title={field.label}>{field.label}</span>
                                    <span className="shrink-0 text-[10px] text-stone-400">{field.node}:{field.input}</span>
                                    <Button size="small" type="text" className="!h-6 !w-6 !min-w-6 !p-0" icon={<Settings2 className="size-3.5" />} onClick={() => setEditing(isEditing ? "" : field.key)} aria-label="编辑参数" />
                                    <Button size="small" type="text" danger className="!h-6 !w-6 !min-w-6 !p-0" icon={<X className="size-3.5" />} onClick={() => onRemoveField(field.key)} aria-label="移除参数" />
                                </div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-stone-400">
                                    <span>宽 {span.w}</span>
                                    {[1, 2].map((w) => <button key={w} type="button" className={`rounded border px-1 ${span.w === w ? "border-stone-500 text-stone-700 dark:border-stone-300 dark:text-stone-100" : "border-stone-200 dark:border-stone-700"}`} onClick={() => onSpanChange(field.key, { ...span, w: w as 1 | 2 })}>{w}</button>)}
                                    <span className="ml-1">高 {span.h}</span>
                                    {[1, 2].map((h) => <button key={h} type="button" className={`rounded border px-1 ${span.h === h ? "border-stone-500 text-stone-700 dark:border-stone-300 dark:text-stone-100" : "border-stone-200 dark:border-stone-700"}`} onClick={() => onSpanChange(field.key, { ...span, h: h as 1 | 2 })}>{h}</button>)}
                                </div>
                                {isEditing ? (
                                    <div className="mt-2 grid gap-2 border-t border-stone-200 pt-2 text-[11px] dark:border-stone-800 sm:grid-cols-2">
                                        <label className="space-y-0.5"><span className="text-stone-400">显示名</span><Input size="small" value={field.label} onChange={(event) => onUpdateField(field.key, { label: event.target.value })} /></label>
                                        <label className="space-y-0.5"><span className="text-stone-400">分组</span><Input size="small" value={field.group} onChange={(event) => onUpdateField(field.key, { group: event.target.value })} /></label>
                                        <label className="space-y-0.5"><span className="text-stone-400">类型</span><Select size="small" className="w-full" value={field.type} options={[{ value: "number", label: "数字" }, { value: "select", label: "下拉" }, { value: "boolean", label: "开关" }, { value: "string", label: "文本" }]} onChange={(type) => onUpdateField(field.key, { type: type as FreeWorkflowParam["type"] })} /></label>
                                        <label className="space-y-0.5"><span className="text-stone-400">默认值</span>
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
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="rounded-lg border border-dashed border-stone-200 px-3 py-10 text-center text-[11px] text-stone-400 dark:border-stone-700 dark:text-stone-500">还没有参数；点节点星标加入</div>
            )}
        </div>
    );
}

function NodeCard({ node, fields, style, onToggleField, interactive, draggableInputs = false, adaptiveHeight = false, highlighted = false, zoom, screenZoom = 1, problems, textKeys, selectedTextKeys, textNames, primaryTextKey, onToggleTextInput }: { node: FreeWorkflowGraphNode; fields: FreeWorkflowParam[]; style?: CSSProperties; onToggleField: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => void; interactive: boolean; draggableInputs?: boolean; adaptiveHeight?: boolean; highlighted?: boolean; zoom: number; screenZoom?: number; problems?: string[]; textKeys?: Set<string>; selectedTextKeys?: Set<string>; textNames?: Record<string, string>; primaryTextKey?: string; onToggleTextInput?: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => void }) {
    const flagged = Boolean(problems?.length);
    return (
        <div className={`flex select-none flex-col overflow-hidden rounded-lg border bg-white p-2 text-[11px] shadow-sm dark:bg-stone-900 ${flagged ? "border-red-500" : "border-stone-200 dark:border-stone-700"} ${highlighted ? "outline outline-2 outline-amber-400 outline-offset-2" : ""}`} style={flagged ? { ...style, borderWidth: Math.min(6, Math.max(2, 2 / screenZoom)), boxShadow: `0 0 ${Math.min(30, Math.max(6, 10 / screenZoom))}px rgba(239,68,68,.85)` } : style}>
            <div className={`flex items-start justify-between gap-1 ${flagged ? "-mx-1 rounded bg-red-100 px-1 py-0.5 dark:bg-red-900/50" : ""}`}>
                <div className="min-w-0">
                    <div className="truncate font-medium text-stone-700 dark:text-stone-200" title={node.title} style={{ fontSize: Math.max(9, 11 * zoom) }}>{zhNodeTitle(node.title)}</div>
                    <div className="truncate text-[9px] text-stone-400" title={node.class_type}>{node.class_type} · #{node.id}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {flagged ? <span className="rounded bg-red-500 px-1 text-[9px] font-medium text-white" title={`问题：${problems?.join("\n")}`}>⚠ 问题 {problems?.length}</span> : null}
                    <span className="rounded bg-stone-100 px-1 text-[9px] text-stone-400 dark:bg-white/10">{node.inputs.filter((input) => input.literal).length}</span>
                </div>
            </div>
            <div className={`mt-1.5 min-h-0 flex-1 space-y-0.5 pr-0.5 ${adaptiveHeight ? "" : "overflow-auto"}`}>
                {node.inputs.map((input) => {
                    const field = fieldFor(fields, node.id, input.name);
                    const managed = isCardManagedInput(node, input);
                    const canDrag = draggableInputs && input.literal && !managed;
                    const textKey = `${node.id}\u0000${input.name}`;
                    const isTextCandidate = Boolean(textKeys?.has(textKey));
                    const textSelected = Boolean(selectedTextKeys?.has(textKey));
                    if (isTextCandidate && onToggleTextInput) {
                        const maxed = (selectedTextKeys?.size || 0) >= 4;
                        return (
                            <button
                                key={input.name}
                                type="button"
                                disabled={!textSelected && maxed}
                                title={maxed && !textSelected ? "最多 4 个文本输入" : primaryTextKey === textKey ? "工作流默认主提示词；点击设为卡片输入" : "点击设为卡片输入"}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onToggleTextInput(node, input);
                                }}
                                className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors ${textSelected ? "border-cyan-500 bg-cyan-50/50 dark:bg-cyan-950/20" : "border-dashed border-cyan-400/45 hover:border-cyan-400"} ${!textSelected && maxed ? "opacity-40" : ""}`}
                                style={{ borderWidth: Math.max(1, 1.5 / screenZoom) }}
                            >
                                <span className={`shrink-0 rounded-full px-1 text-[8px] ${textSelected ? "bg-cyan-500 text-white" : "border border-cyan-400/50 text-cyan-600 dark:text-cyan-300"}`}>{textSelected ? "已选" : primaryTextKey === textKey ? "默认" : "设为输入"}</span>
                                <span className="min-w-0 flex-1 truncate text-stone-600 dark:text-stone-300">{textNames?.[textKey] || zhInputLabel(input.name, input.label)}</span>
                                <span className="max-w-[70px] shrink-0 truncate text-[9px] text-cyan-700/70 dark:text-cyan-300/70">{displayValue(input.value)}</span>
                            </button>
                        );
                    }
                    return (
                        <div
                            key={input.name}
                            data-cw-drag={canDrag || undefined}
                            draggable={canDrag}
                            onDragStart={canDrag ? (event) => {
                                event.dataTransfer.setData(CW_INPUT_MIME, JSON.stringify({ node, input }));
                                event.dataTransfer.effectAllowed = "copy";
                            } : undefined}
                            className={`flex items-center gap-1 rounded px-0.5 py-0.5 hover:bg-stone-50 dark:hover:bg-white/5 ${canDrag ? "cursor-grab" : ""}`}
                            title={canDrag ? "拖到右侧设置栏" : undefined}
                        >
                            {input.literal && !managed && interactive ? (
                                <button type="button" className="shrink-0 text-stone-300 hover:text-amber-500" onClick={() => onToggleField(node, input)} aria-label={`暴露 ${input.name}`}>
                                    <Star className={`size-3.5 ${field ? "fill-amber-400 text-amber-500" : ""}`} />
                                </button>
                            ) : canDrag ? (
                                field ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-500" /> : <GripVertical className="size-3.5 shrink-0 text-stone-300 dark:text-stone-600" />
                            ) : (
                                <span className="w-3.5 shrink-0 text-center text-[8px] text-stone-300 dark:text-stone-600" title={managed ? "由主卡接管，不在这里暴露" : "已连线"}>{managed ? "卡" : "·"}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-stone-500 dark:text-stone-400" title={managed ? "由主卡接管" : input.name}>{zhInputLabel(input.name, input.label)}</span>
                            <span className={`max-w-[80px] shrink-0 truncate text-[9px] ${input.linked ? "text-stone-300 dark:text-stone-600" : "text-stone-400"}`} title={input.linked ? "已连线" : displayValue(input.value)}>{input.linked ? "已连线" : displayValue(input.value)}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
