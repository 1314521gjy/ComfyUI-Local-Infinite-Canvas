import { useCallback, useEffect, useState } from "react";

import { fetchResourceStatus, type PromptCapabilities } from "@/services/api/resources";

const CACHE_MS = 60000;

let cache: { at: number; value: PromptCapabilities } | null = null;
let inflight: Promise<PromptCapabilities | null> | null = null;

async function loadCapabilities(force = false): Promise<PromptCapabilities | null> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    if (inflight) return inflight;
    inflight = fetchResourceStatus()
        .then((status) => {
            const value = status.promptCapabilities || null;
            if (value) cache = { at: Date.now(), value };
            return value;
        })
        .catch(() => cache?.value || null)
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

/** 本地反推/提示词引擎是否可用；安装资源后由 local-gateway-refresh-models 触发刷新。 */
export function usePromptCapabilities() {
    const [capabilities, setCapabilities] = useState<PromptCapabilities | null>(() => cache?.value || null);

    const refresh = useCallback(async (force = false) => {
        const next = await loadCapabilities(force);
        if (next) setCapabilities(next);
    }, []);

    useEffect(() => {
        void refresh();
        const handler = () => void refresh(true);
        window.addEventListener("local-gateway-refresh-models", handler);
        return () => window.removeEventListener("local-gateway-refresh-models", handler);
    }, [refresh]);

    return {
        capabilities,
        refresh: () => void refresh(true),
        engineAvailable: (id: string) => (capabilities ? capabilities.engines?.[id]?.available === true : true),
        engineReasons: (id: string) => capabilities?.engines?.[id]?.reasons || [],
    };
}
