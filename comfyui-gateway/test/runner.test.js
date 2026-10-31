import assert from "node:assert/strict";
import { test } from "node:test";

import { buildContext } from "../src/bindings.js";
import { runImage, runVideo, runWorkflow } from "../src/runner.js";

function entry() {
  return {
    name: "runner-test",
    type: "image",
    workflow: { 1: { class_type: "Test", inputs: {} } },
    bindings: {},
    defaults: {},
    presets: {},
  };
}

test("a selected main model replaces the workflow UNET file", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-main-model",
    type: "image",
    workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } } },
    bindings: {},
    defaults: {},
    presets: {},
    mainModelFile: "my_custom_model.safetensors",
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
  });
  assert.equal(submitted["1"].inputs.unet_name, "my_custom_model.safetensors");
});

test("model aliases rewrite loader inputs before submit", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-model-alias",
    type: "image",
    workflow: {
      1: { class_type: "UNETLoader", inputs: { unet_name: "missing_model.safetensors" } },
      2: { class_type: "CLIPLoader", inputs: { clip_name: "keep.safetensors" } },
    },
    bindings: {},
    defaults: {},
    presets: {},
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor: (classType, input, value) => (classType === "UNETLoader" && value === "missing_model.safetensors" ? "local_subdir/model.safetensors" : ""),
  });
  assert.equal(submitted["1"].inputs.unet_name, "local_subdir/model.safetensors");
  assert.equal(submitted["2"].inputs.clip_name, "keep.safetensors");
});

test("dynamically discovered loaders also receive model aliases", async () => {
  let submitted = null;
  const runEntry = {
    name: "runner-dynamic-alias",
    type: "image",
    workflow: {
      1: { class_type: "llama_cpp_model_loader", inputs: { model: "expected-model.gguf", mmproj: "expected-mmproj.gguf" } },
    },
    bindings: {},
    defaults: {},
    presets: {},
  };
  await runWorkflow({
    entry: runEntry,
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submitted = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor: (classType, input, value) => {
      if (classType !== "llama_cpp_model_loader") return "";
      if (input === "model" && value === "expected-model.gguf") return "local-model.gguf";
      if (input === "mmproj" && value === "expected-mmproj.gguf") return "local-mmproj.gguf";
      return "";
    },
    loaderSpecs: [
      { classType: "llama_cpp_model_loader", input: "model" },
      { classType: "llama_cpp_model_loader", input: "mmproj" },
    ],
  });
  assert.equal(submitted["1"].inputs.model, "local-model.gguf");
  assert.equal(submitted["1"].inputs.mmproj, "local-mmproj.gguf");
});

test("aborting a running workflow interrupts ComfyUI", async () => {
  const controller = new AbortController();
  let interrupted = null;
  const comfy = {
    submit: async () => ({ promptId: "prompt-1" }),
    history: async () => null,
    interrupt: async (promptId) => {
      interrupted = promptId;
    },
    view: async () => {
      throw new Error("should not download outputs");
    },
  };

  const running = runWorkflow({
    entry: entry(),
    context: buildContext({ prompt: "x" }),
    comfy,
    timeoutMs: 5000,
    pollIntervalMs: 10,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort("user-stop"), 30);

  await assert.rejects(running, (error) => error.code === "cancelled");
  assert.equal(interrupted, "prompt-1");
});

test("a pre-aborted request is never submitted", async () => {
  const controller = new AbortController();
  controller.abort("user-stop");
  let submitted = 0;
  const comfy = {
    submit: async () => {
      submitted += 1;
      return { promptId: "prompt-1" };
    },
  };

  await assert.rejects(
    () =>
      runWorkflow({
        entry: entry(),
        context: buildContext({ prompt: "x" }),
        comfy,
        signal: controller.signal,
      }),
    (error) => error.code === "cancelled",
  );
  assert.equal(submitted, 0);
});

function loaderEntry() {
  return {
    name: "runner-base-model",
    type: "image",
    workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "default.safetensors" } } },
    bindings: { unet: { node: "1", input: "unet_name", from: "params.unet", default: "default.safetensors" } },
    defaults: {},
    presets: {},
  };
}

function fakeComfy(onSubmit) {
  return {
    submit: async (workflow) => {
      onSubmit?.(workflow);
      return { promptId: "prompt-base" };
    },
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 9: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
    }),
    view: async () => ({ buffer: Buffer.from([1, 2, 3]), contentType: "image/png" }),
  };
}

test("runImage and runVideo forward loaderSpecs to the workflow runner", async () => {
  const runEntry = () => ({
    name: "runner-loader-specs",
    type: "image",
    workflow: { 1: { class_type: "LoraLoaderBypassModelOnly", inputs: { lora_name: "expected.safetensors" } } },
    bindings: {},
    defaults: {},
    presets: {},
  });
  const modelAliasFor = (classType, input, value) => (classType === "LoraLoaderBypassModelOnly" && value === "expected.safetensors" ? "local.safetensors" : "");
  const loaderSpecs = [{ classType: "LoraLoaderBypassModelOnly", input: "lora_name" }];
  let imageWorkflow = null;
  await runImage({
    entry: runEntry(),
    context: buildContext({ prompt: "x", count: 1 }),
    comfy: fakeComfy((workflow) => {
      imageWorkflow = workflow;
    }),
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor,
    loaderSpecs,
  });
  assert.equal(imageWorkflow["1"].inputs.lora_name, "local.safetensors");

  let videoWorkflow = null;
  const videoComfy = {
    submit: async (workflow) => {
      videoWorkflow = workflow;
      return { promptId: "prompt-video" };
    },
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 9: { videos: [{ filename: "out.mp4", subfolder: "", type: "output" }] } },
    }),
    view: async () => ({ buffer: Buffer.from("video"), contentType: "video/mp4" }),
  };
  await runVideo({
    entry: { ...runEntry(), type: "video" },
    context: buildContext({ prompt: "x" }),
    comfy: videoComfy,
    timeoutMs: 5000,
    pollIntervalMs: 10,
    modelAliasFor,
    loaderSpecs,
  });
  assert.equal(videoWorkflow["1"].inputs.lora_name, "local.safetensors");
});

test("base model variants apply params.unet without touching request params", async () => {
  let submittedWorkflow;
  await runWorkflow({
    entry: { ...loaderEntry(), baseModelParams: { unet: "variant.safetensors" } },
    context: buildContext({ prompt: "x" }),
    comfy: fakeComfy((workflow) => {
      submittedWorkflow = workflow;
    }),
    pollIntervalMs: 10,
  });
  assert.equal(submittedWorkflow[1].inputs.unet_name, "variant.safetensors");
});

test("explicit request params override the selected base model", async () => {
  let submittedWorkflow;
  await runWorkflow({
    entry: { ...loaderEntry(), baseModelParams: { unet: "variant.safetensors" } },
    context: buildContext({ prompt: "x", params: { unet: "request.safetensors" } }),
    comfy: fakeComfy((workflow) => {
      submittedWorkflow = workflow;
    }),
    pollIntervalMs: 10,
  });
  assert.equal(submittedWorkflow[1].inputs.unet_name, "request.safetensors");
});
