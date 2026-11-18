import axios from "axios";

import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal; referenceAudio?: { url: string; storageKey?: string; name?: string } };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    if (config.channelMode === "local") return requestLocalAudio(config, requestConfig, prompt, format, options);
    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error(apiText("audioModelRequired"));
        if (!requestConfig.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
        if (!requestConfig.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() },
                signal: options?.signal,
            });
            return await audioPluginBlob(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
        }
    }
    assertAudioConfig(requestConfig, model);
    const instructions = config.audioInstructions.trim();

    try {
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
}

export async function requestDialogueSpeech(
    config: AiConfig,
    text: string,
    instructions: string,
    reference: { blob: Blob; name: string } | null,
    seed: string,
    options?: { signal?: AbortSignal },
): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const seedValue = /^\d+$/.test(seed) ? Number(seed) : undefined;
    try {
        if (!reference) {
            const response = await axios.post<Blob>(
                aiApiUrl(requestConfig, "/audio/speech-h3"),
                {
                    input: text,
                    voice_description: "",
                    instructions,
                    language: "zh",
                    ...(seedValue !== undefined ? { seed: seedValue } : {}),
                },
                { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
            );
            await assertAudioBlob(response.data);
            return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: "audio/wav" });
        }
        const form = new FormData();
        form.append("input", text);
        form.append("instructions", instructions);
        if (seedValue !== undefined) form.append("seed", String(seedValue));
        form.append("reference_audio", reference.blob, reference.name || "reference.wav");
        const response = await axios.post<Blob>(aiApiUrl(requestConfig, "/audio/speech"), form, {
            headers: { "Content-Type": "multipart/form-data" },
            responseType: "blob",
            signal: options?.signal,
        });
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: "audio/wav" });
    } catch (error) {
        throw new Error(await localAudioErrorMessage(error, "台词生成失败"));
    }
}

async function requestLocalAudio(config: AiConfig, requestConfig: ReturnType<typeof resolveModelRequestConfig>, prompt: string, format: string, options?: RequestOptions): Promise<Blob> {
    const songMode = config.audioMode === "song";
    const seed = String(config.seed || "").trim();
    if (!songMode && config.audioReferenceMode === "none") {
        try {
            const response = await axios.post<Blob>(
                aiApiUrl(requestConfig, "/audio/speech-h3"),
                {
                    input: prompt,
                    voice_description: config.audioVoiceDescription || "",
                    instructions: config.audioInstructions.trim(),
                    language: config.audioLanguage || "zh",
                    ...(/^\d+$/.test(seed) ? { seed: Number(seed) } : {}),
                },
                { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
            );
            await assertAudioBlob(response.data);
            return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
        } catch (error) {
            throw new Error(await localAudioErrorMessage(error, apiText("audioGenerationFailed")));
        }
    }
    const referenceKey = songMode ? config.audioSongReferenceKey : config.audioReferenceKey;
    const wiredReference = options?.referenceAudio;
    if (!referenceKey && !wiredReference) throw new Error(apiText("audioReferenceRequired"));
    const form = new FormData();
    form.append("input", prompt);
    form.append("response_format", format);
    form.append("speed", String(normalizeAudioSpeedValue(config.audioSpeed)));
    if (!songMode) form.append("instructions", config.audioInstructions.trim());
    if (songMode) {
        const bpm = Number(String(config.audioBpm ?? "").trim());
        const duration = Number(String(config.audioDuration ?? "").trim());
        if (Number.isFinite(bpm) && bpm > 0) form.append("bpm", String(Math.trunc(bpm)));
        if (Number.isFinite(duration) && duration > 0) form.append("duration", String(duration));
        if (config.audioLanguage?.trim()) form.append("language", config.audioLanguage.trim());
        if (config.audioKeyscale?.trim()) form.append("keyscale", config.audioKeyscale.trim());
    }
    if (/^\d+$/.test(seed)) form.append("seed", seed);
    if (referenceKey || wiredReference) {
        try {
            const url = referenceKey ? await resolveMediaUrl(referenceKey) : wiredReference?.storageKey ? await resolveMediaUrl(wiredReference.storageKey) : wiredReference?.url || "";
            if (!url) throw new Error("missing reference url");
            const refBlob = await (await fetch(url, { signal: options?.signal })).blob();
            const referenceName = referenceKey
                ? (songMode ? config.audioSongReferenceName : config.audioReferenceName)?.trim() || "reference.mp3"
                : wiredReference?.name || "reference.mp3";
            form.append("reference_audio", refBlob, referenceName);
        } catch {
            throw new Error(apiText("audioReferenceUnavailable"));
        }
    }
    try {
        const response = await axios.post<Blob>(aiApiUrl(requestConfig, songMode ? "/audio/song" : "/audio/speech"), form, {
            headers: { "Content-Type": "multipart/form-data" },
            responseType: "blob",
            signal: options?.signal,
        });
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(await localAudioErrorMessage(error, apiText("audioGenerationFailed")));
    }
}

async function localAudioErrorMessage(error: unknown, fallback: string) {
    if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
        try {
            const payload = JSON.parse(await error.response.data.text()) as { error?: { message?: string }; message?: string; msg?: string };
            const message = payload.error?.message || payload.message || payload.msg;
            if (message) return message;
        } catch {
            // 非 JSON 错误体走通用错误处理。
        }
    }
    return readAxiosError(error, fallback);
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error(apiText("scriptNoAudio"));
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(withLocalProxy(url))).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("audioModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiAudioUnsupported"));
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("audioGenerationFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/^\s*<(!doctype\s+html|html[\s>])/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}
