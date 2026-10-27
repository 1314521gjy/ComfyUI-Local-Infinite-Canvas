import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMainModelStore } from "../src/main-models.js";
import { createRegistry } from "../src/registry.js";

test("main model selection persists per pack and resolves per workflow", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "main-models-store-"));
  try {
    const store = createMainModelStore({ dataDir });
    await store.load();
    await store.set("krea2", { file: "my_krea2_finetune.safetensors", workflows: ["image-krea2-turbo"] });
    assert.equal(store.fileForPack("krea2"), "my_krea2_finetune.safetensors");
    assert.equal(store.fileForWorkflow("image-krea2-turbo"), "my_krea2_finetune.safetensors");

    const reloaded = createMainModelStore({ dataDir });
    await reloaded.load();
    assert.equal(reloaded.fileForPack("krea2"), "my_krea2_finetune.safetensors");
    assert.equal(reloaded.fileForWorkflow("image-krea2-turbo"), "my_krea2_finetune.safetensors");

    await reloaded.set("krea2", { file: "", workflows: ["image-krea2-turbo"] });
    assert.equal(reloaded.fileForPack("krea2"), "");
    assert.equal(reloaded.fileForWorkflow("image-krea2-turbo"), "");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("selected main model becomes the workflow default and replaces a duplicate base variant", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "main-models-registry-"));
  try {
    await fsp.writeFile(
      path.join(dir, "registry.json"),
      JSON.stringify({
        version: 1,
        workflows: [
          {
            id: "image-krea2-turbo",
            name: "image-krea2-turbo",
            type: "image",
            file: "krea2.json",
            bindings: { unet: { node: "1", input: "unet_name", from: "params.unet", default: "krea2_default.safetensors" } },
            baseModels: {
              param: "unet",
              classType: "UNETLoader",
              input: "unet_name",
              filter: "krea2",
              prefix: "k2t",
            },
          },
        ],
      }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(dir, "krea2.json"),
      JSON.stringify({ 1: { class_type: "UNETLoader", inputs: { unet_name: "krea2_default.safetensors" } } }),
      "utf8",
    );

    const registry = createRegistry({
      dir,
      mainModelFile: (id) => (id === "image-krea2-turbo" ? "my_krea2_finetune.safetensors" : ""),
    });
    await registry.load();
    const loaderOptions = { UNETLoader: ["my_krea2_finetune.safetensors"] };
    const models = registry.listModels(loaderOptions);
    const plain = models.filter((model) => model.modelId === "image-krea2-turbo");
    assert.equal(plain.length, 1);
    assert.deepEqual(plain[0].entry.baseModelParams, { unet: "my_krea2_finetune.safetensors" });
    assert.equal(models.some((model) => model.modelId === "img-k2t-my-krea2-finetune"), false);

    const resolved = registry.resolveModel("image-krea2-turbo", loaderOptions);
    assert.deepEqual(resolved.entry.baseModelParams, { unet: "my_krea2_finetune.safetensors" });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
