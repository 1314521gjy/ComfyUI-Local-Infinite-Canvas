import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_LOADER_SPECS, discoverModelLoaderSpecs } from "../src/model-loaders.js";

test("discovers third-party model loaders from object_info", () => {
  const specs = discoverModelLoaderSpecs({
    LoraLoaderBypassModelOnly: {
      input: { required: { lora_name: [["style.safetensors", "sub/face.safetensors"], {}] } },
    },
    GGUFLoader: {
      input: { required: { model_name: [["model.gguf"], {}] } },
    },
    // 新版 ComfyUI 的 COMBO 形态。
    LiteLoader: {
      input: { required: { model_name: ["COMBO", { options: ["lite.safetensors"] }] } },
    },
  });
  assert.ok(specs.some((spec) => spec.classType === "LoraLoaderBypassModelOnly" && spec.input === "lora_name"));
  assert.ok(specs.some((spec) => spec.classType === "GGUFLoader" && spec.input === "model_name"));
  assert.ok(specs.some((spec) => spec.classType === "LiteLoader" && spec.input === "model_name"));
  // 静态清单仍然保留。
  assert.ok(specs.some((spec) => spec.classType === "UNETLoader"));
});

test("ignores media and non-file enums", () => {
  const specs = discoverModelLoaderSpecs({
    LoadImage: { input: { required: { image: [["a.png", "b.jpg"], {}] } } },
    KSampler: { input: { required: { sampler_name: [["euler", "dpmpp_2m"], {}] } } },
    SomeLoader: { input: { required: { mode: [["fast", "slow"], {}] } } },
    MixedLoader: { input: { required: { model_name: [["a.safetensors", "not-a-file"], {}] } } },
  });
  assert.equal(specs.some((spec) => spec.classType === "LoadImage"), false);
  assert.equal(specs.some((spec) => spec.classType === "KSampler"), false);
  assert.equal(specs.some((spec) => spec.classType === "SomeLoader"), false);
  assert.equal(specs.some((spec) => spec.classType === "MixedLoader"), false);
});

test("does not duplicate static loader specs", () => {
  const specs = discoverModelLoaderSpecs({
    UNETLoader: { input: { required: { unet_name: [["a.safetensors"], {}] } } },
  });
  const matches = specs.filter((spec) => spec.classType === "UNETLoader" && spec.input === "unet_name");
  assert.equal(matches.length, 1);
  assert.equal(MODEL_LOADER_SPECS.length, 12);
});
