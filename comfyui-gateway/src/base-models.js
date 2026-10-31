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

// 整个 models 根被映射成 diffusion_models 时，UNETLoader 也会列出其他角色的权重；
// 这些文件不是 UNet 底模，不能出现在「默认底模」里。
const NON_UNET_DIR = /(^|[\\/])(loras?|lycoris|vae|vae_approx|clip|text_encoders?|clip_vision|controlnet|t2i_adapter|upscale_models|latent_upscale_models|embeddings|audio_encoders|style_models|gligen|photomaker)([\\/]|$)/i;

function isUnsupportedBaseFile(file) {
  return NON_UNET_DIR.test(String(file || ""));
}

function accepted(file, config) {
  return !isUnsupportedBaseFile(file) && (!config.filter || matches(file, config.filter)) && !matches(file, config.exclude);
}

function uniqueBaseFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    const key = path.basename(String(file || "")).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

// ComfyUI 的 loader 列表可能是子目录路径（如 Krea2/krea2_turbo_fp8_scaled.safetensors），
// 而工作流里保存的默认值往往只有文件名。只在同名文件唯一时做兼容匹配，避免误配到别的模型。
function matchLoaderFile(config, loaderOptions, file) {
  const target = String(file || "");
  if (!target) return "";
  const files = loaderFiles(config, loaderOptions);
  if (files.includes(target)) return target;
  const base = path.basename(target).toLowerCase();
  const matches = files.filter((item) => path.basename(String(item || "")).toLowerCase() === base);
  return matches.length === 1 ? matches[0] : "";
}

function filePresent(config, loaderOptions, file) {
  return Boolean(matchLoaderFile(config, loaderOptions, file));
}

export function resolveBaseModelFile(config, loaderOptions, file) {
  return matchLoaderFile(config, loaderOptions, file);
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
  const configuredRaw = explicitVariants(config);
  const configured = configuredRaw?.map((item) => ({
    ...item,
    file: matchLoaderFile(config, loaderOptions, item.file) || item.file,
  }));
  const files = uniqueBaseFiles(
    configured
      ? configured.map((item) => item.file)
      : (loaderOptions?.[config.classType || "UNETLoader"] || []).filter((file) => accepted(file, config)),
  );
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

function sameBaseFile(a, b) {
  return path.basename(String(a || "")).toLowerCase() === path.basename(String(b || "")).toLowerCase();
}

export function listModelDescriptors(entries, loaderOptions) {
  const descriptors = [];
  for (const entry of entries) {
    const defaultFile = baseModelDefault(entry);
    const defaultPresent = !entry.baseModels || !defaultFile || filePresent(entry.baseModels, loaderOptions, defaultFile);
    const fallback = !defaultPresent
      ? listBaseModels(entry, loaderOptions).find((variant) => filePresent(entry.baseModels, loaderOptions, variant.file))
      : null;
    // 默认底模缺失时，仍保留工作流级入口并回退到第一个可用底模，避免整个模型从下拉里消失。
    if (defaultPresent || fallback) descriptors.push({ modelId: entry.name, baseId: entry.id, entry, variant: null, defaultFile: fallback?.file || defaultFile });
    for (const variant of listBaseModels(entry, loaderOptions)) {
      if (sameBaseFile(variant.file, fallback?.file || defaultFile)) continue;
      if (entry.baseModels && !filePresent(entry.baseModels, loaderOptions, variant.file)) continue;
      descriptors.push({ modelId: modelIdFor(entry, variant), baseId: entry.id, entry, variant, defaultFile });
    }
  }
  return descriptors;
}

function optionsFor(entry, config, loaderOptions) {
  const configured = explicitVariants(config);
  if (configured) return uniqueBaseFiles(configured.map((item) => matchLoaderFile(config, loaderOptions, item.file) || item.file));
  return uniqueBaseFiles((loaderOptions?.[config.classType || "UNETLoader"] || []).filter((file) => accepted(file, config)));
}

export function decorateParameters(entry, variant, loaderOptions) {
  const parameters = Array.isArray(entry?.parameters) ? entry.parameters.map((item) => ({ ...item })) : [];
  const config = entry?.baseModels;
  if (!config) return parameters;
  const options = optionsFor(entry, config, loaderOptions);
  const configuredDefault = variant?.file || baseModelDefault(entry, config);
  const defaultFile = matchLoaderFile(config, loaderOptions, configuredDefault) || configuredDefault;
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
    name: variant.modelId || entry.name,
    baseModel: variant.file,
    baseModelLabel: variant.label,
    baseModelParams: { [entry.baseModels.param]: variant.file, ...(variant.params || {}) },
    parameters,
  };
}
