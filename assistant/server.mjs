import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Agent } from "@mariozechner/pi-agent-core";

import { createDiagnosticTools, collectSnapshot, normalizeGatewayUrl } from "./diagnostics.mjs";
import { applyProposalFiles, createRepairTools, rollbackProposalFiles } from "./repair-tools.mjs";
import { buildSystemPrompt, SKILL_MARKDOWN, SKILL_NAME, SKILL_VERSION } from "./skill.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ASSISTANT_PORT || 0);
const HOST = "127.0.0.1";
const SERVICE_VERSION = "0.3.1";
const APP_ROOT = path.resolve(process.env.ASSISTANT_APP_ROOT || path.join(ROOT, ".."));
const WORKSPACE_ROOT = path.resolve(process.env.ASSISTANT_WORKSPACE || path.join(ROOT, "workspace"));
const WORKSPACE_WEB = path.join(WORKSPACE_ROOT, "infinite-canvas", "web");
const WEB_DIST = path.resolve(process.env.ASSISTANT_WEB_DIST || path.join(APP_ROOT, "infinite-canvas", "web", "dist"));
const DATA_DIR = path.resolve(process.env.ASSISTANT_DATA_DIR || path.join(ROOT, "data"));
const BACKUP_ROOT = path.join(DATA_DIR, "backups");
const FIXES_FILE = path.join(DATA_DIR, "fixes.json");
const PROPOSALS_FILE = path.join(DATA_DIR, "proposals.json");
const LOG_FILE = path.join(DATA_DIR, "assistant.log");
const GATEWAY_URL = normalizeGatewayUrl(process.env.ASSISTANT_GATEWAY_URL || "http://127.0.0.1:8190");
const COMFY_URL = String(process.env.ASSISTANT_COMFY_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const IDLE_MS = Math.max(5_000, Number(process.env.ASSISTANT_IDLE_MS || 180_000));
const PARENT_PID = Number(process.env.ASSISTANT_PARENT_PID || 0);
const APP_VERSION = (readText(path.join(APP_ROOT, "VERSION")) || "0.0.0").trim();
const REQUEST_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 6000;
const THREAD_IDLE_MS = 2 * 60 * 60 * 1000;
const ENGINE = "pi-agent-core@0.73.1";
const MIN_BUILD_FREE_RAM = 1.2 * 1024 * 1024 * 1024;

const startedAt = new Date().toISOString();
const threads = new Map();
const proposals = new Map();
let applyRunning = false;
let activeRequests = 0;
let buildRunning = false;
let lastActivity = Date.now();
let shuttingDown = false;
let recoveryReport = { state: "running", reapplied: 0, conflicts: [], build: null, at: Date.now() };
let recoveryPromise = Promise.resolve();

function readText(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return "";
    }
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function log(...args) {
    const line = `${new Date().toISOString()} [assistant] ${args.join(" ")}`;
    console.log(line);
    try {
        ensureDir(DATA_DIR);
        fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
    } catch {
        // 日志写失败不影响服务。
    }
}

function sha256(text) {
    return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
}

function workspaceVersion() {
    return readText(path.join(WORKSPACE_ROOT, "VERSION")).trim() || readText(path.join(WORKSPACE_ROOT, "infinite-canvas", "VERSION")).trim() || "unknown";
}

function touch() {
    lastActivity = Date.now();
}

function beginActivity() {
    activeRequests += 1;
    touch();
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        activeRequests = Math.max(0, activeRequests - 1);
        touch();
    };
}

function corsHeaders(origin) {
    let allowed = false;
    try {
        const host = new URL(String(origin || "")).hostname.toLowerCase();
        allowed = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
    } catch {
        allowed = false;
    }
    return {
        ...(allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, accept",
        "Access-Control-Max-Age": "600",
    };
}

function sendJson(res, status, payload, origin) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        ...corsHeaders(origin),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > REQUEST_LIMIT_BYTES) {
                reject(new Error("请求体过大"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch {
                reject(new Error("JSON 解析失败"));
            }
        });
        req.on("error", reject);
    });
}

function normalizeBaseUrl(value) {
    let url;
    try {
        url = new URL(String(value || "").trim());
    } catch {
        return "";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    let pathname = url.pathname.replace(/\/+$/, "");
    if (/generativelanguage\.googleapis\.com$/i.test(url.hostname) && !/\/openai$/i.test(pathname)) {
        pathname = `${pathname || "/v1beta"}/openai`;
    }
    return `${url.protocol}//${url.host}${pathname}`;
}

function validateProfile(api) {
    if (!api || typeof api !== "object") return { error: "缺少 API 配置" };
    const baseUrl = normalizeBaseUrl(api.baseUrl);
    const apiKey = String(api.apiKey || "").trim();
    const model = String(api.model || "").trim();
    if (!baseUrl) return { error: "API 地址无效（只支持 http/https）" };
    if (!apiKey) return { error: "API Key 为空，请先在画布设置里配置" };
    if (!model) return { error: "API 模型为空" };
    return { ok: true, baseUrl, apiKey, model, name: String(api.name || "").trim() };
}

function buildModel(profile) {
    return {
        id: profile.model,
        name: profile.model,
        api: "openai-completions",
        provider: "openai",
        baseUrl: profile.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
    };
}

function profileSignature(profile) {
    return `${profile.baseUrl}|${profile.model}|${profile.apiKey}`;
}

function zeroUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function seedHistory(history, model) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
        .slice(-12)
        .map((item) =>
            item.role === "user"
                ? { role: "user", content: item.content.slice(0, MAX_MESSAGE_CHARS), timestamp: Date.now() }
                : {
                      role: "assistant",
                      content: [{ type: "text", text: item.content.slice(0, MAX_MESSAGE_CHARS) }],
                      api: model.api,
                      provider: model.provider,
                      model: model.id,
                      usage: zeroUsage(),
                      stopReason: "stop",
                      timestamp: Date.now(),
                  },
        );
}

function toolLabel(name) {
    const labels = {
        gateway_health: "网关健康",
        setup_status: "扫描状态",
        workflow_status: "工作流状态",
        resource_status: "资源状态",
        directory_settings: "目录设置",
        system_stats: "系统状态",
    };
    return labels[name] || name;
}

function compactArgs(args) {
    if (!args || typeof args !== "object") return {};
    const out = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string") out[key] = value.slice(0, 120);
        else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    }
    return out;
}

function sanitizeError(message, apiKey) {
    let text = String(message || "未知错误");
    if (apiKey) text = text.split(apiKey).join("***");
    text = text.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***");
    text = text.replace(/sk-[A-Za-z0-9._\-]{8,}/g, "sk-***");
    const lower = text.toLowerCase();
    let hint = "";
    if (/connection error|fetch failed|econnrefused|enotfound|getaddrinfo/.test(lower)) hint = "无法连接模型 API，请检查 API 地址、网络和 Key 是否有效。";
    else if (/\b401\b|unauthorized|invalid api key|authentication/.test(lower)) hint = "API Key 无效或没有权限（401）。";
    else if (/\b404\b|model not found|not found/.test(lower)) hint = "API 地址或模型名不存在（404）。";
    else if (/\b429\b|rate limit|too many requests/.test(lower)) hint = "API 限流（429），稍后再试。";
    if (hint) text = `${hint}（${text}）`;
    return text.slice(0, 1200);
}

function lastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "assistant") continue;
        return (message.content || [])
            .filter((part) => part?.type === "text")
            .map((part) => part.text || "")
            .join("");
    }
    return "";
}

function lastAssistantUsage(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "assistant" && message.usage) return message.usage;
    }
    return null;
}

function buildTools(gatewayUrl) {
    return [
        ...createDiagnosticTools({ gatewayUrl }),
        ...createRepairTools({
            workspaceRoot: WORKSPACE_ROOT,
            proposals,
            webDir: WORKSPACE_WEB,
            beforeBuild: checkBuildAllowed,
            runTask: runBuildTask,
        }),
    ];
}

function createThread({ id, systemPrompt, model, profile, history }) {
    const tools = buildTools(profile.gatewayUrl);
    const agent = new Agent({
        initialState: {
            systemPrompt,
            model,
            tools,
        },
        getApiKey: () => profile.apiKey,
        toolExecution: "sequential",
    });
    const seeded = seedHistory(history, model);
    if (seeded.length) agent.state.messages = seeded;
    const record = {
        id,
        agent,
        signature: profileSignature(profile),
        gatewayUrl: profile.gatewayUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        running: false,
        subscriber: null,
        lastActive: Date.now(),
    };
    threads.set(id, record);
    return record;
}

function updateThreadContext(record, { systemPrompt, profile }) {
    record.agent.state.systemPrompt = systemPrompt;
    if (record.signature !== profileSignature(profile)) {
        record.signature = profileSignature(profile);
        record.model = profile.model;
        record.apiKey = profile.apiKey;
        record.agent.state.model = buildModel(profile);
    }
    if (record.gatewayUrl !== profile.gatewayUrl) {
        record.gatewayUrl = profile.gatewayUrl;
        record.agent.state.tools = buildTools(profile.gatewayUrl);
    }
    record.lastActive = Date.now();
}

function extractToolSummary(name, result) {
    const text = (result?.content || []).find((item) => item?.type === "text")?.text || "";
    const details = result?.details || {};
    if (name === "propose_edit") return `修复方案 · ${details.files?.length ?? 0} 个文件，等待确认`;
    if (name === "run_check") return `${details.kind || "检查"} ${details.ok ? "通过" : "失败"}`;
    if (name === "read_source") return `读取 ${details.path || ""} · ${details.totalLines ?? "?"} 行`;
    if (name === "search_source") return `匹配 ${details.count ?? 0} 条`;
    if (name === "list_workspace") return "工作区目录";
    if (name === "read_remote_source") return details.lfs ? "LFS 指针" : `远程源码 ${text.length} 字符`;
    try {
        const data = JSON.parse(text);
        if (name === "gateway_health") {
            const counts = data?.setup?.counts || data?.workflows || {};
            return `网关 ${data?.version || "?"} · ComfyUI ${data?.comfy?.reachable ? "可达" : "不可达"} · ${counts.available ?? "?"}/${counts.total ?? counts.count ?? "?"}`;
        }
        if (name === "setup_status") {
            const counts = data?.counts || {};
            return `扫描 ${data?.phase || "?"} · ${counts.available ?? "?"}/${counts.total ?? "?"} · 不可用 ${data?.unavailable?.length ?? 0}`;
        }
        if (name === "workflow_status") {
            const list = data?.workflows || [];
            const offline = list.filter((item) => (item.problems || []).some((problem) => String(problem).startsWith("offline"))).length;
            if (offline) return `ComfyUI 离线 · ${data?.total ?? list.length} 条待确认`;
            const problems = list.filter((item) => !item.available || item.problems?.length || item.variantProblems?.length).length;
            return `${list.length}/${data?.total ?? 0} 条 · 问题 ${problems}`;
        }
        if (name === "resource_status") {
            const counts = data?.counts || {};
            return `缺失 ${counts.missing ?? "?"} · 别名 ${data?.aliases?.length ?? 0} · 缺依赖 ${data?.workflowDependencies?.length ?? 0}`;
        }
        if (name === "directory_settings") {
            return `重启 ${data?.loadReport?.restartRequired ? "需要" : "不需要"} · ${data?.comfyDir || data?.comfyRoot || ""}`;
        }
        if (name === "system_stats") {
            const gpu = data?.gpu?.[0];
            return gpu ? `GPU ${(gpu.memoryUsedMb / 1024).toFixed(1)}/${(gpu.memoryTotalMb / 1024).toFixed(1)} GB` : "无 GPU 数据";
        }
        if (name === "restart_comfy") return data?.ok ? "ComfyUI 已启动/重启" : "重启失败";
        if (name === "replace_model") return data?.resource?.matchedBy === "alias" ? `已替换 ${data?.resourceId || ""}` : `替换结果 ${data?.resource?.status || "?"}`;
        return text.replace(/\s+/g, " ").slice(0, 160);
    } catch {
        return text.replace(/\s+/g, " ").slice(0, 160);
    }
}

function runNodeScript(scriptPath, args, timeoutMs) {
    return new Promise((resolve) => {
        if (!fs.existsSync(scriptPath)) {
            resolve({ ok: false, output: `缺少构建程序：${scriptPath}` });
            return;
        }
        execFile(
            process.execPath,
            [scriptPath, ...args],
            { cwd: WORKSPACE_WEB, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
            (error, stdout, stderr) => {
                const output = `${stdout || ""}\n${stderr || ""}`.trim();
                resolve({ ok: !error, output: output.length > 8000 ? output.slice(-8000) : output });
            },
        );
    });
}

async function runBuildTask(kind) {
    const tsc = path.join(WORKSPACE_WEB, "node_modules", "typescript", "bin", "tsc");
    const vite = path.join(WORKSPACE_WEB, "node_modules", "vite", "bin", "vite.js");
    if (kind === "typecheck") return runNodeScript(tsc, ["--noEmit"], 240000);
    if (kind === "build") return runNodeScript(vite, ["build"], 420000);
    return { ok: false, output: `未知构建任务：${kind}` };
}

async function checkBuildAllowed() {
    const free = os.freemem();
    if (free > 0 && free < MIN_BUILD_FREE_RAM) {
        return { ok: false, reason: `可用内存不足（${(free / 1024 ** 3).toFixed(1)} GB），先关闭其他程序再应用修复。` };
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch(`${COMFY_URL}/queue`, { signal: controller.signal, headers: { accept: "application/json" } });
            if (response.ok) {
                const queue = await response.json();
                const running = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
                const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
                if (running + pending > 0) return { ok: false, reason: "ComfyUI 正在生成或排队，等任务结束后再应用修复。" };
            }
        } finally {
            clearTimeout(timer);
        }
    } catch {
        // ComfyUI 离线时不影响纯前端修复构建。
    }
    return { ok: true };
}

function resolveWorkspacePath(relative) {
    const rel = String(relative || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel.startsWith("infinite-canvas/web/")) throw new Error("只允许修改画布前端源码");
    const parts = rel.split("/");
    if (parts.some((part) => part === ".." || part === "node_modules" || part === "dist" || part.startsWith("."))) {
        throw new Error(`禁止访问：${rel}`);
    }
    if (/^infinite-canvas\/web\/(vite|postcss|tailwind|tsconfig[^/]*\.json|package(-lock)?\.json|pnpm-lock\.yaml|bun\.lock|index\.html)$/i.test(rel)) {
        throw new Error("不能修改构建配置或依赖清单");
    }
    const target = path.resolve(WORKSPACE_ROOT, rel);
    if (!target.startsWith(path.join(WORKSPACE_ROOT, "infinite-canvas", "web") + path.sep)) throw new Error("路径不能跳出工作区");
    return target;
}

function loadFixes() {
    const data = readJson(FIXES_FILE, null);
    if (!data || !Array.isArray(data.records)) return { version: 1, records: [] };
    return data;
}

function saveFixes(data) {
    writeJsonAtomic(FIXES_FILE, data);
}

function recordAppliedFix(proposal) {
    const fixes = loadFixes();
    const edits = proposal.edits.map((edit) => {
        let newSha = "";
        try {
            newSha = sha256(fs.readFileSync(resolveWorkspacePath(edit.path), "utf8"));
        } catch {
            newSha = "";
        }
        return {
            path: edit.path,
            isCreate: edit.isCreate === true,
            search: edit.isCreate ? "" : String(edit.search || ""),
            replace: String(edit.replace || ""),
            newSha,
        };
    });
    const record = {
        id: proposal.id,
        summary: proposal.summary,
        appliedAt: Date.now(),
        workspaceVersion: workspaceVersion(),
        status: "applied",
        edits,
    };
    const index = fixes.records.findIndex((item) => item.id === proposal.id);
    if (index >= 0) fixes.records[index] = record;
    else fixes.records.push(record);
    saveFixes(fixes);
}

function removeFixRecord(id) {
    const fixes = loadFixes();
    const next = fixes.records.filter((item) => item.id !== id);
    if (next.length !== fixes.records.length) saveFixes({ version: 1, records: next });
}

function loadAppliedProposals() {
    const data = readJson(PROPOSALS_FILE, null);
    if (!data || !Array.isArray(data.records)) return;
    for (const record of data.records) {
        if (!record || record.status !== "applied" || !Array.isArray(record.edits)) continue;
        proposals.set(record.id, { ...record, status: "applied" });
    }
}

function persistAppliedProposals() {
    const records = [...proposals.values()]
        .filter((proposal) => proposal.status === "applied")
        .map((proposal) => ({
            id: proposal.id,
            summary: proposal.summary,
            createdAt: proposal.createdAt,
            status: "applied",
            edits: proposal.edits,
        }));
    writeJsonAtomic(PROPOSALS_FILE, { version: 1, records });
}

async function rebuildAndDeploy({ guard = true } = {}) {
    if (guard) {
        const allowed = await checkBuildAllowed();
        if (!allowed.ok) return { ok: false, stage: "preflight", output: allowed.reason };
    }
    buildRunning = true;
    touch();
    try {
        const typecheck = await runBuildTask("typecheck");
        if (!typecheck.ok) return { ok: false, stage: "typecheck", output: typecheck.output };
        const build = await runBuildTask("build");
        if (!build.ok) return { ok: false, stage: "build", output: build.output };
        const deploy = deployWorkspace();
        if (!deploy.ok) return { ok: false, stage: "deploy", output: deploy.output };
        return { ok: true, output: `${typecheck.output}\n${build.output}\n${deploy.output}`.trim() };
    } finally {
        buildRunning = false;
        touch();
    }
}

function runtimeConfigScript() {
    let origin;
    try {
        origin = new URL(GATEWAY_URL).origin;
    } catch {
        origin = "http://127.0.0.1:8190";
    }
    const port = new URL(origin).port || "80";
    return `window.__RUNTIME_CONFIG__ = ${JSON.stringify({ LOCAL_GATEWAY_HOST: "127.0.0.1", LOCAL_GATEWAY_PORT: port, LOCAL_GATEWAY_URL: `${origin}/v1` })};\n`;
}

function readPluginManifest(distDir) {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(distDir, "plugins", "index.json"), "utf8"));
        return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function deployWorkspace() {
    const sourceDist = path.join(WORKSPACE_WEB, "dist");
    if (!fs.existsSync(path.join(sourceDist, "index.html"))) {
        return { ok: false, output: `工作区构建产物不存在：${sourceDist}` };
    }
    ensureDir(BACKUP_ROOT);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backupDist = path.join(BACKUP_ROOT, `deploy-${stamp}-${process.pid}`);
    const stagingDist = `${WEB_DIST}.assistant-new-${process.pid}`;
    const hadTarget = fs.existsSync(WEB_DIST);
    let configScript = "";
    let oldPlugins = [];
    try {
        if (hadTarget) {
            fs.cpSync(WEB_DIST, backupDist, { recursive: true });
            configScript = readText(path.join(WEB_DIST, "config.js"));
            oldPlugins = readPluginManifest(WEB_DIST);
        }
        fs.rmSync(stagingDist, { recursive: true, force: true });
        fs.cpSync(sourceDist, stagingDist, { recursive: true });
        fs.writeFileSync(path.join(stagingDist, "config.js"), configScript || runtimeConfigScript(), "utf8");
        if (oldPlugins.length) {
            const nextPlugins = readPluginManifest(stagingDist);
            for (const plugin of oldPlugins) {
                const rel = String(plugin).replace(/^\/+/, "");
                if (!rel || nextPlugins.includes(plugin)) continue;
                const source = path.join(backupDist, rel);
                if (!fs.existsSync(source)) continue;
                fs.mkdirSync(path.dirname(path.join(stagingDist, rel)), { recursive: true });
                fs.copyFileSync(source, path.join(stagingDist, rel));
                nextPlugins.push(plugin);
            }
            fs.mkdirSync(path.join(stagingDist, "plugins"), { recursive: true });
            fs.writeFileSync(path.join(stagingDist, "plugins", "index.json"), JSON.stringify(nextPlugins), "utf8");
        }
        fs.rmSync(WEB_DIST, { recursive: true, force: true });
        fs.renameSync(stagingDist, WEB_DIST);
    } catch (error) {
        try {
            fs.rmSync(stagingDist, { recursive: true, force: true });
            if (hadTarget && fs.existsSync(backupDist)) {
                fs.rmSync(WEB_DIST, { recursive: true, force: true });
                fs.cpSync(backupDist, WEB_DIST, { recursive: true });
            }
        } catch {
            // 回滚失败时保留备份目录供手工恢复。
        }
        return { ok: false, output: `部署失败：${error?.message || error}` };
    }
    try {
        const backups = fs
            .readdirSync(BACKUP_ROOT)
            .filter((name) => name.startsWith("deploy-"))
            .map((name) => ({ name, at: fs.statSync(path.join(BACKUP_ROOT, name)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
        for (const item of backups.slice(3)) fs.rmSync(path.join(BACKUP_ROOT, item.name), { recursive: true, force: true });
    } catch {
        // 清理旧备份失败不影响本次部署。
    }
    return { ok: true, output: `已部署到 ${WEB_DIST}` };
}

async function recoverAppliedFixes() {
    const fixes = loadFixes();
    const applied = fixes.records.filter((record) => record.status === "applied" && Array.isArray(record.edits) && record.edits.length);
    const report = { state: "done", reapplied: 0, checked: applied.length, conflicts: [], build: null, at: Date.now() };
    if (!applied.length) {
        recoveryReport = report;
        return report;
    }
    let changed = false;
    for (const record of applied) {
        let recordChanged = false;
        const conflicts = [];
        for (const edit of record.edits) {
            try {
                const file = resolveWorkspacePath(edit.path);
                const exists = fs.existsSync(file);
                if (exists) {
                    const current = fs.readFileSync(file, "utf8");
                    if (edit.newSha && sha256(current) === edit.newSha) continue;
                }
                if (edit.isCreate) {
                    if (exists) {
                        conflicts.push({ path: edit.path, reason: "文件已存在且内容不同" });
                        continue;
                    }
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, String(edit.replace || ""), "utf8");
                    edit.newSha = sha256(String(edit.replace || ""));
                    recordChanged = true;
                    continue;
                }
                if (!exists) {
                    conflicts.push({ path: edit.path, reason: "文件不存在" });
                    continue;
                }
                const current = fs.readFileSync(file, "utf8");
                const search = String(edit.search || "");
                if (!search) {
                    conflicts.push({ path: edit.path, reason: "缺少可重放的替换原文" });
                    continue;
                }
                const first = current.indexOf(search);
                if (first < 0 || current.indexOf(search, first + search.length) >= 0) {
                    conflicts.push({ path: edit.path, reason: first < 0 ? "原文已变化" : "原文出现多次" });
                    continue;
                }
                const updated = `${current.slice(0, first)}${String(edit.replace || "")}${current.slice(first + search.length)}`;
                fs.writeFileSync(file, updated, "utf8");
                edit.newSha = sha256(updated);
                recordChanged = true;
            } catch (error) {
                conflicts.push({ path: edit.path, reason: String(error?.message || error) });
            }
        }
        if (conflicts.length) {
            report.conflicts.push({ id: record.id, summary: record.summary, files: conflicts });
        } else if (recordChanged) {
            report.reapplied += 1;
            record.workspaceVersion = workspaceVersion();
            changed = true;
        }
    }
    if (changed) {
        const result = await rebuildAndDeploy({ guard: false });
        report.build = { ok: result.ok, stage: result.stage || "", output: String(result.output || "").slice(-4000) };
        if (!result.ok) report.state = "failed";
    }
    fixes.records = fixes.records.map((record) => ({ ...record, lastRecoveryAt: Date.now() }));
    saveFixes(fixes);
    recoveryReport = report;
    log(`fix recovery checked=${report.checked} reapplied=${report.reapplied} conflicts=${report.conflicts.length} build=${report.build ? (report.build.ok ? "ok" : "failed") : "skipped"}`);
    return report;
}

function handleChat(req, res, origin) {
    void (async () => {
        const endActivity = beginActivity();
        let body;
        try {
            body = await readBody(req);
        } catch (error) {
            endActivity();
            sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
            return;
        }
        const message = String(body.message || "").trim();
        if (!message) {
            endActivity();
            sendJson(res, 400, { ok: false, error: "消息为空" }, origin);
            return;
        }
        if (message.length > MAX_MESSAGE_CHARS) {
            endActivity();
            sendJson(res, 400, { ok: false, error: `消息过长（上限 ${MAX_MESSAGE_CHARS} 字）` }, origin);
            return;
        }
        const validated = validateProfile(body.api);
        if (!validated.ok) {
            endActivity();
            sendJson(res, 400, { ok: false, error: validated.error }, origin);
            return;
        }
        const profile = {
            ...validated,
            gatewayUrl: normalizeGatewayUrl(body.gatewayUrl || GATEWAY_URL),
        };
        const threadId = String(body.threadId || "").trim() || randomUUID();
        const history = Array.isArray(body.history) ? body.history : [];
        const context = body.context && typeof body.context === "object" ? body.context : null;
        await recoveryPromise;
        const systemPrompt = buildSystemPrompt({ context, gatewayUrl: profile.gatewayUrl, workspaceRoot: WORKSPACE_ROOT });
        const model = buildModel(profile);

        let record = threads.get(threadId);
        let recreated = false;
        if (!record) {
            record = createThread({ id: threadId, systemPrompt, model, profile, history });
            recreated = history.length > 0;
        } else {
            updateThreadContext(record, { systemPrompt, profile });
        }
        if (record.running) {
            endActivity();
            sendJson(res, 409, { ok: false, error: "该卡片正在回复中，请先停止或等待完成" }, origin);
            return;
        }
        record.running = true;
        record.lastActive = Date.now();
        let ended = false;
        let sentError = false;
        let aborted = false;

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            ...corsHeaders(origin),
        });
        const send = (event, payload) => {
            if (ended) return;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch {
                ended = true;
            }
        };
        const heartbeat = setInterval(() => {
            if (!ended) {
                try {
                    res.write(": ping\n\n");
                } catch {
                    ended = true;
                }
            }
        }, 15000);
        record.subscriber = send;
        send("meta", {
            threadId,
            engine: ENGINE,
            serviceVersion: SERVICE_VERSION,
            appVersion: APP_VERSION,
            workspaceVersion: workspaceVersion(),
            permission: "L0",
            model: profile.model,
            gatewayUrl: profile.gatewayUrl,
            recreated: recreated || record.agent.state.messages.length === 0,
            recovery: recoveryReport,
        });

        const unsubscribe = record.agent.subscribe((event) => {
            if (ended) return;
            if (event.type === "message_update") {
                const update = event.assistantMessageEvent;
                if (update?.type === "text_delta" && update.delta) send("delta", { text: update.delta });
                if (update?.type === "error") {
                    const text = sanitizeError(update.error?.errorMessage || "模型请求失败", profile.apiKey);
                    if (!sentError) {
                        sentError = true;
                        send("error", { message: text });
                    }
                }
                return;
            }
            if (event.type === "tool_execution_start") {
                send("tool_start", { id: event.toolCallId, name: event.toolName, label: toolLabel(event.toolName), args: compactArgs(event.args) });
                return;
            }
            if (event.type === "tool_execution_end") {
                send("tool_end", { id: event.toolCallId, name: event.toolName, ok: !event.isError, summary: extractToolSummary(event.toolName, event.result) });
                const details = event.result?.details;
                if (event.toolName === "propose_edit" && details?.proposalId) {
                    send("patch", { proposalId: details.proposalId, summary: details.summary, files: details.files || [] });
                }
            }
        });

        try {
            await record.agent.prompt(message);
            const messages = record.agent.state.messages;
            const finalText = lastAssistantText(messages);
            const usage = lastAssistantUsage(messages);
            const errorMessage = record.agent.state.errorMessage;
            aborted = Boolean(record.agent.signal?.aborted);
            if (aborted) {
                send("done", { text: finalText, stopped: true, usage });
            } else if (errorMessage && !finalText) {
                if (!sentError) send("error", { message: sanitizeError(errorMessage, profile.apiKey) });
                send("done", { text: "", failed: true, usage });
            } else {
                send("done", { text: finalText, usage });
            }
        } catch (error) {
            if (!sentError) send("error", { message: sanitizeError(error?.message || error, profile.apiKey) });
            send("done", { text: "", failed: true });
        } finally {
            unsubscribe();
            record.subscriber = null;
            record.running = false;
            record.lastActive = Date.now();
            ended = true;
            clearInterval(heartbeat);
            res.end();
            endActivity();
        }
    })();
}

function handleApply(req, res, origin, id) {
    void (async () => {
        const endActivity = beginActivity();
        try {
            const body = await readBody(req);
            if (body.confirm !== true) {
                sendJson(res, 400, { ok: false, error: "应用修复需要用户确认" }, origin);
                return;
            }
            if (applyRunning) {
                sendJson(res, 409, { ok: false, error: "已有修复正在应用，请稍后" }, origin);
                return;
            }
            const proposal = proposals.get(id);
            if (!proposal) {
                sendJson(res, 404, { ok: false, error: "修复方案不存在或已过期" }, origin);
                return;
            }
            if (Date.now() - proposal.createdAt > 30 * 60 * 1000) {
                proposals.delete(id);
                sendJson(res, 410, { ok: false, error: "修复方案已过期，请重新生成" }, origin);
                return;
            }
            if (proposal.status !== "pending") {
                sendJson(res, 409, { ok: false, error: `修复方案状态为 ${proposal.status}，请重新生成或回滚` }, origin);
                return;
            }
            const allowed = await checkBuildAllowed();
            if (!allowed.ok) {
                sendJson(res, 409, { ok: false, stage: "preflight", error: allowed.reason }, origin);
                return;
            }
            await recoveryPromise;
            applyRunning = true;
            proposal.status = "applying";
            let applied = null;
            try {
                applied = applyProposalFiles({ proposal, workspaceRoot: WORKSPACE_ROOT, backupRoot: BACKUP_ROOT });
                const result = await rebuildAndDeploy({ guard: false });
                if (!result.ok) {
                    proposal.status = "failed";
                    proposal.lastError = result;
                    sendJson(res, 200, { ok: false, stage: result.stage, output: result.output, applied, rollbackAvailable: true }, origin);
                    return;
                }
                proposal.status = "applied";
                recordAppliedFix(proposal);
                persistAppliedProposals();
                sendJson(res, 200, { ok: true, applied, output: result.output, reload: true }, origin);
            } catch (error) {
                proposal.status = "failed";
                proposal.lastError = String(error?.message || error);
                sendJson(res, 200, { ok: false, stage: "apply", output: String(error?.message || error), applied, rollbackAvailable: Boolean(applied) }, origin);
            } finally {
                applyRunning = false;
            }
        } catch (error) {
            applyRunning = false;
            sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
        } finally {
            endActivity();
        }
    })();
}

function handleRollback(req, res, origin, id) {
    void (async () => {
        const endActivity = beginActivity();
        try {
            const body = await readBody(req);
            if (body.confirm !== true) {
                sendJson(res, 400, { ok: false, error: "回滚需要用户确认" }, origin);
                return;
            }
            if (applyRunning) {
                sendJson(res, 409, { ok: false, error: "已有修复正在应用，请稍后" }, origin);
                return;
            }
            const proposal = proposals.get(id);
            if (!proposal) {
                sendJson(res, 404, { ok: false, error: "修复方案不存在" }, origin);
                return;
            }
            const allowed = await checkBuildAllowed();
            if (!allowed.ok) {
                sendJson(res, 409, { ok: false, stage: "preflight", error: allowed.reason }, origin);
                return;
            }
            applyRunning = true;
            try {
                rollbackProposalFiles({ proposal, workspaceRoot: WORKSPACE_ROOT, backupRoot: BACKUP_ROOT });
                removeFixRecord(id);
                proposals.delete(id);
                persistAppliedProposals();
                proposal.status = "rolled_back";
                const result = await rebuildAndDeploy({ guard: false });
                sendJson(res, 200, { ok: result.ok, stage: result.stage || "", output: result.output, rolledBack: true }, origin);
            } catch (error) {
                sendJson(res, 200, { ok: false, stage: "rollback", output: String(error?.message || error) }, origin);
            } finally {
                applyRunning = false;
            }
        } catch (error) {
            applyRunning = false;
            sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
        } finally {
            endActivity();
        }
    })();
}

function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    for (const record of threads.values()) {
        try {
            record.agent.abort();
        } catch {
            // ignore
        }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
}

const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT || 0}`}`);
    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
        sendJson(
            res,
            200,
            {
                ok: true,
                service: "canvas-assistant",
                engine: ENGINE,
                version: SERVICE_VERSION,
                appVersion: APP_VERSION,
                workspaceVersion: workspaceVersion(),
                startedAt,
                threads: threads.size,
                active: activeRequests,
                buildRunning,
                idleRemainingMs: Math.max(0, IDLE_MS - (Date.now() - lastActivity)),
                idleMs: IDLE_MS,
                gateway: GATEWAY_URL,
                permission: "L0-read-only + L1-source + L2-propose + L3-apply/actions",
                workspace: { root: WORKSPACE_ROOT, exists: fs.existsSync(WORKSPACE_ROOT) },
                deployTarget: WEB_DIST,
                recovery: recoveryReport,
            },
            origin,
        );
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistant/wake") {
        touch();
        sendJson(res, 200, { ok: true, idleRemainingMs: IDLE_MS }, origin);
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistant/shutdown") {
        void (async () => {
            try {
                const body = await readBody(req);
                if (body.confirm !== true) {
                    sendJson(res, 400, { ok: false, error: "缺少确认" }, origin);
                    return;
                }
                sendJson(res, 200, { ok: true }, origin);
                setTimeout(() => shutdown("gateway-request"), 30);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
            }
        })();
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/assistant/skill") {
        sendJson(res, 200, { ok: true, name: SKILL_NAME, version: SKILL_VERSION, content: SKILL_MARKDOWN }, origin);
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/assistant/workspace") {
        sendJson(res, 200, { ok: true, root: WORKSPACE_ROOT, web: WORKSPACE_WEB, exists: fs.existsSync(WORKSPACE_ROOT) }, origin);
        return;
    }
    if (req.method === "POST" && /^\/api\/assistant\/proposals\/[^/]+\/apply$/.test(url.pathname)) {
        handleApply(req, res, origin, decodeURIComponent(url.pathname.split("/")[4] || ""));
        return;
    }
    if (req.method === "POST" && /^\/api\/assistant\/proposals\/[^/]+\/rollback$/.test(url.pathname)) {
        handleRollback(req, res, origin, decodeURIComponent(url.pathname.split("/")[4] || ""));
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/assistant/diagnostics") {
        void collectSnapshot(url.searchParams.get("gateway") || GATEWAY_URL).then((snapshot) => sendJson(res, 200, snapshot, origin));
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistant/chat") {
        handleChat(req, res, origin);
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistant/stop") {
        void (async () => {
            try {
                const body = await readBody(req);
                const record = threads.get(String(body.threadId || ""));
                if (record) record.agent.abort();
                sendJson(res, 200, { ok: true, stopped: Boolean(record) }, origin);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
            }
        })();
        return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/assistant/threads/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/assistant/threads/".length));
        const record = threads.get(id);
        if (record) {
            try {
                record.agent.abort();
            } catch {
                // ignore
            }
            threads.delete(id);
        }
        sendJson(res, 200, { ok: true, removed: Boolean(record) }, origin);
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistant/threads") {
        void (async () => {
            try {
                const body = await readBody(req);
                const validated = validateProfile(body.api);
                if (!validated.ok) {
                    sendJson(res, 400, { ok: false, error: validated.error }, origin);
                    return;
                }
                const profile = { ...validated, gatewayUrl: normalizeGatewayUrl(body.gatewayUrl || GATEWAY_URL) };
                const id = randomUUID();
                createThread({ id, systemPrompt: buildSystemPrompt({ gatewayUrl: profile.gatewayUrl, workspaceRoot: WORKSPACE_ROOT }), model: buildModel(profile), profile, history: [] });
                sendJson(res, 200, { ok: true, threadId: id }, origin);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error?.message || error) }, origin);
            }
        })();
        return;
    }
    sendJson(res, 404, { ok: false, error: "not found" }, origin);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT || 0, HOST, () => {
    const actualPort = server.address()?.port;
    ensureDir(DATA_DIR);
    loadAppliedProposals();
    log(`listening on http://${HOST}:${actualPort} version=${SERVICE_VERSION} app=${APP_VERSION} workspace=${workspaceVersion()}`);
    recoveryPromise = recoverAppliedFixes().catch((error) => {
        recoveryReport = { state: "failed", reapplied: 0, conflicts: [], build: null, error: String(error?.message || error), at: Date.now() };
        log(`fix recovery failed: ${error?.message || error}`);
        return recoveryReport;
    });
});

setInterval(() => {
    if (shuttingDown) return;
    if (activeRequests > 0 || buildRunning) {
        touch();
        return;
    }
    if (Date.now() - lastActivity >= IDLE_MS) {
        shutdown("idle");
        return;
    }
    const now = Date.now();
    for (const [id, record] of threads) {
        if (record.running) continue;
        if (now - record.lastActive > THREAD_IDLE_MS) {
            try {
                record.agent.abort();
            } catch {
                // ignore
            }
            threads.delete(id);
            log(`thread expired ${id}`);
        }
    }
    for (const [id, proposal] of proposals) {
        if (now - proposal.createdAt > 2 * 60 * 60 * 1000) proposals.delete(id);
    }
}, 5000).unref();

if (PARENT_PID) {
    setInterval(() => {
        try {
            process.kill(PARENT_PID, 0);
        } catch (error) {
            if (error?.code === "ESRCH") shutdown("parent-exit");
        }
    }, 20000).unref();
}

process.on("SIGINT", () => shutdown("sigint"));
process.on("SIGTERM", () => shutdown("sigterm"));
