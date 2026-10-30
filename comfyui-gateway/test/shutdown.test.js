import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createMockComfyServer } from "../mock/comfyui-mock.mjs";
import { createGatewayApp, stopGateway } from "../src/server.js";

process.env.DISABLE_NODE_BOOTSTRAP = "1";

const root = path.resolve(import.meta.dirname, "..");
let tempDir;
let mock;
let app;
let gatewayServer;
let baseUrl;
let tasks;
let comfy;
let setup;
let abortActiveRequests;

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

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

before(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comfyui-shutdown-test-"));
  const workflows = path.join(tempDir, "workflows");
  await copyWorkflows(workflows);
  mock = createMockComfyServer({ port: 0, delayMs: 60000, quiet: true });
  await mock.start();
  const created = await createGatewayApp({
    comfyUrl: mock.url,
    workflowDir: workflows,
    dataDir: path.join(tempDir, "data"),
    outputDir: path.join(tempDir, "data", "outputs"),
    publicBaseUrl: "http://127.0.0.1:18199",
    corsOrigins: ["http://localhost:3000"],
    requestTimeoutMs: 15000,
    videoTimeoutMs: 0,
    pollIntervalMs: 50,
  });
  app = created.app;
  tasks = created.tasks;
  comfy = created.comfy;
  setup = created.setup;
  abortActiveRequests = created.abortActiveRequests;
  gatewayServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => gatewayServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;
});

after(async () => {
  try {
    await stopGateway({ tasks, comfy, setup, server: gatewayServer, abortActiveRequests });
  } catch {
    /* 失败清理不覆盖测试结论 */
  }
  if (gatewayServer?.listening) await new Promise((resolve) => gatewayServer.close(resolve));
  await mock?.stop();
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("shutdown endpoint refuses to run without a host process", async () => {
  const { response, data } = await jsonFetch(`${baseUrl}/api/system/shutdown`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal(data.error.code, "shutdown_unavailable");
});

test("shutdown cancels the in-flight ComfyUI prompt before exiting", async () => {
  const form = new FormData();
  form.set("model", "video-mock");
  form.set("prompt", "a long blue cat walking");
  form.set("seconds", "5");
  form.set("size", "1024x576");
  form.set("mode", "frames");
  form.set("resolution_name", "720p");
  const created = await jsonFetch(`${baseUrl}/v1/videos`, { method: "POST", body: form });
  assert.equal(created.response.status, 200);

  const received = await waitFor(() => mock.runs.size > 0);
  assert.ok(received, "mock ComfyUI should receive a prompt");
  const promptId = [...mock.runs.keys()][0];
  const running = await waitFor(() => tasks.get(created.data.id)?.status === "running" && tasks.get(created.data.id)?.promptId === promptId);
  assert.ok(running, "gateway task should be running with the ComfyUI prompt id");

  let markStopped;
  const stopped = new Promise((resolve) => {
    markStopped = resolve;
  });
  app.locals.requestShutdown = () => {
    void stopGateway({ tasks, comfy, setup, server: gatewayServer, abortActiveRequests }).finally(markStopped);
  };

  const { response, data } = await jsonFetch(`${baseUrl}/api/system/shutdown`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  await stopped;

  assert.ok(
    mock.cancelRequests.some((entry) => entry.type === "queue" && entry.body?.delete?.includes(promptId)),
    "ComfyUI queue delete should include the prompt id",
  );
  assert.ok(
    mock.cancelRequests.some((entry) => entry.type === "interrupt" && entry.body?.prompt_id === promptId),
    "ComfyUI interrupt should include the prompt id",
  );
  const settled = await waitFor(() => {
    const task = tasks.get(created.data.id);
    return task && ["cancelled", "failed"].includes(task.status);
  });
  assert.ok(settled, "task should not stay running after shutdown");
});
