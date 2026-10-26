import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { createResourceManager } from "../src/resources.js";

async function waitForJob(manager, id, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const job = manager.getJob(id);
        if (job && ["done", "error", "canceled"].includes(job.status)) return job;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("job timeout");
}

test("resources download falls back to the backup source and verifies sha256", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });

    const payload = crypto.randomBytes(64 * 1024);
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const server = http.createServer((req, res) => {
        if (req.url === "/bad") {
            res.statusCode = 500;
            res.end("nope");
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", payload.length);
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const index = {
        schema: 1,
        version: "test-1",
        packs: [{ id: "test", label: "Test", resources: ["test-file"] }],
        resources: [
            {
                id: "test-file",
                type: "model",
                label: "Test file",
                target: "vae/test.bin",
                size: payload.length,
                sha256: digest,
                sources: [
                    { url: `http://127.0.0.1:${port}/bad` },
                    { url: `http://127.0.0.1:${port}/good.bin` },
                ],
            },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");

    const manager = createResourceManager({
        config: {
            rootDir: root,
            dataDir: data,
            comfyDir: comfy,
            comfyWorkflowsDir: "",
            resourcesIndexUrl: "",
            resourcesFetchTimeoutMs: 1000,
            resourceConcurrency: 1,
        },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });

    try {
        await manager.init();
        const before = manager.status();
        assert.equal(before.summary.missing, 1);
        const job = manager.install({ ids: ["test-file"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        const target = path.join(comfy, "models", "vae", "test.bin");
        assert.deepEqual(await fsp.readFile(target), payload);
        const after = manager.status();
        assert.equal(after.summary.missing, 0);
        assert.equal(after.resources[0].status, "present");
        const lock = JSON.parse(await fsp.readFile(path.join(data, "resource-lock.json"), "utf8"));
        assert.equal(lock.installed["test-file"].sha256, digest);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});


test("resources can install a custom node zip", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-node-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "custom_nodes"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const source = path.join(root, "source");
    await fsp.mkdir(path.join(source, "ComfyUI-testnode"), { recursive: true });
    await fsp.writeFile(path.join(source, "ComfyUI-testnode", "__init__.py"), `NODE_CLASS_MAPPINGS = {}\n`, "utf8");
    const archive = path.join(root, "node.zip");
    const zipped = spawnSync("tar", ["-a", "-c", "-f", "node.zip", "-C", "source", "ComfyUI-testnode"], { cwd: root, encoding: "utf8" });
    assert.equal(zipped.status, 0, zipped.stderr);
    const payload = await fsp.readFile(archive);
    const server = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", payload.length);
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const index = {
        schema: 1,
        version: "test-node-1",
        packs: [{ id: "test", resources: ["test-node"] }],
        resources: [{ id: "test-node", type: "node", label: "Test node", target: "custom_nodes/ComfyUI-testnode", sources: [`http://127.0.0.1:${port}/node.zip`] }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        assert.equal(manager.status().summary.missing, 1);
        const job = manager.install({ ids: ["test-node"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.equal(fs.existsSync(path.join(comfy, "custom_nodes", "ComfyUI-testnode", "__init__.py")), true);
        assert.equal(manager.status().resources[0].status, "present");
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("8GB GPU recommends the int8 lite pack instead of bf16", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-recommend-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const requirements = (weightsGb, floorGb, recommendVramGb) => ({
        vramFloorGb: floorGb,
        weightsGb,
        ramBaseGb: 8,
        safety: 0.15,
        recommendVramGb,
    });
    const index = {
        schema: 1,
        version: "recommend-test",
        packs: [
            { id: "moss", family: "moss", tier: "balanced", resources: [], requirements: requirements(21, 8, 20) },
            { id: "moss-lite", family: "moss", tier: "lite", resources: [], requirements: requirements(14.5, 6, 6) },
        ],
        resources: [],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
        hardware: { gpuName: "Test 8GB", vramTotalMb: 8192, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
    });
    try {
        await manager.init();
        const status = manager.status();
        const bf16 = status.packs.find((pack) => pack.id === "moss");
        const lite = status.packs.find((pack) => pack.id === "moss-lite");
        assert.equal(bf16.eligible, true);
        assert.equal(bf16.recommended, false);
        assert.equal(lite.recommended, true);
        assert.equal(lite.offload, true);
        assert.equal(status.recommendationAvailable, true);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
