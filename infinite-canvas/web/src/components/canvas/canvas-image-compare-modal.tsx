import { useEffect, useRef, useState } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

export type CanvasImageCompareItem = { id: string; title: string; src: string };

export function CanvasImageCompareModal({ open, items, onClose }: { open: boolean; items: CanvasImageCompareItem[]; onClose: () => void }) {
    const { t } = useTranslation();
    const [position, setPosition] = useState(50);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [left, right] = items;
    const visible = open && Boolean(left?.src) && Boolean(right?.src);

    useEffect(() => {
        if (open) setPosition(50);
    }, [open]);

    const updateFromClientX = (clientX: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect?.width) return;
        setPosition(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
    };

    return (
        <Modal
            open={visible}
            title={t("canvas.projectPage.compareTitle")}
            centered
            onCancel={onClose}
            destroyOnHidden
            footer={null}
            width="92vw"
            style={{ maxWidth: 1500, top: 24 }}
            styles={{ body: { padding: 0, overflow: "hidden" } }}
        >
            {visible ? (
                <div data-testid="canvas-image-compare">
                    <div
                        ref={containerRef}
                        className="relative w-full select-none overflow-hidden bg-[#0b0c0e]"
                        style={{ height: "min(78vh, 900px)", touchAction: "none", cursor: "ew-resize" }}
                        onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            updateFromClientX(event.clientX);
                        }}
                        onPointerMove={(event) => updateFromClientX(event.clientX)}
                    >
                        <img src={right.src} alt={right.title} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
                        <img
                            src={left.src}
                            alt={left.title}
                            draggable={false}
                            data-testid="canvas-image-compare-left"
                            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                            style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
                        />
                        <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur">{t("canvas.projectPage.compareImageLeft")}</span>
                        <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur">{t("canvas.projectPage.compareImageRight")}</span>
                        <div className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_12px_rgba(0,0,0,.55)]" style={{ left: `${position}%` }}>
                            <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white backdrop-blur">
                                <ChevronsLeftRight className="size-4" />
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/10 bg-[#111215] px-4 py-2.5 text-xs text-white/65">
                        <span className="shrink-0">{t("canvas.projectPage.compareHint")}</span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={0.1}
                            value={position}
                            aria-label={t("canvas.projectPage.compareTitle")}
                            onChange={(event) => setPosition(Number(event.target.value))}
                            className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
                        />
                        <span className="w-10 shrink-0 text-right tabular-nums">{Math.round(position)}%</span>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
