import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, Check, Crosshair, Download, ImagePlus, LoaderCircle, Mountain, Play, RefreshCw, Square } from "lucide-react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";

import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { dataUrlToFile, formatBytes } from "@/lib/image-utils";
import { SCENE3D_TARGET_SIZE } from "@/lib/canvas/model3d";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { cancelScene3DTask, createScene3DJob, getScene3DTask } from "@/services/api/scene3d";

const STAGE_KEYS = ["stageExpand", "stageSeam", "stageBuild"] as const;
const POLL_MS = 1500;

function stageOf(progress: number) {
    if (progress < 0.45) return 0;
    if (progress < 0.75) return 1;
    return 2;
}

const clampOffset = (value: number) => Math.max(-1, Math.min(1, value));

function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function Scene3DNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const theme = ctx.theme;
    const scene = ctx.node.metadata?.scene3d;
    const ctxRef = useRef(ctx);
    const abortRef = useRef<AbortController | null>(null);
    const [sourceUrl, setSourceUrl] = useState(scene?.sourceUrl || "");
    const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
    const [sourceError, setSourceError] = useState(false);
    const [offset, setOffset] = useState({ x: Number(scene?.offsetX) || 0, y: Number(scene?.offsetY) || 0 });
    const offsetRef = useRef(offset);
    const dragRef = useRef<{ id: number; startX: number; startY: number; start: { x: number; y: number }; slackX: number; slackY: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [prompt, setPrompt] = useState(scene?.prompt || "");
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState(scene?.progress || 0);
    const [error, setError] = useState(scene?.error || "");
    const [viewUrl, setViewUrl] = useState("");
    const [showForm, setShowForm] = useState(!scene?.panoramaUrl);
    const [uploading, setUploading] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const captureRef = useRef<(() => Promise<string>) | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        ctxRef.current = ctx;
    }, [ctx]);

    useEffect(() => {
        let cancelled = false;
        const key = ctx.node.metadata?.scene3d?.panoramaStorageKey;
        const fallback = ctx.node.metadata?.scene3d?.panoramaUrl || "";
        if (!key && !fallback) {
            setViewUrl("");
            return;
        }
        void resolveImageUrl(key, fallback).then((url) => {
            if (!cancelled) setViewUrl(url || fallback);
        });
        return () => {
            cancelled = true;
        };
    }, [ctx.node.metadata?.scene3d?.panoramaStorageKey, ctx.node.metadata?.scene3d?.panoramaUrl]);

    useEffect(() => {
        void resolveImageUrl(ctx.node.metadata?.scene3d?.sourceStorageKey, ctx.node.metadata?.scene3d?.sourceUrl || "").then((url) => {
            if (url) setSourceUrl(url);
        });
    }, [ctx.node.metadata?.scene3d?.sourceStorageKey, ctx.node.metadata?.scene3d?.sourceUrl]);

    useEffect(() => {
        if (!sourceUrl) return;
        let cancelled = false;
        setSourceError(false);
        const image = new Image();
        image.onload = () => {
            if (cancelled) return;
            setSourceSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
        };
        image.onerror = () => {
            if (cancelled) return;
            setSourceSize({ width: 0, height: 0 });
            setSourceError(true);
        };
        image.src = sourceUrl;
        return () => {
            cancelled = true;
        };
    }, [sourceUrl]);

    useEffect(() => {
        offsetRef.current = offset;
    }, [offset]);

    const patchScene = useCallback((patch: Partial<NonNullable<CanvasNodeMetadata["scene3d"]>>) => {
        const latest = ctxRef.current.node.metadata?.scene3d || {};
        ctxRef.current.updateMetadata({ scene3d: { ...latest, ...patch } });
    }, []);

    const finishWithTask = useCallback(
        async (taskUrl: string) => {
            const stored = await uploadImage(taskUrl);
            patchScene({
                panoramaUrl: stored.url,
                panoramaStorageKey: stored.storageKey,
                panoramaBytes: stored.bytes,
                panoramaWidth: stored.width,
                panoramaHeight: stored.height,
                sceneJson: { panorama: stored.storageKey || stored.url, rotation: 0, mode: "panorama", characterDistance: 1 },
                taskId: undefined,
                progress: 1,
                error: undefined,
            });
            setViewUrl(stored.url);
            setShowForm(false);
            setProgress(1);
        },
        [patchScene],
    );

    const poll = useCallback(
        async (taskId: string, controller: AbortController) => {
            setRunning(true);
            setError("");
            let cleared = false;
            try {
                while (!controller.signal.aborted) {
                    await wait(POLL_MS, controller.signal);
                    const task = await getScene3DTask(taskId, controller.signal);
                    if (controller.signal.aborted) return;
                    setProgress(task.progress);
                    patchScene({ taskId, progress: task.progress });
                    if (task.status === "completed") {
                        if (!task.url) throw new Error("3D 场景任务没有产出全景图");
                        await finishWithTask(task.url);
                        cleared = true;
                        return;
                    }
                    if (task.status === "failed" || task.status === "cancelled") {
                        throw new Error(task.error || (task.status === "cancelled" ? "任务已取消" : "3D 场景生成失败"));
                    }
                }
            } catch (err) {
                if (isAbort(err) || controller.signal.aborted) return;
                const text = err instanceof Error ? err.message : String(err);
                setError(text);
                patchScene({ error: text, taskId: undefined });
            } finally {
                if (!cleared) setRunning(false);
            }
        },
        [finishWithTask, patchScene],
    );

    useEffect(() => {
        const taskId = ctx.node.metadata?.scene3d?.taskId;
        const done = Boolean(ctx.node.metadata?.scene3d?.panoramaStorageKey);
        if (!taskId || done) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setShowForm(false);
        setRunning(true);
        void poll(taskId, controller);
        return () => controller.abort();
        // 只在节点挂载/刷新恢复时接续任务。
    }, []);

    const start = async () => {
        if (!sourceUrl || running) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setError("");
        setProgress(0);
        setShowForm(false);
        patchScene({ prompt, offsetX: offsetRef.current.x, offsetY: offsetRef.current.y, progress: 0, error: undefined, taskId: undefined });
        try {
            const dataUrl = await imageToDataUrl({ url: sourceUrl, storageKey: ctx.node.metadata?.scene3d?.sourceStorageKey });
            const file = dataUrlToFile({
                id: ctx.node.id,
                name: ctx.node.metadata?.scene3d?.sourceName || "scene.png",
                type: ctx.node.metadata?.mimeType || "image/png",
                dataUrl,
            });
            const created = await createScene3DJob(file, prompt, offsetRef.current, controller.signal);
            if (controller.signal.aborted) return;
            if (created.panoramaUrl) {
                await finishWithTask(created.panoramaUrl);
                return;
            }
            if (!created.taskId) throw new Error("3D 场景服务没有返回任务");
            patchScene({ taskId: created.taskId });
            await poll(created.taskId, controller);
        } catch (err) {
            if (isAbort(err) || controller.signal.aborted) return;
            const text = err instanceof Error ? err.message : String(err);
            setError(text);
            patchScene({ error: text, taskId: undefined });
            setShowForm(true);
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            if (!controller.signal.aborted) setRunning(false);
        }
    };

    const stop = () => {
        const taskId = ctxRef.current.node.metadata?.scene3d?.taskId;
        abortRef.current?.abort();
        abortRef.current = null;
        if (taskId) void cancelScene3DTask(taskId);
        setRunning(false);
        setProgress(0);
        patchScene({ taskId: undefined, progress: 0 });
        setShowForm(true);
    };

    const uploadSource = async (file?: File | null) => {
        if (!file) return;
        setUploading(true);
        try {
            const uploaded = await uploadImage(file);
            setSourceUrl(uploaded.url);
            setSourceSize({ width: uploaded.width, height: uploaded.height });
            setOffset({ x: 0, y: 0 });
            offsetRef.current = { x: 0, y: 0 };
            patchScene({ sourceUrl: uploaded.url, sourceStorageKey: uploaded.storageKey, sourceName: file.name, offsetX: 0, offsetY: 0 });
        } catch {
            message.error(t("canvas.scene3d.imageReadFailed"));
        } finally {
            setUploading(false);
        }
    };

    const downloadPanorama = async () => {
        if (!viewUrl) return;
        try {
            const response = await fetch(viewUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            saveAs(await response.blob(), "scene-panorama.png");
        } catch {
            message.error(t("canvas.scene3d.downloadFailed"));
        }
    };

    const takePhoto = async () => {
        const capture = captureRef.current;
        if (!capture || capturing) return;
        setCapturing(true);
        try {
            const dataUrl = await capture();
            const uploaded = await uploadImage(dataUrl);
            const scale = Math.min(1, 640 / Math.max(uploaded.width, uploaded.height));
            const width = Math.max(80, Math.round(uploaded.width * scale));
            const height = Math.max(80, Math.round(uploaded.height * scale));
            const source = ctxRef.current.node;
            ctxRef.current.applyOps([
                {
                    type: "add_node",
                    nodeType: "image",
                    title: t("canvas.scene3d.photoTitle"),
                    position: { x: source.position.x + source.width + 96, y: source.position.y },
                    width,
                    height,
                    metadata: {
                        content: uploaded.url,
                        storageKey: uploaded.storageKey,
                        mimeType: uploaded.mimeType,
                        naturalWidth: uploaded.width,
                        naturalHeight: uploaded.height,
                        bytes: uploaded.bytes,
                        status: "success",
                        prompt: "",
                    },
                },
            ]);
            message.success(t("canvas.scene3d.photoAdded"));
        } catch (err) {
            console.error("[scene3d] capture failed", err);
            message.error(t("canvas.scene3d.photoFailed"));
        } finally {
            setCapturing(false);
        }
    };

    const sourceWidth = sourceSize.width;
    const sourceHeight = sourceSize.height;
    const fitScale = sourceWidth && sourceHeight ? Math.min(1, SCENE3D_TARGET_SIZE.width / sourceWidth, SCENE3D_TARGET_SIZE.height / sourceHeight) : 0;
    const widthPct = sourceWidth ? ((sourceWidth * fitScale) / SCENE3D_TARGET_SIZE.width) * 100 : 0;
    const heightPct = sourceHeight ? ((sourceHeight * fitScale) / SCENE3D_TARGET_SIZE.height) * 100 : 0;
    const slackX = Math.max(0, 100 - widthPct);
    const slackY = Math.max(0, 100 - heightPct);
    const leftPct = (slackX / 2) * (1 + offset.x);
    const topPct = (slackY / 2) * (1 + offset.y);
    const hatchBackground = `repeating-linear-gradient(45deg, ${theme.node.stroke} 0, ${theme.node.stroke} 1px, transparent 1px, transparent 9px)`;

    const onPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!sourceWidth || event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            start: offsetRef.current,
            slackX: (rect.width * slackX) / 100,
            slackY: (rect.height * slackY) / 100,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
    };
    const onPreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const next = {
            x: drag.slackX > 2 ? clampOffset(drag.start.x + dx / (drag.slackX / 2)) : 0,
            y: drag.slackY > 2 ? clampOffset(drag.start.y + dy / (drag.slackY / 2)) : 0,
        };
        offsetRef.current = next;
        setOffset(next);
    };
    const endPreviewDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        patchScene({ offsetX: offsetRef.current.x, offsetY: offsetRef.current.y });
    };
    const resetOffset = () => {
        offsetRef.current = { x: 0, y: 0 };
        setOffset({ x: 0, y: 0 });
        patchScene({ offsetX: 0, offsetY: 0 });
    };

    const panoramaWidth = ctx.node.metadata?.scene3d?.panoramaWidth || 0;
    const panoramaHeight = ctx.node.metadata?.scene3d?.panoramaHeight || 0;
    const panoramaBytes = ctx.node.metadata?.scene3d?.panoramaBytes || 0;
    const panoramaLabel = panoramaWidth && panoramaHeight ? `${panoramaWidth}×${panoramaHeight}` : t("canvas.scene3d.panorama");
    const panoramaSize = `${panoramaLabel}${panoramaBytes ? ` · ${formatBytes(panoramaBytes)}` : ""}`;

    const fieldStyle = { borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text } as const;

    if (viewUrl && !showForm) {
        return (
            <div className="relative h-full w-full overflow-hidden rounded-3xl" style={{ background: theme.toolbar.panel }}>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void uploadSource(event.target.files?.[0]); event.target.value = ""; }} />
                <PanoramaViewer ctx={ctx} url={viewUrl} initialRotation={ctx.node.metadata?.scene3d?.sceneJson?.rotation || 0} captureRef={captureRef} />
                <div className="pointer-events-none absolute left-2 top-2 rounded-md px-2 py-1 text-[11px] tabular-nums backdrop-blur" style={{ background: "rgba(0,0,0,.45)", color: "#e2e8f0" }}>
                    {panoramaSize}
                </div>
                <div className="pointer-events-none absolute bottom-2 left-2 rounded-md px-2 py-1 text-[11px] backdrop-blur" style={{ background: "rgba(0,0,0,.45)", color: "#cbd5e1" }}>
                    {t("canvas.scene3d.viewerHint")}
                </div>
                <div className="absolute bottom-2 right-2 flex items-center gap-1">
                    <ViewerButton label={t("canvas.scene3d.photo")} onClick={() => void takePhoto()} icon={<Camera className="size-3.5" />} disabled={capturing} />
                    <ViewerButton label={t("canvas.scene3d.regenerate")} onClick={() => setShowForm(true)} icon={<RefreshCw className="size-3.5" />} />
                    <ViewerButton label={t("canvas.scene3d.download")} onClick={() => void downloadPanorama()} icon={<Download className="size-3.5" />} />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-hidden rounded-3xl border p-3" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void uploadSource(event.target.files?.[0]); event.target.value = ""; }} />
            <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <Mountain className="size-4" />
                    {t("canvas.scene3d.title")}
                </span>
                {running ? (
                    <span className="text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{Math.round(progress * 100)}%</span>
                ) : scene?.panoramaUrl ? (
                    <button type="button" className="text-[11px]" style={{ color: theme.node.muted }} onMouseDown={(event) => event.stopPropagation()} onClick={() => setShowForm(false)}>
                        {t("canvas.scene3d.back")}
                    </button>
                ) : null}
            </div>

            {sourceUrl ? (
                <div className="flex w-full shrink-0 flex-col gap-1">
                    <div
                        className="relative w-full max-w-[560px] select-none self-center overflow-hidden rounded-xl border"
                        style={{ aspectRatio: "2 / 1", borderColor: theme.node.stroke, background: theme.node.fill, touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
                        onPointerDown={onPreviewPointerDown}
                        onPointerMove={onPreviewPointerMove}
                        onPointerUp={endPreviewDrag}
                        onPointerCancel={endPreviewDrag}
                        onMouseDown={(event) => event.stopPropagation()}
                        title={t("canvas.scene3d.dragHint")}
                    >
                        <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: hatchBackground }} />
                        {sourceError ? (
                            <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: theme.node.muted }}>{t("canvas.scene3d.imageReadFailed")}</div>
                        ) : sourceWidth ? (
                            <img
                                src={sourceUrl}
                                alt=""
                                className="pointer-events-none absolute select-none"
                                style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` }}
                                draggable={false}
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <LoaderCircle className="size-5 animate-spin" style={{ color: theme.node.muted }} />
                            </div>
                        )}
                        <div className="absolute right-1.5 top-1.5 flex items-center gap-1" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                            <ViewerButton label={t("canvas.scene3d.center")} onClick={resetOffset} icon={<Crosshair className="size-3.5" />} />
                            <ViewerButton label={t("canvas.scene3d.replaceImage")} onClick={() => fileRef.current?.click()} icon={<ImagePlus className="size-3.5" />} />
                        </div>
                    </div>
                    <div className="flex w-full max-w-[560px] items-center justify-between gap-2 self-center text-[10px] tabular-nums" style={{ color: theme.node.muted }}>
                        <span className="inline-flex items-center gap-1">
                            <span className="inline-block size-2.5 rounded-[2px] border" style={{ borderColor: theme.node.stroke, backgroundImage: hatchBackground }} />
                            {t("canvas.scene3d.expandZone")}
                        </span>
                        <span>
                            {sourceWidth ? `${sourceWidth}×${sourceHeight} → ` : ""}
                            {SCENE3D_TARGET_SIZE.width}×{SCENE3D_TARGET_SIZE.height} · 16MP
                        </span>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    className="flex h-36 w-full shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-xs"
                    style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                    disabled={uploading}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => fileRef.current?.click()}
                >
                    {uploading ? <LoaderCircle className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
                    {t("canvas.scene3d.importImage")}
                </button>
            )}

            <label className="block min-w-0">
                <span className="mb-1 block text-[11px]" style={{ color: theme.node.muted }}>{t("canvas.scene3d.promptLabel")}</span>
                <textarea
                    value={prompt}
                    placeholder={t("canvas.scene3d.promptPlaceholder")}
                    className="thin-scrollbar h-16 w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-sm leading-5 outline-none"
                    style={fieldStyle}
                    onBlur={() => patchScene({ prompt })}
                    onChange={(event) => setPrompt(event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </label>

            {running ? (
                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                    {STAGE_KEYS.map((key, index) => {
                        const active = stageOf(progress);
                        const done = index < active || progress >= 1;
                        return (
                            <div key={key} className="flex items-center gap-2 text-xs">
                                <span className="grid size-5 place-items-center rounded-full" style={{ background: done ? theme.node.activeStroke : theme.node.fill, color: done ? theme.node.panel : theme.node.muted }}>
                                    {done ? <Check className="size-3" /> : index === active ? <LoaderCircle className="size-3 animate-spin" /> : <span className="size-1 rounded-full" style={{ background: theme.node.muted }} />}
                                </span>
                                <span style={{ color: index <= active ? theme.node.text : theme.node.muted }}>{t(`canvas.scene3d.${key}`)}</span>
                            </div>
                        );
                    })}
                    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: theme.node.fill }}>
                        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.max(3, Math.round(progress * 100))}%`, background: theme.node.activeStroke }} />
                    </div>
                </div>
            ) : null}

            {error ? (
                <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] leading-4 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                    {error}
                </div>
            ) : null}

            <div className="mt-auto flex items-center justify-end gap-2">
                {running ? (
                    <button
                        type="button"
                        className="inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={stop}
                    >
                        <Square className="size-3.5 fill-current" />
                        {t("canvas.scene3d.stop")}
                    </button>
                ) : (
                    <button
                        type="button"
                        className="inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        disabled={!sourceUrl}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => void start()}
                    >
                        <Play className="size-3.5" />
                        {t("canvas.scene3d.generate")}
                    </button>
                )}
            </div>
        </div>
    );
}

function ViewerButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            title={label}
            disabled={disabled}
            className="inline-flex h-7 items-center justify-center rounded-md px-2 text-[11px] backdrop-blur disabled:opacity-40"
            style={{ background: "rgba(0,0,0,0.45)", color: "#e2e8f0" }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {icon}
        </button>
    );
}

function PanoramaViewer({ ctx, url, initialRotation, captureRef }: { ctx: CanvasNodeContext; url: string; initialRotation: number; captureRef: React.MutableRefObject<(() => Promise<string>) | null> }) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const startRotation = useRef(initialRotation);
    const ctxRef = useRef(ctx);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [error, setError] = useState("");

    useEffect(() => {
        ctxRef.current = ctx;
    }, [ctx]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !url) return;
        let cancelled = false;
        let frame = 0;
        const cleanups: Array<() => void> = [];
        setStatus("loading");
        setError("");
        void (async () => {
            try {
                const THREE = (await import("three/webgpu")) as any;
                if (cancelled) return;
                const width = Math.max(1, container.clientWidth);
                const height = Math.max(1, container.clientHeight);
                let renderer: any;
                const makeRenderer = (forceWebGL: boolean) => new THREE.WebGPURenderer({ antialias: true, alpha: false, forceWebGL, preserveDrawingBuffer: true });
                try {
                    renderer = makeRenderer(!(navigator as Navigator & { gpu?: unknown }).gpu);
                    await renderer.init();
                } catch (firstError) {
                    renderer?.dispose?.();
                    if (cancelled) return;
                    console.warn("[scene3d] WebGPU init failed, retrying with WebGL", firstError);
                    renderer = makeRenderer(true);
                    await renderer.init();
                }
                if (cancelled) {
                    renderer.dispose?.();
                    return;
                }
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                renderer.setSize(width, height, false);
                renderer.domElement.style.width = "100%";
                renderer.domElement.style.height = "100%";
                renderer.domElement.style.display = "block";
                renderer.domElement.style.touchAction = "none";
                container.appendChild(renderer.domElement);

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(72, width / height, 0.1, 100);
                const geometry = new THREE.SphereGeometry(10, 64, 40);
                geometry.scale(-1, 1, 1);
                const texture = await new THREE.TextureLoader().loadAsync(url);
                if (cancelled) {
                    geometry.dispose?.();
                    texture.dispose?.();
                    renderer.dispose?.();
                    return;
                }
                texture.colorSpace = THREE.SRGBColorSpace;
                const material = new THREE.MeshBasicMaterial({ map: texture });
                const sphere = new THREE.Mesh(geometry, material);
                scene.add(sphere);

                let yaw = (Number(startRotation.current) || 0) * Math.PI / 180;
                let pitch = 0;
                let fov = 72;
                const applyCamera = () => {
                    pitch = Math.max(-1.35, Math.min(1.35, pitch));
                    fov = Math.max(35, Math.min(90, fov));
                    camera.fov = fov;
                    camera.rotation.set(pitch, yaw, 0, "YXZ");
                    camera.updateProjectionMatrix();
                };
                applyCamera();

                let persistTimer = 0;
                const persistRotation = () => {
                    window.clearTimeout(persistTimer);
                    persistTimer = window.setTimeout(() => {
                        const rotation = Math.round(((yaw * 180) / Math.PI) % 360);
                        const latest = ctxRef.current.node.metadata?.scene3d?.sceneJson || {};
                        ctxRef.current.updateMetadata({
                            scene3d: {
                                ...(ctxRef.current.node.metadata?.scene3d || {}),
                                sceneJson: { ...latest, panorama: ctxRef.current.node.metadata?.scene3d?.panoramaStorageKey || url, rotation, mode: "panorama", characterDistance: latest.characterDistance ?? 1 },
                            },
                        });
                    }, 300);
                };

                let dragging = false;
                let lastX = 0;
                let lastY = 0;
                const onPointerDown = (event: PointerEvent) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    dragging = true;
                    lastX = event.clientX;
                    lastY = event.clientY;
                    container.style.cursor = "grabbing";
                    container.setPointerCapture?.(event.pointerId);
                };
                const onPointerMove = (event: PointerEvent) => {
                    if (!dragging) return;
                    yaw -= (event.clientX - lastX) * 0.0042;
                    pitch -= (event.clientY - lastY) * 0.0042;
                    lastX = event.clientX;
                    lastY = event.clientY;
                    applyCamera();
                };
                const onPointerUp = (event: PointerEvent) => {
                    if (!dragging) return;
                    dragging = false;
                    container.style.cursor = "grab";
                    container.releasePointerCapture?.(event.pointerId);
                    persistRotation();
                };
                const onWheel = (event: WheelEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    fov += event.deltaY * 0.05;
                    applyCamera();
                    persistRotation();
                };
                const onMouseDown = (event: MouseEvent) => event.stopPropagation();
                const onResize = () => {
                    const nextWidth = Math.max(1, container.clientWidth);
                    const nextHeight = Math.max(1, container.clientHeight);
                    renderer.setSize(nextWidth, nextHeight, false);
                    camera.aspect = nextWidth / nextHeight;
                    camera.updateProjectionMatrix();
                };
                const observer = new ResizeObserver(onResize);
                observer.observe(container);
                container.style.cursor = "grab";
                container.addEventListener("mousedown", onMouseDown);
                container.addEventListener("pointerdown", onPointerDown);
                container.addEventListener("pointermove", onPointerMove);
                container.addEventListener("pointerup", onPointerUp);
                container.addEventListener("pointercancel", onPointerUp);
                container.addEventListener("wheel", onWheel, { passive: false });

                captureRef.current = async () => {
                    renderer.render(scene, camera);
                    const source = renderer.domElement;
                    const output = document.createElement("canvas");
                    output.width = source.width;
                    output.height = source.height;
                    const context = output.getContext("2d");
                    if (!context) throw new Error("capture context unavailable");
                    context.drawImage(source, 0, 0);
                    return output.toDataURL("image/png");
                };

                const tick = () => {
                    renderer.render(scene, camera);
                    frame = window.requestAnimationFrame(tick);
                };
                tick();
                setStatus("ready");
                cleanups.push(() => {
                    captureRef.current = null;
                    window.cancelAnimationFrame(frame);
                    window.clearTimeout(persistTimer);
                    observer.disconnect();
                    container.removeEventListener("mousedown", onMouseDown);
                    container.removeEventListener("pointerdown", onPointerDown);
                    container.removeEventListener("pointermove", onPointerMove);
                    container.removeEventListener("pointerup", onPointerUp);
                    container.removeEventListener("pointercancel", onPointerUp);
                    container.removeEventListener("wheel", onWheel);
                    container.style.cursor = "";
                    geometry.dispose?.();
                    material.dispose?.();
                    texture.dispose?.();
                    renderer.dispose?.();
                    renderer.domElement.remove();
                });
            } catch (err) {
                if (cancelled) return;
                console.error("[scene3d] viewer load failed", err);
                setError(err instanceof Error ? err.message : String(err));
                setStatus("error");
            }
        })();
        return () => {
            cancelled = true;
            for (const cleanup of cleanups) cleanup();
        };
    }, [captureRef, url]);

    return (
        <div className="absolute inset-0">
            <div ref={containerRef} className="absolute inset-0" />
            {status === "loading" ? (
                <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(11,11,14,.78)", color: "#cbd5e1" }}>
                    <LoaderCircle className="size-4 animate-spin" />
                    {t("canvas.scene3d.viewerLoading")}
                </div>
            ) : null}
            {status === "error" ? (
                <div className="absolute left-1/2 top-1/2 flex max-w-[90%] -translate-x-1/2 -translate-y-1/2 flex-col gap-1 rounded-lg px-3 py-2 text-center text-xs" style={{ background: "rgba(11,11,14,.85)", color: "#fca5a5" }}>
                    <span>{t("canvas.scene3d.viewerFailed")}</span>
                    <span className="truncate opacity-70" title={error}>{error}</span>
                </div>
            ) : null}
        </div>
    );
}
