import { useEffect } from "react";

import { isLocalGatewayUrl, LOCAL_GATEWAY_BASE_URL, LOCAL_ONLY } from "@/constant/app-mode";
import { encodeChannelModel, guessCapability, modelOptionsFromChannels, useConfigStore, type ModelCapability } from "@/stores/use-config-store";

const SYNC_INTERVAL_MS = 8000;
const REQUEST_TIMEOUT_MS = 4000;

function syncableCapability(name: string): ModelCapability | null {
    const capability = guessCapability(name);
    return capability === "image" || capability === "video" ? capability : null;
}

/** 本地模式下自动从网关同步模型；网关新增/删除工作流后无需手动刷新渠道。 */
export function useLocalGatewaySync() {
    useEffect(() => {
        if (!LOCAL_ONLY) return;
        let stopped = false;
        let timer: number | undefined;

        const sync = async () => {
            if (timer) {
                window.clearTimeout(timer);
                timer = undefined;
            }
            try {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                const response = await fetch(`${LOCAL_GATEWAY_BASE_URL.replace(/\/+$/, "")}/models`, {
                    cache: "no-store",
                    signal: controller.signal,
                });
                window.clearTimeout(timeout);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const payload = (await response.json()) as {
                    data?: Array<{
                        id?: string;
                        metadata?: { type?: string; workflowId?: string; label?: string; baseModel?: string; baseModelLabel?: string; variantModes?: string[]; variantLabels?: Record<string, string> };
                    }>;
                };
                const synced = (payload.data || [])
                    .map((item) => {
                        const name = String(item.id || "").trim();
                        const meta = item.metadata || {};
                        const capability = meta.type === "image" || meta.type === "video" ? meta.type : syncableCapability(name);
                        return {
                            name,
                            capability,
                            label: meta.label?.trim() || undefined,
                            workflowId: meta.workflowId?.trim() || undefined,
                            baseModel: meta.baseModel?.trim() || undefined,
                            baseModelLabel: meta.baseModelLabel?.trim() || undefined,
                            variantModes: Array.isArray(meta.variantModes) ? meta.variantModes.map(String) : undefined,
                            variantLabels: meta.variantLabels && typeof meta.variantLabels === "object" ? meta.variantLabels : undefined,
                        };
                    })
                    .filter((model) => Boolean(model.name) && Boolean(model.capability));
                if (synced.length) {
                    const state = useConfigStore.getState();
                    const config = state.config;
                    const channel = config.channels.find((item) => isLocalGatewayUrl(item.baseUrl)) || config.channels[0];
                    if (channel) {
                        const nextModels = synced.map((model) => {
                            const previous = channel.models.find((item) => item.name === model.name);
                            return { ...model, capability: previous?.capability || (model.capability as ModelCapability) };
                        });
                        const signature = (
                            models: Array<{ name: string; capability: string; label?: string; workflowId?: string; baseModel?: string; baseModelLabel?: string; variantModes?: string[]; variantLabels?: Record<string, string> }>,
                        ) => JSON.stringify(models.map((model) => [model.name, model.capability, model.label || "", model.workflowId || "", model.baseModel || "", model.baseModelLabel || "", model.variantModes || [], model.variantLabels || {}]));
                        if (signature(channel.models) !== signature(nextModels)) {
                            const channels = config.channels.map((item) =>
                                item.id === channel.id ? { ...item, apiKey: item.apiKey || "local", models: nextModels } : item,
                            );
                            const imageOptions = channels.flatMap((item) =>
                                item.models.filter((model) => model.capability === "image").map((model) => encodeChannelModel(item.id, model.name)),
                            );
                            const videoOptions = channels.flatMap((item) =>
                                item.models.filter((model) => model.capability === "video").map((model) => encodeChannelModel(item.id, model.name)),
                            );
                            const pick = (current: string, options: string[]) => (options.includes(current) ? current : options[0] || "");
                            useConfigStore.setState({
                                config: {
                                    ...config,
                                    channels,
                                    models: modelOptionsFromChannels(channels),
                                    imageModel: pick(config.imageModel, imageOptions),
                                    videoModel: pick(config.videoModel, videoOptions),
                                    model: pick(config.model, imageOptions),
                                    baseUrl: channel.baseUrl,
                                    apiKey: channel.apiKey || "local",
                                },
                            });
                        }
                    }
                } else {
                    const state = useConfigStore.getState();
                    const config = state.config;
                    const channel = config.channels.find((item) => isLocalGatewayUrl(item.baseUrl)) || config.channels[0];
                    if (channel && channel.models.length) {
                        const channels = config.channels.map((item) => (item.id === channel.id ? { ...item, apiKey: item.apiKey || "local", models: [] } : item));
                        useConfigStore.setState({
                            config: {
                                ...config,
                                channels,
                                models: modelOptionsFromChannels(channels),
                                imageModel: "",
                                videoModel: "",
                                model: "",
                                baseUrl: channel.baseUrl,
                                apiKey: channel.apiKey || "local",
                            },
                        });
                    }
                }
            } catch {
                // 网关还没起来时静默重试，画布保持可用。
            }
            if (!stopped) timer = window.setTimeout(sync, SYNC_INTERVAL_MS);
        };

        void sync();
        const refresh = () => void sync();
        window.addEventListener("local-gateway-refresh-models", refresh);
        return () => {
            stopped = true;
            window.removeEventListener("local-gateway-refresh-models", refresh);
            if (timer) window.clearTimeout(timer);
        };
    }, []);
}
