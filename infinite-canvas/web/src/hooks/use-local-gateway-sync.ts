import { useEffect } from "react";

import { isLocalGatewayUrl, LOCAL_GATEWAY_BASE_URL, LOCAL_GATEWAY_ORIGIN, LOCAL_ONLY } from "@/constant/app-mode";
import { createGatewayModelSync, type GatewaySyncTrigger } from "@/lib/local-gateway-sync";
import { markGatewayUp, noteGatewayError } from "@/services/api/gateway-status";
import { applyLocalGatewayModels, useConfigStore } from "@/stores/use-config-store";

const SYNC_INTERVAL_MS = 8000;
const REQUEST_TIMEOUT_MS = 4000;

function localChannelOf() {
    const config = useConfigStore.getState().config;
    return config.channels.find((item) => isLocalGatewayUrl(item.baseUrl)) || (LOCAL_ONLY ? config.channels[0] : null);
}

/** 本地模式下自动从网关同步模型；SSE、聚焦、可见性、轮询和自定义事件共用同一个同步入口。 */
export function useLocalGatewaySync() {
    useEffect(() => {
        const modelsUrl = `${LOCAL_GATEWAY_BASE_URL.replace(/\/+$/, "")}/models`;
        const sync = createGatewayModelSync({
            timeoutMs: REQUEST_TIMEOUT_MS,
            fetchModels: async (signal) => {
                const response = await fetch(modelsUrl, { cache: "no-store", signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                markGatewayUp();
                return response.json();
            },
            apply: (snapshot, decision) => {
                // 扫描中、degraded/stale、无法确认的空快照都保留当前列表和默认选择。
                if (decision.action === "retain") return;
                const state = useConfigStore.getState();
                const channel = localChannelOf();
                if (!channel) return;
                const result = applyLocalGatewayModels(state.config, {
                    channelId: channel.id,
                    baseUrl: LOCAL_GATEWAY_BASE_URL,
                    models: snapshot.models,
                    clear: decision.action === "clear",
                });
                if (result.changed) useConfigStore.setState({ config: result.config });
            },
            onStatus: (status) => useConfigStore.getState().setLocalGatewaySync(status),
            onError: (error) => {
                // 网关还没起来时静默重试，画布保持可用；断线状态由统一横幅提示。
                noteGatewayError(error, modelsUrl);
            },
        });

        const refresh = (trigger: GatewaySyncTrigger, reason?: string) => {
            if (!localChannelOf()) return;
            void sync.request(trigger, reason);
        };

        // 网关主动广播工作流启用/扫描完成/目录变化；SSE 只带 revision/reason，正文靠重新拉取。
        const events = typeof EventSource === "function" && LOCAL_GATEWAY_ORIGIN ? new EventSource(`${LOCAL_GATEWAY_ORIGIN}/api/models/events`) : null;
        const onModelsEvent = (event: MessageEvent) => {
            let reason = "";
            try {
                const data = JSON.parse(String(event.data || "{}")) as { reason?: unknown };
                reason = typeof data.reason === "string" ? data.reason : "";
            } catch {
                reason = "";
            }
            refresh("sse", reason);
            // 自由卡片 sources 也会随 ComfyUI 工作流目录或 registry 变化；只在这些原因下补拉一次。
            if (["scan", "directories", "registry-import", "registry-scan", "registry-reload", "registry-remove"].includes(reason)) {
                window.dispatchEvent(new CustomEvent("local-gateway-refresh-resources", { detail: { reason } }));
            }
        };
        events?.addEventListener("models", onModelsEvent);

        const onManualRefresh = () => refresh("manual");
        const onFocus = () => refreshWhenVisible("focus");
        const onVisibilityChange = () => refreshWhenVisible("visibility");
        function refreshWhenVisible(trigger: GatewaySyncTrigger) {
            if (document.visibilityState === "visible") refresh(trigger);
        }

        window.addEventListener("local-gateway-refresh-models", onManualRefresh);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibilityChange);
        // 轮询只兜底，不承担实时性；即使拿到空响应也不会清空列表。
        const poll = window.setInterval(() => refresh("poll"), SYNC_INTERVAL_MS);
        refresh("initial");

        return () => {
            sync.stop();
            window.clearInterval(poll);
            events?.close();
            window.removeEventListener("local-gateway-refresh-models", onManualRefresh);
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);
}
