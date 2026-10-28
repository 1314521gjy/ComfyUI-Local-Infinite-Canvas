import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";

// 网关重启/换端口时，页面里同时在飞的请求会一起失败。这里把它们合并成一个
// “正在重连”状态：只显示一条提示，恢复后自动刷新一次，避免每个请求各弹一个错误。

type Listener = (down: boolean) => void;

const listeners = new Set<Listener>();
const HEALTH_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;

let down = false;
let pollTimer: number | null = null;
let reloadTimer: number | null = null;

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
        if (await probeHealth()) {
            markGatewayUp();
            return;
        }
        pollTimer = window.setTimeout(() => void tick(), HEALTH_INTERVAL_MS);
    };
    pollTimer = window.setTimeout(() => void tick(), HEALTH_INTERVAL_MS);
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
    if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
    }
    emit();
    // 断线期间的模型列表、资源状态、进行中的请求都已过期，恢复后统一刷新一次。
    if (reloadTimer === null) {
        reloadTimer = window.setTimeout(() => window.location.reload(), 600);
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
