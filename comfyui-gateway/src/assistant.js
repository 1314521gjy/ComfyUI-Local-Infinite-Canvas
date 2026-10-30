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
    const paths = {
        root: assistantDir,
        server: path.join(assistantDir, "server.mjs"),
        workspace: path.join(assistantDir, "workspace"),
        workspaceWeb: path.join(assistantDir, "workspace", "infinite-canvas", "web"),
        workspaceWebModules: path.join(assistantDir, "workspace", "infinite-canvas", "web", "node_modules"),
        serviceModules: path.join(assistantDir, "node_modules", "@mariozechner", "pi-agent-core"),
        serviceAiModules: path.join(assistantDir, "node_modules", "@mariozechner", "pi-ai"),
        data: path.join(assistantDir, "data"),
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
        if (process.env.ASSISTANT_ENABLED === "0") {
            return { available: false, needFullPackage: false, reason: "Agent 已被环境变量关闭" };
        }
        const missing = [];
        if (!hasFile(paths.server)) missing.push("assistant/server.mjs");
        if (!hasDir(paths.serviceModules) || !hasDir(paths.serviceAiModules)) missing.push("assistant/node_modules");
        if (!hasFile(path.join(paths.workspaceWeb, "package.json"))) missing.push("assistant/workspace");
        if (!hasDir(paths.workspaceWebModules)) missing.push("assistant/workspace/infinite-canvas/web/node_modules");
        if (!hasFile(path.join(config.canvasDist, "index.html"))) missing.push("infinite-canvas/web/dist");
        if (!missing.length) return { available: true, needFullPackage: false, reason: "" };
        const fullPackageItems = new Set(["assistant/node_modules", "assistant/workspace", "assistant/workspace/infinite-canvas/web/node_modules"]);
        return {
            available: false,
            needFullPackage: missing.some((item) => fullPackageItems.has(item)),
            reason: `缺少 ${missing.join("、")}`,
            missing,
        };
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

    async function ensure() {
        const info = availability();
        if (!info.available) {
            return { ok: false, needFullPackage: info.needFullPackage, error: info.reason, missing: info.missing || [] };
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
        return {
            ok: true,
            available: info.available,
            needFullPackage: info.needFullPackage,
            reason: info.reason,
            missing: info.missing || [],
            running: Boolean(state.child),
            url: state.child ? state.url : "",
            port: state.child ? state.port : 0,
            pid: state.child?.pid || 0,
            startedAt: state.startedAt,
            lastError: state.error,
            idleMs,
            workspaceVersion: readVersion(path.join(paths.workspace, "VERSION")) || readVersion(path.join(paths.workspace, "infinite-canvas", "VERSION")),
            appVersion: readVersion(path.join(config.appRoot, "VERSION")),
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
            workspaceVersion: health?.workspaceVersion || base.workspaceVersion,
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
