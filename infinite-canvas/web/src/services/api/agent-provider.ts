import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { gatewayFetch } from "@/services/api/gateway-status";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

export type AgentProviderInput = {
    baseUrl: string;
    apiKey: string;
    model: string;
    label?: string;
};

async function readError(response: Response, fallback: string) {
    const data = await response.json().catch(() => ({}));
    return String(data?.error || fallback);
}

export async function syncAgentProvider(input: AgentProviderInput) {
    const response = await gatewayFetch(`${gatewayRoot}/api/agent/provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(await readError(response, `同步 Agent API 失败（HTTP ${response.status}）`));
}

export async function clearAgentProvider() {
    const response = await gatewayFetch(`${gatewayRoot}/api/agent/provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ clear: true }),
    });
    if (!response.ok) throw new Error(await readError(response, `清除 Agent API 失败（HTTP ${response.status}）`));
}
