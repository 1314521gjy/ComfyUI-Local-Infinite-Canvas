import { useEffect } from "react";

import { fetchSkinUnlocks, persistSkinUnlock } from "@/services/api/skin-unlocks";
import { useThemeStore } from "@/stores/use-theme-store";

export function useSkinUnlockPersistence() {
    const mergeUnlockedCardSkins = useThemeStore((state) => state.mergeUnlockedCardSkins);

    useEffect(() => {
        let cancelled = false;
        let retryTimer: number | undefined;

        const sync = async (attempt = 0) => {
            try {
                const remote = await fetchSkinUnlocks();
                if (cancelled) return;
                mergeUnlockedCardSkins(remote);
                const local = useThemeStore.getState().unlockedCardSkins;
                const missing = local.filter((skinId) => !remote.includes(skinId));
                await Promise.all(missing.map((skinId) => persistSkinUnlock(skinId).catch(() => undefined)));
            } catch {
                if (!cancelled && attempt < 2) {
                    retryTimer = window.setTimeout(() => void sync(attempt + 1), 3000);
                }
            }
        };

        void sync();
        return () => {
            cancelled = true;
            if (retryTimer) window.clearTimeout(retryTimer);
        };
    }, [mergeUnlockedCardSkins]);
}
