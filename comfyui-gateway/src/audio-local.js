import fs from "node:fs";
import path from "node:path";

import { runWorkflow } from "./runner.js";
import { convertUiWorkflow } from "./ui-workflow.js";
import { uploadImages } from "./uploads.js";
import { autoSongDuration } from "./audio-engine.js";

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aac)$/i;
const PRIMITIVE_INT = /^Primitive(Int|Float|String|Boolean)$/;

function pickAudio(files) {
  return files.find((f) => /^audio\//i.test(f.mimeType || "") || AUDIO_EXT.test(f.filename || ""));
}

// 画布会把上游文本块编号成「【文本1】」再拼进生成提示词；
// 台词/歌曲标签不能把这层编号念出来。
function stripCanvasTextLabels(text) {
  return String(text || "").replace(/(^|\n)\s*【文本\s*\d+】\s*/g, "$1").trim();
}

function uploadedAudioName(uploaded) {
  if (!uploaded?.name) return "";
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

async function uploadReference(comfy, referenceFile) {
  if (!referenceFile?.buffer) return "";
  const [uploaded] = await uploadImages(comfy, [referenceFile]);
  const name = uploadedAudioName(uploaded);
  if (!name) throw Object.assign(new Error("参考音频上传失败"), { status: 502, code: "reference_upload_failed" });
  return name;
}

// 用户 UI 工作流里的 PrimitiveInt/PrimitiveFloat 是前端真值节点，
// 转 API 后要把值内联到下游，且不能留一个 ComfyUI 不认识的节点。
function inlineFrontendValues(workflow) {
  for (const [id, node] of Object.entries(workflow)) {
    if (!PRIMITIVE_INT.test(String(node?.class_type || ""))) continue;
    const value = node.inputs?.value;
    for (const other of Object.values(workflow)) {
      for (const [name, input] of Object.entries(other.inputs || {})) {
        if (Array.isArray(input) && String(input[0]) === id) other.inputs[name] = value;
      }
    }
    delete workflow[id];
  }
  return workflow;
}

function findNode(workflow, classType) {
  return Object.entries(workflow).find(([, node]) => node?.class_type === classType);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function runAndPick({ workflow, name, comfy, config, logger, signal, requestId }) {
  const result = await runWorkflow({
    entry: { name, type: "audio", workflow, bindings: {}, defaults: {}, presets: {} },
    context: { prompt: "", count: 1, params: {} },
    comfy,
    timeoutMs: config.requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    signal,
    requestId,
    logger,
  });
  const file = pickAudio(result.files);
  if (!file) throw Object.assign(new Error("本地语音工作流没有返回音频输出"), { status: 502, code: "no_audio_output" });
  return { buffer: file.buffer, mimeType: file.mimeType || "audio/wav", filename: file.filename };
}

// 台词 / 零样本克隆：IndexTTS-2（本地节点）。reference 为必填参考音频；instructions 走情绪文本节点。
export async function synthesizeSpeech({ comfy, config, logger, text, seed, speed, instructions, referenceFile, signal, requestId }) {
  const content = stripCanvasTextLabels(text);
  if (!content) throw Object.assign(new Error("台词文本不能为空"), { status: 400, code: "missing_text" });
  const description = String(instructions || "").trim();
  if (!referenceFile?.buffer) {
    throw Object.assign(new Error("台词生成需要参考音色，请先上传 3–15 秒参考音频"), { status: 400, code: "missing_reference_audio" });
  }
  const referenceName = await uploadReference(comfy, referenceFile);
  const speechSpeed = clampNumber(speed, 1, 0.5, 2);
  const seedValue = Number.isFinite(seed) ? Math.trunc(seed) : Math.floor(Math.random() * 2 ** 32);
  const workflow = {
    "1": { class_type: "easy downloadIndexTTSAndLoadModel", inputs: { model: "IndexTTS-2", download_from: "modelscope" } },
    "2": { class_type: "LoadAudio", inputs: { audio: referenceName } },
    "3": {
      class_type: "easy indexTTSGenerate",
      inputs: {
        indextts_model: ["1", 0],
        text: content,
        unload_model: true,
        do_sample: true,
        temperature: 0.8,
        top_p: 0.9,
        top_k: 30,
        num_beams: 3,
        repetition_penalty: 10.0,
        length_penalty: 0.0,
        max_mel_tokens: 1815,
        max_tokens_per_sentence: 120,
        speech_speed: speechSpeed,
        seed: seedValue,
        ...(description ? { emotions: ["5", 0] } : { reference_audio: ["2", 0] }),
      },
    },
    "4": { class_type: "SaveAudio", inputs: { audio: ["3", 0], filename_prefix: "audio/indextts2" } },
  };
  if (description) {
    workflow["5"] = {
      class_type: "easy indexTTSEmotionText",
      inputs: { reference_audio: ["2", 0], voice_name: "", description, use_random: false },
    };
  }
  return runAndPick({ workflow, name: "indextts2-speech", comfy, config, logger, signal, requestId });
}

// 无参考台词：MiniMax H3 描述音色语音（T8 Speech Studio），不给参考音频也能自然说话。
const H3_SPEECH_LANGUAGES = {
  zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", fr: "French",
  de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic",
};
const H3_DEFAULT_VOICE = {
  Chinese: "一位成年女声，自然温暖，像面对面聊天，吐字清晰，情绪克制，有真实的停顿。",
  English: "An adult speaker with a natural warm voice, clear diction, human micro-pauses, and close conversational delivery.",
};

function estimateSpeechSeconds(text) {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const words = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return cjk * 0.26 + words * 0.42 + 1.5;
}

export async function synthesizeSpeechH3({ comfy, config, logger, text, voiceDescription, instructions, language, seed, signal, requestId }) {
  const content = stripCanvasTextLabels(text);
  if (!content) throw Object.assign(new Error("台词文本不能为空"), { status: 400, code: "missing_text" });
  const h3Language = H3_SPEECH_LANGUAGES[String(language || "zh").trim()] || "";
  if (!h3Language) throw Object.assign(new Error("H3 语音不支持该语言"), { status: 400, code: "unsupported_language" });
  const seconds = estimateSpeechSeconds(content);
  if (seconds > 15.08) {
    throw Object.assign(new Error(`台词约 ${Math.ceil(seconds)} 秒，超过 H3 单段约 15 秒上限；请把台词拆成多段再生成`), { status: 400, code: "text_too_long" });
  }
  const renderSeconds = clampNumber(seconds, 5.2, 5.17, 15.08);
  const description = String(voiceDescription || "").trim() || H3_DEFAULT_VOICE[h3Language] || H3_DEFAULT_VOICE.English;
  const direction = String(instructions || "").trim() || "自然、真诚、像面对面交谈，语速自然";
  const seedValue = Number.isFinite(seed) ? Math.trunc(seed) : Math.floor(Math.random() * 2 ** 31);
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "5": {
      class_type: "MiniMaxH3VoiceProfileT8",
      inputs: {
        voice_mode: "described_voice",
        speaker_id: "narrator",
        voice_description: description,
        language: h3Language,
        rights_confirmed: false,
        reference_start_seconds: 0,
        reference_duration_seconds: 0,
        highpass_60hz: true,
        peak_limit_minus_3_dbfs: true,
      },
    },
    "6": {
      class_type: "MiniMaxH3SpeechPlanT8",
      inputs: {
        voice_profile: ["5", 0],
        text: content,
        language: h3Language,
        acting_direction: direction,
        emotion: "neutral",
        emotion_intensity: 0.4,
        space: "studio",
        chunking: "single_segment",
        target_units: 18,
        max_units: 24,
      },
    },
    "7": {
      class_type: "MiniMaxH3SpeechStudioT8",
      inputs: {
        model: ["1", 0],
        clip: ["2", 0],
        video_vae: ["3", 0],
        audio_vae: ["4", 0],
        voice_profile: ["5", 0],
        speech_plan: ["6", 0],
        segment_index: 0,
        seed: seedValue,
        render_seconds: renderSeconds,
        resolution: 32,
        steps: 20,
        sampler_name: "res_multistep",
        scheduler: "simple",
        shift_video: 12,
        shift_audio: 3,
        trim_mode: "none",
        verify_mode: "off",
        asr_model_directory: "",
        asr_language: h3Language,
        min_similarity: 0.85,
        unload_asr_after_verify: true,
        speaker_check_mode: "off",
        speaker_model_directory: "",
        min_speaker_similarity: 0.86,
        unload_speaker_after_verify: true,
        peak_limit_dbfs: -1,
        release_policy: "unload_all_models",
      },
    },
    "8": { class_type: "SaveAudio", inputs: { audio: ["7", 0], filename_prefix: "audio/h3_speech" } },
  };
  return runAndPick({ workflow, name: "h3-speech", comfy, config, logger, signal, requestId });
}

// 歌曲：ACE-Step 1.5（用户 UI 工作流 → API）。UI 的主提示词同时作为 tags 与 lyrics；
// API 仍可单独传 lyrics。参考音色走 ACE 原生 ReferenceTimbreAudio（先把参考音频 VAE 编码成 timbre latent）。
const YUE2_COMFY_DEFAULT_CHECKPOINT = "yue2_3b_int8_convrot.safetensors";
export const YUE2_PRECISION_CHECKPOINTS = Object.freeze({
  fast: YUE2_COMFY_DEFAULT_CHECKPOINT,
  quality: "yue2_3b_bf16.safetensors",
});

export function resolveYue2Precision(rawPrecision, { envCheckpoint = "", bf16Installed = null } = {}) {
  const raw = rawPrecision === undefined || rawPrecision === null ? "" : String(rawPrecision).trim().toLowerCase();
  const precision = raw || "fast";
  if (precision !== "fast" && precision !== "quality") {
    const error = new Error('precision 只支持 "fast" 或 "quality"');
    error.status = 400;
    error.code = "invalid_precision";
    throw error;
  }
  if (precision === "quality") {
    if (bf16Installed === false) {
      const error = new Error("YuE2 质量档需要 yue2_3b_bf16.safetensors；请到资源中心安装 YuE2-3B BF16 后重试");
      error.status = 503;
      error.code = "audio_model_missing";
      error.details = { engine: "comfyui", resourceId: "yue2_3b_bf16" };
      throw error;
    }
    return { precision, checkpoint: YUE2_PRECISION_CHECKPOINTS.quality };
  }
  return { precision, checkpoint: String(envCheckpoint || "").trim() || YUE2_PRECISION_CHECKPOINTS.fast };
}

// ComfyUI 官方 YuE2 Text-to-Music 口径：ABC 规划 → GenerateMusic(max_duration 上限) → 由计划推导时长 → KSampler(cfg=1,32) → VAE。
export function buildYue2ComfyWorkflow({ style, lyrics, seed, mode = "full", seconds = 120, checkpoint = YUE2_COMFY_DEFAULT_CHECKPOINT, instrumental = false }) {
  const rawSeconds = Number(seconds);
  const resolvedSeconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : instrumental ? 200 : autoSongDuration(lyrics);
  const maxDuration = Math.round(clampNumber(resolvedSeconds, instrumental ? 200 : 120, 10, 300));
  const safeSeed = Math.trunc(clampNumber(seed, Date.now() % 2147483647, 0, Number.MAX_SAFE_INTEGER));
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": {
      class_type: "YuE2GenerateABC",
      inputs: { clip: ["1", 1], style, lyrics, seed: safeSeed, mode, max_abc_tokens: 8192, temperature: 0.7, top_p: 0.9, top_k: 30, repetition_penalty: 1.005, penalty_window: 100 },
    },
    ...(instrumental ? { "9": { class_type: "YuE2InstrumentalConvert", inputs: { abc: ["2", 0], overlap: "vocal", keep_chords: true } } } : {}),
    "3": {
      class_type: "YuE2GenerateMusic",
      inputs: { clip: ["1", 1], style, lyrics, abc: instrumental ? ["9", 0] : ["2", 0], seed: safeSeed, mode, max_duration: maxDuration, temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2 },
    },
    "4": { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["3", 1], batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["3", 0], negative: ["6", 0], latent_image: ["4", 0], seed: safeSeed, steps: 32, cfg: 1, sampler_name: "dpm_2", scheduler: "sgm_uniform", denoise: 1 },
    },
    "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["3", 0] } },
    "7": { class_type: "VAEDecodeAudio", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveAudio", inputs: { audio: ["7", 0], filename_prefix: "audio/yue2" } },
  };
}

export async function runYue2ComfySong({ comfy, config, logger, style, lyrics, seed, cot = "full", duration, signal, requestId, checkpoint, instrumental = false }) {
  const workflow = buildYue2ComfyWorkflow({ style, lyrics, seed, mode: String(cot || "full").toLowerCase() === "melody" ? "melody" : String(cot || "full").toLowerCase() === "off" ? "off" : "full", seconds: duration, checkpoint, instrumental });
  const result = await runAndPick({ workflow, name: instrumental ? "yue2-comfy-instrumental" : "yue2-comfy-song", comfy, config, logger, signal, requestId });
  return { buffer: result.buffer, mimeType: result.mimeType || "audio/flac", meta: { engine: "yue2-comfy", instrumental } };
}

export async function generateSong({ comfy, config, logger, tags, lyrics, bpm, duration, language, keyscale, timesignature, seed, referenceFile, signal, requestId }) {
  const promptTags = stripCanvasTextLabels(tags);
  if (!promptTags) throw Object.assign(new Error("歌曲提示词不能为空"), { status: 400, code: "missing_prompt" });
  const source = path.join(config.comfyWorkflowsDir || "", "▶▶ACE-Step-音乐&歌曲生成流.json");
  if (!config.comfyWorkflowsDir || !fs.existsSync(source)) {
    throw Object.assign(new Error("本机缺少 ACE-Step 歌曲工作流"), { status: 400, code: "song_workflow_missing" });
  }
  const objectInfo = await comfy.objectInfo();
  const ui = JSON.parse(fs.readFileSync(source, "utf8").replace(/^\uFEFF/, ""));
  const { workflow } = convertUiWorkflow(ui, objectInfo);
  inlineFrontendValues(workflow);

  const samplerEntry = findNode(workflow, "KSampler");
  const encodeEntry = findNode(workflow, "TextEncodeAceStepAudio1.5");
  const latentEntry = findNode(workflow, "EmptyAceStep1.5LatentAudio");
  const vaeEntry = findNode(workflow, "VAELoader");
  if (!samplerEntry || !encodeEntry || !latentEntry || !vaeEntry) {
    throw Object.assign(new Error("ACE-Step 工作流结构不完整"), { status: 502, code: "song_workflow_invalid" });
  }
  const [, sampler] = samplerEntry;
  const [encodeId, encode] = encodeEntry;
  const [, latent] = latentEntry;
  const [vaeId] = vaeEntry;

  const seconds = clampNumber(duration, Number(encode.inputs.duration) || 120, 10, 300);
  const songBpm = clampNumber(bpm, Number(encode.inputs.bpm) || 120, 10, 300);
  const songSeed = Number.isFinite(seed) ? Math.trunc(seed) : Math.floor(Math.random() * 2 ** 31);
  encode.inputs.tags = promptTags;
  encode.inputs.lyrics = stripCanvasTextLabels(lyrics) || promptTags;
  encode.inputs.bpm = songBpm;
  if (timesignature) encode.inputs.timesignature = String(timesignature);
  encode.inputs.duration = seconds;
  encode.inputs.language = String(language || encode.inputs.language || "zh");
  encode.inputs.keyscale = String(keyscale || encode.inputs.keyscale || "E minor");
  encode.inputs.seed = songSeed;
  latent.inputs.seconds = seconds;
  sampler.inputs.seed = songSeed;

  if (referenceFile?.buffer) {
    const referenceName = await uploadReference(comfy, referenceFile);
    workflow["audio_ref_load"] = { class_type: "LoadAudio", inputs: { audio: referenceName } };
    workflow["audio_ref_encode"] = { class_type: "VAEEncodeAudio", inputs: { audio: ["audio_ref_load", 0], vae: [vaeId, 0] } };
    workflow["audio_ref_timbre"] = { class_type: "ReferenceTimbreAudio", inputs: { conditioning: [encodeId, 0], latent: ["audio_ref_encode", 0] } };
    sampler.inputs.positive = ["audio_ref_timbre", 0];
    encode.inputs.generate_audio_codes = false;
  }

  return runAndPick({ workflow, name: "ace-step-song", comfy, config, logger, signal, requestId });
}
