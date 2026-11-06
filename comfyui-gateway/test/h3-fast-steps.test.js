import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatewayDir = path.join(root, "comfyui-gateway");
const workflowPath = path.join(gatewayDir, "workflows", "h3-fast-draft.json");
const contractPath = path.join(gatewayDir, "resources", "nodes", "unpacked", "comfystreamerh3", "contract.py");
const changelogPath = path.join(root, "CHANGELOG.md");
const registryPath = path.join(gatewayDir, "workflows", "registry.json");

function pdmdPositions() {
    const source = fs.readFileSync(contractPath, "utf8");
    const match = source.match(/"pdmd-2step"\s*:\s*\{[\s\S]*?"positions"\s*:\s*\(([^)]*)\)/);
    assert.ok(match, "contract.py 缺少 pdmd-2step positions");
    return match[1].split(",").map((value) => value.trim()).filter(Boolean);
}

test("H3 fast draft is two steps and public copy matches the workflow", () => {
    const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
    const loader = Object.values(workflow).find((node) => node?.inputs?.sampling_contract_override);
    assert.ok(loader, "h3-fast-draft.json 缺少 sampling_contract_override");
    assert.equal(loader.inputs.sampling_contract_override, "pdmd-2step");
    const sampler = Object.values(workflow).find((node) => node?.class_type === "FastH3BenchmarkSampler");
    assert.ok(sampler);
    assert.match(sampler._meta?.title || "", /pdmd-2step/);

    const steps = pdmdPositions().length - 1;
    assert.equal(steps, 2);

    const changelog = fs.readFileSync(changelogPath, "utf8");
    const v0248 = changelog.split("## v0.24.8")[1]?.split("## v0.24.7")[0] || "";
    const changelogSteps = v0248.match(/H3 极速草稿：(\d+) 步快速出片/);
    assert.ok(changelogSteps, "CHANGELOG v0.24.8 缺少极速草稿步数描述");
    assert.equal(Number(changelogSteps[1]), steps);

    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const fast = registry.workflows.find((entry) => entry.id === "video-h3-fast");
    assert.ok(fast, "registry 缺少 video-h3-fast");
    const registrySteps = fast.description.match(/FastH3 (\d+) 步采样/);
    assert.ok(registrySteps, "registry video-h3-fast 缺少 FastH3 步数描述");
    assert.equal(Number(registrySteps[1]), steps);
});
