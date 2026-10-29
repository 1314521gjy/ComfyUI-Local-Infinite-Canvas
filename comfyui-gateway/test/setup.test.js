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

function createAliasManager(dataDir, unetFiles, workflow) {
  const custom = { ...entry, workflow, baseModels: undefined };
  return createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: custom.id }],
      resolve: () => custom,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => objectInfo(unetFiles),
    },
    logger: null,
    mainModelFile: () => "",
  });
}

test("auto-recognizes the same model file in a different subfolder", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-auto-"));
  try {
    const manager = createAliasManager(dataDir, ["zimage/z_image_turbo_bf16.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "zimage/z_image_turbo_bf16.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit alias only applies after the user chooses an installed candidate", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-explicit-"));
  try {
    const manager = createAliasManager(dataDir, ["local_other.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "missing_model.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    const problem = manager.workflowStatus(entry.id).problems.find((item) => item.type === "model");
    assert.ok(problem?.candidates?.includes("local_other.safetensors"));
    await manager.setModelAlias({ classType: "UNETLoader", input: "unet_name", from: "missing_model.safetensors", to: "local_other.safetensors" });
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "missing_model.safetensors"), "local_other.safetensors");
    const saved = JSON.parse(await fsp.readFile(path.join(dataDir, "model-aliases.json"), "utf8"));
    assert.equal(saved.aliases["UNETLoader\u0000unet_name\u0000missing_model.safetensors"], "local_other.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

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

test("a model folder change rescans availability without restarting the gateway", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-folder-poll-"));
  const models = path.join(root, "models", "unet");
  await fsp.mkdir(models, { recursive: true });
  try {
    const manager = createSetupManager({
      config: {
        dataDir: path.join(root, "data"),
        comfyUrl: "http://127.0.0.1:1",
        comfyWorkflowsDir: "",
        maxWorkflowBytes: 1024 * 1024,
        scanDebounceMs: 5,
      },
      registry: {
        list: () => [{ id: entry.id }],
        resolve: () => entry,
        scan: async () => ({ imported: 0 }),
        reloadIfChanged: () => {},
      },
      comfy: {
        systemStats: async () => ({}),
        objectInfo: async () => objectInfo(await fsp.readdir(models)),
        folderPaths: async () => ({ unet: [models], clip: [], vae: [] }),
      },
      logger: null,
      mainModelFile: () => "",
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    assert.equal(manager.pollModelFolders(), false, "nothing changed yet");

    await fsp.writeFile(path.join(models, "z_image_turbo_bf16.safetensors"), "x");
    assert.equal(manager.pollModelFolders(), true, "folder mtime changed");

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(manager.isAvailable(entry.id), true, "rescan activated the workflow");
    assert.equal(manager.pollModelFolders(), false, "signature settled after the rescan");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
