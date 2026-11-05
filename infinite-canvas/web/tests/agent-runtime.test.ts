import { expect, test } from "bun:test";

import { agentCloudLabel, formatAgentApiError, selectAgentBackend } from "../src/lib/agent/agent-runtime";
import type { PromptCloudApi } from "../src/stores/use-config-store";

const cloudApi: PromptCloudApi = {
    id: "api-1",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-local-test",
    model: "deepseek-chat",
};

test("prefers pi Agent when both the bridge and a cloud API are ready", () => {
    const backend = selectAgentBackend("http://127.0.0.1:18800", cloudApi);
    expect(backend).toEqual({ source: "pi", url: "http://127.0.0.1:18800" });
});

test("falls back to the cloud API when pi Agent is unavailable", () => {
    const backend = selectAgentBackend("", cloudApi);
    expect(backend.source).toBe("cloud");
    if (backend.source === "cloud") expect(backend.api).toBe(cloudApi);
});

test("returns a readable missing state when neither backend is ready", () => {
    expect(selectAgentBackend("", null)).toEqual({ source: "none", reason: "missing-both" });
    expect(selectAgentBackend("http://127.0.0.1:18800", { ...cloudApi, apiKey: "" })).toEqual({ source: "none", reason: "missing-api" });
});

test("labels cloud backends by name and model", () => {
    expect(agentCloudLabel(cloudApi)).toBe("DeepSeek · deepseek-chat");
    expect(agentCloudLabel({ ...cloudApi, name: "" })).toBe("deepseek-chat");
    expect(agentCloudLabel({ ...cloudApi, name: "DeepSeek", model: "DeepSeek" })).toBe("DeepSeek");
});

test("formats provider JSON errors without exposing the request body", () => {
    const text = formatAgentApiError(401, JSON.stringify({ error: { message: "Invalid API key" }, apiKey: "sk-local-test" }));
    expect(text).toContain("Invalid API key");
    expect(text).not.toContain("sk-local-test");
    expect(text).toContain("401");
});

test("formats plain text, HTML and empty error bodies", () => {
    expect(formatAgentApiError(429, "rate limited")).toContain("rate limited");
    expect(formatAgentApiError(502, "<html><body>Bad gateway</body></html>")).toBe("API 请求失败：Bad gateway（HTTP 502）");
    expect(formatAgentApiError(500, "   ")).toBe("API 请求失败：HTTP 500");
});

test("truncates very long error bodies", () => {
    const text = formatAgentApiError(400, "x".repeat(1000));
    expect(text.length).toBeLessThanOrEqual(330);
    expect(text).toContain("…");
});
