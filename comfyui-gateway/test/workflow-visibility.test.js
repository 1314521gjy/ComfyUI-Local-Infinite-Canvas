import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorkflowVisibilityStore } from "../src/workflow-visibility.js";

test("workflow visibility persists hidden ids across reloads", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "visibility-test-"));
    try {
        const store = createWorkflowVisibilityStore({ dataDir: dir });
        await store.load();
        assert.equal(store.isHidden("image-moss-sft-8step"), false);
        await store.setHidden("image-moss-sft-8step", true);
        assert.equal(store.isHidden("image-moss-sft-8step"), true);

        const reloaded = createWorkflowVisibilityStore({ dataDir: dir });
        await reloaded.load();
        assert.deepEqual(reloaded.list(), ["image-moss-sft-8step"]);
        await reloaded.setHidden("image-moss-sft-8step", false);
        assert.equal(reloaded.isHidden("image-moss-sft-8step"), false);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});
