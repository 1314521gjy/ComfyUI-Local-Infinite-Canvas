import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { buildTrtCompileHint, createResourceManager, inferComfyRootFromFolderPaths, selectPipWheelForRuntime } from "../src/resources.js";

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


test("explicit user replacement overrides an automatic similarity match", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-similar-priority-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.writeFile(path.join(comfy, "models", "vae", "test-vae-int8.safetensors"), "x");
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-similar-1",
        packs: [{ id: "test", resources: ["test-vae"] }],
        resources: [{ id: "test-vae", type: "model", label: "Test VAE", target: "vae/test-vae.safetensors", size: 10 }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    let alias = "";
    const setup = {
        loaderOptions: () => ({}),
        status: () => ({ comfyReachable: true }),
        modelAliasFor: () => alias,
        userModelAliasFor: () => alias,
        setModelAliases: async (entries) => {
            alias = entries[0]?.to || "";
        },
        pickModelFile: async () => ({ file: "local-vae.safetensors" }),
        scan: async () => ({}),
    };
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup,
        logger: null,
    });
    try {
        await manager.init();
        assert.equal(manager.status().resources[0].matchedBy, "similar");
        await manager.setResourceReplacement("test-vae", "local-vae.safetensors");
        const item = manager.status().resources[0];
        assert.equal(item.status, "present");
        assert.equal(item.matchedBy, "alias");
        assert.equal(item.overridden, true);
        assert.equal(item.overriddenBy, "local-vae.safetensors");
        assert.equal(item.matchedFile, "local-vae.safetensors");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("user replacement still wins when the expected file is present", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-alias-exact-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.writeFile(path.join(comfy, "models", "vae", "test-vae.safetensors"), "0123456789");
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-alias-exact-1",
        packs: [{ id: "test", resources: ["test-vae"] }],
        resources: [{ id: "test-vae", type: "model", label: "Test VAE", target: "vae/test-vae.safetensors", size: 10 }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    let alias = "";
    const setup = {
        loaderOptions: () => ({}),
        status: () => ({ comfyReachable: true }),
        modelAliasFor: () => alias,
        userModelAliasFor: () => alias,
        setModelAliases: async (entries) => {
            alias = entries[0]?.to || "";
        },
        pickModelFile: async () => ({ file: "local-vae.safetensors" }),
        scan: async () => ({}),
    };
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup,
        logger: null,
    });
    try {
        await manager.init();
        assert.equal(manager.status().resources[0].matchedBy, "path");
        await manager.setResourceReplacement("test-vae", "local-vae.safetensors");
        const item = manager.status().resources[0];
        assert.equal(item.status, "present");
        assert.equal(item.matchedBy, "alias");
        assert.equal(item.overridden, true);
        assert.equal(item.overriddenBy, "local-vae.safetensors");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("resource replacement marks a missing model present and skips download", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-replace-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-replace-1",
        packs: [{ id: "test", resources: ["test-vae"] }],
        resources: [{ id: "test-vae", type: "model", label: "Test VAE", target: "vae/test-vae.safetensors" }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    let alias = "";
    const setup = {
        loaderOptions: () => ({}),
        status: () => ({ comfyReachable: true }),
        modelAliasFor: (classType, input, value) => (classType === "VAELoader" && value === "test-vae.safetensors" ? alias : ""),
        userModelAliasFor: (classType, input, value) => (classType === "VAELoader" && value === "test-vae.safetensors" ? alias : ""),
        setModelAliases: async (entries) => {
            alias = entries[0]?.to || "";
        },
        pickModelFile: async () => ({ file: "local-vae.safetensors" }),
        scan: async () => ({}),
    };
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup,
        logger: null,
    });
    try {
        await manager.init();
        assert.equal(manager.status().resources[0].status, "missing");
        assert.equal(await manager.pickResourceReplacement("test-vae"), "local-vae.safetensors");
        await manager.setResourceReplacement("test-vae", "local-vae.safetensors");
        const item = manager.status().resources[0];
        assert.equal(item.status, "present");
        assert.equal(item.overridden, true);
        assert.equal(item.overriddenBy, "local-vae.safetensors");
        const job = manager.install({ ids: ["test-vae"] });
        assert.equal(job.status, "done");
        assert.equal(job.items.length, 0);
    } finally {
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

test("directory models install from a zip into the LLM model root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-dir-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "LLM"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const source = path.join(root, "source");
    await fsp.mkdir(path.join(source, "Florence-test"), { recursive: true });
    await fsp.writeFile(path.join(source, "Florence-test", "config.json"), '{}\n', "utf8");
    await fsp.writeFile(path.join(source, "Florence-test", "model.safetensors"), "weights", "utf8");
    const zipped = spawnSync("tar", ["-a", "-c", "-f", "model.zip", "-C", "source", "Florence-test"], { cwd: root, encoding: "utf8" });
    assert.equal(zipped.status, 0, zipped.stderr);
    const payload = await fsp.readFile(path.join(root, "model.zip"));
    const server = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", payload.length);
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const index = {
        schema: 1,
        version: "test-dir-1",
        packs: [{ id: "test", resources: ["test-dir"] }],
        resources: [{ id: "test-dir", type: "dir", label: "Test dir model", target: "LLM/Florence-test", size: payload.length, sources: [`http://127.0.0.1:${port}/model.zip`] }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        assert.equal(manager.status().resources[0].status, "missing");
        const job = manager.install({ ids: ["test-dir"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.equal(fs.existsSync(path.join(comfy, "models", "LLM", "Florence-test", "config.json")), true);
        assert.equal(manager.status().resources[0].status, "present");
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("pip resources report missing when the ComfyUI Python cannot import the module", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-pip-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(comfy, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-pip-1",
        packs: [{ id: "test", resources: ["test-pip"] }],
        resources: [{ id: "test-pip", type: "pip", label: "Test runtime", target: "LLM/test-runtime", module: "definitely_missing_module", wheels: { "3.12": "https://example.test/w.whl" } }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const item = manager.status().resources[0];
        assert.equal(item.status, "missing");
        assert.match(item.pipReason, /Python|definitely_missing_module/);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("prompt capabilities explain missing local reverse dependencies", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-prompt-caps-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(comfy, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-caps-1",
        packs: [],
        resources: [
            { id: "prompt_qwen_gguf", type: "model", target: "LLM/qwen.gguf" },
            { id: "prompt_qwen_mmproj", type: "model", target: "LLM/mmproj.gguf" },
            { id: "prompt_llama_node", type: "node", target: "custom_nodes/llama" },
            { id: "prompt_te_man", type: "node", target: "custom_nodes/TE_MAN" },
            { id: "prompt_llama_python", type: "pip", target: "LLM/runtime", module: "definitely_missing_module" },
            { id: "prompt_florence_node", type: "node", target: "custom_nodes/florence" },
            { id: "prompt_florence_model", type: "dir", target: "LLM/florence" },
            { id: "qwen3.5_9b_int8_convrot", type: "model", target: "text_encoders/te.safetensors" },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), hasNodeClass: () => false, scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const caps = manager.status().promptCapabilities;
        assert.equal(caps.comfyReachable, true);
        assert.equal(caps.engines.qwen.available, false);
        assert.ok(caps.engines.qwen.missingResources.some((item) => item.id === "prompt_qwen_gguf"));
        assert.ok(caps.engines.qwen.missingNodes.includes("llama_cpp_model_loader"));
        assert.equal(caps.engines.florence.available, false);
        assert.equal(caps.engines.teMan.available, false);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("node resources can install from a bundled directory without extracting", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-node-dir-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "custom_nodes"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(path.join(resources, "nodes", "testnode"), { recursive: true });
    await fsp.writeFile(path.join(resources, "nodes", "testnode", "__init__.py"), "BUNDLED = True\n", "utf8");
    const index = {
        schema: 1,
        version: "test-node-dir-1",
        packs: [{ id: "test", resources: ["test-node"] }],
        resources: [{
            id: "test-node",
            type: "node",
            label: "Test node",
            target: "custom_nodes/TestNode",
            bundleDir: "resources/nodes/testnode",
            sources: [],
        }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const job = manager.install({ ids: ["test-node"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.equal(await fsp.readFile(path.join(comfy, "custom_nodes", "TestNode", "__init__.py"), "utf8"), "BUNDLED = True\n");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("node backup sources can opt out of the primary zip hash", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-node-backup-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "custom_nodes"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const buildZip = async (name, content) => {
        const source = path.join(root, name);
        await fsp.mkdir(path.join(source, "ComfyUI-testnode"), { recursive: true });
        await fsp.writeFile(path.join(source, "ComfyUI-testnode", "__init__.py"), content, "utf8");
        const archive = path.join(root, `${name}.zip`);
        const zipped = spawnSync("tar", ["-a", "-c", "-f", `${name}.zip`, "-C", name, "ComfyUI-testnode"], { cwd: root, encoding: "utf8" });
        assert.equal(zipped.status, 0, zipped.stderr);
        return fsp.readFile(archive);
    };
    const primary = await buildZip("primary", "PRIMARY = True\n");
    const backup = await buildZip("backup", "BACKUP = True\n");
    assert.notEqual(
        crypto.createHash("sha256").update(primary).digest("hex"),
        crypto.createHash("sha256").update(backup).digest("hex"),
    );
    const server = http.createServer((req, res) => {
        if (req.url === "/missing.zip") {
            res.statusCode = 500;
            res.end("no");
            return;
        }
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", backup.length);
        res.end(backup);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const index = {
        schema: 1,
        version: "test-node-backup-1",
        packs: [{ id: "test", resources: ["test-node"] }],
        resources: [{
            id: "test-node",
            type: "node",
            label: "Test node",
            target: "custom_nodes/ComfyUI-testnode",
            size: primary.length,
            sha256: crypto.createHash("sha256").update(primary).digest("hex"),
            sources: [
                `http://127.0.0.1:${port}/missing.zip`,
                { url: `http://127.0.0.1:${port}/node.zip`, label: "backup", verify: false },
            ],
        }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const job = manager.install({ ids: ["test-node"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.equal(await fsp.readFile(path.join(comfy, "custom_nodes", "ComfyUI-testnode", "__init__.py"), "utf8"), "BACKUP = True\n");
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

test("a merged pack recommends bf16 on large cards and int8 on small cards", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-variant-test-"));
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
        version: "variant-test",
        packs: [{
            id: "moss",
            family: "moss",
            tier: "balanced",
            resources: ["bf16", "int8", "te", "vae", "lora", "balanced"],
            optionalResources: ["balanced"],
            requirements: requirements(21, 8, 20),
            variants: [
                { id: "bf16", tier: "balanced", workflows: ["w-bf16"], requirements: requirements(21, 8, 20) },
                { id: "int8", tier: "lite", workflows: ["w-int8"], requirements: requirements(15.5, 6, 6) },
            ],
            workflowDependencies: {
                "w-bf16": ["bf16", "te", "vae", "lora"],
                "w-int8": ["int8", "te", "vae", "lora"],
            },
        }],
        resources: [
            { id: "bf16", type: "model", label: "BF16", target: "diffusion_models/bf16.safetensors", size: 10, sources: ["http://127.0.0.1:1/file"] },
            { id: "int8", type: "model", label: "INT8", target: "diffusion_models/int8.safetensors", size: 10, sources: ["http://127.0.0.1:1/file"] },
            { id: "te", type: "model", label: "TE", target: "text_encoders/te.safetensors", size: 10, sources: ["http://127.0.0.1:1/file"] },
            { id: "vae", type: "model", label: "VAE", target: "vae/vae.safetensors", size: 10, sources: ["http://127.0.0.1:1/file"] },
            { id: "lora", type: "model", label: "LoRA", target: "loras/lora.safetensors", size: 10, sources: ["http://127.0.0.1:1/file"] },
            { id: "balanced", type: "bake", label: "Balanced", target: "diffusion_models/balanced.safetensors", size: 10, requires: ["bf16", "int8"] },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const createManager = (vramTotalMb, ramGb) => createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
        workflowVisibility: { isHidden: (id) => id === "w-bf16" },
        hardware: { gpuName: `Test ${vramTotalMb}`, vramTotalMb, ramTotalBytes: ramGb * 1024 ** 3, ramFreeBytes: ramGb * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
    });
    try {
        const large = createManager(32768, 64);
        await large.init();
        const largePack = large.status().packs[0];
        assert.equal(largePack.recommended, true);
        assert.equal(largePack.recommendedVariant, "bf16");
        assert.deepEqual(largePack.requiredIds, ["bf16", "te", "vae", "lora"]);
        assert.equal(largePack.workflowDependencies.find((item) => item.id === "w-bf16").recommended, true);
        assert.equal(largePack.workflowDependencies.find((item) => item.id === "w-int8").recommended, false);
        assert.equal(largePack.workflowDependencies.find((item) => item.id === "w-bf16").enabled, false);
        assert.equal(largePack.workflowDependencies.find((item) => item.id === "w-int8").enabled, true);

        const small = createManager(8192, 64);
        await small.init();
        const smallStatus = small.status();
        const smallPack = smallStatus.packs[0];
        assert.equal(smallPack.recommended, true);
        assert.equal(smallPack.recommendedVariant, "int8");
        assert.deepEqual(smallPack.requiredIds, ["int8", "te", "vae", "lora"]);
        assert.equal(smallPack.variants.find((item) => item.id === "int8").recommended, true);
        assert.equal(smallPack.workflowDependencies.find((item) => item.id === "w-int8").recommended, true);
        assert.equal(smallStatus.summary.recommendedResources, 4);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("zimage pack keeps one default base and exposes int8 as an optional base model", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "zimage");
    assert.ok(pack, "zimage pack is missing");
    assert.equal(pack.autoRecommend, false);
    assert.equal(pack.optional, true);
    assert.equal(pack.variants, undefined);
    assert.deepEqual(pack.workflowDependencies, {
        "image-z-image-turbo": ["z_image_turbo_bf16", "qwen_3_4b", "ae"],
    });
    assert.deepEqual(pack.workflows, ["image-z-image-turbo"]);
    assert.deepEqual(pack.resources, [
        "z_image_turbo_bf16",
        "qwen_3_4b",
        "ae",
        "z_image_turbo_int8_convrot",
    ]);
    assert.deepEqual(pack.optionalResources, pack.resources);
    assert.ok(!pack.workflowDependencies["image-z-image-turbo"].includes("z_image_turbo_int8_convrot"));
    assert.equal(index.resources.some((item) => item.id === "z_image_turbo_distill_lora"), false);
});

test("krea2 pack matches the zimage shape with no bundled LoRAs", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "krea2");
    assert.ok(pack, "krea2 pack is missing");
    assert.equal(pack.autoRecommend, false);
    assert.equal(pack.optional, true);
    assert.equal(pack.variants, undefined);
    assert.deepEqual(pack.workflowDependencies, {
        "image-krea2-turbo": ["krea2_turbo_fp8_scaled", "qwen3vl_4b_fp8_scaled", "qwen_image_vae"],
    });
    assert.deepEqual(pack.workflows, ["image-krea2-turbo"]);
    assert.deepEqual(pack.resources, [
        "krea2_turbo_fp8_scaled",
        "qwen3vl_4b_fp8_scaled",
        "qwen_image_vae",
        "krea2_turbo_int8_convrot",
    ]);
    assert.deepEqual(pack.optionalResources, pack.resources);
    assert.ok(!pack.workflowDependencies["image-krea2-turbo"].includes("krea2_turbo_int8_convrot"));
    assert.equal(index.resources.some((item) => item.id === "krea2_darkbrush_lora"), false);
    assert.equal(index.resources.some((item) => item.id === "krea2_retroanime_lora"), false);
    assert.equal(index.resources.length, 70);
});

test("moss pack no longer ships Balanced workflows or the local bake resource", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "moss");
    assert.ok(pack, "moss pack is missing");
    assert.equal(pack.workflows.includes("image-moss-balanced-8step"), false);
    assert.equal(pack.workflows.includes("image-moss-balanced-50step"), false);
    assert.equal(pack.workflowDependencies["image-moss-balanced-8step"], undefined);
    assert.equal(index.resources.some((item) => item.id === "moss_balanced_s100"), false);
    assert.equal(index.resources.some((item) => item.id === "moss_image_base_bf16"), false);
});

test("compiled bake outputs do not report a same-name size mismatch", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-bake-size-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "diffusion_models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(comfy, "models", "diffusion_models", "engine.safetensors"), "12345");
    const index = {
        schema: 1,
        version: "bake-size-test",
        packs: [{ id: "test", resources: ["engine"] }],
        resources: [{ id: "engine", type: "bake", label: "Engine", target: "diffusion_models/engine.safetensors", size: 999 }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const item = manager.status().resources[0];
        assert.equal(item.status, "present");
        assert.equal(item.sizeMismatch, "");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("upscale pack ships the node with the app and downloads ESRGAN/SeedVR2 weights per workflow", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "upscale");
    assert.ok(pack, "upscale pack is missing");
    assert.equal(pack.optional, true);
    assert.deepEqual(pack.workflows, [
        "image-esrgan-upscale",
        "video-esrgan_2x",
        "image-seedvr2-upscale",
        "video-seedvr2-upscale",
    ]);
    assert.deepEqual(pack.workflowDependencies["image-esrgan-upscale"], ["esrgan_x2plus"]);
    assert.deepEqual(pack.workflowDependencies["image-esrgan-upscale"], pack.workflowDependencies["video-esrgan_2x"]);
    const runtimes = ["seedvr2_dep_diffusers", "seedvr2_dep_rotary", "seedvr2_dep_omegaconf", "seedvr2_dep_opencv", "seedvr2_dep_einops"];
    assert.deepEqual(pack.workflowDependencies["image-seedvr2-upscale"], ["seedvr2_7b_dit", "seedvr2_vae", ...runtimes]);
    assert.deepEqual(pack.workflowDependencies["video-seedvr2-upscale"], ["seedvr2_3b_dit", "seedvr2_vae", ...runtimes]);
    const optional = new Set(pack.optionalResources || []);
    for (const id of pack.resources) {
        assert.ok(optional.has(id), `${id} must stay optional so weight downloads remain user-driven`);
    }
    const node = index.resources.find((item) => item.id === "seedvr2_node");
    assert.equal(node.type, "node");
    assert.equal(node.autoInstall, true);
    assert.ok(node.bundleDir, "seedvr2 node must ship a bundled directory");
    for (const id of runtimes) {
        const runtime = index.resources.find((item) => item.id === id);
        assert.equal(runtime.type, "pip", `${id} type`);
        assert.ok(runtime.module && runtime.pipName, `${id} must declare module and pipName`);
        assert.equal(runtime.restartAfterInstall, true, `${id} needs a ComfyUI restart`);
        const wheel = runtime.wheelMatrix?.[0];
        assert.ok(wheel?.url?.startsWith("https://mirrors.aliyun.com/pypi/"), `${id} wheel url`);
        assert.ok(wheel.size > 0 && /^[0-9a-f]{64}$/.test(wheel.sha256), `${id} wheel size/sha256`);
    }
    for (const id of ["seedvr2_3b_dit", "seedvr2_7b_dit"]) {
        const resource = index.resources.find((item) => item.id === id);
        assert.match(resource.target, /^SEEDVR2\//);
        assert.ok(resource.sha256);
    }
    const vae = index.resources.find((item) => item.id === "seedvr2_vae");
    assert.equal(vae.target, "vae/ema_vae_fp16.safetensors");
    for (const id of ["esrgan_x2plus", "esrgan_x4plus", "esrgan_anime6b"]) {
        const resource = index.resources.find((item) => item.id === id);
        assert.equal(resource.target.startsWith("upscale_models/"), true, `${id} target`);
        assert.ok(resource.sha256);
    }
});

test("h3 pack lists the shared models, VDN/noVDN variants and character swap", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "h3");
    assert.ok(pack, "h3 pack is missing");
    assert.equal(pack.planned, false);
    assert.equal(pack.optional, true);
    assert.equal(pack.autoRecommend, false);
    assert.deepEqual(pack.workflows, [
        "video-h3-ref2va",
        "video-h3-t2v",
        "video-h3-frames",
        "video-h3-ref2va-novdn",
        "video-h3-t2v-novdn",
        "video-h3-frames-novdn",
        "video-h3-character-swap",
    ]);
    const byId = new Map(index.resources.map((item) => [item.id, item]));
    const optional = new Set(pack.optionalResources || []);
    const required = pack.resources.filter((id) => !optional.has(id));
    assert.deepEqual(required, ["sage_h3"], "h3 only requires the SageAttention runtime at pack level");
    for (const id of ["h3_unet_singularity_ref2va_v13_int8", "h3_te_qwen3vl_32b_int8_convrot", "h3_audio_vae_fp32", "h3_vae_onnx_decoder", "h3_trt_vae_decoder_engine", "h3_trt_vae_encoder_engine"]) {
        assert.ok(pack.resources.includes(id), `h3 missing ${id}`);
    }
    for (const id of pack.resources) {
        assert.notEqual(byId.get(id)?.type, "node", `${id} is a node and must ship with the app, not download`);
    }
    assert.ok(pack.workflowDependencies["video-h3-ref2va"].includes("h3_vae_onnx_decoder"));
    assert.ok(pack.workflowDependencies["video-h3-ref2va"].includes("h3_vdn_stage_model"));
    assert.ok(pack.workflowDependencies["video-h3-ref2va"].includes("h3_trt_vae_decoder_engine"));
    assert.ok(pack.workflowDependencies["video-h3-ref2va-novdn"].includes("h3_lightx2v_8step_lora"));
    assert.ok(pack.workflowDependencies["video-h3-character-swap"].includes("h3_character_swap_lora"));
    const decoderEngine = index.resources.find((item) => item.id === "h3_trt_vae_decoder_engine");
    assert.equal(decoderEngine.type, "bake");
    assert.equal(decoderEngine.builder.kind, "h3-trt-vae");
    assert.deepEqual(decoderEngine.requires, ["h3_vae_onnx_decoder", "h3_vae_onnx_decoder_data"]);
    const ids = new Set(index.resources.map((item) => item.id));
    assert.equal(ids.size, index.resources.length, "duplicate resource ids");
});

test("a selected pack main model activates the workflow and replaces the default model resource", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-main-model-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "main-model-test",
        packs: [{ id: "test-pack", label: "Test", resources: ["default-model"], workflows: ["image-test"] }],
        resources: [
            {
                id: "default-model",
                type: "model",
                label: "Default model",
                target: "diffusion_models/default.safetensors",
                size: 128,
                sources: ["https://example.com/default.safetensors"],
            },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: {
            loaderOptions: () => ({ UNETLoader: ["my_finetune.safetensors"] }),
            status: () => ({ comfyReachable: true }),
            scan: async () => ({}),
            workflowStatus: () => ({ available: true, problems: [] }),
        },
        registry: {
            resolve: (id) =>
                id === "image-test"
                    ? { id, name: id, workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } } } }
                    : null,
        },
        mainModels: {
            fileForPack: () => "my_finetune.safetensors",
            set: async () => {},
        },
        hardware: { gpuName: "Test", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
        logger: null,
    });
    try {
        await manager.init();
        const status = manager.status();
        const pack = status.packs[0];
        assert.equal(pack.mainModel.selected, "my_finetune.safetensors");
        assert.equal(pack.mainModel.selectedInstalled, true);
        assert.equal(pack.mainModel.available, true);
        assert.equal(pack.mainModel.options.some((option) => option.file === "my_finetune.safetensors" && option.source === "local"), true);
        assert.equal(pack.resources[0].status, "present");
        assert.equal(pack.resources[0].overridden, true);
        assert.equal(pack.missing, 0);
        assert.equal(status.summary.missing, 0);
        await assert.rejects(() => manager.setMainModel("test-pack", "missing.safetensors"), /尚未安装/);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("optional alternate model packs can stay eligible without being auto-recommended", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-auto-recommend-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const requirements = {
        vramFloorGb: 8,
        weightsGb: 18,
        ramBaseGb: 8,
        safety: 0.15,
        recommendVramGb: 16,
    };
    const index = {
        schema: 1,
        version: "auto-recommend-test",
        packs: [
            { id: "primary", family: "image", tier: "balanced", resources: [], requirements },
            { id: "alternate", family: "alternate", tier: "standard", optional: true, autoRecommend: false, resources: [], requirements },
        ],
        resources: [],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
        hardware: { gpuName: "Test 32GB", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
    });
    try {
        await manager.init();
        const status = manager.status();
        const primary = status.packs.find((pack) => pack.id === "primary");
        const alternate = status.packs.find((pack) => pack.id === "alternate");
        assert.equal(primary.recommended, true);
        assert.equal(alternate.eligible, true);
        assert.equal(alternate.recommended, false);
        assert.equal(status.summary.recommendedPacks, 1);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("optional pack resources are listed separately and do not block required readiness", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-optional-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "optional-test",
        packs: [{
            id: "test",
            family: "test",
            tier: "standard",
            resources: ["required-file", "optional-file"],
            optionalResources: ["optional-file"],
            requirements: { vramFloorGb: 8, weightsGb: 10, ramBaseGb: 8, safety: 0.15, recommendVramGb: 8 },
        }],
        resources: [
            { id: "required-file", type: "model", label: "Required", target: "vae/required.bin", size: 100, sources: ["http://127.0.0.1:1/required.bin"] },
            { id: "optional-file", type: "model", label: "Optional", target: "vae/optional.bin", size: 200, sources: ["http://127.0.0.1:1/optional.bin"] },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
        hardware: { gpuName: "Test 32GB", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
    });
    try {
        await manager.init();
        const status = manager.status();
        const pack = status.packs[0];
        assert.equal(pack.total, 1);
        assert.equal(pack.missing, 1);
        assert.equal(pack.missingSize, 100);
        assert.equal(pack.optionalTotal, 1);
        assert.equal(pack.optionalMissing, 1);
        assert.equal(pack.optionalSize, 200);
        assert.deepEqual(pack.requiredItems.map((item) => item.id), ["required-file"]);
        assert.deepEqual(pack.optionalItems.map((item) => item.id), ["optional-file"]);
        assert.equal(status.summary.recommendedResources, 1);
        assert.equal(status.summary.recommendedMissing, 1);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("workflow dependencies expand bake prerequisites and keep workflow labels", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-workflow-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "diffusion_models"), { recursive: true });
    await fsp.mkdir(path.join(comfy, "custom_nodes"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const model = (id, target, size = 10) => ({ id, type: "model", label: id, target, size, sources: ["http://127.0.0.1:1/file"] });
    const index = {
        schema: 1,
        version: "workflow-test",
        packs: [{
            id: "test",
            label: "Test",
            resources: ["base", "sft", "bake", "plugin"],
            optionalResources: ["base"],
            workflowDependencies: { "test-workflow": ["bake", "plugin"] },
            requirements: { vramFloorGb: 8, weightsGb: 10, ramBaseGb: 8, safety: 0.15, recommendVramGb: 8 },
        }],
        resources: [
            model("base", "diffusion_models/base.safetensors"),
            model("sft", "diffusion_models/sft.safetensors"),
            { ...model("bake", "diffusion_models/bake.safetensors"), type: "bake", requires: ["base", "sft"] },
            { id: "plugin", type: "node", label: "Plugin", target: "custom_nodes/TestNode", size: 5, sources: ["http://127.0.0.1:1/node.zip"] },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}), workflowStatus: () => ({ available: false, problems: [{ type: "node", message: "missing plugin" }] }) },
        registry: { resolve: (id) => ({ id, label: "Test workflow" }) },
        logger: null,
    });
    try {
        await manager.init();
        const pack = manager.status().packs[0];
        assert.equal(pack.workflowDependencies.length, 1);
        const workflow = pack.workflowDependencies[0];
        assert.equal(workflow.label, "Test workflow");
        assert.equal(workflow.available, false);
        assert.equal(workflow.missing, 2);
        assert.deepEqual([...workflow.installIds].sort(), ["bake", "base", "plugin", "sft"]);
        assert.equal(pack.optionalTotal, 1);
        assert.equal(pack.total, 3);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("qwen21 all-in-one pack declares both workflows and their full dependencies", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "qwen21");
    assert.ok(pack, "qwen21 pack is missing");
    assert.equal(index.packs.some((item) => item.id === "angle"), false);
    assert.deepEqual(pack.workflows, ["image-qwen21", "image-qwen21-angle"]);
    assert.deepEqual(pack.workflowDependencies["image-qwen21"], [
        "qwen_image_2.1_turbo_int8_convrot",
        "qwen3vl_8b_int8_convrot",
        "qwen_image_2.1_vae_bf16",
        "qwen21_outpaint_lora",
    ]);
    assert.deepEqual(pack.workflowDependencies["image-qwen21-angle"], [
        "qwen_image_2.1_turbo_int8_convrot",
        "qwen3vl_8b_int8_convrot",
        "qwen_image_2.1_vae_bf16",
    ]);
    const byId = new Map(index.resources.map((item) => [item.id, item]));
    const lora = byId.get("qwen21_outpaint_lora");
    assert.equal(lora.size, 159436576);
    assert.equal(lora.sha256, "3611a5ccae5f790405eeacf1dfb2c89285c1e4f2987b9abc88cd0161a60eca28");
    assert.equal(lora.sources.length, 3);
    assert.ok(lora.sources[1].includes("aifasthub.com"));
    assert.ok(byId.get("inpaint_cropandstitch").provides.includes("InpaintCropImproved"));
    assert.ok(byId.get("kjnodes").provides.includes("DrawMaskOnImage"));
});

test("statically hidden workflows are marked canvas-only in resource status", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-canvas-entry-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "canvas-entry-test",
        packs: [{
            id: "test",
            family: "test",
            tier: "standard",
            resources: [],
            workflowDependencies: { visible: [], hidden: [] },
            requirements: { vramFloorGb: 8, weightsGb: 10, ramBaseGb: 8, safety: 0.15, recommendVramGb: 12 },
        }],
        resources: [],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}), workflowStatus: () => ({ available: true, problems: [] }) },
        registry: { resolve: (id) => ({ id, label: id, hidden: id === "hidden", variantLabels: id === "visible" ? { t2i: "文生图" } : {} }) },
        logger: null,
    });
    try {
        await manager.init();
        const [visible, hidden] = manager.status().packs[0].workflowDependencies;
        assert.equal(visible.modelVisible, true);
        assert.deepEqual(visible.variantLabels, { t2i: "文生图" });
        assert.equal(hidden.modelVisible, false);
        assert.deepEqual(hidden.variantLabels, {});
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("a partial download from one mirror is discarded before trying another", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-cross-host-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });

    const payload = crypto.randomBytes(64 * 1024);
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const prefix = Buffer.alloc(8 * 1024, 0xaa);
    let rangeHeader = null;
    const server = http.createServer((req, res) => {
        if (req.url === "/bad") {
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
            res.write(prefix, () => res.socket?.destroy());
            return;
        }
        rangeHeader = req.headers.range || "";
        if (rangeHeader) {
            const start = Number(/bytes=(\d+)-/.exec(rangeHeader)?.[1] || 0);
            const body = payload.subarray(start);
            res.writeHead(206, {
                "Content-Type": "application/octet-stream",
                "Content-Length": body.length,
                "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
            });
            res.end(body);
            return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const index = {
        schema: 1,
        version: "cross-host-test",
        packs: [],
        resources: [
            {
                id: "cross-host-file",
                type: "model",
                label: "Cross host file",
                target: "vae/cross-host.bin",
                size: payload.length,
                sha256: digest,
                sources: [`http://127.0.0.1:${port}/bad`, `http://127.0.0.1:${port}/good`],
            },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const job = manager.install({ ids: ["cross-host-file"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.equal(rangeHeader, "");
        assert.deepEqual(await fsp.readFile(path.join(comfy, "models", "vae", "cross-host.bin")), payload);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("remote resource index falls back to the backup URL", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-index-backup-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(comfy, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const server = http.createServer((req, res) => {
        if (req.url === "/backup.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ schema: 1, version: "backup-test", packs: [], resources: [] }));
            return;
        }
        res.statusCode = 404;
        res.end("missing");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify({ schema: 1, version: "local-test", packs: [], resources: [] }), "utf8");
    const manager = createResourceManager({
        config: {
            rootDir: root,
            dataDir: data,
            comfyDir: comfy,
            comfyWorkflowsDir: "",
            resourcesIndexUrl: `http://127.0.0.1:${port}/missing.json`,
            resourcesIndexUrlBackup: `http://127.0.0.1:${port}/backup.json`,
            resourcesFetchTimeoutMs: 1000,
            resourceConcurrency: 1,
        },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        hardware: { gpuName: "Test", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
        logger: null,
    });
    try {
        await manager.init();
        await manager.refresh();
        const status = manager.status();
        assert.equal(status.indexVersion, "backup-test");
        assert.equal(status.indexSource, "remote-backup");
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("trt compile failure hint is copy-ready for the user's agent", () => {
    const hint = buildTrtCompileHint({
        python: "E:/ComfyUI/python_embeded/python.exe",
        compiler: "E:/ComfyUI/custom_nodes/ComfyUI-H3VAE_TRT/compile.py",
        input: "E:/ComfyUI/models/vae/minimax_h3_vae_decoder.onnx",
        output: "E:/ComfyUI/models/vae/minimax_h3_vae_decoder.engine",
        device: 0,
    });
    assert.match(hint, /tensorrt/);
    assert.match(hint, /AI Agent/);
    assert.match(hint, /compile\.py/);
    assert.match(hint, /--input/);
    assert.match(hint, /--output/);
    assert.match(hint, /--device 0/);

    const spaced = buildTrtCompileHint({
        python: "C:/Program Files/Python312/python.exe",
        compiler: "D:/My ComfyUI/custom_nodes/ComfyUI-H3VAE_TRT/compile.py",
        input: "D:/My ComfyUI/models/vae/a.onnx",
        output: "D:/My ComfyUI/models/vae/a.engine",
    });
    assert.ok(spaced.includes('"C:/Program Files/Python312/python.exe"'));
    assert.ok(spaced.includes('"D:/My ComfyUI/custom_nodes/ComfyUI-H3VAE_TRT/compile.py"'));
});

test("packs only declare downloadable weights; nodes ship with the app", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const byId = new Map(index.resources.map((item) => [item.id, item]));
    for (const pack of index.packs) {
        const optional = new Set(pack.optionalResources || []);
        for (const id of pack.resources || []) {
            const resource = byId.get(id);
            assert.notEqual(resource?.type, "node", `${pack.id} lists node ${id}`);
            if (!optional.has(id)) {
                assert.equal(resource?.type, "pip", `${pack.id} declares ${id} as required; only runtime pip resources may be required`);
            }
        }
        for (const [workflowId, ids] of Object.entries(pack.workflowDependencies || {})) {
            for (const id of ids) {
                assert.notEqual(byId.get(id)?.type, "node", `${workflowId} depends on node ${id}`);
            }
        }
    }
    for (const id of index.resources.filter((item) => item.type === "node").map((item) => item.id)) {
        assert.ok(index.resources.find((item) => item.id === id), `node ${id} must stay in the index for the launcher`);
    }
});

test("resources use ComfyUI folder paths for detection and install targets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-extrapath-test-"));
    const comfy = path.join(root, "ComfyUI");
    const extra = path.join(root, "models-extra");
    const extraVae = path.join(extra, "vae");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(extraVae, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(comfy, "main.py"), "", "utf8");
    await fsp.writeFile(path.join(extraVae, "already.safetensors"), "x", "utf8");

    const payload = crypto.randomBytes(1024);
    await fsp.writeFile(path.join(resources, "payload.bin"), payload);
    const index = {
        schema: 1,
        version: "test-extrapath",
        packs: [{ id: "test", label: "Test", resources: ["existing-file", "new-file"] }],
        resources: [
            { id: "existing-file", type: "model", label: "Existing", target: "vae/already.safetensors", size: 1 },
            {
                id: "new-file",
                type: "model",
                label: "New",
                target: "vae/new.bin",
                size: payload.length,
                sources: [{ kind: "bundled", path: "resources/payload.bin" }],
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
        setup: {
            loaderOptions: () => ({}),
            folderPaths: () => ({ vae: [extraVae] }),
            status: () => ({ comfyReachable: true }),
            scan: async () => ({}),
        },
        logger: null,
    });

    try {
        await manager.init();
        const before = manager.status();
        const existing = before.resources.find((item) => item.id === "existing-file");
        const missing = before.resources.find((item) => item.id === "new-file");
        assert.equal(existing.status, "present");
        assert.equal(missing.status, "missing");
        assert.ok(before.modelRoots.vae.includes(extraVae));

        const job = manager.install({ ids: ["new-file"] });
        const finished = await waitForJob(manager, job.id);
        assert.equal(finished.status, "done", JSON.stringify(finished));
        assert.deepEqual(await fsp.readFile(path.join(extraVae, "new.bin")), payload);
        assert.equal(fs.existsSync(path.join(comfy, "models", "vae", "new.bin")), false);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("resource matching handles subfolders, renamed files and size mismatches", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-match-test-"));
    const comfy = path.join(root, "ComfyUI");
    const extra = path.join(root, "models-extra");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(path.join(extra, "vae", "sub"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(comfy, "main.py"), "", "utf8");
    await fsp.writeFile(path.join(extra, "vae", "sub", "demo.safetensors"), Buffer.alloc(1024));
    await fsp.writeFile(path.join(extra, "vae", "renamed.safetensors"), Buffer.alloc(2048));
    await fsp.writeFile(path.join(extra, "vae", "wrong.safetensors"), Buffer.alloc(100));

    const index = {
        schema: 1,
        version: "test-match",
        packs: [{ id: "test", label: "Test", resources: ["subdir-demo", "renamed-demo", "wrong-size", "loader-only"] }],
        resources: [
            { id: "subdir-demo", type: "model", label: "Subdir", target: "vae/demo.safetensors", size: 1024 },
            { id: "renamed-demo", type: "model", label: "Renamed", target: "vae/original.safetensors", size: 2048 },
            { id: "wrong-size", type: "model", label: "Wrong", target: "vae/wrong.safetensors", size: 4096 },
            { id: "loader-only", type: "model", label: "Loader only", target: "vae/loader-only.safetensors", size: 0 },
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
        setup: {
            loaderOptions: () => ({ VAELoader: ["loader-only.safetensors"] }),
            folderPaths: () => ({ vae: [path.join(extra, "vae")] }),
            status: () => ({ comfyReachable: true }),
            scan: async () => ({}),
        },
        logger: null,
    });

    try {
        await manager.init();
        const byId = new Map(manager.status().resources.map((item) => [item.id, item]));
        assert.equal(byId.get("subdir-demo").status, "present");
        assert.equal(byId.get("subdir-demo").matchedBy, "name");
        assert.equal(byId.get("renamed-demo").status, "present");
        assert.equal(byId.get("renamed-demo").matchedBy, "size");
        assert.equal(byId.get("wrong-size").status, "present");
        assert.match(byId.get("wrong-size").sizeMismatch, /大小不一致/);
        assert.equal(byId.get("loader-only").status, "present");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("extra_model_paths.yaml is used when ComfyUI folder paths are unavailable", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-yaml-test-"));
    const comfy = path.join(root, "ComfyUI");
    const extra = path.join(root, "other-drive");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(path.join(comfy, "models", "vae"), { recursive: true });
    await fsp.mkdir(path.join(extra, "vae"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(comfy, "main.py"), "", "utf8");
    await fsp.writeFile(path.join(extra, "vae", "from-yaml.safetensors"), Buffer.alloc(777));
    await fsp.writeFile(
        path.join(comfy, "extra_model_paths.yaml"),
        ["other:", `  base_path: ${extra.split("\\").join("/")}`, "  vae: vae/", ""].join("\n"),
        "utf8",
    );
    const index = {
        schema: 1,
        version: "test-yaml",
        packs: [{ id: "test", label: "Test", resources: ["yaml-vae"] }],
        resources: [{ id: "yaml-vae", type: "model", label: "YAML VAE", target: "vae/from-yaml.safetensors", size: 777 }],
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
        setup: { loaderOptions: () => ({}), folderPaths: () => ({}), status: () => ({ comfyReachable: false }), scan: async () => ({}) },
        logger: null,
    });

    try {
        await manager.init();
        const status = manager.status();
        assert.equal(status.resources[0].status, "present");
        const expectedRoot = path.join(extra, "vae").toLowerCase();
        assert.ok(status.modelRoots.vae.some((entry) => entry.toLowerCase() === expectedRoot));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("sage wheel matrix selects by python, torch and cuda", () => {
    const resource = {
        wheelMatrix: [
            { python: ">=3.10", torch: ">=2.10.0", cuda: "13.0", url: "cu130-2.10" },
            { python: ">=3.10", torch: ">=2.9.1,<2.10.0", cuda: "13.0", url: "cu130-2.9.1" },
            { python: ">=3.9", torch: ">=2.9.0,<2.9.1", cuda: "13.0", url: "cu130-2.9.0" },
            { python: ">=3.10", torch: ">=2.10.0", cuda: "12.8", url: "cu128-2.10" },
            { python: ">=3.10", torch: ">=2.9.1,<2.10.0", cuda: "12.8", url: "cu128-2.9.1" },
            { python: ">=3.9", torch: ">=2.9.0,<2.9.1", cuda: "12.8", url: "cu128-2.9.0" },
            { python: ">=3.9", torch: ">=2.8.0,<2.9.0", cuda: "12.8", url: "cu128-2.8.0" },
            { python: ">=3.9", torch: ">=2.7.1,<2.8.0", cuda: "12.8", url: "cu128-2.7.1" },
        ],
    };
    const pick = (python, torch, cuda) => selectPipWheelForRuntime(resource, { python, torch, cuda })?.url || "";
    assert.equal(pick("3.12", "2.12.0+cu130", "13.0"), "cu130-2.10");
    assert.equal(pick("3.12", "2.9.1+cu130", "13.0"), "cu130-2.9.1");
    assert.equal(pick("3.12", "2.9.0+cu130", "13.0"), "cu130-2.9.0");
    assert.equal(pick("3.12", "2.10.1+cu128", "12.8"), "cu128-2.10");
    assert.equal(pick("3.12", "2.9.1+cu128", "12.8"), "cu128-2.9.1");
    assert.equal(pick("3.12", "2.8.0+cu128", "12.8"), "cu128-2.8.0");
    assert.equal(pick("3.12", "2.7.1+cu128", "12.8"), "cu128-2.7.1");
    assert.equal(pick("3.12", "2.7.0+cu128", "12.8"), "");
    assert.equal(pick("3.12", "2.9.1+cu130", "12.6"), "");
});

test("universal pip wheels match any python/torch/cuda runtime", () => {
    const resource = { wheelMatrix: [{ url: "https://example.test/universal.whl", size: 10, sha256: "a".repeat(64) }] };
    for (const runtime of [
        { python: "3.10", torch: "2.4.0", cuda: "12.1" },
        { python: "3.12", torch: "2.12.0+cu130", cuda: "13.0" },
        { python: "3.13", torch: "", cuda: "" },
    ]) {
        assert.equal(selectPipWheelForRuntime(resource, runtime)?.url, "https://example.test/universal.whl");
    }
    const gated = { wheelMatrix: [{ python: ">=3.13", url: "https://example.test/py313.whl" }] };
    assert.equal(selectPipWheelForRuntime(gated, { python: "3.12" }), null);
});

test("release index includes sage runtime in every H3 workflow", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const sage = index.resources.find((item) => item.id === "sage_h3");
    assert.ok(sage, "missing sage_h3 resource");
    assert.equal(sage.type, "pip");
    assert.equal(sage.module, "sageattention");
    assert.equal(sage.wheelMatrix.length, 10);
    assert.ok(sage.wheelMatrix.every((item) => item.url && item.sha256 && item.size > 0));
    const pick = (runtime) => selectPipWheelForRuntime(sage, runtime)?.url || "";
    assert.match(pick({ python: "3.12", torch: "2.9.1+cu130", cuda: "13.0" }), /cu130torch2.9.1.post6/);
    assert.match(pick({ python: "3.12", torch: "2.12.0+cu130", cuda: "13.0" }), /cu130torch2.10.0andhigher.post6/);
    assert.match(pick({ python: "3.12", torch: "2.8.0+cu128", cuda: "12.8" }), /cu128torch2.8.0.post3/);
    assert.equal(pick({ python: "3.12", torch: "2.7.0+cu128", cuda: "12.8" }), "");
    const h3 = index.packs.find((item) => item.id === "h3");
    assert.ok(h3.resources.includes("sage_h3"));
    assert.equal(h3.optionalResources.includes("sage_h3"), false);
    for (const ids of Object.values(h3.workflowDependencies || {})) {
        assert.ok(ids.includes("sage_h3"));
    }
});

test("missing local index self-heals from remote and falls back to cache", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-index-cache-test-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(comfy, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ schema: 1, version: "remote-test", packs: [], resources: [] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const config = {
        rootDir: root,
        dataDir: data,
        comfyDir: comfy,
        comfyWorkflowsDir: "",
        resourcesIndexUrl: `http://127.0.0.1:${port}/index.json`,
        resourcesIndexUrlBackup: "",
        resourcesFetchTimeoutMs: 1000,
        resourceConcurrency: 1,
    };
    const setup = { loaderOptions: () => ({}), status: () => ({ comfyReachable: false }), scan: async () => ({}) };
    const hardware = { gpuName: "Test", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" };
    try {
        const first = createResourceManager({ config, setup, hardware, logger: null });
        await first.init();
        const online = first.status();
        assert.equal(online.indexVersion, "remote-test");
        assert.equal(online.indexSource, "remote");
        assert.equal(online.indexError, "");
        assert.ok(fs.existsSync(path.join(data, "resources-index.json")));

        await new Promise((resolve) => server.close(resolve));
        const second = createResourceManager({ config, setup, hardware, logger: null });
        await second.init();
        const offline = second.status();
        assert.equal(offline.indexVersion, "remote-test");
        assert.equal(offline.indexSource, "cache");
        assert.match(offline.indexWarning, /缓存/);
        assert.equal(offline.indexError, "");
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("infers ComfyUI root from folder_paths when comfyDir is empty", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "comfy-root-infer-"));
    const comfy = path.join(root, "MyComfy");
    const vae = path.join(comfy, "models", "vae");
    await fsp.mkdir(vae, { recursive: true });
    await fsp.mkdir(path.join(comfy, "custom_nodes"), { recursive: true });
    try {
        const inferred = inferComfyRootFromFolderPaths({ vae: [vae] });
        assert.equal(inferred, comfy);
        assert.equal(inferComfyRootFromFolderPaths({ vae: [path.join(root, "elsewhere", "vae")] }), "");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("a node pack installed under another folder name counts as present", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-node-provides-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    await fsp.mkdir(comfy, { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-node-provides-1",
        packs: [{ id: "test", resources: ["test-node"] }],
        resources: [{ id: "test-node", type: "node", label: "Test node", target: "custom_nodes/ComfyUI-ExpectedName", provides: ["SeedVR2VideoUpscaler"] }],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}), hasNodeClass: (name) => name === "SeedVR2VideoUpscaler" },
        logger: null,
    });
    try {
        await manager.init();
        const item = manager.status().resources[0];
        assert.equal(item.status, "present");
        assert.equal(item.matchedBy, "class");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("VDN availability reports a missing Stage-B adapter with an actionable message", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-vdn-stage-b-"));
    const comfy = path.join(root, "ComfyUI");
    const data = path.join(root, "data");
    const resources = path.join(root, "resources");
    const stage = path.join(comfy, "models", "vdn", "stage-dmd-step-250");
    await fsp.mkdir(path.join(stage, "linear_branch"), { recursive: true });
    await fsp.writeFile(path.join(stage, "linear_branch", "model.safetensors"), "model");
    await fsp.mkdir(data, { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    const index = {
        schema: 1,
        version: "test-vdn-stage-b-1",
        packs: [{ id: "h3", resources: ["h3_vdn_stage_model", "h3_vdn_stage_default_adapter"], workflowDependencies: { "video-h3-ref2va": ["h3_vdn_stage_model", "h3_vdn_stage_default_adapter"] } }],
        resources: [
            { id: "h3_vdn_stage_model", type: "model", label: "VDN linear_branch/model.safetensors", target: "vdn/stage-dmd-step-250/linear_branch/model.safetensors" },
            { id: "h3_vdn_stage_default_adapter", type: "model", label: "VDN adapters/default/adapter_model.safetensors", target: "vdn/stage-dmd-step-250/adapters/default/adapter_model.safetensors" },
        ],
    };
    await fsp.writeFile(path.join(resources, "index.json"), JSON.stringify(index), "utf8");
    const manager = createResourceManager({
        config: { rootDir: root, dataDir: data, comfyDir: comfy, comfyWorkflowsDir: "", resourcesIndexUrl: "", resourcesFetchTimeoutMs: 1000, resourceConcurrency: 1 },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        logger: null,
    });
    try {
        await manager.init();
        const missing = manager.runtimeProblemsFor("video-h3-ref2va");
        assert.equal(missing.length, 1);
        assert.equal(missing[0].resourceId, "h3_vdn_stage_default_adapter");
        assert.match(missing[0].message, /Stage-B/);
        await fsp.mkdir(path.join(stage, "adapters", "default"), { recursive: true });
        await fsp.writeFile(path.join(stage, "adapters", "default", "adapter_model.safetensors"), "adapter");
        assert.deepEqual(manager.runtimeProblemsFor("video-h3-ref2va"), []);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
