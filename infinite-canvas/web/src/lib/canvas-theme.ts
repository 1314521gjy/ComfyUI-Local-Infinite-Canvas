export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f2ed",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#1c1917",
            selectionFill: "rgba(28,25,23,.06)",
        },
        node: {
            label: "#57534e",
            fill: "#e7e5df",
            panel: "#fbfaf7",
            stroke: "#d6d3ca",
            activeStroke: "#1c1917",
            placeholder: "#8a8479",
            text: "#292524",
            muted: "#78716c",
            faint: "#a8a29e",
        },
        toolbar: {
            panel: "rgba(251,250,247,.96)",
            border: "#d6d3ca",
            item: "#57534e",
            itemHover: "#e7e5df",
            activeBg: "#e7e5df",
            activeText: "#292524",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeText: "#f5f5f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];

export type CardSkinId = "warm" | "cream" | "mist" | "forest" | "angel" | "fish";

export const cardSkinIds: CardSkinId[] = ["warm", "cream", "mist", "forest", "angel", "fish"];

type CardSkinNodeOverride = Partial<Record<keyof (typeof canvasThemes)["light"]["node"], string>>;

const cardSkinNodeOverrides: Record<CardSkinId, { light: CardSkinNodeOverride; dark: CardSkinNodeOverride }> = {
    warm: { light: {}, dark: {} },
    cream: {
        light: { label: "#1c1c1c", fill: "#f8f0e2", panel: "#fffaf0", stroke: "#ddcfb9", placeholder: "#7f7f7f", text: "#0f0f0f", muted: "#4a4a4a", faint: "#8a8a8a", activeStroke: "#0f0f0f" },
        dark: { label: "#1c1c1c", fill: "#f6eddc", panel: "#fffaf0", stroke: "#d9cbb4", placeholder: "#7f7f7f", text: "#0f0f0f", muted: "#4a4a4a", faint: "#8a8a8a", activeStroke: "#0f0f0f" },
    },
    mist: {
        light: { label: "#475569", fill: "#e4ebf3", panel: "#f7fafc", stroke: "#c5d2df", placeholder: "#94a3b8", text: "#1e293b", muted: "#64748b", faint: "#94a3b8" },
        dark: { label: "#cbd5e1", fill: "#1e293b", panel: "#16202e", stroke: "#334155", placeholder: "#94a3b8", text: "#f1f5f9", muted: "#94a3b8", faint: "#64748b" },
    },
    forest: {
        light: { label: "#4b6558", fill: "#e2ebe5", panel: "#f7fbf8", stroke: "#c5d6cb", placeholder: "#8fa99b", text: "#1c2a22", muted: "#5f7a6b", faint: "#8fa99b" },
        dark: { label: "#c7d8ce", fill: "#1b2a23", panel: "#142019", stroke: "#345144", placeholder: "#8aa596", text: "#f0f7f2", muted: "#9ab5a6", faint: "#6b8a78" },
    },
    fish: {
        light: { label: "#345a75", fill: "#d7e9f7", panel: "#f2f9ff", stroke: "#a9cce6", placeholder: "#7fa9c7", text: "#0a2236", muted: "#5b7f98", faint: "#8fb2c8" },
        dark: { label: "#a9d6f5", fill: "#0b2438", panel: "#071521", stroke: "#1d4f73", placeholder: "#7fa9c7", text: "#eaf7ff", muted: "#8bb9d8", faint: "#5b87a6" },
    },
    angel: {
        light: { label: "#7a5a2e", fill: "#f7f1e4", panel: "#fffaf0", stroke: "#dcc9a8", placeholder: "#a8987e", text: "#3d3022", muted: "#7d6b52", faint: "#a8987e" },
        dark: { label: "#e8d3a3", fill: "#151d2c", panel: "#0e1520", stroke: "#3b4a63", placeholder: "#8c9ab0", text: "#f7f2e6", muted: "#b7ad99", faint: "#7f8ba0" },
    },
};

type CardSkinToolbarOverride = Partial<Record<keyof (typeof canvasThemes)["light"]["toolbar"], string>>;

const cardSkinToolbarOverrides: Partial<Record<CardSkinId, { light: CardSkinToolbarOverride; dark: CardSkinToolbarOverride }>> = {
    cream: {
        light: { panel: "rgba(255,250,240,.97)", border: "#ddcfb9", item: "#2b2b2b", itemHover: "#f3e8d7", activeBg: "#eddfc7", activeText: "#0f0f0f" },
        dark: { panel: "rgba(255,250,240,.97)", border: "#d9cbb4", item: "#2b2b2b", itemHover: "#f3e8d7", activeBg: "#eddfc7", activeText: "#0f0f0f" },
    },
};

const themeCache = new Map<string, CanvasTheme>();

export function getCanvasTheme(theme: CanvasColorTheme, cardSkin: CardSkinId = "warm"): CanvasTheme {
    const key = `${theme}:${cardSkin}`;
    const cached = themeCache.get(key);
    if (cached) return cached;
    const base = canvasThemes[theme];
    const override = cardSkinNodeOverrides[cardSkin]?.[theme] || {};
    const toolbarOverride = cardSkinToolbarOverrides[cardSkin]?.[theme] || {};
    const result = ({
        ...base,
        ...(Object.keys(override).length ? { node: { ...base.node, ...override } } : {}),
        ...(Object.keys(toolbarOverride).length ? { toolbar: { ...base.toolbar, ...toolbarOverride } } : {}),
    }) as CanvasTheme;
    themeCache.set(key, result);
    return result;
}

export function getCardBackground(theme: CanvasColorTheme, cardSkin: CardSkinId = "warm") {
    if (cardSkin === "fish") {
        return theme === "dark" ? "linear-gradient(145deg, #071521 0%, #0b2438 52%, #103a59 100%)" : "linear-gradient(145deg, #e7f4ff 0%, #d7e9f7 55%, #c7e0f2 100%)";
    }
    if (cardSkin === "angel") {
        return theme === "dark" ? "linear-gradient(145deg, #0e1624 0%, #172238 55%, #2b2418 100%)" : "linear-gradient(145deg, #fffaf0 0%, #f7f0e1 55%, #efe3cc 100%)";
    }
    return canvasThemes[theme].node.fill;
}
