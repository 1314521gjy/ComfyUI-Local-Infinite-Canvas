const MODES = new Set(["fast", "quality", "ultra"]);
const SAGE_NODE = "PathchSageAttentionKJ";
const KREA2_UNET = "krea2_turbo_fp8_scaled.safetensors";
const KREA2_CLIP = "qwen3vl_4b_fp8_scaled.safetensors";
const KREA2_VAE = "qwen_image_vae.safetensors";
const ZIMAGE_UNET = "z_image_turbo_bf16.safetensors";
const ZIMAGE_CLIP = "qwen_3_4b.safetensors";
const ZIMAGE_VAE = "ae.safetensors";
const UPSCALE_MODEL = "OmniSR_X4_DIV2K.safetensors";
const T2I_DENOISE = 0.45;
const EDIT_DENOISE = 0.2;
const SECOND_PASS_PROMPT = "Keep the scene, people, pose, action, and clothing unchanged. Preserve facial identity, background, composition, and framing exactly. Refine only fine detail and texture: natural skin, individual hair strands, fabric weave, crisp edges, and realistic photographic light. Do not add or remove anything.";

function nextId(workflow, start) {
  let candidate = start;
  while (workflow[String(candidate)]) candidate += 1;
  return String(candidate);
}

function findNode(workflow, classType) {
  for (const [id, node] of Object.entries(workflow || {})) {
    if (node?.class_type === classType) return id;
  }
  return null;
}

function addNode(workflow, classType, inputs) {
  const id = nextId(workflow, 1001);
  workflow[id] = { class_type: classType, inputs };
  return id;
}

/**
 * Qwen 2.1 文生图 / 多图编辑三档：
 * fast=仅 Qwen；quality=Qwen 一采 → 像素解码 → 二采（文生图 Krea2 0.45 / 多图编辑 Z-Image 0.2）；
 * ultra=quality + USD ×1.5。只在 t2i / edit 生效，其余模式原样返回。
 * 跨模型 latent 不通用，必须走像素；二采用低 denoise，保留 Qwen 的构图与文字。
 */
export function applyQwenHybridMode(workflow, { entry, params, mode, logger } = {}) {
  if (String(entry?.id || entry?.name || "") !== "image-qwen21") return workflow;
  if (!["t2i", "edit"].includes(String(mode || "t2i"))) return workflow;
  const tier = MODES.has(String(params?.qwenT2iMode || "")) ? String(params.qwenT2iMode) : "fast";
  const next = structuredClone(workflow);

  const cacheId = findNode(next, "QwenImage21Cache");
  const guiderId = findNode(next, "CFGGuider");
  const textId = findNode(next, "TextEncodeQwenImage21");
  const noiseId = findNode(next, "RandomNoise");
  const latentId = String(mode) === "t2i" ? findNode(next, "EmptyLatentImage") : null;
  const decodeId = findNode(next, "VAEDecode");
  const saveId = findNode(next, "SaveImage");
  if (!cacheId || !guiderId || !textId || !noiseId || !decodeId || !saveId) {
    logger?.warn?.("Qwen 2.1 文生图档位：工作流结构不匹配，保持原图");
    return workflow;
  }

  const seed = Math.floor(Number(next[noiseId].inputs?.noise_seed) || 0);
  const prompt = String(next[textId].inputs?.prompt || "");
  const negative = String(next[textId].inputs?.negative_prompt || "");
  const savePrefix = String(next[saveId].inputs?.filename_prefix || "QW21");
  const denoise = mode === "edit" ? EDIT_DENOISE : T2I_DENOISE;
  const width = latentId ? Math.max(64, Number(next[latentId].inputs?.width) || 1024) : null;
  const height = latentId ? Math.max(64, Number(next[latentId].inputs?.height) || 1024) : null;
  const sizeLabel = width && height ? `${width}x${height}` : "编辑原尺寸";

  const sageQ = nextId(next, 9001);
  next[sageQ] = { class_type: SAGE_NODE, inputs: { model: [cacheId, 0], sage_attention: "auto", allow_compile: false } };
  next[guiderId].inputs.model = [sageQ, 0];

  if (tier === "fast") {
    logger?.info?.(`Qwen 2.1 ${mode === "edit" ? "多图编辑" : "文生图"} 快速档：${sizeLabel}，Qwen + Sage`);
    return next;
  }

  const rgbId = addNode(next, "SplitImageWithAlpha", { image: [decodeId, 0] });
  const useZImage = String(mode) === "edit";
  let secondVae;
  let secondPositive;
  let secondNegative;
  let secondSage;
  let secondDecode;
  let secondSteps;

  if (useZImage) {
    const unetZ = addNode(next, "UNETLoader", { unet_name: ZIMAGE_UNET, weight_dtype: "default" });
    const clipZ = addNode(next, "CLIPLoader", { clip_name: ZIMAGE_CLIP, type: "qwen_image", device: "default" });
    secondVae = addNode(next, "VAELoader", { vae_name: ZIMAGE_VAE });
    secondPositive = addNode(next, "CLIPTextEncode", { clip: [clipZ, 0], text: SECOND_PASS_PROMPT });
    secondNegative = addNode(next, "ConditioningZeroOut", { conditioning: [secondPositive, 0] });
    const encodeZ = addNode(next, "VAEEncode", { pixels: [rgbId, 0], vae: [secondVae, 0] });
    secondSage = addNode(next, SAGE_NODE, { model: [unetZ, 0], sage_attention: "auto", allow_compile: false });
    secondSteps = 8;
    const samplerZ = addNode(next, "KSampler", {
      model: [secondSage, 0],
      positive: [secondPositive, 0],
      negative: [secondNegative, 0],
      latent_image: [encodeZ, 0],
      seed: seed + 1,
      steps: secondSteps,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise,
    });
    secondDecode = addNode(next, "VAEDecode", { samples: [samplerZ, 0], vae: [secondVae, 0] });
  } else {
    const unetK = addNode(next, "UNETLoader", { unet_name: KREA2_UNET, weight_dtype: "default" });
    const clipK = addNode(next, "CLIPLoader", { clip_name: KREA2_CLIP, type: "krea2", device: "default" });
    secondVae = addNode(next, "VAELoader", { vae_name: KREA2_VAE });
    secondPositive = addNode(next, "CLIPTextEncode", { clip: [clipK, 0], text: prompt });
    secondNegative = addNode(next, "CLIPTextEncode", { clip: [clipK, 0], text: negative });
    const encodeK = addNode(next, "VAEEncode", { pixels: [rgbId, 0], vae: [secondVae, 0] });
    secondSage = addNode(next, SAGE_NODE, { model: [unetK, 0], sage_attention: "auto", allow_compile: false });
    secondSteps = 4;
    const samplerK = addNode(next, "KSampler", {
      model: [secondSage, 0],
      positive: [secondPositive, 0],
      negative: [secondNegative, 0],
      latent_image: [encodeK, 0],
      seed: seed + 1,
      steps: secondSteps,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise,
    });
    secondDecode = addNode(next, "VAEDecode", { samples: [samplerK, 0], vae: [secondVae, 0] });
  }
  const saveK = addNode(next, "SaveImage", { images: [secondDecode, 0], filename_prefix: savePrefix });
  delete next[saveId];

  if (tier === "ultra") {
    const upscaler = addNode(next, "UpscaleModelLoader", { model_name: UPSCALE_MODEL });
    const usd = addNode(next, "UltimateSDUpscale", {
      image: [secondDecode, 0],
      model: [secondSage, 0],
      positive: [secondPositive, 0],
      negative: [secondNegative, 0],
      vae: [secondVae, 0],
      upscale_by: 1.5,
      seed: seed + 2,
      steps: secondSteps,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 0.15,
      upscale_model: [upscaler, 0],
      mode_type: "Linear",
      tile_width: 1024,
      tile_height: 1024,
      mask_blur: 16,
      tile_padding: 64,
      seam_fix_mode: "None",
      seam_fix_denoise: 1,
      seam_fix_width: 64,
      seam_fix_mask_blur: 8,
      seam_fix_padding: 16,
      force_uniform_tiles: true,
      tiled_decode: false,
      batch_size: 1,
    });
    next[saveK].inputs.images = [usd, 0];
  }

  const engineLabel = useZImage ? "Z-Image" : "Krea2";
  logger?.info?.(`Qwen 2.1 ${mode === "edit" ? "多图编辑" : "文生图"} ${tier} 档：${sizeLabel}，Qwen + ${engineLabel} 二采 ${secondSteps} 步 denoise ${denoise}${tier === "ultra" ? " + USD 1.5×" : ""}，全链 Sage`);
  return next;
}
