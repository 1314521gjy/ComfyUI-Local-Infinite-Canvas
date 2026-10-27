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
import { createComfyBridge } from "./comfy-bridge.js";
import { createComfyClient } from "./comfy-client.js";
import { createLogger, loadConfig } from "./config.js";
import { createMainModelStore } from "./main-models.js";
import { createRegistry } from "./registry.js";
import { createSessionTracker } from "./sessions.js";
import { createSetupManager } from "./setup.js";
import { createResourceManager } from "./resources.js";
import { createPromptOptimizer } from "./prompt-optimizer.js";
import { reorderQwenEditFiles, reorderQwenEditPrompt } from "./qwen-edit.js";
import { createVideoInterpolator } from "./video-interpolation.js";
import { createPreviewHub } from "./preview-hub.js";
import { createFreeWorkflowStore, applyFreeInputs } from "./free-workflows.js";
import { applyMossLayoutPrompt } from "./layout-prompt.js";
import { runImage, runVideo, runWorkflow } from "./runner.js";
import { createSkinUnlockStore } from "./skin-unlocks.js";
import { readSystemStats } from "./system-stats.js";
import { createTaskStore } from "./tasks.js";
import { applyUpdate, checkForUpdate } from "./update.js";
import { uploadImages } from "./uploads.js";
import { createWorkflowVisibilityStore } from "./workflow-visibility.js";
import { extFromMime, jsonError, nowIso, parseSize, randomId, safeFileName, sleep } from "./util.js";

class HttpError extends Error {
  constructor(message, { status = 400, code = "bad_request", details } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function probeVideoFrames(file) {
  if (!file?.buffer?.length) return 0;
  const rawExt = extFromMime(file.mimetype) || ".mp4";
  const ext = String(rawExt).startsWith(".") ? rawExt : `.${rawExt}`;
  const temp = path.join(os.tmpdir(), `comfy-probe-${randomId()}${ext}`);
  try {
    fs.writeFileSync(temp, file.buffer);
    const raw = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-show_entries", "format=duration", "-of", "json", temp], { encoding: "utf8", timeout: 20000 });
    const data = JSON.parse(raw);
    const rate = String(data.streams?.[0]?.avg_frame_rate || "0/1").split("/").map(Number);
    const fps = rate[1] ? rate[0] / rate[1] : rate[0];
    const duration = Number(data.format?.duration || 0);
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) return 0;
    return Math.max(1, Math.round(fps * duration));
  } catch {
    return 0;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
    }
  }
}

function corsMiddleware(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = config.corsOrigins.includes("*") || (origin && config.corsOrigins.includes(origin));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.includes("*") ? "*" : origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With, X-Request-Id");
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

function requireModel(registry, setup, model, expectedType) {
  const name = String(model || "").trim();
  if (!name) throw new HttpError("缺少 model 参数", { status: 400, code: "missing_model" });
  const found = registry.resolveModel(name, (setup.loaderOptions?.() || {}));
  if (!found) throw new HttpError(`未找到模型：${name}。请先在网关注册工作流，或在画布渠道里拉取模型列表。`, { status: 404, code: "model_not_found" });
  if (expectedType && found.entry.type !== expectedType) throw new HttpError(`模型 ${name} 的类型是 ${found.entry.type}，不是 ${expectedType}`, { status: 400, code: "model_type_mismatch" });
  return found.entry;
}

export async function createGatewayApp(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = createLogger(overrides.logPrefix || "gateway");
  const previewHub = createPreviewHub({ comfyUrl: config.comfyUrl, logger });
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
    publicBaseUrl: config.publicBaseUrl,
    logger,
    retentionDays: config.taskRetentionDays,
    maxTasks: config.maxStoredTasks,
  });
  await tasks.load();
  const freeWorkflows = createFreeWorkflowStore({
    dataDir: config.dataDir,
    comfyWorkflowsDir: config.comfyWorkflowsDir,
    comfy,
    logger,
    maxWorkflowBytes: config.maxWorkflowBytes,
  });
  await freeWorkflows.load();
  const skinUnlocks = createSkinUnlockStore({ dataDir: config.dataDir, logger });
  await skinUnlocks.load();
  const workflowVisibility = createWorkflowVisibilityStore({ dataDir: config.dataDir, logger });
  await workflowVisibility.load();
  const comfyBridge = createComfyBridge({ config, logger });
  const bridgeStatus = await comfyBridge.ensure();
  if (!bridgeStatus.installed) logger.warn(`ComfyUI 工作流桥接未安装：${bridgeStatus.reason || "未知原因"}`);
  const sessions = createSessionTracker({ staleMs: config.sessionStaleSec * 1000 });
  const setup = createSetupManager({ config, registry, comfy, logger, mainModelFile: (id) => mainModels.fileForWorkflow(id) });
  const resources = createResourceManager({ config, setup, registry, logger, workflowVisibility, mainModels });
  await resources.init();
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
  const promptOptimizer = createPromptOptimizer({ config, comfy, logger });
  const videoInterpolator = createVideoInterpolator({ config, logger });

  // 把 parameters.optionsFrom（如 "UpscaleModelLoader.model_name"）替换成 ComfyUI 实时选项。
  const enrichParameters = (parameters) => {
    const loaders = setup.loaderOptions?.() || {};
    return (Array.isArray(parameters) ? parameters : []).map((parameter) => {
      const source = String(parameter?.optionsFrom || "").trim();
      if (!source) return parameter;
      const [classType] = source.split(".");
      const options = Array.isArray(loaders[classType]) ? loaders[classType] : [];
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
    res.on("finish", () => logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms ${req.id}`));
    next();
  });
  app.use(corsMiddleware(config));
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 12 },
  });

  app.get("/health", async (_req, res) => {
    const reachable = await Promise.race([comfy.isReachable(), sleep(1500).then(() => false)]);
    res.json({
      status: "ok",
      version: config.version,
      comfy: { url: config.comfyUrl, reachable },
      workflows: { count: registry.list().length },
      setup: { phase: setup.status().phase, counts: setup.status().counts },
      tasks: { count: tasks.list().length, retentionDays: config.taskRetentionDays, maxStoredTasks: config.maxStoredTasks },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/setup/status", (_req, res) => {
    res.json({ ok: true, status: setup.status(), comfyUrl: config.comfyUrl });
  });

  app.get("/api/resources/status", (_req, res) => {
    res.json(resources.status());
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
    const taskOOM = tasks.list().find((task) => /out of memory|CUDA OOM|\bOOM\b|allocation on device/i.test(task.error || ""));
    res.json({
      ok: true,
      ...stats,
      comfy: { url: config.comfyUrl, reachable: setup.status().comfyReachable },
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

  app.post("/api/update/apply", async (req, res) => {
    const active = tasks.list().some((task) => ["queued", "running"].includes(task.status));
    if (active) {
      throw new HttpError("有正在运行的生成任务，请等待完成或取消后再更新", { status: 409, code: "tasks_running" });
    }
    res.json(await applyUpdate(config, { dryRun: req.body?.dryRun === true }));
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

  app.post("/api/setup/scan", (_req, res) => {
    void setup.scan().catch((error) => logger.warn(`manual setup scan failed: ${error.message}`));
    res.json({ ok: true, status: setup.status() });
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

  app.get("/api/tasks", (_req, res) => {
    res.json({ tasks: tasks.list().slice(0, 50) });
  });

  app.get("/v1/models", async (_req, res) => {
    await registry.reloadIfChanged();
    const data = registry
      .listModels((setup.loaderOptions?.() || {}))
      .filter((model) => setup.isAvailable(model.baseId) && !model.entry.hidden && model.entry.category !== "upscale" && !workflowVisibility.isHidden(model.entry.id))
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
          parameters: enrichParameters(model.entry.parameters),
          availability: setup.workflowStatus(model.baseId),
        },
      }));
    res.json({ object: "list", data });
  });

  app.get("/api/workflows", async (_req, res) => {
    await registry.reloadIfChanged();
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
    logger.info(`imported workflow ${result.workflow.name} (${result.workflow.type})`);
    res.status(201).json({ ok: true, ...result });
  });

  app.post("/api/workflows/scan", async (_req, res) => {
    const result = await registry.scan();
    res.json({ ok: true, ...result });
  });

  app.post("/api/workflows/reload", async (_req, res) => {
    await registry.load();
    res.json({ ok: true, count: registry.list().length });
  });

  app.delete("/api/workflows/:id", async (req, res) => {
    const removed = await registry.remove(req.params.id);
    if (!removed) throw new HttpError("工作流不存在", { status: 404, code: "workflow_not_found" });
    res.json({ ok: true });
  });

  const requireFreeWorkflow = (id) => {
    const entry = freeWorkflows.get(id);
    if (!entry) throw new HttpError("自由卡片不存在", { status: 404, code: "free_workflow_not_found" });
    return entry;
  };

  app.get("/api/free-workflows/sources", async (_req, res) => {
    res.json({ sources: await freeWorkflows.listSources(), dir: config.comfyWorkflowsDir || "" });
  });

  app.get("/api/free-workflows", async (req, res) => {
    const archived = req.query.archived === "1" || req.query.archived === "true";
    res.json({ workflows: await freeWorkflows.list(archived ? { archived: true } : {}) });
  });

  app.post("/api/free-workflows/import", async (req, res) => {
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

  app.get("/api/free-workflows/:id/ui", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    try {
      res.json(await freeWorkflows.readRawWorkflow(entry));
    } catch (error) {
      const message = /ENOENT/.test(String(error.message)) ? "源工作流文件已不存在，可能已在 ComfyUI 中删除" : error.message;
      throw new HttpError(`读取工作流失败：${message}`, { status: 409, code: "free_workflow_read_failed" });
    }
  });

  app.get("/api/free-workflows/:id/open", async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    const source = await freeWorkflows.sourceState(entry);
    if (!source.exists) throw new HttpError("源工作流文件已不存在，无法在 ComfyUI 中编辑", { status: 409, code: "free_workflow_source_missing" });
    const bridge = await comfyBridge.ensure();
    const target = new URL(config.comfyUrl);
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
      const result = await freeWorkflows.sync(req.params.id);
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

  app.post("/v1/free-workflows/:id/images", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    if (entry.bindings?.outputType !== "image") {
      throw new HttpError("这个自由卡片不是图片工作流", { status: 400, code: "free_workflow_not_image" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    if (entry.bindings?.prompt && !prompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const parsedSize = parseSize(body.size);
    const workflow = applyFreeInputs(entry.workflow, entry.bindings, {
      prompt,
      uploadedImages,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
    });
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    let result;
    try {
      result = await runWorkflow({
        entry: { name: entry.name, type: "image", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt, count: 1 }),
        comfy,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal: abort.signal,
        requestId: req.id,
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
    const files = result.files.filter((file) => /^image\//i.test(file.mimeType) || /\.(png|jpe?g|webp)$/i.test(file.filename));
    if (!files.length) throw new HttpError("自由工作流没有返回图片", { status: 502, code: "no_images" });
    logger.info(`free image ${entry.name} -> ${result.promptId} (${files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        data.push({ url: saved.url });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/free-workflows/:id/videos", upload.any(), async (req, res) => {
    const entry = requireFreeWorkflow(req.params.id);
    if (entry.bindings?.outputType !== "video") {
      throw new HttpError("这个自由卡片不是视频工作流", { status: 400, code: "free_workflow_not_video" });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || "");
    if (entry.bindings?.prompt && !prompt.trim()) {
      throw new HttpError("这个工作流需要正向提示词", { status: 400, code: "missing_prompt" });
    }
    const uploadedImages = await uploadImages(comfy, orderedPromptImages(req.files || []));
    const parsedSize = parseSize(body.size);
    const workflow = applyFreeInputs(entry.workflow, entry.bindings, {
      prompt,
      uploadedImages,
      size: parsedSize ? { width: parsedSize.width, height: parsedSize.height } : undefined,
      count: body.n ?? body.count,
      seed: body.seed,
      seedFixed: body.seedFixed,
      ratio: body.ratio,
    });
    const task = tasks.create({
      model: entry.name,
      request: {
        prompt,
        size: body.size,
        images: uploadedImages.map((image) => image.name),
      },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      const result = await runVideo({
        entry: { name: entry.name, type: "video", workflow, bindings: {}, defaults: {}, presets: {} },
        context: buildContext({ prompt, count: 1 }),
        comfy,
        timeoutMs: config.videoTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        signal,
        requestId: req.id,
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
    await registry.reloadIfChanged();
    const body = req.body || {};
    const baseEntry = requireModel(registry, setup, body.model, "image");
    const mode = String(body.mode || body.imageMode || "").trim();
    const entry = mode ? registry.resolveForMode(baseEntry, mode) : baseEntry;
    if (body.background && !entry.bindings?.background && !entry.backgroundPrompt) {
      throw new HttpError(`工作流 ${entry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const context = buildContext({
      prompt: applyBackgroundPrompt(body.prompt, body.background, entry),
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
    logger.info(`image ${entry.name} -> ${result.promptId} (${result.files.length} file(s)) ${req.id}`);
    const responseFormat = String(body.response_format || "b64_json").toLowerCase();
    const data = [];
    for (const file of result.files) {
      if (responseFormat === "url") {
        const saved = await tasks.saveOutput(randomId("img_"), file.buffer, extFromMime(file.mimeType, file.filename, "png"));
        data.push({ url: saved.url });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("ComfyUI 没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/images/upscale", upload.any(), async (req, res) => {
    await registry.reloadIfChanged();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "image-esrgan-upscale", "image");
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
        data.push({ url: saved.url });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    if (!data.length) throw new HttpError("超分工作流没有返回图片", { status: 502, code: "no_images" });
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/images/edits", upload.any(), async (req, res) => {
    await registry.reloadIfChanged();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model, "image");
    const files = imageFilesFrom(req.files || []);
    if (!files.length) throw new HttpError("图片编辑请求缺少参考图", { status: 400, code: "missing_input_image" });
    const mode = String(body.mode || "").trim() || (entry.variants ? Object.keys(entry.variants)[0] : "");
    if (entry.variants && !entry.variants[mode]) {
      throw new HttpError(`模型 ${entry.name} 不支持功能：${mode || "（空）"}`, { status: 400, code: "unsupported_image_mode" });
    }
    if (entry.id === "image-qwen21") {
      if (mode === "inpaint" && files.length !== 2) {
        throw new HttpError("Qwen 局部重绘需要 2 张图：原图 + 二值蒙版", { status: 400, code: "invalid_inpaint_media" });
      }
      if (mode === "edit" && files.length > 4) {
        throw new HttpError("Qwen 多图编辑最多 4 张参考图", { status: 400, code: "too_many_reference_images" });
      }
      if (mode === "outpaint" && files.length !== 1) {
        throw new HttpError("Qwen 扩图需要且只接收 1 张原图", { status: 400, code: "invalid_outpaint_media" });
      }
    }
    const qwenEdit = entry.id === "image-qwen21" && mode === "edit" && files.length > 1;
    const orderedFiles = qwenEdit ? reorderQwenEditFiles(files) : files;
    const promptText = qwenEdit ? reorderQwenEditPrompt(body.prompt, files.length) : body.prompt;
    const resolvedEntry = registry.resolveForMode(entry, mode);
    if (body.background && !resolvedEntry.bindings?.background && !resolvedEntry.backgroundPrompt) {
      throw new HttpError(`工作流 ${resolvedEntry.name} 没有 background 绑定，不能保证透明背景。`, { status: 400, code: "unsupported_background" });
    }
    const uploadedImages = await uploadImages(comfy, orderedFiles);
    const context = buildContext({
      prompt: applyBackgroundPrompt(promptText, body.background, resolvedEntry),
      negative: body.negative,
      size: body.size,
      count: body.n ?? body.count,
      quality: body.quality,
      background: body.background,
      mode,
      images: orderedFiles,
      uploadedImages,
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
        data.push({ url: saved.url });
      } else {
        data.push({ b64_json: file.buffer.toString("base64") });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  });

  app.post("/v1/prompts/optimize", upload.any(), async (req, res) => {
    const body = req.body || {};
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
    const uploadedImages = await uploadImages(comfy, files.slice(0, 1));
    const abort = abortOnDisconnect(req, res, registerActiveRequest);
    try {
      const result = await promptOptimizer.captionImage({
        uploadedImages,
        language: body.language,
        instruction: body.instruction,
        engine: body.engine,
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
    await registry.reloadIfChanged();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model || "video-seedvr2-upscale", "video");
    if (entry.category !== "upscale") {
      throw new HttpError(`模型 ${entry.name} 不是视频超分工作流`, { status: 400, code: "not_upscale_workflow" });
    }
    const videoFiles = orderedVideoRefFiles(req.files || []);
    if (!videoFiles.length) throw new HttpError("视频超分请求缺少输入视频", { status: 400, code: "missing_input_video" });
    const uploadedVideos = await uploadImages(comfy, videoFiles);
    const params = parseParams(body.params);
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
    const task = tasks.create({
      model: "video-rife",
      request: { mode: "interpolate", multiplier, video: source.originalname || "input.mp4" },
    });
    tasks.enqueue(task, async (_task, progress, signal) => {
      progress?.({ phase: "interpolating", progress: 0.1 });
      const interpolated = await videoInterpolator.interpolate({
        comfy,
        buffer: source.buffer,
        filename: source.originalname || "input.mp4",
        multiplier: multiplier === "3x" ? 3 : 2,
        requestId: req.id,
        signal,
        timeoutMs: Number(config.videoTimeoutMs) > 0 ? config.videoTimeoutMs : 10 * 60 * 1000,
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
    await registry.reloadIfChanged();
    const body = req.body || {};
    const entry = requireModel(registry, setup, body.model, "video");
    const files = orderedVideoFiles(req.files || []);
    const videoFiles = orderedVideoRefFiles(req.files || []);
    const audioFiles = orderedAudioRefFiles(req.files || []);
    const extraParams = parseParams(body.params);
    const params = { ...extraParams };
    const interpolation = String(params.interpolation || "off").trim();
    if (!["off", "2x", "3x"].includes(interpolation)) {
      throw new HttpError("插帧只支持 off、2x、3x", { status: 400, code: "invalid_interpolation" });
    }
    let videoMode = String(body.mode || "").trim();
    if (entry.id === "video-h3-t2v") videoMode = "text";
    else if (entry.id === "video-h3-frames") videoMode = "frames";
    else if (entry.id === "video-h3-ref2va") videoMode = "reference";
    let requiredImageCount = Object.values(entry.bindings || {}).reduce((max, binding) => {
      if (!binding) return max;
      if (binding.from === "image" && binding.array) return Math.max(max, Number(binding.min ?? 0));
      if (binding.required && (binding.from === "image" || binding.imageIndex !== undefined)) {
        return Math.max(max, (Number.isInteger(binding.imageIndex) ? binding.imageIndex : 0) + 1);
      }
      return max;
    }, 0);
    if (entry.id === "video-h3-t2v") {
      if (files.length || videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 文生视频不接收图片/视频/音频；首尾帧请选 H3 首尾帧，多参请选 H3 多参", { status: 400, code: "unsupported_video_media" });
      }
      requiredImageCount = 0;
    } else if (entry.id === "video-h3-frames") {
      if (videoFiles.length || audioFiles.length) {
        throw new HttpError("H3 首尾帧只接收 1–2 张图片；音频/视频请选 H3 多参", { status: 400, code: "unsupported_video_media" });
      }
      const frameMode = String(params.frameMode || (files.length >= 2 ? "both" : "first"));
      if (!["first", "last", "both"].includes(frameMode)) {
        throw new HttpError("frameMode 必须是 first、last 或 both", { status: 400, code: "invalid_frame_mode" });
      }
      params.frameMode = frameMode;
      requiredImageCount = frameMode === "both" ? 2 : 1;
    }
    if (files.length < requiredImageCount) {
      const hint = entry.id === "video-h3-ref2va" ? "（H3 多参支持 1–6 图 / 0–2 音频 / 0–1 视频，至少一种媒体）" : entry.id === "video-h3-frames" ? "（首尾帧支持首帧、尾帧或首尾帧；首尾帧模式需要 2 张图）" : "";
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${requiredImageCount} 张参考图${hint}`, { status: 400, code: "missing_reference_image" });
    }
    if (entry.minMedia && files.length + videoFiles.length + audioFiles.length < Number(entry.minMedia)) {
      throw new HttpError(`工作流 ${entry.name} 需要至少 ${entry.minMedia} 个参考素材（图片/音频/视频）`, { status: 400, code: "missing_reference_media" });
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
    if (videoFiles.length) context.sourceVideoFrames = probeVideoFrames(videoFiles[0]);
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
        onProgress: progress,
        logger,
        loraCatalog: setup.loraNames(),
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
    res.json({ id: task.id, object: "video", status: "queued", progress: 0, created_at: Math.floor(Date.now() / 1000) });
  });

  app.get("/v1/videos/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("视频任务不存在", { status: 404, code: "video_not_found" });
    const data = tasks.publicTask(task);
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
    });
  });

  app.get("/api/previews/:promptId", (req, res) => {
    const preview = previewHub.get(req.params.promptId);
    if (!preview) throw new HttpError("预览还没有生成", { status: 404, code: "preview_not_ready" });
    res.setHeader("Cache-Control", "no-store");
    if (preview.step != null) res.setHeader("X-Preview-Step", String(preview.step));
    if (preview.total != null) res.setHeader("X-Preview-Total", String(preview.total));
    res.type(preview.mime).send(Buffer.from(preview.data, "base64"));
  });

  app.get("/api/progress/:requestId", (req, res) => {
    const progress = previewHub.getByRequest(req.params.requestId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: progress?.state || "pending",
      step: progress?.step || 0,
      total: progress?.total || 0,
      prompt_id: progress?.promptId || undefined,
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
    res.json(result);
  });

  app.get("/v1/tasks/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) throw new HttpError("任务不存在", { status: 404, code: "task_not_found" });
    res.json(tasks.publicTask(task));
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

  return { app, config, logger, registry, tasks, sessions, setup, comfy, skinUnlocks };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { app, config, logger, tasks, setup } = await createGatewayApp();
  let cleanupTimer = null;
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
  const shutdown = async () => {
    logger.info("shutting down");
    setup.stop();
    if (cleanupTimer) clearInterval(cleanupTimer);
    server.close();
    await tasks.persistNow();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
