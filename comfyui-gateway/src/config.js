import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");
const appRoot = path.resolve(rootDir, "..");

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function count(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function list(value, fallback) {
  const raw = String(value ?? fallback ?? "");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const port = num(overrides.port ?? process.env.PORT, 8190);
  const host = overrides.host ?? process.env.HOST ?? "127.0.0.1";
  const allowRemote = String(process.env.ALLOW_REMOTE || "").trim() === "1";
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) && !allowRemote) {
    throw new Error("网关默认只允许绑定本机回环地址；如确需局域网访问，请设置 ALLOW_REMOTE=1。");
  }
  const config = {
    rootDir,
    appRoot,
    port,
    host,
    comfyUrl: String(overrides.comfyUrl ?? process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/+$/, ""),
    comfyDir: String(overrides.comfyDir ?? process.env.COMFYUI_DIR ?? "").trim(),
    comfyFrontendDir: String(overrides.comfyFrontendDir ?? process.env.COMFY_FRONTEND_DIR ?? "").trim(),
    comfyWorkflowsDir: String(overrides.comfyWorkflowsDir ?? process.env.COMFY_WORKFLOWS_DIR ?? "").trim(),
    scanOnStart: overrides.scanOnStart ?? process.env.SCAN_ON_START !== "0",
    watchWorkflows: overrides.watchWorkflows ?? process.env.WATCH_WORKFLOWS !== "0",
    scanDebounceMs: num(overrides.scanDebounceMs ?? process.env.SCAN_DEBOUNCE_MS, 800),
    workflowDir: path.resolve(overrides.workflowDir ?? process.env.WORKFLOW_DIR ?? path.join(rootDir, "workflows")),
    dataDir: path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(rootDir, "data")),
    outputDir: path.resolve(overrides.outputDir ?? process.env.OUTPUT_DIR ?? path.join(rootDir, "data", "outputs")),
    publicBaseUrl: String(overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/+$/, ""),
    launcherControlUrl: String(overrides.launcherControlUrl ?? process.env.LAUNCHER_CONTROL_URL ?? "").replace(/\/+$/, ""),
    corsOrigins: overrides.corsOrigins ?? list(process.env.CORS_ORIGINS, "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8188,http://127.0.0.1:8188"),
    requestTimeoutMs: num(overrides.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS, 10 * 60 * 1000),
    videoTimeoutMs: num(overrides.videoTimeoutMs ?? process.env.VIDEO_TIMEOUT_MS, 0),
    pollIntervalMs: num(overrides.pollIntervalMs ?? process.env.POLL_INTERVAL_MS, 750),
    comfyRetryAttempts: num(overrides.comfyRetryAttempts ?? process.env.COMFY_RETRY_ATTEMPTS, 3),
    comfyRetryDelayMs: num(overrides.comfyRetryDelayMs ?? process.env.COMFY_RETRY_DELAY_MS, 500),
    taskRetentionDays: count(overrides.taskRetentionDays ?? process.env.TASK_RETENTION_DAYS, 0),
    maxStoredTasks: count(overrides.maxStoredTasks ?? process.env.MAX_STORED_TASKS, 0),
    cleanupIntervalMs: num(overrides.cleanupIntervalMs ?? process.env.CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
    sessionStaleSec: num(overrides.sessionStaleSec ?? process.env.SESSION_STALE_SEC, 120),
    maxUploadBytes: num(overrides.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    outpaintMaxMegapixels: num(overrides.outpaintMaxMegapixels ?? process.env.OUTPAINT_MAX_MEGAPIXELS, 4),
    maxWorkflowBytes: num(overrides.maxWorkflowBytes ?? process.env.MAX_WORKFLOW_BYTES, 5 * 1024 * 1024),
    maxImageCount: num(overrides.maxImageCount ?? process.env.MAX_IMAGE_COUNT, 15),
    updateEnabled: overrides.updateEnabled ?? process.env.UPDATE_ENABLED !== "0",
    updateManifestPath: path.resolve(overrides.updateManifestPath ?? process.env.UPDATE_MANIFEST_PATH ?? path.join(appRoot, "update.json")),
    updateManifestUrl: String(overrides.updateManifestUrl ?? process.env.UPDATE_MANIFEST_URL ?? "https://www.modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/resolve/master/update.json").trim(),
    updateManifestUrlBackup: String(overrides.updateManifestUrlBackup ?? process.env.UPDATE_MANIFEST_URL_BACKUP ?? "https://raw.githubusercontent.com/1314521gjy/ComfyUI-Local-Infinite-Canvas/main/update.json").trim(),
    updateRemote: String(overrides.updateRemote ?? process.env.UPDATE_REMOTE ?? "origin").trim(),
    updateBranch: String(overrides.updateBranch ?? process.env.UPDATE_BRANCH ?? "main").trim(),
    updateFetchTimeoutMs: num(overrides.updateFetchTimeoutMs ?? process.env.UPDATE_FETCH_TIMEOUT_MS, 30000),
    updateApplyTimeoutMs: num(overrides.updateApplyTimeoutMs ?? process.env.UPDATE_APPLY_TIMEOUT_MS, 600000),
    resourcesIndexUrl: String(
        overrides.resourcesIndexUrl ??
            process.env.RESOURCES_INDEX_URL ??
            "https://www.modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/resolve/master/comfyui-gateway/resources/index.json",
    ).trim(),
    resourcesIndexUrlBackup: String(
        overrides.resourcesIndexUrlBackup ??
            process.env.RESOURCES_INDEX_URL_BACKUP ??
            "https://raw.githubusercontent.com/1314521gjy/ComfyUI-Local-Infinite-Canvas/main/comfyui-gateway/resources/index.json",
    ).trim(),
    resourcesFetchTimeoutMs: num(overrides.resourcesFetchTimeoutMs ?? process.env.RESOURCES_FETCH_TIMEOUT_MS, 8000),
    resourceConcurrency: num(overrides.resourceConcurrency ?? process.env.RESOURCE_CONCURRENCY, 2),
    allowRemote,
    gatewayToken: String(process.env.GATEWAY_TOKEN || "").trim(),
    version: "0.1.0",
  };
  if (config.corsOrigins.includes("*") && !allowRemote) {
    throw new Error("CORS_ORIGINS 不能使用通配符；请列出本地画布地址，或设置 ALLOW_REMOTE=1。");
  }
  if (config.comfyWorkflowsDir) config.comfyWorkflowsDir = path.resolve(config.comfyWorkflowsDir);
  if (config.comfyDir) config.comfyDir = path.resolve(config.comfyDir);
  if (config.comfyFrontendDir) config.comfyFrontendDir = path.resolve(config.comfyFrontendDir);
  fs.mkdirSync(config.workflowDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
  return config;
}

export function createLogger(prefix = "gateway") {
  const write = (level, message, extra) => {
    const line = `[${new Date().toISOString()}] [${prefix}] ${level} ${message}`;
    if (extra === undefined) console.log(line);
    else console.log(line, typeof extra === "string" ? extra : JSON.stringify(extra));
  };
  return {
    info: (message, extra) => write("INFO", message, extra),
    warn: (message, extra) => write("WARN", message, extra),
    error: (message, extra) => write("ERROR", message, extra),
  };
}
