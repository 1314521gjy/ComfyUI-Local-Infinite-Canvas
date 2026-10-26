import { getCanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function useCanvasTheme() {
    const theme = useThemeStore((state) => state.theme);
    const cardSkin = useThemeStore((state) => state.cardSkin);
    return getCanvasTheme(theme, cardSkin);
}
