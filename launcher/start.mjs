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
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installBundledNodes } from "./bootstrap-nodes.mjs";

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
  canvasIdleGraceSec: 30,
  allowLan: false,
  canvasHost: "127.0.0.1",
  gatewayHost: "127.0.0.1",
  gatewayPublicHost: "",
  corsOrigins: "",
};

function normalizeHost(value, fallback = "127.0.0.1") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1" || /^127\./.test(value);
}

function browseHostFor(bindHost) {
  const host = normalizeHost(bindHost);
  return host === "0.0.0.0" || host === "::" || isLoopbackHost(host) ? "127.0.0.1" : host;
}

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

// 15s 是 v0.21.18 及以前的默认值；旧 config.json 原样保留 15 时按新默认处理。
// 想用 15s 可显式设环境变量 CANVAS_IDLE_GRACE_SEC=15。
const LEGACY_IDLE_GRACE_SEC = 15;

function resolveIdleGraceSec(merged) {
  const fromEnv = process.env.CANVAS_IDLE_GRACE_SEC;
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (n > 0) return n;
    log(`环境变量 CANVAS_IDLE_GRACE_SEC=${fromEnv} 非法，改用默认 ${DEFAULT_CONFIG.canvasIdleGraceSec}s`, "WARN");
    return DEFAULT_CONFIG.canvasIdleGraceSec;
  }
  const n = Number(merged.canvasIdleGraceSec);
  if (!(n > 0)) return DEFAULT_CONFIG.canvasIdleGraceSec;
  if (n === LEGACY_IDLE_GRACE_SEC) {
    log(`画布空闲宽限 ${LEGACY_IDLE_GRACE_SEC}s 是旧默认值，按新默认 ${DEFAULT_CONFIG.canvasIdleGraceSec}s 处理。`);
    return DEFAULT_CONFIG.canvasIdleGraceSec;
  }
  return n;
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
    canvasIdleGraceSec: resolveIdleGraceSec(merged),
    allowLan: merged.allowLan === true,
    canvasHost: normalizeHost(merged.canvasHost, DEFAULT_CONFIG.canvasHost),
    gatewayHost: normalizeHost(merged.gatewayHost, DEFAULT_CONFIG.gatewayHost),
    gatewayPublicHost: normalizeHost(merged.gatewayPublicHost, ""),
    corsOrigins: String(merged.corsOrigins || "").trim(),
    configCreated: created,
  };
  if (cfg.allowLan !== true && (!isLoopbackHost(cfg.canvasHost) || !isLoopbackHost(cfg.gatewayHost))) {
    throw new Error("canvasHost/gatewayHost 非回环地址时必须显式设置 allowLan=true；否则可能把无鉴权服务暴露到局域网。");
  }
  // 本机健康检查/代理始终走回环，避免 gatewayPublicHost 在本机不可解析时启动失败。
  cfg.gatewayUrl = `http://127.0.0.1:${cfg.gatewayPort}`;
  const specificLanHost = !isLoopbackHost(cfg.gatewayHost) && cfg.gatewayHost !== "0.0.0.0" && cfg.gatewayHost !== "::";
  const publicHost = cfg.allowLan ? (cfg.gatewayPublicHost || (specificLanHost ? cfg.gatewayHost : "127.0.0.1")) : "127.0.0.1";
  cfg.gatewayPublicUrl = `http://${publicHost}:${cfg.gatewayPort}`;
  cfg.canvasUrl = `http://${browseHostFor(cfg.canvasHost)}:${cfg.canvasPort}`;
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
// 8000 是 ComfyUI 桌面版默认端口；其余是常见整合包/自定义端口。
const EXTRA_COMFY_PORTS = [8000, 7860, 8080, 8888, 18000];

function parsePortSpec(spec) {
  const ports = [];
  for (const part of String(spec || "").split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      const maxSpan = 200;
      for (let p = Math.min(from, to); p <= Math.max(from, to) && p - Math.min(from, to) < maxSpan; p += 1) ports.push(p);
    } else if (/^\d+$/.test(piece)) {
      ports.push(Number(piece));
    }
  }
  return ports;
}

function comfyPortCandidates(cfg) {
  const ports = [];
  const add = (port) => {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    if (!ports.includes(port)) ports.push(port);
  };
  add(portFromUrl(cfg.comfyUrl));
  add(COMFY_PORT_FIRST);
  for (const port of EXTRA_COMFY_PORTS) add(port);
  for (const port of parsePortSpec(process.env.COMFY_PORT_SCAN)) add(port);
  for (let port = COMFY_PORT_FIRST + 1; port <= COMFY_PORT_LAST; port += 1) add(port);
  return ports;
}

async function probeComfy(url, timeoutMs = 900) {
  const res = await httpGet(`${url.replace(/\/+$/, "")}/system_stats`, timeoutMs);
  return res.ok;
}

// 并行探测一组端口，避免逐个 2s 超时把启动拖成十几秒。
async function probeAnyComfy(ports, timeoutMs = 900) {
  const queue = [...ports];
  const worker = async () => {
    while (queue.length) {
      const port = queue.shift();
      const url = `http://127.0.0.1:${port}`;
      if (await probeComfy(url, timeoutMs)) return url;
    }
    return "";
  };
  const results = await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
  const hit = results.find(Boolean);
  return hit ? { url: hit, via: `端口 ${portFromUrl(hit)}` } : null;
}

async function detectComfy(cfg) {
  return await probeAnyComfy(comfyPortCandidates(cfg), 900);
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

const pythonProbeCache = new Map();
// 整合包里可能存在坏掉的 python.exe（例如 env\Scripts 下的占位文件），
// 选解释器前实际跑一次，别把 ComfyUI 拉起失败留到用户面前。
function pythonWorks(file) {
  if (!file) return false;
  const cached = pythonProbeCache.get(file);
  if (cached && Date.now() - cached.at < 300000) return cached.ok;
  let ok = false;
  try {
    const result = spawnSync(file, ["-c", "import sys;print(sys.version_info[0])"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
    ok = result.status === 0 && /^\s*3\s*$/m.test(String(result.stdout || ""));
  } catch {
    ok = false;
  }
  pythonProbeCache.set(file, { at: Date.now(), ok });
  return ok;
}

function comfyInstallInfo(dir) {
  if (!dir || !isDir(dir)) return null;
  const mainCandidates = [
    path.join(dir, "ComfyUI", "main.py"),
    path.join(dir, "main.py"),
    path.join(dir, "resources", "ComfyUI", "main.py"),
  ];
  const mainPy = mainCandidates.find((candidate) => isFile(candidate)) || "";
  const pythonCandidates = [
    path.join(dir, "python_embeded", "python.exe"),
    path.join(dir, "python_embedded", "python.exe"),
    path.join(dir, "python", "python.exe"),
    path.join(dir, "env", "python.exe"),
    path.join(dir, "env", "python", "python.exe"),
    path.join(dir, "env", "Scripts", "python.exe"),
    path.join(dir, "venv", "Scripts", "python.exe"),
    path.join(dir, ".venv", "Scripts", "python.exe"),
    path.join(dir, "Scripts", "python.exe"),
    path.join(dir, "..", "python", "python.exe"),
    path.join(dir, "..", "env", "python.exe"),
    path.join(dir, "..", "env", "python", "python.exe"),
    path.join(dir, "..", "env", "Scripts", "python.exe"),
    path.join(dir, "..", "python_embeded", "python.exe"),
    mainPy ? path.join(path.dirname(mainPy), "..", "python_embeded", "python.exe") : "",
  ].filter(Boolean);
  const pythonExe = pythonCandidates.find((candidate) => isFile(candidate) && pythonWorks(candidate)) || pythonCandidates.find((candidate) => isFile(candidate)) || "";
  const scripts = [];
  // 只把内容里真的调用 main.py 的脚本算作 ComfyUI 启动脚本；
  // 否则我们自己的 start-local.bat、卸载脚本之类都会被误判成 ComfyUI 安装。
  const pushScript = (file) => {
    if (!isFile(file) || scripts.includes(file)) return;
    try {
      if (/main\.py/i.test(fs.readFileSync(file, "utf8"))) scripts.push(file);
    } catch {
      /* 读不到就跳过 */
    }
  };
  let electronExe = [path.join(dir, "ComfyUI.exe"), path.join(dir, "ComfyUI Desktop.exe")].find((candidate) => isFile(candidate)) || "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const rank = (name) => (/^run_nvidia_gpu\.bat$/i.test(name) ? 0 : /^run.*\.(bat|cmd)$/i.test(name) ? 1 : /(启动|一键|开始|start|launch)/i.test(name) ? 2 : 3);
    const parent = path.dirname(dir);
    const scanDirs = [dir, parent && parent !== path.parse(dir).root ? parent : ""].filter(Boolean);
    for (const base of scanDirs) {
      let list = [];
      try {
        list = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      const bats = list
        .filter((entry) => entry.isFile() && /\.(bat|cmd)$/i.test(entry.name))
        .sort((a, b) => rank(a.name) - rank(b.name));
      for (const entry of bats) pushScript(path.join(base, entry.name));
    }
    if (!electronExe) {
      const exe = entries.find((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && /comfy/i.test(entry.name));
      if (exe) electronExe = path.join(dir, exe.name);
    }
  } catch {
    /* 目录不可读时按已有信息处理 */
  }
  if (!scripts.length && !mainPy && !electronExe) return null;

  const workflowCandidates = [
    path.join(dir, "ComfyUI", "user", "default", "workflows"),
    path.join(dir, "resources", "ComfyUI", "user", "default", "workflows"),
    path.join(dir, "user", "default", "workflows"),
  ];
  const workflowsDir = workflowCandidates.find((candidate) => isDir(candidate)) || "";
  return {
    dir,
    bat: scripts[0] || "",
    scripts,
    mainPy,
    pythonExe,
    electronExe,
    workflowsDir,
  };
}

function resolveLaunchPlan(install) {
  if (!install) return null;
  if (install.electronExe) return { kind: "desktop", file: install.electronExe, cwd: install.dir };
  // 整合包的 bat 往往带了必要的启动参数/环境变量，能跑就优先用；python 直启只作兜底。
  if (install.scripts?.length) return { kind: "script", file: install.scripts[0], cwd: path.dirname(install.scripts[0]) };
  if (install.pythonExe && install.mainPy) return { kind: "python", file: install.pythonExe, mainPy: install.mainPy, cwd: install.dir };
  return null;
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
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const common = [
    cfg.comfyDir,
    path.join(home, "ComfyUI"),
    path.join(home, "Documents", "ComfyUI"),
    path.join(localAppData, "Programs", "@comfyorgcomfyui-electron"),
    path.join(localAppData, "Programs", "@comfyorgcomfyui-electron", "resources", "ComfyUI"),
    path.join(localAppData, "Programs", "ComfyUI"),
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
      const resourceChild = inspect(path.join(dir, "resources", "ComfyUI"), "同盘 resources/ComfyUI");
      if (resourceChild) return resourceChild;
    }
  }

  for (const dir of common) {
    const info = inspect(dir, "常见目录/配置");
    if (info) return info;
  }
  return null;
}

async function pickFreePort(ports) {
  for (const port of ports) {
    if (!(await probeComfy(`http://127.0.0.1:${port}`, 300))) return port;
  }
  return COMFY_PORT_FIRST;
}

// 3000 经常被 NEW API / 其他开发服务占着；画布不能因为一个端口就整体退出。
async function listenCanvasServer(cfg, preferredPort) {
  const ports = [preferredPort, ...Array.from({ length: 10 }, (_, index) => preferredPort + index + 1)];
  let lastError = null;
  for (const port of ports) {
    const server = createCanvasServer(cfg);
    const error = await new Promise((resolve) => {
      server.once("error", (err) => resolve(err));
      server.listen(port, cfg.canvasHost || "127.0.0.1", () => resolve(null));
    });
    if (!error) return { server, port };
    lastError = error;
    try {
      server.close();
    } catch {
      /* 监听失败时 server 可能还没打开 */
    }
    if (error.code !== "EADDRINUSE") break;
  }
  throw lastError || new Error("画布端口不可用");
}

function spawnComfy(plan, port = COMFY_PORT_FIRST) {
  const options = { cwd: plan.cwd, detached: true, stdio: "ignore", windowsHide: plan.kind !== "script" };
  let child;
  if (plan.kind === "python") {
    child = spawn(plan.file, [plan.mainPy, "--port", String(port), "--listen", "127.0.0.1"], options);
  } else if (plan.kind === "desktop") {
    child = spawn(plan.file, [], { ...options, windowsHide: false });
  } else {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    child = spawn(comspec, ["/d", "/s", "/c", plan.file], { ...options, windowsHide: false });
  }
  child.on("error", (err) => log(`启动 ComfyUI 失败：${err.message}`, "ERROR"));
  child.unref();
  return child;
}

/* ------------------------------------------------------------- 网关依赖自愈 */

const GATEWAY_DEPS_ZIP = path.join(__dirname, "gateway-deps.zip");
const GATEWAY_DEPS_URL = "https://modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/resolve/master/patches/gateway-deps.zip";
const GATEWAY_DEPS_SHA256 = "cb6d48c8b9e003b7608f82e2bce3fa3e6b1c21b78c3ab9000a44c6eb3c52d7b2";

function gatewayDepsReady(gatewayDir) {
  if (!isDir(gatewayDir)) return false;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "Promise.all([import('express'),import('multer')]).then(()=>process.exit(0),()=>process.exit(1))"],
    { cwd: gatewayDir, timeout: 30000, windowsHide: true, stdio: "ignore" },
  );
  return result.status === 0;
}

function extractGatewayDeps(archive, destination) {
  const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  let result = spawnSync(tar, ["-xf", archive, "-C", destination], { timeout: 120000, windowsHide: true });
  if (result.status === 0) return;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  result = spawnSync(powershell, ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`], {
    timeout: 120000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("解压网关依赖失败");
}

async function downloadGatewayDeps(destination) {
  log("本机没有可用的网关依赖包，正在从魔搭镜像下载…", "WARN");
  const response = await fetch(GATEWAY_DEPS_URL, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (GATEWAY_DEPS_SHA256 && digest !== GATEWAY_DEPS_SHA256) throw new Error("依赖包 SHA256 校验失败");
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, buffer);
  return destination;
}

let gatewayDepsRepair = null;

function ensureGatewayDeps(cfg) {
  if (gatewayDepsReady(cfg.gatewayDir)) return Promise.resolve();
  if (!gatewayDepsRepair) {
    gatewayDepsRepair = (async () => {
      const candidates = [];
      if (isFile(GATEWAY_DEPS_ZIP)) candidates.push({ archive: GATEWAY_DEPS_ZIP, label: "随包" });
      candidates.push({ remote: true, label: "魔搭镜像" });
      const errors = [];
      log("检测到网关依赖缺失或不完整，正在自动修复…", "WARN");
      for (const candidate of candidates) {
        try {
          const archive = candidate.remote
            ? await downloadGatewayDeps(path.join(ROOT, ".update", "gateway-deps", "gateway-deps.zip"))
            : candidate.archive;
          extractGatewayDeps(archive, cfg.gatewayDir);
          if (gatewayDepsReady(cfg.gatewayDir)) {
            log(`网关依赖已自动修复（${candidate.label}）。`);
            return;
          }
          throw new Error("解压后仍无法加载 express/multer");
        } catch (error) {
          errors.push(`${candidate.label}：${error.message}`);
          log(`网关依赖修复失败（${candidate.label}）：${error.message}`, "WARN");
        }
      }
      throw new Error(`网关依赖缺失，自动修复失败（${errors.join("；")}）`);
    })().finally(() => {
      gatewayDepsRepair = null;
    });
  }
  return gatewayDepsRepair;
}

/* ------------------------------------------------------------- 网关启动 */

async function quarantineTeManData(comfyRoot) {
  if (!comfyRoot) return;
  const dataDir = path.join(ROOT, "comfyui-gateway", "data");
  const marker = path.join(dataDir, "te-man-cleanup-v2.json");
  if (isFile(marker)) return;
  const quarantineRoot = path.join(dataDir, "te-man-quarantine", `20261030-${Date.now()}`);
  const customNodes = path.join(comfyRoot, "custom_nodes", "TE_MAN");
  const bundledNodes = path.join(ROOT, "comfyui-gateway", "resources", "nodes", "unpacked", "TE_MAN");
  const moved = [];
  try {
    const move = async (source, label) => {
      if (!fs.existsSync(source)) return;
      const destination = path.join(quarantineRoot, label, path.basename(source));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fsp.rename(source, destination);
      } catch {
        await fsp.cp(source, destination, { recursive: true, force: true });
        await fsp.rm(source, { recursive: true, force: true });
      }
      moved.push(label);
    };
    for (const [root, prefix] of [[customNodes, "custom"], [bundledNodes, "bundled"]]) {
      await move(path.join(root, "data"), `${prefix}-data`);
      const config = path.join(root, "config_IdeaDesk.ini");
      // 只清理随包分发的旧配置（1042B），用户自己改过的配置保持不动。
      if (isFile(config) && fs.statSync(config).size === 1042) await move(config, `${prefix}-config`);
    }
    await fsp.mkdir(path.join(customNodes, "data"), { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(marker, JSON.stringify({ cleanedAt: new Date().toISOString(), moved }, null, 2));
    if (moved.length) log(`已隔离 TE_MAN 旧数据/配置 ${moved.length} 项`, "WARN");
  } catch (error) {
    log(`TE_MAN 旧数据/配置隔离失败：${error.message}`, "WARN");
  }
}

function spawnGateway(cfg, comfyUrl, workflowsDir) {
  const serverEntry = path.join(cfg.gatewayDir, "src", "server.js");
  if (!isFile(serverEntry)) {
    throw new Error(`找不到网关入口：${serverEntry}`);
  }
  const env = {
    ...process.env,
    PORT: String(cfg.gatewayPort),
    HOST: cfg.gatewayHost || "127.0.0.1",
    ...(isLoopbackHost(cfg.gatewayHost || "127.0.0.1") ? {} : { ALLOW_REMOTE: "1" }),
    ...(cfg.corsOrigins ? { CORS_ORIGINS: cfg.corsOrigins } : {}),
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
    if (state.gatewayChild === child) state.gatewayChild = null;
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

function writeRuntimeConfig(cfg, gatewayUrl) {
  const file = path.join(cfg.canvasDist, "config.js");
  let runtime = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/window\.__RUNTIME_CONFIG__\s*=\s*(\{[\s\S]*?\})\s*;?/);
    if (match) runtime = JSON.parse(match[1]);
  } catch {
    runtime = {};
  }
  let origin = "";
  try {
    origin = new URL(gatewayUrl).origin;
  } catch {
    origin = cfg.gatewayUrl;
  }
  runtime.LOCAL_GATEWAY_HOST = cfg.gatewayPublicHost || "127.0.0.1";
  runtime.LOCAL_GATEWAY_PORT = String(cfg.gatewayPort);
  runtime.LOCAL_GATEWAY_URL = `${origin}/v1`;
  fs.writeFileSync(file, `window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtime)};\n`, "utf8");
  log(`运行时网关配置已写入：${runtime.LOCAL_GATEWAY_URL}`);
}

// 旧版页面把网关写死在 8190。网关换端口后，旧标签页会一直 Failed to fetch；
// 只要 8190 空闲就起一个透明转发，旧页面无需刷新也能继续用。
const LEGACY_GATEWAY_PORT = 8190;

export function createLegacyProxyServer(targetUrl) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return null;
  }
  const targetPort = Number(target.port) || 80;
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { message: `本地网关暂不可用：${error.message}` } }));
      } else {
        res.destroy();
      }
    });
    req.on("aborted", () => proxyReq.destroy());
    req.pipe(proxyReq);
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

async function startLegacyGatewayProxy(cfg, gatewayUrl) {
  if (cfg.gatewayPort === LEGACY_GATEWAY_PORT) return null;
  const server = createLegacyProxyServer(gatewayUrl);
  if (!server) return null;
  const error = await new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(LEGACY_GATEWAY_PORT, "127.0.0.1", () => resolve(null));
  });
  if (error) {
    if (error.code === "EADDRINUSE") {
      log(`旧端口 ${LEGACY_GATEWAY_PORT} 已被占用，跳过兼容转发（新页面不受影响）`, "WARN");
    } else {
      log(`旧端口 ${LEGACY_GATEWAY_PORT} 兼容转发启动失败：${error.message}`, "WARN");
    }
    return null;
  }
  log(`旧端口兼容转发已启用：http://127.0.0.1:${LEGACY_GATEWAY_PORT} → ${gatewayUrl}（旧标签页可直接恢复）`);
  return server;
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

      // 运行时配置由服务端直接生成：npm run build 清空 dist 后也不会丢网关地址。
      if (pathname === "/config.js") {
        let origin = cfg.gatewayUrl;
        try {
          origin = new URL(cfg.gatewayUrl).origin;
        } catch {
          /* 保持原样 */
        }
        const runtime = {
          LOCAL_GATEWAY_HOST: "127.0.0.1",
          LOCAL_GATEWAY_PORT: String(cfg.gatewayPort),
          LOCAL_GATEWAY_URL: `${origin}/v1`,
        };
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(`window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtime)};\n`);
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
  legacyProxy: null,
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
  if (state.legacyProxy) {
    const proxy = state.legacyProxy;
    await new Promise((resolve) => {
      proxy.close(() => resolve());
      proxy.closeAllConnections?.();
    });
    state.legacyProxy = null;
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
  let gatewayStartedAt = "";
  let lastTickAt = Date.now();
  let holdUntil = 0;
  const tick = async () => {
    if (shuttingDown) return;
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    // 系统休眠/时钟跳变后，先等画布重新心跳，别把“刚醒”当成“已关闭”。
    if (gap > 60000) {
      holdUntil = now + 120000;
      log(`检测到 ${Math.round(gap / 1000)}s 的时钟跳变（休眠/挂起），等待画布重新心跳后再判定。`);
      return;
    }
    if (now < holdUntil) return;
    const res = await httpGet(`${gatewayUrl}/api/session/status`, 2500);
    if (!res.ok || !res.json || typeof res.json !== "object") return;
    const status = res.json;
    const startedAt = String(status.startedAt || "");
    if (startedAt && gatewayStartedAt && startedAt !== gatewayStartedAt) {
      seen = false;
      note = "";
      log("网关已重启，等待画布重新心跳后再启用自动退出。");
    }
    if (startedAt) gatewayStartedAt = startedAt;
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
    // 只有页面显式关闭（pagehide/beacon，网关记录 closedAt）才停后台；
    // 心跳缺失（后台标签节流/冻结、浏览器崩溃）不停，避免挂机被误杀。
    const explicitCloseAt = Number(status.closedAt) || 0;
    const explicitRecent = explicitCloseAt > 0 && now - explicitCloseAt < 10 * 60 * 1000;
    if (!explicitRecent) return;
    if (idleMs < cfg.canvasIdleGraceSec * 1000) return;
    await shutdown(0, `画布已关闭（显式关闭信号，空闲 ${Math.round(idleMs / 1000)}s，无进行中任务），停止后台。`, {
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
    const plan = resolveLaunchPlan(install);
    if (!plan) throw new Error(`未找到 ComfyUI 启动方式（comfyDir=${cfg.comfyDir || "空"}）`);
    const startStarted = Date.now();
    state.comfyChild = spawnComfy(plan, plan.kind === "python" ? port : COMFY_PORT_FIRST);
    const ready = await waitFor(
      "ComfyUI（重启）",
      async () => probeAnyComfy(comfyPortCandidates(cfg), 900),
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
      if (req.method === "POST" && pathname === "/restart-gateway") {
        if (!state.gatewayChild) {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: "网关不是本启动器启动的，无法原地重启" }));
          return;
        }
        await ensureGatewayDeps(cfg);
        const previous = state.gatewayChild;
        state.gatewayChild = null;
        killOurChild(previous, "网关");
        await delay(600);
        state.gatewayChild = spawnGateway(cfg, state.gatewayComfyUrl || cfg.comfyUrl, state.gatewayWorkflowsDir || "");
        res.end(JSON.stringify({ ok: true, pid: state.gatewayChild.pid }));
        return;
      }
      if (req.method === "POST" && pathname === "/set-comfy-dir") {
        const body = await new Promise((resolve) => {
          let raw = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 8192) req.destroy();
          });
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
          req.on("error", () => resolve({}));
        });
        const dir = String(body.dir || "").trim();
        if (!dir || !isDir(dir)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: `目录不存在：${dir || "（空）"}` }));
          return;
        }
        cfg.comfyDir = dir;
        const info = comfyInstallInfo(dir);
        if (info?.workflowsDir) cfg.comfyWorkflowsDir = info.workflowsDir;
        persistDiscovery(cfg);
        log(`已更新 ComfyUI 目录：${cfg.comfyDir}${cfg.comfyWorkflowsDir ? `（工作流 ${cfg.comfyWorkflowsDir}）` : ""}`);
        res.end(JSON.stringify({ ok: true, comfyDir: cfg.comfyDir, workflowsDir: cfg.comfyWorkflowsDir, restartRequired: true }));
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
  if (comfyInstall && !DRY_RUN) {
    const comfyRoot = comfyInstall.mainPy
      ? path.dirname(comfyInstall.mainPy)
      : (isDir(path.join(comfyInstall.dir, "ComfyUI")) ? path.join(comfyInstall.dir, "ComfyUI") : comfyInstall.dir);
    const installed = await installBundledNodes({ root: ROOT, comfyRoot, comfyUrl: comfy || "", log });
    await quarantineTeManData(comfyRoot);
    if (installed.length) log(`已自动放置 ${installed.length} 个内置节点包${comfy ? "；ComfyUI 已在运行，重启后生效" : ""}`);
  }
  if (!comfy) {
    if (!comfyInstall) {
      log("未找到 ComfyUI 安装目录（已查环境变量 COMFYUI_DIR、config.comfyDir、C/D/E:\\ComfyUI、" +
        "%USERPROFILE%\\ComfyUI、%USERPROFILE%\\Documents\\ComfyUI、E:\\ComfyUI_windows_portable、" +
        "E:\\ComfyUI\\ComfyUI）。", "ERROR");
      log("请安装/解压 ComfyUI 后重试，或在 launcher/config.json 里填写 comfyDir。", "ERROR");
      log("继续启动网关；完成后会打开 /admin 让你查看真实状态（不会假装 ComfyUI 已就绪）。", "WARN");
      comfy = { url: cfg.comfyUrl, mode: "missing" };
    } else {
      const plan = resolveLaunchPlan(comfyInstall);
      if (!plan) {
        log(`找到 ComfyUI 目录 ${comfyInstall.dir}，但没找到可用的启动方式（启动脚本 / python_embeded+main.py / 桌面版 exe）`, "ERROR");
        log("可手动启动 ComfyUI 后重跑本脚本；继续启动网关并打开 /admin。", "WARN");
        comfy = { url: cfg.comfyUrl, mode: "missing" };
      } else {
        const launchPort = plan.kind === "python" ? await pickFreePort(comfyPortCandidates(cfg)) : COMFY_PORT_FIRST;
        const planLabel = plan.kind === "desktop"
          ? `桌面版 ${plan.file}`
          : plan.kind === "python"
            ? `${plan.file} ${plan.mainPy} --port ${launchPort}`
            : `启动脚本 ${plan.file}`;
        log(`ComfyUI 安装目录：${comfyInstall.dir}`);
        log(`ComfyUI 启动方式：${planLabel}`);
        if (comfyInstall.workflowsDir) log(`ComfyUI 用户工作流目录：${comfyInstall.workflowsDir}`);

        if (DRY_RUN) {
          log(`[dry-run] 将启动 ComfyUI：${planLabel}（cwd=${comfyInstall.dir}，等待 /system_stats 最多 ${cfg.comfyStartTimeoutSec}s）`);
          comfy = { url: `http://127.0.0.1:${launchPort}`, mode: "planned" };
        } else {
          log(`启动 ComfyUI（detached）：${planLabel}`);
          state.comfyChild = spawnComfy(plan, launchPort);
          log(`ComfyUI 子进程 PID=${state.comfyChild.pid}，等待 /system_stats（上限 ${cfg.comfyStartTimeoutSec}s）`);
          comfy = await waitFor(
            "ComfyUI",
            async () => probeAnyComfy(comfyPortCandidates(cfg), 900),
            cfg.comfyStartTimeoutSec,
            { intervalMs: 3000, progressEveryMs: 20000 }
          );
          if (comfy) {
            comfy.mode = "started";
            log(`ComfyUI 已启动：${comfy.url}`);
          } else {
            comfy = { url: `http://127.0.0.1:${launchPort}`, mode: "missing" };
            log("ComfyUI 启动后未在超时内就绪，继续启动网关，稍后可在 /admin 查看状态。", "WARN");
          }
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
        await ensureGatewayDeps(cfg);
        state.gatewayComfyUrl = comfyUrl;
      state.gatewayWorkflowsDir = workflowsDir;
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

  if (!DRY_RUN) {
    state.legacyProxy = await startLegacyGatewayProxy(cfg, gatewayResult.url);
  } else if (cfg.gatewayPort !== LEGACY_GATEWAY_PORT) {
    log(`[dry-run] 将在 127.0.0.1:${LEGACY_GATEWAY_PORT} 启动旧端口兼容转发 → ${gatewayResult.url}`);
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
      log(`[dry-run] 将在 http://${browseHostFor(cfg.canvasHost)}:${cfg.canvasPort} 托管 ${cfg.canvasDist}（SPA fallback → index.html，绑 ${cfg.canvasHost}）`);
      canvasResult = { url: cfg.canvasUrl, mode: "planned" };
    } else {
      try {
        writeRuntimeConfig(cfg, cfg.gatewayPublicUrl || gatewayResult.url);
      } catch (error) {
        log(`写入运行时网关配置失败：${error.message}`, "WARN");
      }
      let listen;
      try {
        listen = await listenCanvasServer(cfg, cfg.canvasPort);
      } catch (error) {
        log(`画布静态服务启动失败：${error.message}`, "ERROR");
        await shutdown(1);
        return;
      }
      if (listen.port !== cfg.canvasPort) {
        log(`画布端口 ${cfg.canvasPort} 已被其他程序占用，改用空闲端口 ${listen.port}`);
        cfg.canvasPort = listen.port;
        cfg.canvasUrl = `http://${browseHostFor(cfg.canvasHost)}:${listen.port}`;
      }
      state.canvasServer = listen.server;
      canvasResult = { url: cfg.canvasUrl, mode: "started" };
      log(`画布已托管：${cfg.canvasUrl}/ ← ${cfg.canvasDist}（SPA fallback 已启用，绑 ${cfg.canvasHost}）`);
    }
  }

  /* 5. 汇总 + 浏览器 */
  log("---------------- 服务状态 ----------------");
  log(`ComfyUI : ${fmtStatus(comfy.mode)}  ${comfyReady ? comfy.url : "（不可用）"}`);
  log(`网关    : ${fmtStatus(gatewayResult.mode)}  ${gatewayResult.url}`);
  if (cfg.gatewayPublicUrl && cfg.gatewayPublicUrl !== gatewayResult.url) log(`对外网关: ${cfg.gatewayPublicUrl}`);
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

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (err) => {
    log(`启动器异常：${err?.stack || err}`, "ERROR");
    try {
      await shutdown(1);
    } catch {
      process.exit(1);
    }
  });
}

export { comfyInstallInfo, resolveLaunchPlan, comfyPortCandidates, detectComfy, probeAnyComfy, listenCanvasServer, isLoopbackHost, normalizeHost, browseHostFor };
