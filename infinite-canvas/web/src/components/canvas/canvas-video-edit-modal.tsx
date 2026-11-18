import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, InputNumber, Modal, Slider, Tooltip } from "antd";
import { Captions, Download, GripVertical, Play, Plus, Scissors, Trash2 } from "lucide-react";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";

type VideoSegment = {
    id: string;
    nodeId: string;
    title: string;
    src: string;
    duration: number;
    inPoint: number;
    outPoint: number;
};

type SubtitleLine = {
    id: string;
    start: number;
    end: number;
    text: string;
};

const DEFAULT_DURATION = 5;
const MIN_SEGMENT = 0.2;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function clock(value: number) {
    const safe = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(safe / 60);
    const seconds = Math.floor(safe % 60);
    const tenths = Math.floor((safe % 1) * 10);
    return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function srtClock(value: number) {
    const safe = Math.max(0, Number(value) || 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = Math.floor(safe % 60);
    const millis = Math.floor((safe % 1) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function newId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function CanvasVideoEditModal({ open, videos, onClose }: { open: boolean; videos: CanvasNodeData[]; onClose: () => void }) {
    const theme = useCanvasTheme();
    const [segments, setSegments] = useState<VideoSegment[]>([]);
    const [subtitles, setSubtitles] = useState<SubtitleLine[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const [playToken, setPlayToken] = useState(0);
    const [dragId, setDragId] = useState("");
    const [note, setNote] = useState("");
    const videoRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const next = videos
            .filter((node) => Boolean(node.metadata?.content))
            .map((node, index) => {
                const duration = Math.max(MIN_SEGMENT, Number(node.metadata?.durationMs || 0) / 1000 || DEFAULT_DURATION);
                return {
                    id: newId("seg"),
                    nodeId: node.id,
                    title: node.title || `视频 ${index + 1}`,
                    src: node.metadata?.content || "",
                    duration,
                    inPoint: 0,
                    outPoint: duration,
                };
            });
        setSegments(next);
        setSubtitles([]);
        setActiveIndex(0);
        setNote("");
    }, [open, videos]);

    const totalDuration = useMemo(() => segments.reduce((sum, segment) => sum + Math.max(0, segment.outPoint - segment.inPoint), 0), [segments]);
    const active = segments[activeIndex] || null;

    useEffect(() => {
        if (!totalDuration) return;
        setSubtitles((prev) =>
            prev.map((line) => {
                const start = Math.min(line.start, Math.max(0, totalDuration - 0.1));
                const end = Math.max(start + 0.1, Math.min(line.end, totalDuration));
                return start === line.start && end === line.end ? line : { ...line, start, end };
            }),
        );
    }, [totalDuration]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !active) return;
        video.pause();
        video.src = active.src;
        video.load();
        const ready = () => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            const duration = video.duration;
            setSegments((prev) =>
                prev.map((segment, index) =>
                    index === activeIndex && segment.outPoint >= segment.duration - 0.02 ? { ...segment, duration, outPoint: duration } : segment,
                ),
            );
            video.currentTime = Math.min(active.inPoint, Math.max(0, duration - 0.05));
            void video.play().catch(() => undefined);
        };
        video.addEventListener("loadedmetadata", ready, { once: true });
        return () => video.removeEventListener("loadedmetadata", ready);
    }, [activeIndex, playToken, active?.src, active?.inPoint]);

    const pausePreview = () => {
        videoRef.current?.pause();
    };

    const startSequential = () => {
        if (!segments.length) return;
        const first = segments[0];
        const video = videoRef.current;
        setActiveIndex(0);
        if (video && video.getAttribute("src") === first.src) {
            try {
                video.currentTime = first.inPoint;
            } catch {
                // Ignore videos whose metadata is not ready yet.
            }
            void video.play().catch(() => undefined);
            return;
        }
        setPlayToken((value) => value + 1);
    };

    const advance = () => {
        if (activeIndex + 1 < segments.length) setActiveIndex(activeIndex + 1);
        else videoRef.current?.pause();
    };

    const onTimeUpdate = () => {
        const video = videoRef.current;
        if (!video || video.paused || !active) return;
        if (video.currentTime >= active.outPoint - 0.04) advance();
    };

    const updateTrim = (id: string, value: number[]) => {
        pausePreview();
        setSegments((prev) =>
            prev.map((segment) => {
                if (segment.id !== id) return segment;
                const inPoint = clamp(value[0] ?? 0, 0, Math.max(0, segment.duration - MIN_SEGMENT));
                const outPoint = clamp(value[1] ?? segment.duration, inPoint + MIN_SEGMENT, segment.duration);
                return { ...segment, inPoint, outPoint };
            }),
        );
    };

    const updateDurationFromThumb = (id: string, duration: number) => {
        if (!Number.isFinite(duration) || duration <= 0) return;
        setSegments((prev) =>
            prev.map((segment) =>
                segment.id === id && segment.outPoint >= segment.duration - 0.02 ? { ...segment, duration, outPoint: duration } : segment,
            ),
        );
    };

    const reorder = (fromId: string, toId: string) => {
        if (!fromId || !toId || fromId === toId) return;
        pausePreview();
        setSegments((prev) => {
            const from = prev.findIndex((segment) => segment.id === fromId);
            const to = prev.findIndex((segment) => segment.id === toId);
            if (from < 0 || to < 0) return prev;
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
        setActiveIndex(0);
    };

    const removeSegment = (id: string) => {
        pausePreview();
        setSegments((prev) => prev.filter((segment) => segment.id !== id));
        setActiveIndex(0);
    };

    const addSubtitle = () => {
        setSubtitles((prev) => [...prev, { id: newId("sub"), start: 0, end: Math.min(2, totalDuration || 2), text: "新字幕" }]);
    };

    const updateSubtitle = (id: string, patch: Partial<SubtitleLine>) => {
        setSubtitles((prev) =>
            prev.map((line) => {
                if (line.id !== id) return line;
                const next = { ...line, ...patch };
                next.start = clamp(Number(next.start) || 0, 0, Math.max(0, totalDuration));
                next.end = clamp(Number(next.end) || 0, next.start + 0.1, Math.max(next.start + 0.1, totalDuration));
                return next;
            }),
        );
    };

    const exportSrt = () => {
        if (!subtitles.length) {
            setNote("还没有字幕，先加一条再导出。");
            return;
        }
        const ordered = [...subtitles].sort((left, right) => left.start - right.start);
        const body = ordered.map((line, index) => `${index + 1}\n${srtClock(line.start)} --> ${srtClock(line.end)}\n${line.text}\n`).join("\n");
        const url = URL.createObjectURL(new Blob([body], { type: "application/x-subrip;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "canvas-cut-subtitles.srt";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const exportVideo = () => {
        setNote("导出待接网关：当前试做只提供顺序预览与字幕编辑；视频 trim/concat 需要网关 ffmpeg 路由，未生成假文件。");
        startSequential();
    };

    return (
        <Modal
            open={open}
            title={<span className="flex items-center gap-2"><Scissors className="size-4" />剪辑（试做）</span>}
            centered
            onCancel={onClose}
            destroyOnHidden
            footer={null}
            width="min(1120px, 94vw)"
            styles={{
                root: { background: theme.toolbar.panel, border: `1px solid ${theme.toolbar.border}`, borderRadius: 16, overflow: "hidden" },
                header: { background: theme.toolbar.panel, color: theme.node.text, borderBottom: `1px solid ${theme.node.stroke}` },
                body: { padding: 16, background: theme.toolbar.panel, color: theme.node.text },
            }}
        >
            <div className="space-y-3">
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <video ref={videoRef} controls muted playsInline className="mx-auto max-h-[42vh] w-full bg-black object-contain" onTimeUpdate={onTimeUpdate} onEnded={advance} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <Button size="small" icon={<Play className="size-3.5" />} onClick={startSequential} disabled={!segments.length}>顺序预览</Button>
                    <span>{active ? `第 ${activeIndex + 1}/${segments.length} 段 · ${active.title} · ${clock(active.inPoint)} → ${clock(active.outPoint)}` : "还没有片段"}</span>
                    <span>顺序预览默认静音，可在播放器里开声</span>
                    <span className="ml-auto tabular-nums">成片 {clock(totalDuration)} · {segments.length} 段 · {subtitles.length} 条字幕</span>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-medium" style={{ color: theme.node.text }}>
                        <span>片段（拖动排序，双滑块裁剪头尾）</span>
                        <span style={{ color: theme.node.muted }}>一行一段，无轨道/转场</span>
                    </div>
                    {segments.length ? segments.map((segment, index) => (
                        <div
                            key={segment.id}
                            draggable
                            onDragStart={() => setDragId(segment.id)}
                            onDragEnd={() => setDragId("")}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => { reorder(dragId, segment.id); setDragId(""); }}
                            className="flex items-center gap-2 rounded-xl border px-2 py-2"
                            style={{ borderColor: dragId === segment.id ? theme.node.text : theme.node.stroke, background: theme.toolbar.panel }}
                        >
                            <GripVertical className="size-4 shrink-0 cursor-grab" style={{ color: theme.node.muted }} />
                            <span className="w-5 shrink-0 text-center text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{index + 1}</span>
                            <video
                                src={segment.src}
                                muted
                                preload="metadata"
                                className="h-12 w-20 shrink-0 rounded-lg bg-black object-cover"
                                onLoadedMetadata={(event) => {
                                    const duration = event.currentTarget.duration;
                                    updateDurationFromThumb(segment.id, duration);
                                    event.currentTarget.currentTime = Math.min(0.1, Number.isFinite(duration) ? duration / 2 : 0.1);
                                }}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium" style={{ color: theme.node.text }}>{segment.title}</div>
                                <Slider
                                    range
                                    min={0}
                                    max={segment.duration}
                                    step={0.1}
                                    value={[segment.inPoint, segment.outPoint]}
                                    onChange={(value) => updateTrim(segment.id, Array.isArray(value) ? value : [segment.inPoint, segment.outPoint])}
                                    tooltip={{ formatter: (value) => clock(Number(value) || 0) }}
                                />
                            </div>
                            <span className="w-28 shrink-0 text-right text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
                                {clock(segment.inPoint)} → {clock(segment.outPoint)}
                            </span>
                            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => removeSegment(segment.id)} aria-label={`删除第 ${index + 1} 段`} />
                        </div>
                    )) : (
                        <div className="rounded-xl border border-dashed px-4 py-8 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            选中的视频没有可读内容。
                        </div>
                    )}
                </div>

                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-medium" style={{ color: theme.node.text }}>
                        <Captions className="size-3.5" />
                        <span>字幕（按成片时间轴，手动编辑）</span>
                        <Tooltip title="本地 SenseVoice 尚未接入；当前先用手动字幕，ASR 不可用会自动降级，不报错。">
                            <span><Button size="small" disabled>自动字幕（待接本地 SenseVoice）</Button></span>
                        </Tooltip>
                        <Button size="small" icon={<Plus className="size-3.5" />} onClick={addSubtitle}>加一行</Button>
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={exportSrt} disabled={!subtitles.length}>导出 SRT</Button>
                    </div>
                    {subtitles.length ? subtitles.map((line) => (
                        <div key={line.id} className="flex flex-wrap items-center gap-2 rounded-xl border px-2 py-2" style={{ borderColor: theme.node.stroke }}>
                            <InputNumber size="small" min={0} max={totalDuration} step={0.1} value={line.start} onChange={(value) => updateSubtitle(line.id, { start: Number(value) || 0 })} className="!w-20" />
                            <span className="text-[11px]" style={{ color: theme.node.muted }}>→</span>
                            <InputNumber size="small" min={0} max={totalDuration} step={0.1} value={line.end} onChange={(value) => updateSubtitle(line.id, { end: Number(value) || 0 })} className="!w-20" />
                            <Input size="small" value={line.text} onChange={(event) => updateSubtitle(line.id, { text: event.target.value })} className="min-w-0 flex-1" placeholder="字幕文字" />
                            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => setSubtitles((prev) => prev.filter((item) => item.id !== line.id))} aria-label="删除字幕" />
                        </div>
                    )) : (
                        <div className="rounded-xl border border-dashed px-4 py-5 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            还没有字幕。手动加行即可；自动字幕待接本地 SenseVoice。
                        </div>
                    )}
                </div>

                {note ? <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}>{note}</div> : null}

                <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <span className="mr-auto text-[11px]" style={{ color: theme.node.muted }}>试做版：预览用原视频，不强制代理；导出/ASR 待接。</span>
                    <Button onClick={onClose}>关闭</Button>
                    <Button type="primary" icon={<Scissors className="size-3.5" />} onClick={exportVideo} disabled={!segments.length}>导出（待接网关）</Button>
                </div>
            </div>
        </Modal>
    );
}