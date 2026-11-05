import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const READY_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 2_500;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVersion(file) {
    try {
        return fs.readFileSync(file, "utf8").trim();
    } catch {
        return "";
    }
}

function hasFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function hasDir(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

function readRuntimeConfig(appRoot) {
    let manifest = null;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "update.json"), "utf8"));
    } catch {
        manifest = null;
    }
    const value = manifest && typeof manifest.assistantRuntime === "object" ? manifest.assistantRuntime : {};
    return {
        url: typeof value.url === "string" ? value.url.trim() : "",
        sha256: typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "",
        runtimeVersion: typeof value.runtimeVersion === "string" ? value.runtimeVersion.trim() : "",
        fullPackageUrl: typeof value.fullPackageUrl === "string" ? value.fullPackageUrl.trim() : "",
    };
}

function compareRuntimeVersions(left, right) {
    const parse = (value) => String(value || "").replace(/^v/i, "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff) return diff < 0 ? -1 : 1;
    }
    return 0;
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => (port ? resolve(port) : reject(new Error("无法分配空闲端口"))));
        });
    });
}

function childEnv({ port, config, paths, idleMs }) {
    const base = {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        TEMP: process.env.TEMP || process.env.TMP || "",
        TMP: process.env.TMP || process.env.TEMP || "",
        USERPROFILE: process.env.USERPROFILE || "",
        NODE_ENV: "production",
    };
    return {
        ...base,
        ASSISTANT_PORT: String(port),
        ASSISTANT_HOST: "127.0.0.1",
        ASSISTANT_APP_ROOT: config.appRoot,
        ASSISTANT_WORKSPACE: paths.workspace,
        ASSISTANT_WEB_DIST: config.canvasDist,
        ASSISTANT_DATA_DIR: paths.data,
        ASSISTANT_GATEWAY_URL: `http://127.0.0.1:${config.port}`,
        ASSISTANT_COMFY_URL: config.comfyUrl,
        ASSISTANT_IDLE_MS: String(idleMs),
        ASSISTANT_PARENT_PID: String(process.pid),
    };
}

export function createAssistantManager({
    config,
    logger,
    spawnFn = spawn,
    fetchFn = fetch,
    findPort = freePort,
    readyTimeoutMs = READY_TIMEOUT_MS,
    idleMs = Number(process.env.ASSISTANT_IDLE_MS || 180_000),
} = {}) {
    const assistantDir = path.join(config.appRoot, "assistant");
    function runtimePackagePath() {
        return (
            [
                path.join(assistantDir, "runtime.zip"),
                path.join(config.appRoot, "assistant-runtime.zip"),
                path.join(config.appRoot, ".update", "assistant-runtime", "assistant-runtime.zip"),
            ].find(hasFile) || ""
        );
    }
    const paths = {
        root: assistantDir,
        server: path.join(assistantDir, "server.mjs"),
        workspace: path.join(assistantDir, "workspace"),
        workspaceWeb: path.join(assistantDir, "workspace", "infinite-canvas", "web"),
        workspaceWebModules: path.join(assistantDir, "workspace", "infinite-canvas", "web", "node_modules"),
        serviceModules: path.join(assistantDir, "node_modules", "@mariozechner", "pi-agent-core"),
        serviceAiModules: path.join(assistantDir, "node_modules", "@mariozechner", "pi-ai"),
        data: path.join(assistantDir, "data"),
        get runtimeZip() {
            return runtimePackagePath();
        },
    };
    const state = {
        child: null,
        url: "",
        port: 0,
        startedAt: "",
        error: "",
        stderrTail: [],
        stopping: false,
    };
    let ensurePromise = null;

    function availability() {
        const runtimePackagePresent = Boolean(runtimePackagePath());
        const runtimeConfig = readRuntimeConfig(config.appRoot);
        const runtimeVersion =
            readVersion(path.join(paths.workspace, "VERSION")) ||
            readVersion(path.join(paths.workspace, "infinite-canvas", "VERSION")) ||
            "";
        const runtimeTargetVersion = runtimeConfig.runtimeVersion;
        const runtimeUpdateAvailable = Boolean(
            runtimePackagePresent && runtimeVersion && runtimeTargetVersion && compareRuntimeVersions(runtimeVersion, runtimeTargetVersion) < 0,
        );
        const canDownload = Boolean(
            runtimeConfig.url && runtimeConfig.sha256 && config.launcherControlUrl && (!runtimePackagePresent || runtimeUpdateAvailable),
        );
        if (process.env.ASSISTANT_ENABLED === "0") {
            return {
                available: false,
                needFullPackage: false,
                canRepair: false,
                canDownload: false,
                runtimePackagePresent,
                runtimeVersion,
                runtimeTargetVersion,
                runtimeUpdateAvailable,
                fullPackageUrl: runtimeConfig.fullPackageUrl,
                runtimeState: runtimePackagePresent ? "disabled" : "disabled-without-package",
                reason: "Agent 已被环境变量关闭",
                missing: [],
            };
        }
        const missing = [];
        if (!hasFile(paths.server)) missing.push("assistant/server.mjs");
        if (!hasDir(paths.serviceModules) || !hasDir(paths.serviceAiModules)) missing.push("assistant/node_modules");
        if (!hasFile(path.join(paths.workspaceWeb, "package.json"))) missing.push("assistant/workspace");
        if (!hasDir(paths.workspaceWebModules)) missing.push("assistant/workspace/infinite-canvas/web/node_modules");
        if (!hasFile(path.join(config.canvasDist, "index.html"))) missing.push("infinite-canvas/web/dist");
        const canRepair = runtimePackagePresent && Boolean(config.launcherControlUrl);
        if (!missing.length) {
            return {
                available: true,
                needFullPackage: false,
                canRepair: false,
                canDownload,
                runtimePackagePresent,
                runtimeVersion,
                runtimeTargetVersion,
                runtimeUpdateAvailable,
                fullPackageUrl: runtimeConfig.fullPackageUrl,
                runtimeState: runtimePackagePresent ? "ready" : "ready-without-package",
                reason: "",
                missing: [],
            };
        }
        const fullPackageItems = new Set(["assistant/node_modules", "assistant/workspace", "assistant/workspace/infinite-canvas/web/node_modules"]);
        return {
            available: false,
            needFullPackage: missing.some((item) => fullPackageItems.has(item)),
            canRepair,
            canDownload,
            runtimePackagePresent,
            runtimeVersion,
            runtimeTargetVersion,
            runtimeUpdateAvailable,
            fullPackageUrl: runtimeConfig.fullPackageUrl,
            runtimeState: runtimePackagePresent ? "needs-repair" : "package-missing",
            reason: `缺少 ${missing.join("、")}`,
            missing,
        };
    }

    let lastRepairAt = 0;
    let repairPromise = null;
    async function repairRuntime({ download = false } = {}) {
        if (!config.launcherControlUrl) return { ok: false, error: "启动器未提供运行时解压接口，请重启应用" };
        if (repairPromise) return repairPromise;
        if (Date.now() - lastRepairAt < 60_000) return { ok: false, error: "刚尝试过解压，请稍后重试" };
        lastRepairAt = Date.now();
        repairPromise = (async () => {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 840_000);
                try {
                    const response = await fetchFn(`${config.launcherControlUrl}/ensure-assistant`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ download: download === true }),
                        signal: controller.signal,
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || data.ok === false) {
                        lastRepairAt = 0;
                        return { ok: false, error: data.error || `启动器解压 Agent 运行时失败（HTTP ${response.status}）` };
                    }
                    logger?.info?.(`Agent 运行时${data.extracted ? "已解压" : "已就绪"}`);
                    return { ok: true, extracted: data.extracted === true, downloaded: data.downloaded === true };
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                lastRepairAt = 0;
                return { ok: false, error: `无法联系启动器解压 Agent 运行时：${error.message}` };
            } finally {
                repairPromise = null;
            }
        })();
        return repairPromise;
    }

    async function probe(timeoutMs = PROBE_TIMEOUT_MS) {
        if (!state.url) return null;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchFn(`${state.url}/health`, { signal: controller.signal, headers: { accept: "application/json" } });
                if (!response.ok) return null;
                return await response.json();
            } finally {
                clearTimeout(timer);
            }
        } catch {
            return null;
        }
    }

    async function wake() {
        if (!state.url) return;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            try {
                await fetchFn(`${state.url}/api/assistant/wake`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: "{}" });
            } finally {
                clearTimeout(timer);
            }
        } catch {
            // 唤醒失败由下一次健康探测处理。
        }
    }

    async function waitReady(child, url) {
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
            if (state.child !== child) throw new Error(state.error || "Agent 服务启动后立即退出");
            const health = await probe(1000);
            if (health?.ok) return health;
            await sleep(250);
        }
        throw new Error(`Agent 服务启动超时${state.stderrTail.length ? `：${state.stderrTail.slice(-3).join(" ")}` : ""}`);
    }

    function clearChild(child) {
        if (child && state.child && state.child !== child) return;
        state.child = null;
        state.url = "";
        state.port = 0;
        state.startedAt = "";
    }

    async function spawnService() {
        const port = await findPort();
        const url = `http://127.0.0.1:${port}`;
        state.error = "";
        state.stderrTail = [];
        state.port = port;
        state.url = url;
        const child = spawnFn(process.execPath, [paths.server], {
            cwd: paths.root,
            env: childEnv({ port, config, paths, idleMs }),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        state.child = child;
        state.startedAt = new Date().toISOString();
        const collect = (prefix, level) => (chunk) => {
            const lines = String(chunk || "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            for (const line of lines) {
                state.stderrTail.push(`${prefix}${line}`);
                if (state.stderrTail.length > 40) state.stderrTail.shift();
                const write = level === "warn" ? logger?.warn : logger?.info;
                if (typeof write === "function") write.call(logger, `assistant ${prefix}${line}`);
            }
        };
        child.stdout?.on("data", collect("", "info"));
        child.stderr?.on("data", collect("ERR ", "warn"));
        child.on("error", (error) => {
            state.error = String(error?.message || error);
            logger?.warn?.(`Agent 服务启动失败：${state.error}`);
            clearChild(child);
        });
        child.on("exit", (code, signal) => {
            const expected = state.stopping;
            clearChild(child);
            if (!expected) logger?.warn?.(`Agent 服务退出（code=${code}, signal=${signal}）`);
        });
        try {
            await waitReady(child, url);
            logger?.info?.(`Agent 服务已唤起：${url}`);
            return { ok: true, url, port, pid: child.pid || 0 };
        } catch (error) {
            state.error = String(error?.message || error);
            try {
                child.kill();
            } catch {
                // ignore
            }
            clearChild(child);
            return { ok: false, url: "", error: state.error };
        }
    }

    async function ensure(options = {}) {
        let info = availability();
        const wantsDownload = options.download === true && (!info.runtimePackagePresent || info.runtimeUpdateAvailable);
        const needsUpdate = info.runtimeUpdateAvailable === true;
        if ((!info.available && (info.canRepair || (wantsDownload && info.canDownload))) || (needsUpdate && info.canRepair)) {
            if (state.child) await stop("runtime-update");
            const repair = await repairRuntime({ download: wantsDownload });
            info = availability();
            if (!repair.ok && !info.available) {
                return {
                    ok: false,
                    needFullPackage: info.needFullPackage,
                    error: repair.error || info.reason,
                    missing: info.missing || [],
                    canRepair: info.canRepair,
                    canDownload: info.canDownload,
                    runtimePackagePresent: info.runtimePackagePresent,
                    runtimeVersion: info.runtimeVersion,
                    runtimeTargetVersion: info.runtimeTargetVersion,
                    runtimeUpdateAvailable: info.runtimeUpdateAvailable,
                    fullPackageUrl: info.fullPackageUrl,
                    runtimeState: info.runtimeState,
                };
            }
            if (!repair.ok && needsUpdate) state.error = repair.error || "Agent 运行时更新失败，继续使用旧版本";
        }
        if (!info.available) {
            return {
                ok: false,
                needFullPackage: info.needFullPackage,
                error: info.reason,
                missing: info.missing || [],
                canRepair: info.canRepair,
                canDownload: info.canDownload,
                runtimePackagePresent: info.runtimePackagePresent,
                fullPackageUrl: info.fullPackageUrl,
                runtimeState: info.runtimeState,
            };
        }
        if (ensurePromise) return ensurePromise;
        ensurePromise = (async () => {
            if (state.child) {
                const health = await probe();
                if (health?.ok) {
                    await wake();
                    return { ok: true, url: state.url, port: state.port, pid: state.child.pid || 0, reused: true };
                }
                state.stopping = true;
                try {
                    state.child.kill();
                } catch {
                    // ignore
                }
                await sleep(150);
                state.stopping = false;
                clearChild(state.child);
            }
            return spawnService();
        })().finally(() => {
            ensurePromise = null;
        });
        return ensurePromise;
    }

    async function stop(reason = "requested") {
        const child = state.child;
        if (!child) return { ok: true, stopped: false };
        state.stopping = true;
        try {
            if (state.url) {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 1200);
                    try {
                        await fetchFn(`${state.url}/api/assistant/shutdown`, {
                            method: "POST",
                            signal: controller.signal,
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ confirm: true }),
                        });
                    } finally {
                        clearTimeout(timer);
                    }
                } catch {
                    // 服务无响应时直接结束子进程。
                }
            }
            const exited = new Promise((resolve) => {
                const timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
                child.once("exit", () => {
                    clearTimeout(timer);
                    resolve(true);
                });
            });
            if (!(await exited)) {
                try {
                    child.kill();
                } catch {
                    // ignore
                }
                await sleep(200);
            }
            logger?.info?.(`Agent 服务已休眠（${reason}）`);
            return { ok: true, stopped: true };
        } finally {
            state.stopping = false;
            clearChild(child);
        }
    }

    function status() {
        const info = availability();
        const appVersion = readVersion(path.join(config.appRoot, "VERSION"));
        return {
            ok: true,
            available: info.available,
            needFullPackage: info.needFullPackage,
            canRepair: info.canRepair === true,
            canDownload: info.canDownload === true,
            runtimePackagePresent: info.runtimePackagePresent === true,
            runtimeVersion: info.runtimeVersion || "",
            runtimeTargetVersion: info.runtimeTargetVersion || "",
            runtimeUpdateAvailable: info.runtimeUpdateAvailable === true,
            fullPackageUrl: info.fullPackageUrl || "",
            runtimeState: info.runtimeState || "",
            reason: info.reason,
            missing: info.missing || [],
            running: Boolean(state.child),
            url: state.child ? state.url : "",
            port: state.child ? state.port : 0,
            pid: state.child?.pid || 0,
            startedAt: state.startedAt,
            lastError: state.error,
            idleMs,
            workspaceVersion:
                readVersion(path.join(paths.workspace, "VERSION")) ||
                readVersion(path.join(paths.workspace, "infinite-canvas", "VERSION")) ||
                appVersion,
            appVersion,
        };
    }

    async function statusWithHealth() {
        const base = status();
        if (!base.running) return { ...base, online: false, health: null };
        const health = await probe();
        return {
            ...base,
            online: Boolean(health?.ok),
            idleRemainingMs: health?.idleRemainingMs ?? null,
            active: health?.active ?? null,
            buildRunning: health?.buildRunning ?? false,
            recovery: health?.recovery || null,
            serviceVersion: health?.version || "",
            workspaceVersion:
                health?.workspaceVersion && health.workspaceVersion !== "unknown" ? health.workspaceVersion : base.workspaceVersion,
            health,
        };
    }

    return {
        ensure,
        stop,
        status: statusWithHealth,
        availability,
        paths,
        get url() {
            return state.url;
        },
        get running() {
            return Boolean(state.child);
        },
    };
}
