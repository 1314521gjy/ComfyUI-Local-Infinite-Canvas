import path from "node:path";

// 这些预览类节点默认按“过程预览”处理：只有在没有终态预览时才作为最后兜底。
const PROCESS_PREVIEW_CLASS = /ImageAndMaskPreview|MaskPreview|PreviewMask|PreviewBridge/i;

function mediaKind(file) {
  const mime = String(file?.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = path.extname(String(file?.filename || "")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv", ".avi"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".flac", ".ogg", ".m4a"].includes(ext)) return "audio";
  return "image";
}

function naturalIdCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function pixelArea(file) {
  const width = Number(file?.width);
  const height = Number(file?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width * height : null;
}

function groupByNode(files) {
  const byNode = new Map();
  for (const file of files) {
    const id = String(file.nodeId ?? "");
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(file);
  }
  return byNode;
}

function orderNodeIds(byNode, flowOutputs) {
  const order = [];
  const seen = new Set();
  for (const id of Array.isArray(flowOutputs) ? flowOutputs : []) {
    const key = String(id);
    if (byNode.has(key) && !seen.has(key)) {
      order.push(key);
      seen.add(key);
    }
  }
  for (const id of [...byNode.keys()].filter((key) => !seen.has(key)).sort(naturalIdCompare)) order.push(id);
  return order;
}

function outgoingNodeIds(workflow) {
  const outgoing = new Set();
  for (const node of Object.values(workflow || {})) {
    for (const value of Object.values(node?.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number")) {
        outgoing.add(String(value[0]));
      }
    }
  }
  return outgoing;
}

function nodeClass(workflow, nodeId) {
  return String(workflow?.[String(nodeId)]?.class_type || "");
}

// 多个 output 时只保留像素最高的一档；同像素并列全部保留。
// 完全读不到尺寸时按并列处理，避免误删唯一输出。
function selectHighestPixel(byNode, warnings) {
  const areas = new Map();
  for (const [id, files] of byNode) {
    const known = files.map(pixelArea).filter((area) => area !== null);
    areas.set(id, known.length ? Math.max(...known) : null);
  }
  const knownAreas = [...areas].filter(([, area]) => area !== null);
  if (!knownAreas.length) return new Set(byNode.keys());
  const highest = Math.max(...knownAreas.map(([, area]) => area));
  const keep = new Set(knownAreas.filter(([, area]) => area === highest).map(([id]) => id));
  const dropped = [...areas.keys()].filter((id) => !keep.has(id)).length;
  if (dropped) warnings.push(`已忽略 ${dropped} 个较低像素或无法比较的输出节点`);
  return keep;
}

// 自由卡出卡判据：
// 1) 有 type=output：按输出节点取像素最高的一档；同像素多个节点全部出卡；同一节点 batch 多条目全部展开。
// 2) 没有 output：只取终态预览（没有下游连线的节点）；中间预览不输出；多个终态预览全部出卡。
// 3) 没有终态预览时兜底过程预览；完全没有媒体则返回空，由调用方报错。
export function classifyFreeWorkflowOutputs(files, { flowOutputs = [], nodeTitles = {}, workflow = null } = {}) {
  const warnings = [];
  const normalized = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.filename) continue;
    let type = file.type;
    if (!type) {
      type = "output";
      warnings.push(`节点 ${file.nodeId || "?"} 的媒体 ${file.filename} 缺少 type，按 output 处理`);
    }
    if (type === "input") continue;
    if (type !== "output" && type !== "temp") {
      warnings.push(`节点 ${file.nodeId || "?"} 的媒体 ${file.filename} type=${type} 未识别，已跳过`);
      continue;
    }
    normalized.push({ ...file, type });
  }

  const outputFiles = normalized.filter((file) => file.type === "output");
  const previewFallback = !outputFiles.length && normalized.some((file) => file.type === "temp");
  let selected = outputFiles;

  if (previewFallback) {
    const tempFiles = normalized.filter((file) => file.type === "temp");
    const allByNode = groupByNode(tempFiles);
    if (allByNode.size) {
      const outgoing = outgoingNodeIds(workflow);
      let terminalIds = workflow ? [...allByNode.keys()].filter((id) => !outgoing.has(String(id))) : [...allByNode.keys()];
      const intermediate = allByNode.size - terminalIds.length;
      if (intermediate > 0) warnings.push(`已排除 ${intermediate} 个中间预览节点`);
      if (!terminalIds.length) {
        terminalIds = [...allByNode.keys()];
        warnings.push("没有找到终态预览节点，使用过程预览兜底");
      }
      const normalIds = terminalIds.filter((id) => !PROCESS_PREVIEW_CLASS.test(nodeClass(workflow, id)));
      if (normalIds.length) {
        const processPreview = terminalIds.length - normalIds.length;
        if (processPreview > 0) warnings.push(`已排除 ${processPreview} 个过程预览节点`);
        terminalIds = normalIds;
      } else if (terminalIds.length) {
        warnings.push("只找到过程预览节点，按兜底输出");
      }
      selected = terminalIds.flatMap((id) => allByNode.get(id));
    }
  }

  const byNode = groupByNode(selected);
  const keep = previewFallback ? new Set(byNode.keys()) : selectHighestPixel(byNode, warnings);
  const order = orderNodeIds(byNode, flowOutputs).filter((id) => keep.has(id));

  const outputs = order.map((id) => {
    const nodeFiles = byNode.get(id);
    return {
      nodeId: id,
      title: String(nodeTitles[id] || id),
      type: previewFallback ? "temp" : "output",
      preview: previewFallback,
      kind: mediaKind(nodeFiles[0]),
      files: nodeFiles,
    };
  });

  return {
    outputs,
    primaryNodeId: outputs.length ? outputs[0].nodeId : null,
    previewFallback,
    warnings: [...new Set(warnings)],
    selectedFiles: order.flatMap((id) => byNode.get(id)),
  };
}

export function freeWorkflowOutputOrder(entry, page = "") {
  const flows = Array.isArray(entry?.bindings?.flows) ? entry.bindings.flows : [];
  const wanted = String(page || "");
  const flow = flows.find((item) => item.id === wanted) || flows.find((item) => item.main) || null;
  return Array.isArray(flow?.outputs) ? flow.outputs.map(String) : [];
}

export function freeWorkflowNodeTitles(workflow) {
  const titles = {};
  for (const [id, node] of Object.entries(workflow || {})) {
    if (!node || typeof node !== "object") continue;
    titles[String(id)] = String(node._meta?.title || node.class_type || id);
  }
  return titles;
}
