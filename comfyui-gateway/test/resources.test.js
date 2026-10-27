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
    assert.equal(pack.workflowDependencies, undefined);
    assert.deepEqual(pack.workflows, ["image-z-image-turbo"]);
    assert.deepEqual(pack.resources, [
        "z_image_turbo_bf16",
        "qwen_3_4b",
        "ae",
        "z_image_turbo_int8_convrot",
    ]);
    assert.deepEqual(pack.optionalResources, ["z_image_turbo_int8_convrot"]);
    assert.equal(index.resources.some((item) => item.id === "z_image_turbo_distill_lora"), false);
});

test("krea2 pack matches the zimage shape with no bundled LoRAs", () => {
    const index = JSON.parse(fs.readFileSync(new URL("../resources/index.json", import.meta.url), "utf8"));
    const pack = index.packs.find((item) => item.id === "krea2");
    assert.ok(pack, "krea2 pack is missing");
    assert.equal(pack.autoRecommend, false);
    assert.equal(pack.optional, true);
    assert.equal(pack.variants, undefined);
    assert.equal(pack.workflowDependencies, undefined);
    assert.deepEqual(pack.workflows, ["image-krea2-turbo"]);
    assert.deepEqual(pack.resources, [
        "krea2_turbo_fp8_scaled",
        "qwen3vl_4b_fp8_scaled",
        "qwen_image_vae",
        "krea2_turbo_int8_convrot",
    ]);
    assert.deepEqual(pack.optionalResources, ["krea2_turbo_int8_convrot"]);
    assert.equal(index.resources.some((item) => item.id === "krea2_darkbrush_lora"), false);
    assert.equal(index.resources.some((item) => item.id === "krea2_retroanime_lora"), false);
    assert.equal(index.resources.length, 24);
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
        "inpaint_cropandstitch",
        "kjnodes",
    ]);
    assert.deepEqual(pack.workflowDependencies["image-qwen21-angle"], [
        "qwen_image_2.1_turbo_int8_convrot",
        "qwen3vl_8b_int8_convrot",
        "qwen_image_2.1_vae_bf16",
        "qwenmultiangle",
    ]);
    const byId = new Map(index.resources.map((item) => [item.id, item]));
    const lora = byId.get("qwen21_outpaint_lora");
    assert.equal(lora.size, 159436576);
    assert.equal(lora.sha256, "3611a5ccae5f790405eeacf1dfb2c89285c1e4f2987b9abc88cd0161a60eca28");
    assert.equal(lora.sources.length, 2);
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
