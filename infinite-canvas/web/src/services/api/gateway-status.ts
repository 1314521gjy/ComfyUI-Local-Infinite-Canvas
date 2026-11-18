import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";

// 网关重启/换端口时，页面里同时在飞的请求会一起失败。这里把它们合并成一个
// “正在重连”状态：只显示一条提示，恢复后自动刷新一次，避免每个请求各弹一个错误。

type Listener = (down: boolean) => void;

const listeners = new Set<Listener>();
const HEALTH_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;
// 重连探测指数退避上限：网关长时间宕机时从 2s 逐次翻倍，封顶 30s，避免高频空探。
const HEALTH_BACKOFF_MAX_MS = 30000;

let down = false;
let pollTimer: number | null = null;
let reloadTimer: number | null = null;
let probeDelayMs = HEALTH_INTERVAL_MS;

function emit() {
    for (const listener of listeners) listener(down);
}

export function isGatewayDown() {
    return down;
}

export function subscribeGatewayStatus(listener: Listener) {
    listeners.add(listener);
    listener(down);
    return () => {
        listeners.delete(listener);
    };
}

async function probeHealth() {
    if (!LOCAL_GATEWAY_ORIGIN) return false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
        const response = await fetch(`${LOCAL_GATEWAY_ORIGIN}/health`, { cache: "no-store", signal: controller.signal });
        return response.ok;
    } catch {
        return false;
    } finally {
        window.clearTimeout(timer);
    }
}

function startPolling() {
    if (pollTimer !== null) return;
    const tick = async () => {
        pollTimer = null;
        if (!down) return;
        // 连续两次健康才判定恢复，过滤单次抖动。
        if (await probeHealth()) {
            if (await probeHealth()) {
                markGatewayUp();
                return;
            }
        }
        // 未恢复则指数退避（2s→4s→8s…封顶 30s），恢复后由 markGatewayUp 重置。
        probeDelayMs = Math.min(HEALTH_BACKOFF_MAX_MS, probeDelayMs * 2);
        pollTimer = window.setTimeout(() => void tick(), probeDelayMs);
    };
    pollTimer = window.setTimeout(() => void tick(), probeDelayMs);
}

export function markGatewayDown() {
    if (down) return;
    down = true;
    emit();
    startPolling();
}

export function markGatewayUp() {
    if (!down) return;
    down = false;
    probeDelayMs = HEALTH_INTERVAL_MS;
    if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
    }
    emit();
    // 恢复后只刷新一次；60s 内已刷过则不再刷，避免“失败→健康→刷新”每 3s 循环。
    if (reloadTimer === null) {
        const last = Number(window.sessionStorage.getItem("qoder-gateway-reload-at") || 0);
        if (Date.now() - last > 60000) {
            window.sessionStorage.setItem("qoder-gateway-reload-at", String(Date.now()));
            reloadTimer = window.setTimeout(() => window.location.reload(), 600);
        }
    }
}

export function isGatewayRequest(url: string) {
    if (!url) return false;
    try {
        const target = new URL(url, LOCAL_GATEWAY_ORIGIN || window.location.origin);
        return Boolean(LOCAL_GATEWAY_ORIGIN) && target.origin === LOCAL_GATEWAY_ORIGIN;
    } catch {
        return false;
    }
}

export function noteGatewayError(error: unknown, url = "") {
    const maybe = error as { code?: string; response?: unknown; config?: { url?: string; baseURL?: string } } | null;
    const isNetworkError = error instanceof TypeError || (maybe?.code === "ERR_NETWORK" && !maybe?.response);
    if (!isNetworkError) return;
    const requestUrl = url || maybe?.config?.url || "";
    const requestBase = maybe?.config?.baseURL || "";
    if (!requestUrl || isGatewayRequest(requestUrl) || isGatewayRequest(requestBase)) markGatewayDown();
}

export async function gatewayFetch(input: RequestInfo | URL, init?: RequestInit) {
    try {
        return await fetch(input, init);
    } catch (error) {
        noteGatewayError(error, String(input));
        throw error;
    }
}
