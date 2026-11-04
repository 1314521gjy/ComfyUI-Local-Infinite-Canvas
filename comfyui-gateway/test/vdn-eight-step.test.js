import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { estimateStepPlan } from "../src/step-plan.js";

const workflowsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"));

test("VDN workflow runs one eight-step SelfLift pass without SigmaRefiner", () => {
    const workflow = readJson("h3-ref2va-drama-vdn.json");
    assert.equal(workflow["112"], undefined);
    assert.equal(Object.values(workflow).some((node) => node?.class_type === "H3SigmaRefiner"), false);
    assert.deepEqual(workflow["78"].inputs.sigmas, ["74", 0]);
    assert.equal(workflow["74"].inputs.steps, 8);
    const plan = estimateStepPlan(workflow);
    assert.deepEqual(plan, { total: 8, steps: { 78: 8 }, absolute: { 78: true } });
});

test("three VDN entries share the eight-step backend and refine tiers", () => {
    const registry = readJson("registry.json");
    const ids = new Set(["video-h3-ref2va", "video-h3-t2v", "video-h3-frames"]);
    const entries = registry.workflows.filter((entry) => ids.has(entry.id));
    assert.equal(entries.length, 3);
    for (const entry of entries) {
        assert.equal(entry.file, "h3-ref2va-drama-vdn.json");
        assert.match(entry.description, /8 NFE/);
        assert.doesNotMatch(entry.description, /9 NFE|SigmaRefiner/);
        const steps = entry.parameters.find((parameter) => parameter.key === "steps");
        assert.equal(steps.default, 8);
        const transition = entry.parameters.find((parameter) => parameter.key === "transition_step");
        assert.equal(transition.default, 6);
        assert.match(transition.description, /快速 6 步低清 \+ 2 步全分辨率/);
        assert.match(transition.description, /质量 5 步低清 \+ 3 步全分辨率/);
        assert.equal(entry.bindings.steps.node, "74");
        assert.equal(entry.bindings.steps.default, 8);
        assert.equal(entry.bindings.transition_step.node, "78");
        assert.equal(entry.bindings.transition_step.default, 6);
    }
});

test("noVDN workflows keep the original 8+1 SigmaRefiner plan", () => {
    const workflow = readJson("h3-ref2va-drama.json");
    assert.equal(workflow["112"]?.class_type, "H3SigmaRefiner");
    assert.deepEqual(workflow["78"].inputs.sigmas, ["112", 0]);
    assert.deepEqual(estimateStepPlan(workflow), { total: 9, steps: { 78: 9 }, absolute: { 78: true } });
});
