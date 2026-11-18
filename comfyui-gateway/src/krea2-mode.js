const MODES = new Set(["fast", "quality", "ultra"]);
const ACCEL_LEVELS = new Set([5, 6, 7]);
const SAGE_NODE = "PathchSageAttentionKJ";

function snap8(value) {
  return Math.max(8, Math.round(value / 8) * 8);
}

function accelTransition(params) {
  const raw = Number(params?.krea2AccelT);
  return ACCEL_LEVELS.has(raw) ? raw : null;
}

function nextId(workflow, start) {
  let candidate = start;
  while (workflow[String(candidate)]) candidate += 1;
  return String(candidate);
}

/**
 * Krea2 V2 三档 + 加速（加速只挂一采）：
 * fast=一采；quality=二采（低清起稿→放大回设置尺寸→精修）；ultra=二采+USD（2×）。
 * accel（t5/6/7）把一采换成 SelfLift，并全局挂 SageAttention；关闭时保持原生。
 */
export function applyKrea2Mode(workflow, { entry, params, logger } = {}) {
  if (String(entry?.id || entry?.name || "") !== "image-krea2-turbo") return workflow;
  const mode = MODES.has(String(params?.krea2Mode || "")) ? String(params.krea2Mode) : "fast";
  const transition = accelTransition(params);
  const next = structuredClone(workflow);
  const latent = next["6"];
  const save = next["11"];
  if (!latent?.inputs || !save?.inputs || !next["8"]?.inputs || !next["9"]?.inputs || !next["10"]?.inputs) {
    return workflow;
  }
  const width = Math.max(64, Number(latent.inputs.width) || 1024);
  const height = Math.max(64, Number(latent.inputs.height) || 1024);
  const baseModel = next["7"]?.inputs?.model || ["1", 0];
  const seed = Math.floor(Number(next["7"]?.inputs?.noise_seed ?? next["9"].inputs.seed) || 0);
  const samplerName = next["7"]?.inputs?.sampler_name || next["9"].inputs.sampler_name || "euler";
  const schedulerName = next["7"]?.inputs?.scheduler || next["9"].inputs.scheduler || "simple";
  const cfg = Number(next["7"]?.inputs?.cfg ?? next["9"].inputs.cfg ?? 1);
  const boundSteps = Math.max(2, Math.floor(Number(next["7"]?.inputs?.steps) || 8));
  const modelSteps = Number(/【(\d+)步】/.exec(String(params?.unet || ""))?.[1]);
  const effectiveSteps = Number.isFinite(modelSteps) && modelSteps > 0 ? modelSteps : boundSteps;

  let samplerIds = [];
  if (mode === "fast") {
    if (transition) {
      // 一采替换为 SelfLift（目标尺寸）
      const selectId = nextId(next, 9101);
      const schedulerId = nextId(next, 9102 + Number(selectId));
      const liftId = nextId(next, 9200 + Number(selectId));
      next[selectId] = { class_type: "KSamplerSelect", inputs: { sampler_name: samplerName } };
      next[schedulerId] = { class_type: "BasicScheduler", inputs: { model: baseModel, scheduler: schedulerName, steps: effectiveSteps, denoise: 1 } };
      next[liftId] = {
        class_type: "SelfLiftImageSampler",
        inputs: {
          model: baseModel, positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], latent_image: ["6", 0],
          sampler: [selectId, 0], sigmas: [schedulerId, 0], seed, cfg,
          transition_step: transition, lowres_scale: 0.5, rho: 0.3, w_min: 0.5, w_max: 1.0, latent_upsample: "nearest",
        },
      };
      delete next["7"];
      next["10"].inputs.samples = [liftId, 0];
      samplerIds = [liftId, schedulerId];
    } else {
      next["7"].inputs.steps = effectiveSteps;
      next["7"].inputs.end_at_step = 10000;
      next["7"].inputs.return_with_leftover_noise = "disable";
      next["10"].inputs.samples = ["7", 0];
      samplerIds = ["7"];
    }
    save.inputs.images = ["10", 0];
  } else {
    const baseWidth = snap8(width / 1.5);
    const baseHeight = snap8(height / 1.5);
    latent.inputs.width = baseWidth;
    latent.inputs.height = baseHeight;
    next["8"].inputs.width = width;
    next["8"].inputs.height = height;
    if (transition) {
      const selectId = nextId(next, 9301);
      const schedulerId = nextId(next, 9402 + Number(selectId));
      const liftId = nextId(next, 9500 + Number(selectId));
      next[selectId] = { class_type: "KSamplerSelect", inputs: { sampler_name: samplerName } };
      next[schedulerId] = { class_type: "BasicScheduler", inputs: { model: baseModel, scheduler: schedulerName, steps: effectiveSteps, denoise: 1 } };
      next[liftId] = {
        class_type: "SelfLiftImageSampler",
        inputs: {
          model: baseModel, positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], latent_image: ["6", 0],
          sampler: [selectId, 0], sigmas: [schedulerId, 0], seed, cfg,
          transition_step: transition, lowres_scale: 0.5, rho: 0.3, w_min: 0.5, w_max: 1.0, latent_upsample: "nearest",
        },
      };
      delete next["7"];
      next["8"].inputs.samples = [liftId, 0];
      samplerIds = [liftId, schedulerId];
    } else {
      next["7"].inputs.steps = effectiveSteps;
      next["7"].inputs.end_at_step = Math.max(1, next["7"].inputs.steps - 2);
      samplerIds = ["7"];
    }
    next["9"].inputs.seed = seed + 1;
    next["9"].inputs.cfg = cfg;
    next["9"].inputs.sampler_name = samplerName;
    next["9"].inputs.scheduler = schedulerName;
    next["10"].inputs.samples = ["9", 0];
    samplerIds.push("9");
    if (mode === "ultra") {
      if (next["13"]?.inputs) {
        next["13"].inputs.seed = seed + 2;
        next["13"].inputs.cfg = cfg;
        next["13"].inputs.sampler_name = samplerName;
        next["13"].inputs.scheduler = schedulerName;
      }
      save.inputs.images = ["13", 0];
      samplerIds.push("13");
    } else {
      save.inputs.images = ["10", 0];
    }
  }

  if (transition && baseModel) {
    const sageId = nextId(next, 9601);
    next[sageId] = { class_type: SAGE_NODE, inputs: { model: baseModel, sage_attention: "auto", allow_compile: false } };
    for (const id of samplerIds) {
      if (next[id]?.inputs?.model) next[id].inputs.model = [sageId, 0];
    }
  }

  logger?.info?.(`Krea2 V2 档位 ${mode}${transition ? ` + SelfLift t${transition} + Sage` : ""}：请求 ${width}x${height}，sampler=${samplerName}/${schedulerName}，steps=${effectiveSteps}，cfg=${cfg}`);
  return next;
}
