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
const SET_NODE_TYPE = "SetNode";
const GET_NODE_TYPE = "GetNode";
// 社区包的前端虚拟节点：easy 的存取节点与 ComfyUI 自带 Set/Get 同构；
// 孤海滑块是把控件值喂给下游输入的「值节点」，本体不执行。
const EASY_SET_TYPE = "easy setNode";
const EASY_GET_TYPE = "easy getNode";
const isSetNode = (node) => node?.type === SET_NODE_TYPE || node?.type === EASY_SET_TYPE;
const isGetNode = (node) => node?.type === GET_NODE_TYPE || node?.type === EASY_GET_TYPE;
const isValueNode = (node) => node?.type === "GoohaiUniversalSlider";
const valueNodeValue = (node) => {
  const named = node?.widgets_values_named;
  if (isPlainObject(named) && named["值"] !== undefined) return named["值"];
  return Array.isArray(node?.widgets_values) ? node.widgets_values[0] : undefined;
};
const BYPASS_MODE = 4;
const MUTE_MODE = 2;

// 组开关/旁路器是前端辅助节点，不参与 ComfyUI 后端执行；不能因为
// object_info 里没有它就把整张 UI 工作流判成“缺自定义节点”。
function isUiOnlyNode(node) {
  const type = String(node?.type || "");
  if (NOTE_TYPES.has(type)) return true;
  if (!/ignore.*group|group.*ignore|fast.*group|group.*bypass|group.*mute|忽略.*组|组.*忽略/i.test(type)) return false;
  const links = [...(node.inputs || []), ...(node.outputs || [])];
  return !links.some((item) => item?.link !== null && item?.link !== undefined);
}
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
  if (Array.isArray(spec)) {
    if (Array.isArray(spec[0])) return spec[0];
    if (Array.isArray(spec[1]?.options)) return spec[1].options;
    if (spec.length && spec.every((item) => typeof item === "string")) return spec;
  }
  if (Array.isArray(spec?.options)) return spec.options;
  return [];
}

export function isInputLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
}

function graphPoint(value) {
  if (Array.isArray(value) && value.length >= 2) return { x: Number(value[0]) || 0, y: Number(value[1]) || 0 };
  if (value && typeof value === "object") return { x: Number(value.x ?? value[0]) || 0, y: Number(value.y ?? value[1]) || 0 };
  return null;
}

function graphSize(value) {
  if (Array.isArray(value) && value.length >= 2) return { width: Number(value[0]) || 0, height: Number(value[1]) || 0 };
  if (value && typeof value === "object") return { width: Number(value.width ?? value[0]) || 0, height: Number(value.height ?? value[1]) || 0 };
  return null;
}

function graphInputLabel(name) {
  return String(name || "").replace(/_/g, " ");
}

export function buildWorkflowGraph(workflow, uiWorkflow = null, objectInfo = {}) {
  const uiNodes = new Map((uiWorkflow?.nodes || []).map((node) => [String(node.id), node]));
  const nodes = [];
  const links = [];
  for (const [id, node] of Object.entries(workflow || {})) {
    if (!node || typeof node !== "object" || typeof node.class_type !== "string") continue;
    const uiNode = uiNodes.get(String(id));
    const info = objectInfo?.[node.class_type];
    const inputs = [];
    for (const [name, value] of Object.entries(node.inputs || {})) {
      const linked = isInputLink(value);
      if (linked) {
        links.push({ from: String(value[0]), to: String(id), toInput: name });
        inputs.push({ name, label: graphInputLabel(name), linked: true, literal: false, value: null, type: "linked", options: [] });
        continue;
      }
      const options = comboOptions(objectInfo, node.class_type, name).map(String);
      const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
      inputs.push({
        name,
        label: graphInputLabel(name),
        linked: false,
        literal: scalar,
        value: scalar ? value : null,
        type: options.length ? "select" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : scalar ? "string" : "json",
        options,
      });
    }
    nodes.push({
      id: String(id),
      class_type: node.class_type,
      title: String(uiNode?.title || node._meta?.title || info?.display_name || node.class_type),
      pos: graphPoint(uiNode?.pos),
      size: graphSize(uiNode?.size),
      inputs,
    });
  }
  return { nodes, links };
}

// Nodes whose widget order is not obvious from object_info alone.
const WIDGET_ORDER = {
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: ["add_noise", "noise_seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
  LoadImage: ["image", "upload"],
  SaveVideo: ["filename_prefix", "format", "format.codec", "codec"],
  VHS_VideoCombine: ["frame_rate", "loop_count", "filename_prefix", "format", "pingpong", "save_output"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length"],
  MiniMaxH3ReferenceToVideo: ["prompt", "width", "height", "length", "ref_image_size"],
};

// The UI keeps display labels such as "Ref2VA — 参考生音视频" while the API
// validates against short combo values. Map a label back to its option when
// one option is a prefix of the saved label.
function normalizeComboValue(spec, value) {
  if (typeof value !== "string" || !spec) return value;
  const options = Array.isArray(spec.opts?.options) ? spec.opts.options : [];
  if (!options.length || options.includes(value)) return value;
  const text = value.trim();
  return options.find((option) => typeof option === "string" && (option === text || text.startsWith(option) || option.startsWith(text))) ?? value;
}

function normalizeType(value) {
  if (Array.isArray(value)) return "COMBO";
  if (Array.isArray(value?.options)) return "COMBO";
  return String(value || "");
}

// 用 object_info 校验一个控件值是否合法（类型/范围/下拉选项）。
// 拿不准就不推：校验不过的对齐方案直接丢弃，绝不写入可疑值。
function specValueValid(objectInfo, classType, spec, value) {
  if (!spec || value === undefined) return true;
  const type = normalizeType(spec.type);
  if (type === "INT" || type === "FLOAT") {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    const min = Number(spec.opts?.min);
    const max = Number(spec.opts?.max);
    if (Number.isFinite(min) && number < min) return false;
    if (Number.isFinite(max) && number > max) return false;
    return true;
  }
  if (type === "BOOLEAN") return typeof value === "boolean";
  if (type === "COMBO") {
    const options = comboOptions(objectInfo, classType, spec.name).map(String);
    if (!options.length) return true;
    return options.includes(String(value));
  }
  return true;
}

function isWidgetType(type) {
  const normalized = normalizeType(type);
  return BASIC_WIDGET_TYPES.has(normalized) || /COMBO/i.test(normalized);
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

const TEXTISH_INPUT_NAMES = new Set(["text", "prompt", "value", "string", "content", "caption", "instruction"]);
const NON_TEXT_INPUT_NAMES = new Set([
  "filename_prefix",
  "image",
  "images",
  "mask",
  "api_key",
  "api_base_url",
  "api_token",
  "base_url",
  "token",
  "password",
  "secret",
  "filename",
  "url",
  "path",
  "file",
  "filepath",
  "model",
  "clip_name",
  "vae_name",
  "lora_name",
  "ckpt_name",
  "unet_name",
  "sampler_name",
  "scheduler",
  "format",
  "codec",
  "frame_rate",
  "aspect_ratio",
  "upscale_method",
  "device",
  "weight_dtype",
  "control_after_generate",
  "upload",
  "prefix",
  "output_dir",
  "type",
]);

// 一个节点可能有多个字符串输入；只把“可读写的文本”暴露给自由卡片，
// 模型名/文件名/采样器等技术字段不当作提示词。
function isTextInput(node, name, objectInfo) {
  if (typeof node?.inputs?.[name] !== "string") return false;
  if (NON_TEXT_INPUT_NAMES.has(name)) return false;
  if (name === "text" || name === "prompt") return true;
  const spec = inputSpecs(objectInfo, node.class_type).find((item) => item.name === name);
  if (TEXTISH_INPUT_NAMES.has(name)) return !spec || spec.type === "STRING";
  return spec?.type === "STRING";
}

function firstTextInput(node, objectInfo) {
  for (const name of ["text", "prompt", "value", "string", "content", "caption", "instruction"]) {
    if (isTextInput(node, name, objectInfo)) return name;
  }
  return null;
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

// SetNode/GetNode 是 ComfyUI 前端虚拟节点，按名称共享值，不进入 API 图。
function setGetName(node) {
  const named = node?.widgets_values_named;
  if (isPlainObject(named)) {
    for (const key of ["name", "variable", "value", "text"]) {
      if (typeof named[key] === "string" && named[key].trim()) return named[key].trim();
    }
    const first = Object.values(named).find((value) => typeof value === "string" && value.trim());
    if (first) return first.trim();
  }
  const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
  return typeof values[0] === "string" ? values[0].trim() : "";
}

// 按连线把 UI 工作流切成互不相连的子流程（SetNode/GetNode 同名也算相连）。
// 只有「含输出节点且输出节点有输入连线」的分量才是候选；默认选正常节点最多的那个，即主流程。
export function detectFlowComponents(ui) {
  const nodes = (ui.nodes || []).filter((node) => !isUiOnlyNode(node) && !NOTE_TYPES.has(node.type));
  const parent = new Map(nodes.map((node) => [String(node.id), String(node.id)]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  const links = normalizeLinks(ui.links);
  for (const node of nodes) {
    for (const input of node.inputs || []) {
      if (input.link === null || input.link === undefined) continue;
      const link = links.get(String(input.link));
      if (link) union(String(node.id), link.from);
    }
  }
  const named = new Map();
  for (const node of nodes) {
    if (!isSetNode(node) && !isGetNode(node)) continue;
    const name = setGetName(node);
    if (!name) continue;
    if (named.has(name)) union(String(node.id), named.get(name));
    else named.set(name, String(node.id));
  }
  const groups = new Map();
  for (const node of nodes) {
    const root = find(String(node.id));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }
  const list = [...groups.values()]
    .map((members) => {
      const outputs = members.filter((node) => (isImageOutputClass(String(node.type)) || isVideoOutputClass(String(node.type))) && (node.inputs || []).some((input) => input.link !== null && input.link !== undefined));
      const active = members.filter((node) => ![MUTE_MODE, BYPASS_MODE].includes(Number(node.mode || 0))).length;
      const nodeIds = members.map((node) => String(node.id));
      return { id: `flow:${[...nodeIds].sort((a, b) => Number(a) - Number(b))[0]}`, nodeIds, outputs: outputs.map((node) => String(node.id)), active };
    })
    .filter((item) => item.outputs.length)
    .sort((a, b) => b.active - a.active || b.nodeIds.length - a.nodeIds.length);
  const uiGroups = (ui.groups || []).filter((group) => Array.isArray(group.bounding));
  const nodeById = new Map((ui.nodes || []).map((node) => [String(node.id), node]));
  const labelOf = (item, index) => {
    let best = null;
    for (const group of uiGroups) {
      const [x, y, w, h] = group.bounding;
      const count = item.nodeIds.filter((id) => {
        const pos = nodeById.get(id)?.pos;
        return Array.isArray(pos) && pos[0] >= x && pos[1] >= y && pos[0] <= x + w && pos[1] <= y + h;
      }).length;
      if (count > 0 && (!best || count > best.count)) best = { title: String(group.title || ""), count };
    }
    if (best?.title) return best.title;
    const outputTitle = item.outputs.map((id) => String(nodeById.get(id)?.title || "").trim()).find(Boolean);
    if (outputTitle) return outputTitle;
    return index === 0 ? "主流程" : `流程 ${index + 1}`;
  };
  const labeled = list.map((item, index) => ({ ...item, main: index === 0, label: labelOf(item, index) }));
  const counts = new Map();
  for (const item of labeled) counts.set(item.label, (counts.get(item.label) || 0) + 1);
  const used = new Map();
  return labeled.map((item) => {
    if (counts.get(item.label) === 1) return item;
    const count = (used.get(item.label) || 0) + 1;
    used.set(item.label, count);
    return count === 1 ? item : { ...item, label: `${item.label} · ${count}` };
  });
}

// 页 id 不能直接用“最小节点 id”：源文件删掉那个节点后 id 就变了，前端 pages 和已存参数会全部对不上。
// 这里按输出节点签名、主流程标记、标签和节点重叠把旧 id 继承下来；新页才分配 flow:<min>。
export function stabilizeFlowIds(flows, previous = []) {
  const prev = (Array.isArray(previous) ? previous : []).filter((item) => item && item.id);
  const nodeIdsOf = (item) => (Array.isArray(item?.nodeIds) ? item.nodeIds : []).map(String);
  const outputsOf = (item) => (Array.isArray(item?.outputs) ? item.outputs : []).map(String);
  const signatureOf = (item) => outputsOf(item).sort((a, b) => Number(a) - Number(b)).join(",");
  const jaccard = (a, b) => {
    if (!a.length || !b.length) return 0;
    const left = new Set(a);
    const right = new Set(b);
    let common = 0;
    for (const id of left) if (right.has(id)) common += 1;
    return common / (left.size + right.size - common);
  };
  const used = new Set();
  const pages = flows.map((flow, index) => {
    const signature = signatureOf(flow);
    const nodeIds = nodeIdsOf(flow);
    const label = String(flow.label || "");
    const candidates = prev.filter((item) => !used.has(item.id));
    let match = candidates.find((item) => item.signature && item.signature === signature);
    if (!match && flow.main) match = candidates.find((item) => item.main);
    if (!match && label && !/^(主流程|流程 \d+)$/.test(label)) {
      const byLabel = candidates.filter((item) => String(item.label || "") === label);
      if (byLabel.length === 1) match = byLabel[0];
    }
    if (!match) {
      const scored = candidates
        .map((item) => ({ item, score: jaccard(nodeIds, nodeIdsOf(item)) }))
        .sort((a, b) => b.score - a.score);
      if (scored[0]?.score >= 0.5) match = scored[0].item;
    }
    let id = match?.id;
    if (!id) {
      const base = `flow:${[...nodeIds].sort((a, b) => Number(a) - Number(b))[0]}`;
      id = used.has(base) ? `${base}:${index + 1}` : base;
    }
    used.add(id);
    return { ...flow, internalId: flow.id, id };
  });
  const currentIds = new Set(pages.map((flow) => flow.id));
  const activePages = pages.map((flow) => ({
    id: flow.id,
    signature: signatureOf(flow),
    label: String(flow.label || ""),
    outputs: outputsOf(flow),
    nodeIds: nodeIdsOf(flow),
    main: Boolean(flow.main),
    active: true,
  }));
  const inactive = prev
    .filter((item) => !currentIds.has(item.id))
    .map((item) => ({ ...item, active: false }));
  return { flows: pages, pageIds: [...activePages, ...inactive].slice(0, 80) };
}

// rgthree「Fast Groups Bypasser/Muter」按 matchTitle 一键开关整个分组；被它管理的分组就是可选阶段。
// 分组成员只按节点左上角是否落在分组框内判断，拿不准的不收。
export function detectBypassGroups(ui) {
  const titles = new Set((ui.nodes || []).filter((node) => /fast.*groups.*(bypasser|muter)/i.test(String(node.type || ""))).map((node) => String(node.properties?.matchTitle || "")).filter(Boolean));
  return (ui.groups || []).filter((group) => titles.has(String(group.title))).map((group) => {
    const [x, y, w, h] = group.bounding || [];
    const nodeIds = (ui.nodes || []).filter((node) => Array.isArray(node.pos) && node.pos[0] >= x && node.pos[1] >= y && node.pos[0] <= x + w && node.pos[1] <= y + h).map((node) => String(node.id));
    const idSet = new Set(nodeIds);
    const work = (ui.nodes || []).filter((node) => idSet.has(String(node.id)) && !isUiOnlyNode(node) && !NOTE_TYPES.has(node.type) && node.type !== PRIMITIVE_TYPE && node.type !== REROUTE_TYPE && !isSetNode(node) && !isGetNode(node) && !isValueNode(node));
    const classes = work.map((node) => String(node.type));
    const off = work.length > 0 && work.every((node) => [MUTE_MODE, BYPASS_MODE].includes(Number(node.mode || 0)));
    // 组内自带 LoadImage/LoadVideo 的是独立分支，不是主流程的可选阶段；拿不准就不推。
    const standalone = classes.some((type) => /^Load(Image|Video)/i.test(type));
    return { title: String(group.title), nodeIds, classes, optional: off && !standalone };
  });
}

export function convertUiWorkflow(ui, objectInfo = {}, options = {}) {
  ui = flattenSubgraphs(ui);
  if (!isUiWorkflow(ui)) throw new Error("不是 ComfyUI UI 工作流（需要 nodes + links）");
  if (Array.isArray(ui.definitions?.subgraphs) && ui.definitions.subgraphs.length) {
    throw new Error("暂不支持包含 Subgraph 的工作流；请在 ComfyUI 里展开子图后保存，或导出 API 格式");
  }
  if ((ui.nodes || []).some((node) => /^workflow>|^Subgraph/i.test(String(node.type || "")))) {
    throw new Error("暂不支持子图/组节点工作流；请展开后保存，或导出 API 格式");
  }

  // 被启用的分组：组内旁路/静音节点按正常节点转换（只有阶段开关打开时才传入）。
  const forced = new Set(options.enableGroups?.length ? detectBypassGroups(ui).filter((group) => options.enableGroups.includes(group.title)).flatMap((group) => group.nodeIds) : []);
  // 整合流：只转换所选子流程（默认主流程）；只有一个候选时不过滤，行为不变。
  const flows = detectFlowComponents(ui);
  const chosenFlow = flows.find((flow) => flow.id === options.flowId) || flows.find((flow) => flow.main);
  const keepFlow = flows.length > 1 && chosenFlow ? new Set(chosenFlow.nodeIds) : null;
  // 用户明确指定、但输出节点整体旁路/静音的子流程：按启用处理，否则只会剩下零星的启用节点。
  // 不能只看 active===0：残留一个启用节点（如孤立的 LoRA）时同样转不出可用图。
  const flowNodeById = new Map((ui.nodes || []).map((node) => [String(node.id), node]));
  const outputOff = (id) => [MUTE_MODE, BYPASS_MODE].includes(Number(flowNodeById.get(id)?.mode || 0));
  const enableChosen = new Set(options.flowId && chosenFlow?.id === options.flowId && chosenFlow.outputs.length && chosenFlow.outputs.every(outputOff) ? chosenFlow.nodeIds : []);
  const nodes = new Map((ui.nodes || []).filter((node) => !keepFlow || keepFlow.has(String(node.id))).map((node) => [String(node.id), forced.has(String(node.id)) || enableChosen.has(String(node.id)) ? { ...node, mode: 0 } : node]));
  const links = normalizeLinks(ui.links);
  const warnings = [];
  const setNodesByName = new Map();
  for (const node of nodes.values()) {
    if (!isSetNode(node)) continue;
    const name = setGetName(node);
    if (!name) continue;
    if (!setNodesByName.has(name)) setNodesByName.set(name, node);
  }

  function resolveEndpoint(nodeId, slot, seen = new Set()) {
    const key = `${nodeId}:${slot}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const node = nodes.get(nodeId);
    if (!node) return undefined;
    if (node.type === PRIMITIVE_TYPE) return { value: primitiveValue(node) };
    if (isValueNode(node)) return { value: valueNodeValue(node) };
    if (node.type === REROUTE_TYPE) {
      const linked = (node.inputs || []).find((input) => input.link !== null && input.link !== undefined);
      return linked ? resolveLink(linked.link, seen) : undefined;
    }
    if (isGetNode(node) || isSetNode(node)) {
      const mode = Number(node.mode || 0);
      if (mode === MUTE_MODE) return undefined;
      let source = node;
      if (isGetNode(node)) {
        if (mode === BYPASS_MODE) return undefined;
        const name = setGetName(node);
        source = setNodesByName.get(name);
        if (!source) return undefined;
        if (Number(source.mode || 0) === MUTE_MODE) return undefined;
      }
      const linked = (source.inputs || []).find((input) => input.link !== null && input.link !== undefined);
      return linked ? resolveLink(linked.link, seen) : undefined;
    }
    const mode = Number(node.mode || 0);
    if (mode === MUTE_MODE) return undefined;
    if (mode === BYPASS_MODE) {
      const outputType = node.outputs?.[slot]?.type;
      const candidates = (node.inputs || []).filter((input) => input.type === outputType && input.link !== null && input.link !== undefined);
      const linked = candidates[0];
      if (linked) return resolveLink(linked.link, seen);
      const widget = (node.inputs || []).find((input) => input.type === outputType && input.widget && node.widgets_values_named?.[input.name] !== undefined);
      if (widget) return { value: node.widgets_values_named[widget.name] };
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
    if (NOTE_TYPES.has(node.type) || node.type === REROUTE_TYPE || node.type === PRIMITIVE_TYPE || isSetNode(node) || isGetNode(node) || isValueNode(node)) continue;
    const mode = Number(node.mode || 0);
    if (mode === MUTE_MODE || mode === BYPASS_MODE) continue;
    if (isUiOnlyNode(node)) continue;
    const specs = inputSpecs(objectInfo, node.type);
    if (!specs.length) {
      // object_info 里没有的节点不能直接丢掉；保留 class_type 和能映射的连线/控件，
      // 让 ComfyUI 在生成时给出权威错误，而不是在导入阶段伪造“缺少自定义节点”。
      const unknownInputs = {};
      const setUnknown = (name, resolved) => {
        if (!name || resolved === undefined) return;
        if (resolved.value !== undefined) unknownInputs[name] = resolved.value;
        else if (resolved.link) unknownInputs[name] = resolved.link;
      };
      for (const uiInput of node.inputs || []) {
        if (uiInput.link === null || uiInput.link === undefined) continue;
        const resolved = resolveLink(uiInput.link);
        if (resolved === undefined) continue;
        setUnknown(uiInput.name, resolved);
      }
      const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null;
      if (named) {
        for (const [name, value] of Object.entries(named)) {
          if (value !== undefined && !(name in unknownInputs)) unknownInputs[name] = value;
        }
      } else if (Array.isArray(node.widgets_values) && node.widgets_values.length) {
        const widgetNames = (node.inputs || []).filter((input) => input.widget).map((input) => input.widget?.name || input.name);
        // 未知节点无法校验：只有控件名数量与值数量完全一致时才按位置映射，否则不猜，只保留连线。
        if (widgetNames.length === node.widgets_values.length) {
          node.widgets_values.forEach((value, index) => {
            const name = widgetNames[index];
            if (!name || name in unknownInputs || name === "control_after_generate" || name === "upload") return;
            unknownInputs[name] = value;
          });
        }
      }
      workflow[nodeId] = {
        class_type: node.type,
        inputs: unknownInputs,
        ...(node.title || node._meta?.title ? { _meta: { title: node.title || node._meta.title } } : {}),
      };
      continue;
    }
    const specByName = new Map(specs.map((spec) => [spec.name, spec]));
    const uiInputs = new Map((node.inputs || []).map((input) => [input.name, input]));
    const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null;
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const inputOrder = WIDGET_ORDER[node.type] || (node.inputs || []).filter((input) => input.widget).map((input) => input.widget.name);
    const baseOrder = inputOrder.length ? inputOrder : specs.filter((spec) => isWidgetType(spec.type)).map((spec) => spec.name);

    const inputs = {};
    const setResolved = (name, resolved) => {
      if (resolved === undefined) return;
      if (resolved.value !== undefined) inputs[name] = resolved.value;
      else if (resolved.link) inputs[name] = resolved.link;
    };

    for (const uiInput of node.inputs || []) {
      if (uiInput.link === null || uiInput.link === undefined) continue;
      const resolved = resolveLink(uiInput.link);
      if (resolved === undefined) continue;
      setResolved(uiInput.name, resolved);
    }

    if (named) {
      for (const [name, value] of Object.entries(named)) {
        if (value === undefined || name in inputs) continue;
        if (!specByName.has(name) && !uiInputs.has(name)) continue;
        // widgets_values_named 里的键就是控件值；GHCOLOR 等自定义控件不在标准控件类型里，
        // 但 object_info 仍把它们列为必需输入，丢掉会导致 ComfyUI 报 Required input is missing。
        if (isInputLink(value) || name === "upload" || name === "control_after_generate") continue;
        inputs[name] = normalizeComboValue(specByName.get(name), value);
      }
    } else {
      // 多候选对齐：先试「seed 后补 control_after_generate」的顺序，再试原顺序；
      // 用 object_info 校验，优先选全部合法的对齐顺序；都不合法时仍按最接近的顺序保留原值，
      // 交给 ComfyUI/静态体检报错，避免把用户的模型名/控件值静默丢掉。
      const orders = [];
      if (!baseOrder.includes("control_after_generate") && values.length > baseOrder.length) {
        const expanded = [];
        for (const name of baseOrder) {
          expanded.push(name);
          if (name === "seed" || name === "noise_seed") expanded.push("control_after_generate");
        }
        orders.push(expanded);
      }
      orders.push(baseOrder);
      let applied = false;
      let fallback = null;
      for (const order of orders) {
        const pending = [];
        order.forEach((name, index) => {
          if (!name || name === "control_after_generate" || name === "upload" || name in inputs) return;
          const spec = specByName.get(name);
          if (!spec || !isWidgetType(spec.type)) return;
          if (index >= values.length) return;
          pending.push([name, normalizeComboValue(spec, values[index])]);
        });
        if (!pending.length) continue;
        const validCount = pending.filter(([name, value]) => specValueValid(objectInfo, node.type, specByName.get(name), value)).length;
        if (validCount === pending.length) {
          for (const [name, value] of pending) inputs[name] = value;
          applied = true;
          break;
        }
        if (!fallback || validCount > fallback.validCount) fallback = { pending, validCount };
      }
      if (!applied && fallback) {
        for (const [name, value] of fallback.pending) inputs[name] = value;
      }
    }

    // Some custom nodes keep prompt/width/height only in widget values, not in node.inputs.
    for (const spec of specs) {
      if (spec.name in inputs || !isWidgetType(spec.type)) continue;
      if (named && spec.name in named) inputs[spec.name] = normalizeComboValue(spec, named[spec.name]);
    }

    workflow[nodeId] = {
      class_type: node.type,
      inputs,
      ...(node.title || node._meta?.title ? { _meta: { title: node.title || node._meta.title } } : {}),
    };
  }

  if (!Object.keys(workflow).length) throw new Error("转换后没有可执行节点");
  return { workflow, warnings };
}

// ComfyUI 0.4.x Subgraph：定义在 definitions.subgraphs，外层用一个 type=子图 id 的实例节点，
// 边界由 inputNode/outputNode(-10/-20) 虚拟节点连线。展开成普通 UI 图后再走转换、分页与阶段识别。
export function flattenSubgraphs(ui, depth = 0) {
  const defs = new Map((ui.definitions?.subgraphs || []).map((def) => [String(def.id), def]));
  if (!defs.size || depth > 8) return ui;
  const parseLink = (raw) =>
    Array.isArray(raw)
      ? { id: raw[0], from: raw[1], fromSlot: raw[2], to: raw[3], toSlot: raw[4], type: raw[5] }
      : { id: raw?.id, from: raw?.origin_id, fromSlot: raw?.origin_slot, to: raw?.target_id, toSlot: raw?.target_slot, type: raw?.type };
  const linkById = new Map();
  const collect = (links) => {
    for (const raw of links || []) {
      const link = parseLink(raw);
      if (link.id === undefined || link.id === null) continue;
      linkById.set(String(link.id), link);
    }
  };
  collect(ui.links);
  for (const def of defs.values()) collect(def.links);

  const outNodes = [];
  const connectors = [];
  const widgetBindings = [];
  const instances = new Map();

  const renameScope = (node, prefix) => {
    if (!prefix || (!isSetNode(node) && !isGetNode(node))) return;
    const name = setGetName(node);
    if (!name || name.startsWith(prefix)) return;
    const next = prefix + name;
    if (isPlainObject(node.widgets_values_named)) {
      for (const key of ["name", "variable", "value", "text"]) {
        if (typeof node.widgets_values_named[key] === "string") node.widgets_values_named[key] = next;
      }
    }
    if (Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === "string") node.widgets_values[0] = next;
  };

  const expand = (scopeNodes, prefix) => {
    for (const raw of scopeNodes || []) {
      const id = prefix + String(raw.id);
      const type = String(raw.type || "");
      const clone = {
        ...raw,
        id,
        inputs: (raw.inputs || []).map((input) => ({ ...input })),
        outputs: (raw.outputs || []).map((output) => ({ ...output })),
        widgets_values_named: isPlainObject(raw.widgets_values_named) ? { ...raw.widgets_values_named } : raw.widgets_values_named,
        widgets_values: Array.isArray(raw.widgets_values) ? [...raw.widgets_values] : raw.widgets_values,
      };
      renameScope(clone, prefix);
      outNodes.push(clone);
      const def = defs.get(type);
      if (!def) continue;
      const innerPrefix = id + ":";
      const instance = { node: clone, outputMap: new Map() };
      instances.set(id, instance);
      const inputIndexOfLink = new Map();
      (def.inputs || []).forEach((input, index) => {
        for (const linkId of input.linkIds || []) inputIndexOfLink.set(String(linkId), index);
      });
      expand(def.nodes || [], innerPrefix);
      const inId = String(def.inputNode?.id ?? -10);
      const outId = String(def.outputNode?.id ?? -20);
      for (const rawLink of def.links || []) {
        const link = parseLink(rawLink);
        if (link.id === undefined || link.id === null) continue;
        if (String(link.from) === inId) {
          connectors.push({ fromInput: { instanceId: id, index: inputIndexOfLink.get(String(link.id)) ?? Number(link.fromSlot) }, to: { id: innerPrefix + String(link.to), slot: Number(link.toSlot) }, type: link.type });
        } else if (String(link.to) === outId) {
          instance.outputMap.set(Number(link.toSlot), { id: innerPrefix + String(link.from), slot: Number(link.fromSlot) });
        } else {
          connectors.push({ from: { id: innerPrefix + String(link.from), slot: Number(link.fromSlot) }, to: { id: innerPrefix + String(link.to), slot: Number(link.toSlot) }, type: link.type });
        }
      }
    }
  };
  expand(ui.nodes || [], "");

  for (const raw of ui.links || []) {
    const link = parseLink(raw);
    if (link.id === undefined || link.id === null) continue;
    // 外→实例输入的连线由边界处理，其他照常保留。
    if (instances.has(String(link.to))) continue;
    connectors.push({ from: { id: String(link.from), slot: Number(link.fromSlot) }, to: { id: String(link.to), slot: Number(link.toSlot) }, type: link.type });
  }

  const resolve = (ref) => {
    let current = ref;
    for (let guard = 0; guard < 32 && instances.has(current.id); guard += 1) {
      const next = instances.get(current.id).outputMap.get(current.slot);
      if (!next) return null;
      current = next;
    }
    return instances.has(current.id) ? null : current;
  };
  const widgetSlots = (node) => {
    const slots = [];
    (node.inputs || []).forEach((input, index) => {
      if (input.widget) slots.push(index);
    });
    return slots;
  };

  let linkSeq = 0;
  const links = [];
  for (const connector of connectors) {
    if (connector.fromInput) {
      const instance = instances.get(connector.fromInput.instanceId);
      const input = instance?.node.inputs?.[connector.fromInput.index];
      if (!input) continue;
      if (input.link === null || input.link === undefined) {
        widgetBindings.push({ instanceId: connector.fromInput.instanceId, index: connector.fromInput.index, to: connector.to });
        continue;
      }
      const outer = linkById.get(String(input.link));
      if (!outer) continue;
      const from = resolve({ id: String(outer.from), slot: Number(outer.fromSlot) });
      if (!from) continue;
      links.push({ id: `sg_${++linkSeq}`, from: from.id, fromSlot: from.slot, to: connector.to.id, toSlot: connector.to.slot, type: connector.type });
      continue;
    }
    const from = resolve(connector.from);
    if (!from) continue;
    links.push({ id: `sg_${++linkSeq}`, from: from.id, fromSlot: from.slot, to: connector.to.id, toSlot: connector.to.slot, type: connector.type });
  }

  const kept = outNodes.filter((node) => !instances.has(node.id));
  const nodeById = new Map(kept.map((node) => [node.id, node]));
  for (const binding of widgetBindings) {
    const instance = instances.get(binding.instanceId);
    const position = widgetSlots(instance.node).indexOf(binding.index);
    const value = position >= 0 && Array.isArray(instance.node.widgets_values) ? instance.node.widgets_values[position] : undefined;
    if (value === undefined) continue;
    const target = nodeById.get(binding.to.id);
    if (!target) continue;
    const targetPosition = widgetSlots(target).indexOf(binding.to.slot);
    if (targetPosition < 0) continue;
    if (!Array.isArray(target.widgets_values)) target.widgets_values = [];
    target.widgets_values[targetPosition] = value;
  }

  const byTarget = new Map();
  for (const link of links) byTarget.set(`${link.to}\u0000${link.toSlot}`, link.id);
  for (const node of kept) {
    (node.inputs || []).forEach((input, index) => {
      input.link = byTarget.get(`${node.id}\u0000${index}`) ?? null;
    });
  }
  return { ...ui, nodes: kept, links: links.map((link) => [link.id, link.from, link.fromSlot, link.to, link.toSlot, link.type]), definitions: undefined };
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

// ComfyUI 会校验提交上来的每一个节点；游离节点（没连到任何输出）照样会被校验，
// 里面引用了缺失的模型/节点就会让整次生成失败。执行前只保留输出节点能到达的子图。
// roots 由当前页的 outputs 显式传入：多个输出全部保留（各自的闭包取并集）。
export function pruneUnreachableNodes(workflow, { roots: requestedRoots } = {}) {
  const entries = listNodes(workflow);
  if (!entries.length) return workflow || {};
  const validRoots = Array.isArray(requestedRoots) ? requestedRoots.map(String).filter((id) => workflow?.[id]) : [];
  const autoRoots = entries
    .filter(([, node]) => /save|preview|output|combine/i.test(String(node?.class_type || "")))
    .map(([id]) => id);
  const roots = validRoots.length ? validRoots : autoRoots;
  if (!roots.length) return workflow;
  const keep = new Set();
  for (const root of roots) {
    for (const id of reachableNodes(workflow, [root])) keep.add(id);
  }
  if (!keep.size || keep.size === entries.length) return workflow;
  const next = {};
  for (const [id, node] of entries) {
    if (keep.has(id)) next[id] = node;
  }
  return next;
}

// 静态体检：不提交 /prompt，只按 object_info 检查节点类型、下拉值、必需连线。
// UI-only / Note / Set-Get / 滑块 / Fast Groups / Label rgthree 不参与执行，不报问题。
const PROBLEM_IGNORED_TYPES = /^(Note|MarkdownNote|Reroute|PrimitiveNode|SetNode|GetNode|easy setNode|easy getNode|GoohaiUniversalSlider|Label\b|Fast Groups\b|Image ?Compare|ImageAndMaskPreview|PreviewImage|easy showAnything|Get ?Image ?Size)/i;
const PROBLEM_DYNAMIC_INPUT = /^COMFY_AUTOGROW/i;
const PROBLEM_UPLOAD_NODE = /^Load(Image|Video|Audio|Mask)/i;

export function detectWorkflowProblems(workflow, objectInfo = {}) {
  const problems = [];
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const classType = String(node?.class_type || "");
    if (!classType || PROBLEM_IGNORED_TYPES.test(classType)) continue;
    const info = objectInfo?.[classType];
    const title = String(node?._meta?.title || info?.display_name || classType);
    if (!info?.input) {
      problems.push({ node: String(nodeId), title, input: "", reason: "节点类型不在 object_info（缺少自定义节点）" });
      continue;
    }
    const uploadNode = PROBLEM_UPLOAD_NODE.test(classType);
    for (const spec of inputSpecs(objectInfo, classType)) {
      const value = node?.inputs?.[spec.name];
      const type = normalizeType(spec.type);
      if (type === "COMBO") {
        if (uploadNode || value === undefined || isInputLink(value)) continue;
        const options = comboOptions(objectInfo, classType, spec.name).map(String);
        if (!options.length) {
          problems.push({ node: String(nodeId), title, input: spec.name, reason: "允许列表为空" });
        } else if (!options.includes(String(value))) {
          problems.push({ node: String(nodeId), title, input: spec.name, reason: `当前值「${value}」不在允许列表` });
        }
        continue;
      }
      if (!spec.required || PROBLEM_DYNAMIC_INPUT.test(type) || value !== undefined) continue;
      if (isWidgetType(type) && spec.opts?.default !== undefined) continue;
      problems.push({
        node: String(nodeId),
        title,
        input: spec.name,
        reason: isWidgetType(type) ? "必需输入未连线且无默认值" : spec.opts?.default !== undefined ? "必需输入缺失（自定义控件）" : "必需输入未连线且无默认值",
      });
    }
  }
  return problems;
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
  const positiveReach = reachableNodes(
    workflow,
    samplers.map(([, node]) => linkTarget(node.inputs?.positive)).filter(Boolean),
  );
  const negativeReach = reachableNodes(
    workflow,
    samplers.map(([, node]) => linkTarget(node.inputs?.negative)).filter(Boolean),
  );

  // 暴露所有可写文本输入；正/负极性只用于排序和默认主提示词，不再单独猜一个。
  const textInputs = [];
  for (const [id, node] of entries) {
    if (!reachable.has(id)) continue;
    for (const input of Object.keys(node.inputs || {})) {
      if (!isTextInput(node, input, objectInfo)) continue;
      const role =
        positiveReach.has(id) && !negativeReach.has(id)
          ? "positive"
          : negativeReach.has(id) && !positiveReach.has(id)
            ? "negative"
            : positiveReach.has(id) && negativeReach.has(id)
              ? "shared"
              : "unknown";
      textInputs.push({
        node: id,
        input,
        title: String(node._meta?.title || "").trim(),
        default: String(node.inputs[input]),
        role,
      });
    }
  }
  const roleRank = { positive: 0, unknown: 1, shared: 1, negative: 2 };
  textInputs.sort((a, b) => (roleRank[a.role] ?? 1) - (roleRank[b.role] ?? 1) || Number(a.node) - Number(b.node) || a.input.localeCompare(b.input));
  const titleCounts = new Map();
  for (const item of textInputs) if (item.title) titleCounts.set(item.title, (titleCounts.get(item.title) || 0) + 1);
  textInputs.forEach((item, index) => {
    const base = item.title || `文本框 ${index + 1}`;
    item.label = item.title && titleCounts.get(item.title) > 1 ? `${base} · #${item.node}` : base;
  });

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
    const textName = firstTextInput(node, objectInfo);
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
      // 只从 negative 可达、且不从 positive 可达的节点不能当正向提示词。
      if (negativeReach.has(id) && !positiveReach.has(id)) continue;
      const textName = firstTextInput(node, objectInfo);
      if (textName) promptCandidates.push({ node: id, input: textName, distance: 99, title: node._meta?.title || node.class_type });
    }
  }
  promptCandidates.sort((a, b) => a.distance - b.distance || Number(a.node) - Number(b.node));
  if (promptCandidates.length) {
    prompt = { node: promptCandidates[0].node, input: promptCandidates[0].input };
  } else if (textInputs.length) {
    const fallback = textInputs.find((item) => item.role === "positive") || textInputs.find((item) => item.role !== "negative") || textInputs[0];
    prompt = { node: fallback.node, input: fallback.input };
    warnings.push("没有找到明确的正向提示词链，已默认使用第一个文本框。");
  } else {
    warnings.push("没有找到可写的文本输入，卡片将不显示提示词框");
  }
  if (textInputs.length > 1) {
    const primary = textInputs.find((item) => prompt && item.node === prompt.node && item.input === prompt.input);
    warnings.push(`检测到 ${textInputs.length} 个文本输入，已全部显示；默认主提示词为「${primary?.label || textInputs[0].label}」。`);
  }

  // 蒙版输入：LoadImage 类节点接到 MASK 型输入（含三方节点如 EasySizeSimpleImage.遮罩），
  // 或 LoadImageMask 本身。这些节点不再算参考图。
  const maskNodes = new Set();
  for (const [id, node] of entries) {
    if (!reachable.has(id)) continue;
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (!isInputLink(value)) continue;
      if (String(inputTypeOf(objectInfo, node.class_type, name)).toUpperCase() !== "MASK") continue;
      const source = workflow[String(value[0])];
      if (source && /^LoadImage/.test(String(source.class_type || ""))) maskNodes.add(String(value[0]));
    }
  }
  for (const [id, node] of entries) {
    if (reachable.has(id) && /^LoadImageMask/.test(String(node.class_type || "")) && typeof node.inputs?.image === "string") maskNodes.add(id);
  }
  const masks = entries
    .filter(([id]) => maskNodes.has(id))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, node]) => ({ node: id, input: "image", title: node._meta?.title || node.class_type }));

  const images = entries
    .filter(([id, node]) => reachable.has(id) && /^LoadImage/.test(node.class_type) && typeof node.inputs?.image === "string" && !maskNodes.has(id))
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
    textInputs,
    images,
    masks,
    maskMode: masks.length ? "separate" : null,
    sizes,
    ratios,
    batches,
    seeds,
    stages: detectOptionalStages(workflow, objectInfo),
    warnings,
  };
}

// 识别"可整体旁路"的后处理阶段（超分/精修等）：从输出节点向上走 IMAGE 通道，
// 收集连续的非核心 IMAGE→IMAGE 节点。边界靠类型/图结构，类名只用于起标签，兼容自制节点。
function inputTypeOf(objectInfo, classType, name) {
  const info = objectInfo?.[classType]?.input;
  const spec = info?.required?.[name] ?? info?.optional?.[name];
  if (!spec) return "";
  const t = Array.isArray(spec) ? spec[0] : spec?.type;
  return Array.isArray(t) ? "COMBO" : String(t || "");
}
function outputTypesOf(objectInfo, classType) {
  return (objectInfo?.[classType]?.output || []).map(String);
}
const CORE_STAGE_CLASSES = /KSampler|SamplerCustom|SelfLift|VAEDecode|VAEEncode|LoadImage|LoadVideo|EmptyLatent|CLIPTextEncode|Loader|Checkpoint|ModelSampling|Conditioning|SaveImage|PreviewImage|SaveVideo|VHS_|ControlNet|SetLatent|Rebatch|JoinImage|ImageBatch/i;

export function detectOptionalStages(workflow, objectInfo = {}) {
  const stages = [];
  const seen = new Set();
  const entries = Object.entries(workflow || {});
  const imageInputOf = (node) => {
    for (const [name, value] of Object.entries(node?.inputs || {})) {
      const t = inputTypeOf(objectInfo, node.class_type, name);
      if (isInputLink(value) && (t === "IMAGE" || t === "*")) return { name, link: value };
    }
    return null;
  };
  for (const [outId, outNode] of entries) {
    if (!/SaveImage|PreviewImage/i.test(outNode?.class_type || "")) continue;
    const outImage = Object.entries(outNode.inputs || {}).find(([name, value]) => isInputLink(value) && inputTypeOf(objectInfo, outNode.class_type, name) === "IMAGE");
    if (!outImage) continue;
    let producerId = String(outImage[1][0]);
    const chain = [];
    const guard = new Set();
    while (producerId && !guard.has(producerId)) {
      guard.add(producerId);
      const node = workflow[producerId];
      if (!node || CORE_STAGE_CLASSES.test(node.class_type || "")) break;
      const outs = outputTypesOf(objectInfo, node.class_type);
      if (!outs.includes("IMAGE") && !outs.includes("*")) break;
      const imgIn = imageInputOf(node);
      if (!imgIn) break;
      chain.push({ id: producerId, node });
      producerId = String(imgIn.link[0]);
    }
    if (!chain.length) continue;
    const chainIds = new Set(chain.map((c) => c.id));
    const shared = entries.some(([nodeId, other]) => nodeId !== outId && !chainIds.has(nodeId) && Object.values(other?.inputs || {}).some((value) => isInputLink(value) && chainIds.has(String(value[0]))));
    if (shared) continue;
    chain.reverse();
    const first = chain[0];
    const entryLink = imageInputOf(first.node).link;
    const id = chain.map((c) => c.id).join("-");
    if (seen.has(id)) continue;
    seen.add(id);
    const classes = chain.map((c) => c.node.class_type).join(" ");
    const label = /upscale/i.test(classes) ? "超分 / 精修" : /refine|detail|face/i.test(classes) ? "精修" : "后处理";
    stages.push({
      id,
      label,
      nodes: chain.map((c) => c.id),
      entryLink,
      exit: { node: outId, input: outImage[0] },
    });
  }
  return stages;
}

export function bindingSummary(bindings) {
  const ratioBindings = bindings.ratios || [];
  const aspectRatios = [...new Set(ratioBindings.flatMap((binding) => binding.ratios || []))];
  const aspectRatio = canonicalAspectRatio(ratioBindings[0]?.value) || aspectRatios[0] || null;
  const textInputs = (bindings.textInputs || []).map((item) => ({
    node: String(item.node),
    input: String(item.input),
    label: String(item.label || item.title || "文本框"),
    default: String(item.default ?? ""),
    role: String(item.role || "unknown"),
  }));
  const primaryInput = bindings.prompt
    ? textInputs.find((item) => item.node === String(bindings.prompt.node) && item.input === String(bindings.prompt.input))
    : null;
  const primaryText = bindings.prompt
    ? {
        node: String(bindings.prompt.node),
        input: String(bindings.prompt.input),
        label: primaryInput?.label || "提示词",
      }
    : null;
  return {
    outputType: bindings.outputType || null,
    prompt: Boolean(bindings.prompt),
    primaryText,
    textInputs,
    imageInputs: bindings.images?.length || 0,
    maskInputs: bindings.masks?.length || 0,
    maskMode: bindings.masks?.length ? (bindings.maskMode || "separate") : null,
    size: bindings.sizes?.[0] ? { width: bindings.sizes[0].width, height: bindings.sizes[0].height } : null,
    aspectRatio,
    aspectRatios,
    count: bindings.batches?.[0]?.default ?? null,
    hasSeed: Boolean(bindings.seeds?.length),
    seed: Number(bindings.seeds?.[0]?.default) > 0 ? String(bindings.seeds[0].default) : null,
    stages: [
      ...(bindings.stages || []).map((s) => ({ id: s.id, label: s.label, nodes: s.nodes })),
      ...(bindings.groupStages || []).map((s) => ({ id: s.id, label: s.label, nodes: [], defaultOff: true })),
    ],
    flows: (bindings.flows || []).map((flow) => {
      const pageTexts = (flow.textInputs || []).map((item) => ({
        node: String(item.node),
        input: String(item.input),
        label: String(item.label || item.title || "文本框"),
        default: String(item.default ?? ""),
        role: String(item.role || "unknown"),
      }));
      const pagePrimary = flow.primaryText
        ? {
            node: String(flow.primaryText.node),
            input: String(flow.primaryText.input),
            label: pageTexts.find((item) => item.node === String(flow.primaryText.node) && item.input === String(flow.primaryText.input))?.label || "提示词",
          }
        : null;
      return { id: flow.id, label: flow.label, nodeIds: flow.nodeIds, outputs: flow.outputs, main: flow.main, maskInputs: flow.maskInputs || 0, stages: flow.stages || [], problems: flow.problems || [], textInputs: pageTexts, primaryText: pagePrimary };
    }),
    problems: bindings.problems || [],
    warnings: bindings.warnings || [],
  };
}
