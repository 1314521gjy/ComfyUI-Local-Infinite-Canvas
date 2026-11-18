import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button, Segmented, Select, Slider, Switch } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { AUDIO_DURATION_AUTO, DIALOGUE_SPEEDS, DIALOGUE_TONES, SONG_DURATION_MAX, SONG_DURATION_MIN, SONG_DURATION_STEP } from "@/lib/canvas/audio-options";
import type { AiConfig } from "@/stores/use-config-store";

export type CanvasAudioSettingKey = "audioSeed" | "audioBpm" | "audioStrength" | "audioStyle" | "audioDuration" | "audioGender" | "audioDialogueSpeed" | "audioDialogueTone";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topRight" }: CanvasAudioSettingsPopoverProps) {
    const theme = useCanvasTheme();
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-select-dropdown, .ant-dropdown, .ant-popover")) return;
            setOpen(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <AudioSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !justify-center !rounded-lg !px-2"} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">设置</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({ buttonRect, panelRef, placement, theme, config, onConfigChange }: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
}) {
    const mode = config.audioMode === "song" ? "song" : "dialogue";
    const autoDuration = mode === "song" && config.audioDuration === AUDIO_DURATION_AUTO;
    const lastManualRef = useRef(config.audioDuration && config.audioDuration !== AUDIO_DURATION_AUTO ? config.audioDuration : "120");
    useEffect(() => {
        if (mode === "song" && !autoDuration && config.audioDuration) lastManualRef.current = config.audioDuration;
    }, [mode, autoDuration, config.audioDuration]);
    const parsedDuration = Number(autoDuration ? lastManualRef.current : config.audioDuration || "120");
    const durationValue = Math.min(SONG_DURATION_MAX, Math.max(SONG_DURATION_MIN, Number.isFinite(parsedDuration) ? parsedDuration : 120));
    const parsedBpm = Number(config.audioBpm);
    const bpmValue = Math.min(240, Math.max(40, Number.isFinite(parsedBpm) && parsedBpm > 0 ? parsedBpm : 120));
    const fieldStyle = { borderColor: theme.toolbar.border, color: theme.node.text, WebkitTextFillColor: theme.node.text } as const;
    const fieldClass = "h-8 w-full min-w-0 rounded-lg border bg-transparent px-2 text-sm outline-none";
    const width = 320;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed", zIndex: 1200, width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(360, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(360, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel, borderRadius: 18, boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18, overflowY: "auto", color: theme.node.text,
    } as const;
    return createPortal(
        <div ref={panelRef} className="canvas-image-settings-popover" style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="space-y-3">
                {mode === "song" ? (
                    <>
                        <label className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>种子</span>
                            <input className={fieldClass} style={fieldStyle} value={config.audioSeed || ""} onChange={(event) => onConfigChange("audioSeed", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>语速</span>
                            <Slider className="min-w-0 flex-1" min={40} max={240} step={5} value={bpmValue} onChange={(value) => onConfigChange("audioBpm", String(value))} tooltip={{ open: false }} />
                            <span className="w-14 shrink-0 text-right text-[11px] tabular-nums" style={{ color: theme.node.text }}>{bpmValue} BPM</span>
                        </label>
                        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-[11px]" style={{ color: theme.node.muted }}>自动时长</span>
                                <Switch size="small" checked={autoDuration} onChange={(checked) => onConfigChange("audioDuration", checked ? AUDIO_DURATION_AUTO : lastManualRef.current || "120")} />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>时长</span>
                                <Slider className="min-w-0 flex-1" min={SONG_DURATION_MIN} max={SONG_DURATION_MAX} step={SONG_DURATION_STEP} value={durationValue} disabled={autoDuration} onChange={(value) => onConfigChange("audioDuration", String(value))} tooltip={{ open: false }} />
                                <span className="w-9 shrink-0 text-right text-[11px] tabular-nums" style={{ color: autoDuration ? theme.node.muted : theme.node.text }}>{autoDuration ? "自动" : `${durationValue}s`}</span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>声线</span>
                            <Segmented
                                block
                                size="small"
                                className="min-w-0 flex-1"
                                value={config.audioGender || "auto"}
                                options={[
                                    { label: "自动", value: "auto" },
                                    { label: "男声", value: "male" },
                                    { label: "女声", value: "female" },
                                ]}
                                onChange={(value) => onConfigChange("audioGender", String(value))}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <label className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>语速</span>
                            <Select className="min-w-0 flex-1" value={config.audioDialogueSpeed || "中速"} options={DIALOGUE_SPEEDS.map((value) => ({ value, label: value }))} onChange={(value) => onConfigChange("audioDialogueSpeed", value)} popupMatchSelectWidth={false} styles={{ popup: { root: { zIndex: 1300 } } }} />
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>语气</span>
                            <Select className="min-w-0 flex-1" value={config.audioDialogueTone || "自然"} options={DIALOGUE_TONES.map((value) => ({ value, label: value }))} onChange={(value) => onConfigChange("audioDialogueTone", value)} popupMatchSelectWidth={false} styles={{ popup: { root: { zIndex: 1300 } } }} />
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-[52px] shrink-0 text-[11px]" style={{ color: theme.node.muted }}>种子</span>
                            <input className={fieldClass} style={fieldStyle} value={config.audioSeed || ""} onChange={(event) => onConfigChange("audioSeed", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                        </label>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
