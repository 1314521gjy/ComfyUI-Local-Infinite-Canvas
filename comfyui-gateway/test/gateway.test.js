import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createMockComfyServer } from "../mock/comfyui-mock.mjs";
import { createGatewayApp } from "../src/server.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(import.meta.dirname, "..");
let tempDir;
let mock;
let gatewayServer;
let baseUrl;
let mockUrl;

async function copyWorkflows(target) {
  await fsp.mkdir(target, { recursive: true });
  for (const file of ["mock-image.json", "mock-image-edit.json", "mock-video.json", "registry.json"]) {
    await fsp.copyFile(path.join(root, "test", "fixtures", file), path.join(target, file));
  }
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comfyui-gateway-test-"));
  const workflows = path.join(tempDir, "workflows");
  await copyWorkflows(workflows);
  mock = createMockComfyServer({ port: 0, delayMs: 50, quiet: true });
  await mock.start();
  mockUrl = mock.url;
  const { app } = await createGatewayApp({
    comfyUrl: mockUrl,
    workflowDir: workflows,
    dataDir: path.join(tempDir, "data"),
    outputDir: path.join(tempDir, "data", "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    corsOrigins: ["http://localhost:3000"],
    requestTimeoutMs: 15000,
    videoTimeoutMs: 15000,
    pollIntervalMs: 50,
  });
  gatewayServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => gatewayServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => gatewayServer?.close(resolve));
  await mock?.stop();
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("health reports mock ComfyUI and registry", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(data.status, "ok");
  assert.equal(data.comfy.reachable, true);
  assert.equal(data.workflows.count, 3);
});

test("session endpoints expose the canvas lifecycle", async () => {
  const open = await jsonFetch(`${baseUrl}/api/session/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "canvas-test" }),
  });
  assert.equal(open.data.count, 1);
  assert.equal(open.data.seen, true);
  const { data: status } = await jsonFetch(`${baseUrl}/api/session/status`);
  assert.equal(status.count, 1);
  assert.equal(status.activeTasks, 0);
  await jsonFetch(`${baseUrl}/api/session/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "canvas-test" }),
  });
  const { data: closed } = await jsonFetch(`${baseUrl}/api/session/status`);
  assert.equal(closed.count, 0);
  assert.equal(closed.seen, true);
});

test("models list exposes image and video workflows", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  const ids = data.data.map((item) => item.id);
  assert.ok(ids.includes("image-mock"));
  assert.ok(ids.includes("image-mock-edit"));
  assert.ok(ids.includes("video-mock"));
  assert.equal(data.data.find((item) => item.id === "video-mock").metadata.type, "video");
});

test("image generation returns a PNG as b64_json", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "image-mock", prompt: "a blue cat", n: 1, size: "1024x1024", quality: "high", response_format: "b64_json" }),
  });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 1);
  const buffer = Buffer.from(data.data[0].b64_json, "base64");
  assert.ok(buffer.subarray(0, 8).equals(pngSignature));
});

test("image generation fills the requested batch count", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "image-mock", prompt: "three cats", n: 3, size: "1024x1024", response_format: "b64_json" }),
  });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 3);
});

test("image edits accept a multipart reference image", async () => {
  const image = await fsp.readFile(path.join(root, "mock", "assets", "mock.png"));
  const form = new FormData();
  form.set("model", "image-mock-edit");
  form.set("prompt", "make it green");
  form.set("n", "1");
  form.set("size", "1024x1024");
  form.set("response_format", "b64_json");
  form.append("image", new Blob([image], { type: "image/png" }), "ref.png");
  const { response, data } = await jsonFetch(`${baseUrl}/v1/images/edits`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 1);
});

test("video task completes and serves mp4 content", async () => {
  const form = new FormData();
  form.set("model", "video-mock");
  form.set("prompt", "a blue cat walking");
  form.set("seconds", "5");
  form.set("size", "1024x576");
  form.set("mode", "frames");
  form.set("resolution_name", "720p");
  const created = await jsonFetch(`${baseUrl}/v1/videos`, { method: "POST", body: form });
  assert.equal(created.response.status, 200);
  assert.ok(created.data.id);
  let task;
  for (let index = 0; index < 100; index += 1) {
    task = (await jsonFetch(`${baseUrl}/v1/videos/${created.data.id}`)).data;
    if (["completed", "failed", "cancelled"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(task.status, "completed");
  assert.ok(task.url.includes("/files/"));
  const content = await fetch(`${baseUrl}/v1/videos/${created.data.id}/content`);
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-type") || "", /video\/mp4/);
  assert.ok((await content.arrayBuffer()).byteLength > 100);
});

test("workflow import accepts API JSON and rejects UI JSON", async () => {
  const api = await jsonFetch(`${baseUrl}/api/workflows/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      json: { 1: { class_type: "SaveImage", inputs: {} } },
      name: "import-test",
      type: "image",
    }),
  });
  assert.equal(api.response.status, 201);
  assert.equal(api.data.workflow.name, "image-import-test");
  const models = (await jsonFetch(`${baseUrl}/v1/models`)).data.data.map((item) => item.id);
  assert.ok(models.includes("image-import-test"));

  const ui = await jsonFetch(`${baseUrl}/api/workflows/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { nodes: [], links: [] }, name: "ui-test" }),
  });
  assert.equal(ui.response.status, 422);
  assert.equal(ui.data.error.code, "ui_workflow_not_supported");
});

test("schema exposes prompt and size bindings", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/api/workflows/image-mock/schema`);
  assert.equal(response.status, 200);
  const keys = data.schema.fields.map((field) => field.key);
  assert.ok(keys.includes("prompt"));
  assert.ok(keys.includes("width"));
  assert.ok(keys.includes("height"));
});

test("model errors are explicit", async () => {
  const missing = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "missing", prompt: "x" }),
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.error.code, "model_not_found");

  const mismatch = await jsonFetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "video-mock", prompt: "x" }),
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.data.error.code, "model_type_mismatch");
});

test("request cancel endpoint is idempotent for unknown ids", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/api/requests/missing/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.cancelled, false);
});

test("CORS preflight allows the canvas origin", async () => {
  const response = await fetch(`${baseUrl}/v1/models`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
});
