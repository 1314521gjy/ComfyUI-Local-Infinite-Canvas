import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CardSkinId } from "@/lib/canvas-theme";
import { isCardSkinLocked } from "@/lib/canvas/skin-unlocks";

export type ThemeName = "light" | "dark";
export type FishWhipSide = "left" | "right";

type ThemeStore = {
    theme: ThemeName;
    cardSkin: CardSkinId;
    unlockedCardSkins: CardSkinId[];
    fishWhipEnabled: boolean;
    fishWhipSide: FishWhipSide;
    setTheme: (theme: ThemeName) => void;
    setCardSkin: (cardSkin: CardSkinId) => void;
    unlockCardSkin: (skinId: CardSkinId) => void;
    mergeUnlockedCardSkins: (skinIds: CardSkinId[]) => void;
    setFishWhipEnabled: (enabled: boolean) => void;
    setFishWhipSide: (side: FishWhipSide) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            cardSkin: "warm",
            unlockedCardSkins: [],
            fishWhipEnabled: true,
            fishWhipSide: "right",
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
            mergeUnlockedCardSkins: (skinIds) =>
                set((state) => {
                    const next = [...new Set([...state.unlockedCardSkins, ...skinIds])];
                    return next.length === state.unlockedCardSkins.length ? state : { unlockedCardSkins: next };
                }),
            setFishWhipEnabled: (enabled) => set({ fishWhipEnabled: enabled }),
            setFishWhipSide: (side) => set({ fishWhipSide: side }),
        }),
        { name: "infinite-canvas:theme_store" },
    ),
);
