import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSkinUnlockStore } from "../src/skin-unlocks.js";

test("skin unlocks persist across reloads and reject invalid ids", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skin-unlocks-"));
  try {
    const first = createSkinUnlockStore({ dataDir });
    await first.load();
    assert.deepEqual(first.list(), []);
    const entry = await first.unlock("fish");
    assert.equal(entry.skinId, "fish");
    assert.equal(first.isUnlocked("fish"), true);

    const second = createSkinUnlockStore({ dataDir });
    await second.load();
    assert.deepEqual(second.list(), ["fish"]);
    assert.equal(second.isUnlocked("FISH"), true);
    await assert.rejects(() => second.unlock("../escape"), /无效的皮肤 ID/);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
