import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildContext } from "../src/bindings.js";
import { runWorkflow } from "../src/runner.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registry = JSON.parse(fs.readFileSync(path.join(root, "workflows", "registry.json"), "utf8"));
const entry = registry.workflows.find((item) => item.id === "image-krea2-four-view");

test("four-view workflow binds the source image, prompt, LoRA and sampler params", async () => {
  assert.ok(entry, "image-krea2-four-view registry entry is missing");
  const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflows", entry.file), "utf8"));
  let submitted = null;
  const comfy = {
    submit: async (payload) => {
      submitted = payload;
      return { promptId: "four-view" };
    },
    history: async () => ({
      status: { status_str: "success" },
      outputs: { 5: { images: [{ filename: "sheet.png", subfolder: "", type: "output" }] } },
    }),
    view: async () => ({ buffer: Buffer.from("sheet"), contentType: "image/png" }),
  };
  const result = await runWorkflow({
    entry: { ...entry, workflow },
    context: buildContext({
      prompt: "four views",
      images: [{ name: "ref.png" }],
      uploadedImages: [{ name: "uploaded-ref.png", subfolder: "" }],
      params: { steps: 12, cfg: 1.5 },
    }),
    comfy,
    timeoutMs: 5000,
    pollIntervalMs: 10,
  });
  assert.equal(submitted["17"].inputs.image, "uploaded-ref.png");
  assert.equal(submitted["24"].inputs.prompt, "four views");
  assert.equal(submitted["14"].inputs.steps, 12);
  assert.equal(submitted["14"].inputs.cfg, 1.5);
  assert.equal(submitted["16"].inputs.lora_name, "Krea2-功能-角色四视图.safetensors");
  assert.equal(submitted["25"].inputs.unet_name, "krea2_turbo_fp8_scaled.safetensors");
  assert.equal(result.files[0].filename, "sheet.png");
});
