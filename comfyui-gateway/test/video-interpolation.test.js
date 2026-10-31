import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createVideoInterpolator } from "../src/video-interpolation.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rife-test-"));
  const workflowDir = path.join(root, "_internal");
  await fsp.mkdir(workflowDir, { recursive: true });
  await fsp.writeFile(
    path.join(workflowDir, "video-rife.json"),
    JSON.stringify({
      "1": { inputs: { video: "" } },
      "2": { inputs: { multiplier: 2 } },
      "3": { inputs: { frame_rate: 24, filename_prefix: "" } },
    }),
  );
  return root;
}

function fakeComfy(capture) {
  return {
    async uploadImage() {
      return { name: "input.mp4", subfolder: "" };
    },
    async submit(workflow) {
      capture.workflow = workflow;
      return { promptId: "p1" };
    },
    async history(promptId) {
      return {
        [promptId]: {
          status: { status_str: "success", completed: true },
          outputs: { "3": { videos: [{ filename: "out.mp4", type: "output" }] } },
        },
      };
    },
    async view() {
      return { buffer: Buffer.from("video"), contentType: "video/mp4" };
    },
  };
}

test("interpolation follows the source frame rate", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    const result = await interpolator.interpolate({
      comfy: fakeComfy(capture),
      buffer: Buffer.from("input"),
      multiplier: 2,
      sourceFps: 30,
      requestId: "req1",
    });
    assert.equal(result.mimeType, "video/mp4");
    assert.equal(capture.workflow["3"].inputs.frame_rate, 60);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("interpolation timeout cancels the running ComfyUI task", async () => {
  const root = await fixture();
  try {
    let cancelled = "";
    const comfy = {
      async uploadImage() {
        return { name: "input.mp4", subfolder: "" };
      },
      async submit() {
        return { promptId: "p-timeout" };
      },
      async cancel(promptId) {
        cancelled = promptId;
      },
      async history() {
        return null;
      },
      async view() {
        return { buffer: Buffer.from("video"), contentType: "video/mp4" };
      },
    };
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await assert.rejects(
      () => interpolator.interpolate({
        comfy,
        buffer: Buffer.from("input"),
        multiplier: 2,
        requestId: "req-timeout",
        timeoutMs: 1,
      }),
      (error) => /插帧超时/.test(error.message),
    );
    assert.equal(cancelled, "p-timeout");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("falls back to 24fps when the source rate is unknown", async () => {
  const root = await fixture();
  try {
    const capture = {};
    const interpolator = createVideoInterpolator({ config: { workflowDir: root } });
    await interpolator.interpolate({
      comfy: fakeComfy(capture),
      buffer: Buffer.from("input"),
      multiplier: 3,
      sourceFps: 0,
      requestId: "req2",
    });
    assert.equal(capture.workflow["3"].inputs.frame_rate, 72);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
