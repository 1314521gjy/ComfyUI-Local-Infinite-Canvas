import { isUiWorkflow } from "./registry.js";
import { isPlainObject } from "./util.js";

const NOTE_TYPES = new Set([
  "Note",
  "MarkdownNote",
  "Note Plus (mtb)",
  "Label (rgthree)",
  "Fast Groups Bypasser (rgthree)",
  "Fast Groups Muter (rgthree)",
  "Bookmark (rgthree)",
]);
const REROUTE_TYPE = "Reroute";
const PRIMITIVE_TYPE = "PrimitiveNode";
const BYPASS_MODE = 4;
const MUTE_MODE = 2;
function isImageOutputClass(classType) {
  return /^SaveImage$/i.test(classType) || /PreviewImage$/i.test(classType) || /(?:save|output).*(?:image|img)/i.test(classType) || /(?:image|img).*(?:save|output)/i.test(classType);
}

function isVideoOutputClass(classType) {
  return /SaveVideo|VHS_VideoCombine|SaveWebM/i.test(classType);
}
const BASIC_WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

// ResolutionSelector and similar combo nodes use labels like "16:9 (Widescreen)".
export function canonicalAspectRatio(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)/i);
  if (!match) return "";
  return `${Number(match[1])}:${Number(match[2])}`;
}

function comboOptions(objectInfo, classType, inputName) {
  const input = objectInfo?.[classType]?.input;
  const spec = input?.required?.[inputName] ?? input?.optional?.[inputName];
  if (Array.isArray(spec) && Array.isArray(spec[1]?.options)) return spec[1].options;
  if (Array.isArray(spec?.options)) return spec.options;
  return [];
}

// Nodes whose widget order is not obvious from object_info alone.
const WIDGET_ORDER = {
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: ["add_noise", "noise_seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
  LoadImage: ["image", "upload"],
  SaveVideo: ["filename_prefix", "format", "format.codec", "codec"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length"],
  MiniMaxH3ReferenceToVideo: ["prompt", "width", "height", "length", "ref_image_size"],
};

function normalizeType(value) {
  if (Array.isArray(value)) return "COMBO";
  if (Array.isArray(value?.options)) return "COMBO";
  return String(value || "");
}

function isWidgetType(type) {
  return BASIC_WIDGET_TYPES.has(normalizeType(type));
}

function inputSpecs(objectInfo, classType) {
  const info = objectInfo?.[classType];
  if (!info?.input) return [];
  const specs = [];
  for (const group of ["required", "optional"]) {
    for (const [name, value] of Object.entries(info.input[group] || {})) {
      specs.push({
        name,
        type: normalizeType(Array.isArray(value) ? value[0] : value?.type),
        opts: Array.isArray(value) ? value[1] || {} : value || {},
        required: group === "required",
      });
    }
  }
  return specs;
}

function normalizeLinks(links) {
  const map = new Map();
  for (const raw of links || []) {
    const item = Array.isArray(raw)
      ? { id: raw[0], from: raw[1], fromSlot: raw[2], to: raw[3], toSlot: raw[4], type: raw[5] }
      : { id: raw?.id, from: raw?.origin_id, fromSlot: raw?.origin_slot, to: raw?.target_id, toSlot: raw?.target_slot, type: raw?.type };
    if (item.id === undefined || item.id === null) continue;
    map.set(String(item.id), { from: String(item.from), fromSlot: Number(item.fromSlot) || 0, type: item.type });
  }
  return map;
}

function primitiveValue(node) {
  const named = node?.widgets_values_named;
  if (isPlainObject(named)) {
    const value = named.value ?? named.primitive ?? Object.values(named)[0];
    if (value !== undefined) return value;
  }
  const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
  return values[0];
}

export function convertUiWorkflow(ui, objectInfo = {}) {
  if (!isUiWorkflow(ui)) throw new Error("不是 ComfyUI UI 工作流（需要 nodes + links）");
  if (Array.isArray(ui.definitions?.subgraphs) && ui.definitions.subgraphs.length) {
    throw new Error("暂不支持包含 Subgraph 的工作流；请在 ComfyUI 里展开子图后保存，或导出 API 格式");
  }
  if ((ui.nodes || []).some((node) => /^workflow>|^Subgraph/i.test(String(node.type || "")))) {
    throw new Error("暂不支持子图/组节点工作流；请展开后保存，或导出 API 格式");
  }

  const nodes = new Map((ui.nodes || []).map((node) => [String(node.id), node]));
  const links = normalizeLinks(ui.links);
  const warnings = [];
  const missingClasses = new Set();

  function resolveEndpoint(nodeId, slot, seen = new Set()) {
    const key = `${nodeId}:${slot}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const node = nodes.get(nodeId);
    if (!node) return undefined;
    if (node.type === PRIMITIVE_TYPE) return { value: primitiveValue(node) };
    if (node.type === REROUTE_TYPE) {
      const linked = (node.inputs || []).find((input) => input.link !== null && input.link !== undefined);
      return linked ? resolveLink(linked.link, seen) : undefined;
    }
    const mode = Number(node.mode || 0);
    if (mode === MUTE_MODE) return undefined;
    if (mode === BYPASS_MODE) {
      const outputType = node.outputs?.[slot]?.type;
      const candidates = (node.inputs || []).filter((input) => input.type === outputType && input.link !== null && input.link !== undefined);
      if (candidates.length > 1) {
        warnings.push(`节点「${node.title || node.type}」有多个 ${outputType} 输入，旁路时只取第一个。`);
      }
      const linked = candidates[0];
      if (linked) return resolveLink(linked.link, seen);
      const widget = (node.inputs || []).find((input) => input.type === outputType && input.widget && node.widgets_values_named?.[input.name] !== undefined);
      if (widget) return { value: node.widgets_values_named[input.name] };
      warnings.push(`旁路节点「${node.title || node.type}」的 ${outputType} 输出没有同类型输入，相关输入会被省略。`);
      return undefined;
    }
    return { link: [nodeId, slot] };
  }

  function resolveLink(linkId, seen = new Set()) {
    const link = links.get(String(linkId));
    if (!link) return undefined;
    return resolveEndpoint(link.from, link.fromSlot, seen);
  }

  const workflow = {};
  for (const [nodeId, node] of nodes) {
    if (NOTE_TYPES.has(node.type) || node.type === REROUTE_TYPE || node.type === PRIMITIVE_TYPE) continue;
    const mode = Number(node.mode || 0);
    if (mode === MUTE_MODE || mode === BYPASS_MODE) continue;
    const specs = inputSpecs(objectInfo, node.type);
    if (!specs.length) {
      missingClasses.add(node.type);
      continue;
    }
    const specByName = new Map(specs.map((spec) => [spec.name, spec]));
    const uiInputs = new Map((node.inputs || []).map((input) => [input.name, input]));
    const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null;
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const inputOrder = WIDGET_ORDER[node.type] || (node.inputs || []).filter((input) => input.widget).map((input) => input.widget.name);
    const fallbackOrder = inputOrder.length ? inputOrder : specs.filter((spec) => isWidgetType(spec.type)).map((spec) => spec.name);

    const inputs = {};
    const setResolved = (name, resolved) => {
      if (resolved === undefined) return;
      if (resolved.value !== undefined) inputs[name] = resolved.value;
      else if (resolved.link) inputs[name] = resolved.link;
    };

    for (const uiInput of node.inputs || []) {
      if (uiInput.link === null || uiInput.link === undefined) continue;
      const resolved = resolveLink(uiInput.link);
      if (resolved === undefined) {
        if (specByName.get(uiInput.name)?.required) warnings.push(`节点「${node.title || node.type}」的输入 ${uiInput.name} 无法解析。`);
        continue;
      }
      setResolved(uiInput.name, resolved);
    }

    if (named) {
      for (const [name, value] of Object.entries(named)) {
        if (value === undefined || name in inputs) continue;
        if (!specByName.has(name) && !uiInputs.has(name)) continue;
        if (!isWidgetType(specByName.get(name)?.type || uiInputs.get(name)?.type)) continue;
        inputs[name] = value;
      }
    } else {
      fallbackOrder.forEach((name, index) => {
        if (!name || name === "control_after_generate" || name === "upload" || name in inputs) return;
        const spec = specByName.get(name);
        if (!spec || !isWidgetType(spec.type)) return;
        if (index < values.length) inputs[name] = values[index];
      });
    }

    // Some custom nodes keep prompt/width/height only in widget values, not in node.inputs.
    for (const spec of specs) {
      if (spec.name in inputs || !isWidgetType(spec.type)) continue;
      if (named && spec.name in named) inputs[spec.name] = named[spec.name];
    }

    workflow[nodeId] = {
      class_type: node.type,
      inputs,
      ...(node.title || node._meta?.title ? { _meta: { title: node.title || node._meta.title } } : {}),
    };
  }

  if (missingClasses.size) {
    throw new Error(`缺少节点定义：${[...missingClasses].slice(0, 8).join(", ")}。请先在 ComfyUI 安装对应自定义节点。`);
  }
  if (!Object.keys(workflow).length) throw new Error("转换后没有可执行节点");
  return { workflow, warnings };
}

function listNodes(workflow) {
  return Object.entries(workflow || {});
}

function linkTarget(value) {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "string" ? String(value[0]) : null;
}

function reachableNodes(workflow, roots) {
  const all = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (!id || all.has(id)) continue;
    const node = workflow[id];
    if (!node) continue;
    all.add(id);
    for (const value of Object.values(node.inputs || {})) {
      const target = linkTarget(value);
      if (target) stack.push(target);
    }
  }
  return all;
}

function numericInput(node, name) {
  const value = node?.inputs?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function detectFreeBindings(workflow, objectInfo = {}) {
  const entries = listNodes(workflow);
  const outputs = entries.filter(([, node]) => isImageOutputClass(node.class_type) || isVideoOutputClass(node.class_type));
  const outputType = outputs.some(([, node]) => isVideoOutputClass(node.class_type)) ? "video" : outputs.some(([, node]) => isImageOutputClass(node.class_type)) ? "image" : null;
  const roots = outputs.length ? outputs.map(([id]) => id) : entries.map(([id]) => id);
  const reachable = reachableNodes(workflow, roots);
  const warnings = [];
  if (!outputType) warnings.push("没有找到 SaveImage / SaveVideo 输出节点");

  const samplers = entries.filter(([id, node]) => reachable.has(id) && (node.inputs?.positive !== undefined || /KSampler|SamplerCustom|SelfLift/i.test(node.class_type)));

  let prompt = null;
  const promptCandidates = [];
  const queue = samplers
    .map(([id, node]) => ({ target: linkTarget(node.inputs?.positive), distance: 0, from: id }))
    .filter((item) => item.target);
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item.target || seen.has(item.target)) continue;
    seen.add(item.target);
    const node = workflow[item.target];
    if (!node) continue;
    const textName = Object.keys(node.inputs || {}).find((name) => (name === "text" || name === "prompt") && typeof node.inputs[name] === "string");
    if (textName) {
      promptCandidates.push({ node: item.target, input: textName, distance: item.distance, title: node._meta?.title || node.class_type });
      continue;
    }
    for (const value of Object.values(node.inputs || {})) {
      const target = linkTarget(value);
      if (target) queue.push({ target, distance: item.distance + 1, from: item.target });
    }
  }
  if (!promptCandidates.length) {
    for (const [id, node] of entries) {
      if (!reachable.has(id)) continue;
      const textName = Object.keys(node.inputs || {}).find((name) => (name === "text" || name === "prompt") && typeof node.inputs[name] === "string");
      if (textName) promptCandidates.push({ node: id, input: textName, distance: 99, title: node._meta?.title || node.class_type });
    }
  }
  promptCandidates.sort((a, b) => a.distance - b.distance || Number(a.node) - Number(b.node));
  if (promptCandidates.length) {
    prompt = { node: promptCandidates[0].node, input: promptCandidates[0].input };
    if (promptCandidates.length > 1) warnings.push(`找到 ${promptCandidates.length} 个提示词输入，已使用「${promptCandidates[0].title}」；其他请在 ComfyUI 里固定。`);
  } else {
    warnings.push("没有找到正向提示词输入，卡片将不显示提示词框");
  }

  const images = entries
    .filter(([id, node]) => reachable.has(id) && /^LoadImage/.test(node.class_type) && typeof node.inputs?.image === "string")
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, input: "image", title: node._meta?.title || node.class_type }));

  const sizes = entries
    .filter(([id, node]) => reachable.has(id) && numericInput(node, "width") !== null && numericInput(node, "height") !== null)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, widthInput: "width", heightInput: "height", width: numericInput(node, "width"), height: numericInput(node, "height") }));
  if (sizes.length > 1) warnings.push(`检测到 ${sizes.length} 个尺寸节点，修改尺寸时会同时写入；默认取节点 ${sizes[0].node} 的值。`);

  const ratios = entries
    .filter(([id, node]) => reachable.has(id) && typeof node.inputs?.aspect_ratio === "string")
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => {
      const options = comboOptions(objectInfo, node.class_type, "aspect_ratio");
      const values = options.length ? options : [node.inputs.aspect_ratio];
      return {
        node: id,
        input: "aspect_ratio",
        value: node.inputs.aspect_ratio,
        options,
        ratios: [...new Set(values.map(canonicalAspectRatio).filter(Boolean))],
      };
    })
    .filter((binding) => binding.ratios.length);

  const batches = entries
    .filter(([id, node]) => reachable.has(id) && numericInput(node, "batch_size") !== null)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, input: "batch_size", default: numericInput(node, "batch_size") }));

  const seeds = entries
    .filter(([id, node]) => reachable.has(id) && (numericInput(node, "seed") !== null || numericInput(node, "noise_seed") !== null))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => {
      const input = numericInput(node, "seed") !== null ? "seed" : "noise_seed";
      return { node: id, input, default: numericInput(node, input) };
    });
  if (seeds.length > 1) warnings.push(`检测到 ${seeds.length} 个种子节点，固定种子会同时写入。`);

  return {
    outputType,
    prompt,
    images,
    sizes,
    ratios,
    batches,
    seeds,
    warnings,
  };
}

export function bindingSummary(bindings) {
  const ratioBindings = bindings.ratios || [];
  const aspectRatios = [...new Set(ratioBindings.flatMap((binding) => binding.ratios || []))];
  const aspectRatio = canonicalAspectRatio(ratioBindings[0]?.value) || aspectRatios[0] || null;
  return {
    outputType: bindings.outputType || null,
    prompt: Boolean(bindings.prompt),
    imageInputs: bindings.images?.length || 0,
    size: bindings.sizes?.[0] ? { width: bindings.sizes[0].width, height: bindings.sizes[0].height } : null,
    aspectRatio,
    aspectRatios,
    count: bindings.batches?.[0]?.default ?? null,
    hasSeed: Boolean(bindings.seeds?.length),
    seed: Number(bindings.seeds?.[0]?.default) > 0 ? String(bindings.seeds[0].default) : null,
    warnings: bindings.warnings || [],
  };
}
