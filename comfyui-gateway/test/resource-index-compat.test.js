import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createResourceManager, isRetiredResourceId, normalizeResourceIndex } from "../src/resources.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexFile = path.join(root, "resources", "index.json");
const FOUR_VIEW_IDS = ["krea2_turbo_fp8_scaled", "qwen3vl_4b_fp8_scaled", "qwen_image_vae", "krea2_four_view_lora"];
const VDN_WORKFLOWS = ["video-h3-ref2va", "video-h3-t2v", "video-h3-frames", "video-h3-character-swap"];
const NOVDN_WORKFLOWS = ["video-h3-ref2va-novdn", "video-h3-t2v-novdn", "video-h3-frames-novdn"];
const RETIRED_IDS = [
    "h3_vdn_stage_model",
    "h3_vdn_stage_turbo_adapter",
    "h3_vdn_stage_default_adapter",
    "h3_vdn_stage_spec",
    "h3_vdn_stage_metadata",
    "h3_vdn_stage_linear_config",
    "h3_vdn_stage_turbo_config",
    "h3_vdn_stage_default_config",
    "h3_character_swap_lora",
    "h3_vdn_node",
];

function readIndex() {
    return JSON.parse(fs.readFileSync(indexFile, "utf8"));
}

// 模拟旧远端 2026.10.31-31：没有独立四视图包、VDN 没有 downloadable 标记、H3 仍列退休资源。
function legacyIndex() {
    const index = readIndex();
    index.version = "2026.10.31-31";
    index.updatedAt = "2026-10-31";
    index.packs = index.packs.filter((pack) => pack.id !== "krea2-four-view");
    const krea2 = index.packs.find((pack) => pack.id === "krea2");
    if (!krea2.optionalResources.includes("krea2_four_view_lora")) krea2.optionalResources.push("krea2_four_view_lora");
    const h3 = index.packs.find((pack) => pack.id === "h3");
    for (const id of RETIRED_IDS) {
        if (!h3.resources.includes(id)) h3.resources.push(id);
        if (!h3.optionalResources.includes(id)) h3.optionalResources.push(id);
    }
    h3.workflows = [...VDN_WORKFLOWS, ...NOVDN_WORKFLOWS];
    for (const id of RETIRED_IDS) {
        const resource = index.resources.find((item) => item.id === id);
        delete resource.downloadable;
    }
    index.resources.find((item) => item.id === "h3_vdn_node").autoInstall = true;
    return index;
}

function serveIndex(payload = { value: null }) {
    const server = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload.value));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}/index.json`, payload });
        });
    });
}

async function tempWorkspace({ localIndex = null, cacheIndex = null } = {}) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "resource-index-compat-"));
    const gatewayRoot = path.join(base, "gateway");
    const comfy = path.join(base, "ComfyUI");
    const data = path.join(base, "data");
    await fsp.mkdir(path.join(gatewayRoot, "resources"), { recursive: true });
    await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
    await fsp.mkdir(data, { recursive: true });
    if (localIndex) await fsp.writeFile(path.join(gatewayRoot, "resources", "index.json"), JSON.stringify(localIndex), "utf8");
    if (cacheIndex) await fsp.writeFile(path.join(data, "resources-index.json"), JSON.stringify(cacheIndex), "utf8");
    return { base, gatewayRoot, comfy, data };
}

function createManager({ workspace, indexUrl = "", backupUrl = "" }) {
    return createResourceManager({
        config: {
            rootDir: workspace.gatewayRoot,
            dataDir: workspace.data,
            comfyDir: workspace.comfy,
            comfyWorkflowsDir: "",
            resourcesIndexUrl: indexUrl,
            resourcesIndexUrlBackup: backupUrl,
            resourcesFetchTimeoutMs: 1000,
            resourceConcurrency: 1,
        },
        setup: { loaderOptions: () => ({}), status: () => ({ comfyReachable: true }), scan: async () => ({}) },
        hardware: { gpuName: "Test 32GB", vramTotalMb: 32768, ramTotalBytes: 64 * 1024 ** 3, ramFreeBytes: 64 * 1024 ** 3, detectedAt: new Date().toISOString(), source: "test" },
        logger: null,
    });
}

async function sparseFile(file, size) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const handle = await fsp.open(file, "w");
    try {
        await handle.truncate(Math.max(1, Number(size) || 1));
    } finally {
        await handle.close();
    }
}

function packByName(status, id) {
    return status.packs.find((pack) => pack.id === id);
}

function assertNoRetiredEntries(status) {
    const h3 = packByName(status, "h3");
    assert.ok(h3, "h3 pack is missing");
    assert.deepEqual(h3.workflows, NOVDN_WORKFLOWS);
    assert.deepEqual(h3.workflowDependencies.map((workflow) => workflow.id), NOVDN_WORKFLOWS);
    for (const id of RETIRED_IDS) {
        assert.equal(h3.resourceIds.includes(id), false, `${id} leaked into pack resources`);
        assert.equal(h3.optionalIds.includes(id), false, `${id} leaked into pack optionals`);
        assert.equal(h3.requiredIds.includes(id), false, `${id} leaked into required ids`);
        for (const workflow of h3.workflowDependencies) {
            assert.equal(workflow.installIds.includes(id), false, `${id} leaked into ${workflow.id} install plan`);
        }
    }
    const retiredItem = status.resources.find((item) => item.id === "h3_vdn_stage_model");
    assert.equal(retiredItem.downloadable, false);
    assert.equal(status.resources.find((item) => item.id === "h3_character_swap_lora").downloadable, false);
    assert.equal(status.resources.find((item) => item.id === "h3_vdn_node").downloadable, false);
    const novdn = h3.workflowDependencies.find((workflow) => workflow.id === "video-h3-ref2va-novdn");
    assert.ok(novdn.resources.some((item) => item.id === "h3_trt_vae_decoder_engine" && item.type === "bake"));
    assert.ok(novdn.installIds.includes("h3_trt_vae_decoder_engine"));
    assert.ok(novdn.installIds.includes("h3_vae_onnx_decoder"));
    assert.ok(novdn.installIds.includes("h3_vae_onnx_decoder_data"));
}

test("normalization is idempotent and does not drift a current index", () => {
    const legacy = legacyIndex();
    const legacyDeps = JSON.parse(JSON.stringify(legacy.packs.find((pack) => pack.id === "h3").workflowDependencies));
    const fourViewResources = new Map(FOUR_VIEW_IDS.map((id) => [id, JSON.parse(JSON.stringify(legacy.resources.find((item) => item.id === id)))]));
    const once = normalizeResourceIndex(legacy);
    const twice = normalizeResourceIndex(JSON.parse(JSON.stringify(once)));
    assert.deepEqual(twice, once, "normalization must be idempotent");
    assert.equal(once.packs.filter((pack) => pack.id === "krea2-four-view").length, 1);
    const fourView = once.packs.find((pack) => pack.id === "krea2-four-view");
    assert.equal(fourView.standalone, true);
    assert.deepEqual(fourView.resources, FOUR_VIEW_IDS);
    assert.deepEqual(fourView.optionalResources, FOUR_VIEW_IDS);
    assert.deepEqual(fourView.workflowDependencies, { "image-krea2-four-view": FOUR_VIEW_IDS });
    const krea2 = once.packs.find((pack) => pack.id === "krea2");
    assert.equal(krea2.optionalResources.includes("krea2_four_view_lora"), false);
    const h3 = once.packs.find((pack) => pack.id === "h3");
    assert.deepEqual(h3.workflows, NOVDN_WORKFLOWS);
    for (const id of RETIRED_IDS) {
        assert.equal(h3.resources.includes(id), false);
        assert.equal(h3.optionalResources.includes(id), false);
    }
    assert.deepEqual(h3.workflowDependencies, legacyDeps, "VDN workflow dependencies must stay for runtime checks");
    for (const id of VDN_WORKFLOWS) assert.ok(h3.workflowDependencies[id]);
    for (const id of FOUR_VIEW_IDS) assert.deepEqual(once.resources.find((item) => item.id === id), fourViewResources.get(id));
    for (const id of RETIRED_IDS) {
        const resource = once.resources.find((item) => item.id === id);
        assert.equal(resource.downloadable, false, `${id} download gate`);
    }
    assert.equal(once.resources.find((item) => item.id === "h3_vdn_node").autoInstall, false);
    for (const id of RETIRED_IDS) assert.equal(isRetiredResourceId(id), true);
    assert.equal(isRetiredResourceId("h3_lightx2v_8step_lora"), false);

    const current = readIndex();
    const normalizedCurrent = normalizeResourceIndex(JSON.parse(JSON.stringify(current)));
    assert.deepEqual(normalizedCurrent, current, "current v32 index must not drift");
});

test("pack expansion skips retired ids while direct ids and requires still fail closed", async () => {
    const index = {
        schema: 1,
        version: "compat-test-1",
        packs: [
            { id: "custom", resources: ["h3_vdn_stage_model", "present-file"] },
            { id: "custom-requires", resources: ["wrapper"] },
        ],
        resources: [
            { id: "h3_vdn_stage_model", type: "model", label: "Retired stage", target: "vdn/stage.bin", size: 10 },
            { id: "present-file", type: "model", label: "Present", target: "vae/present.bin", size: 4 },
            { id: "wrapper", type: "model", label: "Wrapper", target: "vae/wrapper.bin", size: 4, requires: ["h3_vdn_stage_model"] },
        ],
    };
    const workspace = await tempWorkspace({ localIndex: index });
    await sparseFile(path.join(workspace.comfy, "models", "vae", "present.bin"), 4);
    await sparseFile(path.join(workspace.comfy, "models", "vae", "wrapper.bin"), 4);
    const manager = createManager({ workspace });
    try {
        await manager.init();
        const status = manager.status();
        assert.equal(status.packs.find((pack) => pack.id === "custom").resourceIds.includes("h3_vdn_stage_model"), false);
        const job = manager.install({ packs: ["custom"] });
        assert.equal(job.status, "done");
        assert.equal(job.items.length, 0);
        assert.throws(() => manager.install({ ids: ["h3_vdn_stage_model"] }), /停止提供新下载/);
        assert.throws(() => manager.install({ packs: ["custom-requires"] }), /停止提供新下载/);
    } finally {
        await fsp.rm(workspace.base, { recursive: true, force: true });
    }
});

test("C1 old remote index keeps the four-view card and blocks retired downloads", async () => {
    const legacy = legacyIndex();
    const { server, url } = await serveIndex({ value: legacy });
    const workspace = await tempWorkspace();
    const manager = createManager({ workspace, indexUrl: url });
    try {
        await manager.init();
        let status = manager.status();
        assert.equal(status.indexVersion, "2026.10.31-31");
        assert.equal(status.indexSource, "remote");
        const fourViews = status.packs.filter((pack) => pack.id === "krea2-four-view");
        assert.equal(fourViews.length, 1);
        const fourView = fourViews[0];
        assert.equal(fourView.standalone, true);
        assert.equal(fourView.optionalMissing, 4);
        assert.deepEqual([...fourView.workflowDependencies[0].installIds].sort(), [...FOUR_VIEW_IDS].sort());
        assert.equal(packByName(status, "krea2").optionalIds.includes("krea2_four_view_lora"), false);
        assertNoRetiredEntries(status);
        for (const id of RETIRED_IDS) {
            assert.throws(() => manager.install({ ids: [id] }), /停止提供新下载/);
        }
        console.log(`[C1] version=${status.indexVersion} source=${status.indexSource} fourViewPacks=${fourViews.length} fourViewInstall=${fourView.workflowDependencies[0].installIds.join(",")}`);
        const novdn = packByName(status, "h3").workflowDependencies.find((workflow) => workflow.id === "video-h3-ref2va-novdn");
        console.log(`[C1] noVdnBake=${novdn.resources.filter((item) => item.type === "bake").map((item) => item.id).join(",")} bakeRequires=${novdn.installIds.filter((id) => id.startsWith("h3_vae_onnx")).join(",")}`);

        // 基础 Krea2 已具备时，四视图安装计划只剩 LoRA。
        const legacyById = new Map(legacy.resources.map((item) => [item.id, item]));
        for (const id of FOUR_VIEW_IDS.slice(0, 3)) {
            const resource = legacyById.get(id);
            await sparseFile(path.join(workspace.comfy, "models", ...resource.target.split("/")), resource.size);
        }
        const ready = createManager({ workspace, indexUrl: url });
        await ready.init();
        status = ready.status();
        const readyFourView = packByName(status, "krea2-four-view");
        assert.deepEqual(readyFourView.workflowDependencies[0].installIds, ["krea2_four_view_lora"]);
        assert.equal(readyFourView.optionalMissing, 1);
        assertNoRetiredEntries(status);
        console.log(`[C1] basePresent fourViewInstall=${readyFourView.workflowDependencies[0].installIds.join(",")}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(workspace.base, { recursive: true, force: true });
    }
});

test("C2 new remote index matches old-index behavior without duplicating packs", async () => {
    const payload = { value: null };
    const { server, url } = await serveIndex(payload);
    const workspace = await tempWorkspace({ localIndex: legacyIndex() });
    const manager = createManager({ workspace, indexUrl: url });
    try {
        await manager.init();
        assert.equal(manager.status().indexVersion, "2026.10.31-31");
        payload.value = readIndex();
        const status = await manager.refresh();
        assert.equal(status.indexVersion, "2026.11.06-39");
        assert.equal(status.indexSource, "remote");
        const agentPack = status.packs.find((pack) => pack.id === "agent");
        assert.equal(agentPack?.kind, "runtime");
        assert.equal(agentPack?.runtime?.sha256, "759f93fdedf60696d351abbae7ca4515ceb37470475b345a6e6b664ad09a0ce3");
        assert.deepEqual(agentPack?.resourceIds, []);
        assert.equal(status.resources.some((item) => item.id === "agent_runtime"), false);
        const fourViews = status.packs.filter((pack) => pack.id === "krea2-four-view");
        assert.equal(fourViews.length, 1);
        assert.equal(fourViews[0].standalone, true);
        const fourView = status.resources.filter((item) => FOUR_VIEW_IDS.includes(item.id));
        assert.equal(fourView.length, 4);
        const current = readIndex();
        for (const id of FOUR_VIEW_IDS) {
            const served = fourView.find((item) => item.id === id);
            const expected = current.resources.find((item) => item.id === id);
            assert.equal(served.target, expected.target);
            assert.equal(served.size, expected.size);
            assert.equal(served.sha256, expected.sha256);
            const expectedSources = expected.sources.map((source) => (typeof source === "string" ? source : source.url || source.path));
            const servedSources = served.sources.map((source) => source.url || source.path);
            assert.deepEqual(servedSources, expectedSources);
        }
        assert.deepEqual(packByName(status, "krea2-four-view").workflows, ["image-krea2-four-view"]);
        assertNoRetiredEntries(status);
        // refresh 两次结果一致，不产生重复 pack/资源。
        const again = await manager.refresh();
        assert.deepEqual(
            again.packs.map((pack) => pack.id),
            status.packs.map((pack) => pack.id),
        );
        assert.equal(again.packs.filter((pack) => pack.id === "krea2-four-view").length, 1);
        assert.equal(again.resources.length, status.resources.length);
        console.log(`[C2] ${status.indexVersion} fourViewPacks=${fourViews.length} packs=${again.packs.length} resources=${again.resources.length}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(workspace.base, { recursive: true, force: true });
    }
});

test("C3 missing local index still normalizes an old cache", async () => {
    const workspace = await tempWorkspace({ cacheIndex: legacyIndex() });
    const manager = createManager({ workspace, indexUrl: "http://127.0.0.1:1/index.json", backupUrl: "http://127.0.0.1:2/index.json" });
    try {
        await manager.init();
        const status = manager.status();
        assert.equal(status.indexSource, "cache");
        assert.equal(status.indexVersion, "2026.10.31-31");
        assert.equal(status.packs.filter((pack) => pack.id === "krea2-four-view").length, 1);
        assertNoRetiredEntries(status);
        assert.throws(() => manager.install({ ids: ["h3_vdn_stage_model"] }), /停止提供新下载/);
        assert.throws(() => manager.install({ ids: ["h3_character_swap_lora"] }), /停止提供新下载/);
        console.log(`[C3] version=${status.indexVersion} source=${status.indexSource} fourViewPacks=${status.packs.filter((pack) => pack.id === "krea2-four-view").length}`);
    } finally {
        await fsp.rm(workspace.base, { recursive: true, force: true });
    }
});

test("C4 present VDN files only block new downloads and stay in the runtime check", async () => {
    const legacy = legacyIndex();
    const { server, url } = await serveIndex({ value: legacy });
    const workspace = await tempWorkspace();
    const manager = createManager({ workspace, indexUrl: url });
    try {
        await manager.init();
        const byId = new Map(legacy.resources.map((item) => [item.id, item]));
        for (const id of RETIRED_IDS.filter((item) => item !== "h3_vdn_node")) {
            const resource = byId.get(id);
            await sparseFile(path.join(workspace.comfy, "models", ...resource.target.split("/")), resource.size);
        }
        const installed = createManager({ workspace, indexUrl: url });
        await installed.init();
        const status = installed.status();
        for (const id of RETIRED_IDS.filter((item) => item !== "h3_vdn_node")) {
            assert.equal(status.resources.find((item) => item.id === id).status, "present", `${id} should be present`);
        }
        assertNoRetiredEntries(status);
        const job = installed.install({ ids: ["h3_character_swap_lora", "h3_vdn_stage_model"] });
        assert.equal(job.status, "done");
        assert.equal(job.items.length, 0);
        for (const id of ["h3_character_swap_lora", "h3_vdn_stage_model"]) {
            const resource = byId.get(id);
            assert.equal(fs.existsSync(path.join(workspace.comfy, "models", ...resource.target.split("/"))), true, `${id} must not be deleted`);
        }
        for (const workflowId of VDN_WORKFLOWS) {
            const problems = installed.runtimeProblemsFor(workflowId);
            assert.equal(problems.some((problem) => String(problem.resourceId || "").startsWith("h3_vdn_stage_")), false, `${workflowId} VDN runtime check`);
        }
        console.log(`[C4] present=${RETIRED_IDS.filter((id) => id !== "h3_vdn_node").map((id) => status.resources.find((item) => item.id === id).status).join(",")} skipJob=${job.status}/${job.items.length}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fsp.rm(workspace.base, { recursive: true, force: true });
    }
});
