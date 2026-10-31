import assert from "node:assert/strict";
import test from "node:test";

import { workflowAvailabilityProblem } from "../src/workflow-availability.js";

const entry = { id: "image-qwen21", name: "Qwen Image 2.1" };

test("blocks an unavailable workflow with its concrete problems", () => {
  const setup = {
    workflowStatus: () => ({ available: false, problems: [{ type: "model", message: "缺少 diffusion_models/qwen.safetensors" }] }),
  };
  const problem = workflowAvailabilityProblem(setup, entry);
  assert.equal(problem.code, "workflow_unavailable");
  assert.match(problem.message, /qwen\.safetensors/);
  assert.equal(problem.details.workflowId, entry.id);
});

test("blocks only the unavailable variant and keeps other modes usable", () => {
  const setup = {
    workflowStatus: () => ({
      available: true,
      problems: [],
      variants: { edit: { available: true, problems: [] }, outpaint: { available: false, problems: [{ message: "缺少 outpaint LoRA" }] } },
    }),
  };
  assert.equal(workflowAvailabilityProblem(setup, entry, { mode: "edit" }), null);
  const problem = workflowAvailabilityProblem(setup, entry, { mode: "outpaint" });
  assert.equal(problem.code, "workflow_mode_unavailable");
  assert.match(problem.message, /outpaint LoRA/);
  assert.equal(problem.details.mode, "outpaint");
});

test("allows hidden upscale tools and unknown modes without blocking", () => {
  const setup = { workflowStatus: () => ({ available: false, problems: [{ message: "missing" }] }) };
  assert.equal(workflowAvailabilityProblem(setup, entry, { allowUnavailable: true }), null);
  const available = { workflowStatus: () => ({ available: true, problems: [], variants: {} }) };
  assert.equal(workflowAvailabilityProblem(available, entry, { mode: "other" }), null);
});

test("is a no-op before setup exposes workflow status", () => {
  assert.equal(workflowAvailabilityProblem({}, entry), null);
  assert.equal(workflowAvailabilityProblem({ workflowStatus: () => ({ available: true, checking: true, problems: [] }) }, entry), null);
});
