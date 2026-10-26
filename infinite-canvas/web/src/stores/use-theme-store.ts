import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CardSkinId } from "@/lib/canvas-theme";
import { isCardSkinLocked } from "@/lib/canvas/skin-unlocks";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    cardSkin: CardSkinId;
    unlockedCardSkins: CardSkinId[];
    setTheme: (theme: ThemeName) => void;
    setCardSkin: (cardSkin: CardSkinId) => void;
    unlockCardSkin: (skinId: CardSkinId) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            cardSkin: "warm",
            unlockedCardSkins: [],
            setTheme: (theme) => set({ theme }),
            setCardSkin: (cardSkin) =>
                set((state) => {
                    if (isCardSkinLocked(cardSkin) && !state.unlockedCardSkins.includes(cardSkin)) return state;
                    return { cardSkin };
                }),
            unlockCardSkin: (skinId) =>
                set((state) => ({
                    unlockedCardSkins: state.unlockedCardSkins.includes(skinId) ? state.unlockedCardSkins : [...state.unlockedCardSkins, skinId],
                    cardSkin: skinId,
                })),
        }),
        { name: "infinite-canvas:theme_store" },
    ),
);
