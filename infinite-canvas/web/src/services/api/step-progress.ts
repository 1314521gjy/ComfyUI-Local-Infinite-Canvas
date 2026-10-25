export type GenerationStepProgress = { step: number; total: number; requestId?: string };

const handlers = new WeakMap<AbortSignal, (progress: GenerationStepProgress) => void>();

export function bindStepProgress(signal: AbortSignal, handler: (progress: GenerationStepProgress) => void) {
    handlers.set(signal, handler);
}

export function unbindStepProgress(signal: AbortSignal) {
    handlers.delete(signal);
}

export function publishStepProgress(signal: AbortSignal | undefined, progress: GenerationStepProgress) {
    if (signal) handlers.get(signal)?.(progress);
}
