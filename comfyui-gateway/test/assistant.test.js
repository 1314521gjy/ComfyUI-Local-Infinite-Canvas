import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
    const result = await manager.ensure();
    assert.equal(result.ok, false);
    assert.equal(result.needFullPackage, true);
    const status = await manager.status();
    assert.equal(status.running, false);
    fs.rmSync(root, { recursive: true, force: true });
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
