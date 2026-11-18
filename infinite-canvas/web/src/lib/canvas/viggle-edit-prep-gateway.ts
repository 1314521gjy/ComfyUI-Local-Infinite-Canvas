import { cancelPrepareFrame, createPrepareFrame, readPrepareFrame } from "@/services/api/viggle-prepare";
import type { AiConfig } from "@/stores/use-config-store";
import type { VigglePrepAdapter } from "@/lib/canvas/viggle-edit-prep";

const POLL_INTERVAL_MS = 2500;

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function absoluteUrl(config: AiConfig, url: string) {
    try {
        return new URL(url, config.baseUrl).toString();
    } catch {
        return url;
    }
}

export function createGatewayPrepAdapter(getConfig: () => AiConfig): VigglePrepAdapter {
    return async ({ videoFile, instruction, pin, expected, signal, onStep }) => {
        if (!videoFile) throw new Error("缺少源视频文件");
        const config = getConfig();
        const created = await createPrepareFrame(config, { video: videoFile, prompt: instruction, pin }, signal);
        onStep("extract");
        let state = created;
        try {
            while (state.status !== "ready" && state.status !== "failed" && state.status !== "cancelled") {
                await delay(POLL_INTERVAL_MS, signal);
                state = await readPrepareFrame(config, state.id, signal);
                if (state.step === "edit") onStep("edit");
                if (state.step === "selfproduce") onStep("selfproduce");
                if (state.step === "ready" || state.step === "failed") break;
            }
        } catch (error) {
            if (signal?.aborted) await cancelPrepareFrame(config, state.id).catch(() => undefined);
            throw error;
        }
        if (state.status === "cancelled") throw new DOMException("Aborted", "AbortError");
        if (state.status === "failed" || state.step === "failed") throw new Error(state.error || "制备失败");
        const image = state.image;
        if (!image?.url) throw new Error("制备完成但缺少图片");
        if (expected && image.width > 0 && image.height > 0 && (image.width !== expected.width || image.height !== expected.height)) {
            throw new Error(`制备图尺寸 ${image.width}x${image.height} 与源帧 ${expected.width}x${expected.height} 不一致，请手动抽帧后上传`);
        }
        onStep("inject");
        const frameNumber = Number.isFinite(Number(state.frame)) ? Number(state.frame) : 0;
        return { imageUrl: absoluteUrl(config, image.url), frameNumber, pins: String(state.pin ?? frameNumber), thumbUrl: state.thumb ? absoluteUrl(config, state.thumb) : (state.selection?.candidates?.find((item) => item.frame === state.selection?.selectedFrame)?.thumbUrl ? absoluteUrl(config, state.selection.candidates.find((item) => item.frame === state.selection?.selectedFrame)!.thumbUrl!) : undefined),
            candidates: state.selection?.candidates?.map((item) => ({ frame: item.frame, thumbUrl: item.thumbUrl ? absoluteUrl(config, item.thumbUrl) : undefined })), targetFrameUrl: state.targetFrameUrl ? absoluteUrl(config, state.targetFrameUrl) : undefined };
    };
}
