import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isManualModelCategory, manualModelRoots } from "../src/directories.js";

test("manual model roots mirror the managed extra-path mapping", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "manual-model-roots-"));
    try {
        const flat = path.join(root, "flat-models");
        const roots = path.join(root, "model-roots");
        const loras = path.join(root, "my-loras");
        await fsp.mkdir(path.join(roots, "upscale_models"), { recursive: true });
        await fsp.mkdir(path.join(roots, "vae"), { recursive: true });
        await fsp.mkdir(path.join(roots, "vdn"), { recursive: true });
        await fsp.mkdir(path.join(roots, "LLM"), { recursive: true });
        await fsp.mkdir(flat, { recursive: true });
        await fsp.mkdir(loras, { recursive: true });

        const settings = { mode: "manual", modelDirs: [flat, roots], loraDirs: [loras], customNodesDirs: [] };
        assert.deepEqual(manualModelRoots(settings, "upscale_models"), [path.resolve(flat), path.resolve(path.join(roots, "upscale_models"))]);
        assert.deepEqual(manualModelRoots(settings, "vae"), [path.resolve(flat), path.resolve(path.join(roots, "vae"))]);
        // 已有其它类别子目录的根目录不会为缺少的类别兜底映射。
        assert.deepEqual(manualModelRoots(settings, "checkpoints"), [path.resolve(flat)]);
        assert.deepEqual(manualModelRoots(settings, "loras"), [path.resolve(flat), path.resolve(loras)]);
        // VDN / LLM 等专用目录也参与手动映射；缺少子目录时只保留扁平目录。
        assert.deepEqual(manualModelRoots(settings, "vdn"), [path.resolve(flat), path.resolve(path.join(roots, "vdn"))]);
        assert.deepEqual(manualModelRoots(settings, "LLM"), [path.resolve(flat), path.resolve(path.join(roots, "LLM"))]);
        assert.deepEqual(manualModelRoots(settings, "SEEDVR2"), [path.resolve(flat)]);
        // 自动模式不参与手动落点。
        assert.deepEqual(manualModelRoots({ ...settings, mode: "auto" }, "vae"), []);
        assert.equal(isManualModelCategory("vae"), true);
        assert.equal(isManualModelCategory("vdn"), true);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
