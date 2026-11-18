const ACCEL_LEVELS = new Set([5, 6, 7]);
const ACCEL_LOWRES = 0.5;
const ACCEL_RHO = 0.3;
const HIGH_RES_MIN_EDGE = 2048;

function accelTransition(params) {
  const raw = Number(params?.zimageAccelT);
  if (ACCEL_LEVELS.has(raw)) return raw;
  const legacy = params?.zimageAccel;
  if (legacy === true || legacy === "true" || legacy === 1 || legacy === "1") return 5;
  return null;
}

/**
 * Z-Image 生图加速：把现行工作流的 KSampler 换成 SelfLift（前 5 步低清、后 3 步高清）。
 * 只在 2K 及以上生效；低于阈值时按原生采样执行。
 */
export function applyZImageAccel(workflow, { entry, params, logger } = {}) {
  const transition = accelTransition(params);
  if (!transition) return { workflow, applied: false };
  const id = String(entry?.id || entry?.name || "");
  if (id !== "image-z-image-turbo") return { workflow, applied: false };

  const samplerEntry = Object.entries(workflow).find(([, node]) => node?.class_type === "KSampler" && node.inputs?.model && node.inputs?.latent_image);
  if (!samplerEntry) return { workflow, applied: false };
  const [samplerId, sampler] = samplerEntry;

  const latentRef = sampler.inputs.latent_image;
  const latent = Array.isArray(latentRef) ? workflow[String(latentRef[0])] : null;
  const width = Number(latent?.inputs?.width) || 0;
  const height = Number(latent?.inputs?.height) || 0;
  if (Math.max(width, height) < HIGH_RES_MIN_EDGE) {
    logger?.info?.(`Z-Image 加速已请求，但 ${width}x${height} 未达 2K，保持原生采样`);
    return { workflow, applied: false };
  }

  const decodeEntry = Object.entries(workflow).find(([, node]) => node?.class_type === "VAEDecode" && Array.isArray(node.inputs?.samples) && String(node.inputs.samples[0]) === samplerId);
  if (!decodeEntry) return { workflow, applied: false };
  const [decodeId, decode] = decodeEntry;
  const vaeRef = decode.inputs?.vae;
  if (!Array.isArray(vaeRef)) return { workflow, applied: false };

  const next = structuredClone(workflow);
  let candidate = 9101;
  const newId = () => {
    while (next[String(candidate)]) candidate += 1;
    return String(candidate++);
  };
  const selectorId = newId();
  const schedulerId = newId();
  const liftId = newId();
  const sageId = newId();
  next[sageId] = {
    class_type: "PathchSageAttentionKJ",
    inputs: { model: sampler.inputs.model, sage_attention: "auto", allow_compile: false },
    _meta: { title: "Gateway Sage Attention" },
  };
  const sageRef = [sageId, 0];
  const previewId = params?.preview === false ? null : newId();

  if (previewId) next[previewId] = {
    class_type: "ModelPreviewOverrideKJ",
    inputs: {
      model: sageRef,
      max_resolution: 1024,
      jpeg_quality: 80,
      suppress_default_preview: true,
      preview_frames: 1,
      preview_fps: 12,
    },
    _meta: { title: "Gateway Live Preview" },
  };
  const modelRef = previewId ? [previewId, 0] : sageRef;

  next[selectorId] = { class_type: "KSamplerSelect", inputs: { sampler_name: sampler.inputs.sampler_name || "euler" }, _meta: { title: "Gateway Sampler" } };
  next[schedulerId] = {
    class_type: "BasicScheduler",
    inputs: { model: modelRef, scheduler: sampler.inputs.scheduler || "simple", steps: Number(sampler.inputs.steps) || 8, denoise: Number(sampler.inputs.denoise ?? 1) },
    _meta: { title: "Gateway Scheduler" },
  };
  next[liftId] = {
    class_type: "SelfLiftImageSampler",
    inputs: {
      model: modelRef,
      positive: sampler.inputs.positive,
      negative: sampler.inputs.negative,
      vae: vaeRef,
      latent_image: sampler.inputs.latent_image,
      sampler: [selectorId, 0],
      sigmas: [schedulerId, 0],
      seed: sampler.inputs.seed,
      cfg: Number(sampler.inputs.cfg ?? 1),
      transition_step: transition,
      lowres_scale: ACCEL_LOWRES,
      rho: ACCEL_RHO,
      w_min: 0.5,
      w_max: 1.0,
      latent_upsample: "nearest",
    },
    _meta: { title: "SelfLift 生图加速" },
  };
  next[decodeId] = { ...decode, inputs: { ...decode.inputs, samples: [liftId, 0] } };
  delete next[samplerId];

  logger?.info?.(`Z-Image 生图加速：${width}x${height} t=${transition} lowres=${ACCEL_LOWRES} rho=${ACCEL_RHO}`);
  return { workflow: next, applied: true, meta: { width, height, transition, lowres: ACCEL_LOWRES, rho: ACCEL_RHO } };
}
