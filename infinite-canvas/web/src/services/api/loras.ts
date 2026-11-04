import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";
import { gatewayFetch } from "@/services/api/gateway-status";

export async function fetchAvailableLoras(): Promise<string[] | null> {
    if (!LOCAL_GATEWAY_ORIGIN) return null;
    try {
        const response = await gatewayFetch(`${LOCAL_GATEWAY_ORIGIN}/api/loras`, { headers: { Accept: "application/json" } });
        if (!response.ok) return null;
        const data = (await response.json()) as { loras?: string[] };
        return Array.isArray(data.loras) ? data.loras : null;
    } catch {
        return null;
    }
}
