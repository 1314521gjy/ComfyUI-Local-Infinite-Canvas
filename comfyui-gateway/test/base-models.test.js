import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateEntry,
  decorateParameters,
  imageInputCapacity,
  listBaseModels,
  listModelDescriptors,
  resolveBaseModelVariant,
} from "../src/base-models.js";

const entry = {
  id: "image-z-image-turbo",
  name: "image-z-image-turbo",
  workflow: {
    1: { class_type: "UNETLoader", inputs: { unet_name: "z-image-turbo.safetensors" } },
  },
  bindings: { unet: { node: "1", input: "unet_name", from: "params.unet" } },
  parameters: [{ key: "seed", label: "种子", type: "number" }],
  baseModels: { param: "unet", classType: "UNETLoader", label: "底模", filter: "z-image|z_image" },
};

const loaderOptions = {
  UNETLoader: ["z-image-turbo.safetensors", "z_image_bf16.safetensors", "krea2_turbo.safetensors"],
};

test("imageInputCapacity reports how many reference images a workflow consumes", () => {
  assert.equal(imageInputCapacity({ bindings: { refs: { from: "image", array: true, max: 4 } } }), 4);
  assert.equal(imageInputCapacity({ bindings: { frames: { from: "image", frameMode: true, max: 2 } } }), 2);
  assert.equal(imageInputCapacity({ bindings: { image: { from: "image", imageIndex: 0 } } }), 1);
  assert.equal(imageInputCapacity({ bindings: { prompt: { node: "5", input: "text" } } }), 0);
  assert.equal(imageInputCapacity({}), 0);
});

test("listBaseModels filters loader options and keeps stable slugs", () => {
  const variants = listBaseModels(entry, loaderOptions);
  assert.deepEqual(
    variants.map((item) => [item.id, item.file]),
    [
      ["z-image-turbo", "z-image-turbo.safetensors"],
      ["z-image-bf16", "z_image_bf16.safetensors"],
    ]
  );
});

test("base models ignore non-UNet folders and collapse duplicate filenames from multiple roots", () => {
  const krea = { ...entry, baseModels: { ...entry.baseModels, filter: "krea2" } };
  const options = {
    UNETLoader: [
      "Krea2\\a.safetensors",
      "diffusion_models\\Krea2\\a.safetensors",
      "loras\\krea2\\x.safetensors",
      "vae\\krea2\\v.safetensors",
      "krea2_turbo_fp8_scaled.safetensors",
      "diffusion_models\\krea2_turbo_fp8_scaled.safetensors",
      "krea2_turbo_int8_convrot.safetensors",
    ],
  };
  assert.deepEqual(
    listBaseModels(krea, options).map((item) => item.file),
    ["Krea2\\a.safetensors", "krea2_turbo_fp8_scaled.safetensors", "krea2_turbo_int8_convrot.safetensors"],
  );
  const unet = decorateParameters(krea, null, options).find((item) => item.key === "unet");
  assert.deepEqual(unet.options, ["Krea2\\a.safetensors", "krea2_turbo_fp8_scaled.safetensors", "krea2_turbo_int8_convrot.safetensors"]);
});

test("model descriptors expose alternates without duplicating the workflow default", () => {
  const models = listModelDescriptors([entry], loaderOptions);
  assert.equal(models.length, 2);
  assert.equal(models[0].modelId, "image-z-image-turbo");
  assert.equal(models[0].variant, null);
  assert.equal(models[1].modelId, "image-z-image-turbo__z-image-bf16");
  assert.equal(models[1].variant.file, "z_image_bf16.safetensors");
});

test("resolveBaseModelVariant maps a model id back to the base workflow", () => {
  const variant = resolveBaseModelVariant(entry, "image-z-image-turbo__z-image-bf16", loaderOptions);
  assert.equal(variant.file, "z_image_bf16.safetensors");
  assert.equal(variant.modelId, "image-z-image-turbo__z-image-bf16");
  assert.equal(resolveBaseModelVariant(entry, "image-z-image-turbo__missing", loaderOptions), null);
  assert.equal(resolveBaseModelVariant(entry, "krea2__z-image-bf16", loaderOptions), null);
});

test("decorateEntry carries the selected base model as a default parameter", () => {
  const variant = resolveBaseModelVariant(entry, "image-z-image-turbo__z-image-bf16", loaderOptions);
  const decorated = decorateEntry(entry, variant, loaderOptions);
  assert.equal(decorated.name, "image-z-image-turbo__z-image-bf16");
  assert.deepEqual(decorated.baseModelParams, { unet: "z_image_bf16.safetensors" });
  const unet = decorated.parameters.find((item) => item.key === "unet");
  assert.equal(unet.type, "select");
  assert.equal(unet.default, "z_image_bf16.safetensors");
  assert.deepEqual(unet.options, ["z-image-turbo.safetensors", "z_image_bf16.safetensors"]);
});

test("decorateParameters keeps an explicit unet parameter in place", () => {
  const explicit = { ...entry, parameters: [{ key: "unet", label: "模型", type: "select", default: "z_image_bf16.safetensors" }] };
  const parameters = decorateParameters(explicit, null, loaderOptions);
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].key, "unet");
  assert.equal(parameters[0].default, "z_image_bf16.safetensors");
});

test("explicit variants take precedence over loader scanning", () => {
  const explicit = {
    ...entry,
    baseModels: { ...entry.baseModels, variants: [{ id: "turbo", label: "Turbo", file: "custom.safetensors" }] },
  };
  const variants = listBaseModels(explicit, loaderOptions);
  assert.deepEqual(variants.map((item) => [item.id, item.label, item.file]), [["turbo", "Turbo", "custom.safetensors"]]);
});

test("short prefixes and aliases produce compact model ids", () => {
  const prefixed = {
    ...entry,
    type: "image",
    baseModels: {
      ...entry.baseModels,
      prefix: "zit",
      aliases: {
        "z_image_bf16.safetensors": "bf16",
        "Z-image-ZiT-moodyPornMix_zitV7-fp8.safetensors": "moody",
      },
    },
  };
  const models = listModelDescriptors([prefixed], {
    UNETLoader: [...loaderOptions.UNETLoader, "Z-image-ZiT-moodyPornMix_zitV7-fp8.safetensors"],
  });
  assert.deepEqual(models.map((model) => model.modelId), ["image-z-image-turbo", "img-zit-bf16", "img-zit-moody"]);
  const variant = resolveBaseModelVariant(prefixed, "img-zit-bf16", loaderOptions);
  assert.equal(variant.file, "z_image_bf16.safetensors");
  assert.equal(variant.modelId, "img-zit-bf16");
});

test("video workflows use the vid prefix", () => {
  const video = {
    ...entry,
    id: "video-h3-t2v",
    name: "video-h3-t2v",
    type: "video",
    baseModels: { ...entry.baseModels, prefix: "h3" },
  };
  const models = listModelDescriptors([video], loaderOptions);
  assert.equal(models[1].modelId, "vid-h3-z-image-bf16");
});

test("descriptors skip a missing default base model and keep installed alternates", () => {
  const models = listModelDescriptors([entry], { UNETLoader: ["z_image_int8.safetensors"] });
  assert.deepEqual(models.map((model) => model.modelId), ["image-z-image-turbo__z-image-int8"]);
  assert.equal(models[0].variant.file, "z_image_int8.safetensors");
  assert.equal(listModelDescriptors([entry], { UNETLoader: [] }).length, 0);
});
