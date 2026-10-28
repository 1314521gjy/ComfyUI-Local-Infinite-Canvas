import { RUNTIME_LOCAL_GATEWAY_HOST, RUNTIME_LOCAL_GATEWAY_PORT, RUNTIME_LOCAL_GATEWAY_URL } from "./runtime-config";

// 本地模式：只保留 ComfyUI 网关，隐藏云端 API / WebDAV / Agent 等入口。
// 设置 VITE_LOCAL_ONLY=0 可恢复完整界面。
export const LOCAL_ONLY = import.meta.env.VITE_LOCAL_ONLY !== "0";

function runtimeGatewayBaseUrl() {
    if (RUNTIME_LOCAL_GATEWAY_URL) return RUNTIME_LOCAL_GATEWAY_URL.replace(/\/+$/, "").endsWith("/v1") ? RUNTIME_LOCAL_GATEWAY_URL.replace(/\/+$/, "") : `${RUNTIME_LOCAL_GATEWAY_URL.replace(/\/+$/, "")}/v1`;
    const host = RUNTIME_LOCAL_GATEWAY_HOST || "127.0.0.1";
    const port = RUNTIME_LOCAL_GATEWAY_PORT || "8190";
    return `http://${host}:${port}/v1`;
}

export const LOCAL_GATEWAY_BASE_URL = import.meta.env.VITE_LOCAL_GATEWAY_URL || runtimeGatewayBaseUrl();
export const LOCAL_GATEWAY_ORIGIN = (() => {
    try {
        return new URL(LOCAL_GATEWAY_BASE_URL).origin;
    } catch {
        return "";
    }
})();
export const LOCAL_GATEWAY_CHANNEL_ID = "local-gateway";

export const LOCAL_GATEWAY_MODELS = [
    { name: "image-z-image-turbo", capability: "image" as const, imageInputs: 0 },
    { name: "image-krea2-turbo", capability: "image" as const, imageInputs: 0 },
    { name: "image-qwen21", capability: "image" as const, imageInputs: 4 },
    { name: "image-moss-sft-8step", capability: "image" as const, imageInputs: 0 },
    { name: "image-moss-sft-50step", capability: "image" as const, imageInputs: 0 },
    { name: "video-h3-t2v", capability: "video" as const, imageInputs: 0 },
    { name: "video-h3-frames", capability: "video" as const, imageInputs: 2 },
    { name: "video-h3-fast", capability: "video" as const, imageInputs: 2 },
    { name: "video-h3-ref2va", capability: "video" as const, imageInputs: 6 },
    { name: "video-h3-character-swap", capability: "video" as const, imageInputs: 6 },
    { name: "video-h3-t2v-novdn", capability: "video" as const, imageInputs: 0 },
    { name: "video-h3-frames-novdn", capability: "video" as const, imageInputs: 2 },
    { name: "video-h3-ref2va-novdn", capability: "video" as const, imageInputs: 6 },
];

export const LOCAL_GATEWAY_MODEL_VALUES = LOCAL_GATEWAY_MODELS.map((model) => `${LOCAL_GATEWAY_CHANNEL_ID}::${model.name}`);

export function isLocalGatewayUrl(url: string) {
    try {
        const parsed = new URL(String(url || ""));
        if (LOCAL_GATEWAY_ORIGIN && parsed.origin === LOCAL_GATEWAY_ORIGIN) return true;
        return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    } catch {
        return false;
    }
}
