import { getCanvasTheme, type CardSkinId } from "@/lib/canvas-theme";
import { isCardSkinLocked } from "@/lib/canvas/skin-unlocks";
import { useThemeStore } from "@/stores/use-theme-store";

export function useEffectiveCardSkin(): CardSkinId {
    const cardSkin = useThemeStore((state) => state.cardSkin);
    const unlockedCardSkins = useThemeStore((state) => state.unlockedCardSkins);
    return isCardSkinLocked(cardSkin) && !unlockedCardSkins.includes(cardSkin) ? "warm" : cardSkin;
}

export function useCanvasTheme() {
    const theme = useThemeStore((state) => state.theme);
    const cardSkin = useEffectiveCardSkin();
    return getCanvasTheme(theme, cardSkin);
}
