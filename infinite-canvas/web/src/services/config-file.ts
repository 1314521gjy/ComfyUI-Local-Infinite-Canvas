import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { normalizePromptCloudConfig, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    secretsStripped?: boolean;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

const SECRET_KEY = /^(apiKey|password|token|secret|accessKey|secretKey|authorization)$/i;

function redactSecrets<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SECRET_KEY.test(key) ? "" : redactSecrets(item);
    }
    return result as T;
}

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = redactSecrets({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), secretsStripped: true, config, webdav, promptSources: { sources, schedule } });
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) throw new Error(i18n.t("config.invalidFile"));
    const current = useConfigStore.getState();
    const nextConfig = normalizePromptCloudConfig(data.config);
    if (data.secretsStripped) {
        nextConfig.channels = nextConfig.channels.map((channel) => {
            if (channel.apiKey) return channel;
            const existing = current.config.channels.find((item) => item.id === channel.id) || current.config.channels.find((item) => item.baseUrl === channel.baseUrl);
            return existing?.apiKey ? { ...channel, apiKey: existing.apiKey } : channel;
        });
    }
    const nextWebdav = data.secretsStripped && !data.webdav.password ? { ...data.webdav, password: current.webdav.password } : data.webdav;
    useConfigStore.setState({ config: nextConfig, webdav: nextWebdav });
    usePromptSourceStore.setState(data.promptSources);
}
