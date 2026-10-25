import fs from "node:fs";
import path from "node:path";

// ComfyUI 的 UI 工作流把 widget 值放在 widgets_values 数组里；这里覆盖本机 Z-Image 图用到的标准节点。
// 新节点类型先在这里补 widget 顺序，或直接用 ComfyUI 的「导出（API）」。
const WIDGET_ORDER = {
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type", "device"],
  VAELoader: ["vae_name"],
  CLIPTextEncode: ["text"],
  EmptyLatentImage: ["width", "height", "batch_size"],
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  SaveImage: ["filename_prefix"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length"],
  MiniMaxH3ReferenceToVideo: ["prompt", "width", "height", "length", "ref_image_size"],
  ApplyVDNH3Advanced: ["vdn_checkpoint", "apply_turbo_adapter", "stage_b_strength", "turbo_strength", "lora_mode", "branch_weights", "retain_buffers", "verbose", "attention_backend", "window_radius", "window_chunk", "anchor_frames", "text_state", "linear_branch", "fast_kernels"],
  MiniMaxChunkFeedForward: ["chunks", "seq_threshold"],
  ModelPreviewOverrideKJ: ["max_resolution", "jpeg_quality", "suppress_default_preview", "preview_frames", "preview_fps", "tiny_vae"],
  RandomNoise: ["noise_seed", "control_after_generate"],
  BasicScheduler: ["scheduler", "steps", "denoise"],
  KSamplerSelect: ["sampler_name"],
  CreateVideo: ["fps", "bit_depth", "color_space"],
  SaveVideo: ["filename_prefix", "format", "format.codec", "codec"],
};

const SKIP_TYPES = new Set(["MarkdownNote", "Note", "Note Plus (mtb)", "Reroute"]);
const SKIP_WIDGETS = new Set(["control_after_generate", "upload"]);

function convert(ui) {
  const linkMap = new Map((ui.links || []).map(([id, from, fromSlot]) => [id, [String(from), fromSlot]]));
  const result = {};
  for (const node of ui.nodes || []) {
    if (SKIP_TYPES.has(node.type)) continue;
    const inputs = {};
    const order = WIDGET_ORDER[node.type] || (node.inputs || []).filter((input) => input.widget).map((input) => input.widget.name);
    const values = node.widgets_values || [];
    for (const input of node.inputs || []) {
      if (input.link !== null && input.link !== undefined) {
        const link = linkMap.get(input.link);
        if (link) inputs[input.name] = link;
        continue;
      }
      if (input.widget) {
        const index = order.indexOf(input.widget.name);
        if (index >= 0 && index < values.length) inputs[input.name] = values[index];
      }
    }
    // 有些节点的 widget 不出现在 node.inputs 里（例如 H3 的 prompt/width/height/length），补一轮。
    order.forEach((name, index) => {
      if (SKIP_WIDGETS.has(name) || name in inputs || index >= values.length) return;
      inputs[name] = values[index];
    });
    result[String(node.id)] = {
      class_type: node.type,
      inputs,
      ...(node.title ? { _meta: { title: node.title } } : {}),
    };
  }
  return result;
}

const [input, output, name] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/convert-ui-workflow.mjs <ui-workflow.json> <api-workflow.json> [name]");
  process.exit(1);
}
const ui = JSON.parse(fs.readFileSync(input, "utf8"));
if (!Array.isArray(ui.nodes) || !Array.isArray(ui.links)) {
  console.error("不是 ComfyUI UI 格式（需要 nodes + links）。");
  process.exit(1);
}
const api = convert(ui);
const target = path.resolve(output);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(api, null, 2)}\n`);
console.log(`converted ${ui.nodes.length} nodes -> ${Object.keys(api).length} API nodes`);
console.log(`output: ${target}${name ? ` (name: ${name})` : ""}`);
