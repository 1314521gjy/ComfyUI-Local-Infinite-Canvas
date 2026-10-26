import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal } from "antd";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";


import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { CanvasMossLayout, CanvasMossLayoutRegion } from "@/types/canvas";

export type CanvasMossLayoutPayload = CanvasMossLayout;

type Props = {
    open: boolean;
    dataUrl?: string;
    promptDefault?: string;
    size?: string;
    modelLabel?: string;
    layout?: CanvasMossLayout;
    onClose: () => void;
    onConfirm: (layout: CanvasMossLayoutPayload) => void;
};

const LABELS: Array<{ value: CanvasMossLayoutRegion["label"]; label: string; color: string }> = [
    { value: "object", label: "物体", color: "#3b82f6" },
    { value: "character", label: "人物", color: "#22c55e" },
    { value: "text", label: "文字", color: "#f59e0b" },
];

function parseSize(value?: string) {
    const match = String(value || "").match(/^(\d+)x(\d+)$/);
    if (!match) return { width: 1024, height: 1024 };
    return { width: Math.max(64, Number(match[1])), height: Math.max(64, Number(match[2])) };
}

function displayCaption(caption: string) {
    return caption.replace(/^(物体|人物|文字)\s*[：:]\s*/, "").trim();
}

function buildDisplayPrompt(summary: string, regions: CanvasMossLayoutRegion[]) {
    const display = regions
        .filter((region) => region.label !== "text")
        .map((region) => {
            const caption = displayCaption(region.caption.trim());
            if (!caption) return "";
            return `${region.label === "character" ? "人物" : "物体"}：${caption}`;
        })
        .filter(Boolean)
        .join("；");
    if (!display || summary.includes(display)) return summary.trim();
    const base = summary.replace(/[。；;，,\s]+$/, "");
    return base ? `${base}。${display}。` : `${display}。`;
}

export function CanvasNodeMossLayoutDialog({ open, dataUrl, promptDefault = "", size, modelLabel, layout, onClose, onConfirm }: Props) {
    const theme = useCanvasTheme();
    const boardRef = useRef<HTMLDivElement>(null);
    const drawRef = useRef<{ x: number; y: number } | null>(null);
    const moveRef = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; width: number; height: number } | null>(null);
    const initRef = useRef<string | null>(null);
    const [summary, setSummary] = useState("");
    const [regions, setRegions] = useState<CanvasMossLayoutRegion[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [error, setError] = useState("");
    const output = parseSize(size);
    const boardWidth = output.width >= output.height ? 560 : Math.round(560 * (output.width / output.height));
    const boardHeight = output.width >= output.height ? Math.round(560 * (output.height / output.width)) : 560;
    const selected = regions.find((region) => region.id === selectedId) || null;
    const effectiveSummary = buildDisplayPrompt(summary, regions);

    useEffect(() => {
        if (!open) {
            initRef.current = null;
            return;
        }
        const signature = JSON.stringify({ layout: layout ?? null, promptDefault });
        if (initRef.current === signature) return;
        initRef.current = signature;
        setSummary(layout?.summary || promptDefault);
        setRegions(layout?.regions ? layout.regions.map((region) => ({ ...region })) : []);
        setSelectedId(null);
        setDraft(null);
        moveRef.current = null;
        drawRef.current = null;
        setError("");
    }, [layout, open, promptDefault]);

    const pointFromClient = (clientX: number, clientY: number) => {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return {
            x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
        };
    };
    const point = (event: ReactPointerEvent<HTMLDivElement>) => pointFromClient(event.clientX, event.clientY);
    const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        moveRef.current = null;
        const start = point(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        drawRef.current = start;
        setDraft({ ...start, width: 0, height: 0 });
        setSelectedId(null);
    };
    const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        const moving = moveRef.current;
        if (moving) {
            const current = point(event);
            const x = Math.min(1 - moving.width, Math.max(0, moving.originX + current.x - moving.startX));
            const y = Math.min(1 - moving.height, Math.max(0, moving.originY + current.y - moving.startY));
            setRegions((previous) => previous.map((region) => (region.id === moving.id ? { ...region, x, y } : region)));
            return;
        }
        const start = drawRef.current;
        if (!start) return;
        const current = point(event);
        setDraft({
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
        });
    };
    const endDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        const moving = moveRef.current;
        moveRef.current = null;
        if (moving) {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            return;
        }
        const start = drawRef.current;
        drawRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!start || !draft || draft.width < 0.02 || draft.height < 0.02) {
            setDraft(null);
            return;
        }
        const region: CanvasMossLayoutRegion = {
            id: crypto.randomUUID(),
            label: "object",
            caption: "",
            x: draft.x,
            y: draft.y,
            width: draft.width,
            height: draft.height,
        };
        setRegions((previous) => [...previous, region]);
        setSelectedId(region.id);
        setDraft(null);
    };
    const updateSelected = (patch: Partial<CanvasMossLayoutRegion>) => {
        if (!selectedId) return;
        setRegions((previous) => previous.map((region) => (region.id === selectedId ? { ...region, ...patch } : region)));
    };
    const removeSelected = () => {
        if (!selectedId) return;
        setRegions((previous) => previous.filter((region) => region.id !== selectedId));
        setSelectedId(null);
    };
    const move = (direction: -1 | 1) => {
        if (!selectedId) return;
        setRegions((previous) => {
            const index = previous.findIndex((region) => region.id === selectedId);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= previous.length) return previous;
            const next = [...previous];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };
    const submit = () => {
        const text = summary.trim();
        if (!text) return setError("请填写整图描述");
        if (!regions.length) return setError("请至少画一个区域");
        if (regions.some((region) => !region.caption.trim() && !(region.label === "text" && region.text?.trim()))) {
            return setError("每个区域都要填写区域提示词（文字框可只填文字内容）");
        }
        onConfirm({ summary: text, regions: regions.map((region) => ({ ...region })), width: output.width, height: output.height });
    };

    return (
        <Modal open={open} onCancel={onClose} footer={null} width={1040} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(460px,1fr)_360px]" data-canvas-no-zoom>
                <div className="space-y-2">
                    <div
                        ref={boardRef}
                        className="relative select-none overflow-hidden rounded-2xl border"
                        style={{ width: boardWidth, height: boardHeight, margin: "0 auto", borderColor: theme.node.stroke, backgroundColor: theme.node.fill, touchAction: "none" }}
                        onPointerDown={startDraw}
                        onPointerMove={moveDraw}
                        onPointerUp={endDraw}
                        onPointerCancel={endDraw}
                    >
                        {dataUrl ? <img src={dataUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-25" draggable={false} /> : null}
                        {regions.map((region, index) => {
                            const color = LABELS.find((item) => item.value === region.label)?.color || "#3b82f6";
                            return (
                                <div
                                    key={region.id}
                                    className="absolute cursor-move border-2"
                                    style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`, borderColor: color, background: `${color}22` }}
                                    onPointerDown={(event) => {
                                        event.stopPropagation();
                                        event.preventDefault();
                                        setSelectedId(region.id);
                                        setDraft(null);
                                        const start = pointFromClient(event.clientX, event.clientY);
                                        moveRef.current = { id: region.id, startX: start.x, startY: start.y, originX: region.x, originY: region.y, width: region.width, height: region.height };
                                        boardRef.current?.setPointerCapture(event.pointerId);
                                    }}
                                >
                                    <span className="absolute left-1 top-1 rounded px-1 text-[10px] font-semibold text-white" style={{ background: color }}>
                                        {index + 1} · {LABELS.find((item) => item.value === region.label)?.label}
                                    </span>
                                    {region.caption ? <span className="absolute bottom-1 left-1 right-1 truncate rounded bg-black/45 px-1 text-[10px] text-white">{region.caption}</span> : null}
                                </div>
                            );
                        })}
                        {draft ? <div className="absolute border-2 border-dashed border-white/80" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%` }} /> : null}
                    </div>
                    <div className="text-center text-xs" style={{ color: theme.node.muted }}>
                        拖拽空白画新框 · 拖拽已有框移动 · 点击框选中编辑 · {dataUrl ? "底图仅作参考，不参与生成 · " : ""}输出 {output.width} × {output.height}
                    </div>
                </div>

                <div className="space-y-4" style={{ color: theme.node.text }}>
                    <div>
                        <div className="text-lg font-semibold">MOSS 区域布局</div>
                        <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>
                            {modelLabel || "MOSS-Image"} · 背景框先画，主体/文字后画
                        </div>
                        <div className="mt-1 text-xs" style={{ color: "#f59e0b" }}>
                            整图描述会自动附加区域列表（物体：…；人物：…），避免中文区域描述被当成画面文字；文字框不参与。
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>整图描述</div>
                        <Input.TextArea value={summary} onChange={(event) => setSummary(event.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="整张图的风格、场景、光线和构图" />
                        <div className="rounded-lg border px-2 py-1.5 text-xs leading-relaxed" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            显示提示词：{effectiveSummary || "填写整图描述和区域后自动生成"}
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-medium" style={{ color: theme.node.muted }}>
                            <span>区域（{regions.length}）</span>
                            <span>上→下 = 背景→前景</span>
                        </div>
                        <div className="max-h-40 space-y-1 overflow-y-auto">
                            {regions.map((region, index) => (
                                <button
                                    key={region.id}
                                    type="button"
                                    className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs"
                                    style={{ borderColor: selectedId === region.id ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                    onClick={() => setSelectedId(region.id)}
                                >
                                    <span className="w-4 text-center opacity-60">{index + 1}</span>
                                    <span className="truncate">{region.caption || region.text || "未填写"}</span>
                                </button>
                            ))}
                            {!regions.length ? <div className="rounded-lg border border-dashed p-3 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>在左侧拖拽画框</div> : null}
                        </div>
                    </div>
                    {selected ? (
                        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <div className="grid grid-cols-3 gap-1.5">
                                {LABELS.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className="h-8 rounded-full border text-xs"
                                        style={{ borderColor: selected.label === item.value ? item.color : theme.node.stroke, color: theme.node.text, background: "transparent" }}
                                        onClick={() => updateSelected({ label: item.value })}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                            <Input.TextArea value={selected.caption} onChange={(event) => updateSelected({ caption: event.target.value })} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="这个区域的提示词（会自动加入显示提示列表）" />
                            {selected.label === "text" ? <Input value={selected.text || ""} onChange={(event) => updateSelected({ text: event.target.value })} placeholder="要渲染进画面的文字" /> : null}
                            <div className="flex justify-end gap-1">
                                <Button size="small" icon={<ArrowUp className="size-3.5" />} onClick={() => move(-1)} />
                                <Button size="small" icon={<ArrowDown className="size-3.5" />} onClick={() => move(1)} />
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={removeSelected} />
                            </div>
                        </div>
                    ) : null}
                    {error ? <div className="text-xs text-red-500">{error}</div> : null}
                    <div className="flex justify-end gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" onClick={submit}>生成</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
