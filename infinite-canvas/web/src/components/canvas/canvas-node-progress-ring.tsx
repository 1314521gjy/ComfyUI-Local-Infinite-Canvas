import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { getProgressRingSkin, type ProgressRingPalette } from "@/lib/canvas/progress-ring-skins";

const ringPad = 2;
const ringRadius = 26;

export function CanvasNodeProgressRing({ width, height, step, total, complete = false }: { width: number; height: number; step: number; total: number; complete?: boolean }) {
    const themeName = useThemeStore((state) => state.theme);
    const skinId = useConfigStore((state) => state.config.progressRingSkin);
    const theme = useCanvasTheme();
    const dark = themeName === "dark";
    const skin = getProgressRingSkin(skinId);
    const palette = dark ? skin.dark : skin.light;
    const look = skin.style;
    const ratio = complete ? 1 : total > 0 ? Math.min(1, Math.max(0, step / total)) : 0;
    if ((skin.mode || "ring") === "tide") {
        return <TideOverlay width={width} height={height} ratio={ratio} complete={complete} palette={palette} />;
    }
    const boxWidth = width + ringPad * 2;
    const boxHeight = height + ringPad * 2;
    const radius = Math.min(ringRadius, boxWidth / 2, boxHeight / 2);
    const coreWidth = look.coreWidth;
    const path = roundedRectPath(boxWidth, boxHeight, radius, coreWidth);
    const head = pointAtProgress(boxWidth, boxHeight, radius, ratio, coreWidth / 2);
    const { glow, mid, core } = palette;
    const track = theme.node.stroke;
    const gradientId = `canvas-ring-gradient-${skin.id}-${dark ? "dark" : "light"}`;
    const fillLength = ratio * 100;
    const tailLength = Math.min(look.tailLength, fillLength);

    return (
        <div className="pointer-events-none absolute z-[58]" style={{ left: -ringPad, top: -ringPad, width: boxWidth, height: boxHeight }}>
            <style>{`
                @keyframes canvas-ring-breathe { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }
                @keyframes canvas-ring-head { 0%, 100% { opacity: .62 } 50% { opacity: 1 } }
                @keyframes canvas-ring-fade { 0%, 55% { opacity: 1 } 100% { opacity: 0 } }
                @keyframes canvas-ring-flash { 0% { opacity: 0 } 35% { opacity: .5 } 100% { opacity: 0 } }
                @keyframes canvas-ring-core-flash { 0% { opacity: 0 } 30% { opacity: 1 } 100% { opacity: 0 } }
            `}</style>
            <svg width={boxWidth} height={boxHeight} viewBox={`0 0 ${boxWidth} ${boxHeight}`} className="overflow-visible" aria-hidden="true">
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor={palette.gradient[0]} />
                        <stop offset="55%" stopColor={palette.gradient[1]} />
                        <stop offset="100%" stopColor={palette.gradient[2]} />
                    </linearGradient>
                </defs>
                <g style={complete ? { animation: "canvas-ring-fade 1.45s ease forwards" } : undefined}>
                    <path d={path} fill="none" stroke={track} strokeWidth={1.1} opacity={0.18} style={{ animation: `canvas-ring-breathe ${look.breatheSeconds + 0.4}s ease-in-out infinite` }} />
                    {ratio > 0 ? (
                        <g>
                            <path
                                d={path}
                                fill="none"
                                stroke={glow}
                                strokeWidth={look.auraWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.auraOpacity,
                                    filter: `blur(${look.auraBlur}px)`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                }}
                            />
                            <path
                                d={path}
                                fill="none"
                                stroke={glow}
                                strokeWidth={look.haloWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.haloOpacity,
                                    filter: `blur(${look.haloBlur}px) drop-shadow(0 0 4px ${glow})`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                    animation: `canvas-ring-breathe ${look.breatheSeconds}s ease-in-out infinite`,
                                }}
                            />
                            <path
                                d={path}
                                fill="none"
                                stroke={mid}
                                strokeWidth={look.midWidth}
                                strokeLinecap="round"
                                pathLength={100}
                                style={{
                                    strokeDasharray: `${fillLength} 100`,
                                    opacity: look.midOpacity,
                                    filter: `blur(${look.midBlur}px)`,
                                    transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                                    animation: `canvas-ring-breathe ${look.breatheSeconds}s ease-in-out .5s infinite`,
                                }}
                            />
                            {tailLength > 0.5 ? (
                                <path
                                    d={path}
                                    fill="none"
                                    stroke={glow}
                                    strokeWidth={look.tailWidth}
                                    strokeLinecap="round"
                                    pathLength={100}
                                    style={{
                                        strokeDasharray: `${tailLength} 100`,
                                        strokeDashoffset: -(fillLength - tailLength),
                                        opacity: look.tailOpacity,
                                        filter: `blur(${look.tailBlur}px)`,
                                        transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1), stroke-dashoffset 320ms cubic-bezier(.22,.61,.36,1)",
                                    }}
                                />
                            ) : null}
                        </g>
                    ) : null}
                    {ratio > 0 ? (
                        <path
                            d={path}
                            fill="none"
                            stroke={`url(#${gradientId})`}
                            strokeWidth={coreWidth}
                            strokeLinecap="round"
                            pathLength={100}
                            opacity={0.9}
                            style={{
                                strokeDasharray: `${fillLength} 100`,
                                filter: `drop-shadow(0 0 2px ${glow})`,
                                transition: "stroke-dasharray 320ms cubic-bezier(.22,.61,.36,1)",
                            }}
                        />
                    ) : null}
                    {ratio > 0 && ratio < 1 ? (
                        <g
                            style={{
                                transform: `translate(${head.x}px, ${head.y}px)`,
                                transition: "transform 320ms cubic-bezier(.22,.61,.36,1)",
                            }}
                        >
                            <g style={{ animation: `canvas-ring-head ${Math.max(1.4, look.breatheSeconds - 0.9)}s ease-in-out infinite` }}>
                                <circle r={4.5 * look.headScale} fill={glow} opacity={0.14} style={{ filter: "blur(3px)" }} />
                                <circle r={2.2 * look.headScale} fill={mid} opacity={0.28} style={{ filter: "blur(1px)" }} />
                                <circle r={0.9 * look.headScale} fill={core} opacity={0.95} />
                            </g>
                        </g>
                    ) : null}
                    {complete ? (
                        <>
                            <path
                                d={path}
                                fill="none"
                                stroke={glow}
                                strokeWidth={look.haloWidth + 3}
                                strokeLinecap="round"
                                opacity={0}
                                style={{ filter: `blur(${look.haloBlur}px)`, animation: "canvas-ring-flash .95s ease-out forwards" }}
                            />
                            <path
                                d={path}
                                fill="none"
                                stroke={core}
                                strokeWidth={coreWidth + 0.2}
                                strokeLinecap="round"
                                opacity={0}
                                style={{ filter: `drop-shadow(0 0 4px ${glow})`, animation: "canvas-ring-core-flash .95s ease-out forwards" }}
                            />
                        </>
                    ) : null}
                </g>
            </svg>
        </div>
    );
}

function TideOverlay({ width, height, ratio, complete, palette }: { width: number; height: number; ratio: number; complete: boolean; palette: ProgressRingPalette }) {
    const { t } = useTranslation();
    const uid = useId().replace(/:/g, "");
    const waterId = `tide-water-${uid}`;
    const level = complete ? 1 : Math.max(0, Math.min(1, ratio));
    const wavePath = "M -50 3 Q -37.5 -2 -25 3 T 0 3 T 25 3 T 50 3 T 75 3 T 100 3 T 125 3 T 150 3 L 150 100 L -50 100 Z";
    const crestPath = "M -50 3 Q -37.5 -2 -25 3 T 0 3 T 25 3 T 50 3 T 75 3 T 100 3 T 125 3 T 150 3";

    return (
        <div className="pointer-events-none absolute inset-0 z-[58] overflow-hidden" style={{ width, height, borderRadius: 24 }}>
            <style>{`
                @keyframes tide-wave-a { to { transform: translateX(-50px); } }
                @keyframes tide-wave-b { to { transform: translateX(-50px); } }
                @keyframes tide-shimmer { 0%, 100% { opacity: .22 } 50% { opacity: .5 } }
                @keyframes tide-bubble { 0% { transform: translateY(8px) scale(.6); opacity: 0 } 20% { opacity: .45 } 100% { transform: translateY(-46px) scale(1.1); opacity: 0 } }
                @keyframes tide-flash { 0% { opacity: 0 } 30% { opacity: .85 } 100% { opacity: 0 } }
                @keyframes tide-fade { 0%, 70% { opacity: 1 } 100% { opacity: 0 } }
            `}</style>
            <div className="absolute inset-0" style={{ animation: complete ? "tide-fade 1.45s ease forwards" : undefined }}>
                <div
                    className="absolute inset-x-0 bottom-0 overflow-hidden"
                    style={{
                        height: `${level * 100}%`,
                        transition: "height 620ms cubic-bezier(.2,.8,.2,1)",
                        backdropFilter: "blur(1.5px) saturate(1.3)",
                        boxShadow: `inset 0 0 36px ${palette.glow}33, 0 -10px 30px ${palette.glow}55`,
                    }}
                >
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
                        <defs>
                            <linearGradient id={waterId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={palette.core} stopOpacity={0.5} />
                                <stop offset="35%" stopColor={palette.mid} stopOpacity={0.32} />
                                <stop offset="100%" stopColor={palette.glow} stopOpacity={0.2} />
                            </linearGradient>
                        </defs>
                        <path d={wavePath} fill={`url(#${waterId})`} />
                        <g style={{ animation: "tide-wave-a 5.5s linear infinite" }}>
                            <path d={crestPath} fill="none" stroke={palette.core} strokeOpacity={0.95} strokeWidth={1.2} vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 6px ${palette.glow})` }} />
                        </g>
                        <g style={{ animation: "tide-wave-b 8s linear infinite", opacity: 0.4 }}>
                            <path d={wavePath} fill={palette.glow} fillOpacity={0.12} transform="translate(12.5 1.5)" />
                            <path d={crestPath} fill="none" stroke={palette.glow} strokeOpacity={0.5} strokeWidth={0.8} vectorEffect="non-scaling-stroke" transform="translate(12.5 1.5)" />
                        </g>
                    </svg>
                    <div className="absolute inset-x-0 top-0 h-4 -translate-y-1/2" style={{ background: `linear-gradient(to top, ${palette.glow}55, transparent)`, filter: "blur(5px)", opacity: 0.8 }} />
                    <div className="absolute inset-0" style={{ background: `linear-gradient(120deg, transparent 15%, ${palette.core}22 48%, transparent 62%)`, mixBlendMode: "screen", animation: "tide-shimmer 3.6s ease-in-out infinite" }} />
                    {[18, 36, 57, 74].map((left, index) => (
                        <span
                            key={left}
                            className="absolute rounded-full"
                            style={{
                                left: `${left}%`,
                                bottom: `${14 + index * 13}%`,
                                width: 3 + index,
                                height: 3 + index,
                                background: palette.core,
                                opacity: 0.45,
                                filter: "blur(.4px)",
                                boxShadow: `0 0 6px ${palette.glow}`,
                                animation: `tide-bubble ${4.2 + index * 0.7}s ease-in ${index * 0.8}s infinite`,
                            }}
                        />
                    ))}
                </div>
                <div className="absolute inset-x-0 bottom-3 flex justify-center">
                    <span className="rounded-full bg-black/30 px-2.5 py-1 text-[10px] font-medium tracking-[0.18em] text-white/85 backdrop-blur-sm">{t("canvas.node.generating")}</span>
                </div>
                {complete ? (
                    <>
                        <div className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 72%, ${palette.core}d9 0%, ${palette.glow}66 38%, transparent 72%)`, animation: "tide-flash .75s ease-out .5s forwards", opacity: 0 }} />
                        <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${palette.core}, transparent)`, boxShadow: `0 0 10px ${palette.glow}`, animation: "tide-flash .6s ease-out .5s forwards", opacity: 0 }} />
                    </>
                ) : null}
            </div>
        </div>
    );
}

function roundedRectPath(width: number, height: number, radius: number, strokeWidth: number) {
    const inset = strokeWidth / 2;
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    return [
        `M ${left + r} ${top}`,
        `H ${right - r}`,
        `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
        `V ${bottom - r}`,
        `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
        `H ${left + r}`,
        `A ${r} ${r} 0 0 1 ${left} ${bottom - r}`,
        `V ${top + r}`,
        `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
        "Z",
    ].join(" ");
}

function pointAtProgress(width: number, height: number, radius: number, ratio: number, inset: number) {
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
    const straightX = Math.max(0, right - left - 2 * r);
    const straightY = Math.max(0, bottom - top - 2 * r);
    const arc = (Math.PI * r) / 2;
    const perimeter = 2 * straightX + 2 * straightY + 4 * arc;
    let distance = Math.min(perimeter, Math.max(0, ratio * perimeter));
    const segments = [
        { type: "line" as const, length: straightX, from: { x: left + r, y: top }, to: { x: right - r, y: top } },
        { type: "arc" as const, length: arc, cx: right - r, cy: top + r, from: -Math.PI / 2, to: 0 },
        { type: "line" as const, length: straightY, from: { x: right, y: top + r }, to: { x: right, y: bottom - r } },
        { type: "arc" as const, length: arc, cx: right - r, cy: bottom - r, from: 0, to: Math.PI / 2 },
        { type: "line" as const, length: straightX, from: { x: right - r, y: bottom }, to: { x: left + r, y: bottom } },
        { type: "arc" as const, length: arc, cx: left + r, cy: bottom - r, from: Math.PI / 2, to: Math.PI },
        { type: "line" as const, length: straightY, from: { x: left, y: bottom - r }, to: { x: left, y: top + r } },
        { type: "arc" as const, length: arc, cx: left + r, cy: top + r, from: Math.PI, to: (Math.PI * 3) / 2 },
    ];
    for (const segment of segments) {
        if (distance > segment.length) {
            distance -= segment.length;
            continue;
        }
        if (segment.type === "line") {
            const progress = segment.length > 0 ? distance / segment.length : 0;
            return {
                x: segment.from.x + (segment.to.x - segment.from.x) * progress,
                y: segment.from.y + (segment.to.y - segment.from.y) * progress,
            };
        }
        const angle = segment.from + (segment.to - segment.from) * (segment.length > 0 ? distance / segment.length : 0);
        return { x: segment.cx + Math.cos(angle) * r, y: segment.cy + Math.sin(angle) * r };
    }
    return { x: left + r, y: top };
}
