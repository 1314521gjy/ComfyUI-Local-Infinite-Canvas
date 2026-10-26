#!/usr/bin/env node
/**
 * 本地一键启动器（Windows / Node 24 / 零第三方依赖）
 *
 * 行为：
 *   - 先探测 ComfyUI(8188)、网关(8190)、画布(3000)，已在运行的一律“接管”，绝不重复启动；
 *   - 缺失的服务按 comfy → gateway → canvas 顺序拉起；
 *   - ComfyUI 找不到时如实提示，仍启动网关并打开 /admin；
 *   - 画布由内置静态服务器托管 infinite-canvas/web/dist（SPA fallback，仅绑 127.0.0.1）；
 *   - Ctrl+C 只停止“本启动器启动的”子进程；关闭画布最后一个页面时，连同接管的 ComfyUI 一起停止（可配置保留）。
 *
 * 用法：
 *   node launcher/start.mjs [--dry-run] [--no-open]
 *
 * 环境变量：COMFYUI_DIR / COMFY_URL / GATEWAY_PORT / CANVAS_PORT
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_PATH = path.join(__dirname, "launcher.log");

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes("--dry-run");
const NO_OPEN = ARGV.includes("--no-open");

const DEFAULT_CONFIG = {
  comfyUrl: "http://127.0.0.1:8188",
  comfyDir: "",
  comfyWorkflowsDir: "",
  gatewayPort: 8190,
  controlPort: 8290,
  canvasPort: 3000,
  gatewayDir: "",
  canvasDist: "",
  comfyStartTimeoutSec: 300,
  gatewayStartTimeoutSec: 30,
  openBrowser: true,
  closeCanvasStopsBackend: true,
  stopAdoptedComfyOnCanvasClose: true,
  canvasIdleGraceSec: 15,
};

/* ------------------------------------------------------------------ 日志 */

function log(message, level = "INFO") {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + os.EOL);
  } catch {
    /* 日志写失败不应中断启动 */
  }
}

function forwardLines(chunk, tag) {
  const text = String(chunk);
  for (const piece of text.split(/\r?\n/)) {
    if (piece.trim()) log(`[${tag}] ${piece}`, "CHILD");
  }
}

/* ------------------------------------------------------------------ 配置 */

function toPort(value, fallback, envName) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (envName && process.env[envName]) log(`环境变量 ${envName}=${process.env[envName]} 非法，忽略`, "WARN");
  return fallback;
}

function loadConfig() {
  let created = false;
  let fileConfig = {};
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + os.EOL, "utf8");
    created = true;
  } else {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`launcher/config.json 不是合法 JSON：${err.message}`);
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...fileConfig };
  const cfg = {
    comfyUrl: String(process.env.COMFY_URL || merged.comfyUrl || DEFAULT_CONFIG.comfyUrl).replace(/\/+$/, ""),
    comfyDir: String(process.env.COMFYUI_DIR || merged.comfyDir || ""),
    comfyWorkflowsDir: String(merged.comfyWorkflowsDir || ""),
    gatewayPort: toPort(process.env.GATEWAY_PORT ?? merged.gatewayPort, DEFAULT_CONFIG.gatewayPort, "GATEWAY_PORT"),
    controlPort: toPort(process.env.LAUNCHER_CONTROL_PORT ?? merged.controlPort, DEFAULT_CONFIG.controlPort, "LAUNCHER_CONTROL_PORT"),
    canvasPort: toPort(process.env.CANVAS_PORT ?? merged.canvasPort, DEFAULT_CONFIG.canvasPort, "CANVAS_PORT"),
    gatewayDir: path.resolve(ROOT, merged.gatewayDir || "comfyui-gateway"),
    canvasDist: path.resolve(ROOT, merged.canvasDist || path.join("infinite-canvas", "web", "dist")),
    comfyStartTimeoutSec: Number(merged.comfyStartTimeoutSec) > 0 ? Number(merged.comfyStartTimeoutSec) : 300,
    gatewayStartTimeoutSec: Number(merged.gatewayStartTimeoutSec) > 0 ? Number(merged.gatewayStartTimeoutSec) : 30,
    openBrowser: merged.openBrowser !== false,
    closeCanvasStopsBackend: process.env.CLOSE_CANVAS_STOPS_BACKEND !== "0" && merged.closeCanvasStopsBackend !== false,
    stopAdoptedComfyOnCanvasClose: process.env.STOP_ADOPTED_COMFY !== "0" && merged.stopAdoptedComfyOnCanvasClose !== false,
    canvasIdleGraceSec: Number(process.env.CANVAS_IDLE_GRACE_SEC ?? merged.canvasIdleGraceSec) > 0 ? Number(process.env.CANVAS_IDLE_GRACE_SEC ?? merged.canvasIdleGraceSec) : 15,
    configCreated: created,
  };
  cfg.gatewayUrl = `http://127.0.0.1:${cfg.gatewayPort}`;
  cfg.canvasUrl = `http://127.0.0.1:${cfg.canvasPort}`;
  cfg.controlUrl = `http://127.0.0.1:${cfg.controlPort}`;
  return cfg;
}

function persistDiscovery(cfg) {
  try {
    let file = {};
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      file = {};
    }
    file.comfyUrl = cfg.comfyUrl;
    file.comfyDir = cfg.comfyDir;
    file.comfyWorkflowsDir = cfg.comfyWorkflowsDir;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + os.EOL, "utf8");
  } catch (err) {
    log(`保存 launcher/config.json 失败：${err.message}`, "WARN");
  }
}

/* -------------------------------------------------------------- HTTP 探测 */

async function httpGet(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, text, json, contentType: res.headers.get("content-type") || "" };
  } catch {
    return { ok: false, status: 0, text: "", json: null, contentType: "" };
  } finally {
    clearTimeout(timer);
  }
}

const COMFY_PORT_FIRST = 8188;
const COMFY_PORT_LAST = 8199;

async function probeComfy(url) {
  const res = await httpGet(`${url.replace(/\/+$/, "")}/system_stats`, 2000);
  return res.ok;
}

async function detectComfy(cfg) {
  // 1) 首选 8188
  const primary = `http://127.0.0.1:${COMFY_PORT_FIRST}`;
  if (await probeComfy(primary)) return { url: primary, via: "8188 默认端口" };

  // 2) 扫 8189–8199（8188 已试过）
  for (let port = COMFY_PORT_FIRST + 1; port <= COMFY_PORT_LAST; port += 1) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeComfy(url)) return { url, via: `扫描 ${port}` };
  }

  // 3) 配置/环境变量里的地址
  if (cfg.comfyUrl && !cfg.comfyUrl.endsWith(`:${COMFY_PORT_FIRST}`)) {
    if (await probeComfy(cfg.comfyUrl)) return { url: cfg.comfyUrl, via: "config.comfyUrl" };
  }
  return null;
}

async function detectGateway(cfg) {
  const res = await httpGet(`${cfg.gatewayUrl}/health`, 2500);
  if (res.ok && res.json && typeof res.json === "object") return { url: cfg.gatewayUrl, health: res.json };
  return null;
}

async function detectCanvas(cfg) {
  const res = await httpGet(`${cfg.canvasUrl}/`, 2500);
  if (res.ok) return { url: cfg.canvasUrl };
  return null;
}

async function waitFor(label, probe, timeoutSec, { intervalMs = 3000, progressEveryMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  const started = Date.now();
  let nextNote = started + progressEveryMs;
  while (Date.now() < deadline) {
    const hit = await probe();
    if (hit) {
      log(`${label} 就绪（${Math.round((Date.now() - started) / 1000)}s）`);
      return hit;
    }
    if (Date.now() >= nextNote) {
      log(`${label} 仍在等待…（已 ${Math.round((Date.now() - started) / 1000)}s / 上限 ${timeoutSec}s）`);
      nextNote += progressEveryMs;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log(`${label} 在 ${timeoutSec}s 内未就绪`, "ERROR");
  return null;
}

/* ---------------------------------------------------------- ComfyUI 启动 */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function comfyInstallInfo(dir) {
  if (!dir || !isDir(dir)) return null;
  const bat = path.join(dir, "run_nvidia_gpu.bat");
  const mainPy = path.join(dir, "ComfyUI", "main.py");
  const mainPyFlat = path.join(dir, "main.py");
  const hasBat = isFile(bat);
  const hasMain = isFile(mainPy) || isFile(mainPyFlat);
  if (!hasBat && !hasMain) return null;

  const workflowCandidates = [
    path.join(dir, "ComfyUI", "user", "default", "workflows"),
    path.join(dir, "user", "default", "workflows"),
  ];
  const workflowsDir = workflowCandidates.find((p) => isDir(p)) || "";
  return { dir, bat: hasBat ? bat : "", mainPy: hasMain ? (isFile(mainPy) ? mainPy : mainPyFlat) : "", workflowsDir };
}

function findComfyInstall(cfg) {
  const home = os.homedir();
  const sameFolder = [
    ROOT,
    path.join(ROOT, "ComfyUI"),
    path.join(ROOT, "ComfyUI_windows_portable"),
    path.join(ROOT, "ComfyUI_windows_portable", "ComfyUI"),
    path.resolve(ROOT, ".."),
    path.resolve(ROOT, "..", "ComfyUI"),
    path.resolve(ROOT, "..", "ComfyUI_windows_portable"),
    path.resolve(ROOT, "..", "ComfyUI_windows_portable", "ComfyUI"),
  ];
  const common = [
    cfg.comfyDir,
    path.join(home, "ComfyUI"),
    path.join(home, "Documents", "ComfyUI"),
    "C:\\ComfyUI",
    "D:\\ComfyUI",
    "E:\\ComfyUI",
    "E:\\ComfyUI_windows_portable",
    "E:\\ComfyUI\\ComfyUI",
  ].filter(Boolean);

  const seen = new Set();
  const inspect = (raw, via) => {
    if (!raw) return null;
    const dir = path.resolve(raw);
    const key = dir.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const info = comfyInstallInfo(dir);
    if (info) log(`ComfyUI 探测命中（${via}）：${dir}`);
    return info;
  };

  for (const dir of sameFolder) {
    const info = inspect(dir, "同文件夹");
    if (info) return info;
  }

  const driveRoot = path.parse(ROOT).root;
  const skip = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "perflogs"]);
  const started = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(driveRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || skip.has(entry.name.toLowerCase())) continue;
    if (Date.now() - started > 2000) break;
    const dir = path.join(driveRoot, entry.name);
    const info = inspect(dir, "同盘");
    if (info) return info;
    if (/comfy/i.test(entry.name)) {
      const child = inspect(path.join(dir, "ComfyUI"), "同盘子目录");
      if (child) return child;
    }
  }

  for (const dir of common) {
    const info = inspect(dir, "常见目录/配置");
    if (info) return info;
  }
  return null;
}

function spawnComfy(install) {
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const child = spawn(comspec, ["/d", "/s", "/c", install.bat], {
    cwd: install.dir,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", (err) => log(`启动 ComfyUI 失败：${err.message}`, "ERROR"));
  child.unref();
  return child;
}

/* ------------------------------------------------------------- 网关启动 */

function spawnGateway(cfg, comfyUrl, workflowsDir) {
  const serverEntry = path.join(cfg.gatewayDir, "src", "server.js");
  if (!isFile(serverEntry)) {
    throw new Error(`找不到网关入口：${serverEntry}`);
  }
  const env = {
    ...process.env,
    PORT: String(cfg.gatewayPort),
    HOST: "127.0.0.1",
    COMFY_URL: comfyUrl,
    ...(cfg.comfyDir ? { COMFYUI_DIR: cfg.comfyDir } : {}),
    ...(cfg.launcherControlUrl ? { LAUNCHER_CONTROL_URL: cfg.launcherControlUrl } : {}),
  };
  if (workflowsDir) env.COMFY_WORKFLOWS_DIR = workflowsDir;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: cfg.gatewayDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => forwardLines(d, "gateway"));
  child.stderr.on("data", (d) => forwardLines(d, "gateway"));
  child.on("error", (err) => log(`启动网关失败：${err.message}`, "ERROR"));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) log(`网关子进程退出（code=${code}, signal=${signal}）`, "WARN");
  });
  return child;
}

/* --------------------------------------------------------- 画布静态服务 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function sendFile(req, res, filePath, statusCode = 200, cacheControl = "no-cache") {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  res.writeHead(statusCode, {
    "content-type": contentTypeFor(filePath),
    "content-length": stat.size,
    "cache-control": cacheControl,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function createCanvasServer(cfg) {
  const distDir = path.resolve(cfg.canvasDist);
  const indexPath = path.join(distDir, "index.html");

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
        res.end("405 Method Not Allowed");
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("400 Bad Request");
        return;
      }

      const relative = pathname.replace(/^[/\\]+/, "");
      const target = path.resolve(distDir, relative);
      const insideDist = target === distDir || target.startsWith(distDir + path.sep);
      if (!insideDist) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("403 Forbidden");
        return;
      }

      let stat = null;
      try {
        stat = await fsp.stat(target);
      } catch {
        stat = null;
      }

      if (stat && stat.isFile()) {
        const cache = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        await sendFile(req, res, target, 200, cache);
        return;
      }

      // 目录（含 /）或未命中：SPA fallback 到 index.html；带扩展名的资源缺失则 404
      if (!stat || stat.isDirectory()) {
        if (path.extname(pathname)) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
          return;
        }
        await sendFile(req, res, indexPath, 200, "no-cache");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    } catch (err) {
      log(`画布静态服务异常：${err.message}`, "ERROR");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("500 Internal Server Error");
    }
  });
}

/* --------------------------------------------------------------- 浏览器 */

function openBrowser(url) {
  if (DRY_RUN) {
    log(`[dry-run] 将打开浏览器：${url}`);
    return;
  }
  if (NO_OPEN) {
    log(`--no-open：跳过打开浏览器（${url}）`);
    return;
  }
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  try {
    const child = spawn(comspec, ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => log(`打开浏览器失败：${err.message}`, "WARN"));
    child.unref();
    log(`已请求系统浏览器打开：${url}`);
  } catch (err) {
    log(`打开浏览器失败：${err.message}`, "WARN");
  }
}

/* ------------------------------------------------------------ 生命周期 */

const state = {
  comfyChild: null,
  adoptedComfyUrl: null,
  comfyUrl: null,
  gatewayChild: null,
  canvasServer: null,
  controlServer: null,
  sessionTimer: null,
  restarting: false,
};

let shuttingDown = false;

function portFromUrl(url) {
  try {
    return Number(new URL(url).port) || 0;
  } catch {
    return 0;
  }
}

function listenerPids(port) {
  if (!port || process.platform !== "win32") return [];
  const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  if (netstat.status !== 0) return [];
  const pids = new Set();
  for (const line of String(netstat.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING" || !parts[1].endsWith(`:${port}`)) continue;
    if (/^\d+$/.test(parts[4])) pids.add(parts[4]);
  }
  return [...pids];
}

function readSystemStats() {
  let gpu = [];
  let gpuError = null;
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "nvidia-smi",
        ["--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      );
      if (result.status !== 0) throw new Error(String(result.stderr || "nvidia-smi 执行失败").trim());
      gpu = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const [gpuIndex, name, used, total, utilization, temperature] = line.split(",").map((part) => part.trim());
          return {
            index: Number(gpuIndex) || index,
            name: name || "GPU",
            memoryUsedMb: Number(used) || 0,
            memoryTotalMb: Number(total) || 0,
            utilization: Number(utilization) || 0,
            temperature: Number(temperature) || 0,
          };
        });
    }
  } catch (error) {
    gpuError = error?.message || String(error);
  }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    at: new Date().toISOString(),
    gpu,
    gpuError,
    ram: { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) },
  };
}

// 关闭画布时按用户要求停止“接管”的 ComfyUI；只在画布关闭路径调用，Ctrl+C 不会触发。
function stopAdoptedComfyProcess(label) {
  const port = portFromUrl(state.adoptedComfyUrl);
  if (!port) return false;
  if (process.platform !== "win32") {
    log(`接管的 ${label}（端口 ${port}）未自动停止，请手动处理`, "WARN");
    return false;
  }
  const pids = listenerPids(port);
  let stopped = false;
  for (const pid of pids) {
    const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (result.status === 0) {
      log(`已停止接管的 ${label}（PID ${pid}，端口 ${port}）`);
      stopped = true;
    } else {
      log(`停止接管的 ${label}（PID ${pid}）失败，可手动处理`, "WARN");
    }
  }
  return stopped;
}

function killOurChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (r.status === 0) log(`已停止本启动器启动的 ${label}（PID ${pid}）`);
      else log(`停止 ${label}（PID ${pid}）失败，可手动处理`, "WARN");
    } else {
      child.kill("SIGTERM");
      log(`已停止本启动器启动的 ${label}（PID ${pid}）`);
    }
  } catch (err) {
    log(`停止 ${label} 失败：${err.message}`, "WARN");
  }
}

async function shutdown(exitCode = 0, reason = "", { stopAdoptedComfy = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) log(reason);
  log("收到退出信号，停止本启动器启动的进程…");
  if (state.sessionTimer) clearInterval(state.sessionTimer);
  state.sessionTimer = null;
  if (state.controlServer) {
    state.controlServer.closeAllConnections?.();
    state.controlServer.close();
    state.controlServer = null;
  }
  if (state.canvasServer) {
    const server = state.canvasServer;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    log("画布静态服务已关闭");
    state.canvasServer = null;
  }
  killOurChild(state.gatewayChild, "网关");
  killOurChild(state.comfyChild, "ComfyUI");
  const adoptedComfyStopped = !state.comfyChild && stopAdoptedComfy && state.adoptedComfyUrl ? stopAdoptedComfyProcess("ComfyUI") : false;
  if (adoptedComfyStopped) log("已退出。接管的网关未被触碰；接管的 ComfyUI 已按要求停止。");
  else log("已退出。接管（非本启动器启动）的服务未被触碰。");
  process.exit(exitCode);
}

// 画布页面每 5s 向网关心跳；最后一个页面关闭且无生成任务后，回收本启动器启动的后台。
function startSessionWatchdog(cfg, gatewayUrl) {
  if (!cfg.closeCanvasStopsBackend) {
    log("关闭画布自动清理已禁用（closeCanvasStopsBackend=false）。");
    return;
  }
  log(
    `画布会话监控已启用：最后一个页面关闭且无任务后等待 ${cfg.canvasIdleGraceSec}s 退出；` +
      `${cfg.stopAdoptedComfyOnCanvasClose ? "接管的 ComfyUI 也会停止" : "接管进程保留"}。`,
  );
  let seen = false;
  let note = "";
  const tick = async () => {
    if (shuttingDown) return;
    const res = await httpGet(`${gatewayUrl}/api/session/status`, 2500);
    if (!res.ok || !res.json || typeof res.json !== "object") return;
    const status = res.json;
    if (status.seen) seen = true;
    if (!seen) return;
    const sessions = Number(status.count) || 0;
    if (sessions > 0) {
      if (note) {
        log("画布会话已恢复，取消待退出。");
        note = "";
      }
      return;
    }
    const activeTasks = Number(status.activeTasks) || 0;
    if (activeTasks > 0) {
      if (note !== `tasks:${activeTasks}`) {
        log(`画布已关闭，但仍有 ${activeTasks} 个生成任务在跑；完成后退出。`, "WARN");
        note = `tasks:${activeTasks}`;
      }
      return;
    }
    const idleMs = Number(status.idleMs) || 0;
    if (idleMs < cfg.canvasIdleGraceSec * 1000) return;
    await shutdown(0, `画布已关闭（空闲 ${Math.round(idleMs / 1000)}s，无进行中任务），停止后台。`, {
      stopAdoptedComfy: cfg.stopAdoptedComfyOnCanvasClose,
    });
  };
  const timer = setInterval(() => void tick(), 5000);
  if (typeof timer.unref === "function") timer.unref();
  state.sessionTimer = timer;
}

/* ------------------------------------------------------ ComfyUI 清理重启 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function restartComfy(cfg) {
  if (state.restarting) {
    const error = new Error("ComfyUI 正在重启，请稍候");
    error.status = 409;
    throw error;
  }
  state.restarting = true;
  const startedAt = Date.now();
  const report = { ok: false, steps: [], before: null, afterKill: null, afterStart: null };
  try {
    report.before = readSystemStats();
    const targetUrl = state.comfyUrl || cfg.comfyUrl;
    const port = portFromUrl(targetUrl);
    const pids = listenerPids(port);
    const killStarted = Date.now();
    for (const pid of pids) {
      const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
      log(result.status === 0 ? `已强制停止 ComfyUI（PID ${pid}）` : `停止 ComfyUI（PID ${pid}）失败`, result.status === 0 ? "INFO" : "WARN");
    }
    killOurChild(state.comfyChild, "ComfyUI");
    state.comfyChild = null;
    report.steps.push({ name: "停止 ComfyUI", pids, durationMs: Date.now() - killStarted });

    const closeStarted = Date.now();
    while (Date.now() - closeStarted < 30000) {
      if (!(await probeComfy(targetUrl))) break;
      await delay(500);
    }
    const portClosed = !(await probeComfy(targetUrl));
    report.steps.push({ name: "确认端口关闭", ok: portClosed, durationMs: Date.now() - closeStarted });
    if (!portClosed) throw new Error(`ComfyUI 端口 ${port} 未能在 30 秒内释放`);

    const beforeMb = report.before.gpu?.[0]?.memoryUsedMb || 0;
    let afterKill = readSystemStats();
    const vramStarted = Date.now();
    while (beforeMb > 0 && Date.now() - vramStarted < 20000) {
      const used = afterKill.gpu?.[0]?.memoryUsedMb;
      if (typeof used !== "number" || used <= Math.max(0, beforeMb - 256)) break;
      await delay(500);
      afterKill = readSystemStats();
    }
    report.afterKill = afterKill;
    report.freedMb = Math.max(0, beforeMb - (afterKill.gpu?.[0]?.memoryUsedMb || 0));
    report.steps.push({
      name: "检测显存释放",
      beforeMb,
      afterMb: afterKill.gpu?.[0]?.memoryUsedMb || 0,
      freedMb: report.freedMb,
      durationMs: Date.now() - vramStarted,
    });

    const install = findComfyInstall(cfg);
    if (!install?.bat) throw new Error(`未找到 ComfyUI 启动脚本（comfyDir=${cfg.comfyDir || "空"}）`);
    const startStarted = Date.now();
    state.comfyChild = spawnComfy(install);
    const ready = await waitFor(
      "ComfyUI（重启）",
      async () => {
        for (let p = COMFY_PORT_FIRST; p <= COMFY_PORT_LAST; p += 1) {
          const url = `http://127.0.0.1:${p}`;
          if (await probeComfy(url)) return { url };
        }
        return null;
      },
      cfg.comfyStartTimeoutSec,
      { intervalMs: 2000, progressEveryMs: 15000 },
    );
    if (!ready) throw new Error("ComfyUI 未在超时时间内重新就绪");
    state.comfyUrl = ready.url;
    state.adoptedComfyUrl = null;
    report.afterStart = readSystemStats();
    report.steps.push({ name: "重新拉起 ComfyUI", url: ready.url, durationMs: Date.now() - startStarted });
    report.ok = true;
    report.comfyUrl = ready.url;
    report.durationMs = Date.now() - startedAt;
    log(`ComfyUI 清理重启完成：${ready.url}，释放显存 ${report.freedMb} MB，用时 ${Math.round(report.durationMs / 1000)}s`);
    return report;
  } catch (error) {
    try {
      killOurChild(state.comfyChild, "ComfyUI");
    } catch {
      /* 失败清理不覆盖原始错误 */
    }
    state.comfyChild = null;
    report.error = error?.message || String(error);
    report.durationMs = Date.now() - startedAt;
    error.report = report;
    log(`ComfyUI 清理重启失败：${report.error}`, "ERROR");
    throw error;
  } finally {
    state.restarting = false;
  }
}

async function startControlServer(cfg) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && pathname === "/health") {
        res.end(JSON.stringify({ ok: true, restarting: state.restarting }));
        return;
      }
      if (req.method === "POST" && pathname === "/restart-comfy") {
        res.setTimeout(360000);
        const report = await restartComfy(cfg);
        res.end(JSON.stringify(report));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) {
      res.statusCode = error?.status || 500;
      res.end(JSON.stringify({ ok: false, error: error?.message || String(error), ...(error?.report || {}) }));
    }
  });
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.once("error", (error) => {
      log(`控制接口启动失败（${cfg.controlUrl}）：${error.message}`, "WARN");
      resolve(false);
    });
    server.listen(cfg.controlPort, "127.0.0.1", () => {
      state.controlServer = server;
      log(`控制接口已启动：${cfg.controlUrl}（ComfyUI 清理重启）`);
      resolve(true);
    });
  });
}

/* ------------------------------------------------------------------ 主流程 */

function fmtStatus(mode) {
  if (mode === "adopt") return "接管";
  if (mode === "started") return "已启动";
  if (mode === "missing") return "未找到";
  if (mode === "planned") return "将启动";
  return mode;
}

async function main() {
  log(`===== 本地一键启动器 ${DRY_RUN ? "[dry-run] " : ""}=====`);
  log(`工作区：${ROOT}`);
  log(`Node：${process.execPath} (${process.version})`);

  const cfg = loadConfig();
  log(`配置：${CONFIG_PATH}${cfg.configCreated ? "（已创建默认配置）" : "（已加载）"}`);
  log(
    `参数：comfyUrl=${cfg.comfyUrl} gatewayPort=${cfg.gatewayPort} controlPort=${cfg.controlPort} canvasPort=${cfg.canvasPort} ` +
      `gatewayDir=${cfg.gatewayDir} canvasDist=${cfg.canvasDist}`
  );
  if (DRY_RUN) log("dry-run：只做检测与打印，不启动任何进程，不监听端口");
  cfg.launcherControlUrl = "";
  if (!DRY_RUN) {
    const controlReady = await startControlServer(cfg);
    if (controlReady) cfg.launcherControlUrl = cfg.controlUrl;
  }

  /* 1. 检测 */
  const comfyHit = await detectComfy(cfg);
  let comfy = null;
  if (comfyHit) {
    comfy = { url: comfyHit.url, mode: "adopt" };
    log(`ComfyUI 已在运行（${comfyHit.url}，${comfyHit.via}）→ 接管，不重复启动`);
  } else {
    log("ComfyUI 未运行（8188–8199 与 config.comfyUrl 均无响应）");
  }

  const gatewayHit = await detectGateway(cfg);
  let gateway = null;
  if (gatewayHit) {
    gateway = { url: gatewayHit.url, mode: "adopt" };
    const comfyInfo = gatewayHit.health?.comfy?.reachable;
    log(
      `网关已在运行（${gatewayHit.url}/health 可达${
        comfyInfo === undefined ? "" : `，其内部 ComfyUI 视角 reachable=${comfyInfo}`
      }）→ 接管，不重复启动`
    );
  } else {
    log(`网关未运行（${cfg.gatewayUrl}/health 无响应）`);
  }

  const canvasHit = await detectCanvas(cfg);
  let canvas = null;
  if (canvasHit) {
    canvas = { url: canvasHit.url, mode: "adopt" };
    log(`画布已在运行（${canvasHit.url}/）→ 接管，不重复启动`);
  } else {
    log(`画布未运行（${cfg.canvasUrl}/ 无响应）`);
  }

  /* 2. ComfyUI */
  let comfyInstall = findComfyInstall(cfg);
  if (comfyInstall && (!cfg.comfyDir || (!cfg.comfyWorkflowsDir && comfyInstall.workflowsDir))) {
    cfg.comfyDir = cfg.comfyDir || comfyInstall.dir;
    cfg.comfyWorkflowsDir = cfg.comfyWorkflowsDir || comfyInstall.workflowsDir;
    persistDiscovery(cfg);
    log(`记录 ComfyUI 安装目录：${cfg.comfyDir}${cfg.comfyWorkflowsDir ? `，工作流目录：${cfg.comfyWorkflowsDir}` : ""}`);
  }
  if (!comfy) {
    if (!comfyInstall) {
      log("未找到 ComfyUI 安装目录（已查环境变量 COMFYUI_DIR、config.comfyDir、C/D/E:\\ComfyUI、" +
        "%USERPROFILE%\\ComfyUI、%USERPROFILE%\\Documents\\ComfyUI、E:\\ComfyUI_windows_portable、" +
        "E:\\ComfyUI\\ComfyUI）。", "ERROR");
      log("请安装/解压 ComfyUI 后重试，或在 launcher/config.json 里填写 comfyDir。", "ERROR");
      log("继续启动网关；完成后会打开 /admin 让你查看真实状态（不会假装 ComfyUI 已就绪）。", "WARN");
      comfy = { url: cfg.comfyUrl, mode: "missing" };
    } else if (!comfyInstall.bat) {
      log(`找到 ComfyUI 目录 ${comfyInstall.dir}，但缺少 run_nvidia_gpu.bat，无法自动启动`, "ERROR");
      log("可手动启动 ComfyUI 后重跑本脚本；继续启动网关并打开 /admin。", "WARN");
      comfy = { url: cfg.comfyUrl, mode: "missing" };
    } else {
      log(`ComfyUI 安装目录：${comfyInstall.dir}`);
      log(`ComfyUI 启动脚本：${comfyInstall.bat}`);
      if (comfyInstall.workflowsDir) log(`ComfyUI 用户工作流目录：${comfyInstall.workflowsDir}`);

      if (DRY_RUN) {
        log(`[dry-run] 将启动 ComfyUI：${comfyInstall.bat}（cwd=${comfyInstall.dir}，等待 /system_stats 最多 ${cfg.comfyStartTimeoutSec}s）`);
        comfy = { url: `http://127.0.0.1:${COMFY_PORT_FIRST}`, mode: "planned" };
      } else {
        log(`启动 ComfyUI（detached）：${comfyInstall.bat}`);
        state.comfyChild = spawnComfy(comfyInstall);
        log(`ComfyUI 子进程 PID=${state.comfyChild.pid}，等待 /system_stats（上限 ${cfg.comfyStartTimeoutSec}s）`);
        comfy = await waitFor(
          "ComfyUI",
          async () => {
            for (let port = COMFY_PORT_FIRST; port <= COMFY_PORT_LAST; port += 1) {
              const url = `http://127.0.0.1:${port}`;
              if (await probeComfy(url)) return { url };
            }
            return null;
          },
          cfg.comfyStartTimeoutSec,
          { intervalMs: 3000, progressEveryMs: 20000 }
        );
        if (comfy) {
          comfy.mode = "started";
          log(`ComfyUI 已启动：${comfy.url}`);
        } else {
          comfy = { url: `http://127.0.0.1:${COMFY_PORT_FIRST}`, mode: "missing" };
          log("ComfyUI 启动后未在超时内就绪，继续启动网关，稍后可在 /admin 查看状态。", "WARN");
        }
      }
    }
  }
  const comfyReady = comfy.mode === "adopt" || comfy.mode === "started";
  state.adoptedComfyUrl = comfy.mode === "adopt" ? comfy.url : null;
  state.comfyUrl = comfyReady ? comfy.url : cfg.comfyUrl;

  /* 3. 网关 */
  let gatewayResult = gateway;
  if (!gateway) {
    const workflowsDir = cfg.comfyWorkflowsDir || comfyInstall?.workflowsDir || "";
    if (workflowsDir) log(`网关将使用 COMFY_WORKFLOWS_DIR=${workflowsDir}`);
    const comfyUrl = comfy?.url || cfg.comfyUrl;

    if (DRY_RUN) {
      log(
        `[dry-run] 将启动网关：${process.execPath} ${path.join(cfg.gatewayDir, "src", "server.js")} ` +
          `（cwd=${cfg.gatewayDir}，PORT=${cfg.gatewayPort}，COMFY_URL=${comfyUrl}，等待 /health 最多 ${cfg.gatewayStartTimeoutSec}s）`
      );
      gatewayResult = { url: cfg.gatewayUrl, mode: "planned" };
    } else {
      log(`启动网关：${path.join(cfg.gatewayDir, "src", "server.js")}（PORT=${cfg.gatewayPort}，COMFY_URL=${comfyUrl}）`);
      try {
        state.gatewayChild = spawnGateway(cfg, comfyUrl, workflowsDir);
      } catch (err) {
        log(err.message, "ERROR");
        log("网关无法启动，画布即便打开也无法生成内容；请修复后重试。", "ERROR");
        await shutdown(1);
        return;
      }
      log(`网关子进程 PID=${state.gatewayChild.pid}，等待 /health（上限 ${cfg.gatewayStartTimeoutSec}s）`);
      const hit = await waitFor(
        "网关",
        async () => {
          const res = await httpGet(`${cfg.gatewayUrl}/health`, 2000);
          return res.ok && res.json ? { url: cfg.gatewayUrl } : null;
        },
        cfg.gatewayStartTimeoutSec,
        { intervalMs: 1500, progressEveryMs: 10000 }
      );
      if (!hit) {
        log(`网关启动失败，请查看 launcher/launcher.log 与上方 [gateway] 日志。`, "ERROR");
        await shutdown(1);
        return;
      }
      gatewayResult = { url: cfg.gatewayUrl, mode: "started" };
      log(`网关已启动：${cfg.gatewayUrl}/health`);
      if (comfyReady) log(`已向网关注入 COMFY_URL=${comfyUrl}`);
    }
  }

  /* 4. 画布静态服务 */
  let canvasResult = canvas;
  if (!canvas) {
    if (!isDir(cfg.canvasDist) || !isFile(path.join(cfg.canvasDist, "index.html"))) {
      log(`画布静态产物缺失：${cfg.canvasDist}`, "ERROR");
      log("请先构建：cd infinite-canvas\\web && npm install && npm run build", "ERROR");
      await shutdown(1);
      return;
    }
    if (DRY_RUN) {
      log(`[dry-run] 将在 http://127.0.0.1:${cfg.canvasPort} 托管 ${cfg.canvasDist}（SPA fallback → index.html，仅绑 127.0.0.1）`);
      canvasResult = { url: cfg.canvasUrl, mode: "planned" };
    } else {
      const server = createCanvasServer(cfg);
      const listenError = await new Promise((resolve) => {
        server.once("error", (err) => resolve(err));
        server.listen(cfg.canvasPort, "127.0.0.1", () => resolve(null));
      });
      if (listenError) {
        const hint =
          listenError.code === "EADDRINUSE"
            ? `端口 ${cfg.canvasPort} 已被其他程序占用且不是可识别的画布服务`
            : listenError.message;
        log(`画布静态服务启动失败：${hint}`, "ERROR");
        await shutdown(1);
        return;
      }
      state.canvasServer = server;
      canvasResult = { url: cfg.canvasUrl, mode: "started" };
      log(`画布已托管：http://127.0.0.1:${cfg.canvasPort}/ ← ${cfg.canvasDist}（SPA fallback 已启用，仅绑 127.0.0.1）`);
    }
  }

  /* 5. 汇总 + 浏览器 */
  log("---------------- 服务状态 ----------------");
  log(`ComfyUI : ${fmtStatus(comfy.mode)}  ${comfyReady ? comfy.url : "（不可用）"}`);
  log(`网关    : ${fmtStatus(gatewayResult.mode)}  ${gatewayResult.url}`);
  log(`画布    : ${fmtStatus(canvasResult.mode)}  ${canvasResult.url}`);
  log("------------------------------------------");
  if (!DRY_RUN) startSessionWatchdog(cfg, gatewayResult.url);

  const target = comfyReady ? `${canvasResult.url}/` : `${cfg.gatewayUrl}/admin`;
  if (!comfyReady) {
    log("ComfyUI 未就绪：打开 /admin 查看真实状态，而不是画布。", "WARN");
  }
  if (DRY_RUN) {
    log(`[dry-run] 将打开：${target}`);
    log("dry-run 结束（未启动任何进程）。");
    return;
  }

  if (cfg.openBrowser) openBrowser(target);
  else log(`config.openBrowser=false，未自动打开：${target}`);

  log("启动器前台运行中。按 Ctrl+C 只停止本启动器启动的进程；关闭画布最后一个页面会按配置停止后台（含接管的 ComfyUI）。");

  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      log("捕获 Ctrl+C");
      resolve();
    });
    process.on("SIGBREAK", () => {
      log("捕获 Ctrl+Break");
      resolve();
    });
    process.on("SIGTERM", () => {
      log("捕获 SIGTERM");
      resolve();
    });
  });
  await shutdown(0);
}

main().catch(async (err) => {
  log(`启动器异常：${err?.stack || err}`, "ERROR");
  try {
    await shutdown(1);
  } catch {
    process.exit(1);
  }
});
