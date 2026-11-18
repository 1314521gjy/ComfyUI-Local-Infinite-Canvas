import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DevAgentStatus = "idle" | "checking" | "connected" | "error";

export const PI_AGENT_BASE_URL = "http://127.0.0.1:18800";
export const PI_AGENT_NORMAL_MODEL = "openclaw/canvas-agent";
export const PI_AGENT_DEV_MODEL = "openclaw/canvas-dev";

type DevAgentStore = {
    enabled: boolean;
    status: DevAgentStatus;
    error: string;
    baseUrl: string;
    setEnabled: (enabled: boolean) => void;
    setStatus: (status: DevAgentStatus, error?: string) => void;
    setBaseUrl: (baseUrl: string) => void;
};

export const useDevAgentStore = create<DevAgentStore>()(
    persist(
        (set) => ({
            enabled: false,
            status: "idle",
            error: "",
            baseUrl: PI_AGENT_BASE_URL,
            setEnabled: (enabled) => set({ enabled }),
            setStatus: (status, error = "") => set({ status, error }),
            setBaseUrl: (baseUrl) => set({ baseUrl: String(baseUrl || "").trim().replace(/\/+$/, "") || PI_AGENT_BASE_URL }),
        }),
        {
            name: "infinite-canvas:dev_agent_store",
            partialize: (state) => ({ enabled: state.enabled }),
        },
    ),
);
