import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal } from "antd";
import { Minimize2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasOutpaintPayload = {
    prompt: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    generate: boolean;
};

type CanvasNodeOutpaintDialogProps = {
    dataUrl: string;
    open: boolean;
    promptDefault?: string;
    onClose: () => void;
    onConfirm: (payload: CanvasOutpaintPayload) => void;
};

type CanvasState = { width: number; height: number; x: number; y: number };

const RATIOS = [
    { key: "original", label: "原图" },
    { key: "1:1", label: "1:1", value: 1 },
    { key: "4:3", label: "4:3", value: 4 / 3 },
    { key: "16:9", label: "16:9", value: 16 / 9 },
    { key: "9:16", label: "9:16", value: 9 / 16 },
];
const MAX_EDGE = 4096;
const MAX_PIXELS = 8_000_000;
const MIN_MARGIN = 64;

const align32 = (value: number) => Math.max(32, Math.round(value / 32) * 32);

function clampCanvasSize(width: number, height: number, imageWidth: number, imageHeight: number) {
    let w = Math.max(align32(width), align32(imageWidth + MIN_MARGIN));
    let h = Math.max(align32(height), align32(imageHeight + MIN_MARGIN));
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
    w = align32(w * scale);
    h = align32(h * scale);
    return { width: w, height: h };
}

function clampOffset(x: number, y: number, canvas: { width: number; height: number }, imageWidth: number, imageHeight: number) {
    return {
        x: Math.min(Math.max(0, x), Math.max(0, canvas.width - imageWidth)),
        y: Math.min(Math.max(0, y), Math.max(0, canvas.height - imageHeight)),
    };
}

export function CanvasNodeOutpaintDialog({ dataUrl, open, promptDefault = "", onClose, onConfirm }: CanvasNodeOutpaintDialogProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const boardRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
    const initRef = useRef<{ dataUrl: string; promptDefault: string } | null>(null);
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [prompt, setPrompt] = useState(promptDefault);
    const [ratioKey, setRatioKey] = useState("original");
    const [canvas, setCanvas] = useState<CanvasState>({ width: 1024, height: 1024, x: 0, y: 0 });
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open || !dataUrl) {
            if (!open) initRef.current = null;
            return;
        }
        const previous = initRef.current;
        if (previous && previous.dataUrl === dataUrl && previous.promptDefault === promptDefault) return;
        initRef.current = { dataUrl, promptDefault };
        const next = new Image();
        next.onload = () => {
            const width = next.naturalWidth || 1024;
            const height = next.naturalHeight || 1024;
            const size = clampCanvasSize(width * 1.5, height * 1.5, width, height);
            setImage(next);
            setRatioKey("original");
            setPrompt(promptDefault);
            setError("");
            setCanvas({ ...size, x: (size.width - width) / 2, y: (size.height - height) / 2 });
        };
        next.src = dataUrl;
    }, [dataUrl, open, promptDefault]);

    const ratio = ratioKey === "original" ? (image ? image.naturalWidth / image.naturalHeight : 1) : (RATIOS.find((item) => item.key === ratioKey)?.value || 1);
    const boardWidth = ratio >= 1 ? 560 : Math.round(460 * ratio);
    const boardHeight = ratio >= 1 ? Math.round(560 / ratio) : 460;
    const scale = image ? Math.min(boardWidth / canvas.width, boardHeight / canvas.height) : 1;
    const imageWidth = image?.naturalWidth || 1;
    const imageHeight = image?.naturalHeight || 1;
    const shownWidth = imageWidth * scale;
    const shownHeight = imageHeight * scale;
    const left = (boardWidth - canvas.width * scale) / 2 + canvas.x * scale;
    const top = (boardHeight - canvas.height * scale) / 2 + canvas.y * scale;
    const leftPad = Math.max(0, Math.round(canvas.x));
    const topPad = Math.max(0, Math.round(canvas.y));
    const rightPad = Math.max(0, Math.round(canvas.width - imageWidth - canvas.x));
    const bottomPad = Math.max(0, Math.round(canvas.height - imageHeight - canvas.y));

    const applyRatio = (key: string) => {
        if (!image) return;
        const nextRatio = key === "original" ? imageWidth / imageHeight : (RATIOS.find((item) => item.key === key)?.value || 1);
        const area = key === "original" ? Math.max(imageWidth * imageHeight * 2.25, 1) : Math.max(canvas.width * canvas.height, imageWidth * imageHeight * 1.5);
        let width = Math.sqrt(area * nextRatio);
        let height = width / nextRatio;
        if (width < imageWidth + MIN_MARGIN) {
            width = imageWidth + MIN_MARGIN;
            height = width / nextRatio;
        }
        if (height < imageHeight + MIN_MARGIN) {
            height = imageHeight + MIN_MARGIN;
            width = height * nextRatio;
        }
        const size = clampCanvasSize(width, height, imageWidth, imageHeight);
        setRatioKey(key);
        setCanvas({ ...size, x: (size.width - imageWidth) / 2, y: (size.height - imageHeight) / 2 });
    };

    const zoom = (factor: number) => {
        if (!image) return;
        setCanvas((previous) => {
            const centerX = previous.x + imageWidth / 2;
            const centerY = previous.y + imageHeight / 2;
            const size = clampCanvasSize(previous.width * factor, previous.height * factor, imageWidth, imageHeight);
            const offset = clampOffset(centerX - imageWidth / 2, centerY - imageHeight / 2, size, imageWidth, imageHeight);
            return { ...size, ...offset };
        });
    };

    useEffect(() => {
        if (!open) return;
        const node = boardRef.current;
        if (!node) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12);
        };
        node.addEventListener("wheel", onWheel, { passive: false });
        return () => node.removeEventListener("wheel", onWheel);
    }, [open, imageWidth, imageHeight]);

    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startY: event.clientY, offsetX: canvas.x, offsetY: canvas.y };
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const next = clampOffset(drag.offsetX + (event.clientX - drag.startX) / scale, drag.offsetY + (event.clientY - drag.startY) / scale, canvas, imageWidth, imageHeight);
        setCanvas((previous) => ({ ...previous, ...next }));
    };
    const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text) return setError("请填写扩图提示词");
        onConfirm({
            prompt: text,
            left: leftPad,
            top: topPad,
            right: rightPad,
            bottom: bottomPad,
            width: canvas.width,
            height: canvas.height,
            generate: true,
        });
    };

    return (
        <Modal open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_300px]" data-canvas-no-zoom>
                <div
                    ref={boardRef}
                    className="relative flex min-h-[420px] select-none items-center justify-center overflow-hidden rounded-2xl"
                    style={{
                        backgroundColor: theme.node.fill,
                        touchAction: "none",
                    }}
                >
                    <div
                        className="relative overflow-hidden rounded-lg"
                        style={{
                            width: boardWidth,
                            height: boardHeight,
                            backgroundImage: `linear-gradient(45deg, ${theme.node.stroke} 25%, transparent 25%), linear-gradient(-45deg, ${theme.node.stroke} 25%, transparent 25%), linear-gradient(45deg, transparent 75%, ${theme.node.stroke} 75%), linear-gradient(-45deg, transparent 75%, ${theme.node.stroke} 75%)`,
                            backgroundSize: "24px 24px",
                            backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0",
                            backgroundColor: theme.node.fill,
                        }}
                    >
                        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/55 px-2 py-0.5 text-[10px] text-white">
                            棋盘格 = 输出画布 {canvas.width} × {canvas.height}
                        </div>
                        {image ? (
                            <div
                                className="absolute cursor-move overflow-hidden rounded-md border-2 shadow-lg"
                                style={{ left, top, width: shownWidth, height: shownHeight, borderColor: "#3b82f6", touchAction: "none" }}
                                onPointerDown={startDrag}
                                onPointerMove={moveDrag}
                                onPointerUp={endDrag}
                                onPointerCancel={endDrag}
                            >
                                <img src={dataUrl} alt="" className="h-full w-full select-none object-fill" draggable={false} />
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="space-y-4" style={{ color: theme.node.text }}>
                    <div>
                        <div className="text-lg font-semibold">扩图</div>
                        <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                            拖拽图片调整位置；棋盘格区域就是输出画布。滚轮或下方按钮扩大/缩小画布，原图围绕当前位置缩放。
                        </div>
                    </div>
                    <div className="space-y-2">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>比例</div>
                        <div className="grid grid-cols-3 gap-2">
                            {RATIOS.map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    className="h-8 cursor-pointer rounded-full border px-2 text-xs transition hover:opacity-80"
                                    style={{ borderColor: ratioKey === item.key ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                    onClick={() => applyRatio(item.key)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-1 rounded-xl border p-3 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <div className="flex justify-between"><span>输出画布</span><span style={{ color: theme.node.text }}>{canvas.width} × {canvas.height}</span></div>
                        <div className="flex justify-between"><span>上 / 下</span><span>{topPad} / {bottomPad} px</span></div>
                        <div className="flex justify-between"><span>左 / 右</span><span>{leftPad} / {rightPad} px</span></div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button size="small" onClick={() => zoom(1.12)}>扩大画布</Button>
                        <Button size="small" onClick={() => zoom(1 / 1.12)}>缩小画布</Button>
                        <Button size="small" icon={<Minimize2 className="size-3.5" />} onClick={() => setCanvas((previous) => ({ ...previous, x: (previous.width - imageWidth) / 2, y: (previous.height - imageHeight) / 2 }))}>
                            居中
                        </Button>
                    </div>
                    <div className="space-y-2">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>提示词</div>
                        <Input.TextArea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            autoSize={{ minRows: 3, maxRows: 5 }}
                            placeholder="描述空白区域要补什么，例如：向两侧自然延伸夜景街道与湿润反光"
                        />
                        {error ? <div className="text-xs text-red-500">{error}</div> : null}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" onClick={submit}>生成</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
