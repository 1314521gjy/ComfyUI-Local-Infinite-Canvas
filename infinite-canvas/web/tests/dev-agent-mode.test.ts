import { afterAll, expect, test } from "bun:test";

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
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

const { useDevAgentStore } = await import("../src/stores/use-dev-agent-store");

test("developer mode is persisted across store reads", () => {
    useDevAgentStore.getState().setEnabled(true);
    expect(useDevAgentStore.getState().enabled).toBe(true);
    const saved = JSON.parse(values.get("infinite-canvas:dev_agent_store") || "{}");
    expect(saved.state?.enabled).toBe(true);

    useDevAgentStore.getState().setEnabled(false);
    expect(useDevAgentStore.getState().enabled).toBe(false);
    const cleared = JSON.parse(values.get("infinite-canvas:dev_agent_store") || "{}");
    expect(cleared.state?.enabled).toBe(false);
});
