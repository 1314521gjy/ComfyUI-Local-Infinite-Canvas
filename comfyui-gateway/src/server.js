import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import express from "express";
import multer from "multer";

import { buildContext } from "./bindings.js";
import { imageInputCapacity } from "./base-models.js";
import { createAssistantManager } from "./assistant.js";
import { createComfyBridge } from "./comfy-bridge.js";
import { createComfyClient } from "./comfy-client.js";
import { createLogger, loadConfig } from "./config.js";
import { describeAutoDirectories, detectComfyLayout, directoryLoadReport, manualCustomNodeRoots, normalizeDirectorySettings, saveDirectorySettings, scanDirectories, validateDirectorySettings, writeManagedExtraPaths } from "./directories.js";
import { pickFolder } from "./folder-picker.js";
import { createMainModelStore } from "./main-models.js";
import { createModelEventBus } from "./model-events.js";
import { createRegistry } from "./registry.js";
import { createSessionTracker } from "./sessions.js";
import { createSetupManager } from "./setup.js";
import { pickWorkflowDir, workflowDirCandidates } from "./workflow-dir.js";
import { createResourceManager, inferComfyRootFromFolderPaths } from "./resources.js";
import { createPromptOptimizer } from "./prompt-optimizer.js";
import { createLyricsOptimizer } from "./lyrics-optimizer.js";
import { normalizeH3ImageEditPrompt, reorderQwenEditFiles, reorderQwenEditPrompt, stripImageLabelPreamble } from "./qwen-edit.js";
import { createVideoInterpolator } from "./video-interpolation.js";
import { createPreviewHub } from "./preview-hub.js";
import { absoluteTaskUrl } from "./public-url.js";
import { createFreeWorkflowStore, applyFreeFields, applyFreeInputs, normalizeFreeFields } from "./free-workflows.js";
import { classifyFreeWorkflowOutputs, freeWorkflowNodeTitles, freeWorkflowOutputOrder } from "./free-workflow-outputs.js";
import { applyMossLayoutPrompt } from "./layout-prompt.js";
import { assertMossTierAvailable, legacyMossTarget, MOSS_MODEL_ID } from "./moss-tier.js";
import { runImage, runVideo, runWorkflow } from "./runner.js";
import { ensureSourceAudio, extractVideoFrame, extractVideoFrames, fitViggleSourceCanvas, flattenViggleReferences, padSourceForSegment, planViggleSegments, runViggleLongVideo, scoreVideoFrames } from "./viggle-long.js";
import { mediaPixelSize } from "./media-size.js";
import { resolveVariantFallback } from "./variant-fallback.js";
import { createSkinUnlockStore } from "./skin-unlocks.js";
import { readSystemStats } from "./system-stats.js";
import { createTaskStore } from "./tasks.js";
import { createSwapChain } from "./swap-chain.js";
import { applyUpdate, checkForUpdate, detectInterruptedUpdate, getUpdateProgress, recoverWorkflowBackups, restoreInterruptedUpdate } from "./update.js";
import { uploadImages } from "./uploads.js";
import { resolveYue2Precision, runYue2ComfySong, synthesizeSpeech, synthesizeSpeechH3 } from "./audio-local.js";
import { autoSongDuration, buildSongStyle, lyricsDurationIssue } from "./audio-engine.js";
import { createWorkflowVisibilityStore } from "./workflow-visibility.js";
import { buildScene3dPrompt, evaluateScene3dMetrics, placeSource, prepareSeamAssets, resolveScene3dPython, scene3dScriptPath, SCENE3D_PANO_ID, SCENE3D_SEAM_ID, stitchPanorama } from "./scene3d.js";
import { workflowAvailabilityProblem } from "./workflow-availability.js";
import { alignH3Frames, alignViggleFramesUp, capH3ReferenceFrames, framesFromSeconds, extFromMime, jsonError, nowIso, parseSize, randomId, safeFileName, sleep, VIGGLE_MAX_FRAMES, VIGGLE_MIN_FRAMES } from "./util.js";

class HttpError extends Error {
  constructor(message, { status = 400, code = "bad_request", details } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const uploadBudgetSymbol = Symbol("uploadBudget");

// SageAttention 探测：复用资源中心的 pip 检测，5 分钟内只算一次，避免每个视频任务全量扫资源。
const SAGE_PROBE_TTL_MS = 5 * 60 * 1000;
let sageProbeCache = { at: 0, available: null, pending: null };
function probeSageAvailability(resources) {
  const now = Date.now();
  if (now - sageProbeCache.at < SAGE_PROBE_TTL_MS && sageProbeCache.available !== null) {
    return Promise.resolve(sageProbeCache.available);
  }
  if (!sageProbeCache.pending) {
    sageProbeCache.pending = Promise.resolve()
      .then(() => resources.status())
      .then((result) => {
        const item = (result.resources || []).find((entry) => entry.id === "sage_h3");
        const available = item ? item.present !== false : null;
        sageProbeCache = { at: Date.now(), available, pending: null };
        return available;
      })
      .catch(() => {
        sageProbeCache = { at: 0, available: null, pending: null };
        return null;
      });
  }
  return sageProbeCache.pending;
}

function createBoundedMemoryStorage(maxTotalBytes) {
  const limit = maxTotalBytes >= 1024 * 1024
    ? `${Math.round(maxTotalBytes / (1024 * 1024))} MB`
    : `${Math.ceil(maxTotalBytes / 1024)} KB`;
  const exceeded = () => new HttpError(`上传文件总大小超过 ${limit} 请求预算，请减少素材或分批重试。`, {
    status: 413,
    code: "upload_total_too_large",
  });
  return {
    _handleFile(req, file, cb) {
      const budget = req[uploadBudgetSymbol] || { bytes: 0, failed: false };
      req[uploadBudgetSymbol] = budget;
      const chunks = [];
      let done = false;
      const finish = (...args) => {
        if (done) return;
        done = true;
        cb(...args);
      };
      if (budget.failed) {
        file.stream.resume();
        finish(exceeded());
        return;
      }
      file.stream.on("data", (chunk) => {
        if (budget.failed) return;
        budget.bytes += chunk.length;
        if (budget.bytes > maxTotalBytes) {
          budget.failed = true;
          chunks.length = 0;
          finish(exceeded());
          return;
        }
        chunks.push(chunk);
      });
      file.stream.on("end", () => {
        if (budget.failed) return finish();
        const buffer = Buffer.concat(chunks);
        finish(null, { buffer, size: buffer.length });
      });
      file.stream.on("error", finish);
    },
    _removeFile(_req, file, cb) {
      delete file.buffer;
      cb(null);
    },
  };
}

function requestGatewayToken(req) {
  const header = req.headers["x-gateway-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function gatewayTokenMatches(candidate, expected) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function probeVideoInfo(file, extraProbes = []) {
  if (!file?.buffer?.length) return { fps: 0, duration: 0, frames: 0 };
  const rawExt = extFromMime(file.mimetype) || ".mp4";
  const ext = String(rawExt).startsWith(".") ? rawExt : `.${rawExt}`;
  const temp = path.join(os.tmpdir(), `comfy-probe-${randomId()}${ext}`);
  const candidates = ["ffprobe", ...extraProbes.filter(Boolean)];
  try {
    fs.writeFileSync(temp, file.buffer);
    for (const bin of candidates) {
      try {
        const raw = execFileSync(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-show_entries", "format=duration", "-of", "json", temp], { encoding: "utf8", timeout: 20000 });
        const data = JSON.parse(raw);
        const rate = String(data.streams?.[0]?.avg_frame_rate || "0/1").split("/").map(Number);
        const fps = rate[1] ? rate[0] / rate[1] : rate[0];
        const duration = Number(data.format?.duration || 0);
        if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) continue;
        return { fps, duration, frames: Math.max(1, Math.round(fps * duration)) };
      } catch {
        // 换下一个 ffprobe 路径。
      }
    }
    return { fps: 0, duration: 0, frames: 0 };
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
    }
  }
}

function probeVideoFrames(file, extraProbes = []) {
  return probeVideoInfo(file, extraProbes).frames;
}

function gpuVramTotalGb(stats) {
  const totals = (stats?.gpu || [])
    .map((gpu) => Number(gpu.memoryTotalMb))
    .filter((value) => Number.isFinite(value) && value > 0);
  return totals.length ? Math.max(...totals) / 1024 : 0;
}

function corsMiddleware(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    let localOrigin = false;
    try {
      localOrigin = Boolean(origin) && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(origin).hostname);
    } catch {
      localOrigin = false;
    }
    const allowed = config.corsOrigins.includes("*") || localOrigin || (origin && config.corsOrigins.includes(origin));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.includes("*") ? "*" : origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-Request-Id, X-Gateway-Token");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

function abortOnDisconnect(req, res, register) {
  const controller = new AbortController();
  const unregister = register?.(req.id, controller);
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", abort);
  res.on("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", abort);
      res.off("close", abort);
      unregister?.();
    },
  };
}

function parseFreeTexts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function freeEffectivePrompt(entry, texts, prompt, primaryText = null) {
  const binding = primaryText?.node !== undefined && primaryText?.input ? primaryText : entry?.bindings?.prompt;
  if (!binding) return String(prompt || "");
  const match = (Array.isArray(texts) ? texts : []).find(
    (item) => String(item?.node ?? "") === String(binding.node) && String(item?.input ?? "") === String(binding.input),
  );
  return String(match?.value ?? prompt ?? "");
}

function parsePrimaryText(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || parsed.node === undefined || !parsed.input) return null;
  return { node: String(parsed.node), input: String(parsed.input) };
}

function parseParams(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 落到下面的统一错误。
    }
  }
  throw new HttpError("params 必须是 JSON 对象", { status: 400, code: "invalid_params" });
}

function imageFilesFrom(files = []) {
  return files.filter((file) => /image|frame/i.test(file.fieldname || ""));
}

// 一次产片模板归一：历史 prompt 常把 <Picture N> 写成 edit 口径的“frame at the pin”，
// 把人物参考照片谎称为视频帧会让模型矛盾而不换人；统一改写为 reference photo 身份参考口径。
// 同时清理为保留角色多加的没有 <Picture N> 的 <Subject N>，保持 keyframe/Subject 映射一致。
function normalizeViggleSwapPrompt(prompt) {
  const notes = [];
  let text = String(prompt || "").replace(/\r\n/g, "\n");
  text = text.replace(/^<Picture\s+(\d+)>\s+is\s+the\s+target\s+video['’]s\s+frame\s+at\s+the\s+pin\b.*$/gim, (line, index) => {
    const subject = line.match(/as\s+<Subject\s+(\d+)>/i);
    notes.push(`Picture ${index} 改为身份参考照片口径`);
    return subject
      ? `<Picture ${index}> is a reference photo of <Subject ${subject[1]}> (identity and wardrobe reference, not a video frame).`
      : `<Picture ${index}> is a reference photo of the corresponding subject (identity and wardrobe reference, not a video frame).`;
  });
  const pictureIds = new Set([...text.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => match[1]));
  const kept = [];
  const removedSubjects = [];
  for (const line of text.split("\n")) {
    const subject = line.match(/^<Subject\s+(\d+)>/i);
    if (subject && !pictureIds.has(subject[1]) && /fully_preserved|keeps?\s+(?:her|his|their)\s+original|unchanged|original appearance/i.test(line)) {
      removedSubjects.push(subject[1]);
      notes.push(`移除无 Picture 的保留角色 Subject ${subject[1]}`);
      continue;
    }
    kept.push(line);
  }
  text = kept
    .map((line) => removedSubjects.reduce((acc, index) => acc.replace(new RegExp(`<Subject\\s+${index}>\\s*`, "gi"), ""), line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // 旧模板可能在 summary/retention 里使用 <Subject 1>，却没有 subject_definitions 定义；
  // 从 retention 的 replaced 描述与 Picture 1 描述补一条最小定义，恢复 Subject↔Picture 对应。
  if (text) {
    const lines = text.split("\n");
    const defined = new Set([...text.matchAll(/^<Subject\s+(\d+)>\s+is\s+/gim)].map((match) => match[1]));
    const used = new Set([...text.matchAll(/<Subject\s+(\d+)>/gi)].map((match) => match[1]));
    const additions = [];
    for (const id of used) {
      if (defined.has(id)) continue;
      const retention = lines.find((line) => new RegExp(`^<Subject\\s+${id}>`, "i").test(line) && /is replaced/i.test(line));
      const picture = lines.find((line) => new RegExp(`^<Picture\\s+${id}>`, "i").test(line));
      if (!retention || !picture) continue;
      const source = (retention.match(/-\s*(.+?)\s+is replaced/i) || [])[1];
      const target = (picture.match(/showing\s+(.+)$/i) || [])[1];
      if (!source || !target) continue;
      additions.push(`<Subject ${id}> is ${source} replaced by the person in <Picture ${id}>: ${target.replace(/[。.]$/, "")}.`);
      notes.push(`补回缺失的 Subject ${id} 定义`);
    }
    if (additions.length) {
      const summaryIndex = lines.findIndex((line) => /^summary\s*:/i.test(line.trim()));
      const insertAt = summaryIndex >= 0 ? summaryIndex : lines.length;
      lines.splice(insertAt, 0, ...additions);
      text = lines.join("\n");
    }
  }
  return { text: text || String(prompt || ""), notes };
}

function orderedVideoFiles(files = []) {
  const groups = ["first_frame", "last_frame", "image", "image[]", "images"];
  const ordered = [];
  const seen = new Set();
  const push = (file) => {
    if (!file?.buffer) return;
    const hash = crypto.createHash("sha1").update(file.buffer).digest("hex");
    if (seen.has(hash)) return;
    seen.add(hash);
    ordered.push(file);
  };
  for (const group of groups) files.filter((file) => file.fieldname === group).forEach(push);
  for (const file of files) if (/image|frame/i.test(file.fieldname || "")) push(file);
  return ordered.slice(0, 8);
}

function orderedPromptImages(files = []) {
  const byName = new Map(files.filter((file) => file?.buffer).map((file) => [file.fieldname, file]));
  const ordered = [];
  const take = (name) => {
    const file = byName.get(name);
    if (!file) return;
    byName.delete(name);
    ordered.push(file);
  };
  take("image");
  take("image1");
  take("images");
  for (let index = 2; index <= 15; index += 1) take(`image${index}`);
  for (const file of files) {
    if (ordered.length >= 15) break;
    if (file?.buffer && /image|frame/i.test(file.fieldname || "") && !ordered.includes(file)) ordered.push(file);
  }
  return ordered.slice(0, 15);
}

function orderedVideoRefFiles(files = []) {
  return files.filter((file) => file?.buffer && /^videos?(\[\])?$/i.test(file.fieldname || "")).slice(0, 1);
}

function orderedAudioRefFiles(files = []) {
  return files.filter((file) => file?.buffer && /^audios?(\[\])?$/i.test(file.fieldname || "")).slice(0, 2);
}

const RGBA_PROMPT_PREFIX = "This is an RGBA format image with transparency.";
const RGBA_PROMPT_SUFFIX = "The image has an alpha channel and a transparent background.";

function applyBackgroundPrompt(prompt, background, entry) {
  if (background !== "transparent" || !entry?.backgroundPrompt) return prompt;
  const text = String(prompt || "").trim();
  if (/alpha channel|RGBA/i.test(text)) return text;
  return `${RGBA_PROMPT_PREFIX} ${text} ${RGBA_PROMPT_SUFFIX}`.trim();
}

function requireModel(registry, setup, model, expectedType, { mode = "", allowUnavailable = false } = {}) {
  const name = String(model || "").trim();
  if (!name) throw new HttpError("缺少 model 参数", { status: 400, code: "missing_model" });
  const found = registry.resolveModel(name, (setup.loaderOptions?.() || {}));
  if (!found) throw new HttpError(`未找到模型：${name}。请先在网关注册工作流，或在画布渠道里拉取模型列表。`, { status: 404, code: "model_not_found" });
  if (expectedType && found.entry.type !== expectedType) throw new HttpError(`模型 ${name} 的类型是 ${found.entry.type}，不是 ${expectedType}`, { status: 400, code: "model_type_mismatch" });
  const unavailable = workflowAvailabilityProblem(setup, found.entry, { mode, allowUnavailable });
  if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
  return found.entry;
}

function requireWorkflowMode(setup, entry, mode) {
  const unavailable = workflowAvailabilityProblem(setup, entry, { mode });
  if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
}

// 字段名会重复出现在普通节点里，必须同时匹配已发现的 loader classType 和 input。
function diagnosticLoaderPairs(setup) {
  const pairs = new Set();
  for (const spec of setup?.modelLoaderSpecs?.() || []) {
    if (!spec?.classType || !spec?.input) continue;
    pairs.add(`${spec.classType}\u0000${spec.input}`);
  }
  return pairs;
}

// loader 值允许保留 ComfyUI 内的相对子目录，但不能把本机绝对路径带进诊断。
function sanitizeModelValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const normalized = text.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") || normalized.startsWith("/")) {
    return normalized.split("/").filter(Boolean).pop() || "";
  }
  return text;
}

function sanitizeDiagnosticText(value) {
  return String(value ?? "")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|，。；）)]+/g, "<path>")
    .replace(/\/(?:Users|home|root|tmp|var|opt|mnt)\/[^\s"'<>|，。；）)]+/g, "<path>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(authorization|token|api[_-]?key|secret|password|cookie)\b\s*[:=]\s*[^\s,;"']+/gi, "$1=<redacted>");
}

function sanitizeComfyUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function setupSyncSummary(status, instanceId) {
  return {
    instanceId: instanceId || status?.instanceId || "",
    scanId: status?.scanId ?? 0,
    revision: status?.revision ?? 0,
    phase: status?.phase || "idle",
    scanning: status?.scanning === true,
    stale: status?.stale === true,
    comfyReachable: status?.comfyReachable === true,
    scannedAt: status?.scannedAt || null,
    counts: status?.counts || { available: 0, unavailable: 0, total: 0 },
  };
}

function diagnosticProblems(problems = [], limit = 20) {
  return (Array.isArray(problems) ? problems : [])
    .slice(0, limit)
    .map((problem) => ({
      type: String(problem?.type || "problem"),
      message: sanitizeDiagnosticText(problem?.message || ""),
      classType: problem?.classType ? String(problem.classType) : undefined,
      input: problem?.input ? String(problem.input) : undefined,
      value: problem?.value ? sanitizeModelValue(problem.value) : undefined,
      candidates: Array.isArray(problem?.candidates)
        ? problem.candidates.slice(0, 10).map(sanitizeModelValue)
        : undefined,
    }));
}

function setupProblemSummary(status) {
  const missing = status?.missing || {};
  const list = (items) => (Array.isArray(items) ? items : []);
  return {
    models: list(missing.models).slice(0, 10).map(sanitizeDiagnosticText),
    modelCount: list(missing.models).length,
    nodes: list(missing.nodes).slice(0, 10).map(sanitizeDiagnosticText),
    nodeCount: list(missing.nodes).length,
    runtime: list(missing.runtime).slice(0, 10).map(sanitizeDiagnosticText),
    restart: list(missing.restart).slice(0, 10).map(sanitizeDiagnosticText),
    uiWorkflows: Number(missing.uiWorkflows || 0),
    uiSamples: list(missing.uiSamples).slice(0, 5).map(sanitizeDiagnosticText),
  };
}

function workflowLoaderEvidence(entry, setup, status) {
  const specs = setup.modelLoaderSpecs?.() || [];
  const catalog = setup.loaderOptions?.() || {};
  const rows = [];
  for (const [nodeId, node] of Object.entries(entry?.workflow || {})) {
    const classType = node?.class_type;
    if (!classType) continue;
    for (const spec of specs) {
      if (spec.classType !== classType) continue;
      const expected = node.inputs?.[spec.input];
      if (typeof expected !== "string" || !expected.trim()) continue;
      const options = Array.isArray(catalog[`${classType}\u0000${spec.input}`])
        ? catalog[`${classType}\u0000${spec.input}`]
        : Array.isArray(catalog[classType]) ? catalog[classType] : [];
      const wanted = expected.replace(/\\/g, "/").toLowerCase();
      const installed = options.some((item) => String(item).replace(/\\/g, "/").toLowerCase() === wanted);
      const alias = setup.modelAliasFor?.(classType, spec.input, expected) || "";
      const problem = (status?.problems || []).find((item) => item.classType === classType && item.input === spec.input && (!item.value || item.value === expected));
      const candidates = (setup.modelCandidates?.(classType, expected, spec.input) || []).slice(0, 10);
      rows.push({
        nodeId,
        classType,
        input: spec.input,
        expected: sanitizeModelValue(expected),
        installed,
        alias: alias ? sanitizeModelValue(alias) : null,
        effective: sanitizeModelValue(alias || expected),
        candidates: candidates.map(sanitizeModelValue),
        availability: {
          available: !problem,
          problemType: problem?.type || null,
          message: problem ? sanitizeDiagnosticText(problem.message) : null,
        },
      });
    }
  }
  return rows;
}

function diagnosticWorkflow(entry, setup, status, { workflowVisibility } = {}) {
  const variants = {};
  for (const [mode, variant] of Object.entries(status?.variants || {})) {
    variants[mode] = {
      available: variant?.available === true,
      problems: diagnosticProblems(variant?.problems),
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    enabled: entry.hidden !== true && !workflowVisibility?.isHidden?.(entry.id),
    available: status?.available === true,
    stale: status?.stale === true,
    problems: diagnosticProblems(status?.problems),
    variants,
    loaders: workflowLoaderEvidence(entry, setup, status),
  };
}

function isLoopbackPeer(address) {
  const raw = String(address || "").replace(/^::ffff:/i, "");
  return raw === "::1" || raw === "localhost" || raw.startsWith("127.");
}

export async function stopGateway({ tasks, comfy, setup, server, abortActiveRequests, assistant, logger } = {}) {
  try {
    setup?.stop?.();
  } catch {
    /* 关停清理失败不应阻塞退出 */
  }
  try {
    abortActiveRequests?.();
  } catch {
    /* 同上 */
  }
  try {
    await assistant?.stop?.("gateway-shutdown");
  } catch {
    /* Agent 停机失败不应阻塞网关退出 */
  }
  try {
    server?.close?.();
  } catch {
    /* 同上 */
  }
  const result = await tasks.cancelInFlight(comfy, { timeoutMs: 2500 });
  if (result.total) logger?.info?.(`关停取消 ${result.total} 个在途任务${result.timedOut ? "（等待超时）" : ""}`);
  await tasks.persistNow();
  return result;
}

export async function createGatewayApp(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = createLogger(overrides.logPrefix || "gateway");
  const assistant = createAssistantManager({ config, logger, idleMs: config.assistantIdleMs });
  try {
    const recovery = await recoverWorkflowBackups(config);
    const interruptedUpdate = await detectInterruptedUpdate(config).catch(() => ({ pending: false }));
    if (interruptedUpdate.pending) {
      logger.warn(`检测到未完成的更新 v${interruptedUpdate.version}（当前 v${interruptedUpdate.currentVersion}）；可调用 POST /api/update/recovery/restore 回滚，或重新应用完整包。`);
    }
    if (recovery.restored.length) {
      logger.warn(`升级后恢复 ${recovery.restored.length} 个本地修改的工作流；新版官方文件保存在 .update-backup/${config.version}/official-new`);
    }
  } catch (error) {
    logger.warn(`恢复升级前工作流失败：${error.message}`);
  }
  const previewHub = createPreviewHub({ comfyUrl: () => comfy.baseUrl(), logger });
  const comfy = createComfyClient({
    baseUrl: config.comfyUrl,
    timeoutMs: config.requestTimeoutMs,
    retryAttempts: config.comfyRetryAttempts,
    retryDelayMs: config.comfyRetryDelayMs,
    logger,
    previewHub,
  });
  const mainModels = createMainModelStore({ dataDir: config.dataDir, logger });
  await mainModels.load();
  const registry = createRegistry({
    dir: config.workflowDir,
    maxWorkflowBytes: config.maxWorkflowBytes,
    logger,
    mainModelFile: (id) => mainModels.fileForWorkflow(id),
  });
  await registry.load();
  const tasks = createTaskStore({
    dataDir: config.dataDir,
    logger,
    retentionDays: config.taskRetentionDays,
    maxTasks: config.maxStoredTasks,
  });
  await tasks.load();
  const swapChain = createSwapChain({ comfy, config, logger, dataDir: config.dataDir });
  swapChain.load();
  const taskResponse = (req, task) => {
    const data = tasks.publicTask(task);
    return { ...data, url: data.url ? absoluteTaskUrl(config, req, data.url) : null };
  };
  const freeWorkflows = createFreeWorkflowStore({
    dataDir: config.dataDir,
    comfyWorkflowsDir: config.comfyWorkflowsDir,
    getComfyWorkflowsDir: () => config.comfyWorkflowsDir,
    comfy,
    logger,
    maxWorkflowBytes: config.maxWorkflowBytes,
  });
  await freeWorkflows.load();
  const skinUnlocks = createSkinUnlockStore({ dataDir: config.dataDir, logger });
  await skinUnlocks.load();
  const workflowVisibility = createWorkflowVisibilityStore({ dataDir: config.dataDir, logger });
  await workflowVisibility.load();
  const modelEvents = createModelEventBus({ logger });
  // 只轮询已导入自选条目的源文件签名；ComfyUI 保存后自动重转换并广播这一条条目。
  freeWorkflows.startWatching({ onSynced: (entry) => modelEvents.broadcast("free-workflow-sync", { freeWorkflowId: entry.id }) });
  const comfyBridge = createComfyBridge({ config, logger });
  const bridgeStatus = await comfyBridge.ensure();
  if (!bridgeStatus.installed) logger.warn(`ComfyUI 工作流桥接未安装：${bridgeStatus.reason || "未知原因"}`);
  const sessions = createSessionTracker({ staleMs: config.sessionStaleSec * 1000 });
  const setup = createSetupManager({
    config,
    registry,
    comfy,
    logger,
    mainModelFile: (id) => mainModels.fileForWorkflow(id),
    // 扫描成功/失败、断线、重连、目录/别名等变化都复用这一条广播路径；
    // 只带 revision 信号与快照代际，不推送模型列表正文。
    onScanComplete: (status, meta = {}) => {
      const reason = meta.ok === false ? (meta.reason === "offline" ? "offline" : "scan-failed") : meta.reason || "scan";
      modelEvents.broadcast(reason, {
        scanId: status?.scanId,
        setupRevision: status?.revision,
        stale: status?.stale,
        instanceId: status?.instanceId,
      });
    },
  });
  const emitModelChange = (reason) => {
    const status = setup.status();
    return modelEvents.broadcast(reason, {
      scanId: status.scanId,
      setupRevision: status.revision,
      stale: status.stale,
      instanceId: status.instanceId,
    });
  };
  // 注册表内容变化后必须重建 setup 快照，禁止同一 ID 的新工作流沿用旧可用性。
  const reloadRegistryAndSnapshot = async (reason = "registry-reload") => {
    const changed = await registry.reloadIfChanged();
    if (!changed && setup.registrySnapshotCurrent()) return;
    const pending = setup.scan(reason);
    // 首扫尚未完成时不阻塞模型列表；已有成功快照时等新代际提交，避免返回跨代数据。
    if (setup.status().scanId > 0) await pending;
  };
  if (config.allowRemote && !config.gatewayToken) {
    logger.warn("ALLOW_REMOTE=1 但未设置 GATEWAY_TOKEN：接口无令牌保护，仅可在可信内网使用，不要映射到公网。");
  }
  const resources = createResourceManager({ config, setup, registry, logger, workflowVisibility, mainModels });
  await resources.init();
  setup.setRuntimeProblemProvider?.((workflowId) => resources.runtimeProblemsFor(workflowId));
  // 启动器只靠端口接管 ComfyUI 时可能拿不到安装目录；自由卡片仍应能工作。
  async function resolveFreeWorkflowsDir() {
    const collect = (folderPaths) =>
      workflowDirCandidates({
        configured: config.comfyWorkflowsDir,
        comfyDir: config.comfyDir,
        comfyRoot: resources.comfyRoot?.() || "",
        folderPaths,
      });
    let tried = collect(setup.folderPaths?.() || {});
    let dir = pickWorkflowDir(tried);
    if (!dir) {
      const liveFolderPaths = await comfy.folderPaths().catch(() => ({}));
      tried = [...new Set([...tried, ...collect(liveFolderPaths)])];
      dir = pickWorkflowDir(tried);
    }
    if (dir && path.resolve(dir) !== path.resolve(config.comfyWorkflowsDir || "")) {
      config.comfyWorkflowsDir = dir;
      logger.info(`已自动识别 ComfyUI 工作流目录：${dir}`);
    }
    return { dir, tried };
  }
  // 随包节点由启动器首次启动复制；直接用 start-all/start-gateway 启动时这里补一次（幂等）
  void ensureBundledNodes();
  async function ensureBundledNodes() {
    if (process.env.DISABLE_NODE_BOOTSTRAP === "1") return;
    try {
      const packageRoot = path.join(config.rootDir, "..");
      const modulePath = path.join(packageRoot, "launcher", "bootstrap-nodes.mjs");
      if (!fs.existsSync(modulePath)) return;
      const comfyDir = resources.comfyRoot();
      if (!comfyDir) return;
      const { installBundledNodes } = await import(pathToFileURL(modulePath).href);
      const installed = await installBundledNodes({
        root: packageRoot,
        comfyRoot: comfyDir,
        comfyUrl: config.comfyUrl,
        customNodesDirs: manualCustomNodeRoots(setup?.getDirectorySettings?.() || null),
        log: (message, level) => (level === "WARN" ? logger.warn(message) : logger.info(message)),
      });
      if (installed.length) logger.info(`已放置 ${installed.length} 个随包节点，重启 ComfyUI 后生效`);
    } catch (error) {
      logger.warn(`随包节点检查失败：${error.message}`);
    }
  }
  let lastOOM = null;
  const activeRequests = new Map();
  const registerActiveRequest = (id, controller) => {
    const key = String(id || "");
    if (!key) return () => {};
    activeRequests.set(key, controller);
    return () => {
      if (activeRequests.get(key) === controller) activeRequests.delete(key);
    };
  };
  const abortActiveRequests = () => {
    for (const controller of activeRequests.values()) {
      try {
        controller.abort();
      } catch {
        /* 单个请求取消失败不影响关停 */
      }
    }
    activeRequests.clear();
  };
  const promptOptimizer = createPromptOptimizer({
    config,
    comfy,
    logger,
    modelAliasFor: setup.modelAliasFor,
    loaderSpecs: () => setup.modelLoaderSpecs?.(),
  });
  const lyricsOptimizer = createLyricsOptimizer({ appRoot: config.appRoot });
  const videoInterpolator = createVideoInterpolator({ config, logger });

  // 把 parameters.optionsFrom（如 "UpscaleModelLoader.model_name"）替换成 ComfyUI 实时选项。
  const isUpscaleModelOption = (name) => {
    const parts = String(name || "").replace(/\\/g, "/").split("/").filter(Boolean);
    // ComfyUI 的 upscale_models 有时会把整个 models 根也列进来；只保留根文件和真正的放大模型目录。
    return parts.length === 1 || /^(?:upscale_models?|esrgan|upscalers?|4x)$/i.test(parts[0]);
  };

  const uniqueByBasename = (options) => {
    const seen = new Set();
    return options.filter((name) => {
      const base = String(name || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
      if (!base || seen.has(base)) return false;
      seen.add(base);
      return true;
    });
  };

  const enrichParameters = (parameters) => {
    const loaders = setup.loaderOptions?.() || {};
    return (Array.isArray(parameters) ? parameters : []).map((parameter) => {
      const source = String(parameter?.optionsFrom || "").trim();
      if (!source) return parameter;
      const [classType] = source.split(".");
      let options = Array.isArray(loaders[classType]) ? loaders[classType] : [];
      if (source === "UpscaleModelLoader.model_name") options = uniqueByBasename(options.filter(isUpscaleModelOption));
      return { ...parameter, options };
    });
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incomingId = String(req.headers["x-request-id"] || "").replace(/[^\w.:-]/g, "").slice(0, 100);
    req.id = incomingId || randomId("req_");
    res.setHeader("X-Request-Id", req.id);
    const started = Date.now();
    // 前端进度轮询与启动器会话轮询频率高、无诊断价值，不写访问日志，避免把真实错误淹没。
    const quiet = /^\/api\/progress\//.test(req.path) || /^\/api\/session\/status\b/.test(req.path);
    res.on("finish", () => {
      if (!quiet) logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms ${req.id}`);
    });
    next();
  });
  app.use(corsMiddleware(config));
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  const localOriginHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    try {
      if (localOriginHosts.has(new URL(origin).hostname)) return true;
    } catch {
      return false;
    }
    return config.corsOrigins.includes(origin) || config.corsOrigins.includes("*") || origin === config.publicBaseUrl;
  };
  app.use((req, res, next) => {
    // 管理接口支持令牌；生成与媒体链的远程鉴权需和前端请求、SSE、Blob 一起迁移。
    if (config.allowRemote && config.gatewayToken && (req.path.startsWith("/api/") || req.path === "/admin")) {
      if (!gatewayTokenMatches(requestGatewayToken(req), config.gatewayToken)) {
        res.status(401).json({ ok: false, error: { message: "缺少有效的网关令牌", code: "unauthorized" } });
        return;
      }
    }
    // 跨站请求防护：浏览器发起的写操作必须来自本地或 CORS 白名单
    if (!SAFE_METHODS.has(req.method)) {
      const origin = String(req.headers.origin || "");
      const site = String(req.headers["sec-fetch-site"] || "");
      // Edge/Chromium 把 localhost:3000 页面访问 127.0.0.1 网关记为 cross-site，但两端都是本机回环；
      // 白名单 Origin 同理放行。缺少 Origin 的跨站写请求和外部来源仍然拒绝。
      const trustedCrossSite = site === "cross-site" && Boolean(origin) && isAllowedOrigin(origin);
      if (!isAllowedOrigin(origin) || (site === "cross-site" && !trustedCrossSite)) {
        if (site === "cross-site") logger.warn(`拒绝跨站写请求 ${req.method} ${req.path} origin=${origin || "-"} sec-fetch-site=${site} ${req.id}`);
        res.status(403).json({ ok: false, error: { message: "跨站请求被拒绝" } });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  const upload = multer({
    storage: createBoundedMemoryStorage(config.maxTotalUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: 12 },
  });

  app.get("/health", async (_req, res) => {
    const reachable = await Promise.race([comfy.isReachable(), sleep(60000).then(() => false)]);
    const setupStatus = setup.status();
    const interrupted = await detectInterruptedUpdate(config).catch(() => ({ pending: false }));
    res.json({
      status: "ok",
      version: config.version,
      updateRecovery: interrupted.pending ? { pending: true, version: interrupted.version, files: interrupted.files?.length || 0 } : null,
      comfy: { url: comfy.baseUrl(), reachable },
      // 与设置页一致：hidden 的辅助工作流不计入可用性统计。
      workflows: { count: setupStatus.counts?.total || registry.list().length },
      setup: {
        phase: setupStatus.phase,
        counts: setupStatus.counts,
        instanceId: setupStatus.instanceId,
        scanId: setupStatus.scanId,
        revision: setupStatus.revision,
        scanning: setupStatus.scanning,
        stale: setupStatus.stale,
      },
      tasks: { count: tasks.list().length, retentionDays: config.taskRetentionDays, maxStoredTasks: config.maxStoredTasks },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/setup/status", (_req, res) => {
    // revision 是 SSE 变更序列号，setup.revision 是最近一次成功提交的扫描代际。
    res.json({ ok: true, status: setup.status(), comfyUrl: comfy.baseUrl(), revision: modelEvents.snapshot().revision });
  });

  app.get("/api/setup/diagnostics", async (req, res) => {
    const queryText = (value, field) => {
      if (value === undefined) return "";
      const raw = String(value).trim();
      if (!raw) return "";
      if (raw.length > 200) throw new HttpError(`${field} 过长`, { status: 400, code: "invalid_query" });
      return raw;
    };
    const workflowId = queryText(req.query.workflowId, "workflowId");
    const modelId = queryText(req.query.modelId, "modelId");
    const promptId = queryText(req.query.promptId, "promptId");
    if (promptId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(promptId)) {
      throw new HttpError("promptId 格式不合法", { status: 400, code: "invalid_prompt_id" });
    }

    const setupStatus = setup.status();
    let workflowEntry = null;
    if (workflowId) {
      workflowEntry = registry.resolve(workflowId);
      if (!workflowEntry) throw new HttpError(`工作流不存在：${workflowId}`, { status: 404, code: "workflow_not_found" });
    }
    let modelEntry = null;
    if (modelId) {
      const found = registry.resolveModel(modelId, setup.loaderOptions?.() || {});
      if (!found) throw new HttpError(`未找到模型：${modelId}`, { status: 404, code: "model_not_found" });
      modelEntry = found.entry;
    }

    let execution = null;
    if (promptId) {
      let history = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        history = await comfy.history(promptId, { signal: controller.signal });
      } catch (error) {
        throw new HttpError(`读取 ComfyUI 执行记录失败：${sanitizeDiagnosticText(error?.message || error)}`, { status: 502, code: "comfy_history_failed" });
      } finally {
        clearTimeout(timer);
      }
      if (!history) throw new HttpError(`未找到执行记录：${promptId}`, { status: 404, code: "prompt_not_found" });
      // 真实执行图在 history.prompt[2]；只提取已发现 loader spec 的精确 classType + input。
      const graph = Array.isArray(history.prompt) ? history.prompt[2] : history.prompt;
      const loaderPairs = diagnosticLoaderPairs(setup);
      const nodes = [];
      for (const [nodeId, node] of Object.entries(graph && typeof graph === "object" ? graph : {})) {
        if (!node?.class_type) continue;
        const classType = String(node.class_type);
        const fields = {};
        for (const [key, value] of Object.entries(node.inputs || {})) {
          if (!loaderPairs.has(`${classType}\u0000${key}`)) continue;
          if (typeof value !== "string" || !value) continue;
          fields[key] = sanitizeModelValue(value);
        }
        if (Object.keys(fields).length) nodes.push({ nodeId, classType, fields });
      }
      execution = {
        promptId,
        status: sanitizeDiagnosticText(history.status?.status_str || ""),
        completed: history.status?.completed === true,
        nodes,
      };
    }

    const evidenceEntry = modelEntry || workflowEntry;
    const evidenceStatus = evidenceEntry ? setup.workflowStatus(evidenceEntry.id) : null;
    res.json({
      ok: true,
      version: config.version,
      generatedAt: nowIso(),
      comfy: {
        url: sanitizeComfyUrl(comfy.baseUrl()),
        reachable: setupStatus.comfyReachable === true,
      },
      setup: {
        instanceId: setupStatus.instanceId || "",
        scanId: setupStatus.scanId ?? 0,
        revision: setupStatus.revision ?? 0,
        phase: setupStatus.phase,
        scanning: setupStatus.scanning === true,
        stale: setupStatus.stale === true,
        comfyReachable: setupStatus.comfyReachable === true,
        scannedAt: setupStatus.scannedAt || null,
        counts: setupStatus.counts || { available: 0, unavailable: 0, total: 0 },
        lastError: setupStatus.lastError ? sanitizeDiagnosticText(setupStatus.lastError) : null,
        problems: setupProblemSummary(setupStatus),
      },
      workflow: workflowEntry ? diagnosticWorkflow(workflowEntry, setup, setup.workflowStatus(workflowEntry.id), { workflowVisibility }) : null,
      model: modelEntry
        ? {
            id: modelId,
            workflowId: evidenceEntry.id,
            ...diagnosticWorkflow(evidenceEntry, setup, evidenceStatus, { workflowVisibility }),
          }
        : null,
      execution,
      links: { models: "/v1/models", status: "/api/setup/status", events: "/api/models/events" },
    });
  });

  app.post("/api/setup/model-alias", async (req, res) => {
    try {
      const status = await setup.setModelAlias(req.body || {});
      res.json({ ok: true, status });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.get("/api/resources/status", (_req, res) => {
    res.json(resources.status());
  });

  app.post("/api/resources/pick-replacement", async (req, res) => {
    try {
      const file = await resources.pickResourceReplacement(String(req.body?.resourceId || ""));
      res.json({ ok: true, file });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.post("/api/resources/replacement", async (req, res) => {
    try {
      const status = await resources.setResourceReplacement(String(req.body?.resourceId || ""), String(req.body?.file || ""));
      res.json({ ok: true, status });
    } catch (error) {
      res.status(error?.status || 400).json({ ok: false, error: { message: error?.message || String(error) } });
    }
  });

  app.post("/api/resources/install", (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const packs = Array.isArray(req.body?.packs) ? req.body.packs : [];
      if (!ids.length && !packs.length) throw new Error("请选择要安装的资源或功能包");
      res.json({ ok: true, job: resources.install({ ids, packs }) });
    } catch (error) {
      res.status(400).json({ ok: false, error: { message: error.message } });
    }
  });

  app.get("/api/resources/jobs/:id", (req, res) => {
    const job = resources.getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: { message: "任务不存在" } });
    res.json({ ok: true, job });
  });

  app.post("/api/resources/jobs/:id/cancel", (req, res) => {
    const job = resources.cancelJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: { message: "任务不存在" } });
    res.json({ ok: true, job });
  });

  app.post("/api/resources/refresh", async (_req, res) => {
    try {
      res.json(await resources.refresh());
    } catch (error) {
      res.status(500).json({ ok: false, error: { message: error.message } });
    }
  });

  app.post("/api/resources/packs/:id/main-model", async (req, res) => {
    try {
      res.json({ ok: true, status: await resources.setMainModel(req.params.id, req.body?.file) });
    } catch (error) {
      res.status(400).json({ ok: false, error: { message: error.message } });
    }
  });

  app.get("/api/skin-unlocks", (_req, res) => {
    res.json({ ok: true, unlocked: skinUnlocks.list(), entries: skinUnlocks.entries() });
  });

  app.post("/api/skin-unlocks", async (req, res) => {
    const entry = await skinUnlocks.unlock(req.body?.skinId);
    res.json({ ok: true, unlocked: skinUnlocks.list(), entry });
  });

  app.get("/api/loras", (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const loras = setup.loraNames().filter((name) => !q || name.toLowerCase().includes(q));
    res.json({ ok: true, loras });
  });

  app.get("/api/system/stats", async (_req, res) => {
    const stats = await readSystemStats();
    const setupStatus = setup.status();
    const taskOOM = tasks.list().find((task) => /out of memory|CUDA OOM|\bOOM\b|allocation on device/i.test(task.error || ""));
    res.json({
      ok: true,
      ...stats,
      comfy: { url: comfy.baseUrl(), reachable: setupStatus.comfyReachable },
      setup: { phase: setupStatus.phase, counts: setupStatus.counts, scannedAt: setupStatus.scannedAt },
      restartAvailable: Boolean(config.launcherControlUrl),
      lastOOM: lastOOM || (taskOOM ? { at: taskOOM.completedAt, message: taskOOM.error } : null),
    });
  });

  app.post("/api/system/free-memory", async (_req, res) => {
    if (!setup.status().comfyReachable) {
      throw new HttpError("ComfyUI 当前不可达，无法清理显存", { status: 503, code: "comfy_unreachable" });
    }
    const before = await readSystemStats({ cacheMs: 0 });
    const started = Date.now();
    await comfy.freeMemory();
    const beforeVram = before.gpu?.[0]?.memoryUsedMb || 0;
    let after = before;
    let lastVram = beforeVram;
    let stable = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await readSystemStats({ cacheMs: 0 });
      const used = after.gpu?.[0]?.memoryUsedMb || 0;
      if (beforeVram === 0 || used <= Math.max(0, beforeVram - 256)) break;
      stable = Math.abs(used - lastVram) <= 8 ? stable + 1 : 0;
      lastVram = used;
      if (stable >= 2 && Date.now() - started >= 900) break;
    }
    const afterVram = after.gpu?.[0]?.memoryUsedMb || 0;
    const freedRamBytes = Math.max(0, before.ram.usedBytes - after.ram.usedBytes);
    res.json({
      ok: true,
      before,
      after,
      freedVramMb: Math.max(0, beforeVram - afterVram),
      freedRamBytes,
      durationMs: Date.now() - started,
    });
  });

  app.get("/api/update/check", async (req, res) => {
    const fetchRemote = req.query.fetch === "1" || req.query.fetch === "true";
    res.json(await checkForUpdate(config, { fetchRemote }));
  });

  app.get("/api/update/progress", (_req, res) => {
    res.json({ ok: true, progress: getUpdateProgress() });
  });

  app.get("/api/update/recovery", async (_req, res) => {
    const { backupDir: _backupDir, ...info } = await detectInterruptedUpdate(config);
    res.json({ ok: true, ...info });
  });

  app.post("/api/update/recovery/restore", async (_req, res) => {
    res.json({ ok: true, ...(await restoreInterruptedUpdate(config)) });
  });

  app.post("/api/update/apply", async (req, res) => {
    const active = tasks.list().some((task) => ["queued", "running"].includes(task.status));
    if (active) {
      throw new HttpError("有正在运行的生成任务，请等待完成或取消后再更新", { status: 409, code: "tasks_running" });
    }
    res.json(await applyUpdate(config, { dryRun: req.body?.dryRun === true, force: req.body?.force === true }));
  });

  app.post("/api/system/restart-comfy", async (_req, res) => {
    if (!config.launcherControlUrl) {
      throw new HttpError("启动器未运行，无法自动重启 ComfyUI", { status: 503, code: "launcher_unavailable" });
    }
    try {
      const response = await fetch(`${config.launcherControlUrl}/restart-comfy`, {
        method: "POST",
        signal: AbortSignal.timeout(360000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new HttpError(data.error || "重启 ComfyUI 失败", { status: 502, code: "restart_failed", details: data });
      }
      lastOOM = null;
      res.json(data);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(`无法联系启动器：${error.message}`, { status: 503, code: "launcher_unreachable" });
    }
  });

  app.post("/api/system/shutdown", (req, res) => {
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      throw new HttpError("仅允许本机发起关停请求", { status: 403, code: "shutdown_forbidden" });
    }
    if (typeof app.locals.requestShutdown !== "function") {
      throw new HttpError("当前网关不是由启动器托管的主进程，无法自动关停", { status: 409, code: "shutdown_unavailable" });
    }
    res.json({ ok: true });
    setTimeout(() => app.locals.requestShutdown(), 30);
  });

  app.post("/api/agent/provider", (req, res) => {
    if (!isLoopbackPeer(req.socket.remoteAddress)) {
      throw new HttpError("仅允许本机同步 Agent API", { status: 403, code: "provider_forbidden" });
    }
    const origin = String(req.headers.origin || "");
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).hostname.toLowerCase();
      } catch {}
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
        throw new HttpError("仅允许本机 origin 同步 Agent API", { status: 403, code: "provider_origin_forbidden" });
      }
    }
    const value = req.body && typeof req.body === "object" ? req.body : {};
    const providerFile = path.join(config.appRoot, "assistant", "agent-provider.json");
    if (value.clear === true) {
      fs.rmSync(providerFile, { force: true });
      logger.info?.("Agent provider cleared");
      res.json({ ok: true, cleared: true });
      return;
    }
    let baseUrl = "";
    try {
      const parsed = new URL(String(value.baseUrl || "").trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      baseUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new HttpError("API 地址无效（只支持 http/https）", { status: 400, code: "provider_base_url_invalid" });
    }
    const apiKey = String(value.apiKey || "").trim();
    const model = String(value.model || "").trim();
    const label = String(value.label || "").trim();
    if (!apiKey) throw new HttpError("缺少 API Key", { status: 400, code: "provider_key_missing" });
    if (!model) throw new HttpError("缺少 API 模型", { status: 400, code: "provider_model_missing" });
    fs.mkdirSync(path.dirname(providerFile), { recursive: true });
    const temp = `${providerFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ baseUrl, apiKey, model, label, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, providerFile);
    logger.info?.("Agent provider updated (key redacted)");
    res.json({ ok: true, model, label });
  });

  app.get("/api/assistant/status", async (_req, res) => {
    res.json(await assistant.status());
  });

  app.post("/api/assistant/ensure", async (req, res) => {
    const result = await assistant.ensure({ download: req.body?.download === true });
    if (!result.ok) {
      const payload = {
        ...result,
        ok: false,
        state: result.state || "failed",
        starting: false,
        online: false,
        error: result.error || result.reason || "Agent 服务启动失败",
        guide: result.guide || (result.needFullPackage
          ? result.canRepair ? "点右上角「重新解压」修复 Agent 运行时。" : result.canDownload ? "点「下载完整包」自动下载并解压 Agent 运行时。" : result.fullPackageUrl ? "打开完整包下载页，取出 assistant-runtime.zip 放到程序根目录后重启应用。" : "请安装包含 assistant-runtime 的完整包后重启应用。"
          : "检查网关日志中的 Agent 启动错误；修复后重新点击拉起。"),
      };
      res.status(result.needFullPackage ? 409 : 503).json(payload);
      return;
    }
    res.json(result);
  });

  app.post("/api/assistant/stop", async (_req, res) => {
    res.json(await assistant.stop("api-request"));
  });

  app.post("/api/setup/scan", (_req, res) => {
    void setup.scan().catch((error) => logger.warn(`manual setup scan failed: ${error.message}`));
    res.json({ ok: true, status: setup.status() });
  });

  async function setLauncherComfyDir(dir) {
    if (config.launcherControlUrl) {
      try {
        const response = await fetch(`${config.launcherControlUrl}/set-comfy-dir`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir }),
        });
        if (response.ok) return true;
        logger.warn(`启动器拒绝更新 ComfyUI 目录：HTTP ${response.status}`);
      } catch (error) {
        logger.warn(`通知启动器更新 ComfyUI 目录失败：${error.message}`);
      }
    }
    try {
      const file = path.join(config.appRoot, "launcher", "config.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {};
      data.comfyDir = dir;
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      return true;
    } catch (error) {
      logger.warn(`写入 launcher/config.json 失败：${error.message}`);
      return false;
    }
  }

  let pickerBusy = false;

  app.post("/api/setup/pick-directory", async (req, res) => {
    if (config.allowRemote) throw new HttpError("远程模式不支持原生目录选择，请手动输入路径", { status: 400, code: "picker_remote_disabled" });
    if (process.platform !== "win32" && !process.env.FOLDER_PICKER_FAKE) {
      throw new HttpError("当前系统不支持原生目录选择，请手动输入路径", { status: 400, code: "picker_unsupported" });
    }
    if (pickerBusy) throw new HttpError("已有目录选择窗口打开，请先完成或取消", { status: 409, code: "picker_busy" });
    pickerBusy = true;
    try {
      const result = await pickFolder({
        title: String(req.body?.title || "选择文件夹"),
        initial: String(req.body?.initial || ""),
      });
      res.json({ ok: true, ...result });
    } finally {
      pickerBusy = false;
    }
  });

  app.get("/api/setup/directories", (_req, res) => {
    const liveRoot = resources.comfyRoot?.() || config.comfyDir || "";
    const settings = setup.getDirectorySettings();
    const auto = describeAutoDirectories({ comfyRoot: liveRoot, workflowsDir: config.comfyWorkflowsDir });
    const setupStatus = setup.status();
    const loadReport = directoryLoadReport(settings, { comfyRoot: liveRoot, folderPaths: setup.folderPaths?.() || {} });
    res.json({
      ok: true,
      settings,
      comfyRoot: liveRoot,
      auto,
      loadReport,
      setup: { phase: setupStatus.phase, counts: setupStatus.counts, comfyReachable: setupStatus.comfyReachable },
    });
  });

  app.post("/api/setup/directories/scan", (req, res) => {
    const settings = normalizeDirectorySettings({ ...(req.body || {}), mode: "manual" });
    const validation = validateDirectorySettings(settings);
    if (!validation.ok) throw new HttpError(validation.errors.join("；"), { status: 400, code: "invalid_directories", details: validation.errors });
    res.json({ ok: true, scan: scanDirectories(settings), validation });
  });

  app.post("/api/setup/directories", async (req, res) => {
    const body = req.body || {};
    const settings = normalizeDirectorySettings({ ...body, mode: body.mode === "auto" ? "auto" : "manual" });
    const validation = validateDirectorySettings(settings);
    if (!validation.ok) throw new HttpError(validation.errors.join("；"), { status: 400, code: "invalid_directories", details: validation.errors });
    const previous = setup.getDirectorySettings();
    const liveRootBefore = resources.comfyRoot?.() || setup.comfyRootForScan() || config.comfyDir;
    const saved = await saveDirectorySettings(config.dataDir, settings);
    setup.setDirectorySettings(saved);
    const liveRoot = liveRootBefore;
    const manualRoot = saved.mode === "manual" && saved.comfyDir ? detectComfyLayout(saved.comfyDir)?.root || saved.comfyDir : "";
    const targetRoot = manualRoot || liveRoot;
    const yamlSettings = saved.mode === "manual" ? saved : { ...saved, modelDirs: [], loraDirs: [], customNodesDirs: [] };
    const write = writeManagedExtraPaths(targetRoot, yamlSettings);
    resources.invalidate?.();
    // 换目录或切回自动时，把旧目录里的托管块也清掉，避免以后又切回去时残留旧路径。
    if (previous.mode === "manual" && previous.comfyDir && previous.comfyDir !== saved.comfyDir) {
      const previousRoot = detectComfyLayout(previous.comfyDir)?.root || previous.comfyDir;
      if (previousRoot !== targetRoot) {
        writeManagedExtraPaths(previousRoot, { ...previous, modelDirs: [], loraDirs: [], customNodesDirs: [] });
      }
    }
    const launcherUpdated = saved.mode === "manual" && saved.comfyDir ? await setLauncherComfyDir(saved.comfyDir) : false;
    const scan = scanDirectories(saved);
    // 用 live 的 folder_paths 判断是否已在 ComfyUI 清单里，避免用上次扫描的旧结果误报“需重启”。
    const liveFolderPaths = await comfy.folderPaths().catch(() => setup.folderPaths?.() || {});
    const loadReport = directoryLoadReport(saved, { comfyRoot: liveRootBefore, folderPaths: liveFolderPaths });
    const restartRequired = saved.mode === "manual" && (loadReport.restartRequired || Boolean(write.changed));
    await setup.scan("directories").catch((error) => logger.warn(`directory settings rescan failed: ${error.message}`));
    res.json({
      ok: true,
      settings: saved,
      comfyRoot: targetRoot,
      write,
      scan,
      loadReport,
      launcherUpdated,
      restartRequired,
      note: saved.mode === "auto"
        ? "已切回自动识别，手动目录已从 extra_model_paths.yaml 移除。"
        : restartRequired
          ? "新目录不在 ComfyUI 当前清单中；已写入 extra_model_paths.yaml，重启 ComfyUI 后生效，资源卡与工作流可用性也会在重启后刷新。"
          : "目录已在 ComfyUI 当前清单中，无需重启；已重新扫描，资源卡会直接更新。",
    });
  });

  app.post("/api/session/open", (req, res) => {
    res.json({ ok: true, ...sessions.touch(req.body?.id) });
  });

  app.post("/api/session/heartbeat", (req, res) => {
    res.json({ ok: true, ...sessions.touch(req.body?.id) });
  });

  app.post("/api/session/close", (req, res) => {
    res.json({ ok: true, ...sessions.close(req.body?.id) });
  });

  app.get("/api/session/status", (_req, res) => {
    const activeTasks = tasks.list().filter((task) => task.status === "queued" || task.status === "running").length;
    res.json({ ok: true, ...sessions.status(), activeTasks });
  });

  app.post("/api/requests/:id/cancel", (req, res) => {
    const controller = activeRequests.get(String(req.params.id || ""));
    if (controller) controller.abort("client-cancel");
    res.json({ ok: true, cancelled: Boolean(controller) });
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(config.rootDir, "src", "admin.html"));
  });

  app.get("/api/tasks", (req, res) => {
    res.json({
      tasks: tasks.list().slice(0, 50).map((task) => ({
        ...task,
        url: task.url ? absoluteTaskUrl(config, req, task.url) : null,
      })),
    });
  });

  app.get("/api/models/events", (req, res) => {
    modelEvents.subscribe(req, res);
  });

  app.get("/v1/models", async (_req, res) => {
    await reloadRegistryAndSnapshot();
    const status = setup.status();
    const degraded = status.phase === "degraded";
    const data = registry
      .listModels((setup.loaderOptions?.() || {}))
      .filter((model) => (setup.isAvailable(model.baseId) || (degraded && setup.isKnownAvailable?.(model.baseId))) && !model.entry.hidden && model.entry.category !== "upscale" && !workflowVisibility.isHidden(model.entry.id))
      .map((model) => ({
        id: model.modelId,
        object: "model",
        created: 0,
        owned_by: "local-comfyui",
        metadata: {
          type: model.entry.type,
          workflowId: model.entry.id,
          label: model.entry.baseModel
            ? `${model.entry.label || model.entry.name} · ${model.entry.baseModelLabel || "variant"}`
            : model.entry.label || model.entry.name,
          baseModel: model.entry.baseModel || null,
          baseModelLabel: model.entry.baseModelLabel || null,
          imageInputs: imageInputCapacity(model.entry),
          description: model.entry.description || "",
          variantModes: model.entry.variants ? Object.keys(model.entry.variants) : [],
          variantLabels: model.entry.variantLabels || {},
          defaultMode: model.entry.defaultMode || null,
          parameters: enrichParameters(model.entry.parameters),
          resolutionTiers: model.entry.resolutionTiers || null,
          defaultTier: model.entry.defaultTier || null,
          availability: setup.workflowStatus(model.baseId),
          ...(model.baseId === MOSS_MODEL_ID
            ? (() => {
                const availability = setup.workflowStatus(model.baseId);
                return { moss: { tiers: availability.tiers || {}, precision: availability.precision || {} } };
              })()
            : {}),
        },
      }));
    res.json({ object: "list", revision: modelEvents.snapshot().revision, setup: setupSyncSummary(status), data });
  });

  app.get("/api/workflows", async (_req, res) => {
    await reloadRegistryAndSnapshot();
    res.json({
      workflows: registry.list().map((entry) => ({
        ...entry,
        enabled: entry.hidden !== true && !workflowVisibility.isHidden(entry.id),
        availability: setup.workflowStatus(entry.id),
      })),
    });
  });

  app.post("/api/workflows/:id/visibility", async (req, res) => {
    const entry = registry.resolve(req.params.id);
    if (!entry) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    if (entry.hidden) throw new HttpError("该工作流由内置规则隐藏，不能修改", { status: 400, code: "workflow_internal" });
    const enabled = req.body?.enabled !== false;
    await workflowVisibility.setHidden(entry.id, !enabled);
    logger.info(`workflow visibility ${entry.id} -> ${enabled ? "enabled" : "hidden"}`);
    emitModelChange("visibility");
    res.json({ ok: true, id: entry.id, enabled });
  });

  app.get("/api/workflows/:id", (req, res) => {
    const entry = registry.resolve(req.params.id);
    if (!entry) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    res.json({ workflow: registry.publicEntry(entry), schema: registry.schema(entry) });
  });

  app.get("/api/workflows/:id/schema", (req, res) => {
    const found = registry.resolveModel(req.params.id, (setup.loaderOptions?.() || {}));
    if (!found) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    const schema = registry.schema(found.entry);
    res.json({ schema: { ...schema, parameters: enrichParameters(schema.parameters) } });
  });

  app.get("/api/upscale/workflows", (_req, res) => {
    const workflows = registry
      .list()
      .filter((entry) => entry.category === "upscale" && entry.type === "image")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        label: entry.label || entry.name,
        description: entry.description || "",
        available: setup.isAvailable(entry.id),
        problems: setup.workflowStatus(entry.id).problems || [],
        parameters: enrichParameters(entry.parameters),
      }));
    res.json({ workflows });
  });

  app.post("/api/workflows/import", async (req, res) => {
    const result = await registry.importWorkflow(req.body || {});
    await setup.scan("registry-import");
    logger.info(`imported workflow ${result.workflow.name} (${result.workflow.type})`);
    res.status(201).json({ ok: true, ...result });
  });

  app.post("/api/workflows/scan", async (_req, res) => {
    const result = await registry.scan();
    await setup.scan("registry-scan");
    res.json({ ok: true, ...result });
  });

  app.post("/api/workflows/reload", async (_req, res) => {
    await registry.load();
    await setup.scan("registry-reload");
    res.json({ ok: true, count: registry.list().length });
  });

  app.delete("/api/workflows/:id", async (req, res) => {
    const removed = await registry.remove(req.params.id);
    if (!removed) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    // 只移除注册记录，不删除用户工作流文件；本次事件后列表立即更新。
    emitModelChange("registry-remove");
    res.json({ ok: true });
  });

  const requireFreeWorkflow = (id) => {
    const entry = freeWorkflows.get(id);
    if (!entry) throw new HttpError("自由卡片不存在", { status: 404, code: "free_workflow_not_found" });
    return entry;
  };

  app.get("/api/free-workflows/sources", async (_req, res) => {
    const resolved = await resolveFreeWorkflowsDir();
    res.json({
      sources: await freeWorkflows.listSources(),
      dir: resolved.dir || config.comfyWorkflowsDir || "",
      comfyDir: config.comfyDir || "",
      tried: resolved.tried,
    });
  });

  app.get("/api/free-workflows", async (req, res) => {
    const archived = req.query.archived === "1" || req.query.archived === "true";
    res.json({ workflows: await freeWorkflows.list({ archived }) });
  });

  app.post("/api/free-workflows/import", async (req, res) => {
    await resolveFreeWorkflowsDir();
    const relative = String(req.body?.path || "").trim();
    if (!relative) throw new HttpError("缺少工作流路径", { status: 400, code: "missing_workflow_path" });
    try {
      const entry = await freeWorkflows.importSource(relative);
      res.status(201).json({ workflow: await freeWorkflows.publicEntry(entry) });
    } catch (error) {
      throw new HttpError(`导入工作流失败：${error.message}`, { status: 400, code: "free_workflow_import_failed", details: error.details });
    }
  });

  app.get("/api/free-workflows/:id", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.post("/api/free-workflows/:id/snapshots", async (req, res) => {
    const entry = await freeWorkflows.createSnapshot(req.params.id, req.body || {});
    res.status(201).json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.get("/api/free-workflows/:id/snapshot", async (req, res) => {
    const snapshot = freeWorkflows.getSnapshot(req.params.id);
    if (!snapshot) throw new HttpError("归档快照不存在", { status: 404, code: "free_workflow_snapshot_not_found" });
    res.json(snapshot);
  });

  app.get("/api/free-workflows/:id/ui", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    try {
      res.json(await freeWorkflows.readRawWorkflow(entry));
    } catch (error) {
      const message = /ENOENT/.test(String(error.message)) ? "源工作流文件已不存在，可能已在 ComfyUI 中删除" : error.message;
      throw new HttpError(`读取工作流失败：${message}`, { status: 409, code: "free_workflow_read_failed" });
    }
  });

  app.get("/api/free-workflows/:id/graph", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    res.json({ ...(await freeWorkflows.graph(entry, String(req.query.flowId || ""))), comfyUrl: comfy.baseUrl() });
  });

  // Agent G3/G4 只读体检：不提交 /prompt。
  app.get("/api/free-workflows/:id/health", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    res.json(await freeWorkflows.health(entry, String(req.query.flowId || "")));
  });

  // Agent G6 干跑：组装并校验请求体，不提交 ComfyUI。
  app.post("/api/free-workflows/:id/validate", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    res.json(await freeWorkflows.validate(entry, req.body || {}));
  });

  app.put("/api/free-workflows/:id/params", async (req, res) => {
    const entry = await freeWorkflows.setParams(req.params.id, req.body?.params ?? req.body?.fields);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.get("/api/free-workflows/:id/open", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    const source = await freeWorkflows.sourceState(entry);
    if (!source.exists) throw new HttpError("源工作流文件已不存在，无法在 ComfyUI 中编辑", { status: 409, code: "free_workflow_source_missing" });
    const bridge = await comfyBridge.ensure();
    const target = new URL(comfy.baseUrl());
    target.searchParams.set("local_canvas_open", entry.id);
    target.searchParams.set("local_canvas_gw", `${req.protocol}://${req.get("host")}`);
    res.json({
      url: target.toString(),
      name: entry.name,
      sourceRel: entry.sourceRel,
      sourceFormat: entry.sourceFormat,
      bridge: Boolean(bridge.installed),
      bridgeReason: bridge.installed ? undefined : bridge.reason,
    });
  });

  app.post("/api/free-workflows/:id/sync", async (req, res) => {
    try {
      const result = await freeWorkflows.sync(req.params.id, String(req.query.force || "") === "1");
      res.json({ changed: result.changed, workflow: await freeWorkflows.publicEntry(result.entry) });
    } catch (error) {
      throw new HttpError(`同步工作流失败：${error.message}`, { status: 409, code: "free_workflow_sync_failed" });
    }
  });

  app.patch("/api/free-workflows/:id", async (req, res) => {
    const body = req.body || {};
    const entry =
      body.name !== undefined
        ? await freeWorkflows.rename(req.params.id, body.name)
        : await freeWorkflows.setArchived(req.params.id, Boolean(body.archived), body.preset);
    res.json({ workflow: await freeWorkflows.publicEntry(entry) });
  });

  app.delete("/api/free-workflows/:id", async (req, res) => {
    const entry = await freeWorkflows.remove(req.params.id);
    if (!entry) throw new HttpError("自由卡片不存在", { status: 404, code: "free_workflow_not_found" });
    res.json({ ok: true, id: entry.id });
  });

  let audioJobActive = null;
  const sendAudio = (res, req, result) => {
    const format = String(req.body?.response_format || "").toLowerCase();
    if (format === "b64_json") return res.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: result.buffer.toString("base64") }] });
    res.set("Content-Type", result.mimeType);
    return res.send(result.buffer);
  };

  app.post("/v1/audio/speech", upload.any(), async (req, res) => {
    const body = req.body || {};
    const referenceFile = (req.files || []).find((f) => f?.buffer && /reference|audio/i.test(f.fieldname));
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await synthesizeSpeech({
        comfy, config, logger,
        text: String(body.input || ""),
        seed: body.seed != null ? Number(body.seed) : undefined,
        speed: body.speed != null ? Number(body.speed) : undefined,
        instructions: String(body.instructions || ""),
        referenceFile,
        signal: abort.signal, requestId: req.id,
      });
      return sendAudio(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally { abort.cleanup(); }
  });

  app.post("/v1/audio/speech-h3", async (req, res) => {
    const body = req.body || {};
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await synthesizeSpeechH3({
        comfy, config, logger,
        text: String(body.input || body.text || body.prompt || ""),
        voiceDescription: String(body.voice_description || ""),
        instructions: String(body.instructions || ""),
        language: String(body.language || "zh"),
        seed: body.seed != null ? Number(body.seed) : undefined,
        signal: abort.signal, requestId: req.id,
      });
      return sendAudio(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally { abort.cleanup(); }
  });

  app.post("/v1/audio/song", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = req.files || [];
    const reference = files.find((file) => file?.buffer && /reference|audio/i.test(file.fieldname || ""));
    if (reference) {
      throw new HttpError("YuE2 写歌不支持参考音色；参考音色仅用于换声", { status: 400, code: "unsupported_reference_audio" });
    }
    const rawPrecision = String(body.precision ?? "").trim().toLowerCase();
    let bf16Installed = null;
    if (rawPrecision === "quality") {
      try {
        const bf16 = resources.status()?.resources?.find((item) => item.id === "yue2_3b_bf16");
        if (bf16) bf16Installed = Boolean(bf16.present);
      } catch {
        bf16Installed = null;
      }
    }
    let yue2Precision;
    try {
      yue2Precision = resolveYue2Precision(body.precision, { envCheckpoint: process.env.YUE2_COMFY_CHECKPOINT, bf16Installed });
    } catch (error) {
      throw new HttpError(error.message, { status: error.status || 400, code: error.code || "invalid_precision", details: error.details });
    }
    const { precision, checkpoint } = yue2Precision;
    const audioModelMissing = () => new HttpError(
      precision === "quality"
        ? "YuE2 质量档模型未就绪：请到资源中心安装 YuE2-3B BF16（yue2_3b_bf16.safetensors）后重试。"
        : "YuE2 模型/节点未就绪：请确认 ComfyUI 0.44+ 已安装原生 YuE2 节点，并把 yue2_3b_int8_convrot.safetensors 放到 models/checkpoints（CC BY-NC 4.0，资源中心/官方下载）。",
      { status: 503, code: "audio_model_missing", details: { engine: "comfyui", ...(precision === "quality" ? { resourceId: "yue2_3b_bf16" } : {}) } },
    );
    const lyrics = String(body.lyrics || body.input || body.prompt || "").trim();
    const instrumentalFlag = body.instrumental;
    const flagOff = instrumentalFlag === false || /^(false|0)$/i.test(String(instrumentalFlag ?? ""));
    const instrumental = !flagOff && (/^(true|1)$/i.test(String(instrumentalFlag ?? "")) || !lyrics);
    if (!instrumental) {
      if (!lyrics) throw new HttpError("缺少歌词或主题", { status: 400, code: "missing_prompt" });
      if (!/\[Verse\]/.test(lyrics) || !/\[Chorus\]/.test(lyrics)) {
        throw new HttpError("YuE2 歌词需要 [Verse] 和 [Chorus] 段落；请先让 AI 写词或按官方格式补齐", { status: 400, code: "invalid_lyrics" });
      }
    }
    const candidates = Math.min(2, Math.max(1, Math.trunc(Number(body.candidates ?? body.best_of ?? 1)) || 1));
    if (candidates > 1) {
      throw new HttpError("双候选 PER 选择尚未接入；本轮默认单候选（GPU 成本约 2 倍）", { status: 400, code: "best_of_unavailable", details: { candidates } });
    }
    const rawDuration = body.duration;
    const durationText = String(rawDuration ?? "").trim().toLowerCase();
    const durationAuto = rawDuration === undefined || rawDuration === null || durationText === "" || durationText === "auto" || Number(rawDuration) === 0 || !Number.isFinite(Number(rawDuration));
    const resolvedDuration = durationAuto ? (instrumental ? 200 : autoSongDuration(lyrics)) : Math.min(300, Math.max(10, Math.round(Number(rawDuration))));
    if (!durationAuto && !instrumental) {
      const lyricsIssue = lyricsDurationIssue(lyrics, resolvedDuration);
      if (lyricsIssue) {
        throw new HttpError(lyricsIssue.message, { status: 400, code: "invalid_lyrics_duration", details: lyricsIssue });
      }
    }
    const rawStyle = String(body.tags || body.style || body.input || body.prompt || "").trim();
    const genderRaw = String(body.gender ?? body.vocalGender ?? "").trim().toLowerCase();
    const genderMap = { male: "male", female: "female", 男: "male", 女: "female" };
    if (genderRaw && !genderMap[genderRaw]) {
      throw new HttpError("gender 只支持 male / female（男 / 女）", { status: 400, code: "invalid_gender" });
    }
    const gender = genderMap[genderRaw] || "";
    const style = buildSongStyle({
      tags: rawStyle,
      gender,
      bpm: body.bpm,
      language: body.language,
      keyscale: body.keyscale,
      instrumental,
    });
    const seedValue = Number(body.seed);
    if (audioJobActive) throw new HttpError("已有音频任务在跑，请稍后再试", { status: 409, code: "audio_busy" });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      // YuE2 走 --low-vram 动态 offload（只保留当前活跃模块在显存），不再用显存余额硬拒。
      if (abort.signal.aborted) return;
      audioJobActive = "song";
      let result;
      try {
        result = await runYue2ComfySong({
          comfy,
          config,
          logger,
          style,
          lyrics,
          seed: Number.isFinite(seedValue) ? seedValue : undefined,
          cot: String(body.cot || "full"),
          duration: resolvedDuration,
          signal: abort.signal,
          requestId: req.id,
          checkpoint,
          instrumental,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const messageText = String(error?.message || error || "");
        const nodeHint = /YuE2InstrumentalConvert|does not exist|node .*not|not found/i.test(messageText);
        const modelHint = /yue2|checkpoint|value not in list|missing/i.test(messageText);
        if (instrumental) {
          if (nodeHint) {
            throw new HttpError("纯音乐转换节点未加载：请重启 ComfyUI 让 YuE2 Instrumental Convert 节点生效（随应用安装）。", { status: 503, code: "audio_instrumental_node_missing", details: { engine: "comfyui" } });
          }
          if (modelHint) {
            throw audioModelMissing();
          }
          throw error;
        }
        if (modelHint) {
          throw audioModelMissing();
        }
        throw error;
      }
      return sendAudio(res, req, result);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally {
      audioJobActive = null;
      abort.cleanup();
    }
  });

  app.post("/v1/free-workflows/:id/images", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    if (entry.bindings?.outputType !== "image") {
      throw new HttpError("这个自由卡片不是图片工作流", { status: 400, code: "free_workflow_not_image" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    const texts = parseFreeTexts(body.texts);
    const primaryText = parsePrimaryText(body.primaryText);
    const flow = await freeWorkflows.resolveFlow(entry, parseFreeTexts(body.enableGroups), String(body.flowId || ""));
    const effectivePrompt = freeEffectivePrompt({ bindings: flow.bindings }, texts, prompt, primaryText);
    const promptBinding = primaryText || flow.bindings?.prompt;
    if (promptBinding && !effectivePrompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const maskFile = (req.files || []).find((file) => file?.buffer && file.fieldname === "mask");
    const maskImage = maskFile ? (await uploadImages(comfy, [maskFile]))[0] : undefined;
    const parsedSize = parseSize(body.size);
    let workflow = applyFreeInputs(flow.workflow, flow.bindings, {
      prompt: effectivePrompt,
      texts,
      uploadedImages,
      maskImage,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
      bypassStages: parseFreeTexts(body.bypassStages),
      keepOutputs: flow.outputs,
      primaryText,
    });
    workflow = applyFreeFields(workflow, flow.page ? normalizeFreeFields(parseFreeTexts(body.fields)) : entry.params || [], parseParams(body.params));
    const loras = parseFreeTexts(body.loras);
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry: { name: entry.name, type: "image", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt: effectivePrompt, count: 1, params: { loras } }),
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        loraCatalog: setup.loraNames(),
        includePreviewOutputs: true,
        logger,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`free image ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const imageFiles = result.files.filter((file) => /^image\//i.test(file.mimeType) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.filename));
    const classified = classifyFreeWorkflowOutputs(imageFiles, {
      flowOutputs: flow.outputs?.length ? flow.outputs : freeWorkflowOutputOrder(entry, flow.page),
      nodeTitles: freeWorkflowNodeTitles(result.workflow),
      workflow: result.workflow,
    });
    if (!classified.selectedFiles.length) {
      throw new HttpError("自由工作流没有返回可展示的图片输出", { status: 502, code: "no_media_outputs", details: { warnings: classified.warnings } });
    }
    logger.info(`free image ${entry.name} -> ${result.promptId} (${classified.selectedFiles.length} file(s), ${classified.outputs.length} output node(s)${classified.previewFallback ? ", preview fallback" : ""}) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const encoded = new Map();
    const encodeFile = async (file) => {
      if (encoded.has(file)) return encoded.get(file);
      let payload;
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        payload = { url: absoluteTaskUrl(config, req, saved.url) };
      } else {
        payload = { b64_json: file.buffer.toString("base64") };
      }
      encoded.set(file, payload);
      return payload;
    };
    const data = [];
    for (const file of classified.selectedFiles) data.push(await encodeFile(file));
    const outputs = [];
    for (const output of classified.outputs) {
      const entries = [];
      for (const file of output.files) {
        const payload = await encodeFile(file);
        entries.push({ filename: file.filename, subfolder: file.subfolder || "", mimeType: file.mimeType, ...payload });
      }
      outputs.push({ nodeId: output.nodeId, title: output.title, type: output.type, preview: output.preview, kind: output.kind, entries });
    }
    res.json({ created: Math.floor(Date.now() / 1000), data, outputs, primaryNodeId: classified.primaryNodeId, previewFallback: classified.previewFallback, warnings: classified.warnings });
  });

  app.post("/v1/free-workflows/:id/videos", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    await freeWorkflows.ensureBindings(entry);
    if (entry.bindings?.outputType !== "video") {
      throw new HttpError("这个自由卡片不是视频工作流", { status: 400, code: "free_workflow_not_video" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    const texts = parseFreeTexts(body.texts);
    const primaryText = parsePrimaryText(body.primaryText);
    const flow = await freeWorkflows.resolveFlow(entry, parseFreeTexts(body.enableGroups), String(body.flowId || ""));
    const effectivePrompt = freeEffectivePrompt({ bindings: flow.bindings }, texts, prompt, primaryText);
    const promptBinding = primaryText || flow.bindings?.prompt;
    if (promptBinding && !effectivePrompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const parsedSize = parseSize(body.size);
    let workflow = applyFreeInputs(flow.workflow, flow.bindings, {
      prompt: effectivePrompt,
      texts,
      uploadedImages,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
      bypassStages: parseFreeTexts(body.bypassStages),
      keepOutputs: flow.outputs,
      primaryText,
    });
    workflow = applyFreeFields(workflow, flow.page ? normalizeFreeFields(parseFreeTexts(body.fields)) : entry.params || [], parseParams(body.params));
    const loras = parseFreeTexts(body.loras);
    const task = tasks.create({
      model: entry.name,
      request: {
        prompt: effectivePrompt,
        size: body.size,
        images: uploadedImages.map((image) => image.name),
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = await runVideo({
        entry: { name: entry.name, type: "video", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt: effectivePrompt, count: 1, params: { loras } }),
        comfy,
        timeoutMs: config.videoTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        loraCatalog: setup.loraNames(),
        includePreviewOutputs: true,
        onProgress: progress,
        logger,
      });
      const file = result.files[0];
      return {
        buffer: file.buffer,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`free video ${entry.name} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.post("/v1/images/generations", async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    // MOSS 旧 id：4 条 SFT 映射到单卡的档位+精度；balanced 已下线，明确报错而不是静默映射。
    const legacyMoss = legacyMossTarget(body.model);
    if (legacyMoss) {
      if (legacyMoss.kind === "balanced") {
        throw new HttpError("该变体已下线，请改用 MOSS-Image", { status: 400, code: "moss_variant_retired" });
      }
      const params = parseParams(body.params);
      params.mossTier = legacyMoss.tier;
      params.mossPrecision = legacyMoss.precision;
      body.params = params;
      body.model = String(body.model).slice(0, -legacyMoss.id.length) + MOSS_MODEL_ID;
    }
    const baseEntry = requireModel(registry, setup, body.model, "image");
    const mode = String(body.mode || body.imageMode || baseEntry.defaultMode || "").trim();
    requireWorkflowMode(setup, baseEntry, mode);
    const entry = mode ? registry.resolveForMode(baseEntry, mode) : baseEntry;
    if (entry.id === MOSS_MODEL_ID) {
      assertMossTierAvailable(entry, setup.workflowStatus(entry.id), parseParams(body.params));
    }
    if (body.background && !entry.bindings?.background && !entry.backgroundPrompt) {
      throw new HttpError(`工作流 ${entry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const context = buildContext({
      prompt: applyBackgroundPrompt(stripImageLabelPreamble(body.prompt), body.background, entry),
      negative: body.negative,
      size: body.size,
      count: body.n ?? body.count,
      quality: body.quality,
      background: body.background,
      mode,
      params: parseParams(body.params),
      presets: entry.presets,
    });
    if (entry.id.startsWith("image-moss-")) applyMossLayoutPrompt(context);
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`image ${entry.name} seed=${result.usedSeed ?? "-"} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("ComfyUI 没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data, seed: result.usedSeed ?? null });
  });

  app.post("/v1/images/upscale", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "image-esrgan-upscale", "image", { allowUnavailable: true });
    if (entry.category !== "upscale") {
      throw new HttpError(`模型 ${entry.name} 不是超分工作流`, { status: 400, code: "not_upscale_workflow" });
    }
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("超分请求缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const context = buildContext({
      prompt: body.prompt,
      count: 1,
      images: [files[0]],
      uploadedImages,
      params: parseParams(body.params),
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`upscale ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`upscale ${entry.name} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("超分工作流没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data, seed: result.usedSeed ?? null });
  });

  app.post("/v1/images/scene3d", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const panoEntry = registry.resolve(SCENE3D_PANO_ID);
    const seamEntry = registry.resolve(SCENE3D_SEAM_ID);
    if (!panoEntry || !seamEntry) {
      throw new HttpError("3D 场景工作流未注册", { status: 500, code: "missing_scene3d_workflow" });
    }
    for (const entry of [panoEntry, seamEntry]) {
      const unavailable = workflowAvailabilityProblem(setup, entry);
      if (unavailable) throw new HttpError(unavailable.message, { status: 409, code: unavailable.code, details: unavailable.details });
    }
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("3D 场景缺少输入图片", { status: 400, code: "missing_image" });
    const inputFile = files[0];
    const python = resolveScene3dPython({ comfyDir: config.comfyDir || inferComfyRootFromFolderPaths(setup.folderPaths?.() || {}) });
    const script = scene3dScriptPath();
    if (!python || !fs.existsSync(script)) {
      throw new HttpError("3D 场景缺少图像处理环境（Pillow/numpy/cv2）。可复制给 AI Agent：设置 SCENE3D_PYTHON 指向 ComfyUI 的 python_embeded，或安装 Pillow/numpy/opencv-python 后重试。", {
        status: 500,
        code: "missing_scene3d_image_runtime",
      });
    }
    const maxAttempts = Math.max(1, Math.min(3, Number(body.attempts) || 3));
    let baseSeed = Number(body.seed);
    if (!Number.isFinite(baseSeed) || baseSeed <= 0) baseSeed = crypto.randomInt(1, 2147483647);
    baseSeed = Math.trunc(baseSeed) % 2147483647 || 1;
    const sceneText = String(body.prompt ?? body.scene ?? "").trim();
    const readOffset = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
    };
    const offsetX = readOffset(body.offsetX ?? body.offset_x);
    const offsetY = readOffset(body.offsetY ?? body.offset_y);
    const prompt = buildScene3dPrompt(sceneText);
    const task = tasks.create({
      model: "image-scene-3d",
      request: { prompt: sceneText, seed: baseSeed, attempts: maxAttempts, offsetX, offsetY },
    });
    tasks.enqueue(task, async (_task, onProgress, signal) => {
      const report = (progress, phase, promptId) => {
        onProgress(promptId ? { progress, phase, promptId } : { progress, phase });
      };
      let lastPromptId = null;
      try {
        let lastMetrics = null;
        let lastReasons = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (signal.aborted) throw Object.assign(new Error("任务已取消"), { code: "cancelled" });
          const seed = ((baseSeed + attempt - 1 - 1) % 2147483647) + 1;
          report(0.08, "扩全景");
          const placed = await placeSource({
            python,
            script,
            inputBuffer: inputFile.buffer,
            offsetX,
            offsetY,
            signal,
          });
          const uploadedPlaced = await uploadImages(comfy, [
            { buffer: placed.buffer, originalname: `scene3d_placed_${seed}.png`, mimetype: "image/png" },
          ]);
          const panoContext = buildContext({ prompt, count: 1, images: [inputFile], uploadedImages: uploadedPlaced, params: { seed } });
          const pano = await runWorkflow({
            entry: panoEntry,
            context: panoContext,
            comfy,
            timeoutMs: config.requestTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: task.id,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          });
          lastPromptId = pano.promptId;
          report(0.4, "扩全景", pano.promptId);
          const panoFile = pano.files.find((file) => /^image\//i.test(file.mimeType)) || pano.files[0];
          if (!panoFile) throw new Error("H3 全景扩图没有返回图片");
          await comfy.freeMemory().catch(() => {});

          report(0.45, "修缝");
          const assets = await prepareSeamAssets({
            python,
            script,
            panoBuffer: panoFile.buffer,
            inputBuffer: inputFile.buffer,
            signal,
          });
          const uploadedSeam = await uploadImages(comfy, [
            { buffer: assets.stripBuffer, originalname: `scene3d_strip_${seed}.png`, mimetype: "image/png" },
            { buffer: assets.maskBuffer, originalname: `scene3d_mask_${seed}.png`, mimetype: "image/png" },
          ]);
          const seamContext = buildContext({ count: 1, uploadedImages: uploadedSeam, params: { seed } });
          const seam = await runWorkflow({
            entry: seamEntry,
            context: seamContext,
            comfy,
            timeoutMs: config.requestTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: task.id,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          });
          report(0.7, "修缝", seam.promptId);
          const seamFile = seam.files.find((file) => /^image\//i.test(file.mimeType)) || seam.files[0];
          if (!seamFile) throw new Error("Qwen 接缝修复没有返回图片");
          await comfy.freeMemory().catch(() => {});

          report(0.78, "建场景");
          const stitched = await stitchPanorama({
            python,
            script,
            panoBuffer: panoFile.buffer,
            repairedBuffer: seamFile.buffer,
            maskBuffer: assets.maskBuffer,
            inputBuffer: inputFile.buffer,
            signal,
          });
          const gate = evaluateScene3dMetrics(stitched.metrics);
          lastMetrics = { ...stitched.metrics, person_single: gate.person };
          lastReasons = gate.reasons;
          logger.info(
            `scene3d attempt ${attempt}/${maxAttempts} seed=${seed} mae=${lastMetrics.edge_mae ?? "-"} luma=${lastMetrics.luma_delta ?? "-"} person=${gate.person} passed=${gate.passed} ${task.id}`,
          );
          if (gate.passed) {
            report(0.95, "建场景", seam.promptId);
            return { buffer: stitched.buffer, ext: "png", mimeType: "image/png", promptId: seam.promptId };
          }
          await comfy.freeMemory().catch(() => {});
        }
        const error = new Error(
          `3D 场景质量门未通过（${maxAttempts} 个种子）：${lastReasons.join("；")}。可复制给 AI Agent：重试 /v1/images/scene3d，换更清晰的主体图或缩短场景描述；若连续失败，检查 H3-Image 与 Qwen 2.1 的节点/权重是否齐全。`,
        );
        error.code = "scene3d_quality_rejected";
        error.details = { attempts: maxAttempts, base_seed: baseSeed, last_metrics: lastMetrics, reasons: lastReasons };
        throw error;
      } catch (error) {
        if (lastPromptId) {
          logger.info(`scene3d task ${task.id} failed after prompt ${lastPromptId}: ${error?.message || error}`);
        }
        throw error;
      } finally {
        await comfy.freeMemory().catch(() => {});
      }
    });
    res.status(202).json({ id: task.id, taskId: task.id, status: task.status, progress: task.progress });
  });

  app.post("/v1/3d/generations", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = registry.resolve("image-idol-3d");
    if (!entry) throw new HttpError("3D 工作流未注册", { status: 500, code: "missing_3d_workflow" });
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("3D 生成缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const params = parseParams(body.params);
    params.idolMode = String(body.mode || params.idolMode || "synthetic").toLowerCase() === "real" ? "real" : "synthetic";
    const seed = Number(body.seed);
    if (Number.isFinite(seed) && seed > 0) params.seed = Math.trunc(seed);
    const gaussians = Number(body.num_gaussians ?? body.numGaussians);
    if (Number.isFinite(gaussians)) params.numGaussians = Math.max(32768, Math.min(1048576, Math.trunc(gaussians)));
    const context = buildContext({ images: [files[0]], uploadedImages, params, mode: params.idolMode });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`3d ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      const failureText = `${error?.message || ""} ${typeof error?.details === "string" ? error.details : JSON.stringify(error?.details || "")}`;
      if (/mask is empty|no object found/i.test(failureText)) {
        throw new HttpError("没有检测到可分离的主体：图片转3D 只适合单个物体；场景或三视图请先裁出一张主体图再试。", { status: 422, code: "no_3d_subject" });
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const video = result.files.find((file) => /\.(mp4|webm|mov)$/i.test(file.filename) || /^video\//i.test(file.mimeType));
    const model = result.files.find((file) => /\.(ply|spz|ksplat|splat)$/i.test(file.filename));
    const preview = result.files.find((file) => file !== video && file !== model && /^image\//i.test(file.mimeType));
    if (!model) throw new HttpError("3D 工作流没有返回模型文件", { status: 502, code: "no_3d_output", details: result.files.map((file) => file.filename) });
    const savedModel = await tasks.saveOutput(randomId("model3d_"), model.buffer, extFromMime(model.mimeType, model.filename, "ply"));
    const savedVideo = video ? await tasks.saveOutput(randomId("model3d_"), video.buffer, extFromMime(video.mimeType, video.filename, "mp4")) : null;
    const savedPreview = preview ? await tasks.saveOutput(randomId("model3d_"), preview.buffer, extFromMime(preview.mimeType, preview.filename, "png")) : null;
    logger.info(`3d ${entry.name} seed=${result.usedSeed ?? "-"} -> ${result.promptId} mode=${params.idolMode} ${req.id}`);
    res.json({
      created: Math.floor(Date.now() / 1000),
      prompt_id: result.promptId,
      seed: result.usedSeed ?? null,
      mode: params.idolMode,
      model: { url: absoluteTaskUrl(config, req, savedModel.url), bytes: savedModel.bytes, filename: model.filename },
      video: savedVideo ? { url: absoluteTaskUrl(config, req, savedVideo.url), bytes: savedVideo.bytes, filename: video.filename } : null,
      preview: savedPreview ? { url: absoluteTaskUrl(config, req, savedPreview.url), bytes: savedPreview.bytes, filename: preview.filename } : null,
    });
  });

  app.post("/v1/3d/scenes", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = registry.resolve("image-moge-scene");
    if (!entry) throw new HttpError("MoGe 场景工作流未注册", { status: 500, code: "missing_scene_workflow" });
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("场景建3D 缺少输入图片", { status: 400, code: "missing_input_image" });
    const uploadedImages = await uploadImages(comfy, [files[0]]);
    const params = parseParams(body.params);
    const resolution = Number(body.resolution ?? params.mogeResolution);
    if (Number.isFinite(resolution)) params.mogeResolution = Math.max(0, Math.min(9, Math.trunc(resolution)));
    const decimation = Number(body.decimation ?? params.mogeDecimation);
    if (Number.isFinite(decimation)) params.mogeDecimation = Math.max(1, Math.min(8, Math.trunc(decimation)));
    const context = buildContext({ images: [files[0]], uploadedImages, params });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`3d scene ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    const model = result.files.find((file) => /\.(glb|gltf)$/i.test(file.filename));
    const preview =
      result.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.filename) && /render/i.test(file.filename)) ||
      result.files.find((file) => /^image\//i.test(file.mimeType));
    const depth = result.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.filename) && /depth/i.test(file.filename));
    if (!model) throw new HttpError("MoGe 没有返回网格文件", { status: 502, code: "no_scene_mesh", details: result.files.map((file) => file.filename) });
    const savedModel = await tasks.saveOutput(randomId("scene3d_"), model.buffer, extFromMime(model.mimeType, model.filename, "glb"));
    const savedPreview = preview ? await tasks.saveOutput(randomId("scene3d_"), preview.buffer, extFromMime(preview.mimeType, preview.filename, "png")) : null;
    const savedDepth = depth ? await tasks.saveOutput(randomId("scene3d_"), depth.buffer, extFromMime(depth.mimeType, depth.filename, "png")) : null;
    logger.info(`3d scene ${entry.name} -> ${result.promptId} res=${params.mogeResolution ?? 6} ${req.id}`);
    res.json({
      created: Math.floor(Date.now() / 1000),
      prompt_id: result.promptId,
      resolution: params.mogeResolution ?? 6,
      model: { url: absoluteTaskUrl(config, req, savedModel.url), bytes: savedModel.bytes, filename: model.filename, format: "glb" },
      preview: savedPreview ? { url: absoluteTaskUrl(config, req, savedPreview.url), bytes: savedPreview.bytes, filename: preview.filename } : null,
      depth: savedDepth ? { url: absoluteTaskUrl(config, req, savedDepth.url), bytes: savedDepth.bytes, filename: depth.filename } : null,
    });
  });

  app.post("/v1/images/edits", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model, "image");
    if (entry.id === "image-krea2-turbo") {
      throw new HttpError("Krea2 只支持文生图，不支持参考图 / 图生图", { status: 400, code: "reference_not_supported" });
    }
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("图片编辑请求缺少参考图", { status: 400, code: "missing_input_image" });
    const mode = String(body.mode || "").trim() || (entry.variants ? Object.keys(entry.variants)[0] : "");
    if (entry.variants && !entry.variants[mode]) {
      throw new HttpError(`模型 ${entry.name} 不支持功能：${mode || "（空）"}`, { status: 400, code: "unsupported_image_mode" });
    }
    requireWorkflowMode(setup, entry, mode);
    if (entry.id === "image-qwen21") {
      if (mode === "inpaint" && files.length !== 2) {
        throw new HttpError("Qwen 局部重绘需要 2 张图：原图 + 二值蒙版", { status: 400, code: "invalid_inpaint_media" });
      }
      if (mode === "remove" && files.length !== 2) {
        throw new HttpError("Qwen 元素移除需要 2 张图：原图 + 二值蒙版", { status: 400, code: "invalid_inpaint_media" });
      }
      if (mode === "edit" && files.length > 10) {
        throw new HttpError("Qwen 多图编辑最多 10 张参考图", { status: 400, code: "too_many_reference_images" });
      }
      if (mode === "outpaint" && files.length !== 1) {
        throw new HttpError("Qwen 扩图需要且只接收 1 张原图", { status: 400, code: "invalid_outpaint_media" });
      }
    }
    if (entry.id === "image-h3image" && mode === "edit" && files.length > 16) {
      throw new HttpError("MiniMax H3-Image 多图编辑最多 16 张参考图", { status: 400, code: "too_many_reference_images" });
    }
    const qwenEdit = entry.id === "image-qwen21" && mode === "edit" && files.length > 1;
    const h3Edit = entry.id === "image-h3image" && mode === "edit";
    const orderedFiles = qwenEdit ? reorderQwenEditFiles(files) : files;
    const promptText = qwenEdit
      ? reorderQwenEditPrompt(body.prompt, files.length)
      : h3Edit
        ? normalizeH3ImageEditPrompt(body.prompt, files.length)
        : entry.id === "image-qwen21"
          ? body.prompt
          : stripImageLabelPreamble(body.prompt);
    const resolvedEntry = registry.resolveForMode(entry, mode);
    if (body.background && !resolvedEntry.bindings?.background && !resolvedEntry.backgroundPrompt) {
      throw new HttpError(`工作流 ${resolvedEntry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const uploadedImages = await uploadImages(comfy, orderedFiles);
    // 同一张卡上重绘/扩图并发出多张只会互抢显存，统一收敛为单张；
    // 扩图采样像素按配置封顶，避免 16MP 在 16GB 卡上必 OOM。
    const editParams = parseParams(body.params);
    const singleShot = mode === "inpaint" || mode === "outpaint" || mode === "remove";
    if (mode === "outpaint" && Number.isFinite(Number(editParams.megapixels))) {
      editParams.megapixels = Math.max(0.1, Math.min(Number(editParams.megapixels), config.outpaintMaxMegapixels));
    }
    const context = buildContext({
      prompt: applyBackgroundPrompt(promptText, body.background, resolvedEntry),
      negative: body.negative,
      size: body.size,
      count: singleShot ? 1 : (body.n ?? body.count),
      quality: body.quality,
      background: body.background,
      mode,
      images: orderedFiles,
      uploadedImages,
      params: editParams,
      presets: entry.presets,
    });
    if (entry.id.startsWith("image-moss-")) applyMossLayoutPrompt(context);
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runImage({
        entry,
        context,
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
        logger,
        loraCatalog: setup.loraNames(),
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`edit ${entry.name} 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
    logger.info(`edit ${entry.name} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        data.push({ url: absoluteTaskUrl(config, req, saved.url) });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/prompts/optimize", upload.any(), async (req, res) => {
    const body = req.body || {};
    if (String(body.task || "").toLowerCase() === "lyrics") {
      const abort = abortOnDisconnect(req, res, registerActiveRequest);
      try {
        const result = await lyricsOptimizer.optimize({
          prompt: body.prompt,
          style: body.style,
          duration: body.duration ?? body.seconds,
          signal: abort.signal,
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        if (abort.signal.aborted) {
          logger.info(`lyrics optimize 请求被客户端中断 ${req.id}`);
          return;
        }
        throw error;
      } finally {
        abort.cleanup();
      }
      return;
    }
    const files = orderedPromptImages(req.files || []);
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = !useCloud && files.length ? await uploadImages(comfy, files) : [];
    const cloudImages = useCloud ? files.map((file) => `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.optimize({
        prompt: body.prompt,
        mode: body.mode,
        duration: body.duration ?? body.seconds,
        referenceNote: body.referenceNote ?? body.reference_note,
        language: body.language,
        viggleMode: body.viggleMode,
        uploadedImages,
        cloudImages,
        imageCount: files.length,
        signal: abort.signal,
        engine: body.engine,
        cloud: {
          baseUrl: body.cloudBaseUrl,
          apiKey: body.cloudApiKey,
          model: body.cloudModel,
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`prompt optimize 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/prompts/optimize-image", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = orderedPromptImages(req.files || []);
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = !useCloud && files.length ? await uploadImages(comfy, files) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.optimizeImage({
        prompt: body.prompt,
        mode: body.mode,
        language: body.language,
        uploadedImages,
        imageCount: Number(body.imageCount) || 0,
        engine: body.engine,
        cloud: {
          baseUrl: body.cloudBaseUrl,
          apiKey: body.cloudApiKey,
          model: body.cloudModel,
        },
        signal: abort.signal,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image prompt optimize 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/prompts/caption", upload.any(), async (req, res) => {
    const body = req.body || {};
    const files = orderedPromptImages(req.files || []);
    if (!files.length) throw new HttpError("反推提示词请求缺少图片", { status: 400, code: "missing_reference_image" });
    const useCloud = String(body.engine || "").toLowerCase() === "cloud";
    const uploadedImages = useCloud ? [] : await uploadImages(comfy, files.slice(0, 1));
    const cloudImages = useCloud ? files.slice(0, 1).map((file) => `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`) : [];
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.captionImage({
        uploadedImages,
        cloudImages,
        language: body.language,
        instruction: body.instruction,
        engine: body.engine,
        cloud: { baseUrl: body.cloudBaseUrl, apiKey: body.cloudApiKey, model: body.cloudModel },
        signal: abort.signal,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (abort.signal.aborted) {
        logger.info(`image caption 请求被客户端中断 ${req.id}`);
        return;
      }
      throw error;
    } finally {
      abort.cleanup();
    }
  });

  app.post("/v1/videos/upscale", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "video-seedvr2-upscale", "video", { allowUnavailable: true });
    if (entry.category !== "upscale") {
      throw new HttpError(`模型 ${entry.name} 不是视频超分工作流`, { status: 400, code: "not_upscale_workflow" });
    }
    const videoFiles = orderedVideoRefFiles(req.files || []);
    if (!videoFiles.length) throw new HttpError("视频超分请求缺少输入视频", { status: 400, code: "missing_input_video" });
    const uploadedVideos = await uploadImages(comfy, videoFiles);
    const params = parseParams(body.params);
    // SeedVR2 的「最高画质」默认值在 16GB 卡上必 OOM；按实际显存分档收敛。
    const vramGb = gpuVramTotalGb(await readSystemStats({ cacheMs: 30000 }));
    const tier = vramGb > 0 && vramGb <= 18 ? { resolution: 1024, batch: 1 } : vramGb > 0 && vramGb <= 26 ? { resolution: 1280, batch: 2 } : null;
    if (tier) {
      const requestedResolution = Number(params.resolution) || 0;
      const requestedBatch = Number(params.batch_size) || 0;
      params.resolution = requestedResolution > 0 ? Math.min(requestedResolution, tier.resolution) : tier.resolution;
      params.batch_size = requestedBatch > 0 ? Math.min(requestedBatch, tier.batch) : tier.batch;
      if (requestedResolution > tier.resolution || requestedBatch > tier.batch) {
        logger.warn(`视频超分按 ${Math.round(vramGb)}GB 显存收敛为 ${params.resolution}/${params.batch_size}（请求 ${requestedResolution}/${requestedBatch}）`);
      }
    }
    const context = buildContext({
      count: 1,
      mode: "upscale",
      videos: videoFiles,
      uploadedVideos,
      params,
    });
    const task = tasks.create({
      model: entry.name,
      request: {
        mode: "upscale",
        video: uploadedVideos[0]?.name,
        resolution: params.resolution,
        fps: params.fps,
        scale: params.scale,
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = await runVideo({
        entry,
        context,
        comfy,
        timeoutMs: config.videoTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal,
        requestId: req.id,
        modelAliasFor: setup.modelAliasFor,
        loaderSpecs: setup.modelLoaderSpecs?.(),
        onProgress: progress,
        logger,
      });
      const file = result.files[0];
      return {
        buffer: file.buffer,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`video upscale ${entry.name} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.post("/v1/videos/interpolate", upload.any(), async (req, res) => {
    const body = req.body || {};
    const videoFiles = orderedVideoRefFiles(req.files || []);
    if (!videoFiles.length) throw new HttpError("插帧请求缺少输入视频", { status: 400, code: "missing_input_video" });
    const multiplier = String(body.multiplier || "2x").trim().toLowerCase();
    if (!["2x", "3x"].includes(multiplier)) {
      throw new HttpError("插帧只支持 2x 或 3x", { status: 400, code: "invalid_interpolation" });
    }
    const source = videoFiles[0];
    const probes = config.comfyDir
      ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
      : [];
    const sourceInfo = probeVideoInfo(source, probes);
    const sourceFps = sourceInfo.fps > 0 ? sourceInfo.fps : 24;
    if (!sourceInfo.fps) logger.warn(`插帧未探测到源视频帧率，按 24fps 处理：${req.id}`);
    const task = tasks.create({
      model: "video-rife",
      request: { mode: "interpolate", multiplier, video: source.originalname || "input.mp4", source_fps: sourceFps },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      progress?.({ phase: "interpolating", progress: 0.1 });
      const interpolated = await videoInterpolator.interpolate({
        comfy,
        buffer: source.buffer,
        filename: source.originalname || "input.mp4",
        multiplier: multiplier === "3x" ? 3 : 2,
        sourceFps,
        requestId: req.id,
        signal,
        timeoutMs: config.interpolationTimeoutMs,
        onProgress: progress,
      });
      return {
        buffer: interpolated.buffer,
        ext: extFromMime(interpolated.mimeType, interpolated.filename, "mp4"),
        mimeType: interpolated.mimeType,
      };
    });
    logger.info(`video interpolate ${multiplier} queued ${task.id} ${req.id}`);
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.post("/v1/videos", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    // H3 已合并为「VDN / 无VDN」两条；旧卡片/脚本里的文生、首尾帧 id 映射到合并条目并补上模式。
    const legacyH3Model = {
      "video-h3-t2v": ["video-h3-ref2va", "text"],
      "video-h3-frames": ["video-h3-ref2va", "frames"],
      "video-h3-t2v-novdn": ["video-h3-ref2va-novdn", "text"],
      "video-h3-frames-novdn": ["video-h3-ref2va-novdn", "frames"],
    };
    const legacyId = Object.keys(legacyH3Model).find((id) => String(body.model || "").endsWith(id));
    if (legacyId) {
      body.model = String(body.model).slice(0, -legacyId.length) + legacyH3Model[legacyId][0];
      if (!body.mode) body.mode = legacyH3Model[legacyId][1];
    }
    const entry = requireModel(registry, setup, body.model, "video");
    const files = orderedVideoFiles(req.files || []);
    const videoFiles = orderedVideoRefFiles(req.files || []);
    const audioFiles = orderedAudioRefFiles(req.files || []);
    let autoPrompt = false;
    let autoPins = null;
    const requestedViggleMode = String(body.mode || "").trim();
    const viggleEditMode = /^(edit|edit-singularity)$/i.test(requestedViggleMode);
    if (entry.id === "video-h3-viggle-swap" && videoFiles.length === 1 && files.length <= 4 && (viggleEditMode || files.length >= 1)) {
      const promptText = String(body.prompt || "").trim();
      const isSixSection = /subject_definitions\s*:/i.test(promptText) && /detailed_description\s*:/i.test(promptText);
      if (!isSixSection) {
        const cloud = {
          baseUrl: String(body.cloudBaseUrl || body.cloud_base_url || "").trim(),
          apiKey: String(body.cloudApiKey || body.cloud_api_key || "").trim(),
          model: String(body.cloudModel || body.cloud_model || "").trim(),
        };
        if (!promptText) throw new HttpError(viggleEditMode ? "视频编辑需要提示词" : "换人需要提示词", { status: 400, code: "missing_prompt" });
        const cloudReady = Boolean(cloud.baseUrl && cloud.apiKey && cloud.model);
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        const probes = config.comfyDir
          ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
          : [];
        const info = probeVideoInfo(videoFiles[0], probes);
        const reportedSeconds = Number(body.source_duration_seconds);
        const seconds = info.duration > 0 ? info.duration : (Number.isFinite(reportedSeconds) && reportedSeconds > 0 ? reportedSeconds : 0);
        const totalFrames = info.duration > 0 ? Math.round(info.duration * 24) : framesFromSeconds(seconds);
        const picks = totalFrames > 0
          ? [...new Set([0, 0.25, 0.5, 0.75, 0.99].map((ratio) => Math.max(0, Math.min(totalFrames - 1, Math.round((totalFrames - 1) * ratio)))))]
          : [];
        const sourceFrames = picks.length ? await extractVideoFrames(videoFiles[0], { frames: picks, config: ffmpegConfig }).catch(() => []) : [];
        const cloudImages = [
          ...files.map((file) => `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`),
          ...sourceFrames.map((file) => `data:image/png;base64,${file.buffer.toString("base64")}`),
        ].slice(0, 9);
        let compiled;
        try {
          const localImages = cloudReady ? [] : await uploadImages(comfy, files.slice(0, 2));
          compiled = await promptOptimizer.optimize({
            prompt: promptText,
            mode: "Viggle",
            viggleMode: viggleEditMode ? "edit" : "swap",
            duration: seconds > 0 ? seconds : 5,
            referenceNote: String(body.referenceNote || ""),
            engine: cloudReady ? "cloud" : "local",
            cloud,
            cloudImages,
            uploadedImages: localImages,
          });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          const where = cloudReady ? "云端 API" : "本地 llama.cpp 节点与 Qwen3.5 模型";
          throw new HttpError(`提示词自动编译失败（${cloudReady ? "云端" : "本地"}）：${String(error?.message || error).slice(0, 300)}。请检查${where}，或手动填写六段式提示词后重试。`, {
            status: error?.status || 502,
            code: error?.code || "prompt_compile_failed",
            details: error?.details,
          });
        }
        body.prompt = compiled.prompt;
        autoPrompt = true;
        logger.info(`Viggle 提示词自动编译为六段式（${compiled.provider || "cloud"}，${compiled.elapsedMs || 0}ms）`);
      }
    }
    let promptNormalized = false;
    if (entry.id === "video-h3-viggle-swap" && !/^(edit|edit-singularity)$/i.test(String(body.mode || "").trim()) && /subject_definitions\s*:/i.test(String(body.prompt || ""))) {
      const normalized = normalizeViggleSwapPrompt(body.prompt);
      if (normalized.text !== body.prompt) {
        body.prompt = normalized.text;
        promptNormalized = true;
        logger.info(`Viggle 提示词按一次产片模板归一：${normalized.notes.join("；")}`);
      }
    }
    const extraParams = parseParams(body.params);
    const params = { ...extraParams };
    const interpolation = String(params.interpolation || "off").trim();
    if (!["off", "2x", "3x"].includes(interpolation)) {
      throw new HttpError("插帧只支持 off、2x、3x", { status: 400, code: "invalid_interpolation" });
    }
    if (params.segmentSeconds != null && params.segmentSeconds !== "") {
      const rawSeconds = Number(params.segmentSeconds);
      if (!Number.isFinite(rawSeconds) || rawSeconds < 3.75 || rawSeconds > 14.4) {
        throw new HttpError("分段长度必须在 3.75–14.4 秒之间", { status: 400, code: "invalid_segment_seconds" });
      }
    }
    const viggleSegmentFrames = alignViggleFramesUp(Number(params.segmentFrames) || Number(params.segmentSeconds) * 24 || 277);
    let videoMode = String(body.mode || "").trim();
    const h3MultiMode = entry.id === "video-h3-ref2va" || entry.id === "video-h3-ref2va-novdn";
    if (h3MultiMode) {
      if (!videoMode) videoMode = "reference";
      if (!["text", "frames", "reference"].includes(videoMode)) {
        throw new HttpError("H3 模式必须是 text、frames 或 reference", { status: 400, code: "invalid_video_mode" });
      }
    } else if (entry.id === "video-h3-fast") {
      videoMode = videoMode === "text" ? "text" : "frames";
    }
    let variantFallback = null;
    if (entry.variants) {
      const requestedMode = videoMode;
      const resolvedMode = resolveVariantFallback(setup, entry, videoMode);
      if (resolvedMode !== requestedMode) {
        const requestedLabel = entry.variantLabels?.[requestedMode] || entry.variants?.[requestedMode]?.label || requestedMode;
        const resolvedLabel = entry.variantLabels?.[resolvedMode] || entry.variants?.[resolvedMode]?.label || resolvedMode;
        variantFallback = {
          requestedVariant: requestedMode,
          resolvedVariant: resolvedMode,
          fallbackNotice: `「${requestedLabel}」当前不可用，已自动降级为「${resolvedLabel}」`,
        };
        logger.info(`Viggle 模式 ${requestedMode} 不可用，自动降级到 ${resolvedMode}`);
      }
      videoMode = resolvedMode;
      requireWorkflowMode(setup, entry, videoMode);
    }
    const viggleEditing = entry.id === "video-h3-viggle-swap" && (videoMode === "edit" || videoMode === "edit-singularity");
    let requiredImageCount = Object.values(entry.bindings || {}).reduce((max, binding) => {
      if (!binding) return max;
      if (binding.from === "image" && binding.array) return Math.max(max, Number(binding.min ?? 0));
      if (binding.required && (binding.from === "image" || binding.imageIndex !== undefined)) {
        return Math.max(max, (Number.isInteger(binding.imageIndex) ? binding.imageIndex : 0) + 1);
      }
      return max;
    }, 0);
    if (h3MultiMode && videoMode === "text") {
      if (files.length || videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 文生视频不接收图片/视频/音频；首尾帧或参考素材请切换到对应模式", { status: 400, code: "unsupported_video_media" });
      }
      requiredImageCount = 0;
    } else if (h3MultiMode && videoMode === "frames") {
      if (videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 首尾帧只接收 1–2 张图片；音频/视频请切到多参模式", { status: 400, code: "unsupported_video_media" });
      }
      const frameMode = String(params.frameMode || (files.length >= 2 ? "both" : "first"));
      if (!["first", "last", "both"].includes(frameMode)) {
        throw new HttpError("frameMode 必须是 first、last 或 both", { status: 400, code: "invalid_frame_mode" });
      }
      params.frameMode = frameMode;
      requiredImageCount = frameMode === "both" ? 2 : 1;
    } else if (h3MultiMode && videoMode === "reference") {
      requiredImageCount = 0;
      if (!files.length && !videoFiles.length && !audioFiles.length) {
        throw new HttpError("H3 多参需要至少一个参考素材（图片/音频/视频）", { status: 400, code: "missing_reference_media" });
      }
    } else if (entry.id === "video-h3-fast" && videoMode === "text") {
      if (files.length || videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 极速草稿的文生模式不接收图片/视频/音频；要首帧请切到首尾帧", { status: 400, code: "unsupported_video_media" });
      }
      requiredImageCount = 0;
    } else if (entry.id === "video-h3-fast") {
      if (videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 首尾帧只接收 1–2 张图片；音频/视频请切到多参模式", { status: 400, code: "unsupported_video_media" });
      }
      const frameMode = String(params.frameMode || (files.length >= 2 ? "both" : "first"));
      if (!["first", "last", "both"].includes(frameMode)) {
        throw new HttpError("frameMode 必须是 first、last 或 both", { status: 400, code: "invalid_frame_mode" });
      }
      params.frameMode = frameMode;
      requiredImageCount = frameMode === "both" ? 2 : 0;
    } else if (entry.id === "video-h3-viggle-swap") {
      const allVideoRefs = (req.files || []).filter((file) => file?.buffer && /^videos?(\[\])?$/i.test(file.fieldname || ""));
      const viggleLabel = viggleEditing ? "视频编辑" : "Viggle 角色替换";
      if (allVideoRefs.length !== 1) {
        throw new HttpError(`${viggleLabel}需要且仅需要 1 段源视频`, { status: 400, code: "missing_source_video" });
      }
      if (!files.length || files.length > 4) {
        throw new HttpError(
          viggleEditing
            ? "视频编辑需要 1 张编辑参考图（最多 4 张）：从源视频抽一帧、用图像编辑改好后再上传（pins 填该帧号）"
            : "Viggle 角色替换需要 1–4 张角色参考图",
          { status: 400, code: "invalid_reference_images" },
        );
      }
      if (audioFiles.length) {
        throw new HttpError(`${viggleLabel}直接沿用源视频音轨，不需要单独上传音频`, { status: 400, code: "unsupported_audio" });
      }
      requiredImageCount = 0;
    }
    if (files.length < requiredImageCount) {
      const hint = (h3MultiMode && videoMode === "frames") || entry.id === "video-h3-fast" ? "（首尾帧支持首帧、尾帧或首尾帧；首尾帧模式需要 2 张图）" : "";
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${requiredImageCount} 张参考图${hint}`, { status: 400, code: "missing_reference_image" });
    }
    if (!h3MultiMode && entry.minMedia && files.length + videoFiles.length + audioFiles.length < Number(entry.minMedia)) {
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${entry.minMedia} 个参考素材（图片/音频/视频）`, { status: 400, code: "missing_reference_media" });
    }
    if (entry.id === "video-h3-viggle-swap" && videoFiles.length === 1) {
      const patched = await ensureSourceAudio(videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      if (patched !== videoFiles[0]) {
        videoFiles[0] = patched;
        logger.info("Viggle 源视频没有音轨，已补静音音轨后上传");
      }
      const fitted = await fitViggleSourceCanvas(videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      if (fitted !== videoFiles[0]) {
        videoFiles[0] = fitted;
        logger.info("Viggle 源视频已按原比例缩放为短边 480（避免 Remake 画布拉伸）");
      }
    }
    if (entry.id === "video-h3-viggle-swap") {
      // 透明参考图先压到源片背景色上，避免透明像素被模型画成黑底。
      const prepared = await flattenViggleReferences(files, videoFiles[0], { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" });
      for (let index = 0; index < files.length; index += 1) files[index] = prepared[index] || files[index];
    }
    const uploadedImages = await uploadImages(comfy, files);
    const uploadedVideos = await uploadImages(comfy, videoFiles);
    const uploadedAudios = await uploadImages(comfy, audioFiles);
    const context = buildContext({
      prompt: body.prompt,
      size: body.size,
      count: 1,
      quality: body.resolution_name || body.vquality,
      seconds: body.seconds,
      mode: videoMode,
      images: files,
      uploadedImages,
      uploadedVideos,
      uploadedAudios,
      params: {
        ...params,
        ratio: body.ratio,
        resolution_name: body.resolution_name,
        generate_audio: body.generate_audio,
        watermark: body.watermark,
      },
    });
    let sourceVideoTruncated = false;
    let sourceFps = 0;
    if (videoFiles.length) {
      // H3 统一按 24fps 出片：源视频用时长×24 换算帧数，30/60fps 素材不会算长。
      const sourceSeconds = Number(body.source_duration_seconds);
      const fromDuration = framesFromSeconds(sourceSeconds);
      const probes = config.comfyDir
        ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
        : [];
      const info = probeVideoInfo(videoFiles[0], probes);
      sourceFps = info.fps || 0;
      if (entry.id === "video-h3-viggle-swap" && info.fps > 0 && Math.abs(info.fps - 24) > 0.01) {
        logger.info(`源视频 ${info.fps.toFixed(2)}fps → 24fps（VHS force_rate=24 归一）`);
      }
      const probedFrames = info.duration > 0 ? Math.round(info.duration * 24) : 0;
      const sourceFrames = probedFrames || fromDuration;
      const viggle = entry.id === "video-h3-viggle-swap";
      if (viggle && (!sourceFrames || sourceFrames < VIGGLE_MIN_FRAMES)) {
        throw new HttpError(`Viggle 角色替换的源视频至少需要 3.75 秒（90 帧 @24fps），当前约 ${(Math.max(0, sourceFrames) / 24).toFixed(2)} 秒`, {
          status: 400, code: "source_video_too_short", details: { sourceFrames, minimum: VIGGLE_MIN_FRAMES },
        });
      }
      const longVideoEnabled = params.longVideo !== false;
      const viggleLong = viggle && longVideoEnabled && sourceFrames > viggleSegmentFrames;
      const aligned = viggle ? (viggleLong ? viggleSegmentFrames : alignViggleFramesUp(sourceFrames)) : alignH3Frames(sourceFrames);
      // 官方 H3 参考视频单段上限 15 秒（24fps 下 362 帧 = 17×21+5）。
      // Viggle Remake 单窗口上限 345 帧（14.375 秒）；超过分段长度时由长视频编排器逐段生成。
      const capped = viggle ? (viggleLong ? viggleSegmentFrames : (longVideoEnabled ? aligned : Math.min(aligned, VIGGLE_MAX_FRAMES))) : capH3ReferenceFrames(aligned);
      context.sourceVideoFrames = capped;
      context.sourceTotalFrames = sourceFrames;
      if (viggle && !viggleLong && aligned > sourceFrames) {
        const padDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "viggle-pad-"));
        try {
          const paddedBuffer = await padSourceForSegment(
            videoFiles[0],
            sourceFrames,
            aligned,
            { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" },
            padDir,
          );
          videoFiles[0] = { ...videoFiles[0], buffer: paddedBuffer, size: paddedBuffer.length, originalname: "source-padded.mp4" };
          const [paddedUpload] = await uploadImages(comfy, [videoFiles[0]]);
          uploadedVideos[0] = paddedUpload;
          context.uploadedVideos[0] = paddedUpload;
          logger.info(`Viggle 源视频 ${sourceFrames} 帧补齐到 ${aligned} 帧后上传（frame_load_cap=${aligned}）`);
        } finally {
          await fs.promises.rm(padDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      context.viggleSegmentFrames = viggleSegmentFrames;
      context.viggleLong = viggleLong;
      context.viggleLongEnabled = longVideoEnabled;
      sourceVideoTruncated = viggle ? (!viggleLong && sourceFrames > capped) : capped > 0 && aligned > capped;
      if (viggleLong) logger.info(`源视频 ${sourceFrames} 帧 > 分段 ${viggleSegmentFrames} 帧，将逐段生成并 RemakePrefix 接力`);
      if (viggle && !longVideoEnabled && sourceFrames > capped) logger.info(`长视频分段已关闭：源视频 ${sourceFrames} 帧截断为 ${capped} 帧`);
      if (viggle) {
        // SageAttention 默认开（auto）；运行库/硬件不可用时静默回退并记日志。
        const sageRaw = String(params.sage ?? "auto").trim().toLowerCase();
        params.sage = ["disabled", "off", "false", "0"].includes(sageRaw) ? "disabled" : "auto";
        if (params.sage !== "disabled") {
          const sageAvailable = await probeSageAvailability(resources);
          if (sageAvailable === false) {
            params.sage = "disabled";
            logger.warn("SageAttention 运行库不可用，已静默回退为 disabled（本次生成不加速）");
          }
        }
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        // 长视频尾段不足 90 帧会被丢弃；pins 上限按实际生成的最后一段末帧算，避免“校验通过但被静默丢弃”。
        const plannedEnd = viggleLong
          ? planViggleSegments(sourceFrames, viggleSegmentFrames).reduce((end, segment) => Math.max(end, segment.start + segment.frames), 0)
          : 0;
        const pinLimit = viggleLong ? (plannedEnd || sourceFrames) : (sourceFrames ? Math.min(capped, sourceFrames) : capped);
        let pinsRaw = String(params.pins ?? "").trim();
        if (!pinsRaw && !viggleEditing) {
          // 一次产片：未显式给 pins 时自动选帧（laplacian+中心），每张角色图用同一个源帧。
          const K = Math.min(8, Math.max(1, pinLimit - 1));
          const indices = [];
          for (let i = 0; i < K; i += 1) {
            const value = K === 1 ? Math.max(1, Math.floor(pinLimit / 2)) : Math.round(1 + ((pinLimit - 2) * i) / (K - 1));
            if (value > 0 && value < pinLimit && !indices.includes(value)) indices.push(value);
          }
          const candidates = await extractVideoFrames(videoFiles[0], { frames: indices, config: ffmpegConfig });
          const scored = await scoreVideoFrames(candidates, { config: ffmpegConfig, references: files });
          const usable = scored.filter((item) => item.score > 0 && !item.black).sort((a, b) => b.score - a.score);
          if (!usable.length) {
            throw new HttpError("源视频没有可用的候选帧（全黑或无法打分）；请显式填写 pins 或更换源视频", { status: 422, code: "no_usable_frame" });
          }
          const best = usable[0].frame;
          pinsRaw = Array(files.length).fill(String(best)).join(", ");
          params.pins = pinsRaw;
          autoPins = { frame: best, source: "reference-similarity+heuristic", scores: scored.map((item) => ({ frame: item.frame, score: item.score, similarity: item.similarity, black: item.black })) };
          logger.info(`Viggle 自动 pins：frame=${best}（${files.length} 张角色图，启发式）`);
        }
        if (!pinsRaw) {
          throw new HttpError(
            viggleEditing
              ? "视频编辑需要填写 pins（源帧号）：每张编辑参考图一个，例如 96；pins 为空时不会注入关键帧，编辑不会生效"
              : "Viggle 角色替换需要填写 pins（源帧号）：每张角色参考图一个，例如 96；pins 为空时不会注入关键帧，人物不会被替换",
            { status: 400, code: "missing_pins", details: { referenceImages: files.length } },
          );
        }
        if (pinsRaw) {
          const pins = pinsRaw.split(/[,\s]+/).filter(Boolean).map(Number);
          if (pins.length !== files.length) {
            throw new HttpError(`pins 数量必须等于${viggleEditing ? "编辑参考图" : "角色参考图"}数量（当前 ${pins.length} 个 pins / ${files.length} 张参考图）`, {
              status: 400, code: "invalid_pins", details: { pins, referenceImages: files.length },
            });
          }
          if (!pins.every((pin) => Number.isInteger(pin) && pin > 0 && pin < pinLimit)) {
            throw new HttpError(`pins 必须是 1–${pinLimit - 1} 的整数，并且与参考图一一对应（0 会污染首帧，不允许）`, {
              status: 400, code: "invalid_pins", details: { pins, frames: pinLimit },
            });
          }
          params.pins = pins.join(", ");
        }
        context.params = { ...(context.params || {}), pins: params.pins, sage: params.sage };
      }
      if (aligned && sourceFrames && aligned !== sourceFrames) {
        logger.info(`源视频 ${sourceFrames} 帧，补齐到 17n+5 的 ${aligned} 帧（约 ${(aligned / 24).toFixed(1)}s），生成后裁回源时长`);
      }
      if (sourceVideoTruncated) {
        const limit = viggle ? `Viggle 单窗口 ${(VIGGLE_MAX_FRAMES / 24).toFixed(2)}s` : "H3 单段 15s";
        logger.warn(`源视频约 ${(sourceFrames / 24).toFixed(1)}s，超过 ${limit} 上限，已截取前 ${(capped / 24).toFixed(1)}s`);
      }
      if (!probedFrames && fromDuration) logger.warn(`ffprobe 不可用，按上报时长 ${sourceSeconds}s 换算为 ${fromDuration} 帧`);
    }
    const requestMeta = entry.id === "video-h3-viggle-swap"
      ? {
          mode: viggleEditing ? "viggle-edit" : "swap-one-shot",
          autoPrompt,
          promptNormalized,
          autoPins,
          estimatedSeconds: viggleEditing ? null : { min: 96, max: 125 },
        }
      : (autoPrompt ? { mode: "viggle-prompt-auto", autoPrompt } : null);
    const task = tasks.create({
      model: entry.name,
      request: {
        prompt: String(body.prompt || ""),
        seconds: body.seconds,
        size: body.size,
        ratio: body.ratio,
        resolution_name: body.resolution_name,
        mode: videoMode,
        images: uploadedImages.map((image) => image.name),
        videos: uploadedVideos.map((file) => file.name),
        audios: uploadedAudios.map((file) => file.name),
        interpolation,
        source_video_truncated: sourceVideoTruncated,
        source_fps: sourceFps,
        segmented: context.viggleLong === true,
        segment_frames: context.viggleSegmentFrames || 0,
        ...(variantFallback || {}),
        ...(requestMeta ? { meta: requestMeta } : {}),
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = context.viggleLong
        ? await runViggleLongVideo({
            entry,
            context,
            comfy,
            sourceFile: videoFiles[0],
            segmentFrames: context.viggleSegmentFrames,
            config: { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "", comfyRoot: resources.comfyRoot?.() || "" },
            timeoutMs: config.videoTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: req.id,
            onProgress: progress,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          })
        : await runVideo({
            entry,
            context,
            comfy,
            timeoutMs: config.videoTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            signal,
            requestId: req.id,
            onProgress: progress,
            logger,
            loraCatalog: setup.loraNames(),
            modelAliasFor: setup.modelAliasFor,
            loaderSpecs: setup.modelLoaderSpecs?.(),
          });
      let file = result.files[0];
      if (interpolation !== "off") {
        progress?.({ phase: "interpolating", progress: 0.97 });
        const interpolated = await videoInterpolator.interpolate({
          comfy,
          buffer: file.buffer,
          filename: file.filename,
          multiplier: interpolation === "3x" ? 3 : 2,
          requestId: req.id,
          signal,
          timeoutMs: config.interpolationTimeoutMs,
          onProgress: progress,
        });
        file = { ...file, buffer: interpolated.buffer, filename: interpolated.filename, mimeType: interpolated.mimeType };
      }
      return {
        buffer: file.buffer,
        ext: extFromMime(file.mimeType, file.filename, "mp4"),
        mimeType: file.mimeType,
        promptId: result.promptId,
      };
    });
    logger.info(`video ${entry.name} queued ${task.id} ${req.id}`);
    res.json({
      id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000),
      ...(variantFallback || {}),
      ...(requestMeta ? { meta: requestMeta } : {}),
      ...(autoPrompt ? { prompt: body.prompt, auto_prompt: true } : {}),
    });
  });

  app.get("/v1/videos/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const data = taskResponse(req, task);
    const preview = task.promptId ? previewHub.get(task.promptId) : null;
    const stepProgress = task.promptId ? previewHub.getProgress(task.promptId) : null;
    res.json({
      id: data.id,
      object: "video",
      status: data.status,
      progress: data.progress,
      prompt_id: data.promptId || undefined,
      steps: stepProgress ? { step: stepProgress.step, total: stepProgress.total } : undefined,
      preview: preview
        ? {
            url: `/api/previews/${encodeURIComponent(task.promptId)}?t=${preview.updatedAt}`,
            mime: preview.mime,
            step: preview.step,
            total: preview.total,
          }
        : undefined,
      url: data.url || undefined,
      error: data.error ? { message: data.error } : undefined,
      created_at: data.createdAt,
      completed_at: data.completedAt,
      model: data.model,
      meta: data.request?.meta || undefined,
      ...(data.request?.resolvedVariant
        ? {
            requestedVariant: data.request.requestedVariant,
            resolvedVariant: data.request.resolvedVariant,
            fallbackNotice: data.request.fallbackNotice,
          }
        : {}),
    });
  });

  // #308 自动链（两阶段）：抽帧 → Qwen2.1 改图 → 返回 painted frame；用户确认 P 后再提交 Viggle。
  const vigglePrepareJobs = new Map();
  let vigglePrepareActive = null;
  const VIGGLE_PREPARE_MIN_FREE_MB = Number(process.env.VIGGLE_PREPARE_MIN_FREE_MB || 8000);
  const prepareResponse = (req, job) => ({
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    frame: job.frame,
    pin: job.pin,
    image: job.image ? { ...job.image, url: absoluteTaskUrl(config, req, job.image.url) } : null,
    selection: job.selection
      ? {
          ...job.selection,
          candidates: (job.selection.candidates || []).map((candidate) => ({
            ...candidate,
            thumbUrl: candidate.thumbUrl ? absoluteTaskUrl(config, req, candidate.thumbUrl) : undefined,
          })),
        }
      : null,
    error: job.error ? { message: job.error.message || String(job.error), code: job.error.code || "prepare_failed" } : null,
    video: job.video ? { ...job.video, url: absoluteTaskUrl(config, req, job.video.url) } : null,
    meta: job.meta || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
  const retirePrepareJob = (id) => {
    const timer = setTimeout(() => vigglePrepareJobs.delete(id), 30 * 60 * 1000);
    timer.unref?.();
  };

  app.post("/v1/viggle/prepare-frame", upload.any(), async (req, res) => {
    const body = req.body || {};
    const source = orderedVideoRefFiles(req.files || [])[0];
    const prompt = String(body.prompt || "").trim();
    const prepareMode = String(body.mode || "").trim().toLowerCase();
    const swapSelfProduce = prepareMode === "swap-selfproduce" || (prepareMode === "" && String(body.viggleMode || "").toLowerCase() === "swap");
    if (swapSelfProduce) {
      throw new HttpError("换人已改为一次生成：直接调用 /v1/videos（自动编译六段式与自动 pins），不再使用 prepare-frame", { status: 410, code: "swap_selfproduce_retired" });
    }
    if (!source) throw new HttpError("缺少源视频", { status: 400, code: "missing_source_video" });
    if (!prompt) throw new HttpError(swapSelfProduce ? "换人自产目标帧需要提示词（六段式）" : "视频编辑需要编辑指令（想改什么）", { status: 400, code: swapSelfProduce ? "missing_prompt" : "missing_edit_prompt" });
    if (vigglePrepareActive) throw new HttpError("已有参考帧制备任务在跑，请稍后再试", { status: 409, code: "prepare_busy" });

    const probes = config.comfyDir
      ? [path.join(config.comfyDir, "ffprobe.exe"), path.join(config.comfyDir, "..", "ffprobe.exe"), path.join(config.comfyDir, "ffmpeg", "bin", "ffprobe.exe")]
      : [];
    const info = probeVideoInfo(source, probes);
    const reported = Number(body.source_duration_seconds);
    const seconds = info.duration > 0 ? info.duration : (Number.isFinite(reported) && reported > 0 ? reported : 0);
    const sourceFrames = info.duration > 0 ? Math.round(info.duration * 24) : framesFromSeconds(seconds);
    if (!sourceFrames || sourceFrames < VIGGLE_MIN_FRAMES) {
      throw new HttpError(`源视频至少需要 3.75 秒（90 帧），当前约 ${(Math.max(0, sourceFrames) / 24).toFixed(2)} 秒`, { status: 400, code: "source_video_too_short" });
    }
    if (swapSelfProduce) {
      const refFiles = orderedVideoFiles(req.files || []);
      if (!refFiles.length || refFiles.length > 4) {
        throw new HttpError("换人自产目标帧需要 1–4 张角色参考图", { status: 400, code: "invalid_reference_images" });
      }
      const rawTarget = String(body.pin ?? "").trim();
      let targetFrame = 20;
      if (rawTarget) {
        const pin = Number(rawTarget);
        if (!Number.isInteger(pin) || pin <= 0 || pin >= 90) {
          throw new HttpError("目标帧必须是 1–89 的整数（第一遍固定 90 帧）", { status: 400, code: "invalid_pins", details: { pin, frames: 90 } });
        }
        targetFrame = pin;
      }
      const job = {
        id: randomId("viggle_prepare_"),
        status: "queued",
        step: "selfproduce",
        progress: 0,
        frame: targetFrame,
        pin: targetFrame,
        image: null,
        selection: null,
        meta: null,
        error: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        controller: new AbortController(),
      };
      vigglePrepareJobs.set(job.id, job);
      vigglePrepareActive = job;
      res.status(202).json(prepareResponse(req, job));
      logger.info(`Viggle 自产目标帧开始 ${job.id} target=${targetFrame} sourceFrames=${sourceFrames} refs=${refFiles.length}`);
      const run = async () => {
        const signal = job.controller.signal;
        try {
          job.status = "running";
          job.step = "selfproduce";
          job.progress = 0.1;
          job.updatedAt = nowIso();
          const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
          let freeMb = null;
          try {
            const stats = await comfy.systemStats();
            const device = Array.isArray(stats?.devices) ? stats.devices[0] : null;
            const free = Number(device?.vram_free ?? device?.vramFree ?? 0);
            if (free > 0) freeMb = Math.round(free / (1024 * 1024));
          } catch (error) {
            logger.warn(`读取 ComfyUI 显存失败，跳过自产目标帧遥测：${error.message}`);
          }
          logger.info(`自产目标帧显存遥测 ${freeMb === null ? "不可读（跳过）" : `${freeMb}MB`}，阈值 ${VIGGLE_PREPARE_MIN_FREE_MB}MB（仅遥测，不拦截）`);
          const patchedSource = await ensureSourceAudio(source, ffmpegConfig);
          const refs = await flattenViggleReferences(refFiles, patchedSource, ffmpegConfig);
          const uploadedImages = await uploadImages(comfy, refs);
          const uploadedVideos = await uploadImages(comfy, [patchedSource]);
          const entry = requireModel(registry, setup, "video-h3-viggle-swap", "video");
          const firstContext = buildContext({
            prompt,
            size: body.size,
            count: 1,
            quality: body.resolution_name,
            seconds: 90 / 24,
            mode: "reference",
            images: refs,
            uploadedImages,
            uploadedVideos,
            params: { pins: "17", sage: "auto", short_edge: 480, ...(body.seed != null ? { seed: body.seed } : {}) },
          });
          firstContext.sourceVideoFrames = 90;
          firstContext.sourceTotalFrames = 90;
          let first;
          try {
            first = await runVideo({
              entry,
              context: firstContext,
              comfy,
              timeoutMs: config.videoTimeoutMs,
              pollIntervalMs: config.pollIntervalMs,
              signal,
              requestId: req.id,
              onProgress: (event) => {
                job.progress = Math.min(0.5, 0.1 + (Number(event?.progress) || 0) * 0.4);
                job.updatedAt = nowIso();
              },
              logger,
              loraCatalog: setup.loraNames(),
              modelAliasFor: setup.modelAliasFor,
              loaderSpecs: setup.modelLoaderSpecs?.(),
            });
          } catch (error) {
            if (signal.aborted) throw new HttpError("制备已取消", { status: 400, code: "cancelled" });
            throw new HttpError(`第一遍 Viggle 自产失败：${error.message || error}；请检查参考图/显存后重试，或手动上传目标帧`, { status: 422, code: "selfproduce_failed", details: { cause: error.code || "" } });
          }
          const firstVideo = first.files?.find((file) => /^video\//i.test(file.mimeType) || /\.(mp4|webm|mov)$/i.test(file.filename));
          if (!firstVideo?.buffer?.length) throw new HttpError("第一遍 Viggle 没有返回视频；请手动上传目标帧", { status: 422, code: "selfproduce_failed" });
          if (signal.aborted) throw new HttpError("制备已取消", { status: 400, code: "cancelled" });
          job.step = "extract";
          job.progress = 0.6;
          job.updatedAt = nowIso();
          let extracted;
          try {
            extracted = await extractVideoFrame({ buffer: firstVideo.buffer, mimetype: firstVideo.mimeType || "video/mp4", originalname: firstVideo.filename || "selfproduce.mp4" }, { frame: targetFrame, config: ffmpegConfig });
          } catch (error) {
            throw new HttpError(`第一遍已生成，但抽第 ${targetFrame} 帧失败：${error.message}；请手动上传目标帧`, { status: 422, code: "target_frame_extract_failed" });
          }
          const size = mediaPixelSize(extracted.buffer, "image/png", extracted.filename);
          const saved = await tasks.saveOutput(randomId("viggle_target_"), extracted.buffer, "png");
          job.image = { url: saved.url, name: path.basename(saved.file), width: size?.width || 0, height: size?.height || 0, bytes: saved.bytes };
          job.frame = targetFrame;
          job.pin = targetFrame;
          job.selection = { mode: "swap-selfproduce", engine: "viggle-first-pass", selectedFrame: targetFrame, stage: "target-frame", targetFrame: { frame: targetFrame, url: saved.url } };
          job.meta = { estimatedSeconds: 158.6, firstPassSeconds: 70.4, secondPassSeconds: 88.2, next: "submit /v1/videos with target frame as Picture 1 and pins=frame" };
          job.status = "ready";
          job.step = "ready";
          job.progress = 1;
          job.updatedAt = nowIso();
          logger.info(`Viggle 自产目标帧完成 ${job.id} frame=${targetFrame} ${job.image.width}x${job.image.height}`);
        } catch (error) {
          if (signal.aborted) {
            job.status = "cancelled";
            job.error = { message: "制备已取消", code: "cancelled" };
          } else {
            job.status = "failed";
            job.error = { message: error.message || String(error), code: error.code || "selfproduce_failed" };
            logger.warn(`Viggle 自产目标帧失败 ${job.id}: ${job.error.message}`);
          }
          job.updatedAt = nowIso();
        } finally {
          if (vigglePrepareActive === job) vigglePrepareActive = null;
          retirePrepareJob(job.id);
        }
      };
      void run();
      return;
    }
    const segmentSeconds = Number(body.segmentSeconds);
    const segmentFrames = alignViggleFramesUp(Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? segmentSeconds * 24 : 277);
    const long = sourceFrames > segmentFrames;
    const plannedEnd = long
      ? planViggleSegments(sourceFrames, segmentFrames).reduce((end, segment) => Math.max(end, segment.start + segment.frames), 0)
      : alignViggleFramesUp(sourceFrames);
    const limit = plannedEnd || sourceFrames;
    const rawPin = String(body.pin ?? "").trim();
    let frame = null;
    if (rawPin) {
      const pin = Number(rawPin);
      if (!Number.isInteger(pin) || pin <= 0 || pin >= limit) {
        throw new HttpError(`pin 必须是 1–${limit - 1} 的整数`, { status: 400, code: "invalid_pins", details: { pin, frames: limit } });
      }
      frame = pin;
    }

    const job = {
      id: randomId("viggle_prepare_"),
      status: "queued",
      step: "extract",
      progress: 0,
      frame,
      pin: frame,
      image: null,
      selection: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      controller: new AbortController(),
    };
    vigglePrepareJobs.set(job.id, job);
    vigglePrepareActive = job;
    res.status(202).json(prepareResponse(req, job));
    logger.info(`Viggle 参考帧制备开始 ${job.id} frame=${frame ?? "auto"} video=${source.originalname || "source.mp4"}`);

    const run = async () => {
      const signal = job.controller.signal;
      try {
        job.status = "running";
        job.step = "extract";
        job.progress = 0.1;
        job.updatedAt = nowIso();
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        let extracted = null;
        if (frame) {
          extracted = await extractVideoFrame(source, { frame, config: ffmpegConfig });
          job.selection = { mode: "override", engine: "user", selectedFrame: frame, candidates: [] };
        } else {
          // 自动选帧：K=8 均匀候选（避开 0，落在实际生成范围内），再按启发式打分取最高。
          const K = Math.min(8, Math.max(1, limit - 1));
          const indices = [];
          for (let i = 0; i < K; i += 1) {
            const value = K === 1 ? Math.max(1, Math.floor(limit / 2)) : Math.round(1 + ((limit - 2) * i) / (K - 1));
            if (value > 0 && value < limit && !indices.includes(value)) indices.push(value);
          }
          const candidates = await extractVideoFrames(source, { frames: indices, config: ffmpegConfig });
          const scored = await scoreVideoFrames(candidates, { config: ffmpegConfig });
          const usable = scored.filter((item) => item.score > 0 && !item.black).sort((a, b) => b.score - a.score);
          if (!usable.length) {
            throw new HttpError("源视频没有可用的候选帧（全黑或无法打分）；请手动抽帧、编辑后上传", { status: 422, code: "no_usable_frame" });
          }
          const best = usable[0];
          const bestCandidate = candidates.find((item) => item.frame === best.frame);
          if (!bestCandidate) throw new HttpError("自动选帧失败：候选帧与打分结果不一致；请手动抽帧、编辑后上传", { status: 422, code: "no_usable_frame" });
          extracted = bestCandidate;
          frame = best.frame;
          job.frame = frame;
          job.pin = frame;
          const savedCandidates = [];
          for (const item of scored) {
            let thumbUrl = null;
            if (item.thumbBuffer?.length) {
              const savedThumb = await tasks.saveOutput(randomId("viggle_candidate_"), item.thumbBuffer, "jpg");
              thumbUrl = savedThumb.url;
            }
            savedCandidates.push({ frame: item.frame, score: item.score, black: item.black, thumbUrl });
          }
          job.selection = { mode: "heuristic", engine: "laplacian+center", selectedFrame: frame, candidates: savedCandidates };
          job.updatedAt = nowIso();
          logger.info(`参考帧自动选帧 ${job.id}: frame=${frame} score=${best.score} candidates=${scored.map((item) => `${item.frame}:${item.score}`).join(",")}`);
        }
        if (signal.aborted) throw new HttpError("制备已取消", { status: 400, code: "cancelled" });
        const frameSize = mediaPixelSize(extracted.buffer, "image/png", extracted.filename);

        job.step = "edit";
        job.progress = 0.35;
        job.updatedAt = nowIso();
        // 显存遥测：Qwen 编辑前记录空闲显存；读不到统计时跳过，不拦截。
        let freeMb = null;
        try {
          const stats = await comfy.systemStats();
          const device = Array.isArray(stats?.devices) ? stats.devices[0] : null;
          const free = Number(device?.vram_free ?? device?.vramFree ?? 0);
          if (free > 0) freeMb = Math.round(free / (1024 * 1024));
        } catch (error) {
          logger.warn(`读取 ComfyUI 显存失败，跳过参考帧制备遥测：${error.message}`);
        }
        logger.info(`参考帧制备显存遥测 ${freeMb === null ? "不可读（跳过）" : `${freeMb}MB`}，阈值 ${VIGGLE_PREPARE_MIN_FREE_MB}MB（仅遥测，不拦截）`);

        const entry = requireModel(registry, setup, "image-qwen21", "image", { mode: "edit" });
        const uploaded = await uploadImages(comfy, [{ buffer: extracted.buffer, originalname: extracted.filename, mimetype: "image/png" }]);
        const sizeText = frameSize ? `${frameSize.width}x${frameSize.height}` : "1024x1024";
        const context = buildContext({
          prompt,
          size: sizeText,
          count: 1,
          quality: body.quality,
          mode: "edit",
          images: [{ buffer: extracted.buffer, originalname: extracted.filename, mimetype: "image/png" }],
          uploadedImages: uploaded,
        });
        const result = await runImage({
          entry,
          context,
          comfy,
          timeoutMs: config.requestTimeoutMs,
          pollIntervalMs: config.pollIntervalMs,
          signal,
          requestId: req.id,
          logger,
          loraCatalog: setup.loraNames(),
          modelAliasFor: setup.modelAliasFor,
          loaderSpecs: setup.modelLoaderSpecs?.(),
        });
        const painted = result.files?.[0];
        if (!painted?.buffer?.length) {
          throw new HttpError("Qwen 图像编辑没有返回图片；请手动抽帧、编辑后上传", { status: 502, code: "qwen_unavailable" });
        }
        if (signal.aborted) throw new HttpError("制备已取消", { status: 400, code: "cancelled" });
        const paintedSize = mediaPixelSize(painted.buffer, painted.mimeType || "image/png", painted.filename || "");
        if (frameSize && paintedSize && (frameSize.width !== paintedSize.width || frameSize.height !== paintedSize.height)) {
          throw new HttpError(`参考帧尺寸与源帧不一致（源帧 ${frameSize.width}x${frameSize.height}，改图 ${paintedSize.width}x${paintedSize.height}）；请重试，或手动抽帧、编辑后上传同尺寸图片`, { status: 422, code: "frame_size_mismatch" });
        }
        const saved = await tasks.saveOutput(randomId("viggle_frame_"), painted.buffer, extFromMime(painted.mimeType, painted.filename, "png"));
        job.image = {
          url: saved.url,
          name: path.basename(saved.file),
          width: paintedSize?.width || frameSize?.width || 0,
          height: paintedSize?.height || frameSize?.height || 0,
          bytes: saved.bytes,
        };
        job.status = "ready";
        job.step = "ready";
        job.progress = 1;
        job.updatedAt = nowIso();
        logger.info(`Viggle 参考帧制备完成 ${job.id} frame=${frame} ${job.image.width}x${job.image.height}`);
      } catch (error) {
        if (signal.aborted) {
          job.status = "cancelled";
          job.error = { message: "制备已取消", code: "cancelled" };
        } else {
          job.status = "failed";
          job.error = { message: error.message || String(error), code: error.code || "prepare_failed" };
          logger.warn(`Viggle 参考帧制备失败 ${job.id}: ${job.error.message}`);
        }
        job.updatedAt = nowIso();
      } finally {
        if (vigglePrepareActive === job) vigglePrepareActive = null;
        retirePrepareJob(job.id);
      }
    };
    void run();
  });

  app.get("/v1/viggle/prepare-frame/:id", (req, res) => {
    const job = vigglePrepareJobs.get(String(req.params.id));
    if (!job) throw new HttpError("制备任务不存在", { status: 404, code: "prepare_not_found" });
    res.json(prepareResponse(req, job));
  });

  app.post("/v1/viggle/prepare-frame/:id/cancel", (req, res) => {
    const job = vigglePrepareJobs.get(String(req.params.id));
    if (!job) throw new HttpError("制备任务不存在", { status: 404, code: "prepare_not_found" });
    if (!["ready", "failed", "cancelled"].includes(job.status)) {
      job.status = "cancelling";
      job.updatedAt = nowIso();
      try {
        job.controller.abort(new Error("cancelled"));
      } catch {}
    }
    res.json(prepareResponse(req, job));
  });

  app.get("/api/previews/:promptId", (req, res) => {
    const preview = previewHub.get(req.params.promptId);
    if (!preview) throw new HttpError("预览还没有生成", { status: 404, code: "preview_not_ready" });
    res.setHeader("Cache-Control", "no-store");
    if (preview.step != null) res.setHeader("X-Preview-Step", String(preview.step));
    if (preview.total != null) res.setHeader("X-Preview-Total", String(preview.total));
    res.type(preview.mime).send(Buffer.from(preview.data, "base64"));
  });

  app.get("/api/progress/stream", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 32);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const snapshot = (requestId) => {
      const progress = previewHub.getByRequest(requestId);
      const preview = progress?.previewEnabled !== false && progress?.promptId ? previewHub.get(progress.promptId) : null;
      return {
        status: progress?.state || "pending",
        step: progress?.step || 0,
        total: progress?.total || 0,
        prompt_id: progress?.promptId || undefined,
        preview_url: preview ? `/api/previews/${encodeURIComponent(progress.promptId)}?t=${preview.updatedAt}` : undefined,
        preview_mime: preview?.mime || undefined,
      };
    };
    const send = (requestId) => {
      res.write(`data: ${JSON.stringify({ [requestId]: snapshot(requestId) })}\n\n`);
    };
    res.write(": connected\n\n");
    ids.forEach(send);
    const unsubscribe = previewHub.subscribe(({ requestId }) => {
      if (ids.includes(requestId)) send(requestId);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.get("/api/progress", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 32);
    const out = {};
    for (const id of ids) {
      const progress = previewHub.getByRequest(id);
      const preview = progress?.promptId ? previewHub.get(progress.promptId) : null;
      out[id] = {
        status: progress?.state || "pending",
        step: progress?.step || 0,
        total: progress?.total || 0,
        prompt_id: progress?.promptId || undefined,
        preview_url: preview ? `/api/previews/${encodeURIComponent(progress.promptId)}?t=${preview.updatedAt}` : undefined,
        preview_mime: preview?.mime || undefined,
      };
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  });

  app.get("/api/progress/:requestId", (req, res) => {
    const progress = previewHub.getByRequest(req.params.requestId);
    const preview = progress?.promptId ? previewHub.get(progress.promptId) : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: progress?.state || "pending",
      step: progress?.step || 0,
      total: progress?.total || 0,
      prompt_id: progress?.promptId || undefined,
      preview_url: preview ? `/api/previews/${encodeURIComponent(progress.promptId)}?t=${preview.updatedAt}` : undefined,
      preview_mime: preview?.mime || undefined,
    });
  });

  app.get("/v1/videos/:id/content", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const file = tasks.contentPath(req.params.id);
    if (!file) throw new HttpError("视频文件还没有生成完成", { status: 409, code: "video_not_ready" });
    res.sendFile(file);
  });

  app.post("/v1/videos/:id/cancel", async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const result = await tasks.cancel(req.params.id, comfy);
    res.json({ ...result, url: result.url ? absoluteTaskUrl(config, req, result.url) : null });
  });

  app.post("/v1/swap-chain", upload.any(), async (req, res) => {
    const files = req.files || [];
    const source = files.find((file) => file.fieldname === "source_video" || String(file.mimetype || "").startsWith("video/"));
    const refs = files.filter((file) => file !== source && String(file.mimetype || "").startsWith("image/")).slice(0, 2);
    if (!source) throw new HttpError("缺少源视频", { status: 400, code: "missing_source_video" });
    const job = await swapChain.create({
      source,
      refs,
      intent: req.body?.intent,
      mode: req.body?.mode,
      targetSelection: req.body?.target_selection,
      seed: req.body?.seed,
    });
    res.status(202).json(job);
  });

  app.get("/v1/swap-chain/:id", (req, res) => {
    const job = swapChain.get(req.params.id);
    if (!job) throw new HttpError("任务不存在", { status: 404, code: "job_not_found" });
    res.json(job);
  });

  app.get("/v1/swap-chain/:id/content/:artifact", (req, res) => {
    const file = swapChain.artifactPath(req.params.id, req.params.artifact);
    if (!file || !fs.existsSync(file)) throw new HttpError("产物尚未生成", { status: 404, code: "artifact_not_found" });
    res.sendFile(file);
  });

  app.post("/v1/swap-chain/:id/cancel", async (req, res) => {
    res.json(await swapChain.cancel(req.params.id));
  });

  app.post("/v1/swap-chain/:id/resume", async (req, res) => {
    res.json(await swapChain.resume(req.params.id));
  });

  app.get("/v1/tasks/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("任务不存在", { status: 404, code: "task_not_found" });
    res.json(taskResponse(req, task));
  });
  app.post("/v1/tasks/:id/cancel", async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("任务不存在", { status: 404, code: "task_not_found" });
    const result = await tasks.cancel(req.params.id, comfy);
    res.json({ ...result, url: result.url ? absoluteTaskUrl(config, req, result.url) : null });
  });


  // ---- 视频编辑预览（Phase2，§15 契约）：当前帧单图预览，后台按有无蒙版自动路由 ----
  const videoEditPreviewJobs = new Map();
  const videoEditPreviewTimeout = Math.min(Number(config.requestTimeoutMs) || 0, 5 * 60 * 1000) || 5 * 60 * 1000;

  function decodePreviewImage(value, field) {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value).trim();
    const match = /^data:([^;,]+)?(;base64)?,/i.exec(text);
    const base64 = match ? text.slice(match[0].length) : text;
    if (match && !match[2]) throw new HttpError(`${field} 必须是 base64 编码的图片`, { status: 400, code: `invalid_${field}` });
    let buffer;
    try { buffer = Buffer.from(base64, "base64"); } catch { buffer = Buffer.alloc(0); }
    if (!buffer.length) throw new HttpError(`${field} 不是有效的 base64 图片`, { status: 400, code: `invalid_${field}` });
    if (buffer.length > 32 * 1024 * 1024) throw new HttpError(`${field} 超过 32MB`, { status: 413, code: `too_large_${field}` });
    const mime = String(match?.[1] || "image/png").toLowerCase();
    return { buffer, mimetype: mime.startsWith("image/") ? mime : "image/png", originalname: `${field}.png` };
  }

  async function resolvePreviewSource(source) {
    const text = String(source || "").trim();
    if (!text) throw new HttpError("source 不能为空", { status: 400, code: "missing_source" });
    if (/^data:/i.test(text)) {
      const match = /^data:([^;,]+)?(;base64)?,/i.exec(text);
      if (!match?.[2]) throw new HttpError("source data URL 必须是 base64", { status: 400, code: "invalid_source" });
      const buffer = Buffer.from(text.slice(match[0].length), "base64");
      if (!buffer.length) throw new HttpError("source 为空", { status: 400, code: "invalid_source" });
      return { buffer, mimetype: match[1] || "video/mp4", originalname: "source.mp4" };
    }
    if (/^https?:/i.test(text)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("下载源视频超时")), 120000);
      try {
        const response = await fetch(text, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) throw new HttpError(`源视频下载失败：HTTP ${response.status}`, { status: 422, code: "source_unavailable" });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new HttpError("源视频为空", { status: 422, code: "source_unavailable" });
        if (buffer.length > (Number(config.maxUploadBytes) || 512 * 1024 * 1024)) throw new HttpError("源视频超过上传上限", { status: 413, code: "source_too_large" });
        return { buffer, mimetype: response.headers.get("content-type") || "video/mp4", originalname: "source.mp4" };
      } finally {
        clearTimeout(timer);
      }
    }
    const base = safeFileName(path.basename(text.replace(/[?#].*$/, "")));
    const candidates = [];
    if (/^\/files\//i.test(text)) {
      const name = decodeURIComponent(text.replace(/^\/files\//i, "").replace(/[?#].*$/, ""));
      candidates.push(path.join(config.outputDir, safeFileName(name)));
    }
    candidates.push(path.join(config.outputDir, base));
    candidates.push(path.join(config.dataDir, "uploads", base));
    if (path.isAbsolute(text)) candidates.push(text);
    for (const file of candidates) {
      try {
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
          return { buffer: fs.readFileSync(file), mimetype: "video/mp4", originalname: path.basename(file) };
        }
      } catch { /* 继续下一个候选 */ }
    }
    throw new HttpError("source 无法解析为本地视频或 URL；可传 /files 地址、data URL 或绝对路径", { status: 422, code: "source_unavailable" });
  }

  function previewProbeDuration(file) {
    const candidates = [
      process.env.FFPROBE_PATH,
      "ffprobe",
      config.comfyDir && path.join(config.comfyDir, "ffprobe.exe"),
      config.comfyDir && path.join(config.comfyDir, "..", "ffprobe.exe"),
      config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", "ffprobe.exe"),
    ].filter(Boolean);
    const binary = candidates.find((candidate) => {
      try { execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
    });
    if (!binary) throw new HttpError("网关未找到 ffprobe，无法按 frame_t 定位帧", { status: 422, code: "ffprobe_missing" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-edit-probe-"));
    try {
      const input = path.join(tempDir, "source.mp4");
      fs.writeFileSync(input, file.buffer);
      const raw = execFileSync(binary, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
      const duration = Number(String(raw).trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("duration invalid");
      return duration;
    } catch (error) {
      throw new HttpError(`源视频时长探测失败：${String(error?.message || error).slice(0, 200)}`, { status: 422, code: "frame_extract_failed" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function buildPreviewSwapGraph({ targetName, refName, prompt, strength, seed }) {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_bf16.safetensors", weight_dtype: "default" } },
      "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors", strength_model: 1 } },
      "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: "oldx-qwen2.1人物替换.safetensors", strength_model: strength } },
      "4": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
      "5": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "6": { class_type: "LoadImage", inputs: { image: targetName } },
      "7": { class_type: "LoadImage", inputs: { image: refName } },
      "10": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["5", 0], negative_prompt: "extra fingers, missing fingers, deformed hands, bad anatomy, malformed hands", resolution: 1024, prompt, "images.image_1": ["7", 0], "images.image_2": ["6", 0] } },
      "11": { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["5", 0] } },
      "12": { class_type: "CFGGuider", inputs: { model: ["3", 0], positive: ["10", 0], negative: ["10", 1], cfg: 1 } },
      "13": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
      "14": { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.35, 0.152292, 0" } },
      "15": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["15", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
      "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["5", 0] } },
      "18": { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: "video-edit-preview/swap" } },
    };
  }

  async function runPreviewSwap({ targetFile, refFile, prompt, strength }) {
    const [targetUpload, refUpload] = await uploadImages(comfy, [targetFile, refFile]);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const graph = buildPreviewSwapGraph({ targetName: targetUpload.name, refName: refUpload.name, prompt, strength, seed });
    const submitted = await comfy.submit(graph, { clientId: randomId("video-edit-preview-") });
    const deadline = Date.now() + videoEditPreviewTimeout;
    while (Date.now() < deadline) {
      await sleep(config.pollIntervalMs);
      const hist = await comfy.history(submitted.promptId).catch(() => null);
      if (!hist) continue;
      if (hist.status?.status_str === "error") {
        const reason = (hist.status?.messages || []).flat().join(" ").slice(0, 300);
        throw new HttpError(`OLDX 替换执行失败：${reason || "未知错误"}`, { status: 502, code: "swap_failed" });
      }
      const out = hist.outputs?.["18"]?.images?.[0];
      if (out) {
        const viewed = await comfy.view(out);
        return { buffer: viewed.buffer, promptId: submitted.promptId };
      }
    }
    throw new HttpError("OLDX 替换超时", { status: 504, code: "swap_timeout" });
  }

  async function runPreviewQwen({ jobId, mode, prompt, frameFile, maskFile, requestId }) {
    const entry = requireModel(registry, setup, "image-qwen21", "image");
    requireWorkflowMode(setup, entry, mode);
    const files = maskFile ? [frameFile, maskFile] : [frameFile];
    const uploadedImages = await uploadImages(comfy, files);
    const context = buildContext({ prompt, mode, count: 1, images: files, uploadedImages, params: {} });
    const result = await runImage({ entry, context, comfy, timeoutMs: config.requestTimeoutMs, pollIntervalMs: config.pollIntervalMs, requestId, logger, loraCatalog: setup.loraNames() });
    const file = result.files[0];
    if (!file?.buffer?.length) throw new HttpError("预览工作流没有返回图片", { status: 502, code: "no_preview_output" });
    return { buffer: file.buffer, promptId: result.promptId };
  }

  function saveVideoEditPreview(jobId, buffer) {
    const filename = `video-edit-${jobId}.png`;
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(path.join(config.outputDir, filename), buffer);
    return filename;
  }

  app.post("/v1/video-edit/preview", upload.any(), async (req, res) => {
    await reloadRegistryAndSnapshot();
    const body = req.body || {};
    const mode = String(body.mode || "").trim();
    if (!["swap", "edit"].includes(mode)) {
      throw new HttpError('mode 必须是 "swap" 或 "edit"', { status: 400, code: "invalid_mode" });
    }
    const frameT = Number(body.frame_t ?? body.frameT);
    const frameFileInput = decodePreviewImage(body.frame, "frame");
    const prompt = String(body.prompt ?? "").trim();
    const maskFile = decodePreviewImage(body.mask, "mask");
    const refFile = decodePreviewImage(body.ref, "ref");
    const strengthRaw = Number(body.strength);
    const strength = Math.max(0, Math.min(1, Number.isFinite(strengthRaw) ? strengthRaw : 0.9));
    if (mode === "swap" && !maskFile && !refFile) {
      throw new HttpError("swap 预览需要 ref 角色参考图", { status: 400, code: "missing_ref" });
    }
    if (!frameFileInput && (!Number.isFinite(frameT) || frameT < 0 || frameT > 1)) {
      throw new HttpError("未提供 frame 时，frame_t 必须是 0–1 之间的数字", { status: 400, code: "invalid_frame_t" });
    }
    const jobId = randomId("preview-");
    const job = { id: jobId, status: "running", imageUrl: null, error: null, route: "", promptId: null, createdAt: nowIso() };
    videoEditPreviewJobs.set(jobId, job);
    if (videoEditPreviewJobs.size > 200) {
      const oldest = videoEditPreviewJobs.keys().next().value;
      if (oldest) videoEditPreviewJobs.delete(oldest);
    }
    try {
      let frameFile;
      if (frameFileInput) {
        frameFile = { ...frameFileInput, originalname: "video-edit-frame.png" };
      } else {
        const sourceFile = await resolvePreviewSource(body.source);
        const duration = previewProbeDuration(sourceFile);
        const frameIndex = Math.max(0, Math.round(frameT * duration * 24));
        const ffmpegConfig = { ...config, comfyDir: config.comfyDir || resources.comfyRoot?.() || "" };
        const frame = await extractVideoFrame(sourceFile, { frame: frameIndex, config: ffmpegConfig });
        frameFile = { buffer: frame.buffer, mimetype: "image/png", originalname: "video-edit-frame.png" };
      }
      let result;
      if (maskFile) {
        job.route = "qwen-inpaint";
        result = await runPreviewQwen({ jobId, mode: "inpaint", prompt, frameFile, maskFile, requestId: req.id });
      } else if (mode === "edit") {
        job.route = "qwen-edit";
        result = await runPreviewQwen({ jobId, mode: "edit", prompt, frameFile, maskFile: null, requestId: req.id });
      } else {
        job.route = "oldx-swap";
        const swapPrompt = prompt || "将目标人物替换为参考图中的人物；保持姿势、构图、背景与光照不变，只替换目标人物。";
        const finalPrompt = /^<rwth>/i.test(swapPrompt) ? swapPrompt : `<rwth>, ${swapPrompt}`;
        result = await runPreviewSwap({ targetFile: frameFile, refFile, prompt: finalPrompt, strength });
      }
      job.promptId = result.promptId || null;
      const filename = saveVideoEditPreview(jobId, result.buffer);
      job.imageUrl = absoluteTaskUrl(config, req, `/files/${encodeURIComponent(filename)}`);
      job.status = "completed";
      res.json({ job_id: jobId, image_url: job.imageUrl, status: job.status, route: job.route, prompt_id: job.promptId });
    } catch (error) {
      job.status = "failed";
      job.error = String(error?.message || error);
      throw error;
    }
  });

  app.get("/v1/video-edit/preview/:job_id", (req, res) => {
    const job = videoEditPreviewJobs.get(String(req.params.job_id || ""));
    if (!job) throw new HttpError("预览任务不存在", { status: 404, code: "preview_not_found" });
    res.json({ job_id: job.id, status: job.status, image_url: job.imageUrl, route: job.route, prompt_id: job.promptId, error: job.error });
  });

  app.get("/files/:name", (req, res) => {
    const filename = safeFileName(req.params.name);
    const file = path.join(config.outputDir, filename);
    if (!filename || !fs.existsSync(file)) throw new HttpError("文件不存在", { status: 404, code: "file_not_found" });
    res.sendFile(file);
  });

  app.use((req, res) => {
    res.status(404).json(jsonError(`Not found: ${req.method} ${req.path}`, { status: 404, code: "not_found" }));
  });

  app.use((error, req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      const limitMb = Math.round(Number(config.maxUploadBytes || 0) / (1024 * 1024));
      error.message = `上传文件过大：单个文件上限 ${limitMb} MB。请压缩或剪短视频后重试（有需要可在 launcher/config.json 调整 maxUploadBytes）。`;
    }
    const status = Number(error?.status) || (error instanceof multer.MulterError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 500);
    let code = error?.code || (status >= 500 ? "internal_error" : "bad_request");
    if (error?.type === "entity.parse.failed") code = "invalid_json";
    if (status >= 500 && /out of memory|CUDA OOM|\bOOM\b|allocation on device/i.test(String(error?.message || ""))) {
      lastOOM = { at: nowIso(), message: String(error.message) };
    }
    logger.error(`${req.method} ${req.path} -> ${status} ${error?.message || error} ${req.id}`);
    if (res.headersSent) return;
    res.status(status).json(
      jsonError(error?.message || "Internal error", {
        status,
        code,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        details: error?.details,
      }),
    );
  });

  return { app, config, logger, registry, tasks, sessions, setup, comfy, skinUnlocks, abortActiveRequests, assistant };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { app, config, logger, tasks, setup, comfy, abortActiveRequests, assistant } = await createGatewayApp();
  let cleanupTimer = null;
  let stopping = false;
  const cleanup = () =>
    tasks.cleanup({ retentionDays: config.taskRetentionDays, maxTasks: config.maxStoredTasks }).catch((error) => logger.warn(`清理任务失败：${error.message}`));
  const server = app.listen(config.port, config.host, () => {
    logger.info(`ComfyUI gateway ${config.version} listening on http://${config.host}:${config.port}`);
    logger.info(`ComfyUI: ${config.comfyUrl} | workflows: ${config.workflowDir}`);
    if (config.scanOnStart) setup.start();
    if (config.taskRetentionDays > 0 || config.maxStoredTasks > 0) {
      void cleanup();
      cleanupTimer = setInterval(cleanup, config.cleanupIntervalMs);
      if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
    }
  });
  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down");
    if (cleanupTimer) clearInterval(cleanupTimer);
    await stopGateway({ tasks, comfy, setup, server, abortActiveRequests, assistant, logger });
    process.exit(exitCode);
  };
  app.locals.requestShutdown = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
