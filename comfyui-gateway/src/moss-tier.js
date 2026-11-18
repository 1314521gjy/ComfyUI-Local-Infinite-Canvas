import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const MOSS_MODEL_ID = "image-moss-image";
export const MOSS_TIER_IDS = ["fast", "quality", "ultra"];
export const MOSS_PRECISION_MODES = ["off", "on"];
const LEGACY_PRECISION_MODES = { auto: "off", bf16: "off", int8: "on" };
const PRECISION_BY_MODE = { off: "bf16", on: "int8" };
const MODE_LABEL = { off: "关闭", on: "开启" };

export const MOSS_LEGACY_TARGETS = [
  { id: "image-moss-sft-8step", tier: "fast", precision: "bf16" },
  { id: "image-moss-sft-int8-8step", tier: "fast", precision: "int8" },
  { id: "image-moss-sft-50step", tier: "ultra", precision: "bf16" },
  { id: "image-moss-sft-int8-50step", tier: "ultra", precision: "int8" },
];

export const MOSS_BALANCED_IDS = ["image-moss-balanced-8step", "image-moss-balanced-50step"];

export class MossTierError extends Error {
  constructor(message, { status = 400, code = "moss_tier_unavailable", details } = {}) {
    super(message);
    this.name = "MossTierError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function legacyMossTarget(modelId) {
  const raw = String(modelId || "");
  for (const target of MOSS_LEGACY_TARGETS) {
    if (raw.endsWith(target.id)) return { kind: "sft", ...target, id: target.id };
  }
  for (const id of MOSS_BALANCED_IDS) {
    if (raw.endsWith(id)) return { kind: "balanced", id };
  }
  return null;
}

function int8OrBf16(precision) {
  return precision === "bf16" ? "int8" : "bf16";
}

function tierIdOf(entry, params) {
  const requested = String(params?.mossTier || "");
  if (MOSS_TIER_IDS.includes(requested)) return requested;
  const fallback = String(entry?.defaultTier || "fast");
  return MOSS_TIER_IDS.includes(fallback) ? fallback : "fast";
}

function precisionRequestOf(params) {
  const raw = String(params?.mossPrecision || "").trim().toLowerCase();
  const mode = raw === "on" || raw === "off" ? raw : LEGACY_PRECISION_MODES[raw] || "off";
  return { raw, mode, legacyAuto: raw === "auto" || raw === "" };
}

/** 返回当前档位/精度对应的 workflow；不可用时抛中文错误。 */
export function resolveMossTier(entry, params) {
  if (entry?.id !== MOSS_MODEL_ID) return null;
  const tierId = tierIdOf(entry, params);
  const tier = entry.tiers?.[tierId];
  if (!tier) throw new MossTierError(`MOSS-Image 档位无效：${tierId}`);
  const workflows = tier.workflows || {};
  const availablePrecisions = ["bf16", "int8"].filter((key) => workflows[key]?.workflow);
  if (!availablePrecisions.length) {
    throw new MossTierError(tier.unavailableReason || `MOSS-Image 的${tier.label || tierId}档未安装`);
  }
  const { mode, legacyAuto } = precisionRequestOf(params);
  let precision = PRECISION_BY_MODE[mode];
  if (!availablePrecisions.includes(precision)) {
    // 旧卡未显式选择精度（auto/空）时，保留“有 bf16 用 bf16、否则 int8”的兼容行为。
    if (legacyAuto && availablePrecisions.includes("int8")) precision = "int8";
    else throw new MossTierError(`MOSS-Image 的${tier.label || tierId}档${MODE_LABEL[mode]}不可用：${precision} 精度模型未安装`);
  }
  const selected = workflows[precision];
  if (!selected?.workflow) {
    throw new MossTierError(`MOSS-Image 的${tier.label || tierId}档没有 ${precision} 精度模型，请换档或安装对应模型`);
  }
  return {
    workflow: selected.workflow,
    bindings: selected.bindings || tier.bindings || entry.bindings,
    defaults: selected.defaults || tier.defaults || entry.defaults,
    tier: tierId,
    tierLabel: tier.label || tierId,
    steps: tier.steps ?? null,
    precision,
    precisionMode: mode,
  };
}

/** 生成前按可用性扫描结果拦一次，避免 UI 失配或 API 直调跑到缺件档位。 */
export function assertMossTierAvailable(entry, status, params) {
  if (entry?.id !== MOSS_MODEL_ID) return null;
  const tierId = tierIdOf(entry, params);
  const tierStatus = status?.tiers?.[tierId];
  if (!tierStatus) throw new MossTierError(`MOSS-Image 的${entry.tiers?.[tierId]?.label || tierId}档不可用`);
  if (!tierStatus.available) {
    throw new MossTierError(tierStatus.reason || `MOSS-Image 的${tierStatus.label || tierId}档不可用`);
  }
  const { mode, legacyAuto } = precisionRequestOf(params);
  const precisionStatus = tierStatus.precision || {};
  const requested = PRECISION_BY_MODE[mode];
  let precision = requested;
  if (precisionStatus[requested] === false) {
    if (legacyAuto && precisionStatus[int8OrBf16(requested)] === true) precision = int8OrBf16(requested);
    else throw new MossTierError(`MOSS-Image 的${tierStatus.label || tierId}档${MODE_LABEL[mode]}不可用：${requested} 精度模型未安装`);
  }
  return { tier: tierId, precision, precisionMode: precision === requested ? mode : precision === "int8" ? "on" : "off" };
}

const hashCache = new Map();

async function fileSha256(file, stat) {
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const hash = crypto.createHash("sha256");
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  hashCache.set(key, digest);
  return digest;
}

/**
 * 12 步 LoRA 的安装有效性门：只认真实文件（大小 + 可选 sha256），
 * 拒绝下载失败留下的 HTML/截断文件。
 */
export async function tierRequiresStatus(requires, { comfyDir = "", comfyRoots = [], loraRoots = [] } = {}) {
  if (!requires?.file) return { ok: true, message: null };
  const roots = [...new Set([comfyDir, ...comfyRoots].map((root) => String(root || "").trim()).filter(Boolean))];
  const loras = [...new Set((loraRoots || []).map((root) => String(root || "").trim()).filter(Boolean))];
  const relativeToLoras = String(requires.file).replace(/^models[\\/]+loras[\\/]+/i, "").replace(/^loras[\\/]+/i, "");
  const candidates = [];
  if (path.isAbsolute(requires.file)) candidates.push(requires.file);
  for (const root of roots) candidates.push(path.join(root, requires.file));
  for (const root of loras) candidates.push(path.join(root, relativeToLoras));
  const uniqueCandidates = [...new Set(candidates)];
  if (!uniqueCandidates.length) return { ok: false, message: requires.missingRootMessage || "无法确认 12 步 LoRA 是否安装（ComfyUI 目录未知）" };
  let target = "";
  let stat = null;
  for (const candidate of uniqueCandidates) {
    const found = await fsp.stat(candidate).catch(() => null);
    if (found?.isFile()) {
      target = candidate;
      stat = found;
      break;
    }
  }
  if (!stat) return { ok: false, message: requires.missingMessage || "12步加速 LoRA 未安装" };
  const minBytes = Number(requires.minBytes) || 0;
  if (minBytes > 0 && stat.size < minBytes) {
    return { ok: false, message: requires.invalidMessage || "12步加速 LoRA 文件不完整（下载失败）" };
  }
  if (requires.sha256) {
    const digest = await fileSha256(target, stat).catch(() => "");
    if (digest && digest.toLowerCase() !== String(requires.sha256).toLowerCase()) {
      return { ok: false, message: requires.invalidMessage || "12步加速 LoRA 文件校验失败" };
    }
  }
  return { ok: true, message: null };
}
