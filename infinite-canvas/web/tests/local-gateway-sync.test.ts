import { afterAll, expect, test } from "bun:test";
import type { AiConfig, ChannelModel } from "../src/stores/use-config-store";

// The config store (and the sync helper importing it) touches localStorage during module init.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const {
    createGatewayModelSync,
    decideModelApply,
    fetchSetupDiagnostics,
    isStaleServerRevision,
    modelPickerEmptyActions,
    parseGatewayModelsPayload,
    pickerOpenPlan,
    requestGatewayRescan,
    resolveModelPickerEmptyKind,
} = await import("../src/lib/local-gateway-sync");
const { applyLocalGatewayModels, defaultConfig } = await import("../src/stores/use-config-store");

const CHANNEL_ID = "local-gateway";
const BASE_URL = "http://127.0.0.1:8190/v1";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const localConfig = (): AiConfig => ({
    ...defaultConfig,
    channelMode: "local",
    baseUrl: BASE_URL,
    apiKey: "keep-me",
    channels: [
        {
            id: CHANNEL_ID,
            name: "Local",
            baseUrl: BASE_URL,
            apiKey: "keep-me",
            apiFormat: "openai",
            models: [
                { name: "image-a", capability: "image" },
                { name: "image-b", capability: "image" },
            ],
        },
    ],
    model: `${CHANNEL_ID}::image-a`,
    imageModel: `${CHANNEL_ID}::image-a`,
    videoModel: "",
    models: [`${CHANNEL_ID}::image-a`, `${CHANNEL_ID}::image-b`],
});

function payload(models: string[], options: { revision?: number; scanId?: string; setup?: Record<string, unknown> } = {}) {
    return {
        object: "list",
        revision: options.revision,
        data: models.map((name) => ({ id: name, metadata: { type: "image", workflowId: "wf-image", label: name } })),
        setup: {
            phase: "ready",
            scanId: options.scanId ?? "scan-1",
            scanning: false,
            stale: false,
            comfyReachable: true,
            ...options.setup,
        },
    };
}

function applyDecision(config: AiConfig, raw: unknown, trigger: Parameters<typeof decideModelApply>[1]) {
    const snapshot = parseGatewayModelsPayload(raw);
    const decision = decideModelApply(snapshot, trigger);
    if (decision.action === "retain") return { config, decision };
    const result = applyLocalGatewayModels(config, { channelId: CHANNEL_ID, baseUrl: BASE_URL, models: snapshot.models, clear: decision.action === "clear" });
    return { config: result.config, decision };
}

test("a slow old response can never overwrite the newer list", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const applied: string[][] = [];
    const sync = createGatewayModelSync({
        fetchModels: () => new Promise((resolve) => resolvers.push(resolve)),
        apply: (snapshot) => applied.push(snapshot.models.map((model) => model.name)),
    });

    const first = sync.request("focus");
    await flush();
    const followUp = sync.request("sse", "visibility");
    resolvers[0](payload(["old-image"], { revision: 1 }));
    await flush();
    expect(resolvers).toHaveLength(2);
    resolvers[1](payload(["new-image"], { revision: 2 }));
    await Promise.all([first, followUp]);

    expect(applied).toEqual([["new-image"]]);
    expect(sync.status().revision).toBe(2);
});

test("events arriving during a sync are queued and trigger a follow-up pull", async () => {
    let fetchCount = 0;
    const resolvers: Array<(value: unknown) => void> = [];
    const applied: string[][] = [];
    const sync = createGatewayModelSync({
        fetchModels: () => {
            fetchCount += 1;
            return new Promise((resolve) => resolvers.push(resolve));
        },
        apply: (snapshot) => applied.push(snapshot.models.map((model) => model.name)),
    });

    const first = sync.request("initial");
    await flush();
    void sync.request("sse", "directories");
    void sync.request("focus");
    resolvers[0](payload(["image-a"], { revision: 1 }));
    await flush();
    expect(fetchCount).toBe(2);
    expect(resolvers).toHaveLength(2);
    resolvers[1](payload(["image-b"], { revision: 2 }));
    await first;

    expect(applied.at(-1)).toEqual(["image-b"]);
    expect(sync.status().reason).toBe("focus");
});

test("scanning or degraded empty responses keep the current models and default selection", () => {
    for (const setup of [
        { phase: "scanning", scanning: true },
        { phase: "degraded", stale: true },
        { phase: "ready", comfyReachable: false },
    ]) {
        const { config, decision } = applyDecision(localConfig(), payload([], { setup }), "sse");
        expect(decision.action).toBe("retain");
        expect(config.channels[0].models.map((model) => model.name)).toEqual(["image-a", "image-b"]);
        expect(config.imageModel).toBe(`${CHANNEL_ID}::image-a`);
        expect(config.model).toBe(`${CHANNEL_ID}::image-a`);
    }
});

test("only a confirmed ready, non-scanning empty snapshot clears models and selections", () => {
    const ready = applyDecision(localConfig(), payload([]), "sse");
    expect(ready.decision.action).toBe("clear");
    expect(ready.config.channels[0].models).toEqual([]);
    expect(ready.config.imageModel).toBe("");
    expect(ready.config.model).toBe("");
    expect(ready.config.channels[0].apiKey).toBe("keep-me");

    const fromPoll = applyDecision(localConfig(), payload([]), "poll");
    expect(fromPoll.decision.action).toBe("retain");
    expect(fromPoll.config.channels[0].models).toHaveLength(2);

    const legacy = applyDecision(localConfig(), { object: "list", data: [] }, "sse");
    expect(legacy.decision.action).toBe("retain");
    expect(legacy.config.channels[0].models).toHaveLength(2);
});

test("a failed sync keeps the old list and only marks the status stale", async () => {
    const applied: unknown[] = [];
    const statuses: Array<{ phase: string; stale: boolean; error?: string }> = [];
    const sync = createGatewayModelSync({
        fetchModels: async () => {
            throw new TypeError("Failed to fetch");
        },
        apply: (snapshot) => applied.push(snapshot),
        onStatus: (status) => statuses.push({ phase: status.phase, stale: status.stale, error: status.error }),
    });
    await sync.request("sse");
    expect(applied).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ phase: "offline", stale: true, error: "Failed to fetch" });
});

test("a stale server revision is discarded unless a new scan generation started", () => {
    expect(isStaleServerRevision({ revision: 5, scanId: "scan-1" }, { revision: 4, scanId: "scan-1" })).toBe(true);
    expect(isStaleServerRevision({ revision: 5, scanId: "scan-1" }, { revision: 4, scanId: "scan-2" })).toBe(false);
    expect(isStaleServerRevision({ revision: 5, scanId: "scan-1" }, { revision: 5, scanId: "scan-1" })).toBe(false);
    expect(isStaleServerRevision({ revision: 5, scanId: "scan-1" }, { revision: undefined })).toBe(false);
});

test("equal event revision with an older environment revision is stale", () => {
    expect(isStaleServerRevision({ revision: 5, setupRevision: 3, instanceId: "gw-1" }, { revision: 5, setupRevision: 2, instanceId: "gw-1" })).toBe(true);
    expect(isStaleServerRevision({ revision: 5, setupRevision: 3, instanceId: "gw-1" }, { revision: 5, setupRevision: 4, instanceId: "gw-1" })).toBe(false);
});

test("a restarted gateway instance may reset its revision sequence", () => {
    expect(isStaleServerRevision({ revision: 9, setupRevision: 4, instanceId: "gw-old" }, { revision: 1, setupRevision: 1, instanceId: "gw-new" })).toBe(false);
});

test("numeric backend scan ids and instance ids are preserved", () => {
    const snapshot = parseGatewayModelsPayload({
        revision: 7,
        data: [],
        setup: { phase: "ready", instanceId: "setup_abc", scanId: 3, revision: 2, scanning: false, stale: false },
    });
    expect(snapshot.setup?.scanId).toBe("3");
    expect(snapshot.setup?.instanceId).toBe("setup_abc");
    expect(snapshot.setup?.revision).toBe(7);
});

test("a lower server revision response does not overwrite an already applied list", async () => {
    const applied: string[][] = [];
    let call = 0;
    const sync = createGatewayModelSync({
        fetchModels: async () => {
            call += 1;
            return call === 1 ? payload(["image-a"], { revision: 5 }) : payload(["image-b"], { revision: 4 });
        },
        apply: (snapshot) => applied.push(snapshot.models.map((model) => model.name)),
    });
    await sync.request("initial");
    await sync.request("focus");
    expect(applied).toEqual([["image-a"]]);
    expect(sync.status().revision).toBe(5);
});

test("empty pickers report scanning/offline/unsynced/no-models and never auto-open config", () => {
    const base = { phase: "idle" as const, scanning: false, stale: false };
    expect(resolveModelPickerEmptyKind({ optionCount: 0, local: true, status: { ...base, scanning: true, phase: "scanning" } })).toBe("scanning");
    expect(resolveModelPickerEmptyKind({ optionCount: 0, local: true, status: { ...base, phase: "offline" } })).toBe("offline");
    expect(resolveModelPickerEmptyKind({ optionCount: 0, local: true, status: base })).toBe("unsynced");
    expect(resolveModelPickerEmptyKind({ optionCount: 0, local: true, status: { ...base, phase: "ready", revision: 3 } })).toBe("no-models");
    expect(resolveModelPickerEmptyKind({ optionCount: 1, local: true, status: base })).toBeNull();

    expect(modelPickerEmptyActions({ local: true, hasMissingConfigHandler: false })).toEqual(["rescan", "diagnostics"]);
    expect(modelPickerEmptyActions({ local: true, hasMissingConfigHandler: true })).toEqual(["rescan", "reason", "diagnostics"]);
    expect(pickerOpenPlan(true).requestConfig).toBe(false);
});

test("diagnostics are fetched for the workflow, sanitized, and surface short failures", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
        requested = url;
        return new Response(
            JSON.stringify({
                ok: true,
                workflowId: "wf-image",
                comfy: { url: "http://127.0.0.1:8188", authorization: "Bearer abc.def" },
                apiKey: "sk-secret",
                prompt: "a very private prompt",
                paths: { models: "C:\\Users\\Example\\Documents\\models" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as unknown as typeof fetch;

    const { text, report } = await fetchSetupDiagnostics({ root: BASE_URL.replace(/\/v1$/, ""), workflowId: "wf-image", fetchImpl });
    expect(requested).toContain("/api/setup/diagnostics?workflowId=wf-image");
    const gateway = (report as { gateway: Record<string, unknown> }).gateway;
    expect(gateway.apiKey).toBe("[redacted]");
    expect(gateway.prompt).toBe("[redacted]");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("a very private prompt");
    expect((gateway.paths as { models: string }).models).toBe("C:\\Users\\<user>\\Documents\\models");

    const failing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchSetupDiagnostics({ root: "http://127.0.0.1:8190", fetchImpl: failing })).rejects.toThrow("HTTP 404");
});

test("rescan prefers the resource refresh endpoint and falls back to setup scan", async () => {
    const calls: string[] = [];
    const firstOk = (async (url: string) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await requestGatewayRescan({ root: "http://127.0.0.1:8190", fetchImpl: firstOk })).toEqual({ source: "resources" });
    expect(calls).toEqual(["http://127.0.0.1:8190/api/resources/refresh"]);

    calls.length = 0;
    let attempt = 0;
    const fallback = (async (url: string) => {
        calls.push(url);
        attempt += 1;
        return new Response("{}", { status: attempt === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    expect(await requestGatewayRescan({ root: "http://127.0.0.1:8190", fetchImpl: fallback })).toEqual({ source: "setup" });
    expect(calls).toEqual(["http://127.0.0.1:8190/api/resources/refresh", "http://127.0.0.1:8190/api/setup/scan"]);
});

test("synced models keep an explicitly configured channel api key", () => {
    const models: ChannelModel[] = [{ name: "image-c", capability: "image" }];
    const result = applyLocalGatewayModels(localConfig(), { channelId: CHANNEL_ID, baseUrl: BASE_URL, models });
    expect(result.changed).toBe(true);
    expect(result.config.channels[0].apiKey).toBe("keep-me");
    expect(result.config.channels[0].baseUrl).toBe(BASE_URL);
    expect(result.config.channels[0].models.map((model) => model.name)).toEqual(["image-c"]);
    expect(result.config.imageModel).toBe(`${CHANNEL_ID}::image-c`);
});
