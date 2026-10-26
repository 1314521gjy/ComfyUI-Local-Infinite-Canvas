import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFreeInputs } from "../src/free-workflows.js";
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
