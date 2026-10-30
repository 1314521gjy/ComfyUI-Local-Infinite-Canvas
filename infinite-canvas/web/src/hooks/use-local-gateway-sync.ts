import { useEffect } from "react";

import { isLocalGatewayUrl, LOCAL_GATEWAY_BASE_URL, LOCAL_GATEWAY_ORIGIN, LOCAL_ONLY } from "@/constant/app-mode";
import { markGatewayUp, noteGatewayError } from "@/services/api/gateway-status";
import { encodeChannelModel, guessCapability, modelOptionsFromChannels, useConfigStore, type ModelCapability } from "@/stores/use-config-store";

const SYNC_INTERVAL_MS = 8000;
const REQUEST_TIMEOUT_MS = 4000;

function syncableCapability(name: string): ModelCapability | null {
    const capability = guessCapability(name);
    return capability === "image" || capability === "video" ? capability : null;
}

function localChannelOf() {
    const config = useConfigStore.getState().config;
    return config.channels.find((item) => isLocalGatewayUrl(item.baseUrl)) || (LOCAL_ONLY ? config.channels[0] : null);
}

/** 本地模式下自动从网关同步模型；网关新增/删除工作流后无需手动刷新渠道。 */
export function useLocalGatewaySync() {
    useEffect(() => {
        let stopped = false;
        let syncing = false;
        let timer: number | undefined;

        const schedule = (delay = SYNC_INTERVAL_MS) => {
            if (stopped) return;
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => void sync(), delay);
        };

        const sync = async () => {
            if (stopped || syncing) return;
            if (timer) {
                window.clearTimeout(timer);
                timer = undefined;
            }
            // 完整界面里也可能同时存在本地渠道；只同步本地渠道，绝不覆盖云端渠道。
            if (!localChannelOf()) {
                schedule();
                return;
            }
            syncing = true;
            try {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                const response = await fetch(`${LOCAL_GATEWAY_BASE_URL.replace(/\/+$/, "")}/models`, {
                    cache: "no-store",
                    signal: controller.signal,
                });
                window.clearTimeout(timeout);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                markGatewayUp();
                const payload = (await response.json()) as {
                    data?: Array<{
                        id?: string;
                        metadata?: { type?: string; workflowId?: string; label?: string; baseModel?: string; baseModelLabel?: string; imageInputs?: number; variantModes?: string[]; variantLabels?: Record<string, string> };
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
                            imageInputs: typeof meta.imageInputs === "number" ? meta.imageInputs : undefined,
                            variantModes: Array.isArray(meta.variantModes) ? meta.variantModes.map(String) : undefined,
                            variantLabels: meta.variantLabels && typeof meta.variantLabels === "object" ? meta.variantLabels : undefined,
                        };
                    })
                    .filter((model) => Boolean(model.name) && Boolean(model.capability));
                const state = useConfigStore.getState();
                const config = state.config;
                const channel = localChannelOf();
                if (!channel) return;
                if (synced.length) {
                    const nextModels = synced.map((model) => {
                        const previous = channel.models.find((item) => item.name === model.name);
                        return { ...model, capability: previous?.capability || (model.capability as ModelCapability) };
                    });
                    const signature = (
                        models: Array<{ name: string; capability: string; label?: string; workflowId?: string; baseModel?: string; baseModelLabel?: string; imageInputs?: number; variantModes?: string[]; variantLabels?: Record<string, string> }>,
                    ) => JSON.stringify(models.map((model) => [model.name, model.capability, model.label || "", model.workflowId || "", model.baseModel || "", model.baseModelLabel || "", model.imageInputs ?? -1, model.variantModes || [], model.variantLabels || {}]));
                    if (signature(channel.models) !== signature(nextModels)) {
                        // 网关换端口后，浏览器里保存的旧 baseUrl 必须自动跟到运行时地址，否则会一直 Failed to fetch。
                        const channels = config.channels.map((item) =>
                            item.id === channel.id ? { ...item, apiKey: item.apiKey || "local", baseUrl: LOCAL_GATEWAY_BASE_URL, models: nextModels } : item,
                        );
                        const imageOptions = channels.flatMap((item) =>
                            item.models.filter((model) => model.capability === "image").map((model) => encodeChannelModel(item.id, model.name)),
                        );
                        const videoOptions = channels.flatMap((item) =>
                            item.models.filter((model) => model.capability === "video").map((model) => encodeChannelModel(item.id, model.name)),
                        );
                        const pick = (current: string, options: string[]) => (options.includes(current) ? current : options[0] || "");
                        const pickImage = (current: string) => {
                            if (imageOptions.includes(current)) return current;
                            if (String(current).endsWith("::image-krea2-aesthetics")) {
                                const turbo = imageOptions.find((option) => option.endsWith("::image-krea2-turbo"));
                                if (turbo) return turbo;
                            }
                            return pick(current, imageOptions);
                        };
                        useConfigStore.setState({
                            config: {
                                ...config,
                                channels,
                                models: modelOptionsFromChannels(channels),
                                imageModel: pickImage(config.imageModel),
                                videoModel: pick(config.videoModel, videoOptions),
                                model: pickImage(config.model),
                                baseUrl: LOCAL_GATEWAY_BASE_URL,
                                apiKey: channel.apiKey || "local",
                            },
                        });
                    }
                } else if (channel.models.length) {
                    const channels = config.channels.map((item) =>
                        item.id === channel.id ? { ...item, apiKey: item.apiKey || "local", baseUrl: LOCAL_GATEWAY_BASE_URL, models: [] } : item,
                    );
                    useConfigStore.setState({
                        config: {
                            ...config,
                            channels,
                            models: modelOptionsFromChannels(channels),
                            imageModel: "",
                            videoModel: "",
                            model: "",
                            baseUrl: LOCAL_GATEWAY_BASE_URL,
                            apiKey: channel.apiKey || "local",
                        },
                    });
                }
            } catch (error) {
                // 网关还没起来时静默重试，画布保持可用；断线状态由统一横幅提示。
                noteGatewayError(error, `${LOCAL_GATEWAY_BASE_URL.replace(/\/+$/, "")}/models`);
            } finally {
                syncing = false;
                schedule();
            }
        };

        const refresh = () => void sync();
        const refreshWhenVisible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        // 网关主动广播工作流启用/扫描完成；断线时 EventSource 自动重连，轮询继续兜底。
        const events = typeof EventSource === "function" && LOCAL_GATEWAY_ORIGIN ? new EventSource(`${LOCAL_GATEWAY_ORIGIN}/api/models/events`) : null;
        events?.addEventListener("models", refresh);
        window.addEventListener("local-gateway-refresh-models", refresh);
        window.addEventListener("focus", refreshWhenVisible);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        void sync();
        return () => {
            stopped = true;
            if (timer) window.clearTimeout(timer);
            events?.close();
            window.removeEventListener("local-gateway-refresh-models", refresh);
            window.removeEventListener("focus", refreshWhenVisible);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
        };
    }, []);
}
