import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { extractVideoFrame, scoreVideoFrames } from "./viggle-long.js";
import { alignViggleFramesUp, randomId, sleep } from "./util.js";

const execFileAsync = promisify(execFile);

const IMAGE_SIZE = { width: 832, height: 480 };
const DEFAULT_SEED = 98742863019142;
const MAX_IMAGE_RETRIES = 2;
const MAX_VIDEO_RETRIES = 1;
const FRAMES = 124;
const REMAKE_FRAMES_MIN = 90;
const REMAKE_FRAMES_MAX = 345;
const SHORT_EDGE = 480;
const SWAP_SIGMAS = "1.0, 0.990476, 0.965243, 0.923077, 0.8, 0.631579, 0.0";
const EDIT_SIGMAS = "1.0, 0.983607, 0.96, 0.923077, 0.857143, 0.705882, 0.0";
const QWEN_SIGMAS = "1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.35, 0.152292, 0";
const QWEN_UNET = "qwen_image_2.1_bf16.safetensors";
const QWEN_LORA_6 = "p_q_image_2.1_6_steps_v0.2_comfyui_bf16.safetensors";
const QWEN_OLDX = "oldx-qwen2.1人物替换.safetensors";
const QWEN_CLIP = "qwen3vl_8b_int8_convrot.safetensors";
const QWEN_VAE = "qwen_image_2.1_vae_bf16.safetensors";
const SWAP_UNET = "viggle_remake_swap_pruned_int8_convrot.safetensors";
const H3_CLIP = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors";
const H3_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors";
const H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors";
const EDIT_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const EDIT_LORA = "viggle_remake_edit_comfyui.safetensors";

export class SwapChainError extends Error {
  constructor(message, { status = 500, code = "swap_chain_failed", details } = {}) {
    super(message);
    this.name = "SwapChainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function findBinary(name, config = {}) {
  const key = name === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH";
  const candidates = [
    process.env[key],
    name,
    config.comfyDir && path.join(config.comfyDir, `${name}.exe`),
    config.comfyDir && path.join(config.comfyDir, "..", `${name}.exe`),
    config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", `${name}.exe`),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return "";
}

function ffmpegOrThrow(config) {
  const binary = findBinary("ffmpeg", config);
  if (!binary) throw new SwapChainError("网关未找到 ffmpeg，无法抽帧/生成接触表", { status: 500, code: "ffmpeg_missing" });
  return binary;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function parseBox(value) {
  if (!value) return null;
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch { return null; }
  }
  if (typeof data !== "object") return null;
  const x = clamp01(data.x), y = clamp01(data.y);
  const width = Math.min(1 - x, clamp01(data.width ?? data.w ?? 0.45));
  const height = Math.min(1 - y, clamp01(data.height ?? data.h ?? 0.9));
  if (width < 0.05 || height < 0.05) return null;
  return { x, y, width, height };
}

function inferMode(intent, explicitMode) {
  const allowed = new Set(["single_swap", "double_swap", "edit_clothes", "edit_light", "edit_time"]);
  if (explicitMode && allowed.has(explicitMode)) return explicitMode;
  const text = String(intent || "");
  if (/双人|两人|两个都|同时换|左右都/.test(text)) return "double_swap";
  if (/衣服|服装|西装|换装|外套|裙|领带/.test(text)) return "edit_clothes";
  if (/黄昏|暖光|打光|光照|灯光|光线/.test(text)) return "edit_light";
  if (/夜晚|夜景|黑夜|时间|白天|天色/.test(text)) return "edit_time";
  return "single_swap";
}

function targetLabel(box) {
  if (!box) return "目标人物";
  return box.x + box.width / 2 >= 0.5 ? "画面右侧人物" : "画面左侧人物";
}

function defaultBoxes(mode, intent) {
  if (mode === "double_swap") return [
    { x: 0.04, y: 0.03, width: 0.45, height: 0.94 },
    { x: 0.51, y: 0.03, width: 0.45, height: 0.94 },
  ];
  if (mode === "edit_clothes" || mode === "edit_light" || mode === "edit_time") return [];
  const text = String(intent || "");
  const left = /左/.test(text) && !/右/.test(text);
  return [left ? { x: 0.04, y: 0.03, width: 0.45, height: 0.94 } : { x: 0.51, y: 0.03, width: 0.45, height: 0.94 }];
}

function buildSinglePrompt(job) {
  const label = targetLabel(job.targetBoxes[0]);
  return `<rwth>, 将${label}替换为参考图中的人物；严格保持参考人物的脸、发型和服装特征，保持另一人物、脸部、姿势、动作、位置、尺度、构图、茶具、背景和光照不变。只替换${label}，其他区域保持原样。`;
}

function buildDoublePrompt(job) {
  return `将画面左侧人物替换为图2中的人物，将画面右侧人物替换为图3中的人物；两人各自保持原姿势、动作、位置、尺度与持杯动作，保持构图、茶具、背景和光照不变；不要串脸、漏换或增加人物。`;
}

function buildEditPrompt(job) {
  const intent = String(job.intent || "").trim();
  if (job.mode === "edit_clothes") return `${intent || "改变右侧人物的服装"}；保持两个人物的身份、脸、发型、姿势、位置、尺度、构图、茶具、背景和光照不变，只改变目标人物的服装。`;
  if (job.mode === "edit_light") return `${intent || "改变场景光照"}；保持人物身份、脸、发型、服装、姿势、位置、尺度、构图和所有物体位置不变，只改变光照。`;
  return `${intent || "把时间改为夜晚"}；保持人物身份、脸、发型、服装、姿势、位置、尺度、构图和所有物体位置不变，只改变时间与夜景光照。`;
}

function buildSwapVideoPrompt(job) {
  if (job.mode === "double_swap") {
    return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video showing both replacement people.\n<Subject 1> is the person on the left in <Video 1>, replaced by the left-side person in <Picture 1>.\n<Subject 2> is the person on the right in <Video 1>, replaced by the right-side person in <Picture 1>.\n\nsummary:\n[video editing + character replacement] The target video is an edited version of <Video 1> where the left person becomes <Subject 1> and the right person becomes <Subject 2>, keeping the same actions. Background, props, camera, motion and timing of <Video 1> are kept.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - shot structure, camera path, scene, lighting and action timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - identity and wardrobe for both Subjects.\n<Subject 1> (appears in [Shot 1]): fully_preserved - left figure matches the left side of <Picture 1> throughout.\n<Subject 2> (appears in [Shot 1]): fully_preserved - right figure matches the right side of <Picture 1> throughout.\n\ndetailed_description:\nThe target video matches <Video 1> in scene, colour grade and camera.\n[Shot 1] From 00:00.000 to about 00:05.167, the left person becomes <Subject 1> and the right person becomes <Subject 2>, each following their own body path, poses and timing from <Video 1>. Hair and clothes move naturally. Only these two figures change; everything else stays as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
  }
  const label = targetLabel(job.targetBoxes[0]);
  return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video showing the replacement person.\n<Subject 1> is the person in <Picture 1>: they replace the ${label} in <Video 1>. The other person is not replaced.\n\nsummary:\n[video editing + character replacement] The target video is an edited version of <Video 1> where only the ${label} becomes <Subject 1> exactly as in <Picture 1>, keeping the same actions. Background, props, camera, motion and timing of <Video 1> are kept.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - shot structure, camera path, scene, lighting, the other person, and action timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - identity and wardrobe for <Subject 1> only.\n<Subject 1> (appears in [Shot 1]): fully_preserved - matches <Picture 1> throughout; no leftover original face, hair or clothes.\nThe other person (not a Subject): fully_preserved.\n\ndetailed_description:\nThe target video matches <Video 1> in scene, colour grade and camera.\n[Shot 1] From 00:00.000 to about 00:05.167, only the ${label} becomes <Subject 1>, following the same body path, poses and timing as <Video 1>. Hair and clothes move naturally. Everything else stays as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
}

function buildEditVideoPrompt(job) {
  if (job.mode === "edit_clothes") return buildSwapVideoPrompt({ ...job, mode: "single_swap", targetBoxes: [job.targetBoxes[0] || { x: 0.51, y: 0.03, width: 0.45, height: 0.94 }] }).replace(/replacement person/g, "target clothing").replace(/character replacement/g, "clothing edit");
  if (job.mode === "edit_light") return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video with the target lighting.\n<Subject 1> is the lighting of the scene: it becomes the lighting in <Picture 1>. All people, clothing, poses and geometry stay as in <Video 1>.\n\nsummary:\n[video editing] Only the lighting changes to match <Picture 1>; people, clothing, poses, objects, camera, motion and timing stay as in <Video 1>.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - people, clothing, poses, objects, camera and timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - lighting only.\n\ndetailed_description:\n[Shot 1] From 00:00.000 to about 00:05.167, the lighting matches <Picture 1>; all people, clothing, poses and object positions stay as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
  return `subject_definitions:\n<Video 1> is the source video.\n<Picture 1> is a frame of the target video at night.\n<Subject 1> is the time of the scene: it becomes night as in <Picture 1>. All people, clothing, poses and geometry stay as in <Video 1>.\n\nsummary:\n[video editing] Only the time and lighting change to night as in <Picture 1>; people, clothing, poses, objects, camera, motion and timing stay as in <Video 1>.\n\nretention_analysis:\n<Video 1> (source video editing): fully_preserved - people, clothing, poses, objects, camera and timing stay frame-accurate.\n<Picture 1> (appears in [Shot 1]): reference - night time and lighting only.\n\ndetailed_description:\n[Shot 1] From 00:00.000 to about 00:05.167, the scene becomes night with the lighting of <Picture 1>; all people, clothing, poses and object positions stay as in <Video 1>.\n\noverall_soundscape:\nThe source soundtrack continues throughout.\n\nnon_diegetic_music:\nN/A`;
}

async function runFfmpeg(binary, args, { timeout = 120000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return execFileAsync(binary, args, { timeout, maxBuffer, encoding: null });
}

function fitRemakeFrames(sourceFrameCount) {
  const count = Math.max(REMAKE_FRAMES_MIN, Math.min(REMAKE_FRAMES_MAX, Math.floor(Number(sourceFrameCount) || 0)));
  return alignViggleFramesUp(count);
}

async function probeSourceFrames(file, config) {
  let binary = findBinary("ffprobe", config);
  if (!binary) {
    try {
      binary = path.join(path.dirname(ffmpegOrThrow(config)), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    } catch {
      return 0;
    }
  }
  const { stdout } = await execFileAsync(binary, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,duration,avg_frame_rate", "-show_entries", "format=duration", "-of", "json", file], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const data = JSON.parse(stdout) || {};
  const stream = data.streams?.[0] || {};
  const duration = Number(stream.duration) > 0 ? Number(stream.duration) : Number(data.format?.duration);
  if (Number.isFinite(duration) && duration > 0) return Math.round(duration * 24);
  const rate = String(stream.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = rate[1] ? rate[0] / rate[1] : rate[0];
  const sourceFrames = Number(stream.nb_frames);
  if (Number.isFinite(sourceFrames) && sourceFrames > 0) {
    return Number.isFinite(fps) && fps > 0 ? Math.round((sourceFrames * 24) / fps) : Math.round(sourceFrames);
  }
  return 0;
}

async function padSourceToFrames(sourcePath, outputPath, sourceFrameCount, targetFrames, config) {
  const binary = ffmpegOrThrow(config);
  const padSeconds = Math.max(0, (targetFrames - sourceFrameCount) / 24);
  await runFfmpeg(binary, ["-y", "-i", sourcePath, "-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(6)}`, "-r", "24", "-frames:v", String(targetFrames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath], { timeout: 120000 });
  return outputPath;
}

async function trimToSourceDuration(inputPath, outputPath, seconds, config) {
  const binary = ffmpegOrThrow(config);
  await runFfmpeg(binary, ["-y", "-i", inputPath, "-t", Number(seconds).toFixed(6), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], { timeout: 120000 });
  return outputPath;
}

function formatComfyHistoryError(history) {
  const messages = Array.isArray(history?.status?.messages) ? history.status.messages : [];
  const executionError = messages.find((item) => Array.isArray(item) && item[0] === "execution_error")?.[1];
  if (executionError && typeof executionError === "object") {
    const node = [executionError.node_type, executionError.node_id].filter((value) => value !== undefined && value !== null && value !== "").join(" #");
    return `ComfyUI 执行失败${node ? `（${node}）` : ""}：${executionError.exception_message || executionError.exception_type || "未知错误"}`;
  }
  const summary = messages.map((item) => {
    const [event, data] = Array.isArray(item) ? item : [String(item), null];
    if (typeof data === "string") return `${event}:${data}`;
    if (data && typeof data === "object") return `${event}:${data.exception_message || data.message || JSON.stringify(data).slice(0, 300)}`;
    return event;
  }).join("；");
  return `ComfyUI 执行失败：${summary || "未知错误"}`;
}

async function resizeCover(buffer, config, outPath) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-resize-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", `scale=${IMAGE_SIZE.width}:${IMAGE_SIZE.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${IMAGE_SIZE.width}:${IMAGE_SIZE.height}`, "-frames:v", "1", outPath]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function maskImage(buffer, box, config, outPath) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-mask-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    const x = Math.round(box.x * IMAGE_SIZE.width);
    const y = Math.round(box.y * IMAGE_SIZE.height);
    const w = Math.max(8, Math.round(box.width * IMAGE_SIZE.width));
    const h = Math.max(8, Math.round(box.height * IMAGE_SIZE.height));
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.7:t=fill`, "-frames:v", "1", outPath]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function rgbGrid(buffer, config) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-grid-"));
  try {
    const input = path.join(tempDir, "input.png");
    await fsp.writeFile(input, buffer);
    const { stdout } = await runFfmpeg(binary, ["-v", "error", "-i", input, "-vf", "scale=64:36", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function inBox(x, y, box) {
  return x + 0.5 >= box.x * 64 && x + 0.5 < (box.x + box.width) * 64 && y + 0.5 >= box.y * 36 && y + 0.5 < (box.y + box.height) * 36;
}

function regionDiff(a, b, boxes, { inside = true } = {}) {
  let sum = 0, count = 0;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const px = (y * 64 + x) * 3;
      const match = boxes.some((box) => inBox(x, y, box));
      if ((inside && !match) || (!inside && match)) continue;
      sum += Math.abs(a[px] - b[px]) + Math.abs(a[px + 1] - b[px + 1]) + Math.abs(a[px + 2] - b[px + 2]);
      count += 3;
    }
  }
  return count ? sum / count : 0;
}

function histogram(buffer) {
  const bins = new Float64Array(64);
  for (let i = 0; i < buffer.length; i += 3) {
    const r = Math.min(3, Math.floor(buffer[i] / 64));
    const g = Math.min(3, Math.floor(buffer[i + 1] / 64));
    const b = Math.min(3, Math.floor(buffer[i + 2] / 64));
    bins[(r << 4) | (g << 2) | b] += 1;
  }
  const total = bins.reduce((sum, value) => sum + value, 0) || 1;
  return Array.from(bins, (value) => value / total);
}

function histCorr(a, b) {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - meanA, y = b[i] - meanB;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function cropGrid(grid, box) {
  const out = Buffer.alloc(grid.length);
  let index = 0;
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      if (!inBox(x, y, box)) continue;
      const px = (y * 64 + x) * 3;
      out[index++] = grid[px]; out[index++] = grid[px + 1]; out[index++] = grid[px + 2];
    }
  }
  return out.subarray(0, index);
}

async function evaluateImageGate(job, paintedBuffer, config) {
  const source = await fsp.readFile(job.paths.target);
  const targetGrid = await rgbGrid(source, config);
  const paintedGrid = await rgbGrid(paintedBuffer, config);
  const boxes = job.targetBoxes.length ? job.targetBoxes : [{ x: 0, y: 0, width: 1, height: 1 }];
  const outsideDiff = regionDiff(targetGrid, paintedGrid, boxes, { inside: false });
  const targetDiff = regionDiff(targetGrid, paintedGrid, boxes, { inside: true });
  const identity = [];
  for (let i = 0; i < Math.min(job.refs.length, boxes.length); i += 1) {
    const refGrid = await rgbGrid(await fsp.readFile(job.paths.refs[i]), config);
    const refHist = histogram(refGrid);
    const paintedHist = histogram(cropGrid(paintedGrid, boxes[i]));
    const sourceHist = histogram(cropGrid(targetGrid, boxes[i]));
    const paintedCorr = histCorr(refHist, paintedHist);
    const sourceCorr = histCorr(refHist, sourceHist);
    const delta = paintedCorr - sourceCorr;
    identity.push({ ref: job.refNames[i], paintedCorr: Number(paintedCorr.toFixed(4)), sourceCorr: Number(sourceCorr.toFixed(4)), delta: Number(delta.toFixed(4)), hit: delta >= -0.03, inconclusive: Math.abs(delta) < 0.02 });
  }
  const isEdit = job.mode.startsWith("edit_");
  const outsideOk = job.mode === "edit_light" || job.mode === "edit_time" ? true : isEdit ? outsideDiff < 55 : outsideDiff < 40;
  const changedOk = targetDiff > 7;
  const identityOk = !identity.length || identity.every((item) => item.hit);
  const pass = changedOk && outsideOk && identityOk;
  const negativeGrid = targetGrid;
  const negativeDiff = regionDiff(targetGrid, negativeGrid, boxes, { inside: true });
  return {
    method: "rgb64x36-proxy (no face embedding); identity is advisory, target-hit is enforced by targetDiff/outsideDiff",
    identityAdvisory: true,
    outsideDiff: Number(outsideDiff.toFixed(2)),
    targetDiff: Number(targetDiff.toFixed(2)),
    identity,
    outsideOk,
    changedOk,
    identityOk,
    negativeControl: { name: "unchanged-target", targetDiff: Number(negativeDiff.toFixed(2)), wouldPass: negativeDiff > 7 },
    pass,
  };
}

async function evaluateVideoGate(job, videoBuffer, config) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-vgate-"));
  try {
    const videoPath = path.join(tempDir, "output.mp4");
    await fsp.writeFile(videoPath, videoBuffer);
    const source = { buffer: await fsp.readFile(job.paths.source), originalname: "source.mp4" };
    const frames = [0, 32, 64, 96];
    const outputFrames = [];
    const sourceFrames = [];
    for (const frame of frames) {
      outputFrames.push(await extractVideoFrame({ buffer: videoBuffer, originalname: "output.mp4" }, { frame, config }));
      sourceFrames.push(await extractVideoFrame(source, { frame, config }));
    }
    const boxes = job.targetBoxes.length ? job.targetBoxes : [{ x: 0.04, y: 0.03, width: 0.92, height: 0.94 }];
    const readings = [];
    for (let i = 0; i < frames.length; i += 1) {
      const outGrid = await rgbGrid(outputFrames[i].buffer, config);
      const srcGrid = await rgbGrid(sourceFrames[i].buffer, config);
      const targetDiff = regionDiff(srcGrid, outGrid, boxes, { inside: true });
      const outsideDiff = regionDiff(srcGrid, outGrid, boxes, { inside: false });
      let luma = 0;
      for (let p = 0; p < outGrid.length; p += 3) luma += outGrid[p] * 0.299 + outGrid[p + 1] * 0.587 + outGrid[p + 2] * 0.114;
      luma /= outGrid.length / 3;
      readings.push({ frame: frames[i], targetDiff: Number(targetDiff.toFixed(2)), outsideDiff: Number(outsideDiff.toFixed(2)), luma: Number(luma.toFixed(1)) });
    }
    const targetMin = Math.min(...readings.map((item) => item.targetDiff));
    const outsideMax = Math.max(...readings.map((item) => item.outsideDiff));
    const backgroundMax = Math.max(...readings.filter((item) => item.frame < 80).map((item) => item.outsideDiff));
    const lumaMin = Math.min(...readings.map((item) => item.luma));
    const editTime = job.mode === "edit_time" || job.mode === "edit_light";
    const targetOk = targetMin > 6;
    const backgroundOk = editTime ? true : backgroundMax < 60;
    const blackOk = lumaMin > 8;
    const unchanged = { frame: 0, targetDiff: 0, outsideDiff: 0, luma: 0 };
    return {
      method: "rgb64x36-proxy (no face embedding)",
      samples: readings,
      targetMin: Number(targetMin.toFixed(2)),
      outsideMax: Number(outsideMax.toFixed(2)),
      backgroundMax: Number(backgroundMax.toFixed(2)),
      lumaMin: Number(lumaMin.toFixed(1)),
      targetOk,
      backgroundOk,
      blackOk,
      negativeControl: { name: "unchanged-source", targetDiff: unchanged.targetDiff, wouldPass: unchanged.targetDiff > 6 },
      pass: targetOk && backgroundOk && blackOk,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function makeContactSheet(videoBuffer, config, outPath) {
  const binary = ffmpegOrThrow(config);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swap-chain-contact-"));
  try {
    const input = path.join(tempDir, "output.mp4");
    await fsp.writeFile(input, videoBuffer);
    await runFfmpeg(binary, ["-y", "-i", input, "-vf", "select='not(mod(n\\,8))',scale=240:-1,tile=4x4", "-frames:v", "1", outPath], { timeout: 120000 });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function imageGraph(job, names) {
  const single = job.mode === "single_swap";
  const double = job.mode === "double_swap";
  const refs = names.refs;
  const graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: QWEN_UNET, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: QWEN_LORA_6, strength_model: 1 } },
    "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: QWEN_OLDX, strength_model: single ? 0.9 : 0 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: QWEN_CLIP, type: "qwen_image", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: QWEN_VAE } },
    "6": { class_type: "LoadImage", inputs: { image: names.target } },
    "10": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["4", 0], vae: ["5", 0], negative_prompt: "extra fingers, missing fingers, deformed hands, bad anatomy, malformed hands", resolution: 1024 } },
    "11": { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["5", 0] } },
    "12": { class_type: "CFGGuider", inputs: { model: ["3", 0], positive: ["10", 0], negative: ["10", 1], cfg: 1 } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: job.seed } },
    "14": { class_type: "ManualSigmas", inputs: { sigmas: QWEN_SIGMAS } },
    "15": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["15", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["5", 0] } },
    "18": { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: `swap-chain/${job.id}/painted` } },
  };
  if (single) {
    graph["10"].inputs["images.image_1"] = ["7", 0];
    graph["10"].inputs["images.image_2"] = ["6", 0];
    graph["10"].inputs.prompt = buildSinglePrompt(job);
  } else if (double) {
    graph["10"].inputs["images.image_1"] = ["6", 0];
    graph["10"].inputs["images.image_2"] = ["7", 0];
    graph["10"].inputs["images.image_3"] = ["8", 0];
    graph["10"].inputs.prompt = buildDoublePrompt(job);
  } else {
    graph["10"].inputs["images.image_1"] = ["6", 0];
    graph["10"].inputs.prompt = buildEditPrompt(job);
  }
  for (let i = 0; i < Math.min(refs.length, 2); i += 1) {
    graph[String(7 + i)] = { class_type: "LoadImage", inputs: { image: refs[i] } };
  }
  return graph;
}

function swapVideoGraph(job, names) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: SWAP_UNET, weight_dtype: "default" } },
    "21": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["1", 0], shift_video: 12, shift_audio: 2 } },
    "22": { class_type: "ModelAttentionBackend", inputs: { model: ["21", 0], attention: "comfy kitchen attention" } },
    "23": { class_type: "ModelPreviewOverrideKJ", inputs: { model: ["22", 0], max_resolution: 1024, jpeg_quality: 80, suppress_default_preview: true, preview_frames: 1024, preview_fps: 12, tiny_vae: "taeh3.safetensors" } },
    "24": { class_type: "BlockSparseAttention", inputs: { model: ["23", 0], selection: "sol-attn", "selection.tau": 1.1, start_percent: 0.2, end_percent: 1, dense_blocks: "", min_tokens: 12288, extra_tokens: 256, sink_conditioning: "exact_kv_and_rows", verbose: false } },
    "3": { class_type: "RemakeKeyframeUntil", inputs: { model: ["24", 0], keyframe_until: 0.9 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: H3_CLIP, type: "minimax", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: H3_VIDEO_VAE } },
    "6": { class_type: "VAELoader", inputs: { vae_name: H3_AUDIO_VAE } },
    "9": { class_type: "LoadImage", inputs: { image: names.painted } },
    "9102": { class_type: "VHS_LoadVideo", inputs: { video: names.source, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 345, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } },
    "42": { class_type: "RemakeConditioning", inputs: { clip: ["4", 0], vae: ["5", 0], audio_vae: ["6", 0], source: ["9102", 0], prompt: buildSwapVideoPrompt(job), ref_1: ["9", 0], pins: "", frames: job.frames || FRAMES, short_edge: SHORT_EDGE, audio: ["9102", 2] } },
    "12": { class_type: "RemakeNoise", inputs: { positive: ["42", 0], seed: job.seed } },
    "13": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["42", 0] } },
    "14": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "15": { class_type: "ManualSigmas", inputs: { sigmas: SWAP_SIGMAS } },
    "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["13", 0], sampler: ["14", 0], sigmas: ["15", 0], latent_image: ["42", 1] } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["5", 0] } },
    "18": { class_type: "VAEDecodeAudio", inputs: { samples: ["16", 0], vae: ["6", 0] } },
    "19": { class_type: "CreateVideo", inputs: { images: ["17", 0], audio: ["18", 0], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } },
    "20": { class_type: "SaveVideo", inputs: { video: ["19", 0], filename_prefix: `swap-chain/${job.id}/video`, format: "mp4", codec: "h264" } },
  };
}

function editVideoGraph(job, names) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: EDIT_UNET, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderBypassModelOnly", inputs: { model: ["1", 0], lora_name: EDIT_LORA, strength_model: 1 } },
    "3": { class_type: "RemakeKeyframeUntil", inputs: { model: ["2", 0], keyframe_until: 0.9 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: H3_CLIP, type: "minimax", device: "default" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: H3_VIDEO_VAE } },
    "6": { class_type: "VAELoader", inputs: { vae_name: H3_AUDIO_VAE } },
    "7": { class_type: "VHS_LoadVideo", inputs: { video: names.source, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 345, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } },
    "8": { class_type: "LoadImage", inputs: { image: names.painted } },
    "30": { class_type: "PathchSageAttentionKJ", inputs: { model: ["3", 0], sage_attention: "auto", allow_compile: false } },
    "9": { class_type: "RemakeConditioning", inputs: { clip: ["4", 0], vae: ["5", 0], audio_vae: ["6", 0], source: ["7", 0], ref_1: ["8", 0], pins: "", frames: job.frames || FRAMES, short_edge: SHORT_EDGE, prompt: buildEditVideoPrompt(job), audio: ["7", 2] } },
    "10": { class_type: "RemakeNoise", inputs: { positive: ["9", 0], seed: job.seed } },
    "11": { class_type: "BasicGuider", inputs: { model: ["30", 0], conditioning: ["9", 0] } },
    "12": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "13": { class_type: "ManualSigmas", inputs: { sigmas: EDIT_SIGMAS } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["11", 0], sampler: ["12", 0], sigmas: ["13", 0], latent_image: ["9", 1] } },
    "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["5", 0] } },
    "16": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["6", 0] } },
    "17": { class_type: "CreateVideo", inputs: { images: ["15", 0], audio: ["16", 0], fps: 24, bit_depth: "auto", color_space: "sRGB", codec: "none" } },
    "18": { class_type: "SaveVideo", inputs: { video: ["17", 0], filename_prefix: `swap-chain/${job.id}/video`, format: "mp4", codec: "h264" } },
  };
}

export function createSwapChain({ comfy, config, logger, dataDir }) {
  const root = path.join(dataDir, "swap-chain");
  const storeFile = path.join(dataDir, "swap-chain-jobs.json");
  fs.mkdirSync(root, { recursive: true });
  let jobs = new Map();
  let loaded = false;
  let activeJobId = null;
  const queue = [];

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (fs.existsSync(storeFile)) {
        const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
        for (const job of data.jobs || []) {
          if (job.status === "running" || job.status === "queued") {
            job.status = "interrupted";
            job.error = "网关重启导致任务中断；可点击重试从图像阶段继续";
            job.updatedAt = new Date().toISOString();
          }
          jobs.set(job.id, job);
        }
      }
    } catch (error) {
      logger?.warn?.(`swap-chain job 存储读取失败：${error.message}`);
    }
  }

  function save() {
    writeJsonAtomic(storeFile, { version: 1, updatedAt: new Date().toISOString(), jobs: [...jobs.values()] });
  }

  function publicJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      mode: job.mode,
      intent: job.intent,
      targetBoxes: job.targetBoxes,
      seed: job.seed,
      sourceFrameCount: job.sourceFrameCount ?? null,
      frames: job.frames ?? null,
      promptIds: job.promptIds,
      gates: job.gates,
      error: job.error || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      artifacts: {
        video: `/v1/swap-chain/${job.id}/content/video`,
        painted: `/v1/swap-chain/${job.id}/content/painted`,
        target: `/v1/swap-chain/${job.id}/content/target`,
        contact: `/v1/swap-chain/${job.id}/content/contact`,
      },
    };
  }

  function jobDir(id) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function update(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    save();
  }

  async function create({ source, refs = [], intent = "", mode, targetSelection, seed }) {
    load();
    if (!source?.buffer?.length) throw new SwapChainError("缺少源视频", { status: 400, code: "missing_source_video" });
    const selectedMode = inferMode(intent, mode);
    if (selectedMode === "double_swap" && refs.length < 2) throw new SwapChainError("双人替换需要 2 张参考图", { status: 400, code: "missing_reference" });
    if (selectedMode !== "double_swap" && selectedMode.endsWith("_swap") && !refs.length) throw new SwapChainError("换人需要至少 1 张参考图", { status: 400, code: "missing_reference" });
    const parsed = parseBox(targetSelection);
    const explicitBoxes = Array.isArray(targetSelection?.boxes) ? targetSelection.boxes.map(parseBox).filter(Boolean) : [];
    const boxes = explicitBoxes.length ? explicitBoxes : parsed ? [parsed] : defaultBoxes(selectedMode, intent);
    const id = randomId("swap_");
    const dir = jobDir(id);
    await fsp.writeFile(path.join(dir, "source.mp4"), source.buffer);
    const refNames = [];
    const refPaths = [];
    for (let i = 0; i < refs.length; i += 1) {
      const name = `ref-${i}.png`;
      await fsp.writeFile(path.join(dir, name), refs[i].buffer);
      refNames.push(name);
      refPaths.push(path.join(dir, name));
    }
    const job = {
      id, mode: selectedMode, intent: String(intent || "").trim(), targetBoxes: boxes,
      seed: Number(seed) || DEFAULT_SEED,
      status: "queued", stage: "s1_intent", progress: 0,
      refs: refs.map((item, index) => ({ name: refNames[index], filename: item.originalname || refNames[index], mimeType: item.mimetype || "image/png" })),
      refNames, paths: { dir, source: path.join(dir, "source.mp4"), target: path.join(dir, "target.png"), masked: path.join(dir, "target-masked.png"), painted: path.join(dir, "painted.png"), video: path.join(dir, "video.mp4"), contact: path.join(dir, "contact.png"), refs: refPaths },
      promptIds: [], gates: {}, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    jobs.set(id, job);
    save();
    queue.push(id);
    pump();
    return publicJob(job);
  }

  function fail(job, error) {
    if (!job) return;
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.stage = job.stage || "unknown";
    job.error = error?.message || String(error);
    job.errorCode = error?.code || "swap_chain_failed";
    job.updatedAt = new Date().toISOString();
    save();
    logger?.warn?.(`swap-chain ${job.id} failed at ${job.stage}: ${job.error}`);
  }

  async function waitPrompt(job, graph, { stage, timeoutMs = 15 * 60 * 1000 }) {
    const submitted = await comfy.submit(graph, { clientId: `swap-chain-${job.id}`, signal: undefined });
    job.promptIds.push({ stage, promptId: submitted.promptId });
    update(job, {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (job.cancelRequested) {
        await comfy.interrupt(submitted.promptId).catch(() => {});
        throw new SwapChainError("任务已取消", { status: 499, code: "cancelled" });
      }
      await sleep(2000);
      const history = await comfy.history(submitted.promptId).catch(() => null);
      if (!history) continue;
      if (history.status?.status_str === "error") throw new SwapChainError(formatComfyHistoryError(history), { status: 502, code: "comfy_failed" });
      if (history.outputs && Object.keys(history.outputs).length) return { history, promptId: submitted.promptId };
    }
    await comfy.interrupt(submitted.promptId).catch(() => {});
    throw new SwapChainError("ComfyUI 执行超时", { status: 504, code: "comfy_timeout" });
  }

  function outputFile(history) {
    for (const output of Object.values(history.outputs || {})) {
      for (const key of ["images", "gifs", "videos"]) {
        const file = output?.[key]?.[0];
        if (file?.filename) return file;
      }
    }
    return null;
  }

  async function upload(buffer, name, mimeType) {
    return comfy.uploadImage(buffer, name, mimeType);
  }

  function pump() {
    if (activeJobId) return;
    while (queue.length) {
      const id = queue.shift();
      const next = jobs.get(id);
      if (!next || next.status !== "queued") continue;
      activeJobId = id;
      run(next).finally(() => { activeJobId = null; pump(); });
      return;
    }
  }

  async function prepareStage(job, stage) {
    await comfy.freeMemory().catch((error) => logger?.warn?.(`swap-chain /free 失败：${error.message}`));
    const stats = await comfy.systemStats().catch(() => null);
    const device = stats?.devices?.[0];
    const freeMb = device?.vram_free ? Math.round(Number(device.vram_free) / (1024 * 1024)) : 0;
    job.vram = { ...(job.vram || {}), [stage]: freeMb };
    update(job, {});
  }

  async function run(job) {
    load();
    if (job.status === "cancelled") return;
    job.status = "running";
    job.cancelRequested = false;
    update(job, { stage: "s2_frame", progress: 8 });
    try {
      const source = { buffer: await fsp.readFile(job.paths.source), originalname: "source.mp4" };
      let sourceFrameCount = 0;
      try {
        sourceFrameCount = await probeSourceFrames(job.paths.source, config);
      } catch (error) {
        logger?.warn?.(`swap-chain 源帧数探测失败：${error.message}`);
      }
      job.sourceFrameCount = sourceFrameCount;
      job.frames = sourceFrameCount > 0 ? fitRemakeFrames(sourceFrameCount) : FRAMES;
      update(job, {});
      let frame = await extractVideoFrame(source, { frame: 0, config });
      let score = null;
      try {
        const scored = await scoreVideoFrames([frame], { config, references: job.refs.map((_item, index) => ({ buffer: fs.readFileSync(job.paths.refs[index]) })) });
        score = scored[0] || null;
        if (score?.black) {
          frame = await extractVideoFrame(source, { frame: 64, config });
          score = { ...(score || {}), fallback: "first-frame-black" };
        }
      } catch { /* 选帧打分为可选，失败仍用首帧 */ }
      job.frame = frame.frame;
      job.frameScore = score ? { score: score.score, similarity: score.similarity, black: score.black, fallback: score.fallback } : null;
      await resizeCover(frame.buffer, config, job.paths.target);
      if (job.mode === "single_swap") {
        await maskImage(await fsp.readFile(job.paths.target), job.targetBoxes[0], config, job.paths.masked);
      } else {
        await fsp.copyFile(job.paths.target, job.paths.masked);
      }
      const targetImage = await upload(await fsp.readFile(job.paths.masked), "swap-target.png", "image/png");
      const refImages = [];
      for (let i = 0; i < job.paths.refs.length; i += 1) {
        refImages.push(await upload(await fsp.readFile(job.paths.refs[i]), `swap-ref-${i}.png`, "image/png"));
      }
      await prepareStage(job, "s3_image");
      update(job, { stage: "s3_image", progress: 20 });
      let painted = null;
      let imageGate = null;
      for (let attempt = 0; attempt <= MAX_IMAGE_RETRIES; attempt += 1) {
        const graph = imageGraph(job, { target: targetImage.name, refs: refImages.map((item) => item.name) });
        if (attempt > 0) {
          const node = graph["10"];
          node.inputs.prompt = `${node.inputs.prompt} 目标区域之外保持完全不变；只替换指定目标人物。`;
          graph["13"].inputs.noise_seed = job.seed + attempt;
        }
        const { history, promptId } = await waitPrompt(job, graph, { stage: `s3_image_${attempt}` });
        const file = outputFile(history);
        if (!file) throw new SwapChainError("图像制备没有输出", { status: 502, code: "image_no_output" });
        const view = await comfy.view(file);
        painted = view.buffer;
        await fsp.writeFile(job.paths.painted, painted);
        update(job, { stage: "s4_image_gate", progress: 35 });
        imageGate = await evaluateImageGate(job, painted, config);
        job.gates.image = { ...imageGate, attempt, promptId };
        update(job, {});
        if (imageGate.pass) break;
      }
      if (!imageGate?.pass) throw new SwapChainError("图像门未通过：目标未命中/身份或背景保持不足", { status: 422, code: "image_gate_failed", details: imageGate });
      await prepareStage(job, "s5_video");
      update(job, { stage: "s5_video", progress: 45 });
      const paintedImage = await upload(painted, "swap-painted.png", "image/png");
      let videoSourcePath = job.paths.source;
      if (job.sourceFrameCount > 0 && job.frames > job.sourceFrameCount) {
        try {
          videoSourcePath = await padSourceToFrames(job.paths.source, path.join(job.paths.dir, "source-padded.mp4"), job.sourceFrameCount, job.frames, config);
          job.paddedSource = videoSourcePath;
          update(job, {});
        } catch (error) {
          throw new SwapChainError(`源视频补帧失败：${error.message}`, { status: 500, code: "source_pad_failed" });
        }
      }
      const sourceVideo = await upload(await fsp.readFile(videoSourcePath), "swap-source.mp4", "video/mp4");
      let video = null;
      let videoGate = null;
      for (let attempt = 0; attempt <= MAX_VIDEO_RETRIES; attempt += 1) {
        const graph = job.mode.startsWith("edit_")
          ? editVideoGraph(job, { source: sourceVideo.name, painted: paintedImage.name })
          : swapVideoGraph(job, { source: sourceVideo.name, painted: paintedImage.name });
        if (attempt > 0) graph[Object.keys(graph).find((id) => graph[id].class_type === "RemakeNoise")]?.inputs && (graph[Object.keys(graph).find((id) => graph[id].class_type === "RemakeNoise")].inputs.seed = job.seed + attempt);
        const { history, promptId } = await waitPrompt(job, graph, { stage: `s5_video_${attempt}`, timeoutMs: 20 * 60 * 1000 });
        const file = outputFile(history);
        if (!file) throw new SwapChainError("视频生成没有输出", { status: 502, code: "video_no_output" });
        const view = await comfy.view(file);
        video = view.buffer;
        await fsp.writeFile(job.paths.video, video);
        await makeContactSheet(video, config, job.paths.contact).catch(() => {});
        update(job, { stage: "s6_video_gate", progress: 80 });
        videoGate = await evaluateVideoGate(job, video, config);
        job.gates.video = { ...videoGate, attempt, promptId };
        update(job, {});
        if (videoGate.pass) break;
      }
      if (!videoGate?.pass) throw new SwapChainError("视频门未通过：身份未持续/背景或亮度异常", { status: 422, code: "video_gate_failed", details: videoGate });
      if (job.sourceFrameCount > 0 && job.frames > job.sourceFrameCount) {
        const trimmedPath = `${job.paths.video}.trim.mp4`;
        await trimToSourceDuration(job.paths.video, trimmedPath, job.sourceFrameCount / 24, config);
        await fsp.copyFile(trimmedPath, job.paths.video);
        job.trimmedToSourceFrames = job.sourceFrameCount;
        update(job, {});
        logger?.info?.(`swap-chain ${job.id} 已裁回源时长 ${(job.sourceFrameCount / 24).toFixed(3)}s（模型 ${job.frames} 帧）`);
      }
      update(job, { status: "completed", stage: "s7_delivery", progress: 100 });
      logger?.info?.(`swap-chain ${job.id} completed (${job.mode})`);
    } catch (error) {
      if (job.cancelRequested || error?.code === "cancelled") {
        job.status = "cancelled";
        job.error = "任务已取消";
        job.updatedAt = new Date().toISOString();
        save();
        return;
      }
      fail(job, error);
    }
  }

  async function cancel(id) {
    load();
    const job = jobs.get(id);
    if (!job) throw new SwapChainError("任务不存在", { status: 404, code: "job_not_found" });
    job.cancelRequested = true;
    job.status = "cancelled";
    job.error = "任务已取消";
    job.updatedAt = new Date().toISOString();
    save();
    const last = job.promptIds[job.promptIds.length - 1]?.promptId;
    if (last) await comfy.interrupt(last).catch(() => {});
    return publicJob(job);
  }

  async function resume(id) {
    load();
    const job = jobs.get(id);
    if (!job) throw new SwapChainError("任务不存在", { status: 404, code: "job_not_found" });
    if (job.status === "running") return publicJob(job);
    job.status = "queued";
    job.stage = "s3_image";
    job.error = null;
    job.progress = 15;
    update(job, {});
    queue.push(id);
    pump();
    return publicJob(job);
  }

  function get(id) {
    load();
    return publicJob(jobs.get(id));
  }

  function list() {
    load();
    return [...jobs.values()].map(publicJob).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function artifactPath(id, name) {
    load();
    const job = jobs.get(id);
    if (!job) return null;
    const map = { video: job.paths.video, painted: job.paths.painted, target: job.paths.target, contact: job.paths.contact };
    return map[name] || null;
  }

  return { load, create, get, list, cancel, resume, artifactPath };
}
