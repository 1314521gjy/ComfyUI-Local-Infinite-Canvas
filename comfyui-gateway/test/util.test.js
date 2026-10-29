import assert from "node:assert/strict";
import test from "node:test";

import { alignH3Frames, capH3ReferenceFrames, framesFromSeconds, uniqueFileName } from "../src/util.js";

test("upload filenames stay unique for references with the same original name", () => {
  assert.equal(uniqueFileName("AI_.png", "aaaa"), "AI_-aaaa.png");
  assert.equal(uniqueFileName("AI_.png", "bbbb"), "AI_-bbbb.png");
  assert.equal(uniqueFileName("reference", "cccc"), "reference-cccc.png");
  assert.equal(uniqueFileName("my image.JPG", "dddd"), "my_image-dddd.JPG");
});

test("framesFromSeconds converts to H3 frames and rejects bad input", () => {
  assert.equal(framesFromSeconds(12.25), 294);
  assert.equal(framesFromSeconds("5"), 120);
  assert.equal(framesFromSeconds(0), 0);
  assert.equal(framesFromSeconds(-1), 0);
  assert.equal(framesFromSeconds(undefined), 0);
});

test("alignH3Frames keeps 17n+5 aligned downwards without a cap", () => {
  assert.equal(alignH3Frames(294), 294);
  assert.equal(alignH3Frames(124), 124);
  assert.equal(alignH3Frames(541), 532);
  assert.equal(alignH3Frames(360), 345);
  assert.equal(alignH3Frames(24), 22);
  assert.equal(alignH3Frames(0), 0);
});

test("capH3ReferenceFrames enforces the official 15s (362-frame) limit", () => {
  assert.equal(capH3ReferenceFrames(541), 362);
  assert.equal(capH3ReferenceFrames(362), 362);
  assert.equal(capH3ReferenceFrames(294), 294);
  assert.equal(capH3ReferenceFrames(0), 0);
});
