export type ProgressRingSkinId = "cyan" | "violet" | "aurora" | "amber" | "rose" | "ice" | "tide";

export type ProgressRingPalette = {
    glow: string;
    mid: string;
    core: string;
    gradient: [string, string, string];
};

export type ProgressRingStyle = {
    coreWidth: number;
    auraWidth: number;
    auraOpacity: number;
    auraBlur: number;
    haloWidth: number;
    haloOpacity: number;
    haloBlur: number;
    midWidth: number;
    midOpacity: number;
    midBlur: number;
    tailLength: number;
    tailWidth: number;
    tailOpacity: number;
    tailBlur: number;
    headScale: number;
    breatheSeconds: number;
};

export type ProgressRingSkin = {
    id: ProgressRingSkinId;
    mode?: "ring" | "tide";
    dark: ProgressRingPalette;
    light: ProgressRingPalette;
    style: ProgressRingStyle;
};

const balancedStyle: ProgressRingStyle = {
    coreWidth: 1.4,
    auraWidth: 11,
    auraOpacity: 0.05,
    auraBlur: 8,
    haloWidth: 6,
    haloOpacity: 0.11,
    haloBlur: 5,
    midWidth: 3,
    midOpacity: 0.18,
    midBlur: 2,
    tailLength: 9,
    tailWidth: 3.4,
    tailOpacity: 0.15,
    tailBlur: 3,
    headScale: 1,
    breatheSeconds: 2.8,
};

export const progressRingSkins: ProgressRingSkin[] = [
    {
        id: "cyan",
        dark: { glow: "#38d6ff", mid: "#8cefff", core: "#d7fbff", gradient: ["#8cefff", "#6edcff", "#4aa3ff"] },
        light: { glow: "#2f9bff", mid: "#5bb8ff", core: "#0b6fd6", gradient: ["#0b6fd6", "#2f9bff", "#7dd3fc"] },
        style: balancedStyle,
    },
    {
        id: "violet",
        dark: { glow: "#b56cff", mid: "#d8b4fe", core: "#f6edff", gradient: ["#d8b4fe", "#b56cff", "#7c7cff"] },
        light: { glow: "#8b5cf6", mid: "#c084fc", core: "#6d28d9", gradient: ["#6d28d9", "#a855f7", "#c084fc"] },
        style: { ...balancedStyle, coreWidth: 1.6, haloWidth: 7, haloOpacity: 0.13, midWidth: 3.4, midOpacity: 0.2, tailLength: 12, tailWidth: 4, tailOpacity: 0.18, breatheSeconds: 2.6 },
    },
    {
        id: "aurora",
        dark: { glow: "#35e0b8", mid: "#8ff7dc", core: "#eafffb", gradient: ["#8ff7dc", "#35e0b8", "#3ee089"] },
        light: { glow: "#0d9488", mid: "#2dd4bf", core: "#0f766e", gradient: ["#0f766e", "#14b8a6", "#5eead4"] },
        style: { ...balancedStyle, auraWidth: 14, auraOpacity: 0.06, auraBlur: 10, haloWidth: 8, haloOpacity: 0.12, haloBlur: 7, midWidth: 3, midOpacity: 0.16, midBlur: 3, tailLength: 14, tailWidth: 4, tailOpacity: 0.16, tailBlur: 4, breatheSeconds: 3.2 },
    },
    {
        id: "amber",
        dark: { glow: "#ffae4a", mid: "#ffd08a", core: "#fff8ec", gradient: ["#ffd08a", "#ffae4a", "#ff7a59"] },
        light: { glow: "#ea580c", mid: "#fb923c", core: "#9a3412", gradient: ["#c2410c", "#f97316", "#fdba74"] },
        style: { ...balancedStyle, coreWidth: 1.5, haloWidth: 6, haloOpacity: 0.14, midWidth: 3.2, midOpacity: 0.2, tailLength: 8, tailWidth: 3, tailOpacity: 0.18, tailBlur: 2.5, headScale: 0.95, breatheSeconds: 2.4 },
    },
    {
        id: "rose",
        dark: { glow: "#ff7ac8", mid: "#ffb3de", core: "#fff0fa", gradient: ["#ffb3de", "#ff7ac8", "#c084fc"] },
        light: { glow: "#db2777", mid: "#f472b6", core: "#9d174d", gradient: ["#9d174d", "#ec4899", "#f9a8d4"] },
        style: { ...balancedStyle, coreWidth: 1.5, haloWidth: 7, haloOpacity: 0.12, haloBlur: 6, midWidth: 3.2, midOpacity: 0.18, midBlur: 2.5, tailLength: 12, tailWidth: 3.6, tailOpacity: 0.2, headScale: 1.1, breatheSeconds: 2 },
    },
    {
        id: "ice",
        dark: { glow: "#9adcff", mid: "#cdefff", core: "#ffffff", gradient: ["#cdefff", "#9adcff", "#79b8ff"] },
        light: { glow: "#0ea5e9", mid: "#7dd3fc", core: "#075985", gradient: ["#075985", "#0ea5e9", "#bae6fd"] },
        style: { coreWidth: 1.1, auraWidth: 9, auraOpacity: 0.03, auraBlur: 10, haloWidth: 4, haloOpacity: 0.05, haloBlur: 6, midWidth: 2, midOpacity: 0.1, midBlur: 3, tailLength: 0, tailWidth: 0, tailOpacity: 0, tailBlur: 0, headScale: 0.75, breatheSeconds: 3.6 },
    },
    {
        id: "tide",
        mode: "tide",
        dark: { glow: "#4fe3ff", mid: "#b5f7ff", core: "#f2ffff", gradient: ["#0b3b4d", "#1aa9c9", "#8ef4ff"] },
        light: { glow: "#0891b2", mid: "#67e8f9", core: "#ecfeff", gradient: ["#cffafe", "#67e8f9", "#0e7490"] },
        style: balancedStyle,
    },
];

const skinIds = new Set(progressRingSkins.map((skin) => skin.id));

export function normalizeProgressRingSkin(value: unknown): ProgressRingSkinId {
    const id = String(value || "").trim() as ProgressRingSkinId;
    return skinIds.has(id) ? id : "cyan";
}

export function getProgressRingSkin(value: unknown): ProgressRingSkin {
    const id = normalizeProgressRingSkin(value);
    return progressRingSkins.find((skin) => skin.id === id) || progressRingSkins[0];
}
