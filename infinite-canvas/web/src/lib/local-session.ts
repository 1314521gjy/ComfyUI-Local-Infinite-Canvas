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
    let hiddenSince = document.visibilityState === "hidden" ? Date.now() : 0;

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

    // 浏览器休眠/丢弃后台标签页也会触发 pagehide；后台停留超过 60s 时不当作关闭，
    // 否则挂机一会儿就会被误停后台。
    const close = (event?: PageTransitionEvent) => {
        if (!active) return;
        if (event?.persisted) return;
        if (hiddenSince && Date.now() - hiddenSince > 60000) return;
        active = false;
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
        void post("/api/session/close", true);
    };

    document.addEventListener("visibilitychange", () => {
        hiddenSince = document.visibilityState === "hidden" ? Date.now() : 0;
    });
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) open();
    });
    open();
}
