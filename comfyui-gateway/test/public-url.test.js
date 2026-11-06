import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { absoluteTaskUrl, requestBaseUrl } from "../src/public-url.js";
import { createTaskStore } from "../src/tasks.js";

const config = {
  host: "127.0.0.1",
  port: 8190,
  publicBaseUrl: "http://127.0.0.1:8190",
  publicBaseUrlExplicit: false,
};

test("forwarded headers derive the public https origin", () => {
  const req = {
    headers: {
      host: "127.0.0.1:8190",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "canvas.example.com",
    },
  };
  assert.equal(requestBaseUrl(config, req), "https://canvas.example.com");
  assert.equal(absoluteTaskUrl(config, req, "/files/demo.mp4"), "https://canvas.example.com/files/demo.mp4");
  assert.equal(absoluteTaskUrl(config, req, "http://127.0.0.1:8190/files/demo.mp4"), "https://canvas.example.com/files/demo.mp4");
});

test("a forwarded proto with a public Host also derives https", () => {
  const req = { headers: { host: "canvas.example.com", "x-forwarded-proto": "https" } };
  assert.equal(requestBaseUrl(config, req), "https://canvas.example.com");
});

test("local direct requests keep the configured loopback URL", () => {
  assert.equal(requestBaseUrl(config, { headers: { host: "127.0.0.1:8190" } }), "http://127.0.0.1:8190");
  assert.equal(requestBaseUrl(config, { headers: { host: "localhost:8190" } }), "http://127.0.0.1:8190");
});

test("an explicit PUBLIC_BASE_URL wins when there are no forwarded headers", () => {
  const explicit = { ...config, publicBaseUrl: "https://cdn.example.com", publicBaseUrlExplicit: true };
  assert.equal(requestBaseUrl(explicit, { headers: { host: "127.0.0.1:8190" } }), "https://cdn.example.com");
});

test("loadConfig records whether PUBLIC_BASE_URL was explicit", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-public-url-"));
  try {
    const loaded = loadConfig({
      publicBaseUrl: "https://cdn.example.com",
      dataDir: path.join(tempDir, "data"),
      outputDir: path.join(tempDir, "data", "outputs"),
      workflowDir: path.join(tempDir, "workflows"),
    });
    assert.equal(loaded.publicBaseUrl, "https://cdn.example.com");
    assert.equal(loaded.publicBaseUrlExplicit, true);
    assert.equal(requestBaseUrl(loaded, { headers: {} }), "https://cdn.example.com");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task files are stored and persisted as relative /files URLs", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-relative-url-"));
  try {
    const store = createTaskStore({ dataDir });
    const saved = await store.saveOutput("task_relative", Buffer.from("video"), "mp4");
    assert.equal(saved.url, "/files/task_relative.mp4");
    const task = store.create({ model: "test" });
    task.status = "completed";
    task.file = saved.file;
    task.url = saved.url;
    assert.equal(store.publicTask(task).url, "/files/task_relative.mp4");
    await store.persistNow();
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "tasks.json"), "utf8"));
    assert.equal(persisted.tasks[0].url, "/files/task_relative.mp4");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loading an old absolute task URL normalizes it to a relative path", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-old-url-"));
  try {
    const outputDir = path.join(dataDir, "outputs");
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, "old.mp4");
    fs.writeFileSync(file, "old-video");
    fs.writeFileSync(
      path.join(dataDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "task_old",
            status: "completed",
            file,
            url: "http://127.0.0.1:8190/files/old.mp4",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const store = createTaskStore({ dataDir });
    await store.load();
    assert.equal(store.get("task_old").url, "/files/old.mp4");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
