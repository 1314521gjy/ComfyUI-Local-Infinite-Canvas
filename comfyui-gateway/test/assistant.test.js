import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createAssistantManager } from "../src/assistant.js";

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "assistant-manager-"));
}

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
}

function buildAppRoot({ fakeServer = true, exitAfterMs = 0 } = {}) {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-agent-core"), { recursive: true });
    fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
    write(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "package.json"), "{}");
    write(path.join(root, "infinite-canvas", "web", "dist", "index.html"), "<html></html>");
    write(path.join(root, "VERSION"), "v0.23.1\n");
    if (fakeServer) {
        write(
            path.join(root, "assistant", "server.mjs"),
            `
import http from "node:http";
const port = Number(process.env.ASSISTANT_PORT);
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "0.3.1", idleRemainingMs: 1000, active: 0, recovery: { state: "done" } }));
    return;
  }
  if (req.method === "POST" && (url.pathname === "/api/assistant/wake" || url.pathname === "/api/assistant/shutdown")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    if (url.pathname === "/api/assistant/shutdown") setTimeout(() => process.exit(0), 20);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
${exitAfterMs ? `setTimeout(() => process.exit(0), ${exitAfterMs});` : ""}
`,
        );
    }
    return root;
}

function configFor(root) {
    return {
        appRoot: root,
        canvasDist: path.join(root, "infinite-canvas", "web", "dist"),
        port: 8190,
        comfyUrl: "http://127.0.0.1:8188",
    };
}

test("assistant manager gates on missing full package", async () => {
    const root = tempRoot();
    const manager = createAssistantManager({ config: configFor(root), logger: null });
    const availability = manager.availability();
    assert.equal(availability.available, false);
    assert.equal(availability.needFullPackage, true);
    assert.equal(availability.runtimePackagePresent, false);
    assert.equal(availability.canDownload, false);
    assert.equal(availability.runtimeState, "package-missing");
    const result = await manager.ensure();
    assert.equal(result.ok, false);
    assert.equal(result.needFullPackage, true);
    assert.equal(result.canDownload, false);
    const status = await manager.status();
    assert.equal(status.running, false);
    assert.equal(status.runtimeState, "package-missing");
    fs.rmSync(root, { recursive: true, force: true });
});

test("assistant manager reports an available runtime update from the local version", async () => {
    const root = buildAppRoot();
    write(path.join(root, "assistant", "workspace", "VERSION"), "v0.23.1\n");
    write(path.join(root, "assistant", "runtime.zip"), "zip");
    write(path.join(root, "update.json"), JSON.stringify({ assistantRuntime: { url: "http://127.0.0.1/runtime.zip", sha256: "a".repeat(64), runtimeVersion: "v0.24.10" } }));
    const config = { ...configFor(root), launcherControlUrl: "http://127.0.0.1:9999" };
    const manager = createAssistantManager({ config, logger: null });
    const status = await manager.status();
    assert.equal(status.runtimeVersion, "v0.23.1");
    assert.equal(status.runtimeTargetVersion, "v0.24.10");
    assert.equal(status.runtimeUpdateAvailable, true);
    assert.equal(status.canDownload, true);
    fs.rmSync(root, { recursive: true, force: true });
});

test("assistant manager repairs a present runtime package through the launcher", async () => {
    const root = buildAppRoot();
    fs.rmSync(path.join(root, "assistant", "workspace"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "assistant", "node_modules"), { recursive: true, force: true });
    write(path.join(root, "assistant", "runtime.zip"), "zip");
    let repaired = false;
    const launcher = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/ensure-assistant") {
            fs.mkdirSync(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "node_modules"), { recursive: true });
            fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-agent-core"), { recursive: true });
            fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
            write(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "package.json"), "{}");
            repaired = true;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, extracted: true }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise((resolve) => launcher.listen(0, "127.0.0.1", resolve));
    const config = { ...configFor(root), launcherControlUrl: `http://127.0.0.1:${launcher.address().port}` };
    const manager = createAssistantManager({ config, logger: null });
    try {
        const before = manager.availability();
        assert.equal(before.available, false);
        assert.equal(before.canRepair, true);
        assert.equal(before.runtimePackagePresent, true);

        const started = await manager.ensure();
        assert.equal(repaired, true);
        assert.equal(started.ok, true);
        assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        const status = await manager.status();
        assert.equal(status.available, true);
        assert.equal(status.online, true);
        assert.equal(status.workspaceVersion, "v0.23.1");
    } finally {
        await manager.stop("cleanup");
        await new Promise((resolve) => launcher.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("assistant manager downloads the runtime only on explicit request", async () => {
    const root = buildAppRoot();
    fs.rmSync(path.join(root, "assistant", "workspace"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "assistant", "node_modules"), { recursive: true, force: true });
    write(
        path.join(root, "update.json"),
        JSON.stringify({
            assistantRuntime: {
                url: "http://mirror.test/assistant-runtime.zip",
                sha256: "a".repeat(64),
                size: 123,
                fullPackageUrl: "https://pan.quark.cn/s/example",
            },
        }),
    );
    const bodies = [];
    const launcher = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
        });
        req.on("end", () => {
            bodies.push(raw);
            if (req.method === "POST" && req.url === "/ensure-assistant") {
                fs.mkdirSync(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "node_modules"), { recursive: true });
                fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-agent-core"), { recursive: true });
                fs.mkdirSync(path.join(root, "assistant", "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
                write(path.join(root, "assistant", "workspace", "infinite-canvas", "web", "package.json"), "{}");
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, extracted: true, runtimePackagePresent: false }));
                return;
            }
            res.writeHead(404);
            res.end("{}");
        });
    });
    await new Promise((resolve) => launcher.listen(0, "127.0.0.1", resolve));
    const config = { ...configFor(root), launcherControlUrl: `http://127.0.0.1:${launcher.address().port}` };
    const manager = createAssistantManager({ config, logger: null });
    try {
        const before = manager.availability();
        assert.equal(before.canRepair, false);
        assert.equal(before.canDownload, true);
        assert.equal(before.runtimePackagePresent, false);
        assert.equal(before.fullPackageUrl, "https://pan.quark.cn/s/example");

        const automatic = await manager.ensure();
        assert.equal(automatic.ok, false);
        assert.equal(automatic.canDownload, true);
        assert.equal(bodies.length, 0, "automatic ensure must not download the runtime");

        const downloaded = await manager.ensure({ download: true });
        assert.equal(downloaded.ok, true);
        assert.equal(bodies.length, 1);
        assert.equal(JSON.parse(bodies[0]).download, true);
        const status = await manager.status();
        assert.equal(status.available, true);
        assert.equal(status.runtimeState, "ready-without-package");
        assert.equal(status.workspaceVersion, "v0.23.1");
    } finally {
        await manager.stop("cleanup");
        await new Promise((resolve) => launcher.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("assistant manager starts on demand, reuses and stops", async () => {
    const root = buildAppRoot();
    const manager = createAssistantManager({ config: configFor(root), logger: null });
    try {
        const status = await manager.status();
        assert.equal(status.available, true);
        assert.equal(status.running, false);
        assert.equal(status.online, false);

        const first = await manager.ensure();
        assert.equal(first.ok, true);
        assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);

        const second = await manager.ensure();
        assert.equal(second.ok, true);
        assert.equal(second.reused, true);
        assert.equal(second.url, first.url);

        const online = await manager.status();
        assert.equal(online.running, true);
        assert.equal(online.online, true);
        assert.equal(online.serviceVersion, "0.3.1");

        const stopped = await manager.stop("test");
        assert.equal(stopped.stopped, true);
        const after = await manager.status();
        assert.equal(after.running, false);
    } finally {
        await manager.stop("cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("assistant manager clears state when service exits by itself", async () => {
    const root = buildAppRoot({ exitAfterMs: 350 });
    const manager = createAssistantManager({ config: configFor(root), logger: null });
    try {
        const started = await manager.ensure();
        assert.equal(started.ok, true);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const status = await manager.status();
        assert.equal(status.running, false);
    } finally {
        await manager.stop("cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("healthy runtime update downloads, restarts and reports the new version", async () => {
    const root = buildAppRoot();
    write(path.join(root, "assistant", "workspace", "VERSION"), "v0.23.1\n");
    write(path.join(root, "assistant", "runtime.zip"), "zip");
    const calls = [];
    const launcher = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            calls.push(body);
            write(path.join(root, "assistant", "workspace", "VERSION"), "v0.24.10\n");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, extracted: true }));
        });
    });
    await new Promise((resolve) => launcher.listen(0, "127.0.0.1", resolve));
    const config = { ...configFor(root), launcherControlUrl: `http://127.0.0.1:${launcher.address().port}` };
    const manager = createAssistantManager({ config, logger: null, readyTimeoutMs: 3000 });
    try {
        assert.equal((await manager.ensure()).ok, true);
        write(path.join(root, "update.json"), JSON.stringify({ assistantRuntime: { url: "http://mirror/runtime.zip", sha256: "a".repeat(64), runtimeVersion: "v0.24.10" } }));
        const passive = await manager.ensure();
        assert.equal(passive.reused, true);
        assert.equal(calls.length, 0);
        const updated = await manager.ensure({ download: true });
        assert.equal(updated.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].download, true);
        assert.equal(calls[0].mirrorUrl, "http://mirror/runtime.zip");
        assert.equal(calls[0].mirrorSha256, "a".repeat(64));
        const status = await manager.status();
        assert.equal(status.runtimeVersion, "v0.24.10");
        assert.equal(status.runtimeUpdateAvailable, false);
    } finally {
        await manager.stop("cleanup");
        await new Promise((resolve) => launcher.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("failed runtime update keeps the old service and exposes a readable error", async () => {
    const root = buildAppRoot();
    write(path.join(root, "assistant", "workspace", "VERSION"), "v0.23.1\n");
    write(path.join(root, "assistant", "runtime.zip"), "zip");
    const launcher = http.createServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "模拟下载失败" }));
    });
    await new Promise((resolve) => launcher.listen(0, "127.0.0.1", resolve));
    const config = { ...configFor(root), launcherControlUrl: `http://127.0.0.1:${launcher.address().port}` };
    const manager = createAssistantManager({ config, logger: null, readyTimeoutMs: 3000 });
    try {
        assert.equal((await manager.ensure()).ok, true);
        write(path.join(root, "update.json"), JSON.stringify({ assistantRuntime: { url: "http://mirror/runtime.zip", sha256: "a".repeat(64), runtimeVersion: "v0.24.10" } }));
        const result = await manager.ensure({ download: true });
        assert.equal(result.ok, true);
        assert.match(result.updateError, /模拟下载失败/);
        const status = await manager.status();
        assert.equal(status.runtimeVersion, "v0.23.1");
        assert.match(status.runtimeUpdateError, /模拟下载失败/);
    } finally {
        await manager.stop("cleanup");
        await new Promise((resolve) => launcher.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("assistant manager reports spawn failure", async () => {
    const root = buildAppRoot({ fakeServer: false });
    write(path.join(root, "assistant", "server.mjs"), "process.exit(42);\n");
    const manager = createAssistantManager({ config: configFor(root), logger: null, readyTimeoutMs: 3000 });
    try {
        const result = await manager.ensure();
        assert.equal(result.ok, false);
        assert.ok(result.error);
        const status = await manager.status();
        assert.equal(status.running, false);
    } finally {
        await manager.stop("cleanup");
        fs.rmSync(root, { recursive: true, force: true });
    }
});
