import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateStepPlan } from "../src/step-plan.js";

test("single KSampler contributes its steps", () => {
  const plan = estimateStepPlan({ 3: { class_type: "KSampler", inputs: { steps: 10 } } });
  assert.deepEqual(plan, { total: 10, steps: { 3: 10 }, absolute: {} });
});

test("two-pass KSamplerAdvanced counts only the executed window", () => {
  const plan = estimateStepPlan({
    7: { class_type: "KSamplerAdvanced", inputs: { steps: 7, start_at_step: 0, end_at_step: 7 } },
    9: { class_type: "KSamplerAdvanced", inputs: { steps: 10, start_at_step: 4, end_at_step: 999 } },
  });
  assert.equal(plan.total, 13);
  assert.equal(plan.steps[7], 7);
  assert.equal(plan.steps[9], 6);
});

test("ManualSigmas turns sigma values into sampling steps", () => {
  const plan = estimateStepPlan({
    9: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.9, 0.7, 0.4, 0" } },
    10: { class_type: "SamplerCustomAdvanced", inputs: { sigmas: ["9", 0] } },
  });
  assert.deepEqual(plan, { total: 4, steps: { 10: 4 }, absolute: {} });
});

test("H3 SelfLift follows H3SigmaRefiner to BasicScheduler and adds extra steps", () => {
  const plan = estimateStepPlan({
    74: { class_type: "BasicScheduler", inputs: { steps: 8 } },
    112: { class_type: "H3SigmaRefiner", inputs: { extra_steps: 1, sigmas: ["74", 0] } },
    78: { class_type: "SelfLiftH3Sampler", inputs: { sigmas: ["112", 0] } },
  });
  assert.deepEqual(plan, { total: 9, steps: { 78: 9 }, absolute: { 78: true } });
});

test("workflow without a sampler has no step plan", () => {
  const plan = estimateStepPlan({
    1: { class_type: "SeedVR2VideoUpscaler", inputs: {} },
    2: { class_type: "SaveVideo", inputs: {} },
  });
  assert.deepEqual(plan, { total: 0, steps: {}, absolute: {} });
});
