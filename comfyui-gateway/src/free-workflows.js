import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { bindingSummary, buildWorkflowGraph, canonicalAspectRatio, convertUiWorkflow, detectBypassGroups, detectFlowComponents, detectFreeBindings, detectOptionalStages, detectWorkflowProblems, flattenSubgraphs, isInputLink, pruneUnreachableNodes, stabilizeFlowIds } from "./ui-workflow.js";
import { deepClone, nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "free-workflows.json";
const SOURCE_CACHE_MS = 60 * 1000;
// object_info 有 13MB+，ComfyUI 忙时一次要几十秒。生成路径只做图和绑定的解析，
// 用过期缓存足够；缓存过期时后台刷新，绝不在这里等到新副本。
const OBJECT_INFO_MS = 5 * 60 * 1000;
const RESOLVED_CACHE_MAX = 64;

function sourceSignature(stat) {
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

function imageValue(uploaded) {
  if (!uploaded) return undefined;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

// ComfyUI 会校验提交图里的每一个加载器；空参考槽（LoadImage 的 image 还是 "None"）
// 会让整次生成失败，即使这路参考没填。提交前把空加载器摘掉并断开下游连线。
const MEDIA_LOADER_INPUTS = {
  LoadImage: "image",
  LoadImageMask: "image",
  LoadImageOutput: "image",
  VHS_LoadImagePath: "image",
  LoadVideo: "file",
  VHS_LoadVideo: "video",
  LoadAudio: "audio",
  VHS_LoadAudio: "audio",
};

function isEmptyMediaValue(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return false;
  const text = String(value).trim().toLowerCase();
  return !text || text === "none" || text === "undefined" || text === "null";
}

function stripEmptyMediaLoaders(workflow) {
  const removed = new Set();
  for (const [id, node] of Object.entries(workflow)) {
    const input = MEDIA_LOADER_INPUTS[node?.class_type];
    if (!input || !isEmptyMediaValue(node?.inputs?.[input])) continue;
    removed.add(String(id));
  }
  if (!removed.size) return workflow;
  for (const id of removed) delete workflow[id];
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node?.inputs || {})) {
      if (Array.isArray(value) && removed.has(String(value[0]))) delete node.inputs[key];
    }
  }
  return workflow;
}

export function applyFreeInputs(workflow, bindings, { prompt, texts = [], uploadedImages = [], maskImage, size, count, seed, seedFixed, ratio, bypassStages = [], keepOutputs, primaryText } = {}) {
  const next = deepClone(pruneUnreachableNodes(workflow, { roots: keepOutputs }) || {});
  // 整体旁路可选阶段（超分/精修）：把阶段出口接到入口上游，再删阶段节点。
  for (const stageId of Array.isArray(bypassStages) ? bypassStages : []) {
    const stage = (bindings.stages || []).find((s) => s.id === stageId);
    if (!stage || !next[stage.exit.node]?.inputs) continue;
    next[stage.exit.node].inputs[stage.exit.input] = stage.entryLink;
    for (const nodeId of stage.nodes) delete next[nodeId];
  }
  // 只允许写回扫描时识别出的文本输入，避免通过接口改到模型名/文件名等字段。
  const allowed = new Set((bindings.textInputs || []).map((item) => `${item.node}\u0000${item.input}`));
  const textWrites = new Map();
  for (const item of Array.isArray(texts) ? texts : []) {
    const key = `${item?.node}\u0000${item?.input}`;
    if (!allowed.has(key)) continue;
    textWrites.set(key, String(item?.value ?? ""));
  }
  for (const [key, value] of textWrites) {
    const [nodeId, input] = key.split("\u0000");
    const node = next[nodeId];
    if (node?.inputs) node.inputs[input] = value;
  }
  const promptBinding = primaryText?.node !== undefined && primaryText?.input ? { node: String(primaryText.node), input: String(primaryText.input) } : bindings.prompt;
  if (promptBinding && !textWrites.has(`${promptBinding.node}\u0000${promptBinding.input}`)) {
    const node = next[promptBinding.node];
    if (node?.inputs) node.inputs[promptBinding.input] = String(prompt || "");
  }
  (bindings.images || []).forEach((binding, index) => {
    const uploaded = uploadedImages[index];
    const value = imageValue(uploaded);
    const node = next[binding.node];
    if (value !== undefined && node?.inputs) node.inputs[binding.input] = value;
  });
  if (maskImage) {
    const value = imageValue(maskImage);
    const binding = (bindings.masks || [])[0];
    const node = binding ? next[binding.node] : null;
    if (value !== undefined && node?.inputs) node.inputs[binding.input] = value;
  }
  if (size?.width && size?.height) {
    for (const binding of bindings.sizes || []) {
      const node = next[binding.node];
      if (!node?.inputs) continue;
      node.inputs[binding.widthInput] = size.width;
      node.inputs[binding.heightInput] = size.height;
    }
  }
  const wantedRatio = canonicalAspectRatio(ratio);
  if (wantedRatio) {
    for (const binding of bindings.ratios || []) {
      const node = next[binding.node];
      if (!node?.inputs) continue;
      const options = binding.options || [];
      const match = options.find((option) => canonicalAspectRatio(option) === wantedRatio);
      if (match) node.inputs[binding.input] = match;
    }
  }
  const normalizedCount = Math.max(1, Math.min(15, Math.floor(Number(count) || 1)));
  for (const binding of bindings.batches || []) {
    const node = next[binding.node];
    if (node?.inputs) node.inputs[binding.input] = normalizedCount;
  }
  if (bindings.seeds?.length) {
    const fixed = String(seedFixed ?? "") === "true" && Number(seed) > 0;
    const value = fixed ? Math.floor(Number(seed)) : randomSeed();
    for (const binding of bindings.seeds) {
      const node = next[binding.node];
      if (node?.inputs) node.inputs[binding.input] = value;
    }
  }
  return pruneUnreachableNodes(stripEmptyMediaLoaders(next), { roots: keepOutputs }) || next;
}

const FIELD_TYPES = new Set(["number", "select", "boolean", "string"]);

export function normalizeFreeFields(list) {
  return (Array.isArray(list) ? list : []).map(normalizeField).filter(Boolean).slice(0, 200);
}

function normalizeField(raw) {
  if (!raw || typeof raw !== "object") return null;
  const node = String(raw.node || "").trim();
  const input = String(raw.input || "").trim();
  if (!node || !input) return null;
  const type = FIELD_TYPES.has(String(raw.type)) ? String(raw.type) : "string";
  const value = raw.value === undefined || raw.value === null ? "" : raw.value;
  const field = {
    key: String(raw.key || `f_${node}_${input}`).trim().slice(0, 160),
    node,
    input,
    label: String(raw.label || input).trim().slice(0, 80),
    group: String(raw.group || "参数").trim().slice(0, 80),
    type,
    value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "",
    options: Array.isArray(raw.options) ? raw.options.map(String).slice(0, 200) : [],
  };
  for (const key of ["min", "max", "step"]) {
    if (Number.isFinite(Number(raw[key]))) field[key] = Number(raw[key]);
  }
  return field;
}

export function applyFreeFields(workflow, fields, values) {
  const next = deepClone(workflow);
  const source = values && typeof values === "object" ? values : {};
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field?.node || !field?.input) continue;
    const node = next[field.node];
    if (!node?.inputs || !(field.input in node.inputs) || isInputLink(node.inputs[field.input])) continue;
    if (!Object.prototype.hasOwnProperty.call(source, field.key)) continue;
    let value = source[field.key];
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      value = number;
    } else if (field.type === "boolean") {
      value = Boolean(value);
    } else if (field.type === "string") {
      value = String(value ?? "");
    } else if (field.type === "select" && Array.isArray(field.options) && field.options.length && field.options.every((option) => Number.isFinite(Number(option)))) {
      value = Number(value);
    }
    node.inputs[field.input] = value;
  }
  return next;
}

export function createFreeWorkflowStore({ dataDir, comfyWorkflowsDir = "", getComfyWorkflowsDir, comfy, logger, maxWorkflowBytes = 5 * 1024 * 1024 } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const entries = new Map();
  const sourceCache = new Map();
  let objectInfoCache = null;
  let objectInfoAt = 0;
  let objectInfoRefreshing = null;
  const resolvedCache = new Map();
  let persistQueue = Promise.resolve();
  let loadWarning = "";
  let loadCorrupt = false;

  async function load() {
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      loadWarning = `读取自由卡片库失败：${error.message}`;
      logger?.error?.(loadWarning);
      return;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      loadCorrupt = true;
      const backup = `${file}.corrupt-${Date.now()}.json`;
      try {
        await fsp.writeFile(backup, text, "utf8");
      } catch (writeError) {
        logger?.error?.(`备份损坏的自由卡片库失败：${writeError.message}`);
      }
      loadWarning = `自由卡片库 JSON 损坏，已备份到 ${backup}`;
      logger?.error?.(loadWarning);
      return;
    }
    for (const entry of raw.workflows || []) {
      if (!entry?.id) continue;
      entries.set(entry.id, entry);
      if (!entry.workflow || !entry.bindings) logger?.warn?.(`自由卡片条目数据不完整 ${entry.id}`);
    }
  }

  async function backupBeforeWrite() {
    if (loadCorrupt) return;
    try {
      await fsp.copyFile(file, `${file}.bak`);
    } catch (error) {
      if (error.code !== "ENOENT") logger?.warn?.(`备份自由卡片库失败：${error.message}`);
    }
  }

  function persist() {
    const payload = { version: 1, updatedAt: nowIso(), workflows: [...entries.values()] };
    const run = persistQueue.catch(() => {}).then(async () => {
      await backupBeforeWrite();
      await writeJsonAtomic(file, payload);
    });
    persistQueue = run.catch(() => {});
    return run.catch((error) => {
      logger?.warn?.(`保存自由卡片失败：${error.message}`);
      throw error;
    });
  }

  function rootDir() {
    const currentDir = typeof getComfyWorkflowsDir === "function" ? getComfyWorkflowsDir() : comfyWorkflowsDir;
    return currentDir ? path.resolve(currentDir) : "";
  }

  function resolveSource(relative) {
    const root = rootDir();
    if (!root) throw new Error("网关没有配置 ComfyUI 工作流目录");
    const value = String(relative || "").replace(/\\/g, "/").trim();
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) throw new Error("工作流路径不合法");
    const resolved = path.resolve(root, value);
    if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) throw new Error("工作流路径不合法");
    return resolved;
  }

  async function getObjectInfo(force = false) {
    const fresh = objectInfoCache && Date.now() - objectInfoAt < OBJECT_INFO_MS;
    if (!force && fresh) return objectInfoCache;
    if (!objectInfoRefreshing) {
      objectInfoRefreshing = comfy.objectInfo()
        .then((info) => {
          objectInfoCache = info;
          objectInfoAt = Date.now();
          return info;
        })
        .catch((error) => {
          if (!objectInfoCache) throw error;
          logger?.warn?.(`ComfyUI object_info 刷新失败，沿用缓存：${error.message}`);
          return objectInfoCache;
        })
        .finally(() => {
          objectInfoRefreshing = null;
        });
    }
    if (!force && objectInfoCache) {
      void objectInfoRefreshing.catch(() => {});
      return objectInfoCache;
    }
    return objectInfoRefreshing;
  }

  async function readSource(relative) {
    const sourcePath = resolveSource(relative);
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) throw new Error("工作流不是文件");
    if (stat.size > maxWorkflowBytes) throw new Error("工作流文件过大");
    const text = (await fsp.readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("工作流 JSON 无法解析");
    }
    if (isApiWorkflow(parsed)) {
      let problems = [];
      try {
        problems = detectWorkflowProblems(parsed, await getObjectInfo());
      } catch {
        // ComfyUI 离线时仍按 best-effort 导入，恢复在线后由重扫补齐体检。
      }
      return { workflow: parsed, format: "api", signature: sourceSignature(stat), sourcePath, problems };
    }
    if (isUiWorkflow(parsed)) {
      const objectInfo = await getObjectInfo();
      const converted = convertUiWorkflow(parsed, objectInfo);
      const flat = flattenSubgraphs(parsed);
      const flows = detectFlowComponents(flat);
      const allGroups = detectBypassGroups(flat).filter((group) => group.optional);
      const groupStagesFor = (flow) => allGroups.filter((group) => flows.length < 2 || group.nodeIds.some((id) => flow.nodeIds.includes(id))).map((group) => ({ id: "group:" + group.title, label: group.title, nodes: [], defaultOff: true }));
      const flowList = (list) => list.map((flow) => {
        let imageStages = [];
        let maskInputs = 0;
        let problems = [];
        let textInputs = [];
        let primaryText = null;
        try {
          const flowWorkflow = flow.main ? converted.workflow : convertUiWorkflow(parsed, objectInfo, { flowId: flow.id }).workflow;
          imageStages = detectOptionalStages(flowWorkflow, objectInfo).map((stage) => ({ id: stage.id, label: stage.label, nodes: stage.nodes }));
          const flowBindings = detectFreeBindings(flowWorkflow, objectInfo);
          maskInputs = (flowBindings.masks || []).length;
          textInputs = flowBindings.textInputs || [];
          primaryText = flowBindings.prompt || null;
          problems = detectWorkflowProblems(flowWorkflow, objectInfo);
        } catch {
          imageStages = [];
        }
        return { id: flow.id, label: flow.label, nodeIds: flow.nodeIds, outputs: flow.outputs, main: flow.main, maskInputs, textInputs, primaryText, stages: [...imageStages, ...groupStagesFor(flow)], problems };
      });
      const mainFlow = flows.length > 1 ? flows.find((flow) => flow.main) : null;
      const mainIds = mainFlow ? new Set(mainFlow.nodeIds) : null;
      const groupStages = detectBypassGroups(parsed)
        .filter((group) => group.optional && (!mainIds || group.nodeIds.some((id) => mainIds.has(id))))
        .map((group) => ({ id: "group:" + group.title, label: group.title, title: group.title }));
      return {
        workflow: converted.workflow,
        format: "ui",
        signature: sourceSignature(stat),
        sourcePath,
        warnings: converted.warnings,
        problems: detectWorkflowProblems(converted.workflow, objectInfo),
        groupStages,
        flows: flows.length > 1 ? flowList(flows) : [],
      };
    }
    throw new Error("不是 ComfyUI UI 或 API 工作流");
  }

  async function readRawWorkflow(entry) {
    if (entry?.snapshot && entry.snapshotWorkflow) {
      return { workflow: entry.snapshotWorkflow, format: entry.snapshotFormat || entry.sourceFormat, sourceRel: entry.sourceRel, name: entry.name, signature: entry.sourceSignature || "" };
    }
    const sourcePath = resolveSource(entry.sourceRel);
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) throw new Error("工作流不是文件");
    if (stat.size > maxWorkflowBytes) throw new Error("工作流文件过大");
    const text = (await fsp.readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("工作流 JSON 无法解析");
    }
    if (isApiWorkflow(parsed)) return { workflow: parsed, format: "api", sourceRel: entry.sourceRel, name: entry.name, signature: sourceSignature(stat) };
    if (isUiWorkflow(parsed)) return { workflow: parsed, format: "ui", sourceRel: entry.sourceRel, name: entry.name, signature: sourceSignature(stat) };
    throw new Error("不是 ComfyUI UI 或 API 工作流");
  }

  // 启用被旁路器管理的分组：重新读取 UI 源文件按所选分组转换；任何一步失败都退回已存的 API 图。
  async function workflowWithGroups(entry, groupIds, flowId = "") {
    const titles = (Array.isArray(groupIds) ? groupIds : []).map((id) => String(id).replace(/^group:/, ""));
    if ((!titles.length && !flowId) || entry.sourceFormat !== "ui") return entry.workflow;
    try {
      const raw = await readRawWorkflow(entry);
      if (raw.format !== "ui") return entry.workflow;
      return convertUiWorkflow(raw.workflow, await getObjectInfo(), { enableGroups: titles, flowId: String(flowId || "") }).workflow;
    } catch (error) {
      logger?.warn?.(`按分组重新转换失败 ${entry.id}: ${error.message}`);
      return entry.workflow;
    }
  }

  function pageChangedError() {
    const error = new Error("所选工作流页已变化，请重新选择页签后再生成");
    error.status = 409;
    error.code = "free_workflow_page_changed";
    return error;
  }

  function mainOutputs(entry) {
    const flows = Array.isArray(entry?.bindings?.flows) ? entry.bindings.flows : [];
    const main = flows.find((flow) => flow.main);
    return Array.isArray(main?.outputs) ? main.outputs.map(String) : [];
  }

  function seedPageIds(entry) {
    if (!Array.isArray(entry.pageIds)) {
      const signature = (flow) => (Array.isArray(flow?.outputs) ? flow.outputs : []).map(String).sort((a, b) => Number(a) - Number(b)).join(",");
      entry.pageIds = (Array.isArray(entry.bindings?.flows) ? entry.bindings.flows : []).map((flow) => ({
        id: flow.id,
        signature: signature(flow),
        label: String(flow.label || ""),
        outputs: (Array.isArray(flow.outputs) ? flow.outputs : []).map(String),
        nodeIds: (Array.isArray(flow.nodeIds) ? flow.nodeIds : []).map(String),
        main: Boolean(flow.main),
        active: true,
      }));
    }
    return entry.pageIds;
  }

  // 整合流分页：按所选页（flowId）和启用的分组重新转换；非主页重新识别绑定。
  // 页 id 由 stabilizeFlowIds 继承，源结构变化后找不到所选页会明确报错，不再静默跑主流程。
  async function resolveFlow(entry, groupIds, flowId = "") {
    const wanted = String(flowId || "");
    const titles = (Array.isArray(groupIds) ? groupIds : []).map((id) => String(id).replace(/^group:/, ""));
    const fallback = { workflow: entry.workflow, bindings: entry.bindings, page: "", outputs: mainOutputs(entry) };
    if (!titles.length && !wanted) return fallback;
    if (entry.sourceFormat !== "ui") {
      if (wanted) throw pageChangedError();
      return fallback;
    }
    try {
      const raw = await readRawWorkflow(entry);
      if (raw.format !== "ui") {
        if (wanted) throw pageChangedError();
        return fallback;
      }
      // 页/分组转换依赖源文件与选择项；同一组合只转一次，重复生成直接复用。
      const cacheKey = [entry.id, raw.signature || entry.sourceSignature || "", wanted, [...titles].sort().join("|")].join("\u0000");
      const cached = resolvedCache.get(cacheKey);
      if (cached) return cached;
      const objectInfo = await getObjectInfo();
      const stable = stabilizeFlowIds(detectFlowComponents(flattenSubgraphs(raw.workflow)), seedPageIds(entry));
      entry.pageIds = stable.pageIds;
      const selected = wanted ? stable.flows.find((flow) => flow.id === wanted) : stable.flows.find((flow) => flow.main);
      if (wanted && !selected) throw pageChangedError();
      const page = selected && !selected.main ? selected.id : "";
      const workflow = convertUiWorkflow(raw.workflow, objectInfo, { enableGroups: titles, flowId: selected?.internalId || "" }).workflow;
      const resolved = { workflow, bindings: detectFreeBindings(workflow, objectInfo), page, outputs: selected?.outputs?.map(String) || mainOutputs(entry) };
      if (resolvedCache.size >= RESOLVED_CACHE_MAX) resolvedCache.delete(resolvedCache.keys().next().value);
      resolvedCache.set(cacheKey, resolved);
      return resolved;
    } catch (error) {
      logger?.warn?.(`按页重新转换失败 ${entry.id}: ${error.message}`);
      if (wanted) {
        if (error.status) throw error;
        throw new Error(`切换的工作流页无法读取：${error.message}`);
      }
      return fallback;
    }
  }

  async function graph(entry, flowId = "") {
    let uiWorkflow = null;
    const warnings = [...(entry.warnings || [])];
    if (entry.sourceFormat === "ui") {
      try {
        const raw = await readRawWorkflow(entry);
        if (raw.format === "ui") uiWorkflow = raw.workflow;
      } catch (error) {
        warnings.push(`读取节点布局失败：${error.message}`);
      }
    }
    let objectInfo = null;
    try {
      objectInfo = await getObjectInfo();
    } catch {
      // 节点标题/选项回退到 class_type 和当前值。
    }
    const workflow = flowId ? (await resolveFlow(entry, [], flowId)).workflow : entry.workflow;
    return {
      id: entry.id,
      name: entry.name,
      sourceFormat: entry.sourceFormat,
      ...buildWorkflowGraph(workflow, uiWorkflow ? flattenSubgraphs(uiWorkflow) : null, objectInfo || {}),
      params: entry.params || [],
      warnings: [...new Set(warnings)],
      problems: objectInfo && Object.keys(objectInfo).length ? detectWorkflowProblems(workflow, objectInfo) : [],
    };
  }

  async function setParams(id, params) {
    const entry = entries.get(String(id || "").trim());
    if (!entry) {
      const error = new Error("自由卡片不存在");
      error.status = 404;
      error.code = "free_workflow_not_found";
      throw error;
    }
    entry.params = (Array.isArray(params) ? params : []).map(normalizeField).filter(Boolean).slice(0, 200);
    entry.updatedAt = nowIso();
    await persist();
    return entry;
  }

  async function scanDir(dir, root, out) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await scanDir(full, root, out);
        continue;
      }
      if (!item.isFile() || !item.name.toLowerCase().endsWith(".json")) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.size > maxWorkflowBytes) continue;
      const signature = sourceSignature(stat);
      const cached = sourceCache.get(full);
      if (cached?.signature === signature) {
        out.push({ ...cached.info, updatedAt: new Date(stat.mtimeMs).toISOString() });
        continue;
      }
      let format = "invalid";
      try {
        const parsed = JSON.parse((await fsp.readFile(full, "utf8")).replace(/^\uFEFF/, ""));
        if (isApiWorkflow(parsed)) format = "api";
        else if (isUiWorkflow(parsed)) format = "ui";
      } catch {
        // Keep invalid; the UI can show it as unavailable.
      }
      const info = {
        id: relative,
        name: path.basename(item.name, ".json"),
        folder: path.dirname(relative) === "." ? "" : path.dirname(relative),
        relative,
        format,
      };
      sourceCache.set(full, { signature, info });
      out.push({ ...info, updatedAt: new Date(stat.mtimeMs).toISOString() });
    }
  }

  async function listSources() {
    const root = rootDir();
    if (!root) return [];
    const out = [];
    await scanDir(root, root, out);
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.relative.localeCompare(b.relative));
  }

  async function sourceState(entry) {
    if (entry?.snapshot) return { exists: true, changed: false };
    try {
      const stat = await fsp.stat(resolveSource(entry.sourceRel));
      return { exists: stat.isFile(), changed: sourceSignature(stat) !== entry.sourceSignature };
    } catch {
      return { exists: false, changed: true };
    }
  }

  async function importSource(relative) {
    const source = await readSource(relative);
    const bindings = detectFreeBindings(source.workflow, await getObjectInfo());
    bindings.groupStages = source.groupStages || [];
    const stable = stabilizeFlowIds(source.flows || [], []);
    bindings.flows = stable.flows;
    bindings.problems = source.problems || [];
    const warnings = [...(source.warnings || []), ...(bindings.warnings || [])];
    const stat = await fsp.stat(source.sourcePath);
    const entry = {
      id: randomId("free_"),
      name: path.basename(relative).replace(/\.json$/i, ""),
      sourceRel: String(relative).replace(/\\/g, "/"),
      sourceFormat: source.format,
      sourceSignature: source.signature,
      sourceUpdatedAt: new Date(stat.mtimeMs).toISOString(),
      workflow: source.workflow,
      bindings,
      pageIds: stable.pageIds,
      preset: null,
      warnings,
      archivedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    entries.set(entry.id, entry);
    await persist();
    logger?.info?.(`imported free workflow ${entry.name} (${source.format}, ${bindings.outputType || "unknown"}) ${entry.id}`);
    return entry;
  }

  async function sync(id, force = false) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    if (entry.snapshot) {
      const error = new Error("归档快照不随源工作流同步；需要更新请重新归档");
      error.status = 409;
      error.code = "free_workflow_snapshot_frozen";
      throw error;
    }
    const state = await sourceState(entry);
    if (!state.exists) throw new Error("源工作流文件已不存在，可能已在 ComfyUI 中删除");
    if (!state.changed && !force) return { changed: false, entry };
    const source = await readSource(entry.sourceRel);
    const bindings = detectFreeBindings(source.workflow, await getObjectInfo());
    bindings.groupStages = source.groupStages || [];
    const stable = stabilizeFlowIds(source.flows || [], seedPageIds(entry));
    bindings.flows = stable.flows;
    bindings.problems = source.problems || [];
    entry.workflow = source.workflow;
    entry.bindings = bindings;
    entry.pageIds = stable.pageIds;
    entry.warnings = [...(source.warnings || []), ...(bindings.warnings || [])];
    entry.sourceFormat = source.format;
    entry.sourceSignature = source.signature;
    entry.sourceUpdatedAt = nowIso();
    entry.updatedAt = nowIso();
    await persist();
    return { changed: true, entry };
  }

  async function createSnapshot(id, payload = {}) {
    const original = entries.get(String(id || "").trim());
    if (!original) {
      const error = new Error("自由卡片不存在");
      error.status = 404;
      error.code = "free_workflow_not_found";
      throw error;
    }
    const raw = await readRawWorkflow(original);
    const now = nowIso();
    const snapshot = {
      id: randomId("snap_"),
      name: String(payload.name || original.name || "").trim().slice(0, 80) || original.name,
      sourceRel: original.sourceRel,
      sourceFormat: raw.format,
      sourceSignature: original.sourceSignature,
      sourceUpdatedAt: original.sourceUpdatedAt,
      workflow: original.workflow,
      bindings: original.bindings,
      pageIds: Array.isArray(original.pageIds) ? original.pageIds : [],
      params: Array.isArray(payload.config?.params) ? payload.config.params : original.params || [],
      preset: original.preset || null,
      warnings: original.warnings || [],
      snapshot: true,
      frozen: true,
      snapshotOf: original.snapshotOf || original.id,
      snapshotAt: now,
      snapshotWorkflow: raw.workflow,
      snapshotFormat: raw.format,
      snapshotConfig: payload.config && typeof payload.config === "object" ? payload.config : null,
      snapshotCard: payload.card && typeof payload.card === "object" ? payload.card : null,
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    entries.set(snapshot.id, snapshot);
    await persist();
    logger?.info?.(`snapshot free workflow ${snapshot.name} (${snapshot.id}) from ${original.id}`);
    return snapshot;
  }

  function getSnapshot(id) {
    const entry = entries.get(String(id || "").trim());
    if (!entry?.snapshot) return null;
    return {
      id: entry.id,
      snapshotOf: entry.snapshotOf || null,
      snapshotAt: entry.snapshotAt || null,
      pageId: String(entry.snapshotConfig?.flowId || ""),
      config: entry.snapshotConfig || null,
      card: entry.snapshotCard || null,
    };
  }

  async function setArchived(id, archived, preset) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    entry.archivedAt = archived ? entry.archivedAt || nowIso() : null;
    if (preset && typeof preset === "object") {
      entry.preset = {
        size: typeof preset.size === "string" && preset.size.trim() ? preset.size.trim() : undefined,
        aspectRatio: canonicalAspectRatio(preset.aspectRatio) || undefined,
        count: Number.isFinite(Number(preset.count)) && Number(preset.count) >= 1 ? Math.floor(Number(preset.count)) : undefined,
        seed: preset.seed !== undefined && preset.seed !== null && String(preset.seed).trim() ? String(preset.seed).trim() : undefined,
        seedFixed: String(preset.seedFixed || "") === "true" ? "true" : "false",
      };
    }
    entry.updatedAt = nowIso();
    await persist();
    return entry;
  }

  function get(id) {
    return entries.get(id) || null;
  }

  async function remove(id) {
    const key = String(id || "").trim();
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    try {
      sourceCache.delete(resolveSource(entry.sourceRel));
    } catch {
      // 源文件配置缺失时没有缓存键可删。
    }
    await persist();
    return entry;
  }

  async function rename(id, name) {
    const entry = entries.get(String(id || "").trim());
    if (!entry) {
      const error = new Error("自由卡片不存在");
      error.status = 404;
      error.code = "free_workflow_not_found";
      throw error;
    }
    const next = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!next) {
      const error = new Error("名称不能为空");
      error.status = 400;
      error.code = "invalid_free_workflow_name";
      throw error;
    }
    if (entry.name !== next) {
      entry.name = next;
      entry.updatedAt = nowIso();
      await persist();
    }
    return entry;
  }

  // 旧卡片保存的是旧版 bindings（没有 textInputs），首次访问时重新识别并落盘。
  async function ensureBindings(entry) {
    if (!entry) return entry;
    let pageIdsAdded = false;
    if (!Array.isArray(entry.pageIds)) {
      seedPageIds(entry);
      pageIdsAdded = true;
    }
    if (!entry.workflow) return entry;
    if (Array.isArray(entry.bindings?.textInputs)) {
      if (pageIdsAdded) {
        entry.updatedAt = nowIso();
        try {
          await persist();
        } catch (error) {
          logger?.warn?.(`保存自由卡片页 id 失败 ${entry.id}: ${error.message}`);
        }
      }
      return entry;
    }
    try {
      const bindings = detectFreeBindings(entry.workflow, await getObjectInfo());
      entry.bindings = bindings;
      entry.warnings = [...new Set([...(entry.warnings || []), ...(bindings.warnings || [])])];
      entry.updatedAt = nowIso();
      await persist();
    } catch (error) {
      logger?.warn?.(`升级自由卡片文本输入失败 ${entry.id}: ${error.message}`);
    }
    return entry;
  }

  async function publicEntry(entry) {
    if (!entry) return null;
    await ensureBindings(entry);
    const source = await sourceState(entry);
    const warnings = [...(entry.warnings || [])];
    if (!entry.workflow || !entry.bindings) warnings.push("条目数据不完整，请重新导入或同步");
    const config = entry.snapshotConfig || null;
    const card = entry.snapshotCard || null;
    const pageId = String(config?.flowId || "");
    const pageFlow = Array.isArray(config?.flows) ? config.flows.find((flow) => flow.id === pageId) : null;
    const pageConfig = pageId ? config?.pages?.[pageId] : null;
    const textCandidates = pageFlow?.textInputs || config?.textInputs || [];
    const selectedKeys = pageConfig?.textSelection || config?.textSelection || [];
    const textNameMap = pageConfig?.textNames || config?.textNames || {};
    const textLabels = selectedKeys.map((key) => {
      const [node, input] = String(key).split("\u0000");
      const candidate = textCandidates.find((item) => String(item.node) === node && String(item.input) === input);
      return textNameMap[key] || candidate?.label || input || "文本输入";
    });
    if (!textLabels.length) {
      const primary = pageFlow?.primaryText || config?.primaryText;
      if (primary) textLabels.push(textNameMap[`${primary.node}\u0000${primary.input}`] || primary.label || "提示词");
    }
    const pageCount = Array.isArray(config?.flows) && config.flows.length ? config.flows.length : 1;
    const snapshotPageLabel = pageFlow?.label || config?.flowNames?.[pageId] || (pageId ? "流程" : "主流程");
    return {
      id: entry.id,
      name: entry.name,
      sourceRel: entry.sourceRel,
      sourceFormat: entry.sourceFormat,
      outputType: entry.bindings?.outputType || null,
      archived: Boolean(entry.archivedAt),
      archivedAt: entry.archivedAt || null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sourceChanged: source.changed,
      sourceMissing: !source.exists,
      preset: entry.preset || null,
      params: entry.params || [],
      invalid: !entry.workflow || !entry.bindings,
      snapshot: Boolean(entry.snapshot),
      snapshotOf: entry.snapshotOf || null,
      snapshotAt: entry.snapshotAt || null,
      snapshotPageId: pageId,
      snapshotPageLabel,
      pageCount,
      textLabels,
      snapshotCard: card,
      ...bindingSummary(entry.bindings || {}),
      warnings: [...new Set(warnings)],
    };
  }

  async function list({ archived } = {}) {
    const result = [];
    for (const entry of [...entries.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
      if (archived === true && !entry.archivedAt) continue;
      if (archived === false && entry.archivedAt) continue;
      result.push(await publicEntry(entry));
    }
    return result;
  }

  // 只监听已导入条目的源文件变化，不扫整个 workflows 目录；签名不变不会触发同步，
  // 同步成功后会更新 sourceSignature，因此不会形成“扫描→重写→再扫描”的循环。
  let watchTimer = null;
  let watchBusy = false;
  const pendingSync = new Map();

  async function pollSources(onSynced, debounceMs) {
    if (watchBusy) return;
    watchBusy = true;
    try {
      for (const entry of entries.values()) {
        if (!entry?.sourceRel || entry.snapshot) continue;
        const state = await sourceState(entry);
        if (!state.exists || !state.changed) continue;
        scheduleSourceSync(entry.id, onSynced, debounceMs);
      }
    } finally {
      watchBusy = false;
    }
  }

  function scheduleSourceSync(id, onSynced, debounceMs) {
    if (pendingSync.has(id)) return;
    const timer = setTimeout(async () => {
      pendingSync.delete(id);
      try {
        const result = await sync(id, true);
        if (result.changed) onSynced?.(result.entry);
      } catch (error) {
        logger?.warn?.(`自选工作流自动同步失败 ${id}: ${error.message}`);
      }
    }, Math.max(100, Number(debounceMs) || 1200));
    timer.unref?.();
    pendingSync.set(id, timer);
  }

  function startWatching({ intervalMs = 3000, debounceMs = 1200, onSynced } = {}) {
    if (watchTimer) return () => {};
    const tick = () => { void pollSources(onSynced, debounceMs); };
    watchTimer = setInterval(tick, Math.max(500, Number(intervalMs) || 3000));
    watchTimer.unref?.();
    tick();
    return () => {
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      for (const timer of pendingSync.values()) clearTimeout(timer);
      pendingSync.clear();
    };
  }

  // 只读体检：给 Agent 的 G3/G4 用，不提交 /prompt。
  async function health(entry, flowId = "") {
    await ensureBindings(entry);
    const wanted = String(flowId || "");
    let workflow = entry.workflow;
    let page = "";
    if (wanted) {
      const resolved = await resolveFlow(entry, [], wanted);
      workflow = resolved.workflow;
      page = resolved.page;
    }
    let objectInfo = {};
    let objectInfoReady = false;
    try {
      objectInfo = await getObjectInfo();
      objectInfoReady = Object.keys(objectInfo).length > 0;
    } catch {
      // ComfyUI 不可达时仍返回静态体检；objectInfoReady 交给调用方判断。
    }
    const problems = detectWorkflowProblems(workflow, objectInfo);
    const issues = problems.map((problem) => ({ node: String(problem.node || ""), title: String(problem.title || ""), input: String(problem.input || ""), reason: String(problem.reason || "") }));
    const missingNodes = [...new Set(issues.filter((issue) => /object_info|自定义节点/.test(issue.reason)).map((issue) => workflow?.[issue.node]?.class_type).filter(Boolean))];
    const missingModels = [];
    if (objectInfoReady) {
      for (const [nodeId, node] of Object.entries(workflow || {})) {
        const info = objectInfo[node.class_type];
        if (!info?.input) continue;
        const specs = { ...(info.input.required || {}), ...(info.input.optional || {}) };
        for (const [inputName, spec] of Object.entries(specs)) {
          if (/^(image|video|audio)$/i.test(inputName)) continue;
          const value = node.inputs?.[inputName];
          if (Array.isArray(value) || value === undefined || value === null || String(value) === "" || /^none$/i.test(String(value))) continue;
          const options = Array.isArray(spec?.[0]) ? spec[0] : Array.isArray(spec?.[1]?.options) ? spec[1].options : null;
          if (!options?.length) continue;
          if (!options.map(String).includes(String(value))) missingModels.push({ node: String(nodeId), input: inputName, value: String(value), classType: node.class_type, options: options.slice(0, 20) });
        }
      }
    }
    const reachableOutputs = [];
    for (const [nodeId, node] of Object.entries(workflow || {})) {
      if (!/save|preview|output|combine/i.test(String(node?.class_type || ""))) continue;
      if (!Object.values(node?.inputs || {}).some((value) => Array.isArray(value))) continue;
      reachableOutputs.push({ node: String(nodeId), title: String(node?._meta?.title || node?.class_type || ""), classType: String(node?.class_type || "") });
    }
    return { id: entry.id, flowId: page || wanted, objectInfoReady, issues, missingNodes, missingModels, reachableOutputs, warnings: entry.warnings || [] };
  }

  // G6 干跑：组装并校验请求体，不提交 ComfyUI。
  async function validate(entry, body = {}) {
    const errors = [];
    const texts = Array.isArray(body.texts)
      ? body.texts.map((item) => ({ node: String(item?.node || ""), input: String(item?.input || ""), value: String(item?.value ?? "") })).filter((item) => item.node && item.input)
      : [];
    const primaryText = body.primaryText && typeof body.primaryText === "object" && body.primaryText.node && body.primaryText.input
      ? { node: String(body.primaryText.node), input: String(body.primaryText.input) }
      : null;
    const flow = await resolveFlow(entry, Array.isArray(body.enableGroups) ? body.enableGroups.map(String) : [], String(body.flowId || ""));
    const prompt = String(body.prompt || "");
    const promptBinding = primaryText || flow.bindings?.prompt || null;
    const promptText = promptBinding ? texts.find((item) => item.node === promptBinding.node && item.input === promptBinding.input)?.value : undefined;
    const effectivePrompt = promptText !== undefined ? promptText : prompt;
    if (promptBinding && !String(effectivePrompt).trim()) errors.push({ node: promptBinding.node, input: promptBinding.input, reason: "需要正向提示词" });
    const allowed = new Set((flow.bindings?.textInputs || []).map((item) => `${item.node}\u0000${item.input}`));
    for (const item of texts) if (!allowed.has(`${item.node}\u0000${item.input}`)) errors.push({ node: item.node, input: item.input, reason: "文本输入不在工作流声明中" });
    const sizeMatch = /^(\d+)x(\d+)$/.exec(String(body.size || ""));
    const size = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : undefined;
    let workflow = null;
    try {
      workflow = applyFreeInputs(flow.workflow, flow.bindings, {
        prompt: effectivePrompt,
        texts,
        uploadedImages: Array.isArray(body.images) ? body.images.map((name) => ({ name: String(name) })) : [],
        size,
        count: body.count,
        seed: body.seed,
        seedFixed: body.seedFixed,
        ratio: body.ratio,
        keepOutputs: flow.outputs,
        primaryText: promptBinding,
      });
    } catch (error) {
      errors.push({ node: "", input: "", reason: error.message });
    }
    let objectInfo = {};
    try {
      objectInfo = await getObjectInfo();
    } catch {
      // 没有 object_info 时只做结构性校验。
    }
    if (workflow) {
      for (const [nodeId, node] of Object.entries(workflow)) {
        const info = objectInfo[node.class_type];
        if (!info) {
          errors.push({ node: String(nodeId), input: "", reason: `节点类型不在 object_info：${node.class_type}` });
          continue;
        }
        for (const [key, spec] of Object.entries(info.input?.required || {})) {
          if (key.includes(".") || /^(image|video|audio)$/i.test(key)) continue;
          if (node.inputs?.[key] !== undefined) continue;
          // COMFY_AUTOGROW 这类动态组在 API 图里是 values.a / values.b 展开的，不能按组名判缺。
          const dynamic = Array.isArray(spec) && String(spec[0] || "").startsWith("COMFY_AUTOGROW");
          const hasFlattened = Object.keys(node.inputs || {}).some((input) => input.startsWith(`${key}.`));
          if (dynamic || hasFlattened) continue;
          errors.push({ node: String(nodeId), input: key, reason: "缺少必填输入" });
        }
      }
    }
    const outputs = [];
    for (const [nodeId, node] of Object.entries(workflow || {})) {
      if (!/save|preview|output|combine/i.test(String(node?.class_type || ""))) continue;
      if (!Object.values(node?.inputs || {}).some((value) => Array.isArray(value))) continue;
      outputs.push({ node: String(nodeId), title: String(node?._meta?.title || node?.class_type || ""), classType: String(node?.class_type || "") });
    }
    if (!outputs.length) errors.push({ node: "", input: "", reason: "没有可达输出" });
    return {
      valid: errors.length === 0,
      errors,
      request: {
        entryId: entry.id,
        flowId: flow.page || String(body.flowId || ""),
        nodeCount: Object.keys(workflow || {}).length,
        outputs,
        prompt: String(effectivePrompt),
        texts,
        primaryText: promptBinding,
        size: String(body.size || ""),
        seed: body.seed ?? "",
        count: body.count ?? null,
        images: Array.isArray(body.images) ? body.images.map(String) : [],
      },
    };
  }

  return { load, listSources, importSource, sync, setArchived, createSnapshot, getSnapshot, get, remove, rename, publicEntry, list, applyFreeInputs, applyFreeFields, readRawWorkflow, workflowWithGroups, resolveFlow, sourceState, ensureBindings, graph, setParams, health, validate, startWatching, getLoadWarning: () => loadWarning };
}
