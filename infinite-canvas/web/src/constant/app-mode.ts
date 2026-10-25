// 本地模式：只保留 ComfyUI 网关，隐藏云端 API / WebDAV / Agent 等入口。
// 设置 VITE_LOCAL_ONLY=0 可恢复完整界面。
export const LOCAL_ONLY = import.meta.env.VITE_LOCAL_ONLY !== "0";

export const LOCAL_GATEWAY_BASE_URL = import.meta.env.VITE_LOCAL_GATEWAY_URL || "http://127.0.0.1:8190/v1";
export const LOCAL_GATEWAY_CHANNEL_ID = "local-gateway";

export const LOCAL_GATEWAY_MODELS = [
    { name: "image-z-image-turbo", capability: "image" as const },
    { name: "image-krea2-aesthetics", capability: "image" as const },
    { name: "image-qwen21", capability: "image" as const },
    { name: "image-moss-sft-8step", capability: "image" as const },
    { name: "image-moss-sft-50step", capability: "image" as const },
    { name: "video-h3-t2v", capability: "video" as const },
    { name: "video-h3-frames", capability: "video" as const },
    { name: "video-h3-ref2va", capability: "video" as const },
];

export const LOCAL_GATEWAY_MODEL_VALUES = LOCAL_GATEWAY_MODELS.map((model) => `${LOCAL_GATEWAY_CHANNEL_ID}::${model.name}`);

export function isLocalGatewayUrl(url: string) {
    return /(?:127\.0\.0\.1|localhost):8190/i.test(String(url || ""));
}
