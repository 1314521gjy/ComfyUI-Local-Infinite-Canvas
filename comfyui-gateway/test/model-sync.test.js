import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createMockComfyServer } from "../mock/comfyui-mock.mjs";
import { createGatewayApp, stopGateway } from "../src/server.js";
import { createSetupManager } from "../src/setup.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(import.meta.dirname, "..");

const entry = {
  id: "image-sync-workflow",
  name: "image-sync-workflow",
  type: "image",
  workflow: {
    1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
  },
};

function objectInfo(unetFiles) {
  return { UNETLoader: { input: { required: { unet_name: [unetFiles] } } } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 4000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(interval);
  }
}

function createManager(dataDir, comfy, registry = {}) {
  return createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: entry.id }],
      resolve: () => entry,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
      ...registry,
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => objectInfo(["z_image_turbo_bf16.safetensors"]),
      ...comfy,
    },
    logger: null,
    mainModelFile: () => "",
  });
}

test("a successful scan swaps loader options, folder paths and availability as one revision", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-sync-atomic-"));
  let generation = 1;
  let folderPaths = { diffusion_models: ["C:/models/gen1"] };
  try {
    const manager = createManager(dataDir, {
      objectInfo: async () => objectInfo(generation === 1 ? ["z_image_turbo_bf16.safetensors"] : ["other_base.safetensors"]),
      folderPaths: async () => folderPaths,
    });
    await manager.scan();
    assert.equal(manager.status().scanId, 1);
    assert.equal(manager.status().revision, 1);
    assert.equal(manager.status().phase, "ready");
    assert.equal(manager.status().stale, false);
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["z_image_turbo_bf16.safetensors"]);
    assert.deepEqual(manager.folderPaths(), { diffusion_models: ["C:/models/gen1"] });
    assert.equal(manager.isAvailable(entry.id), true);

    generation = 2;
    folderPaths = { diffusion_models: ["C:/models/gen2"] };
    await manager.scan();

    const status = manager.status();
    assert.equal(status.scanId, 2);
    assert.equal(status.revision, 2);
    assert.equal(status.phase, "ready");
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["other_base.safetensors"]);
    assert.deepEqual(manager.folderPaths(), { diffusion_models: ["C:/models/gen2"] });
    assert.equal(manager.isAvailable(entry.id), false);
    assert.equal(manager.isKnownAvailable(entry.id), false);
    assert.equal(manager.workflowStatus(entry.id).available, false);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a scan in progress keeps the last committed snapshot readable", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-sync-scanning-"));
  let generation = 1;
  let gate = null;
  let release = null;
  try {
    const manager = createManager(
      dataDir,
      {
        objectInfo: async () => objectInfo(generation === 1 ? ["z_image_turbo_bf16.safetensors"] : ["other_base.safetensors"]),
      },
      {
        scan: async () => {
          if (gate) await gate;
          return { imported: 0 };
        },
      },
    );
    await manager.scan();
    assert.equal(manager.status().revision, 1);

    generation = 2;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = manager.scan();
    await waitFor(() => manager.status().scanning && manager.status().phase === "scanning");

    // 扫描中最多只能看到上一份已提交快照，不能提前看到新 loader 目录或空 availability。
    const during = manager.status();
    assert.equal(during.scanning, true);
    assert.equal(during.scanId, 1);
    assert.equal(during.revision, 1);
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["z_image_turbo_bf16.safetensors"]);
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.workflowStatus(entry.id).available, true);
    assert.ok(!manager.workflowStatus(entry.id).stale);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "");

    release();
    await pending;

    const ready = manager.status();
    assert.equal(ready.phase, "ready");
    assert.equal(ready.scanId, 2);
    assert.equal(ready.revision, 2);
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["other_base.safetensors"]);
    assert.equal(manager.isAvailable(entry.id), false);
  } finally {
    release?.();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a failed scan never overwrites the last snapshot with partial discoveries", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-sync-failed-"));
  let generation = 1;
  try {
    const manager = createManager(
      dataDir,
      {
        objectInfo: async () => objectInfo(generation === 1 ? ["z_image_turbo_bf16.safetensors"] : []),
      },
      {
        scan: async () => {
          if (generation === 2) throw new Error("registry exploded");
          return { imported: 0 };
        },
      },
    );
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    const before = manager.status();

    generation = 2;
    await manager.scan();

    const afterFailure = manager.status();
    assert.equal(afterFailure.phase, "degraded");
    assert.equal(afterFailure.stale, true);
    assert.match(String(afterFailure.lastError || ""), /registry exploded/);
    assert.equal(afterFailure.scanId, before.scanId);
    assert.equal(afterFailure.revision, before.revision);
    // 失败不能把空 catalog / 空 availability 覆盖到上次成功结果上。
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["z_image_turbo_bf16.safetensors"]);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "");
    assert.equal(manager.isKnownAvailable(entry.id), true);
    // degraded 只用于 stale 列表，不能放行生成。
    assert.equal(manager.isAvailable(entry.id), false);
    assert.equal(manager.workflowStatus(entry.id).stale, true);
    assert.equal(manager.workflowStatus(entry.id).available, false);

    // 下一次成功扫描重新提交并清除 stale。
    generation = 3;
    await manager.scan();
    const recovered = manager.status();
    assert.equal(recovered.phase, "ready");
    assert.equal(recovered.stale, false);
    assert.equal(recovered.scanId, before.scanId + 1);
    assert.equal(recovered.revision, before.revision + 1);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function openEventStream(url) {
  const controller = new AbortController();
  const events = [];
  const ready = (async () => {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = raw.split("\n").find((item) => item.startsWith("data: "));
            if (!line) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* 心跳等非 JSON 片段忽略 */
            }
          }
        }
      } catch {
        /* abort 后正常退出 */
      }
    })();
  })();
  return { ready, events, close: () => controller.abort() };
}

let tempDir;
let mock;
let gateway;
let server;
let baseUrl;

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comfyui-model-sync-test-"));
  const workflows = path.join(tempDir, "workflows");
  await fsp.mkdir(workflows, { recursive: true });
  for (const file of ["mock-image.json", "mock-image-edit.json", "mock-video.json", "registry.json"]) {
    await fsp.copyFile(path.join(root, "test", "fixtures", file), path.join(workflows, file));
  }
  mock = createMockComfyServer({ port: 0, delayMs: 20, quiet: true });
  await mock.start();
  gateway = await createGatewayApp({
    comfyUrl: mock.url,
    workflowDir: workflows,
    dataDir: path.join(tempDir, "data"),
    outputDir: path.join(tempDir, "data", "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    corsOrigins: ["http://localhost:3000"],
    requestTimeoutMs: 15000,
    watchWorkflows: false,
  });
  server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await gateway.setup.scan();
});

after(async () => {
  if (gateway) {
    await stopGateway({
      tasks: gateway.tasks,
      comfy: gateway.comfy,
      setup: gateway.setup,
      server,
      abortActiveRequests: gateway.abortActiveRequests,
      assistant: gateway.assistant,
    }).catch(() => {});
  }
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await mock?.stop();
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("/v1/models exposes a revision that matches the SSE change sequence", async () => {
  const setupStatus = gateway.setup.status();
  assert.equal(setupStatus.phase, "ready");
  assert.ok(setupStatus.scanId >= 1);
  assert.ok(setupStatus.revision >= 1);

  const first = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.equal(first.object, "list");
  assert.ok(Array.isArray(first.data));
  assert.ok(first.data.some((item) => item.id === "image-mock"));
  assert.equal(typeof first.revision, "number");
  assert.equal(first.setup.scanId, setupStatus.scanId);
  assert.equal(first.setup.revision, setupStatus.revision);
  assert.equal(first.setup.phase, "ready");
  assert.equal(first.setup.scanning, false);
  assert.equal(first.setup.stale, false);
  assert.equal(first.setup.comfyReachable, true);
  assert.equal(first.setup.instanceId, setupStatus.instanceId);
  assert.ok(first.setup.scannedAt);
  assert.equal(first.setup.counts.total, setupStatus.counts.total);

  const stream = openEventStream(`${baseUrl}/api/models/events`);
  await stream.ready;
  await waitFor(() => stream.events.length >= 1);
  assert.equal(stream.events[0].reason, "subscribe");
  const subscribedRevision = stream.events[0].revision;
  assert.equal(subscribedRevision, first.revision);

  const toggled = await fetch(`${baseUrl}/api/workflows/image-mock/visibility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(toggled.status, 200);
  await waitFor(() => stream.events.length >= 2);
  const change = stream.events.at(-1);
  assert.equal(change.reason, "visibility");
  assert.equal(change.revision, subscribedRevision + 1);
  assert.equal(change.scanId, setupStatus.scanId);
  assert.equal(change.setupRevision, setupStatus.revision);
  assert.equal(change.instanceId, setupStatus.instanceId);
  assert.ok(change.updatedAt);
  // SSE 只发变更信号，不推完整模型列表或敏感正文。
  const payload = JSON.stringify(change);
  assert.equal(payload.includes("image-mock"), false);
  assert.equal(payload.includes("mock.safetensors"), false);
  assert.equal("data" in change, false);

  const afterToggle = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.equal(afterToggle.revision, change.revision);
  assert.equal(afterToggle.setup.revision, setupStatus.revision);
  assert.equal(afterToggle.data.some((item) => item.id === "image-mock"), false);

  const restored = await fetch(`${baseUrl}/api/workflows/image-mock/visibility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(restored.status, 200);
  await waitFor(() => stream.events.length >= 3);
  stream.close();
});

test("diagnostics return redacted evidence and explicit not-found codes", async () => {
  const response = await fetch(`${baseUrl}/api/setup/diagnostics?workflowId=image-mock`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.version, fs.readFileSync(path.join(root, "..", "VERSION"), "utf8").trim());
  assert.equal(data.comfy.url, mock.url);
  assert.equal(data.comfy.reachable, true);
  assert.ok(data.setup.scanId >= 1);
  assert.equal(data.setup.phase, "ready");
  assert.equal(data.setup.stale, false);
  assert.ok(data.setup.counts);
  assert.ok(data.setup.problems);
  assert.equal(data.workflow.id, "image-mock");
  assert.equal(data.workflow.available, true);
  const loader = data.workflow.loaders.find((item) => item.classType === "CheckpointLoaderSimple" && item.input === "ckpt_name");
  assert.equal(loader.expected, "mock.safetensors");
  assert.equal(loader.installed, true);
  assert.equal(loader.effective, "mock.safetensors");
  assert.ok(Array.isArray(loader.candidates));
  assert.ok(loader.availability.available);

  const text = JSON.stringify(data);
  assert.equal(text.includes(tempDir), false);
  assert.equal(text.includes("Authorization"), false);
  assert.equal(text.includes("image-mock.json"), false);

  const missingWorkflow = await fetch(`${baseUrl}/api/setup/diagnostics?workflowId=nope`);
  assert.equal(missingWorkflow.status, 404);
  assert.equal((await missingWorkflow.json()).error.code, "workflow_not_found");

  const missingModel = await fetch(`${baseUrl}/api/setup/diagnostics?modelId=nope`);
  assert.equal(missingModel.status, 404);
  assert.equal((await missingModel.json()).error.code, "model_not_found");

  const badPrompt = await fetch(`${baseUrl}/api/setup/diagnostics?promptId=${encodeURIComponent("../etc/passwd")}`);
  assert.equal(badPrompt.status, 400);
  assert.equal((await badPrompt.json()).error.code, "invalid_prompt_id");
});

test("diagnostics extract only whitelisted loader fields from real ComfyUI history", async () => {
  const graph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "C:\\Users\\Secret\\models\\secret.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text: "TOPSECRET prompt body" } },
    3: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
    4: { class_type: "LoraLoader", inputs: { lora_name: "styles\\look.safetensors", strength_model: 1 } },
    5: { class_type: "CustomPromptNode", inputs: { model: "PRIVATE_GENERIC_MODEL_FIELD", text: "PRIVATE_CUSTOM_PROMPT" } },
  };
  const submitted = await fetch(`${mock.url}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "diagnostics-test" }),
  });
  assert.equal(submitted.status, 200);
  const { prompt_id: promptId } = await submitted.json();
  await sleep(120);

  const response = await fetch(`${baseUrl}/api/setup/diagnostics?workflowId=image-mock&promptId=${encodeURIComponent(promptId)}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.execution.promptId, promptId);
  assert.equal(data.execution.completed, true);
  const ckpt = data.execution.nodes.find((node) => node.classType === "CheckpointLoaderSimple");
  assert.equal(ckpt.fields.ckpt_name, "secret.safetensors");
  const unet = data.execution.nodes.find((node) => node.classType === "UNETLoader");
  assert.equal(unet.fields.unet_name, "z_image_turbo_bf16.safetensors");
  assert.equal("weight_dtype" in unet.fields, false);
  const lora = data.execution.nodes.find((node) => node.classType === "LoraLoader");
  assert.equal(lora.fields.lora_name, "styles\\look.safetensors");
  const text = JSON.stringify(data);
  assert.equal(text.includes("TOPSECRET"), false);
  assert.equal(text.includes("PRIVATE_GENERIC_MODEL_FIELD"), false);
  assert.equal(text.includes("PRIVATE_CUSTOM_PROMPT"), false);
  assert.equal(text.includes("C:\\Users"), false);
  assert.equal(text.includes("Secret"), false);
  assert.equal(data.execution.nodes.some((node) => node.classType === "CustomPromptNode"), false);
  assert.equal("prompt" in data.execution, false);
  assert.equal("outputs" in data.execution, false);

  const unknown = await fetch(`${baseUrl}/api/setup/diagnostics?promptId=missing-prompt-id`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "prompt_not_found");
});

test("a changed workflow cannot inherit availability from the previous snapshot", async () => {
  const workflowFile = path.join(tempDir, "workflows", "mock-image.json");
  const original = await fsp.readFile(workflowFile, "utf8");
  try {
    const before = await (await fetch(`${baseUrl}/v1/models`)).json();
    assert.ok(before.data.some((item) => item.id === "image-mock"));

    const workflow = JSON.parse(original);
    workflow["1"].inputs.ckpt_name = "missing-after-edit.safetensors";
    await fsp.writeFile(workflowFile, JSON.stringify(workflow, null, 2), "utf8");

    const historyBefore = Object.keys(await (await fetch(`${mock.url}/history`)).json()).length;
    const after = await (await fetch(`${baseUrl}/v1/models`)).json();
    assert.ok(after.setup.revision > before.setup.revision, "registry change must trigger a fresh setup snapshot");
    const stale = after.data.find((item) => item.id === "image-mock");
    assert.equal(Boolean(stale), false, "a changed, invalid workflow must not reuse old availability");

    const generation = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "image-mock", prompt: "must be blocked", n: 1, response_format: "url" }),
    });
    assert.equal(generation.status, 409);
    const failure = await generation.json();
    assert.ok(["workflow_checking", "workflow_unavailable"].includes(failure.error?.code));
    const historyAfter = Object.keys(await (await fetch(`${mock.url}/history`)).json()).length;
    assert.equal(historyAfter, historyBefore, "blocked generation must never reach ComfyUI");
  } finally {
    await fsp.writeFile(workflowFile, original, "utf8");
    await gateway.setup.scan();
  }
  const recovered = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.ok(recovered.data.some((item) => item.id === "image-mock"));
});

test("a generation entrypoint refreshes a changed workflow before checking availability", async () => {
  const workflowFile = path.join(tempDir, "workflows", "mock-image.json");
  const original = await fsp.readFile(workflowFile, "utf8");
  try {
    const workflow = JSON.parse(original);
    workflow["1"].inputs.ckpt_name = "missing-before-generation.safetensors";
    await fsp.writeFile(workflowFile, JSON.stringify(workflow, null, 2), "utf8");

    const historyBefore = Object.keys(await (await fetch(`${mock.url}/history`)).json()).length;
    const generation = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "image-mock", prompt: "must be blocked", n: 1, response_format: "url" }),
    });
    assert.equal(generation.status, 409);
    const failure = await generation.json();
    assert.ok(["workflow_checking", "workflow_unavailable"].includes(failure.error?.code));
    const historyAfter = Object.keys(await (await fetch(`${mock.url}/history`)).json()).length;
    assert.equal(historyAfter, historyBefore, "the generation route must not submit before rescanning");
  } finally {
    await fsp.writeFile(workflowFile, original, "utf8");
    await gateway.setup.scan();
  }
});

test("importing a workflow broadcasts a new revision and updates models", async () => {
  const stream = openEventStream(`${baseUrl}/api/models/events`);
  await stream.ready;
  await waitFor(() => stream.events.length >= 1);
  const subscribed = stream.events.at(-1).revision;
  const workflow = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mock.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["1", 1] } },
    3: { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    4: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0], seed: 1, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
    5: { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    6: { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "sync-import" } },
  };
  try {
    const imported = await fetch(`${baseUrl}/api/workflows/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "image-sync-imported", type: "image", json: workflow }),
    });
    assert.equal(imported.status, 201);
    const result = await imported.json();
    assert.equal(result.workflow.id, "image-sync-imported");
    await waitFor(() => stream.events.some((event) => event.reason === "registry-import"));
    const event = stream.events.findLast((item) => item.reason === "registry-import");
    assert.ok(event.revision > subscribed);
    const models = await (await fetch(`${baseUrl}/v1/models`)).json();
    assert.equal(models.revision, event.revision);
    assert.ok(models.data.some((model) => model.metadata.workflowId === "image-sync-imported"));
  } finally {
    stream.close();
  }
});
