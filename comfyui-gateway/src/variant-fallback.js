// 编辑模式默认走干净 pruned INT8；没装时自动降级到未剪枝 Singularity 变体，避免误报不可用。
export const WORKFLOW_VARIANT_FALLBACKS = {
  "video-h3-viggle-swap": { edit: "edit-singularity" },
};

export function resolveVariantFallback(setup, entry, mode) {
  const fallback = WORKFLOW_VARIANT_FALLBACKS[entry?.id]?.[mode];
  if (!fallback || !entry?.variants?.[fallback]) return mode;
  const variants = setup?.workflowStatus?.(entry.id)?.variants || {};
  if (variants[mode]?.available !== false) return mode;
  return variants[fallback]?.available === true ? fallback : mode;
}
