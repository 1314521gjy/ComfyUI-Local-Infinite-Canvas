import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { alignH3Frames, capH3ReferenceFrames, framesFromSeconds, uniqueFileName, writeJsonAtomic } from "../src/util.js";

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

test("concurrent atomic JSON writes never leave a malformed document", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-json-test-"));
  try {
    const file = path.join(dir, "state.json");
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeJsonAtomic(file, { index, payload: "x".repeat(index + 1) })));
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    assert.ok(Number.isInteger(parsed.index));
    assert.equal(parsed.payload.length, parsed.index + 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("atomic JSON writes survive a transient Windows read lock", async () => {
  if (process.platform !== "win32") return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-json-lock-test-"));
  try {
    const file = path.join(dir, "state.json");
    await writeJsonAtomic(file, { version: 1 });
    const reader = await fsp.open(file, "r");
    const pending = writeJsonAtomic(file, { version: 2 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await reader.close();
    await pending;
    assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), { version: 2 });
    assert.equal((await fsp.readdir(dir)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
