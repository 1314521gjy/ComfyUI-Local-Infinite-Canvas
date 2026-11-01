import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createMockComfyServer } from "../mock/comfyui-mock.mjs";
import { loadConfig } from "../src/config.js";
import { createGatewayApp, stopGateway } from "../src/server.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(import.meta.dirname, "..");
const token = "test-gateway-token";
let tempDir;
let mock;
let gateway;
let server;
let baseUrl;

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comfyui-security-test-"));
  const workflows = path.join(tempDir, "workflows");
  await fsp.mkdir(workflows, { recursive: true });
  for (const file of ["mock-image.json", "mock-image-edit.json", "mock-video.json", "registry.json"]) {
    await fsp.copyFile(path.join(root, "test", "fixtures", file), path.join(workflows, file));
  }
  mock = createMockComfyServer({ port: 0, delayMs: 10, quiet: true });
  await mock.start();
  gateway = await createGatewayApp({
    allowRemote: true,
    gatewayToken: token,
    comfyUrl: mock.url,
    workflowDir: workflows,
    dataDir: path.join(tempDir, "data"),
    outputDir: path.join(tempDir, "data", "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    corsOrigins: ["http://localhost:3000"],
    maxUploadBytes: 64,
    maxTotalUploadBytes: 96,
  });
  server = gateway.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test("remote opt-in stays compatible while local default stays open", () => {
  const paths = (name) => ({
    workflowDir: path.join(tempDir, name, "workflows"),
    dataDir: path.join(tempDir, name, "data"),
    outputDir: path.join(tempDir, name, "outputs"),
  });
  const remoteWithoutToken = loadConfig({ ...paths("remote-open"), host: "0.0.0.0", allowRemote: true, gatewayToken: "" });
  assert.equal(remoteWithoutToken.gatewayToken, "");
  const local = loadConfig({ ...paths("local"), host: "127.0.0.1", allowRemote: false, gatewayToken: "" });
  assert.equal(local.gatewayToken, "");
  assert.equal(local.maxUploadBytes, 512 * 1024 * 1024);
  assert.equal(local.maxTotalUploadBytes, 768 * 1024 * 1024);
  const remote = loadConfig({ ...paths("remote"), host: "0.0.0.0", allowRemote: true, gatewayToken: token });
  assert.equal(remote.gatewayToken, token);
});

test("health, generation and media stay compatible while management routes accept token auth", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const preflight = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-gateway-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /x-gateway-token/i);

  for (const pathname of ["/api/tasks", "/admin"]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 401, pathname);
    assert.equal((await response.json()).error.code, "unauthorized");
  }
  assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/files/missing.png`)).status, 404);
  const headerAuth = await fetch(`${baseUrl}/api/tasks`, { headers: { "x-gateway-token": token } });
  assert.equal(headerAuth.status, 200);
  const bearerAuth = await fetch(`${baseUrl}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(bearerAuth.status, 200);
});

test("setup diagnostics require the management token and never echo secrets or local paths", async () => {
  const anonymous = await fetch(`${baseUrl}/api/setup/diagnostics`);
  assert.equal(anonymous.status, 401);

  const response = await fetch(`${baseUrl}/api/setup/diagnostics?workflowId=image-mock`, {
    headers: { "x-gateway-token": token },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.ok(data.version);
  assert.equal(data.comfy.url, mock.url);
  for (const key of ["scanId", "revision", "phase", "scanning", "stale", "comfyReachable", "counts", "lastError"]) {
    assert.ok(key in data.setup, key);
  }
  assert.equal(data.workflow.id, "image-mock");
  assert.ok(Array.isArray(data.workflow.loaders));

  const text = JSON.stringify(data);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(tempDir), false);
  assert.equal(text.toLowerCase().includes("authorization"), false);
  assert.equal(text.includes("workflows\\\\"), false);

  const status = await (await fetch(`${baseUrl}/api/setup/status`, { headers: { "x-gateway-token": token } })).json();
  for (const key of ["scanId", "revision", "phase", "scanning", "stale", "comfyReachable", "scannedAt", "counts", "lastError"]) {
    assert.ok(key in status.status, key);
  }
});

test("multipart files share a per-request total byte budget with a clear 413", async () => {
  const form = new FormData();
  form.set("model", "image-mock-edit");
  form.set("prompt", "test");
  form.append("image", new Blob([Buffer.alloc(60, 1)], { type: "image/png" }), "one.png");
  form.append("image2", new Blob([Buffer.alloc(60, 2)], { type: "image/png" }), "two.png");
  const response = await fetch(`${baseUrl}/v1/images/edits`, {
    method: "POST",
    headers: { "x-gateway-token": token },
    body: form,
  });
  assert.equal(response.status, 413);
  const data = await response.json();
  assert.equal(data.error.code, "upload_total_too_large");
  assert.match(data.error.message, /总大小/);
});
