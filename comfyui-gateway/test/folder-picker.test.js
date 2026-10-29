import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pickFolder } from "../src/folder-picker.js";

test("folder picker returns the configured path in fake mode", async () => {
    const previous = process.env.FOLDER_PICKER_FAKE;
    process.env.FOLDER_PICKER_FAKE = os.tmpdir();
    try {
        const result = await pickFolder({ title: "选择文件夹" });
        assert.equal(result.canceled, false);
        assert.equal(path.resolve(result.path), path.resolve(os.tmpdir()));
    } finally {
        if (previous === undefined) delete process.env.FOLDER_PICKER_FAKE;
        else process.env.FOLDER_PICKER_FAKE = previous;
    }
});
