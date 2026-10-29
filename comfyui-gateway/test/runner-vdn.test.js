import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorkflow } from "../src/runner.js";

const entry = { name: "video-test", workflow: { "1": { class_type: "TestLoader", inputs: {} } } };

test("VDN missing Stage-B adapter is translated into an actionable Chinese hint", async () => {
  const comfy = {
    async submit() {
      return { promptId: "p1" };
    },
    async history() {
      return {
        status: {
          status_str: "error",
          messages: [["execution_error", "the 'default' (Stage-B) adapter is missing"]],
        },
      };
    },
  };
  await assert.rejects(
    () => runWorkflow({ entry, context: { params: {} }, comfy, pollIntervalMs: 1 }),
    (error) => {
      assert.match(error.message, /Stage-B/);
      assert.match(error.message, /资源中心/);
      return true;
    },
  );
});
