import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBindings, buildContext, secondsToFrames17 } from "../src/bindings.js";

test("MiniMax-H3 length snaps to the 17k+5 grid at 24fps", () => {
  assert.equal(secondsToFrames17(5, 24), 124);
  assert.equal(secondsToFrames17(10, 24), 243);
  assert.equal(secondsToFrames17(1, 24), 39);
});

test("asLink creates LoadImage nodes only when frame images exist", () => {
  const workflow = { 6: { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "x" } } };
  const entry = {
    name: "video-h3-t2v",
    bindings: {
      image: { node: "6", input: "first_frame", from: "image", imageIndex: 0, asLink: true },
      image2: { node: "6", input: "last_frame", from: "image", imageIndex: 1, asLink: true },
    },
  };
  const withFrames = applyBindings(workflow, entry, buildContext({ prompt: "x", uploadedImages: [{ name: "a.png" }, { name: "b.png" }] }));
  assert.deepEqual(withFrames["6"].inputs.first_frame, ["9001", 0]);
  assert.deepEqual(withFrames["6"].inputs.last_frame, ["9002", 0]);
  assert.equal(withFrames["9001"].class_type, "LoadImage");
  assert.equal(withFrames["9002"].inputs.image, "b.png");

  const textOnly = applyBindings(workflow, entry, buildContext({ prompt: "x", uploadedImages: [] }));
  assert.equal(textOnly["6"].inputs.first_frame, undefined);
  assert.equal(textOnly["6"].inputs.last_frame, undefined);
});

test("snap16 aligns image dimensions before validation", () => {
  const workflow = { 7: { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } } };
  const entry = {
    name: "image-snap16",
    bindings: {
      width: { node: "7", input: "width", from: "size.width", transform: "snap16" },
      height: { node: "7", input: "height", from: "size.height", transform: "snap16" },
    },
  };
  const output = applyBindings(workflow, entry, buildContext({ size: "1000x1000" }));
  assert.equal(output["7"].inputs.width, 1008);
  assert.equal(output["7"].inputs.height, 1008);
});

test("custom params override seed, sampler and boolean inputs", () => {
  const workflow = {
    4: { class_type: "KSampler", inputs: { seed: 1, sampler_name: "euler", scheduler: "simple" } },
    32: { class_type: "ApplyVDNH3Advanced", inputs: { fast_kernels: true } },
  };
  const entry = {
    name: "param-test",
    bindings: {
      seed: { node: "4", input: "seed", from: "params.seed", transform: "int", random: true },
      sampler: { node: "4", input: "sampler_name", from: "params.sampler", default: "euler" },
      scheduler: { node: "4", input: "scheduler", from: "params.scheduler", default: "simple" },
      fast_kernels: { node: "32", input: "fast_kernels", from: "params.fast_kernels", default: true, transform: "boolean" },
    },
  };
  const custom = applyBindings(
    workflow,
    entry,
    buildContext({ params: { seed: "42", sampler: "dpmpp_2m", scheduler: "karras", fast_kernels: false } }),
  );
  assert.equal(custom["4"].inputs.seed, 42);
  assert.equal(custom["4"].inputs.sampler_name, "dpmpp_2m");
  assert.equal(custom["4"].inputs.scheduler, "karras");
  assert.equal(custom["32"].inputs.fast_kernels, false);

  const defaults = applyBindings(workflow, entry, buildContext({}));
  assert.ok(defaults["4"].inputs.seed > 0);
  assert.equal(defaults["4"].inputs.sampler_name, "euler");
  assert.equal(defaults["4"].inputs.scheduler, "simple");
  assert.equal(defaults["32"].inputs.fast_kernels, true);
});

test("H3 size snaps to multiples of 32 and reference images map by index", () => {
  const workflow = {
    136: {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        prompt: ["138", 0],
        width: ["115", 0],
        height: ["115", 1],
        length: ["131", 1],
        "ref_images.ref_image_0": ["137", 0],
        "ref_images.ref_image_1": ["139", 0],
      },
    },
  };
  const entry = {
    name: "video-h3-ref2va",
    bindings: {
      prompt: { node: "136", input: "prompt" },
      width: { node: "136", input: "width", from: "size.width", transform: "snap32" },
      height: { node: "136", input: "height", from: "size.height", transform: "snap32" },
      length: { node: "136", input: "length", from: "seconds", transform: "secondsToFrames17", fps: 24 },
      image: { node: "136", input: "ref_images.ref_image_0", from: "image", imageIndex: 0 },
      image2: { node: "136", input: "ref_images.ref_image_1", from: "image", imageIndex: 1 },
      image3: { node: "136", input: "ref_images.ref_image_2", from: "image", imageIndex: 2 },
    },
  };
  const context = buildContext({
    prompt: "a cat walking",
    size: "1280x720",
    seconds: "5",
    count: 1,
    uploadedImages: [{ name: "a.png" }, { name: "b.png" }, { name: "c.png" }],
  });
  const output = applyBindings(workflow, entry, context);
  assert.equal(output["136"].inputs.prompt, "a cat walking");
  assert.equal(output["136"].inputs.width, 1280);
  assert.equal(output["136"].inputs.height, 736);
  assert.equal(output["136"].inputs.length, 124);
  assert.equal(output["136"].inputs["ref_images.ref_image_0"], "a.png");
  assert.equal(output["136"].inputs["ref_images.ref_image_1"], "b.png");
  // 第三张参考图在原工作流里是可选输入，绑定时应能动态补上。
  assert.equal(output["136"].inputs["ref_images.ref_image_2"], "c.png");
});
