import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

export type VideoEditMode = "swap" | "edit";

export type VideoEditPreviewInput = {
    mode: VideoEditMode;
    frame: string;
    mask?: string;
    ref?: string;
    strength: number;
    prompt: string;
};

export type VideoEditPreviewResult = { job_id: string; image_url?: string };

/** Phase1：按 §15 契约接 service，后台未就绪时由调用方用本地帧兜底。 */
export async function requestVideoEditPreview(config: AiConfig, input: VideoEditPreviewInput): Promise<VideoEditPreviewResult> {
    const response = await axios.post<VideoEditPreviewResult>(buildApiUrl(config.baseUrl, "/video-edit/preview"), input, {
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        timeout: 300000,
    });
    return response.data;
}

export async function readVideoEditPreview(config: AiConfig, jobId: string): Promise<VideoEditPreviewResult & { status?: string }> {
    const response = await axios.get(buildApiUrl(config.baseUrl, `/video-edit/preview/${encodeURIComponent(jobId)}`), {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeout: 15000,
    });
    return response.data;
}
