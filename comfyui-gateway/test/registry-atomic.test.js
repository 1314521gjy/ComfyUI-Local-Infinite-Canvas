import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRegistry } from "../src/registry.js";

function workflow(text) {
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mock.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text, clip: ["1", 1] } },
    3: { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "atomic" } },
  };
}

test("registry reload swaps a complete cache and never exposes a partial load", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-atomic-"));
  const file = path.join(dir, "image-atomic.json");
  const payload = "x".repeat(4 * 1024 * 1024);
  const registry = createRegistry({ dir, maxWorkflowBytes: 6 * 1024 * 1024, logger: null });
  try {
    await fsp.writeFile(file, JSON.stringify(workflow(payload)), "utf8");
    await fsp.writeFile(
      path.join(dir, "registry.json"),
      JSON.stringify({ version: 1, workflows: [{ id: "image-atomic", name: "image-atomic", type: "image", file: "image-atomic.json" }] }),
      "utf8",
    );
    await registry.load();
    assert.equal(registry.list().length, 1);
    assert.equal(await registry.reloadIfChanged(), false);

    await fsp.writeFile(file, JSON.stringify(workflow(`${payload}y`)), "utf8");
    let polling = true;
    const observed = [];
    const poller = (async () => {
      while (polling) {
        observed.push(registry.list().length);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const changed = await registry.reloadIfChanged();
    polling = false;
    await poller;

    assert.equal(changed, true);
    assert.deepEqual([...new Set(observed)], [1]);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.resolve("image-atomic")?.workflow?.[2]?.inputs?.text, `${payload}y`);

    await fsp.writeFile(path.join(dir, "registry.json"), "{invalid", "utf8");
    assert.equal(await registry.reloadIfChanged(), false);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.resolve("image-atomic")?.workflow?.[2]?.inputs?.text, `${payload}y`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
