import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { applyBindings, buildContext } from "../src/bindings.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registry = JSON.parse(fs.readFileSync(path.join(root, "workflows", "registry.json"), "utf8"));
const entry = registry.workflows.find((item) => item.id === "image-qwen21");

function workflow(file) {
  return JSON.parse(fs.readFileSync(path.join(root, "workflows", file), "utf8"));
}

function sigmasAt(workflowNode) {
  return String(workflowNode.inputs.sigmas).split(",").map((value) => Number(value.trim()));
}

test("Qwen 2.1 keeps the official 8-step sigma schedule by default", () => {
  const bound = applyBindings(workflow("image-qwen21-edit-turbo.json"), entry, buildContext({ prompt: "x", uploadedImages: [{ name: "ref.png" }] }));
  assert.equal(bound["9"].inputs.sigmas, "1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0");
});

test("Qwen 2.1 interpolates a custom step count without changing endpoints", () => {
  const bound = applyBindings(workflow("image-qwen21-edit-turbo.json"), entry, buildContext({ prompt: "x", params: { steps: 25 }, uploadedImages: [{ name: "ref.png" }] }));
  const sigmas = sigmasAt(bound["9"]);
  assert.equal(sigmas.length, 26);
  assert.equal(sigmas[0], 1);
  assert.equal(sigmas.at(-1), 0);
  assert.ok(sigmas.every((value, index) => index === 0 || value <= sigmas[index - 1]));
});

test("Qwen inpaint and outpaint bind custom steps to their own sampler nodes", () => {
  const inpaint = applyBindings(
    workflow("image-qwen21-inpaint.json"),
    { ...entry, bindings: entry.variants.inpaint.bindings, workflow: workflow("image-qwen21-inpaint.json") },
    buildContext({ prompt: "x", params: { steps: 16 }, uploadedImages: [{ name: "source.png" }, { name: "mask.png" }] }),
  );
  assert.equal(sigmasAt(inpaint["12"]).length, 17);
  const outpaint = applyBindings(
    workflow("image-qwen21-outpaint.json"),
    { ...entry, bindings: entry.variants.outpaint.bindings, workflow: workflow("image-qwen21-outpaint.json") },
    buildContext({ prompt: "x", params: { steps: 25 }, uploadedImages: [{ name: "source.png" }] }),
  );
  assert.equal(sigmasAt(outpaint["14"]).length, 26);
});

test("Qwen t2i binds custom steps to its sampler node", () => {
  const t2i = applyBindings(
    workflow("image-qwen21-t2i.json"),
    { ...entry, bindings: entry.variants.t2i.bindings, workflow: workflow("image-qwen21-t2i.json") },
    buildContext({ prompt: "x", params: { steps: 25 } }),
  );
  assert.equal(sigmasAt(t2i["9"]).length, 26);
});
