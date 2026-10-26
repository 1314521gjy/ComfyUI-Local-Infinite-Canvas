import crypto from "node:crypto";

import { clamp, deepClone, parseSize } from "./util.js";

export class BindingError extends Error {
  constructor(message, { code = "binding_error", details } = {}) {
    super(message);
    this.name = "BindingError";
    this.status = 400;
    this.code = code;
    this.details = details;
  }
}

export function buildContext({ prompt, negative, size, count, quality, seconds, mode, images = [], uploadedImages = [], uploadedVideos = [], uploadedAudios = [], params = {}, presets = {}, background } = {}) {
  const parsedSize = parseSize(size);
  const qualityValue = String(quality || "auto").trim().toLowerCase() || "auto";
  const preset = presets?.quality?.[qualityValue] || {};
  return {
    prompt: String(prompt || ""),
    negative: negative === undefined || negative === null ? undefined : String(negative),
    size: parsedSize ? { width: parsedSize.width, height: parsedSize.height, raw: parsedSize.raw } : undefined,
    count: clamp(Number(count) || 1, 1, 15),
    quality: { value: qualityValue, ...preset },
    seconds: Number(seconds) > 0 ? Number(seconds) : undefined,
    mode: mode ? String(mode) : undefined,
    background: background ? String(background) : undefined,
    images,
    uploadedImages,
    uploadedVideos,
    uploadedAudios,
    params: params && typeof params === "object" ? params : {},
  };
}

export function resolvePath(context, path) {
  if (!path) return undefined;
  let current = context;
  for (const part of String(path).split(".")) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function secondsToFrames(seconds, fps = 16) {
  const raw = Math.max(1, Math.round(Number(seconds) * Number(fps || 16)));
  // Wan / LTX 类节点普遍要求 4n+1 帧。
  return 4 * Math.round((raw - 1) / 4) + 1;
}

function secondsToFrames17(seconds, fps = 24) {
  const raw = Math.max(5, Math.round(Number(seconds) * Number(fps || 24)));
  // MiniMax-H3 要求向上取到 17k+5 帧（124 ≈ 5s @ 24fps）。
  return raw + ((5 - (raw % 17) + 17) % 17);
}

function applyTransform(value, binding) {
  switch (binding.transform) {
    case "secondsToFrames":
      return secondsToFrames(value, binding.fps || 16);
    case "secondsToFrames17":
      return secondsToFrames17(value, binding.fps || 24);
    case "snap16":
      return Math.max(16, Math.ceil(Number(value) / 16) * 16);
    case "snap32":
      return Math.max(32, Math.round(Number(value) / 32) * 32);
    case "round":
      return Math.round(Number(value));
    case "int":
      return Math.trunc(Number(value));
    case "invert10":
      return 10 - Number(value);
    case "boolean":
      return Boolean(value);
    default:
      return value;
  }
}

function imageValue(uploaded) {
  if (!uploaded) return undefined;
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function nextGatewayLoadId(workflow) {
  let id = 9101;
  while (workflow[String(id)]) id += 1;
  return String(id);
}

export function applyBindings(workflow, entry, context, { logger } = {}) {
  const next = deepClone(workflow);

  for (const [key, value] of Object.entries(entry.defaults || {})) {
    const [nodeId, input] = String(key).split(".");
    if (next[nodeId]?.inputs && input in next[nodeId].inputs) next[nodeId].inputs[input] = value;
  }

  for (const [key, binding] of Object.entries(entry.bindings || {})) {
    if (!binding || !binding.node || !binding.input) continue;
    const node = next[binding.node];
    const isImageBinding = binding.from === "image" || binding.imageIndex !== undefined;
    if (!node?.inputs || (!(binding.input in node.inputs) && !isImageBinding && !binding.array)) {
      logger?.warn?.(`binding ${key} 指向 ${binding.node}.${binding.input}，但工作流里没有这个输入，已跳过。`);
      continue;
    }

    if (binding.frameMode) {
      const images = (context.uploadedImages || []).slice(0, Number(binding.max || 2));
      const mode = String(context.params?.frameMode || (images.length >= 2 ? "both" : "first"));
      delete node.inputs[binding.firstInput || "first_frame"];
      delete node.inputs[binding.lastInput || "last_frame"];
      if (mode === "text") continue;
      const need = mode === "both" ? 2 : 1;
      if (images.length < need) {
        throw new BindingError(`首尾帧模式需要 ${need} 张图，但请求里只有 ${images.length} 张。`, { code: "missing_reference_image" });
      }
      const targets = [];
      if (mode === "first" || mode === "both") targets.push([binding.firstInput || "first_frame", images[0]]);
      if (mode === "last") targets.push([binding.lastInput || "last_frame", images[0]]);
      if (mode === "both") targets.push([binding.lastInput || "last_frame", images[1]]);
      for (const [input, uploaded] of targets) {
        const loadNodeId = nextGatewayLoadId(next);
        next[loadNodeId] = {
          class_type: "LoadImage",
          inputs: { image: imageValue(uploaded) },
          _meta: { title: `Gateway Frame ${input}` },
        };
        node.inputs[input] = [loadNodeId, 0];
      }
      continue;
    }

    if (binding.from === "video" && !binding.array) {
      const index = Number.isInteger(binding.videoIndex) ? binding.videoIndex : 0;
      const uploaded = context.uploadedVideos?.[index];
      const value = imageValue(uploaded);
      if (value !== undefined) {
        node.inputs[binding.input] = value;
      } else if (binding.required) {
        throw new BindingError(`工作流 ${entry.name} 缺少输入视频。`, { code: "missing_reference_media" });
      }
      continue;
    }

    if (binding.array) {
      const isVideo = binding.loadType === "video" || binding.from === "video";
      const isAudio = binding.loadType === "audio" || binding.from === "audio";
      const media = (isVideo ? context.uploadedVideos : isAudio ? context.uploadedAudios : context.uploadedImages) || [];
      const selected = media.slice(0, Number(binding.max || 8));
      const min = Number(binding.min || 0);
      if (selected.length < min) {
        throw new BindingError(`工作流需要至少 ${min} 个参考素材，但请求里只有 ${selected.length} 个。`, { code: "missing_reference_media" });
      }
      const prefix = String(binding.inputPrefix || binding.input || "ref_images.ref_image_");
      const indexBase = Number.isInteger(binding.indexBase) ? binding.indexBase : 0;
      for (const input of Object.keys(node.inputs)) {
        if (input.startsWith(prefix)) delete node.inputs[input];
      }
      selected.forEach((uploaded, index) => {
        const loadNodeId = nextGatewayLoadId(next);
        if (isVideo && binding.loader === "native") {
          next[loadNodeId] = {
            class_type: "LoadVideo",
            inputs: { file: imageValue(uploaded) },
            _meta: { title: `Gateway Video ${index + 1}` },
          };
          const componentsId = nextGatewayLoadId(next);
          next[componentsId] = {
            class_type: "GetVideoComponents",
            inputs: { video: [loadNodeId, 0] },
            _meta: { title: `Gateway Video Frames ${index + 1}` },
          };
          node.inputs[`${prefix}${indexBase + index}`] = [componentsId, 0];
          if (binding.sourceLengthInput) {
            const frames = Math.round(Number(context.sourceVideoFrames));
            if (Number.isFinite(frames) && frames > 0) node.inputs[binding.sourceLengthInput] = frames;
          }
          return;
        }
        if (isVideo) {
          next[loadNodeId] = {
            class_type: "VHS_LoadVideo",
            inputs: {
              video: imageValue(uploaded),
              force_rate: Number(binding.forceRate ?? 0),
              custom_width: 0,
              custom_height: 0,
              frame_load_cap: 0,
              skip_first_frames: 0,
              select_every_nth: 1,
              format: "AnimateDiff",
            },
            _meta: { title: `Gateway Video ${index + 1}` },
          };
        } else if (isAudio) {
          next[loadNodeId] = {
            class_type: "LoadAudio",
            inputs: { audio: imageValue(uploaded) },
            _meta: { title: `Gateway Audio ${index + 1}` },
          };
        } else {
          next[loadNodeId] = {
            class_type: "LoadImage",
            inputs: { image: imageValue(uploaded) },
            _meta: { title: `Gateway Ref ${index + 1}` },
          };
        }
        node.inputs[`${prefix}${indexBase + index}`] = [loadNodeId, 0];
        if (isVideo && binding.audioPrefix) {
          node.inputs[`${binding.audioPrefix}${indexBase + index}`] = [loadNodeId, 2];
        }
        if (isVideo && binding.sourceLengthInput) {
          const sourceLengthOutput = Number.isInteger(binding.sourceLengthOutput) ? binding.sourceLengthOutput : 1;
          node.inputs[binding.sourceLengthInput] = [loadNodeId, sourceLengthOutput];
        }
      });
      continue;
    }

    if (isImageBinding) {
      const index = Number.isInteger(binding.imageIndex) ? binding.imageIndex : 0;
      const uploaded = context.uploadedImages?.[index];
      const value = imageValue(uploaded);
      if (value !== undefined) {
        if (binding.asLink) {
          // H3 的可选帧/参考图是 IMAGE 类型 socket，必须挂 LoadImage 连线，不能直接塞文件名。
          let loadNodeId = binding.loadNodeId;
          if (!loadNodeId) {
            let candidate = 9001;
            while (next[String(candidate)]) candidate += 1;
            loadNodeId = String(candidate);
          }
          next[loadNodeId] = {
            class_type: "LoadImage",
            inputs: { image: value },
            _meta: { title: `Gateway Load ${index + 1}` },
          };
          node.inputs[binding.input] = [loadNodeId, 0];
        } else {
          node.inputs[binding.input] = value;
        }
      } else if (binding.required) {
        throw new BindingError(`工作流 ${entry.name} 需要第 ${index + 1} 张参考图，但请求里没有。`, { code: "missing_reference_image" });
      }
      continue;
    }

    let value;
    if (binding.from) value = resolvePath(context, binding.from);
    else if (key in context) value = context[key];

    if ((value === undefined || value === null || value === "") && binding.random) value = crypto.randomInt(1, 2147483647);
    if ((value === undefined || value === null || value === "") && binding.default !== undefined) value = binding.default;
    if (value === undefined || value === null) {
      if (binding.required) throw new BindingError(`缺少必填参数：${key}`, { code: "missing_parameter" });
      continue;
    }
    if (binding.map && Object.prototype.hasOwnProperty.call(binding.map, value)) value = binding.map[value];
    value = applyTransform(value, binding);
    node.inputs[binding.input] = value;
  }

  return next;
}

export { secondsToFrames, secondsToFrames17 };
