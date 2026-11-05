import type { PromptCloudApi } from "@/stores/use-config-store";

export type AgentBackend =
    | { source: "pi"; url: string }
    | { source: "cloud"; api: PromptCloudApi }
    | { source: "none"; reason: "missing-pi" | "missing-api" | "missing-both" };

export function selectAgentBackend(piUrl: string, api: PromptCloudApi | null | undefined): AgentBackend {
    const baseUrl = api?.baseUrl?.trim() || "";
    const apiKey = api?.apiKey?.trim() || "";
    const model = api?.model?.trim() || "";
    const cloudReady = Boolean(api && baseUrl && apiKey && model);
    if (piUrl && cloudReady) return { source: "pi", url: piUrl };
    if (cloudReady) return { source: "cloud", api: api! };
    return { source: "none", reason: piUrl ? "missing-api" : "missing-both" };
}

export function agentCloudLabel(api: PromptCloudApi) {
    const name = api.name.trim();
    const model = api.model.trim();
    if (name && model && name !== model) return `${name} · ${model}`;
    return model || name || "Cloud API";
}

export function formatAgentApiError(status: number, body: string) {
    let message = String(body || "").trim();
    try {
        const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
        const value = parsed?.error?.message ?? parsed?.message;
        if (typeof value === "string" && value.trim()) message = value.trim();
    } catch {}
    message = message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!message) message = `HTTP ${status}`;
    if (message.length > 300) message = `${message.slice(0, 300)}…`;
    const suffix = message === `HTTP ${status}` ? "" : `（HTTP ${status}）`;
    return `API 请求失败：${message}${suffix}`;
}
