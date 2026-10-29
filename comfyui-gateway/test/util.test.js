import assert from "node:assert/strict";
import test from "node:test";

import { framesFromSeconds, uniqueFileName } from "../src/util.js";

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
