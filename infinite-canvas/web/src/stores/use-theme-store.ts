import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CardSkinId } from "@/lib/canvas-theme";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    cardSkin: CardSkinId;
    setTheme: (theme: ThemeName) => void;
    setCardSkin: (cardSkin: CardSkinId) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            cardSkin: "warm",
            setTheme: (theme) => set({ theme }),
            setCardSkin: (cardSkin) => set({ cardSkin }),
        }),
        { name: "infinite-canvas:theme_store" },
    ),
);
