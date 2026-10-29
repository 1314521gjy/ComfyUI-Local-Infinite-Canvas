import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseExtraModelPaths, collectModelRoots, modelRelativePath, clearExtraModelPathsCache } from "../src/model-paths.js";

test("parseExtraModelPaths resolves base_path and list values", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-paths-yaml-"));
    try {
        const yaml = path.join(root, "extra_model_paths.yaml");
        await fsp.writeFile(yaml, [
            "comfyui:",
            "  base_path: D:/ComfyExtra",
            "  is_default: true",
            "  diffusion_models: models/diffusion_models",
            "  text_encoders: |",
            "    models/text_encoders",
            "    models/clip",
            "other:",
            "  base_path: E:/Other",
            "  loras: loras",
        ].join("\n"), "utf8");
        const parsed = parseExtraModelPaths(yaml);
        assert.deepEqual(parsed.diffusion_models, [path.resolve("D:/ComfyExtra/models/diffusion_models")]);
        assert.deepEqual(parsed.text_encoders, [path.resolve("D:/ComfyExtra/models/text_encoders"), path.resolve("D:/ComfyExtra/models/clip")]);
        assert.deepEqual(parsed.loras, [path.resolve("E:/Other/loras")]);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("collectModelRoots merges folder paths, extra yaml and fallbacks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-paths-roots-"));
    try {
        const comfy = path.join(root, "ComfyUI");
        const extra = path.join(root, "ExtraModels");
        await fsp.mkdir(path.join(comfy, "models", "diffusion_models"), { recursive: true });
        await fsp.mkdir(extra, { recursive: true });
        await fsp.writeFile(path.join(comfy, "extra_model_paths.yaml"), [
            "extra:",
            `  base_path: ${extra.replace(/\\/g, "/")}`,
            "  diffusion_models: diffusion_models",
        ].join("\n"), "utf8");
        clearExtraModelPathsCache();
        const fromFolderPaths = path.join(root, "MappedModels");
        const roots = collectModelRoots({
            dir: "diffusion_models",
            folderPaths: { diffusion_models: [path.join(comfy, "models", "diffusion_models"), fromFolderPaths] },
            comfyDir: comfy,
            comfyRoot: comfy,
        });
        const normalized = roots.map((item) => item.toLowerCase());
        assert.ok(normalized.includes(path.join(comfy, "models", "diffusion_models").toLowerCase()));
        assert.ok(normalized.includes(fromFolderPaths.toLowerCase()));
        assert.ok(normalized.includes(path.join(extra, "diffusion_models").toLowerCase()));
        assert.ok(normalized.includes(path.join(comfy, "models", "unet").toLowerCase()));
        assert.equal(new Set(normalized).size, normalized.length);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("manual managed dirs are visible to resource scans even when ComfyUI folderPaths is empty", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-paths-manual-"));
    try {
        const comfy = path.join(root, "ComfyUI");
        const manual = path.join(root, "ManualModels");
        await fsp.mkdir(path.join(comfy, "models"), { recursive: true });
        await fsp.mkdir(manual, { recursive: true });
        await fsp.writeFile(path.join(comfy, "extra_model_paths.yaml"), [
            "# >>> local-canvas manual directories (managed)",
            "local_canvas_models_1:",
            `  base_path: ${manual.replace(/\\/g, "/")}`,
            "  diffusion_models: .",
            "# <<< local-canvas manual directories (managed)",
        ].join("\n"), "utf8");
        clearExtraModelPathsCache();
        const roots = collectModelRoots({ dir: "diffusion_models", folderPaths: {}, comfyDir: comfy, comfyRoot: comfy });
        assert.ok(roots.map((item) => item.toLowerCase()).includes(manual.toLowerCase()));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("modelRelativePath accepts roots and folds junction targets back", async (t) => {
    if (process.platform !== "win32") {
        t.skip("Windows junction test");
        return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-paths-link-"));
    try {
        const models = path.join(root, "ComfyUI", "models", "diffusion_models");
        const target = path.join(root, "OtherDrive", "models");
        await fsp.mkdir(models, { recursive: true });
        await fsp.mkdir(target, { recursive: true });
        await fsp.writeFile(path.join(target, "mapped.safetensors"), "x", "utf8");
        await fsp.symlink(target, path.join(models, "mapped"), "junction");

        const direct = modelRelativePath([models], path.join(models, "mapped", "mapped.safetensors"));
        assert.deepEqual(direct, { file: "mapped/mapped.safetensors", root: models });
        const viaTarget = modelRelativePath([models], path.join(target, "mapped.safetensors"));
        assert.deepEqual(viaTarget, { file: "mapped/mapped.safetensors", root: models });
        assert.equal(modelRelativePath([models], path.join(root, "elsewhere.safetensors")), null);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
