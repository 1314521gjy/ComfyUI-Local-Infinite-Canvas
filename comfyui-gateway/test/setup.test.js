import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSetupManager } from "../src/setup.js";

const entry = {
  id: "image-z-image-turbo",
  name: "image-z-image-turbo",
  type: "image",
  workflow: {
    1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors" } },
    3: { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  },
  baseModels: { param: "unet", classType: "UNETLoader", input: "unet_name", filter: "z-image|z_image" },
};

function objectInfo(unetFiles) {
  return {
    UNETLoader: { input: { required: { unet_name: [unetFiles] } } },
    CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } },
    VAELoader: { input: { required: { vae_name: [["ae.safetensors"]] } } },
  };
}

function createManager(dataDir, unetFiles, mainModelFile = () => "") {
  return createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: entry.id }],
      resolve: () => entry,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => objectInfo(unetFiles),
    },
    logger: null,
    mainModelFile,
  });
}

test("workflow stays available when the default base model is absent but a tier variant is installed", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-base-fallback-"));
  try {
    const manager = createManager(dataDir, ["z_image_turbo_int8_convrot.safetensors"]);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["z_image_turbo_int8_convrot.safetensors"]);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow stays available when a selected main model replaces the missing base", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-main-model-"));
  try {
    const manager = createManager(dataDir, ["my_custom_model.safetensors"], () => "my_custom_model.safetensors");
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow is unavailable when no matching base model is installed", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-base-missing-"));
  try {
    const manager = createManager(dataDir, []);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    assert.ok(manager.workflowStatus(entry.id).problems.some((problem) => problem.type === "model"));
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
