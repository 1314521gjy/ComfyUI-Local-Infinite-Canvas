import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { deepClone, isPlainObject, nowIso, readJsonFile, slugify, truncate, writeJsonAtomic } from "./util.js";
import { decorateEntry, listModelDescriptors, resolveBaseModelVariant } from "./base-models.js";

const REGISTRY_FILE = "registry.json";
const TYPE_PREFIX = { image: "image", video: "video", audio: "audio", text: "text" };

export class RegistryError extends Error {
  constructor(message, { status = 400, code = "registry_error", details } = {}) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiWorkflow(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (!entries.length) return false;
  return entries.every(([, node]) => isPlainObject(node) && typeof node.class_type === "string" && isPlainObject(node.inputs));
}

export function isUiWorkflow(value) {
  return isPlainObject(value) && Array.isArray(value.nodes) && Array.isArray(value.links);
}

export function inferType(workflow, hint) {
  if (["image", "video", "audio", "text"].includes(hint)) return hint;
  const classes = Object.values(workflow || {}).map((node) => String(node?.class_type || ""));
  const joined = classes.join(" ");
  if (/SaveVideo|VHS_VideoCombine|SaveWebM|WanImageToVideo|WanFirstLastFrame|WanVace|MiniMaxH3|MinimaxH3|H3.*(?:Video|Ref)|VDN-H3/i.test(joined)) return "video";
  if (/SaveImage|KSampler|Empty.*LatentImage/i.test(joined)) return "image";
  if (/SaveAudio|VAE.*Audio|Audio/i.test(joined)) return "audio";
  return "text";
}

function ensureTypePrefix(name, type) {
  const prefix = TYPE_PREFIX[type] || "text";
  const value = String(name || "workflow").trim() || "workflow";
  return value.toLowerCase().startsWith(`${prefix}-`) ? value : `${prefix}-${value}`;
}

function findNodes(workflow) {
  return Object.entries(workflow).map(([id, node]) => ({ id, classType: node.class_type, inputs: node.inputs, meta: node._meta || {} }));
}

function firstNode(nodes, pattern) {
  return nodes.find((node) => pattern.test(node.classType));
}

export function inferBindings(workflow) {
  const nodes = findNodes(workflow);
  const bindings = {};
  const textNodes = nodes.filter((node) => /CLIPTextEncode/i.test(node.classType));
  if (textNodes.length) {
    const positive = textNodes.find((node) => /positive|正向|正面/i.test(String(node.meta.title || ""))) || textNodes[0];
    const negative = textNodes.find((node) => /negative|负向|负面/i.test(String(node.meta.title || ""))) || textNodes.find((node) => node.id !== positive.id);
    if (typeof positive.inputs.text === "string") bindings.prompt = { node: positive.id, input: "text" };
    else if (typeof positive.inputs.text_g === "string") {
      bindings.prompt = { node: positive.id, input: "text_g" };
      bindings.prompt2 = { node: positive.id, input: "text_l" };
    }
    if (negative) {
      if (typeof negative.inputs.text === "string") bindings.negative = { node: negative.id, input: "text", default: "" };
      else if (typeof negative.inputs.text_g === "string") {
        bindings.negative = { node: negative.id, input: "text_g", default: "" };
        bindings.negative2 = { node: negative.id, input: "text_l", default: "" };
      }
    }
  }

  const latent = firstNode(nodes, /Empty.*LatentImage/i);
  if (latent) {
    if (Number.isFinite(latent.inputs.width)) bindings.width = { node: latent.id, input: "width", from: "size.width", default: latent.inputs.width };
    if (Number.isFinite(latent.inputs.height)) bindings.height = { node: latent.id, input: "height", from: "size.height", default: latent.inputs.height };
    if (Number.isFinite(latent.inputs.batch_size)) bindings.batch = { node: latent.id, input: "batch_size", from: "count", default: latent.inputs.batch_size };
  }

  const sampler = firstNode(nodes, /KSampler/i);
  if (sampler) {
    if (Number.isFinite(sampler.inputs.seed)) bindings.seed = { node: sampler.id, input: "seed", random: true };
    if (Number.isFinite(sampler.inputs.steps)) bindings.steps = { node: sampler.id, input: "steps", from: "quality.steps", default: sampler.inputs.steps };
    if (Number.isFinite(sampler.inputs.cfg)) bindings.cfg = { node: sampler.id, input: "cfg", from: "quality.cfg", default: sampler.inputs.cfg };
    if (Number.isFinite(sampler.inputs.denoise) && nodes.some((node) => /^LoadImage/i.test(node.classType))) {
      bindings.denoise = { node: sampler.id, input: "denoise", from: "params.denoise", default: sampler.inputs.denoise };
    }
  }
  const noise = firstNode(nodes, /RandomNoise/i);
  if (!bindings.seed && noise && "noise_seed" in (noise.inputs || {})) {
    bindings.seed = { node: noise.id, input: "noise_seed", random: true };
  }
  const basicScheduler = firstNode(nodes, /BasicScheduler/i);
  if (!bindings.steps && basicScheduler && Number.isFinite(basicScheduler.inputs.steps)) {
    bindings.steps = { node: basicScheduler.id, input: "steps", from: "quality.steps", default: basicScheduler.inputs.steps };
  }

  const loadImages = nodes.filter((node) => /^LoadImage/i.test(node.classType));
  if (loadImages[0]) bindings.image = { node: loadImages[0].id, input: "image", from: "image", imageIndex: 0 };
  if (loadImages[1]) bindings.image2 = { node: loadImages[1].id, input: "image", from: "image", imageIndex: 1 };

  for (const node of nodes) {
    if (!/WanImageToVideo|WanFirstLastFrame|WanVace|MiniMaxH3|MinimaxH3|VDN-H3|H3/i.test(node.classType)) continue;
    const isH3 = /MiniMaxH3|MinimaxH3|H3/i.test(node.classType);
    const nodeFps = Number(node.inputs?.fps ?? node.inputs?.frame_rate);
    for (const input of Object.keys(node.inputs || {})) {
      const low = input.toLowerCase();
      const value = node.inputs[input];
      if ((low === "width" || low === "height") && (!bindings[low] || isH3)) {
        bindings[low] = { node: node.id, input, from: `size.${low}`, default: Number.isFinite(value) ? value : undefined, ...(isH3 ? { transform: "snap32" } : {}) };
      }
      if ((low === "length" || low === "num_frames" || low === "frames") && !bindings.length) {
        bindings.length = {
          node: node.id,
          input,
          from: "seconds",
          transform: isH3 ? "secondsToFrames17" : "secondsToFrames",
          fps: Number.isFinite(nodeFps) ? nodeFps : isH3 ? 24 : 16,
          default: Number.isFinite(value) ? value : undefined,
        };
      }
      if ((low === "fps" || low === "frame_rate") && !bindings.fps) {
        bindings.fps = { node: node.id, input, default: Number.isFinite(value) ? value : isH3 ? 24 : 16 };
      }
      if (["start_image", "start_frame", "first_frame"].includes(low) && !bindings.image) {
        bindings.image = { node: node.id, input, from: "image", imageIndex: 0 };
      }
      if (["end_image", "last_frame"].includes(low) && !bindings.image2) {
        bindings.image2 = { node: node.id, input, from: "image", imageIndex: 1 };
      }
      const refMatch = low.match(/^ref_images\.ref_image_(\d+)$/);
      if (refMatch) {
        const index = Number(refMatch[1]);
        const key = index === 0 ? "image" : `image${index + 1}`;
        if (!bindings[key]) bindings[key] = { node: node.id, input, from: "image", imageIndex: index };
      }
    }
  }

  if (!bindings.prompt) {
    for (const node of nodes) {
      for (const [input, value] of Object.entries(node.inputs || {})) {
        if (typeof value === "string" && /^(prompt|positive|text)$/i.test(input)) {
          bindings.prompt = { node: node.id, input };
          break;
        }
      }
      if (bindings.prompt) break;
    }
  }
  return bindings;
}

function outputWarnings(workflow) {
  const classes = Object.values(workflow || {}).map((node) => String(node?.class_type || ""));
  const warnings = [];
  if (!classes.some((value) => /SaveImage|SaveVideo|VHS_VideoCombine|SaveWebM/i.test(value))) {
    warnings.push("工作流里没有找到 SaveImage / SaveVideo / VHS_VideoCombine 输出节点，生成结果可能无法取回。");
  }
  return warnings;
}

function bindingWarnings(workflow, bindings) {
  const warnings = [];
  for (const [key, binding] of Object.entries(bindings || {})) {
    if (!binding || !binding.node || !binding.input) {
      warnings.push(`绑定 ${key} 缺少 node/input。`);
      continue;
    }
    const node = workflow[binding.node];
    if (!node) {
      warnings.push(`绑定 ${key} 指向不存在的节点 ${binding.node}。`);
      continue;
    }
    if (!(binding.input in (node.inputs || {}))) warnings.push(`绑定 ${key} 指向 ${binding.node}.${binding.input}，但该输入不存在。`);
  }
  return warnings;
}

export function createRegistry({ dir, maxWorkflowBytes = 5 * 1024 * 1024, logger } = {}) {
  const registryPath = path.join(dir, REGISTRY_FILE);
  const cache = new Map();
  const byName = new Map();
  let signature = "";
  let loaded = false;
  let loading = null;

  async function ensureRegistryFile() {
    try {
      await fsp.access(registryPath);
    } catch {
      await writeJsonAtomic(registryPath, { version: 1, workflows: [] });
    }
  }

  async function readRegistryData() {
    await ensureRegistryFile();
    const data = await readJsonFile(registryPath, maxWorkflowBytes);
    return Array.isArray(data?.workflows) ? data.workflows : [];
  }

  async function computeSignature(entries) {
    const parts = [];
    try {
      const stat = await fsp.stat(registryPath);
      parts.push(`registry:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push("registry:missing");
    }
    for (const entry of entries) {
      const files = [entry.file, ...Object.values(entry.variants || {}).map((variant) => variant?.file)].filter(Boolean);
      for (const file of files) {
        const filePath = path.isAbsolute(file) ? file : path.join(dir, file);
        try {
          const stat = await fsp.stat(filePath);
          parts.push(`${filePath}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          parts.push(`${filePath}:missing`);
        }
      }
    }
    return parts.join("|");
  }

  async function doLoad() {
    const entries = await readRegistryData();
    cache.clear();
    byName.clear();
    for (const raw of entries) {
      try {
        if (!raw?.file) throw new Error("缺少 file 字段");
        const filePath = path.isAbsolute(raw.file) ? raw.file : path.join(dir, raw.file);
        const workflow = await readJsonFile(filePath, maxWorkflowBytes);
        if (!isApiWorkflow(workflow)) {
          if (isUiWorkflow(workflow)) logger?.warn?.(`跳过 UI 格式工作流 ${raw.file}，请在 ComfyUI 中导出 API 格式。`);
          else logger?.warn?.(`跳过无效工作流 ${raw.file}`);
          continue;
        }
        const type = inferType(workflow, raw.type);
        const id = raw.id || slugify(raw.name || path.basename(filePath, ".json"), `workflow-${Date.now()}`);
        const name = ensureTypePrefix(raw.name || id, type);
        const entry = {
          ...raw,
          id,
          name,
          type,
          file: raw.file,
          filePath,
          workflow,
          bindings: raw.bindings && Object.keys(raw.bindings).length ? raw.bindings : inferBindings(workflow),
        };
        if (raw.variants) {
          entry.variants = {};
          for (const [mode, variant] of Object.entries(raw.variants)) {
            if (!variant?.file) continue;
            const variantPath = path.isAbsolute(variant.file) ? variant.file : path.join(dir, variant.file);
            const variantWorkflow = await readJsonFile(variantPath, maxWorkflowBytes);
            if (!isApiWorkflow(variantWorkflow)) {
              logger?.warn?.(`跳过无效变体 ${mode}: ${variant.file}`);
              continue;
            }
            entry.variants[mode] = { ...variant, workflow: variantWorkflow, bindings: variant.bindings || entry.bindings, defaults: variant.defaults || entry.defaults };
          }
        }
        cache.set(id, entry);
        byName.set(name, entry);
        if (id !== name) byName.set(id, entry);
      } catch (error) {
        logger?.warn?.(`加载工作流失败 ${raw?.file || raw?.id || "unknown"}: ${error.message}`);
      }
    }
    signature = await computeSignature(entries);
    loaded = true;
  }

  async function load() {
    if (loading) return loading;
    loading = doLoad().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function reloadIfChanged() {
    if (!loaded) return load();
    try {
      const entries = await readRegistryData();
      const next = await computeSignature(entries);
      if (next !== signature) await load();
    } catch (error) {
      logger?.warn?.(`registry reload check failed: ${error.message}`);
    }
  }

  function publicEntry(entry) {
    if (!entry) return null;
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      label: entry.label || entry.name,
      description: entry.description || "",
      category: entry.category || null,
      hidden: entry.hidden === true,
      file: entry.file,
      bindings: entry.bindings || {},
      defaults: entry.defaults || {},
      presets: entry.presets || {},
      parameters: Array.isArray(entry.parameters) ? entry.parameters : [],
      baseModels: entry.baseModels || null,
      lora: entry.lora || null,
      variantModes: entry.variants ? Object.keys(entry.variants) : [],
      variantLabels: entry.variantLabels || {},
      importedAt: entry.importedAt,
      source: entry.source,
    };
  }

  function list() {
    return [...cache.values()].map(publicEntry).sort((a, b) => a.name.localeCompare(b.name));
  }

  function resolve(idOrName) {
    if (!idOrName) return null;
    return cache.get(idOrName) || byName.get(idOrName) || [...cache.values()].find((entry) => entry.name.toLowerCase() === String(idOrName).toLowerCase()) || null;
  }

  function listModels(loaderOptions = {}) {
    return listModelDescriptors([...cache.values()], loaderOptions).map((descriptor) => ({
      ...descriptor,
      entry: decorateEntry(descriptor.entry, descriptor.variant, loaderOptions),
    }));
  }

  function resolveModel(idOrName, loaderOptions = {}) {
    const direct = resolve(idOrName);
    if (direct) return { entry: decorateEntry(direct, null, loaderOptions), variant: null };
    for (const entry of cache.values()) {
      const variant = resolveBaseModelVariant(entry, idOrName, loaderOptions);
      if (!variant) continue;
      return { entry: decorateEntry(entry, variant, loaderOptions), variant };
    }
    return null;
  }

  function resolveForMode(entry, mode) {
    const variant = mode ? entry?.variants?.[mode] : null;
    if (!variant) return entry;
    return {
      ...entry,
      ...variant,
      workflow: variant.workflow || entry.workflow,
      bindings: variant.bindings || entry.bindings,
      defaults: variant.defaults || entry.defaults,
    };
  }

  function schema(entry) {
    const fields = Object.entries(entry.bindings || {}).map(([key, binding]) => ({
      key,
      node: binding.node,
      input: binding.input,
      from: binding.from,
      default: binding.default,
      required: binding.required === true || key === "prompt",
      random: binding.random === true,
      transform: binding.transform,
      imageIndex: binding.imageIndex,
    }));
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      label: entry.label || entry.name,
      baseModel: entry.baseModel || null,
      baseModelLabel: entry.baseModelLabel || null,
      baseModels: entry.baseModels || null,
      variantModes: entry.variants ? Object.keys(entry.variants) : [],
      variantLabels: entry.variantLabels || {},
      fields,
      parameters: Array.isArray(entry.parameters) ? entry.parameters : [],
      lora: entry.lora || null,
    };
  }

  async function uniqueName(baseName) {
    let name = baseName;
    let index = 1;
    while (byName.has(name)) {
      index += 1;
      name = `${baseName}-${index}`;
    }
    return name;
  }

  async function importWorkflow({ url, path: sourcePath, json, name, type, bindings: overrideBindings, defaults, presets, parameters, lora, description, overwrite = false } = {}) {
    let workflow;
    let derivedName = "";
    let source = {};
    if (json !== undefined) {
      if (typeof json === "string") {
        try {
          workflow = JSON.parse(json);
        } catch (error) {
          throw new RegistryError(`JSON 解析失败：${error.message}`, { code: "invalid_json" });
        }
      } else {
        workflow = json;
      }
      derivedName = name || "workflow";
      source = { kind: "json" };
    } else if (sourcePath) {
      const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(dir, sourcePath);
      const text = await fsp.readFile(absolute, "utf8");
      if (Buffer.byteLength(text) > maxWorkflowBytes) throw new RegistryError("工作流文件过大", { status: 413, code: "workflow_too_large" });
      try {
        workflow = JSON.parse(text);
      } catch (error) {
        throw new RegistryError(`工作流 JSON 解析失败：${error.message}`, { code: "invalid_json" });
      }
      derivedName = name || path.basename(absolute, ".json");
      source = { kind: "path", path: absolute };
    } else if (url) {
      if (!/^https?:\/\//i.test(url)) throw new RegistryError("只支持 http/https URL", { code: "invalid_url" });
      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
      } catch (error) {
        throw new RegistryError(`下载工作流失败：${error.message}`, { status: 400, code: "download_failed" });
      }
      if (!response.ok) throw new RegistryError(`下载工作流失败：HTTP ${response.status}`, { status: 400, code: "download_failed" });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength && contentLength > maxWorkflowBytes) throw new RegistryError("工作流文件过大", { status: 413, code: "workflow_too_large" });
      const text = await response.text();
      if (Buffer.byteLength(text) > maxWorkflowBytes) throw new RegistryError("工作流文件过大", { status: 413, code: "workflow_too_large" });
      try {
        workflow = JSON.parse(text);
      } catch (error) {
        throw new RegistryError(`工作流 JSON 解析失败：${error.message}`, { code: "invalid_json" });
      }
      try {
        derivedName = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "workflow").replace(/\.json$/i, "");
      } catch {
        derivedName = name || "workflow";
      }
      source = { kind: "url", url };
    } else {
      throw new RegistryError("请提供 url、path 或 json 之一", { code: "missing_source" });
    }

    if (isUiWorkflow(workflow)) {
      throw new RegistryError("这是 ComfyUI UI 格式工作流，不能直接提交。请在 ComfyUI 里使用「导出（API）」保存为 API 格式后再导入。", {
        status: 422,
        code: "ui_workflow_not_supported",
      });
    }
    if (!isApiWorkflow(workflow)) {
      throw new RegistryError("不是有效的 ComfyUI API 格式工作流（顶层节点需要 class_type + inputs）。", { status: 422, code: "invalid_api_workflow" });
    }

    const resolvedType = inferType(workflow, type);
    const desiredName = ensureTypePrefix(String(name || derivedName || "workflow").trim(), resolvedType);
    let finalName = desiredName;
    let existing = byName.get(finalName);
    let id;
    let fileName;
    if (existing && overwrite) {
      id = existing.id;
      fileName = existing.file;
      finalName = existing.name;
    } else {
      finalName = await uniqueName(desiredName);
      id = slugify(finalName, `workflow-${Date.now()}`);
      let suffix = 1;
      while (cache.has(id)) {
        suffix += 1;
        id = `${slugify(finalName, "workflow")}-${suffix}`;
      }
      fileName = `${id}.json`;
    }

    const inferred = inferBindings(workflow);
    const mergedBindings = { ...inferred, ...(overrideBindings || {}) };
    const warnings = [...outputWarnings(workflow), ...bindingWarnings(workflow, mergedBindings)];
    if (!mergedBindings.prompt) warnings.push("没有自动推断到 prompt 绑定，请在 registry 里手动指定。");

    await writeJsonAtomic(path.join(dir, fileName), workflow);
    const entry = {
      id,
      name: finalName,
      type: resolvedType,
      description: description || "",
      file: fileName,
      bindings: mergedBindings,
      defaults: isPlainObject(defaults) ? defaults : {},
      presets: isPlainObject(presets) ? presets : {},
      parameters: Array.isArray(parameters) ? parameters : [],
      lora: isPlainObject(lora) ? lora : null,
      importedAt: nowIso(),
      source,
    };
    const data = await readRegistryData();
    const next = data.filter((item) => item.id !== id);
    next.push(entry);
    await writeJsonAtomic(registryPath, { version: 1, workflows: next });
    await load();
    const saved = resolve(id);
    return { workflow: publicEntry(saved), warnings };
  }

  async function scan() {
    const entries = await readRegistryData();
    const usedFiles = new Set(entries.flatMap((entry) => [entry.file, ...Object.values(entry.variants || {}).map((variant) => variant?.file)]).filter(Boolean));
    // 入口文件被导入后会复制成 registry 里的 file；源路径也必须去重，否则持续扫描会生成 -2/-3 副本。
    const usedSources = new Set(
      entries
        .flatMap((entry) => [entry.source?.path, ...Object.values(entry.variants || {}).map((variant) => variant?.source?.path)])
        .filter(Boolean)
        .map((sourcePath) => path.resolve(dir, sourcePath)),
    );
    const files = (await fsp.readdir(dir)).filter((file) => file.toLowerCase().endsWith(".json") && file !== REGISTRY_FILE && !usedFiles.has(file));
    const summary = { added: [], skipped: [], failed: [] };
    for (const file of files) {
      const absolute = path.resolve(dir, file);
      if (usedSources.has(absolute)) continue;
      try {
        const result = await importWorkflow({ path: absolute, overwrite: false });
        summary.added.push(result.workflow.name);
      } catch (error) {
        if (error instanceof RegistryError && error.code === "ui_workflow_not_supported") summary.skipped.push({ file, reason: error.message });
        else summary.failed.push({ file, reason: error.message });
      }
    }
    return summary;
  }

  async function remove(id) {
    const data = await readRegistryData();
    const next = data.filter((entry) => entry.id !== id);
    if (next.length === data.length) return false;
    await writeJsonAtomic(registryPath, { version: 1, workflows: next });
    await load();
    return true;
  }

  return {
    dir,
    registryPath,
    load,
    reloadIfChanged,
    list,
    resolve,
    resolveModel,
    listModels,
    resolveForMode,
    schema,
    importWorkflow,
    scan,
    remove,
    publicEntry,
    isLoaded: () => loaded,
  };
}
