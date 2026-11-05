import { ensureAssistantRuntime, fetchAssistantRuntimeStatus, type AssistantRuntimeStatus } from "@/services/api/resources";

export async function resolvePiAgentUrl(): Promise<string> {
    let status: AssistantRuntimeStatus = await fetchAssistantRuntimeStatus();
    if (status.running && status.online && status.url) return status.url;
    if (!status.available) throw new Error(status.reason || "pi Agent 运行时未安装，请先在资源中心安装。");
    const started = await ensureAssistantRuntime(false);
    if (started.url) return started.url;
    status = await fetchAssistantRuntimeStatus();
    if (status.running && status.online && status.url) return status.url;
    throw new Error(status.reason || status.lastError || "pi Agent 没有返回可用的本地地址。");
}

export type PiAgentEvent = { event: string; data: Record<string, unknown> };

export async function streamPiAgentChat(
    url: string,
    payload: Record<string, unknown>,
    options: { signal: AbortSignal; onEvent: (item: PiAgentEvent) => void },
) {
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal: options.signal,
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(String(data?.error || `pi Agent 请求失败（HTTP ${response.status}）`));
    }
    if (!response.body) throw new Error("pi Agent 没有返回流式响应。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            parseBlock(block, options.onEvent);
            index = buffer.indexOf("\n\n");
        }
    }
    if (buffer.trim()) parseBlock(buffer, options.onEvent);
}

function parseBlock(block: string, onEvent: (item: PiAgentEvent) => void) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try {
        onEvent({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
    } catch {
        // Ignore malformed heartbeat/event chunks.
    }
}
