import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSetupManager } from "../src/setup.js";

const entry = {
  id: "image-z-image-turbo",
  name: "image-z-image-turbo",
  type: "image",
  workflow: {
    1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors" } },
    3: { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  },
  baseModels: { param: "unet", classType: "UNETLoader", input: "unet_name", filter: "z-image|z_image" },
};

function objectInfo(unetFiles) {
  return {
    UNETLoader: { input: { required: { unet_name: [unetFiles] } } },
    CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } },
    VAELoader: { input: { required: { vae_name: [["ae.safetensors"]] } } },
  };
}

function createManager(dataDir, unetFiles, mainModelFile = () => "") {
  return createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: entry.id }],
      resolve: () => entry,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => objectInfo(unetFiles),
    },
    logger: null,
    mainModelFile,
  });
}

function createAliasManager(dataDir, unetFiles, workflow) {
  const custom = { ...entry, workflow, baseModels: undefined };
  return createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: custom.id }],
      resolve: () => custom,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => objectInfo(unetFiles),
    },
    logger: null,
    mainModelFile: () => "",
  });
}

test("auto-recognizes the same model file in a different subfolder", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-auto-"));
  try {
    const manager = createAliasManager(dataDir, ["zimage/z_image_turbo_bf16.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "zimage/z_image_turbo_bf16.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("base model alternatives must use the same file format", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-base-format-"));
  try {
    const manager = createManager(dataDir, ["z_image_turbo_int8.gguf"]);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    const problem = manager.workflowStatus(entry.id).problems.find((item) => item.type === "model");
    assert.match(problem?.message || "", /z_image_turbo_bf16\.safetensors/);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("a single working variant keeps the workflow entry active", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-variants-"));
  const variantEntry = {
    id: "multi-variant",
    name: "multi-variant",
    type: "image",
    workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "missing_base.safetensors" } } },
    variants: {
      v1: { workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "missing_v1.safetensors" } } } },
      v2: { workflow: { 1: { class_type: "UNETLoader", inputs: { unet_name: "present_v2.safetensors" } } } },
    },
  };
  try {
    const manager = createSetupManager({
      config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
      registry: {
        list: () => [{ id: variantEntry.id }],
        resolve: () => variantEntry,
        scan: async () => ({ imported: 0 }),
        reloadIfChanged: () => {},
      },
      comfy: {
        systemStats: async () => ({}),
        objectInfo: async () => objectInfo(["present_v2.safetensors"]),
      },
      logger: null,
      mainModelFile: () => "",
    });
    await manager.scan();
    assert.equal(manager.isAvailable(variantEntry.id), true);
    const status = manager.workflowStatus(variantEntry.id);
    assert.equal(status.available, true);
    assert.equal(status.variants.v2.available, true);
    assert.equal(status.variants.v1.available, false);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("a model on disk but not in ComfyUI's loader list is reported as restart, not missing", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-pending-"));
  const comfyRoot = path.join(dataDir, "ComfyUI");
  try {
    await fsp.mkdir(path.join(comfyRoot, "models", "diffusion_models"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "models", "text_encoders"), { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "models", "vae"), { recursive: true });
    await fsp.writeFile(path.join(comfyRoot, "models", "diffusion_models", "z_image_turbo_int8.safetensors"), "x");
    const manager = createSetupManager({
      config: { dataDir, comfyDir: comfyRoot, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
      registry: {
        list: () => [{ id: entry.id }],
        resolve: () => entry,
        scan: async () => ({ imported: 0 }),
        reloadIfChanged: () => {},
      },
      comfy: {
        systemStats: async () => ({}),
        objectInfo: async () => objectInfo([]),
      },
      logger: null,
      mainModelFile: () => "",
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    const problems = manager.workflowStatus(entry.id).problems;
    assert.ok(problems.some((problem) => problem.type === "restart"));
    assert.equal(problems.some((problem) => problem.type === "model" && /z_image_turbo_bf16/.test(problem.message)), false);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("degraded scans do not keep workflows marked available", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-degraded-"));
  try {
    const manager = createSetupManager({
      config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
      registry: {
        list: () => [{ id: entry.id }],
        resolve: () => entry,
        scan: async () => ({ imported: 0 }),
        reloadIfChanged: () => {},
      },
      comfy: {
        systemStats: async () => {
          throw new Error("ComfyUI down");
        },
        objectInfo: async () => ({}),
      },
      logger: null,
      mainModelFile: () => "",
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    const status = manager.workflowStatus(entry.id);
    assert.equal(status.available, false);
    assert.equal(status.stale, true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("fuzzy alias is runtime-only and never marks a resource as user-replaced", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-fuzzy-"));
  try {
    const manager = createAliasManager(dataDir, ["z_image_turbo_int8.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "z_image_turbo_int8.safetensors");
    assert.equal(manager.userModelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "");
    await manager.setModelAlias({ classType: "UNETLoader", input: "unet_name", from: "z_image_turbo_bf16.safetensors", to: "z_image_turbo_int8.safetensors" });
    assert.equal(manager.userModelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "z_image_turbo_int8.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("user replacement wins over a similarity match during execution", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-override-"));
  try {
    const manager = createAliasManager(dataDir, ["z_image_turbo_int8.safetensors", "local_other.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "z_image_turbo_int8.safetensors");
    await manager.setModelAlias({ classType: "UNETLoader", input: "unet_name", from: "z_image_turbo_bf16.safetensors", to: "local_other.safetensors" });
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "local_other.safetensors");
    assert.equal(manager.isAvailable(entry.id), true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("matches installed model filenames case-insensitively", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-case-"));
  try {
    const manager = createAliasManager(dataDir, ["ZImage/Z_Image_Turbo_BF16.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"), "ZImage/Z_Image_Turbo_BF16.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit alias only applies after the user chooses an installed candidate", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-alias-explicit-"));
  try {
    const manager = createAliasManager(dataDir, ["local_other.safetensors"], {
      1: { class_type: "UNETLoader", inputs: { unet_name: "missing_model.safetensors" } },
    });
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    const problem = manager.workflowStatus(entry.id).problems.find((item) => item.type === "model");
    assert.ok(problem?.candidates?.includes("local_other.safetensors"));
    await manager.setModelAlias({ classType: "UNETLoader", input: "unet_name", from: "missing_model.safetensors", to: "local_other.safetensors" });
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(manager.modelAliasFor("UNETLoader", "unet_name", "missing_model.safetensors"), "local_other.safetensors");
    const saved = JSON.parse(await fsp.readFile(path.join(dataDir, "model-aliases.json"), "utf8"));
    assert.equal(saved.aliases["UNETLoader\u0000unet_name\u0000missing_model.safetensors"], "local_other.safetensors");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow stays available when the default base model is absent but a tier variant is installed", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-base-fallback-"));
  try {
    const manager = createManager(dataDir, ["z_image_turbo_int8_convrot.safetensors"]);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.deepEqual(manager.loaderOptions().UNETLoader, ["z_image_turbo_int8_convrot.safetensors"]);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow stays available when a selected main model replaces the missing base", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-main-model-"));
  try {
    const manager = createManager(dataDir, ["my_custom_model.safetensors"], () => "my_custom_model.safetensors");
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("workflow is unavailable when no matching base model is installed", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-base-missing-"));
  try {
    const manager = createManager(dataDir, []);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), false);
    assert.ok(manager.workflowStatus(entry.id).problems.some((problem) => problem.type === "model"));
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("hidden tool workflows keep availability without entering model counts", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-hidden-tool-"));
  const hidden = {
    ...entry,
    id: "image-esrgan-upscale",
    name: "image-esrgan-upscale",
    hidden: true,
    category: "upscale",
    baseModels: undefined,
    workflow: { 1: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x2plus.pth" } } },
  };
  const manager = createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1024 * 1024 },
    registry: {
      list: () => [{ id: hidden.id }],
      resolve: () => hidden,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => ({
        UpscaleModelLoader: { input: { required: { model_name: [["RealESRGAN_x2plus.pth"]] } } },
      }),
    },
    logger: null,
    mainModelFile: () => "",
  });
  try {
    await manager.scan();
    assert.equal(manager.isAvailable(hidden.id), true);
    assert.equal(manager.state.counts.total, 0);
    assert.equal(manager.state.workflows.length, 0);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("a model placed in a deeper subfolder still activates the workflow", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-deep-"));
  try {
    const manager = createManager(dataDir, ["company/series/z_image_turbo_bf16.safetensors"]);
    await manager.scan();
    assert.equal(manager.isAvailable(entry.id), true);
    assert.equal(
      manager.modelAliasFor("UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"),
      "company/series/z_image_turbo_bf16.safetensors",
    );
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("an installed model value is never rewritten by similar matching", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-exact-no-alias-"));
  const custom = {
    id: "image-krea2-turbo",
    name: "image-krea2-turbo",
    type: "image",
    workflow: {
      2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" } },
    },
  };
  const manager = createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1 << 20 },
    registry: {
      list: () => [{ id: custom.id }],
      resolve: () => custom,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => ({
        CLIPLoader: { input: { required: { clip_name: [["qwen3vl_4b_bf16.safetensors", "qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_int8_convrot.safetensors", "qwen3vl_8b_bf16.safetensors"]] } } },
      }),
    },
    logger: null,
  });
  try {
    await manager.scan();
    assert.equal(manager.modelAliasFor("CLIPLoader", "clip_name", "qwen3vl_4b_fp8_scaled.safetensors"), "");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test("LLM mmproj replacement uses the mmproj option list, not the model list", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "setup-llm-mmproj-"));
  const custom = {
    id: "prompt-qwen",
    name: "prompt-qwen",
    type: "image",
    workflow: {
      1: { class_type: "llama_cpp_model_loader", inputs: { model: "Qwen3.5-9B-Q4_K_M.gguf", mmproj: "mmproj-BF16.gguf" } },
    },
  };
  const manager = createSetupManager({
    config: { dataDir, comfyUrl: "http://127.0.0.1:1", comfyWorkflowsDir: "", maxWorkflowBytes: 1 << 20 },
    registry: {
      list: () => [{ id: custom.id }],
      resolve: () => custom,
      scan: async () => ({ imported: 0 }),
      reloadIfChanged: () => {},
    },
    comfy: {
      systemStats: async () => ({}),
      objectInfo: async () => ({
        llama_cpp_model_loader: {
          input: {
            required: {
              model: [["Qwen3.5-9B-Q4_K_M.gguf", "other-model.gguf"]],
              mmproj: [["mmproj-BF16.gguf", "mmproj-27B.gguf"]],
            },
          },
        },
      }),
    },
    logger: null,
  });
  try {
    await manager.scan();
    await manager.setModelAlias({ classType: "llama_cpp_model_loader", input: "mmproj", from: "mmproj-BF16.gguf", to: "mmproj-27B.gguf" });
    assert.equal(manager.userModelAliasFor("llama_cpp_model_loader", "mmproj", "mmproj-BF16.gguf"), "mmproj-27B.gguf");
    assert.equal(manager.modelAliasFor("llama_cpp_model_loader", "mmproj", "mmproj-BF16.gguf"), "mmproj-27B.gguf");
    assert.equal(manager.modelAliasFor("llama_cpp_model_loader", "model", "Qwen3.5-9B-Q4_K_M.gguf"), "");
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
