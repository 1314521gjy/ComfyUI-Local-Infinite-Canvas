import test from "node:test";
import assert from "node:assert/strict";

import { ensureSpeakerTags } from "../src/speaker-tags.js";

const PROMPT = `integrated_multimodal_description: [Shot 1] 画面右侧外传来一个中年男人低沉压迫的声音 (S1) 质问：<d>[Chinese] 你就是沈三叔？</d> 老头儿耳背，缓缓把脑袋向前伸了伸，用沙哑的嗓音反问：<d>[Chinese] 沈什么叔？</d> 画面外同一个男人 (S1) 的声音再次响起：<d>[Chinese] 老东西。</d>

overall_soundscape: 巷道环境声。

non_diegetic_music: N/A`;

test("ensureSpeakerTags adds S2 and off-screen markers", () => {
  const result = ensureSpeakerTags(PROMPT);
  assert.match(result.prompt, /老头儿 \(S2\)/);
  assert.match(result.prompt, /声音 \(S1\) off-screen（不在画面中，不对应任何参考图）/);
  assert.match(result.prompt, /同一个男人 \(S1\) off-screen/);
  assert.equal((result.prompt.match(/不在画面中/g) || []).length, 1);
  assert.equal(result.issues.length, 0);
  assert.ok(result.fixed >= 3);
});

test("ensureSpeakerTags is idempotent", () => {
  const once = ensureSpeakerTags(PROMPT).prompt;
  const twice = ensureSpeakerTags(once);
  assert.equal(twice.prompt, once);
  assert.equal(twice.fixed, 0);
});

test("ensureSpeakerTags normalizes full-width ids and leaves sound sections alone", () => {
  const prompt = `integrated_multimodal_description: [Shot 1] 画外男人（S1）说道：<d>[Chinese] 等一下。</d>\n\noverall_soundscape: 环境声。\n\nnon_diegetic_music: N/A`;
  const result = ensureSpeakerTags(prompt);
  assert.match(result.prompt, /画外男人\s*\(S1\) off-screen/);
  assert.doesNotMatch(result.prompt, /（S1）/);
  assert.match(result.prompt, /overall_soundscape: 环境声。/);
});

test("ensureSpeakerTags reuses an existing subject id", () => {
  const prompt = `integrated_multimodal_description: [Shot 1] 老头儿 (S2) 说道：<d>[Chinese] 一。</d> 老头儿又说：<d>[Chinese] 二。</d>\n\noverall_soundscape: 环境声。\n\nnon_diegetic_music: N/A`;
  const result = ensureSpeakerTags(prompt);
  assert.match(result.prompt, /老头儿\s*\(S2\)\s*又说/);
  assert.doesNotMatch(result.prompt, /\(S3\)/);
});

test("ensureSpeakerTags supports English off-screen speakers", () => {
  const prompt = `integrated_multimodal_description: [Shot 1] A man off-screen asks: <d>[English] Who are you?</d> The old man replies: <d>[English] What?</d>\n\noverall_soundscape: Room tone.\n\nnon_diegetic_music: N/A`;
  const result = ensureSpeakerTags(prompt);
  assert.match(result.prompt, /A man \(S1\) off-screen/);
  assert.match(result.prompt, /old man \(S2\)/);
  assert.match(result.prompt, /not in any reference picture/);
});

test("ensureSpeakerTags leaves prompts without dialogue unchanged", () => {
  const prompt = `integrated_multimodal_description: [Shot 1] 一段没有台词的画面。\n\noverall_soundscape: 环境声。\n\nnon_diegetic_music: N/A`;
  const result = ensureSpeakerTags(prompt);
  assert.equal(result.prompt, prompt);
  assert.equal(result.fixed, 0);
});
