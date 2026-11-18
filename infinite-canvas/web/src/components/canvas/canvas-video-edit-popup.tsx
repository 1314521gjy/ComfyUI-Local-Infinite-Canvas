import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Slider, Switch } from "antd";
import { Eraser, LoaderCircle, Paintbrush, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { videoModelForWorkflow } from "@/lib/canvas/video-model-mode";
import { requestImagePromptOptimize } from "@/services/api/image";
import { requestVideoEditPreview } from "@/services/api/video-edit";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

export type VideoEditGeneratePayload = { previewUrl: string; mode: "swap" | "edit"; prompt: string; frame: number; model: string; longVideo: boolean; segmentSeconds: number };

type Props = { open: boolean; node: CanvasNodeData | null; onClose: () => void; onGenerateVideo: (payload: VideoEditGeneratePayload) => Promise<void> };

type PreviewItem = { id: string; url: string; label: string; frame: number };

function captureFrame(video: HTMLVideoElement, mask: HTMLCanvasElement | null) {
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(video, 0, 0, width, height);
    if (mask) {
        context.globalAlpha = 0.45;
        context.drawImage(mask, 0, 0, width, height);
        context.globalAlpha = 1;
    }
    return canvas.toDataURL("image/png");
}

function maskHasContent(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !canvas.width || !canvas.height) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
}

function captureImage(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || 640;
            canvas.height = img.naturalHeight || 360;
            const context = canvas.getContext("2d");
            if (!context) return reject(new Error("no context"));
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("读取固定图失败"));
        img.src = url;
    });
}

export function CanvasVideoEditPopup({ open, node, onClose, onGenerateVideo }: Props) {
    const theme = useCanvasTheme();
    const config = useConfigStore((state) => state.config);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawing = useRef(false);
    const eraserRef = useRef(false);
    const brushRef = useRef(28);
    const [tab, setTab] = useState<"swap" | "edit">("swap");
    const [swapSub, setSwapSub] = useState<"reference" | "mask">("reference");
    const [frameT, setFrameT] = useState(0);
    const [duration, setDuration] = useState(0);
    const [strength, setStrength] = useState(90);
    const [longVideo, setLongVideo] = useState(true);
    const [segmentSeconds, setSegmentSeconds] = useState(12);
    const [prompt, setPrompt] = useState("");
    const [refImage, setRefImage] = useState("");
    const [brush, setBrush] = useState(28);
    const [eraser, setEraser] = useState(false);
    const [previewsByMode, setPreviewsByMode] = useState<Record<string, PreviewItem[]>>({});
    const [previewError, setPreviewError] = useState("");
    const [hovered, setHovered] = useState<string | null>(null);
    const [pinned, setPinned] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [optimizeError, setOptimizeError] = useState("");
    const [originalPrompt, setOriginalPrompt] = useState("");
    const optimizeControllerRef = useRef<AbortController | null>(null);

    const content = node?.metadata?.content || "";
    const hasMask = tab === "edit" || swapSub === "mask";
    const modeKey = tab === "swap" ? (swapSub === "mask" ? "swap-mask" : "swap") : "edit";
    const previews = previewsByMode[modeKey] || [];
    const hoveredItem = useMemo(() => previews.find((item) => item.id === hovered) || null, [hovered, previews]);
    const pinnedItem = useMemo(() => previews.find((item) => item.id === pinned) || null, [pinned, previews]);
    const displayUrl = pinnedItem?.url || hoveredItem?.url || "";
    const viggleModel = videoModelForWorkflow(config, "video-h3-viggle-swap");
    const generateDisabledReason = !pinnedItem ? "先在右侧点选一张预览图" : !content ? "源视频不可用" : !viggleModel ? "当前没有可用的人物替换模型" : "";

    useEffect(() => {
        if (!open) {
            optimizeControllerRef.current?.abort();
            return;
        }
        setTab("swap");
        setSwapSub("reference");
        setFrameT(0);
        setPrompt("");
        setRefImage("");
        setPreviewsByMode({});
        setPreviewError("");
        setHovered(null);
        setPinned(null);
        setStrength(90);
        setOptimizeError("");
        setOriginalPrompt("");
        // 打开即暂停：停掉 onTimeUpdate 的高频 setFrameT 重渲染，按钮切换才跟手。
        videoRef.current?.pause();
    }, [open]);

    useEffect(() => {
        setHovered(null);
        setPinned(null);
        setPreviewError("");
    }, [modeKey]);

    const resizeMask = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const host = canvas.parentElement;
        const video = videoRef.current;
        canvas.width = host?.clientWidth || video?.clientWidth || 640;
        canvas.height = host?.clientHeight || video?.clientHeight || 360;
    }, []);

    useEffect(() => {
        requestAnimationFrame(resizeMask);
    }, [pinnedItem, hasMask, resizeMask]);

    useEffect(() => {
        if (!open) return;
        const onResize = () => resizeMask();
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [open, resizeMask]);

    const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drawing.current) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        const rect = canvas.getBoundingClientRect();
        context.globalCompositeOperation = eraserRef.current ? "destination-out" : "source-over";
        context.fillStyle = "rgba(64,150,255,0.55)";
        context.beginPath();
        context.arc(event.clientX - rect.left, event.clientY - rect.top, brushRef.current / 2, 0, Math.PI * 2);
        context.fill();
    };

    const clearMask = () => {
        const canvas = canvasRef.current;
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };

    const pickReference = (file?: File) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setRefImage(String(reader.result || ""));
        reader.readAsDataURL(file);
    };

    const runPreview = async () => {
        const pinnedUrl = pinnedItem?.url || "";
        const video = videoRef.current;
        if (!pinnedUrl && !video) return;
        if (video && video.paused === false) video.pause();
        const mode = tab === "swap" && swapSub === "reference" ? "swap" : "edit";
        const withMask = tab === "edit" || swapSub === "mask";
        setBusy(true);
        setPreviewError("");
        try {
            const frame = pinnedUrl ? await captureImage(pinnedUrl) : captureFrame(video as HTMLVideoElement, null);
            const result = await requestVideoEditPreview(config, {
                mode,
                frame,
                mask: withMask && maskHasContent(canvasRef.current) ? canvasRef.current?.toDataURL("image/png") : undefined,
                ref: refImage || undefined,
                strength: strength / 100,
                prompt,
            });
            if (!result.image_url) throw new Error("preview failed");
            const frameNo = pinnedItem ? pinnedItem.frame : Math.round((video?.currentTime || 0) * 24);
            setPreviewsByMode((map) => ({
                ...map,
                [modeKey]: [...(map[modeKey] || []), { id: `${Date.now()}`, url: result.image_url!, frame: frameNo, label: `${mode === "swap" ? (withMask ? "蒙版" : "替换") : "蒙版"}·帧${frameNo}` }],
            }));
        } catch (error) {
            const backend = (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || "";
            const message = backend || (error instanceof Error ? error.message : "");
            setPreviewError(/[一-鿿]/.test(message) ? message : "生图预览失败");
        } finally {
            setBusy(false);
        }
    };

    const runGenerateVideo = async () => {
        if (!pinnedItem || generateDisabledReason) return;
        setGenerating(true);
        setPreviewError("");
        try {
            const videoPrompt = originalPrompt && prompt.trim() !== originalPrompt.trim() ? originalPrompt.trim() : prompt.trim();
            await onGenerateVideo({ previewUrl: pinnedItem.url, mode: tab === "swap" ? "swap" : "edit", prompt: videoPrompt, frame: pinnedItem.frame, model: viggleModel, longVideo, segmentSeconds });
            onClose();
        } catch (error) {
            setPreviewError(error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : "生成视频失败");
        } finally {
            setGenerating(false);
        }
    };

    const runOptimize = async () => {
        const text = prompt.trim();
        if (!text || optimizing) return;
        const useCloud = config.promptApiEngine === "cloud";
        const cloud = {
            baseUrl: (config.promptCloudBaseUrl || "").trim(),
            apiKey: (config.promptCloudApiKey || "").trim(),
            model: (config.promptCloudModel || "").trim(),
        };
        if (useCloud && !(cloud.baseUrl && cloud.apiKey && cloud.model)) {
            setOptimizeError("未配置云端 API，无法优化提示词");
            return;
        }
        optimizeControllerRef.current?.abort();
        const controller = new AbortController();
        optimizeControllerRef.current = controller;
        setOptimizing(true);
        setOptimizeError("");
        try {
            // 预览步是 Qwen2.1 图像生成：按图像卡的图生图模板优化，随附参考图与当前源帧，保留替换意图。
            const images: ReferenceImage[] = [];
            if (refImage) images.push({ id: "ref", name: "ref.png", type: "image/png", dataUrl: refImage });
            const video = videoRef.current;
            if (video && video.videoWidth) images.push({ id: "frame", name: "frame.png", type: "image/png", dataUrl: captureFrame(video, null) });
            else if (pinnedItem) {
                const painted = await captureImage(pinnedItem.url).catch(() => "");
                if (painted) images.push({ id: "painted", name: "painted.png", type: "image/png", dataUrl: painted });
            }
            const result = await requestImagePromptOptimize(config, {
                prompt: text,
                mode: "image",
                language: config.promptOptimizeLanguage === "en" ? "en" : "zh",
                images,
                imageCount: images.length,
                engine: useCloud ? "cloud" : "local",
                cloud: useCloud ? cloud : undefined,
            }, { signal: controller.signal });
            setOriginalPrompt(text);
            setPrompt(result.prompt);
        } catch (error) {
            if (controller.signal.aborted) return;
            setOptimizeError(error instanceof Error && error.message ? error.message : "提示词优化失败");
        } finally {
            if (optimizeControllerRef.current === controller) optimizeControllerRef.current = null;
            setOptimizing(false);
        }
    };

    const videoElement = useMemo(
        () => (
            <video
                ref={videoRef}
                src={content}
                className="h-full w-full object-contain"
                playsInline
                onLoadedMetadata={(event) => {
                    setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
                    requestAnimationFrame(resizeMask);
                }}
                onTimeUpdate={(event) => setFrameT(event.currentTarget.currentTime)}
            />
        ),
        [content, resizeMask],
    );

    const frameCount = duration > 0 ? Math.max(1, Math.round(duration * 24)) : 1;
    const currentFrame = Math.round((frameT || 0) * 24);

    return (
        <Modal open={open} onCancel={onClose} footer={null} width="96vw" centered destroyOnHidden title={null} styles={{ body: { padding: 0 } }}>
            <div className="flex gap-3 p-3" style={{ background: "#141414", color: "#e5e5e5", borderRadius: 16, height: "86vh" }}>
                <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl bg-black">
                    {displayUrl ? (
                        <div className="relative h-full w-full">
                            <img src={displayUrl} alt="" className="h-full w-full object-contain" />
                            {pinnedItem ? (
                                <button type="button" className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-full bg-black/60 text-white" onClick={() => setPinned(null)} aria-label="退出">
                                    <X className="size-4" />
                                </button>
                            ) : null}
                        </div>
                    ) : (
                        videoElement
                    )}
                    {hasMask && (pinnedItem || !displayUrl) ? (
                        <canvas
                            ref={canvasRef}
                            className="absolute inset-0 h-full w-full touch-none"
                            onPointerDown={(event) => {
                                drawing.current = true;
                                event.currentTarget.setPointerCapture(event.pointerId);
                                draw(event);
                            }}
                            onPointerMove={draw}
                            onPointerUp={() => (drawing.current = false)}
                            onPointerLeave={() => (drawing.current = false)}
                        />
                    ) : null}
                </div>

                <div className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto pr-1">
                    <div className="grid grid-cols-2 gap-2">
                        {([["swap", "角色替换"], ["edit", "视频编辑"]] as const).map(([value, label]) => (
                            <button key={value} type="button" className="h-9 rounded-lg text-sm" style={{ background: tab === value ? "#1677ff" : "#262626", color: tab === value ? "#fff" : "#d4d4d4" }} onClick={() => setTab(value)}>
                                {label}
                            </button>
                        ))}
                    </div>
                    {tab === "swap" ? (
                        <div className="grid grid-cols-2 gap-2">
                            {([["reference", "参考替换"], ["mask", "蒙版编辑"]] as const).map(([value, label]) => (
                                <button key={value} type="button" className="h-8 rounded-lg text-xs" style={{ background: swapSub === value ? "#4096ff" : "#262626", color: swapSub === value ? "#fff" : "#d4d4d4" }} onClick={() => setSwapSub(value)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    ) : null}

                    <label className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border text-xs" style={{ borderColor: "#3a3a3a", color: "#d4d4d4" }}>
                        <Plus className="size-3.5" /> 参考图
                        <input type="file" accept="image/*" className="hidden" onChange={(event) => pickReference(event.target.files?.[0])} />
                    </label>
                    {refImage ? <img src={refImage} alt="" className="h-28 w-full rounded-lg bg-black object-contain" /> : null}

                    {hasMask ? (
                        <div className="space-y-2 rounded-lg border p-2" style={{ borderColor: "#3a3a3a" }}>
                            <div className="flex gap-2">
                                <button type="button" className="grid size-8 place-items-center rounded-md" style={{ background: eraser ? "#262626" : "#1677ff" }} onClick={() => { eraserRef.current = false; setEraser(false); }} aria-label="笔刷">
                                    <Paintbrush className="size-4" />
                                </button>
                                <button type="button" className="grid size-8 place-items-center rounded-md" style={{ background: eraser ? "#1677ff" : "#262626" }} onClick={() => { eraserRef.current = true; setEraser(true); }} aria-label="橡皮">
                                    <Eraser className="size-4" />
                                </button>
                                <button type="button" className="grid size-8 place-items-center rounded-md bg-[#262626]" onClick={clearMask} aria-label="清除">
                                    <Trash2 className="size-4" />
                                </button>
                            </div>
                            <Slider min={6} max={80} value={brush} onChange={(value) => { brushRef.current = value; setBrush(value); }} tooltip={{ open: false }} />
                        </div>
                    ) : null}

                    <div className="space-y-1">
                        <div className="text-xs" style={{ color: "#a3a3a3" }}>{tab === "swap" ? "替换强度" : "编辑强度"}</div>
                        <Slider min={0} max={100} value={strength} onChange={setStrength} tooltip={{ open: false }} />
                    </div>

                    <div className="flex items-center justify-between text-xs" style={{ color: "#a3a3a3" }}>
                        <span>长视频自动分段</span>
                        <Switch size="small" checked={longVideo} onChange={setLongVideo} />
                    </div>
                    {longVideo ? (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs" style={{ color: "#a3a3a3" }}>
                                <span>每段最长</span>
                                <span>{segmentSeconds.toFixed(1)}s</span>
                            </div>
                            <Slider min={3.75} max={14.4} step={0.25} value={segmentSeconds} onChange={setSegmentSeconds} tooltip={{ open: false }} />
                        </div>
                    ) : null}

                    <div className="relative">
                        <textarea
                            value={prompt}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                if (originalPrompt) setOriginalPrompt("");
                            }}
                            placeholder={tab === "swap" ? "例如：替换左侧白衣人物" : "编辑指令"}
                            className="thin-scrollbar min-h-[96px] w-full resize-y rounded-lg border bg-transparent px-3 py-2 pr-28 text-sm leading-5 outline-none"
                            style={{ borderColor: "#3a3a3a", color: "#e5e5e5" }}
                            onWheel={(event) => event.stopPropagation()}
                        />
                        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
                            {originalPrompt && prompt !== originalPrompt ? (
                                <button type="button" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]" style={{ background: "#262626", color: "#a3a3a3" }} onClick={() => setPrompt(originalPrompt)} title="恢复原文">
                                    <RotateCcw className="size-3" />
                                    恢复
                                </button>
                            ) : null}
                            <button
                                type="button"
                                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
                                style={{ background: "#262626", color: "#d4d4d4" }}
                                disabled={!prompt.trim() || optimizing || busy || generating}
                                title={!prompt.trim() ? "先填写提示词" : undefined}
                                onClick={() => void runOptimize()}
                            >
                                {optimizing ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                                优化
                            </button>
                        </div>
                    </div>
                    {optimizeError ? <div className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-400">{optimizeError}</div> : null}

                    <Button type="primary" loading={busy} onClick={() => void runPreview()}>
                        生图预览
                    </Button>
                    <Button type="primary" loading={generating} disabled={Boolean(generateDisabledReason)} title={generateDisabledReason || undefined} onClick={() => void runGenerateVideo()}>
                        生成视频
                    </Button>

                    {previewError ? <div className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-400">{previewError}</div> : null}
                    <div className="grid grid-cols-2 gap-2">
                        {previews.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className="relative overflow-hidden rounded-lg border text-left"
                                style={{ borderColor: pinned === item.id ? "#4096ff" : "#3a3a3a" }}
                                onMouseEnter={() => setHovered(item.id)}
                                onMouseLeave={() => setHovered(null)}
                                onClick={() => setPinned(item.id)}
                            >
                                <img src={item.url} alt="" className="h-20 w-full object-cover" />
                                <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">{item.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="px-3 pb-3" style={{ background: "#141414" }}>
                <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={1 / 24}
                    value={frameT}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        setFrameT(next);
                        if (videoRef.current) videoRef.current.currentTime = next;
                    }}
                    className="w-full accent-[#4096ff]"
                />
                <div className="text-center text-[10px]" style={{ color: "#737373" }}>
                    {currentFrame} / {frameCount}
                </div>
            </div>
        </Modal>
    );
}
