export type ReferenceAccelInput = {
    isViggleSwap: boolean;
    referenceAcceleration: unknown;
    mode: string;
    fastDraft: boolean;
    imageCount: number;
};

/** Viggle 逐图身份语义依赖每张参考图独立送入，拼图会破坏 ref 语义并撑爆 pins；恒走逐图路径。 */
export function shouldAccelerateReference({ isViggleSwap, referenceAcceleration, mode, fastDraft, imageCount }: ReferenceAccelInput) {
    return Boolean(referenceAcceleration) && !isViggleSwap && mode === "reference" && !fastDraft && imageCount > 1;
}
