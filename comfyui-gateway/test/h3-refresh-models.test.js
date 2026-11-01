import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatewayApp, stopGateway } from "../src/server.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexFile = path.join(root, "resources", "index.json");
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
const VDN_MODELS = ["video-h3-ref2va", "video-h3-t2v", "video-h3-frames", "video-h3-character-swap"];
const NOVDN_MODELS = ["video-h3-ref2va-novdn", "video-h3-t2v-novdn", "video-h3-frames-novdn"];
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|engine)$/i;

function readIndex() {
    return JSON.parse(fs.readFileSync(indexFile, "utf8"));
}

// 旧远端索引：没有四视图包，VDN 没有 downloadable 标记，H3 仍列退休资源与 VDN 工作流。
// workflowDependencies 只保留模型类资源，避免测试依赖真实 Python/TensorRT。
function legacyIndexForGateway() {
    const index = readIndex();
    index.version = "2026.10.31-31";
    index.updatedAt = "2026-10-31";
    index.packs = index.packs.filter((pack) => pack.id !== "krea2-four-view");
    const krea2 = index.packs.find((pack) => pack.id === "krea2");
    if (!krea2.optionalResources.includes("krea2_four_view_lora")) krea2.optionalResources.push("krea2_four_view_lora");
    const byId = new Map(index.resources.map((item) => [item.id, item]));
    const h3 = index.packs.find((pack) => pack.id === "h3");
    for (const id of RETIRED_IDS) {
        if (!h3.resources.includes(id)) h3.resources.push(id);
        if (!h3.optionalResources.includes(id)) h3.optionalResources.push(id);
    }
    h3.workflows = [...VDN_MODELS, ...NOVDN_MODELS];
    for (const [workflowId, ids] of Object.entries(h3.workflowDependencies)) {
        h3.workflowDependencies[workflowId] = ids.filter((id) => byId.get(id)?.type === "model");
    }
    for (const id of RETIRED_IDS) delete byId.get(id).downloadable;
    byId.get("h3_vdn_node").autoInstall = true;
    return index;
}

function buildObjectInfo(workflowFiles) {
    const defs = new Map();
    for (const file of workflowFiles) {
        const graph = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const node of Object.values(graph)) {
            const classType = node?.class_type;
            if (!classType) continue;
            if (!defs.has(classType)) defs.set(classType, { name: classType, input: { required: {} } });
            const required = defs.get(classType).input.required;
            for (const [input, value] of Object.entries(node.inputs || {})) {
                if (Array.isArray(value)) continue;
                const current = required[input];
                if (typeof value === "string" && MODEL_FILE.test(value)) {
                    if (Array.isArray(current?.[0])) {
                        if (!current[0].includes(value)) current[0].push(value);
                    } else {
                        required[input] = [[value], {}];
                    }
                } else if (!current) {
                    required[input] = [typeof value === "number" ? "INT" : typeof value === "boolean" ? "BOOLEAN" : "STRING", {}];
                }
            }
        }
    }
    return Object.fromEntries(defs);
}

function dropObjectInfoOption(objectInfo, value) {
    for (const definition of Object.values(objectInfo)) {
        for (const group of Object.values(definition.input || {})) {
            if (!group || typeof group !== "object") continue;
            for (const spec of Object.values(group)) {
                if (!Array.isArray(spec?.[0])) continue;
                const index = spec[0].indexOf(value);
                if (index >= 0) spec[0].splice(index, 1);
            }
        }
    }
}

function startJsonServer(handler) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const result = handler(url.pathname, req);
        if (result === undefined) {
            res.statusCode = 404;
            res.end("not found");
            return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
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

async function readModels(baseUrl) {
    const response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    return response.json();
}

function modelIds(payload) {
    return payload.data.map((model) => model.id).sort();
}

function h3Pack(status) {
    return status.packs.find((pack) => pack.id === "h3");
}

test("refresh keeps installed VDN workflows in /v1/models and never re-opens downloads", async () => {
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-h3-refresh-"));
    const workflows = path.join(temp, "workflows");
    const comfy = path.join(temp, "ComfyUI");
    const data = path.join(temp, "data");
    let indexServer;
    let comfyServer;
    let gateway;
    let server;
    try {
        await fsp.cp(path.join(root, "workflows"), workflows, { recursive: true });
        await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
        const legacy = legacyIndexForGateway();
        const byId = new Map(legacy.resources.map((item) => [item.id, item]));
        const h3Files = ["h3-ref2va-drama-vdn.json", "h3-character-swap-vdn.json", "h3-ref2va-drama.json"].map((file) => path.join(workflows, file));
        const objectInfo = buildObjectInfo(h3Files);

        const indexEndpoint = await startJsonServer((pathname) => (pathname.endsWith("/index.json") ? legacy : undefined));
        indexServer = indexEndpoint.server;
        const comfyEndpoint = await startJsonServer((pathname) => {
            if (pathname === "/system_stats") {
                return {
                    system: { comfyui_version: "mock", python_version: "3.12.0 (mock)", pytorch_version: "2.5.0 (mock)", ram_total: 34359738368, ram_free: 17179869184 },
                    devices: [{ name: "cpu (mock)", type: "cpu", index: 0, vram_total: 0, vram_free: 0 }],
                };
            }
            if (pathname === "/object_info") return objectInfo;
            if (pathname === "/internal/folder_paths") return {};
            return undefined;
        });
        comfyServer = comfyEndpoint.server;

        for (const id of RETIRED_IDS.filter((item) => item !== "h3_vdn_node")) {
            const resource = byId.get(id);
            await sparseFile(path.join(comfy, "models", ...resource.target.split("/")), resource.size);
        }

        gateway = await createGatewayApp({
            comfyUrl: comfyEndpoint.url,
            comfyDir: comfy,
            workflowDir: workflows,
            dataDir: data,
            outputDir: path.join(data, "outputs"),
            publicBaseUrl: "http://127.0.0.1:18199",
            corsOrigins: ["http://localhost:3000"],
            requestTimeoutMs: 15000,
            watchWorkflows: false,
            resourcesIndexUrl: `${indexEndpoint.url}/index.json`,
            resourcesIndexUrlBackup: "",
            resourcesFetchTimeoutMs: 1000,
        });
        server = gateway.app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        // 先加载旧远端索引并扫描，建立“已安装 VDN”的基线；随后再 refresh 对比。
        const baselineRefresh = await fetch(`${baseUrl}/api/resources/refresh`, { method: "POST" });
        assert.equal(baselineRefresh.status, 200);
        assert.equal(gateway.setup.status().phase, "ready");

        const before = await readModels(baseUrl);
        const beforeIds = modelIds(before);
        for (const id of VDN_MODELS) assert.ok(beforeIds.includes(id), `${id} must be available before refresh`);
        for (const id of NOVDN_MODELS) assert.ok(beforeIds.includes(id), `${id} must be available before refresh`);
        for (const id of VDN_MODELS) {
            assert.equal(before.data.find((model) => model.id === id).metadata.availability.available, true, `${id} availability`);
        }

        const refresh = await fetch(`${baseUrl}/api/resources/refresh`, { method: "POST" });
        assert.equal(refresh.status, 200);
        const after = await readModels(baseUrl);
        assert.deepEqual(modelIds(after), beforeIds, "refresh must not change the model id set");
        assert.ok(after.revision >= before.revision);
        console.log(
            `[h3-refresh] before=${beforeIds.filter((id) => VDN_MODELS.includes(id)).join(",")} after=${modelIds(after).filter((id) => VDN_MODELS.includes(id)).join(",")} revision=${before.revision}->${after.revision}`,
        );
        for (const id of VDN_MODELS) {
            const model = after.data.find((item) => item.id === id);
            assert.ok(model, `${id} must survive refresh`);
            assert.equal(model.metadata.availability.available, true);
            assert.deepEqual(model.metadata.availability.problems, []);
        }

        const statusResponse = await fetch(`${baseUrl}/api/resources/status`);
        assert.equal(statusResponse.status, 200);
        const status = await statusResponse.json();
        assert.equal(status.indexVersion, "2026.10.31-31");
        assert.equal(status.packs.filter((pack) => pack.id === "krea2-four-view").length, 1);
        assert.equal(status.packs.find((pack) => pack.id === "krea2-four-view").standalone, true);
        const h3 = h3Pack(status);
        assert.deepEqual(h3.workflows, NOVDN_MODELS);
        assert.deepEqual(h3.workflowDependencies.map((workflow) => workflow.id), NOVDN_MODELS);
        for (const id of RETIRED_IDS) {
            const item = status.resources.find((entry) => entry.id === id);
            assert.equal(item.downloadable, false, `${id} must stay closed`);
            const install = await fetch(`${baseUrl}/api/resources/install`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [id] }),
            });
            if (item.status === "present") {
                assert.equal(install.status, 200, `${id} present install must be a skip`);
                assert.equal((await install.json()).job.items.length, 0, `${id} must not download again`);
            } else {
                assert.equal(install.status, 400, `${id} direct install`);
                assert.match((await install.json()).error.message, /停止提供新下载/);
            }
        }

        // 删除临时 VDN 文件后刷新：VDN 不再可用，但直接安装仍被硬门禁拒绝，无 VDN 三条不受牵连。
        await fsp.rm(path.join(comfy, "models", "vdn"), { recursive: true, force: true });
        await fsp.rm(path.join(comfy, "models", "loras", "h3_character_swap_v1.5.safetensors"), { force: true });
        // 模拟 ComfyUI 重启后不再列出已删除的 LoRA / VDN 节点类。
        dropObjectInfoOption(objectInfo, "h3_character_swap_v1.5.safetensors");
        delete objectInfo.ApplyVDNH3Advanced;
        const missingRefresh = await fetch(`${baseUrl}/api/resources/refresh`, { method: "POST" });
        assert.equal(missingRefresh.status, 200);
        const missing = await readModels(baseUrl);
        for (const id of VDN_MODELS) assert.equal(missing.data.some((model) => model.id === id), false, `${id} must drop when files are missing`);
        for (const id of NOVDN_MODELS) assert.ok(missing.data.some((model) => model.id === id), `${id} must not depend on VDN`);
        console.log(`[h3-refresh] missingVdnDrop=${VDN_MODELS.filter((id) => !missing.data.some((model) => model.id === id)).join(",")} noVdnKept=${NOVDN_MODELS.filter((id) => missing.data.some((model) => model.id === id)).join(",")}`);
        const missingStatus = await (await fetch(`${baseUrl}/api/resources/status`)).json();
        const missingH3 = h3Pack(missingStatus);
        assert.deepEqual(missingH3.workflowDependencies.map((workflow) => workflow.id), NOVDN_MODELS);
        for (const id of RETIRED_IDS) {
            assert.equal(missingH3.resourceIds.includes(id), false);
            assert.equal(missingH3.optionalIds.includes(id), false);
            assert.equal(missingStatus.resources.find((entry) => entry.id === id).status, "missing", `${id} must report missing`);
            const install = await fetch(`${baseUrl}/api/resources/install`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: [id] }),
            });
            assert.equal(install.status, 400, `${id} direct install`);
            assert.match((await install.json()).error.message, /停止提供新下载/);
        }
    } finally {
        if (gateway) {
            await stopGateway({ tasks: gateway.tasks, comfy: gateway.comfy, setup: gateway.setup, server, abortActiveRequests: gateway.abortActiveRequests, assistant: gateway.assistant }).catch(() => {});
        }
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => (comfyServer ? comfyServer.close(resolve) : resolve()));
        await new Promise((resolve) => (indexServer ? indexServer.close(resolve) : resolve()));
        await fsp.rm(temp, { recursive: true, force: true });
    }
});
