import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { isApiWorkflow, isUiWorkflow } from "./registry.js";
import { bindingSummary, canonicalAspectRatio, convertUiWorkflow, detectFreeBindings } from "./ui-workflow.js";
import { deepClone, nowIso, randomId, writeJsonAtomic } from "./util.js";

const FILE_NAME = "free-workflows.json";
const SOURCE_CACHE_MS = 60 * 1000;
const OBJECT_INFO_MS = 30 * 1000;

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

export function applyFreeInputs(workflow, bindings, { prompt, texts = [], uploadedImages = [], size, count, seed, seedFixed, ratio } = {}) {
  const next = deepClone(workflow || {});
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
  if (bindings.prompt && !textWrites.has(`${bindings.prompt.node}\u0000${bindings.prompt.input}`)) {
    const node = next[bindings.prompt.node];
    if (node?.inputs) node.inputs[bindings.prompt.input] = String(prompt || "");
  }
  (bindings.images || []).forEach((binding, index) => {
    const uploaded = uploadedImages[index];
    const value = imageValue(uploaded);
    const node = next[binding.node];
    if (value !== undefined && node?.inputs) node.inputs[binding.input] = value;
  });
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
  return next;
}

export function createFreeWorkflowStore({ dataDir, comfyWorkflowsDir = "", comfy, logger, maxWorkflowBytes = 5 * 1024 * 1024 } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const entries = new Map();
  const sourceCache = new Map();
  let objectInfoCache = null;
  let objectInfoAt = 0;
  let persistQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      for (const entry of raw.workflows || []) {
        if (entry?.id && entry.workflow && entry.bindings) entries.set(entry.id, entry);
      }
    } catch {
      // First run.
    }
  }

  function persist() {
    const payload = { version: 1, updatedAt: nowIso(), workflows: [...entries.values()] };
    persistQueue = persistQueue.then(() => writeJsonAtomic(file, payload)).catch((error) => logger?.warn?.(`保存自由卡片失败：${error.message}`));
    return persistQueue;
  }

  function rootDir() {
    return comfyWorkflowsDir ? path.resolve(comfyWorkflowsDir) : "";
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
    if (!force && objectInfoCache && Date.now() - objectInfoAt < OBJECT_INFO_MS) return objectInfoCache;
    objectInfoCache = await comfy.objectInfo();
    objectInfoAt = Date.now();
    return objectInfoCache;
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
    if (isApiWorkflow(parsed)) return { workflow: parsed, format: "api", signature: sourceSignature(stat), sourcePath };
    if (isUiWorkflow(parsed)) {
      const objectInfo = await getObjectInfo();
      const converted = convertUiWorkflow(parsed, objectInfo);
      return { workflow: converted.workflow, format: "ui", signature: sourceSignature(stat), sourcePath, warnings: converted.warnings };
    }
    throw new Error("不是 ComfyUI UI 或 API 工作流");
  }

  async function readRawWorkflow(entry) {
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
    if (isApiWorkflow(parsed)) return { workflow: parsed, format: "api", sourceRel: entry.sourceRel, name: entry.name };
    if (isUiWorkflow(parsed)) return { workflow: parsed, format: "ui", sourceRel: entry.sourceRel, name: entry.name };
    throw new Error("不是 ComfyUI UI 或 API 工作流");
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

  async function sync(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error("自由卡片不存在");
    const state = await sourceState(entry);
    if (!state.exists) throw new Error("源工作流文件已不存在，可能已在 ComfyUI 中删除");
    if (!state.changed) return { changed: false, entry };
    const source = await readSource(entry.sourceRel);
    const bindings = detectFreeBindings(source.workflow, await getObjectInfo());
    entry.workflow = source.workflow;
    entry.bindings = bindings;
    entry.warnings = [...(source.warnings || []), ...(bindings.warnings || [])];
    entry.sourceFormat = source.format;
    entry.sourceSignature = source.signature;
    entry.sourceUpdatedAt = nowIso();
    entry.updatedAt = nowIso();
    await persist();
    return { changed: true, entry };
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
    sourceCache.delete(key);
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
    if (!entry || Array.isArray(entry.bindings?.textInputs)) return entry;
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
      ...bindingSummary(entry.bindings || {}),
      warnings: entry.warnings || [],
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

  return { load, listSources, importSource, sync, setArchived, get, remove, rename, publicEntry, list, applyFreeInputs, readRawWorkflow, sourceState, ensureBindings };
}
