import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { buildYue2ComfyWorkflow, resolveYue2Precision, YUE2_PRECISION_CHECKPOINTS } from "../src/audio-local.js";

const args = {
  style: "cinematic pop, female vocal",
  lyrics: "[Verse]\nhello world\n[Chorus]\nhello again",
  seed: 12345,
  mode: "full",
  seconds: 120,
  instrumental: false,
};

function workflowHash(workflow) {
  return crypto.createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

test("default and fast keep the pre-change YuE2 workflow bytes", () => {
  const baseline = workflowHash(buildYue2ComfyWorkflow(args));
  assert.equal(baseline, "98de955ae17c4dd05898d2d8fc5dcfe1016c40c4231770eab00bd6983a1fd484");

  const fast = resolveYue2Precision(undefined);
  assert.deepEqual(fast, { precision: "fast", checkpoint: YUE2_PRECISION_CHECKPOINTS.fast });
  assert.equal(workflowHash(buildYue2ComfyWorkflow({ ...args, checkpoint: fast.checkpoint })), baseline);
  assert.equal(workflowHash(buildYue2ComfyWorkflow({ ...args, checkpoint: "yue2_3b_int8_convrot.safetensors" })), baseline);
});

test("fast preserves the existing checkpoint override", () => {
  assert.deepEqual(resolveYue2Precision("fast", { envCheckpoint: "custom.safetensors" }), {
    precision: "fast",
    checkpoint: "custom.safetensors",
  });
});

test("quality selects BF16 when installed", () => {
  assert.deepEqual(resolveYue2Precision("quality", { bf16Installed: true }), {
    precision: "quality",
    checkpoint: YUE2_PRECISION_CHECKPOINTS.quality,
  });
});

test("invalid precision is a 400", () => {
  assert.throws(
    () => resolveYue2Precision("high"),
    (error) => error.status === 400 && error.code === "invalid_precision",
  );
});

test("quality without BF16 is an actionable audio_model_missing error", () => {
  assert.throws(
    () => resolveYue2Precision("quality", { bf16Installed: false }),
    (error) =>
      error.status === 503 &&
      error.code === "audio_model_missing" &&
      error.details?.resourceId === "yue2_3b_bf16" &&
      /yue2_3b_bf16\.safetensors/.test(error.message),
  );
});
