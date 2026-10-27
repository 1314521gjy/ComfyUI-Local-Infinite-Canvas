import path from "node:path";

import { slugify } from "./util.js";

function stripExtension(file) {
  return path.basename(String(file || ""), path.extname(String(file || "")));
}

function matches(file, pattern) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, "i").test(file);
  } catch {
    return false;
  }
}

function accepted(file, config) {
  return (!config.filter || matches(file, config.filter)) && !matches(file, config.exclude);
}

function loaderNodeFor(entry, config) {
  const binding = entry.bindings?.[config.param];
  if (binding?.node && binding?.input) return { nodeId: binding.node, input: binding.input };
  const classType = config.classType || "UNETLoader";
  const found = Object.entries(entry.workflow || {}).find(([, node]) => node?.class_type === classType);
  if (!found) return null;
  const input = config.input || "unet_name";
  return found[1]?.inputs && input in found[1].inputs ? { nodeId: found[0], input } : null;
}

export function imageInputCapacity(entry) {
  let count = 0;
  for (const binding of Object.values(entry?.bindings || {})) {
    if (!binding) continue;
    if (binding.from !== "image" && binding.imageIndex === undefined && !binding.frameMode) continue;
    if (binding.frameMode) count += Math.max(2, Number(binding.max) || 0);
    else if (binding.array) count += Math.max(1, Number(binding.max) || 1);
    else count += 1;
  }
  return count;
}

export function findUnetLoader(workflow) {
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    if (node?.class_type !== "UNETLoader") continue;
    const file = node.inputs?.unet_name;
    if (typeof file === "string" && file) return { nodeId, input: "unet_name", file };
  }
  return null;
}

export function baseModelDefault(entry, config = entry?.baseModels) {
  if (!config) return "";
  const target = loaderNodeFor(entry, config);
  const value = target ? entry.workflow?.[target.nodeId]?.inputs?.[target.input] : "";
  return typeof value === "string" ? value : "";
}

function variantSlug(value) {
  return slugify(value, "model").replace(/_/g, "-");
}

const SHORT_TYPE = { image: "img", video: "vid", audio: "aud", text: "txt" };

function shortType(type) {
  return SHORT_TYPE[type] || type || "model";
}

function aliasFor(config, file) {
  return config?.aliases?.[file] || config?.aliases?.[path.basename(String(file || ""))] || "";
}

function loaderFiles(config, loaderOptions) {
  return loaderOptions?.[config?.classType || "UNETLoader"] || [];
}

function filePresent(config, loaderOptions, file) {
  return loaderFiles(config, loaderOptions).includes(file);
}

function explicitVariants(config) {
  if (!Array.isArray(config?.variants)) return null;
  return config.variants
    .filter((item) => item?.file)
    .map((item) => ({
      file: String(item.file),
      label: item.label || stripExtension(item.file),
      id: item.id ? variantSlug(item.id) : "",
      params: item.params && typeof item.params === "object" ? item.params : undefined,
    }));
}

export function listBaseModels(entry, loaderOptions) {
  const config = entry?.baseModels;
  if (!config || !config.param) return [];
  const configured = explicitVariants(config);
  const files = configured
    ? configured.map((item) => item.file)
    : (loaderOptions?.[config.classType || "UNETLoader"] || []).filter((file) => accepted(file, config));
  const seen = new Set();
  return files.map((file) => {
    const explicit = configured?.find((item) => item.file === file);
    const base = explicit?.id || variantSlug(aliasFor(config, file) || stripExtension(file));
    let id = base;
    let index = 1;
    while (seen.has(id)) {
      index += 1;
      id = `${base}-${index}`;
    }
    seen.add(id);
    return {
      id,
      file,
      label: explicit?.label || aliasFor(config, file) || stripExtension(file),
      params: explicit?.params || {},
    };
  });
}

export function modelIdFor(entry, variant) {
  if (!variant) return entry.name;
  const config = entry.baseModels;
  if (config?.prefix) return `${shortType(entry.type)}-${variantSlug(config.prefix)}-${variant.id}`;
  return `${entry.name}__${variant.id}`;
}

export function listModelDescriptors(entries, loaderOptions) {
  const descriptors = [];
  for (const entry of entries) {
    const defaultFile = baseModelDefault(entry);
    const defaultPresent = !entry.baseModels || !defaultFile || filePresent(entry.baseModels, loaderOptions, defaultFile);
    if (defaultPresent) descriptors.push({ modelId: entry.name, baseId: entry.id, entry, variant: null, defaultFile });
    for (const variant of listBaseModels(entry, loaderOptions)) {
      if (variant.file === defaultFile) continue;
      if (entry.baseModels && !filePresent(entry.baseModels, loaderOptions, variant.file)) continue;
      descriptors.push({ modelId: modelIdFor(entry, variant), baseId: entry.id, entry, variant, defaultFile });
    }
  }
  return descriptors;
}

function optionsFor(entry, config, loaderOptions) {
  const configured = explicitVariants(config);
  if (configured) return configured.map((item) => item.file);
  return (loaderOptions?.[config.classType || "UNETLoader"] || []).filter((file) => accepted(file, config));
}

export function decorateParameters(entry, variant, loaderOptions) {
  const parameters = Array.isArray(entry?.parameters) ? entry.parameters.map((item) => ({ ...item })) : [];
  const config = entry?.baseModels;
  if (!config) return parameters;
  const options = optionsFor(entry, config, loaderOptions);
  const defaultFile = variant?.file || baseModelDefault(entry, config);
  const existing = parameters.find((item) => item.key === config.param);
  if (existing) {
    existing.type = "select";
    existing.options = options;
    if (existing.default === undefined) existing.default = defaultFile;
    return parameters;
  }
  parameters.unshift({
    key: config.param,
    label: config.label || "底模",
    type: "select",
    options,
    default: defaultFile,
    description: "同一工作流下切换底模；CLIP/VAE 需与底模匹配。",
  });
  return parameters;
}

export function resolveBaseModelVariant(entry, modelId, loaderOptions) {
  const config = entry?.baseModels;
  if (!config) return null;
  const requested = String(modelId || "").toLowerCase();
  for (const variant of listBaseModels(entry, loaderOptions)) {
    const id = modelIdFor(entry, variant);
    if (id.toLowerCase() === requested || `${entry.name}__${variant.id}`.toLowerCase() === requested) {
      return { ...variant, modelId: id };
    }
  }
  return null;
}

export function decorateEntry(entry, variant, loaderOptions) {
  const parameters = decorateParameters(entry, variant, loaderOptions);
  if (!variant) return { ...entry, parameters };
  return {
    ...entry,
    name: variant.modelId,
    baseModel: variant.file,
    baseModelLabel: variant.label,
    baseModelParams: { [entry.baseModels.param]: variant.file, ...(variant.params || {}) },
    parameters,
  };
}
