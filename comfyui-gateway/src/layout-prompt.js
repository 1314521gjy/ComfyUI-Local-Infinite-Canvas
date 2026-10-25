const LABELS = new Set(["object", "character", "text"]);
const KIND_LABELS = { object: "物体", character: "人物" };

function displayCaption(caption) {
  return caption.replace(/^(物体|人物|文字)\s*[：:]\s*/, "").trim();
}

function buildDisplayList(regions) {
  return regions
    .filter((region) => region?.label !== "text")
    .map((region) => {
      const caption = displayCaption(String(region?.caption || "").trim());
      if (!caption) return "";
      return `${KIND_LABELS[region.label] || "物体"}：${caption}`;
    })
    .filter(Boolean)
    .join("；");
}

// MOSS literalizes CJK item captions unless the whole-image summary also lists them; verified 8/50-step.
function mergeDisplayList(summary, display) {
  if (!display || summary.includes(display)) return summary;
  const base = summary.replace(/[。；;，,\s]+$/, "");
  return base ? `${base}。${display}。` : `${display}。`;
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function normalizeBox(region) {
  const box = region?.bbox || region || {};
  const x = clamp01(box.x);
  const y = clamp01(box.y);
  const width = Math.min(1 - x, clamp01(box.width));
  const height = Math.min(1 - y, clamp01(box.height));
  return { x, y, width, height };
}

function centeredEdge(start, size, total) {
  return Math.round(start * size) - Math.floor(total / 2);
}

export function buildMossLayoutPrompt(layout, fallbackPrompt = "", fallbackSize = {}) {
  const regions = Array.isArray(layout?.regions) ? layout.regions : [];
  if (!regions.length && !layout?.summary) return "";
  const width = Math.max(16, Math.round(Number(layout?.width || fallbackSize.width) || 1024));
  const height = Math.max(16, Math.round(Number(layout?.height || fallbackSize.height) || 1024));
  const summary = String(layout?.summary || fallbackPrompt || "").trim();
  const display = buildDisplayList(regions);
  const mergedSummary = mergeDisplayList(summary, display);
  const items = regions.slice(0, 32).map((region) => {
    const box = normalizeBox(region);
    const label = LABELS.has(region?.label) ? region.label : "object";
    const item = { label, caption: String(region?.caption || "").trim() };
    if (label === "text") item.text = String(region?.text || "");
    if (Array.isArray(region?.palette) && region.palette.length) item.palette = region.palette.slice(0, 5);
    item.bbox = [
      centeredEdge(box.y, height, height),
      centeredEdge(box.x, width, width),
      Math.ceil(box.y * height + box.height * height) - Math.floor(height / 2),
      Math.ceil(box.x * width + box.width * width) - Math.floor(width / 2),
    ];
    return item;
  });
  return JSON.stringify({ summary: { caption: mergedSummary }, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" });
}

export function applyMossLayoutPrompt(context) {
  const layout = context?.params?.layout;
  if (!layout || typeof layout !== "object") return false;
  if (context?.params?.layoutEnabled !== true && layout.enabled !== true) return false;
  const prompt = buildMossLayoutPrompt(layout, context.prompt, context.size || {});
  if (!prompt) return false;
  context.prompt = prompt;
  return true;
}
