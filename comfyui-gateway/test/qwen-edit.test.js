import assert from "node:assert/strict";
import test from "node:test";

import { reorderQwenEditFiles, reorderQwenEditPrompt } from "../src/qwen-edit.js";

test("Qwen multi-image edit moves the target image to the end", () => {
  const files = ["target.png", "ref.png", "extra.png"];
  assert.deepEqual(reorderQwenEditFiles(files), ["ref.png", "extra.png", "target.png"]);
  assert.deepEqual(reorderQwenEditFiles(["only.png"]), ["only.png"]);
});

test("Qwen edit prompt labels follow the reordered reference sequence", () => {
  const prompt = "参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。\n\n保持原图整体构图；将香烟替换为图2中的棒棒糖。";
  const result = reorderQwenEditPrompt(prompt, 2);
  assert.match(result, /^图片顺序：图片1、图片2；其中图片2是目标图\/原图/);
  assert.match(result, /保持图片2整体构图/);
  assert.match(result, /图片1中的棒棒糖/);
  assert.doesNotMatch(result, /参考图片编号/);
});

test("Qwen edit prompt maps Chinese numerals for three references", () => {
  const result = reorderQwenEditPrompt("保持图一主体；图二提供衣服；只编辑图一。", 3);
  assert.match(result, /图片3是目标图/);
  assert.match(result, /保持图片3主体/);
  assert.match(result, /图片1提供衣服/);
  assert.match(result, /只编辑图片3/);
  const alt = reorderQwenEditPrompt("保持第1张；第2张提供衣服；第3张是参考。", 3);
  assert.match(alt, /保持图片3/);
  assert.match(alt, /图片1提供衣服/);
  assert.match(alt, /图片2是参考/);
});
