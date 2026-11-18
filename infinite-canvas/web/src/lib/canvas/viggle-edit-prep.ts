export type VigglePrepStep = "selfproduce" | "extract" | "edit" | "inject";
export type VigglePrepPhase = "idle" | "running" | "done" | "error";
export type VigglePrepState = { phase: VigglePrepPhase; step?: VigglePrepStep; error?: string };
export type VigglePrepCandidate = { frame: number; thumbUrl?: string };
export type VigglePrepResult = { imageUrl: string; frameNumber: number; pins: string; thumbUrl?: string; targetFrameUrl?: string; candidates?: VigglePrepCandidate[] };

export type VigglePrepInput = {
    sourceVideoUrl: string;
    videoFile?: File;
    instruction: string;
    pin?: string;
    expected?: { width: number; height: number };
    signal?: AbortSignal;
    onStep: (step: VigglePrepStep) => void;
};

export type VigglePrepAdapter = (input: VigglePrepInput) => Promise<VigglePrepResult>;

export const VIGGLE_PREP_STEPS: VigglePrepStep[] = ["extract", "edit", "inject"];

export const VIGGLE_PREP_STEP_LABELS: Record<VigglePrepStep, string> = {
    selfproduce: "自产目标帧",
    extract: "抽帧",
    edit: "改图",
    inject: "注入",
};

export function prepFailureGuidance(error: string) {
    const detail = String(error || "").trim();
    return `自动制备失败${detail ? `（${detail}）` : ""}：请手动从源视频抽帧 → 用图像编辑改好 → 上传为参考图，pins 填对应帧号。`;
}

export type VigglePrepRunInput = { sourceVideoUrl: string; videoFile?: File; instruction: string; pin?: string; expected?: { width: number; height: number }; signal?: AbortSignal };

export function createViggleEditPrep(adapter: VigglePrepAdapter) {
    let state: VigglePrepState = { phase: "idle" };
    const listeners = new Set<(next: VigglePrepState) => void>();
    const set = (next: VigglePrepState) => {
        state = next;
        for (const listener of listeners) listener(next);
    };
    return {
        getState: () => state,
        subscribe(listener: (next: VigglePrepState) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async run(input: VigglePrepRunInput) {
            set({ phase: "running", step: "extract" });
            try {
                const result = await adapter({
                    ...input,
                    onStep: (step) => set({ phase: "running", step }),
                });
                set({ phase: "done" });
                return result;
            } catch (error) {
                if (input.signal?.aborted) {
                    set({ phase: "idle" });
                    throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                set({ phase: "error", error: message });
                throw error;
            }
        },
        reset() {
            set({ phase: "idle" });
        },
    };
}

export function createMockPrepAdapter(options?: { failAt?: VigglePrepStep; delayMs?: number }): VigglePrepAdapter {
    return async ({ onStep }) => {
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        for (const step of VIGGLE_PREP_STEPS) {
            onStep(step);
            await delay(options?.delayMs ?? 5);
            if (options?.failAt === step) throw new Error(`mock ${step} failed`);
        }
        return { imageUrl: "mock://edited.png", frameNumber: 96, pins: "96" };
    };
}
