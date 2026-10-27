import assert from "node:assert/strict";
import test from "node:test";

import { uniqueFileName } from "../src/util.js";

test("upload filenames stay unique for references with the same original name", () => {
  assert.equal(uniqueFileName("AI_.png", "aaaa"), "AI_-aaaa.png");
  assert.equal(uniqueFileName("AI_.png", "bbbb"), "AI_-bbbb.png");
  assert.equal(uniqueFileName("reference", "cccc"), "reference-cccc.png");
  assert.equal(uniqueFileName("my image.JPG", "dddd"), "my_image-dddd.JPG");
});
