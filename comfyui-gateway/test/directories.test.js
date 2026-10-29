import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildManagedExtraPaths, detectComfyLayout, directoryLoadReport, normalizeDirectorySettings, scanDirectories, validateDirectorySettings, writeManagedExtraPaths } from "../src/directories.js";

async function fixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "directories-test-"));
    const comfyRoot = path.join(root, "ComfyUI");
    await fsp.mkdir(path.join(comfyRoot, "user", "default", "workflows"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "models", "loras", "style"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "models", "vae"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "models", "checkpoints"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "custom_nodes", "MyPlugin"), { recursive: true });
    await fsp.writeFile(path.join(comfyRoot, "main.py"), "print('comfy')\n");
    await fsp.writeFile(path.join(comfyRoot, "models", "loras", "style", "red.safetensors"), "x");
    await fsp.writeFile(path.join(comfyRoot, "models", "vae", "ae.safetensors"), "x");
    await fsp.writeFile(path.join(comfyRoot, "models", "checkpoints", "base.safetensors"), "x");
    await fsp.writeFile(path.join(comfyRoot, "custom_nodes", "MyPlugin", "__init__.py"), "");
    return { root, comfyRoot };
}

test("normalizes directory settings and splits multi-line paths", () => {
    const settings = normalizeDirectorySettings({
        mode: "manual",
        comfyDir: "D:/ComfyUI",
        modelDirs: "D:/models\nD:/models2, D:/models",
        loraDirs: ["D:/loras"],
        customNodesDirs: "D:/nodes",
    });
    assert.equal(settings.mode, "manual");
    assert.deepEqual(settings.modelDirs, [path.resolve("D:/models"), path.resolve("D:/models2")]);
    assert.deepEqual(settings.loraDirs, [path.resolve("D:/loras")]);
    assert.equal(validateDirectorySettings({ ...settings, comfyDir: "", modelDirs: [], loraDirs: [], customNodesDirs: [] }).ok, false);
});

test("detects ComfyUI layout and deeply scans model / LoRA / plugin folders", async () => {
    const { root, comfyRoot } = await fixture();
    try {
        const settings = normalizeDirectorySettings({
            mode: "manual",
            comfyDir: comfyRoot,
            modelDirs: path.join(comfyRoot, "models"),
            loraDirs: path.join(comfyRoot, "models", "loras"),
            customNodesDirs: path.join(comfyRoot, "custom_nodes"),
        });
        const validation = validateDirectorySettings(settings);
        assert.equal(validation.ok, true, validation.errors.join(";"));
        const layout = detectComfyLayout(comfyRoot);
        assert.match(layout.mainPy.replaceAll("\\", "/"), /ComfyUI\/main\.py$/);
        assert.match(layout.workflowsDir.replaceAll("\\", "/"), /ComfyUI\/user\/default\/workflows$/);
        const managed = buildManagedExtraPaths(settings);
        assert.match(managed, /checkpoints: checkpoints/);
        assert.match(managed, /loras: loras/);
        assert.doesNotMatch(managed, /checkpoints: \./);
        const scan = scanDirectories(settings);
        assert.equal(scan.totals.models, 3);
        assert.equal(scan.totals.loras, 1);
        assert.equal(scan.totals.plugins, 1);
        assert.equal(scan.modelDirs[0].byKind.loras, 1);
        assert.equal(scan.modelDirs[0].byKind.vae, 1);
        assert.equal(scan.customNodesDirs[0].samples[0], "MyPlugin");
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("writes a managed extra_model_paths block, backs up and removes it", async () => {
    const { root, comfyRoot } = await fixture();
    try {
        const file = path.join(comfyRoot, "extra_model_paths.yaml");
        await fsp.writeFile(file, "existing:\n  base_path: D:/existing\n  loras: .\n");
        const settings = normalizeDirectorySettings({
            mode: "manual",
            comfyDir: comfyRoot,
            modelDirs: "D:/models",
            loraDirs: "D:/loras",
            customNodesDirs: "D:/nodes",
        });
        const yaml = buildManagedExtraPaths(settings);
        assert.match(yaml, /local_canvas_models_1:/);
        assert.match(yaml, /base_path: "D:\/models"/);
        assert.match(yaml, /custom_nodes: \./);
        const first = writeManagedExtraPaths(comfyRoot, settings);
        assert.equal(first.ok, true);
        assert.equal(first.changed, true);
        assert.ok(first.backup, "should back up the original file");
        const text = await fsp.readFile(file, "utf8");
        assert.match(text, /existing:/);
        assert.match(text, />>> local-canvas manual directories/);
        const second = writeManagedExtraPaths(comfyRoot, settings);
        assert.equal(second.changed, false, "same settings should not rewrite");
        const cleared = writeManagedExtraPaths(comfyRoot, { ...settings, modelDirs: [], loraDirs: [], customNodesDirs: [] });
        assert.equal(cleared.changed, true);
        const after = await fsp.readFile(file, "utf8");
        assert.doesNotMatch(after, />>> local-canvas manual directories/);
        assert.match(after, /existing:/);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("restart is required only for manual dirs missing from ComfyUI folder paths", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "directories-loaded-"));
    try {
        const comfyRoot = path.join(root, "ComfyUI");
        const models = path.join(root, "ManualModels");
        const loras = path.join(root, "ManualLoras");
        await fsp.mkdir(path.join(comfyRoot, "custom_nodes"), { recursive: true });
        await fsp.mkdir(path.join(comfyRoot, "models"), { recursive: true });
        await fsp.writeFile(path.join(comfyRoot, "main.py"), "print(1)\n");
        await fsp.mkdir(models, { recursive: true });
        await fsp.mkdir(loras, { recursive: true });
        const settings = normalizeDirectorySettings({
            mode: "manual",
            comfyDir: comfyRoot,
            modelDirs: models,
            loraDirs: loras,
            customNodesDirs: path.join(comfyRoot, "custom_nodes"),
        });
        const loaded = directoryLoadReport(settings, {
            comfyRoot,
            folderPaths: { diffusion_models: [models], loras: [loras], custom_nodes: [path.join(comfyRoot, "custom_nodes")] },
        });
        assert.equal(loaded.restartRequired, false);
        assert.deepEqual(loaded.missing, []);
        const missing = directoryLoadReport(settings, { comfyRoot, folderPaths: {} });
        assert.equal(missing.restartRequired, true);
        assert.equal(missing.missing.some((item) => item.kind === "model"), true);
        const switched = directoryLoadReport(settings, {
            comfyRoot: path.join(root, "OtherComfy"),
            folderPaths: { diffusion_models: [models], loras: [loras], custom_nodes: [path.join(comfyRoot, "custom_nodes")] },
        });
        assert.equal(switched.comfyLoaded, false);
        assert.equal(switched.restartRequired, true);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
