import { LOCAL_GATEWAY_BASE_URL, LOCAL_ONLY } from "@/constant/app-mode";

const HEARTBEAT_MS = 5000;
let started = false;

function sessionUrl(path: string) {
    return `${LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "")}${path}`;
}

// 本地模式：向网关注册画布会话，启动器据此在最后一个页面关闭后回收后台。
export function startLocalSession() {
    if (!LOCAL_ONLY || started || typeof window === "undefined") return;
    started = true;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let timer: number | undefined;
    let active = false;

    const post = (path: string, keepalive = false) =>
        fetch(sessionUrl(path), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
            keepalive,
        }).catch(() => undefined);

    const open = () => {
        if (active) return;
        active = true;
        void post("/api/session/open");
        timer = window.setInterval(() => void post("/api/session/heartbeat"), HEARTBEAT_MS);
    };

    const close = () => {
        if (!active) return;
        active = false;
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
        void post("/api/session/close", true);
    };

    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) open();
    });
    open();
}
