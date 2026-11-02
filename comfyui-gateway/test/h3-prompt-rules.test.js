import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("H3 skill documents the local cfg=1 prompt rules", () => {
  const skill = fs.readFileSync(path.join(root, "prompts", "skills", "h3-prompt-writing", "SKILL.md"), "utf8");
  assert.match(skill, /## Local H3 Compatibility Rules \(VDN \/ cfg=1\)/);
  for (const needle of [
    "Describe positively",
    "<Picture 1>",
    "one continuous locked-off shot from a tripod",
    "do not ban `cinematic` outright",
    "do not run a blanket find-and-replace",
    "I2VA, FL2VA, L2VA, and Ref2VA must reference their real keyframe or reference inputs",
  ]) {
    assert.ok(skill.includes(needle), `SKILL.md missing: ${needle}`);
  }
  assert.equal(/keyframe-only prompts must contain no/i.test(skill), false, "keyframe modes must use Picture labels");
});

test("local H3 enhance template carries the same rules in its system prompt", () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, "prompts", "h3-prompt-enhance.json"), "utf8"));
  const systemPrompt = workflow["3"]?.inputs?.["系统提示词"];
  assert.equal(typeof systemPrompt, "string");
  for (const needle of ["cfg=1", "正向事实", "<Picture 1>", "I2VA/FL2VA/L2VA/Ref2VA", "locked-off shot", "cinematic", "不做全局替换"]) {
    assert.ok(systemPrompt.includes(needle), `system prompt missing: ${needle}`);
  }
});
