import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export type PrepareFrameStep = "selfproduce" | "extract" | "edit" | "ready" | "failed";

export type PrepareFrameState = {
    id: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    step?: PrepareFrameStep;
    progress?: number;
    frame?: number;
    pin?: string;
    image?: { url: string; name: string; width: number; height: number };
    thumb?: string;
    targetFrameUrl?: string;
    selection?: { mode: "heuristic" | "override"; engine?: string; selectedFrame?: number; candidates?: Array<{ frame: number; score?: number; black?: boolean; thumbUrl?: string }> } | null;
    error?: string;
};

type CreateInput = {
    video: File;
    prompt: string;
    pin?: string;
    sourceDurationSeconds?: number;
};

export async function createPrepareFrame(config: AiConfig, input: CreateInput, signal?: AbortSignal): Promise<PrepareFrameState> {
    const body = new FormData();
    body.append("video", input.video, input.video.name);
    body.append("prompt", input.prompt);
    if (input.pin) body.append("pin", input.pin);
    if (input.sourceDurationSeconds) body.append("source_duration_seconds", String(input.sourceDurationSeconds));
    const response = await axios.post<PrepareFrameState>(aiApiUrl(config, "/viggle/prepare-frame"), body, {
        headers: aiHeaders(config),
        signal,
    });
    return response.data;
}

export async function readPrepareFrame(config: AiConfig, id: string, signal?: AbortSignal): Promise<PrepareFrameState> {
    const response = await axios.get<PrepareFrameState>(aiApiUrl(config, `/viggle/prepare-frame/${encodeURIComponent(id)}`), {
        headers: aiHeaders(config),
        signal,
    });
    return response.data;
}

export async function cancelPrepareFrame(config: AiConfig, id: string): Promise<void> {
    await axios.post(aiApiUrl(config, `/viggle/prepare-frame/${encodeURIComponent(id)}/cancel`), {}, { headers: aiHeaders(config), timeout: 5000 });
}
