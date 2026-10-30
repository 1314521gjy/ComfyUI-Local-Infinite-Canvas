import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyFreeInputs, createFreeWorkflowStore } from "../src/free-workflows.js";
import { convertUiWorkflow, detectFreeBindings } from "../src/ui-workflow.js";

const objectInfo = {
  CLIPLoader: { input: { required: { clip_name: [["clip.safetensors"], {}], type: [["stable_diffusion"], {}] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP", {}] } } },
  EmptyLatentImage: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } } },
  KSampler: { input: { required: { model: ["MODEL", {}], seed: ["INT", {}], steps: ["INT", {}], cfg: ["FLOAT", {}], sampler_name: [["euler"], {}], scheduler: [["simple"], {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}], denoise: ["FLOAT", {}] } } },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } } },
  SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } } },
  LoadImage: { input: { required: { image: [["input.png"], { image_upload: true }] } } },
  ImageScale: { input: { required: { image: ["IMAGE", {}], width: ["INT", {}], height: ["INT", {}] } } },
  ResolutionSelector: {
    input: {
      required: {
        aspect_ratio: ["COMBO", { options: ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "4:3 (Standard)"] }],
        megapixels: ["FLOAT", {}],
        multiple: ["INT", {}],
      },
    },
  },
  VHS_VideoCombine: {
    input: {
      required: {
        images: ["IMAGE", {}],
        frame_rate: ["FLOAT", {}],
        loop_count: ["INT", {}],
        filename_prefix: ["STRING", {}],
        format: [["video/h264-mp4"], {}],
        pingpong: ["BOOLEAN", {}],
        save_output: ["BOOLEAN", {}],
      },
    },
  },
  TestCombo: {
    input: {
      required: {
        task_type: ["COMBO", { options: ["auto", "Ref2VA", "I2VA"] }],
        value: ["STRING", {}],
      },
    },
  },
  SaveVideo: {
    input: {
      required: {
        video: ["VIDEO", {}],
        filename_prefix: ["STRING", {}],
        format: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "auto" }] }],
      },
    },
  },
};

function uiNode(id, type, inputs, widgetsValuesNamed, mode = 0) {
  return {
    id,
    type,
    mode,
    inputs: inputs.map(([name, type, link]) => ({ name, type, link: link ?? null, ...(link == null ? { widget: { name } } : {}) })),
    outputs: type === "SaveImage" ? [] : [{ name: "OUT", type: "IMAGE" }],
    widgets_values_named: widgetsValuesNamed,
    widgets_values: Object.values(widgetsValuesNamed || {}),
  };
}

test("UI workflow conversion keeps widgets, links and resolves bypass", () => {
  const ui = {
    nodes: [
      uiNode(1, "LoadImage", [["image", "COMBO", null]], { image: "input.png" }),
      uiNode(2, "ImageScale", [["image", "IMAGE", 1], ["width", "INT", null], ["height", "INT", null]], { width: 512, height: 512 }, 4),
      uiNode(3, "SaveImage", [["images", "IMAGE", 2], ["filename_prefix", "STRING", null]], { filename_prefix: "out" }),
    ],
    links: [
      [1, 1, 0, 2, 0, "IMAGE"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["1"].inputs.image, "input.png");
  assert.deepEqual(result.workflow["3"].inputs.images, ["1", 0]);
  assert.equal(result.workflow["3"].inputs.filename_prefix, "out");
});

test("UI conversion maps VHS widgets and normalizes display labels", () => {
  const ui = {
    nodes: [
      {
        id: 1,
        type: "VHS_VideoCombine",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: null }],
        widgets_values: [24, 0, "video/out", "video/h264-mp4", false, true],
      },
      {
        id: 2,
        type: "TestCombo",
        mode: 0,
        inputs: [
          { name: "task_type", type: "COMBO", link: null, widget: { name: "task_type" } },
          { name: "value", type: "STRING", link: null, widget: { name: "value" } },
        ],
        widgets_values_named: { task_type: "Ref2VA — 参考生音视频", value: "x" },
      },
      {
        id: 3,
        type: "SaveVideo",
        mode: 0,
        inputs: [{ name: "video", type: "VIDEO", link: null }],
        widgets_values: ["video/out", "auto"],
      },
    ],
    links: [],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["1"].inputs.frame_rate, 24);
  assert.equal(result.workflow["1"].inputs.loop_count, 0);
  assert.equal(result.workflow["1"].inputs.filename_prefix, "video/out");
  assert.equal(result.workflow["1"].inputs.format, "video/h264-mp4");
  assert.equal(result.workflow["1"].inputs.pingpong, false);
  assert.equal(result.workflow["1"].inputs.save_output, true);
  assert.equal(result.workflow["2"].inputs.task_type, "Ref2VA");
  assert.equal(result.workflow["3"].inputs.filename_prefix, "video/out");
  assert.equal(result.workflow["3"].inputs.format, "auto");
});

test("binding detection finds prompt, size, batch, seed, image and output type", () => {
  const workflow = {
    1: { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["9", 0] } },
    2: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 768, batch_size: 2 } },
    3: { class_type: "KSampler", inputs: { model: ["8", 0], seed: 42, steps: 10, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["1", 0], negative: ["1", 0], latent_image: ["2", 0], denoise: 1 } },
    4: { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["8", 1] } },
    5: { class_type: "LoadImage", inputs: { image: "input.png" } },
    6: { class_type: "ImageScale", inputs: { image: ["5", 0], width: 512, height: 512 } },
    7: { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "out" } },
    10: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "ref" } },
  };
  const bindings = detectFreeBindings(workflow);
  assert.equal(bindings.outputType, "image");
  assert.deepEqual(bindings.prompt, { node: "1", input: "text" });
  assert.equal(bindings.images.length, 1);
  assert.equal(bindings.images[0].node, "5");
  assert.equal(bindings.sizes[0].node, "2");
  assert.equal(bindings.batches[0].default, 2);
  assert.equal(bindings.seeds[0].default, 42);
});

test("binding detection exposes every text input and prefers the positive primitive", () => {
  const info = {
    ...objectInfo,
    PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } } },
  };
  const workflow = {
    10: { class_type: "PrimitiveStringMultiline", inputs: { value: "positive text" }, _meta: { title: "提示词" } },
    11: { class_type: "CLIPTextEncode", inputs: { text: ["10", 0], clip: ["20", 0] } },
    12: { class_type: "CLIPTextEncode", inputs: { text: "negative text", clip: ["20", 0] }, _meta: { title: "负面提示词" } },
    13: { class_type: "KSampler", inputs: { seed: 1, model: ["20", 0], positive: ["11", 0], negative: ["12", 0] } },
    14: { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: "out" } },
    20: { class_type: "UNETLoader", inputs: { unet_name: "safe.safetensors" } },
  };
  const bindings = detectFreeBindings(workflow, info);
  assert.deepEqual(bindings.prompt, { node: "10", input: "value" });
  assert.deepEqual(bindings.textInputs.map((item) => [item.node, item.input, item.label, item.role]), [
    ["10", "value", "提示词", "positive"],
    ["12", "text", "负面提示词", "negative"],
  ]);
  const patched = applyFreeInputs(workflow, bindings, {
    prompt: "new positive",
    texts: [
      { node: "10", input: "value", value: "new positive" },
      { node: "12", input: "text", value: "new negative" },
      { node: "20", input: "unet_name", value: "evil.safetensors" },
    ],
  });
  assert.equal(patched[10].inputs.value, "new positive");
  assert.equal(patched[12].inputs.text, "new negative");
  assert.equal(patched[20].inputs.unet_name, "safe.safetensors");
});

test("free inputs patch the workflow and randomize seed when not fixed", () => {
  const workflow = { 1: { class_type: "CLIPTextEncode", inputs: { text: "old" } }, 2: { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } }, 3: { class_type: "KSampler", inputs: { seed: 42 } } };
  const bindings = {
    prompt: { node: "1", input: "text" },
    images: [],
    sizes: [{ node: "2", widthInput: "width", heightInput: "height" }],
    batches: [{ node: "2", input: "batch_size" }],
    seeds: [{ node: "3", input: "seed" }],
  };
  const patched = applyFreeInputs(workflow, bindings, { prompt: "new", size: { width: 1024, height: 768 }, count: 3, seedFixed: false });
  assert.equal(patched[1].inputs.text, "new");
  assert.equal(patched[2].inputs.width, 1024);
  assert.equal(patched[2].inputs.batch_size, 3);
  assert.notEqual(patched[3].inputs.seed, 42);
  const fixed = applyFreeInputs(workflow, bindings, { prompt: "new", seed: "123", seedFixed: true });
  assert.equal(fixed[3].inputs.seed, 123);
});

test("resolution selector aspect ratio is detected and patched", () => {
  const workflow = {
    1: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 1, multiple: 32 } },
    2: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
  };
  const bindings = detectFreeBindings(workflow, objectInfo);
  assert.equal(bindings.ratios.length, 1);
  assert.equal(bindings.ratios[0].node, "1");
  assert.ok(bindings.ratios[0].ratios.includes("16:9"));
  assert.ok(bindings.ratios[0].ratios.includes("9:16"));
  const patched = applyFreeInputs(workflow, bindings, { ratio: "9:16" });
  assert.equal(patched[1].inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
  const unchanged = applyFreeInputs(workflow, bindings, { ratio: "auto" });
  assert.equal(unchanged[1].inputs.aspect_ratio, "16:9 (Widescreen)");
});

test("free workflow store deletes entries and persists", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "free-workflows-"));
  try {
    const entry = {
      id: "fc-delete",
      name: "Delete me",
      sourceRel: "test.json",
      sourceFormat: "api",
      workflow: { 1: { class_type: "Test", inputs: {} } },
      bindings: { outputType: "image", prompt: null, images: [], sizes: [], ratios: [], batches: [], seeds: [] },
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dataDir, "free-workflows.json"), JSON.stringify({ version: 1, workflows: [entry] }));

    const first = createFreeWorkflowStore({ dataDir, comfy: {} });
    await first.load();
    assert.equal(first.get("fc-delete")?.name, "Delete me");
    assert.equal((await first.rename("fc-delete", "  Renamed   Card  "))?.name, "Renamed Card");
    await assert.rejects(() => first.rename("fc-delete", "   "), /名称不能为空/);
    assert.equal((await first.remove("fc-delete"))?.id, "fc-delete");
    assert.equal(first.get("fc-delete"), null);
    assert.equal(await first.remove("missing"), null);

    const second = createFreeWorkflowStore({ dataDir, comfy: {} });
    await second.load();
    assert.equal(second.get("fc-delete"), null);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("orphan nodes are pruned before submission so they cannot fail validation", () => {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
    "99": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "missing.safetensors" } },
    "98": { class_type: "LoraLoader", inputs: { model: ["99", 0], lora_name: "missing.safetensors", strength_model: 1, strength_clip: 1 } },
  };
  const next = applyFreeInputs(workflow, {}, { prompt: "p" });
  assert.deepEqual(Object.keys(next).sort(), ["1", "2"]);
  assert.equal(next["99"], undefined);
  assert.equal(next["98"], undefined);

  const noOutputs = { "1": { class_type: "LoadImage", inputs: { image: "a.png" } } };
  assert.deepEqual(applyFreeInputs(noOutputs, {}, { prompt: "p" }), noOutputs);
});

test("a stray SaveImage chain is dropped in favour of the main output", () => {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "KSampler", inputs: { model: ["3", 0], latent_image: ["4", 0], seed: 1 } },
    "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "main.safetensors" } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["2", 0], vae: ["3", 1] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "main" } },
    "90": { class_type: "SaveImage", inputs: { images: ["91", 0], filename_prefix: "stray" } },
    "91": { class_type: "VAEDecode", inputs: { samples: ["92", 0], vae: ["93", 0] } },
    "92": { class_type: "KSampler", inputs: { model: ["93", 0], latent_image: ["94", 0], seed: 2 } },
    "93": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "missing.safetensors" } },
    "94": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  };
  const next = applyFreeInputs(workflow, {}, { prompt: "p" });
  assert.equal(next["6"]?.class_type, "SaveImage", "main output kept");
  assert.equal(next["90"], undefined, "stray save dropped");
  assert.equal(next["93"], undefined, "stray model loader dropped");
  assert.equal(next["1"], undefined, "unused LoadImage dropped");
  assert.equal(Object.keys(next).length, 5);
});

test("UI conversion skips frontend-only group control nodes", () => {
  const ui = {
    nodes: [
      uiNode(1, "SaveImage", [["images", "IMAGE", null], ["filename_prefix", "STRING", null]], { filename_prefix: "out" }),
      { id: 2, type: "BanZhang_IgnoreGroups", mode: 0, inputs: [], outputs: [], widgets_values: [] },
    ],
    links: [],
  };
  const result = convertUiWorkflow(ui, objectInfo);
  assert.equal(result.workflow["2"], undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("UI 辅助节点")));
});
