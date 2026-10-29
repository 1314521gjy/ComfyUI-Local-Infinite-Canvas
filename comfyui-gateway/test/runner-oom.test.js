import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorkflow } from "../src/runner.js";

const entry = {
  name: "image-test",
  workflow: { "1": { class_type: "TestLoader", inputs: {} } },
};

function oomHistory() {
  return {
    status: {
      status_str: "error",
      messages: [["execution_error", "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 222.00 MiB"]],
    },
  };
}

function successHistory() {
  return {
    status: { status_str: "success", completed: true },
    outputs: { "1": { images: [{ filename: "out.png", type: "output" }] } },
  };
}

function fakeComfy({ failures = 1 } = {}) {
  const state = { submits: 0, frees: 0 };
  return {
    state,
    async submit() {
      state.submits += 1;
      return { promptId: `p${state.submits}` };
    },
    async history() {
      return state.submits <= failures ? oomHistory() : successHistory();
    },
    async view() {
      return { buffer: Buffer.from("image"), contentType: "image/png" };
    },
    async freeMemory() {
      state.frees += 1;
    },
  };
}

test("OOM frees ComfyUI memory and retries once", async () => {
  const comfy = fakeComfy({ failures: 1 });
  const result = await runWorkflow({ entry, context: { params: {} }, comfy, pollIntervalMs: 1 });
  assert.equal(comfy.state.submits, 2);
  assert.equal(comfy.state.frees, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, "out.png");
});

test("persistent OOM reports an actionable error after one retry", async () => {
  const comfy = fakeComfy({ failures: 5 });
  await assert.rejects(
    () => runWorkflow({ entry, context: { params: {} }, comfy, pollIntervalMs: 1 }),
    (error) => {
      assert.equal(error.code, "comfy_out_of_memory");
      assert.match(error.message, /显存不足/);
      return true;
    },
  );
  assert.equal(comfy.state.submits, 2);
  assert.equal(comfy.state.frees, 1);
});

test("non-OOM failures are not retried", async () => {
  const comfy = {
    state: { submits: 0, frees: 0 },
    async submit() {
      this.state.submits += 1;
      return { promptId: `p${this.state.submits}` };
    },
    async history() {
      return {
        status: { status_str: "error", messages: [["execution_error", "Value not in list: unet_name 'x.safetensors' not in []"]] },
      };
    },
    async freeMemory() {
      this.state.frees += 1;
    },
  };
  await assert.rejects(
    () => runWorkflow({ entry, context: { params: {} }, comfy, pollIntervalMs: 1 }),
    (error) => {
      assert.equal(error.code, "comfy_execution_failed");
      assert.match(error.message, /模型文件/);
      return true;
    },
  );
  assert.equal(comfy.state.submits, 1);
  assert.equal(comfy.state.frees, 0);
});
