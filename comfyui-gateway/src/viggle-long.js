import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { runWorkflow, GenerationError } from "./runner.js";
import { uploadImages } from "./uploads.js";
import { alignViggleFramesUp, deepClone } from "./util.js";

const execFileAsync = promisify(execFile);
const PREFIX_FRAMES = 17;

// 长片编排直接克隆 workflow；必须按 context.mode 取 variant，
// 否则 Viggle edit 会错误地跑 swap 图。
// 取出变体后要清掉 variants：分段注入的 RemakePrefix 节点会再次进入 runWorkflow，
// 不能被二次变体解析覆盖；变体自带的底模也不能被主模型覆盖改掉。
function resolveForMode(entry, mode) {
  const variant = mode ? entry?.variants?.[mode] : null;
  if (!variant) return entry;
  const rest = { ...entry };
  delete rest.variants;
  return {
    ...rest,
    ...variant,
    workflow: variant.workflow || entry.workflow,
    bindings: variant.bindings || entry.bindings,
    defaults: variant.defaults || entry.defaults,
    mainModelFile: "",
  };
}

export function planViggleSegments(totalFrames, segmentFrames) {
  const total = Math.max(0, Math.round(Number(totalFrames) || 0));
  const limit = alignViggleFramesUp(segmentFrames) || 277;
  if (!total) return [];
  if (total <= limit) return [{ start: 0, frames: alignViggleFramesUp(total) || Math.min(total, limit), trim: 0 }];
  const segments = [];
  let start = 0;
  while (start < total) {
    const remaining = total - start;
    // 取下一档 17n+5，尾段不足 90 帧也补足；生成后由源音轨 -shortest 裁回原时长。
    const frames = Math.min(limit, Math.max(90, alignViggleFramesUp(remaining)));
    segments.push({ start, frames, trim: segments.length ? PREFIX_FRAMES : 0 });
    if (start + frames >= total) break;
    start += frames - PREFIX_FRAMES;
  }
  return segments;
}

export async function padSourceForSegment(sourceFile, sourceTotalFrames, targetFrames, config, dir) {
  const binary = ffmpegBinary(config);
  const input = path.join(dir, "source-pad-input.mp4");
  const output = path.join(dir, "source-pad.mp4");
  await fsp.writeFile(input, sourceFile.buffer);
  const padSeconds = Math.max(0, (targetFrames - sourceTotalFrames) / 24);
  await runFfmpeg(binary, ["-y", "-i", input, "-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(6)}`, "-r", "24", "-frames:v", String(targetFrames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", output], "尾段源视频补帧");
  return fsp.readFile(output);
}

function findFfmpeg(config = {}) {  const candidates = [
    process.env.FFMPEG_PATH,
    "ffmpeg",
    config.comfyDir && path.join(config.comfyDir, "ffmpeg.exe"),
    config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", "ffmpeg.exe"),
    config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg.exe"),
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

function ffmpegBinary(config) {
  const found = findFfmpeg(config);
  if (!found) throw new GenerationError("长视频切段需要 ffmpeg，但网关未找到 ffmpeg", { status: 500, code: "ffmpeg_missing" });
  return found;
}

function findFfprobe(config = {}) {
  const candidates = [
    process.env.FFPROBE_PATH,
    "ffprobe",
    config.comfyDir && path.join(config.comfyDir, "ffprobe.exe"),
    config.comfyDir && path.join(config.comfyDir, "..", "ffprobe.exe"),
    config.comfyDir && path.join(config.comfyDir, "..", "ffmpeg", "bin", "ffprobe.exe"),
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

// #308 自动选帧：一次 ffmpeg 抽 K 个候选帧（select 按帧号，输出按升序）。
export async function extractVideoFrames(file, { frames = [], config = {} } = {}) {
  if (!file?.buffer?.length) throw new GenerationError("缺少源视频", { status: 400, code: "missing_source_video" });
  const indices = [...new Set(frames.map((value) => Math.round(Number(value))).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
  if (!indices.length) throw new GenerationError("没有可抽取的候选帧", { status: 422, code: "no_candidate_frames" });
  const binary = findFfmpeg(config);
  if (!binary) throw new GenerationError("网关未找到 ffmpeg，无法抽取候选帧；请手动抽帧、编辑后上传", { status: 422, code: "frame_extract_failed" });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-frames-"));
  try {
    const input = path.join(tempDir, "source.mp4");
    await fsp.writeFile(input, file.buffer);
    const expression = indices.map((index) => `eq(n\\,${index})`).join("+");
    try {
      await execFileAsync(binary, ["-y", "-i", input, "-vf", `select='${expression}'`, "-vsync", "0", path.join(tempDir, "cand-%03d.png")], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
      const detail = String(cause?.stderr || cause?.message || cause).slice(0, 300);
      throw new GenerationError(`源视频候选帧抽取失败：${detail}；请手动抽帧、编辑后上传`, { status: 422, code: "frame_extract_failed" });
    }
    const names = (await fsp.readdir(tempDir)).filter((name) => /^cand-\d+\.png$/.test(name)).sort();
    if (!names.length) throw new GenerationError("源视频没有抽出候选帧；请手动抽帧、编辑后上传", { status: 422, code: "no_candidate_frames" });
    const out = [];
    for (let i = 0; i < names.length; i += 1) {
      const buffer = await fsp.readFile(path.join(tempDir, names[i]));
      if (!buffer.length) continue;
      out.push({ frame: indices[Math.min(i, indices.length - 1)], buffer, mimeType: "image/png", filename: `viggle-candidate-${indices[Math.min(i, indices.length - 1)]}.png` });
    }
    if (!out.length) throw new GenerationError("候选帧为空；请手动抽帧、编辑后上传", { status: 422, code: "no_candidate_frames" });
    return out;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseMeta(text, key) {
  const match = String(text || "").match(new RegExp(`lavfi\\.${key}=([-\\d.]+)`));
  return match ? Number(match[1]) : null;
}

// 现成引擎清单里只有 caption/反推（Qwen3.5-9B VL、Florence2），没有“编辑主体可见度”打分器；
// 这里用 ffmpeg 的 blurdetect（拉普拉斯近似）+ 中心区域 signalstats 做确定性启发式，不新增模型。
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

async function grayGrid(binary, filePath) {
  const { stdout } = await execFileAsync(binary, ["-v", "error", "-i", filePath, "-vf", "scale=32:32,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: null });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

// 参考图相似度：候选帧与角色参考图都缩到 32×32 灰度网格，按 Pearson 相关衡量构图/姿态接近度。
// 只用 ffmpeg + 像素统计，不引入新模型；有多张参考图时取平均。
export async function scoreVideoFrames(candidates, { config = {}, references = [] } = {}) {
  const binary = findFfmpeg(config);
  if (!binary) throw new GenerationError("网关未找到 ffmpeg，无法进行选帧打分；请手动抽帧、编辑后上传", { status: 422, code: "frame_score_unavailable" });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-score-"));
  try {
    const refGrids = [];
    const usableRefs = (references || []).filter((item) => item?.buffer?.length);
    for (let i = 0; i < usableRefs.length; i += 1) {
      const refPath = path.join(tempDir, `ref-${i}.png`);
      await fsp.writeFile(refPath, usableRefs[i].buffer);
      try {
        refGrids.push(await grayGrid(binary, refPath));
      } catch {
        // 单张参考图无法读取时跳过，仍可用其余参考/启发式打分。
      }
    }
    const results = [];
    for (const candidate of candidates) {
      const framePath = path.join(tempDir, `frame-${candidate.frame}.png`);
      const thumbPath = path.join(tempDir, `thumb-${candidate.frame}.jpg`);
      await fsp.writeFile(framePath, candidate.buffer);
      let blur = null;
      let yavg = null;
      let ystd = null;
      let centerStd = null;
      let similarity = null;
      try {
        const blurOut = await execFileAsync(binary, ["-hide_banner", "-i", framePath, "-vf", "blurdetect,metadata=print:file=-", "-f", "null", "-"], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        blur = parseMeta(`${blurOut.stdout}\n${blurOut.stderr}`, "blur");
        const statOut = await execFileAsync(binary, ["-hide_banner", "-i", framePath, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        const statText = `${statOut.stdout}\n${statOut.stderr}`;
        yavg = parseMeta(statText, "signalstats.YAVG");
        ystd = parseMeta(statText, "signalstats.YSTD");
        const centerOut = await execFileAsync(binary, ["-hide_banner", "-i", framePath, "-vf", "crop=iw/2:ih/2,signalstats,metadata=print:file=-", "-f", "null", "-"], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        centerStd = parseMeta(`${centerOut.stdout}\n${centerOut.stderr}`, "signalstats.YSTD");
        if (refGrids.length) {
          const grid = await grayGrid(binary, framePath);
          const each = refGrids.map((refGrid) => Math.max(0, Math.min(1, (pearson(grid, refGrid) + 1) / 2)));
          similarity = each.reduce((sum, value) => sum + value, 0) / each.length;
        }
      } catch {
        // 单帧统计失败按 0 分处理，全部失败时上层回落 422。
      }
      const black = yavg !== null && yavg < 24 && (ystd === null || ystd < 8);
      const sharp = blur === null ? 0 : Math.max(0, 1 - Math.min(1, blur / 10));
      const center = centerStd === null ? 0 : Math.min(1, Math.max(0, centerStd / 64));
      const score = black
        ? 0
        : similarity !== null
          ? Math.round((similarity * 0.75 + sharp * 0.15 + center * 0.1) * 1000) / 10
          : Math.round((sharp * 0.6 + center * 0.4) * 1000) / 10;
      let thumbBuffer = null;
      try {
        await execFileAsync(binary, ["-y", "-i", framePath, "-vf", "scale=320:-2", "-q:v", "4", thumbPath], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        thumbBuffer = await fsp.readFile(thumbPath);
      } catch {
        thumbBuffer = null;
      }
      results.push({ frame: candidate.frame, score, similarity, blur, yavg, ystd, centerStd, black, thumbBuffer });
    }
    return results;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// #308 自动链：从源视频精确抽一帧（select 滤镜按帧号，避免 -ss 关键帧偏移）。
export async function extractVideoFrame(file, { frame = 0, config = {} } = {}) {
  if (!file?.buffer?.length) throw new GenerationError("缺少源视频", { status: 400, code: "missing_source_video" });
  const index = Math.max(0, Math.round(Number(frame) || 0));
  const binary = findFfmpeg(config);
  if (!binary) throw new GenerationError("网关未找到 ffmpeg，无法从源视频抽帧；请手动抽帧、编辑后上传", { status: 422, code: "frame_extract_failed" });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-frame-"));
  try {
    const input = path.join(tempDir, "source.mp4");
    const output = path.join(tempDir, `frame-${index}.png`);
    await fsp.writeFile(input, file.buffer);
    try {
      await execFileAsync(binary, ["-y", "-i", input, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", "-vsync", "0", output], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
      const detail = String(cause?.stderr || cause?.message || cause).slice(0, 300);
      throw new GenerationError(`源视频抽帧失败：${detail}；请手动抽帧、编辑后上传`, { status: 422, code: "frame_extract_failed" });
    }
    const buffer = await fsp.readFile(output).catch(() => null);
    if (!buffer?.length) throw new GenerationError("源视频抽帧没有产出图片；请手动抽帧、编辑后上传", { status: 422, code: "frame_extract_failed" });
    return { buffer, mimeType: "image/png", filename: `viggle-frame-${index}.png`, frame: index };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Viggle Remake 的源画布只接受「短边 480 且两边都是 32 倍数」的原始尺寸；
// 其他尺寸会被节点整体拉伸到 832×480（正方形/竖屏人像会被压扁）。这里先按原比例缩到
// 短边 480、长边取 32 的倍数，让节点走 as-is 分支，避免压缩。
export async function fitViggleSourceCanvas(file, config = {}) {
  if (!file?.buffer?.length) return file;
  const binary = findFfmpeg(config);
  const probe = findFfprobe(config);
  if (!binary || !probe) return file;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-fit-"));
  try {
    const input = path.join(tempDir, "source.mp4");
    await fsp.writeFile(input, file.buffer);
    const raw = execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", input], { encoding: "utf8", timeout: 20000 }).trim().split("\n")[0] || "";
    const [width, height] = raw.split(",").map((value) => Number(value));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return file;
    const shortEdge = 480;
    const long = Math.max(32, Math.round((Math.max(width, height) * shortEdge / Math.min(width, height)) / 32) * 32);
    const targetWidth = width >= height ? long : shortEdge;
    const targetHeight = width >= height ? shortEdge : long;
    if (width === targetWidth && height === targetHeight) return file;
    const output = path.join(tempDir, "source-fit.mp4");
    await execFileAsync(binary, [
      "-y", "-i", input,
      "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos,setsar=1`,
      "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", output,
    ], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const buffer = await fsp.readFile(output);
    if (!buffer.length) return file;
    const base = String(file.originalname || "source").replace(/\.[^.]+$/, "");
    return { ...file, buffer, originalname: `${base}-480p.mp4`, mimetype: "video/mp4" };
  } catch {
    return file;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}


// 无音轨时混入一条静音轨（视频流直拷），模型按 native 音频模式重建静音。
export async function ensureSourceAudio(file, config = {}) {
  if (!file?.buffer?.length) return file;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-audio-"));
  try {
    const input = path.join(tempDir, "source.mp4");
    await fsp.writeFile(input, file.buffer);
    const probe = findFfprobe(config);
    if (!probe) return file;
    let hasAudio = null;
    try {
      const raw = execFileSync(probe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input], { encoding: "utf8", timeout: 20000 });
      hasAudio = raw.trim().length > 0;
    } catch {
      hasAudio = null;
    }
    if (hasAudio !== false) return file;
    const binary = findFfmpeg(config);
    if (!binary) throw new GenerationError("源视频没有音轨，但网关未找到 ffmpeg，无法补静音轨", { status: 500, code: "ffmpeg_missing" });
    const output = path.join(tempDir, "source-silent.mp4");
    const head = ["-y", "-i", input, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-movflags", "+faststart", output];
    try {
      await execFileAsync(binary, [...head.slice(0, -1), "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", output], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    } catch {
      await execFileAsync(binary, [...head.slice(0, -1), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", output], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    }
    const buffer = await fsp.readFile(output);
    const originalname = `${String(file.originalname || "source").replace(/\.[^.]+$/, "")}.mp4`;
    return { ...file, buffer, originalname, mimetype: "video/mp4" };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 参考图带 alpha 时，透明像素在模型里会变成黑底。Viggle 的参考图应当先压到源片
// 背景色上，既消除黑底，又保留源片的浅灰/深色背景氛围。
function sampleSourceBackground(binary, videoPath) {
  const points = [["0", "0"], ["iw-16", "0"], ["0", "ih-16"], ["iw-16", "ih-16"]];
  const samples = [];
  for (const [x, y] of points) {
    try {
      const raw = execFileSync(binary, ["-v", "error", "-i", videoPath, "-frames:v", "1", "-vf", `crop=16:16:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 30000, maxBuffer: 1024 * 1024 });
      if (raw.length >= 3) samples.push([raw[0], raw[1], raw[2]]);
    } catch {
      // try next corner
    }
  }
  if (!samples.length) return "E5E5E5";
  const median = (index) => samples.map((item) => item[index]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return [median(0), median(1), median(2)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function flattenViggleReferences(files, sourceFile, config = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.some((file) => /^image\//i.test(file?.mimetype || ""))) return list;
  const binary = findFfmpeg(config);
  const probe = findFfprobe(config);
  if (!binary || !probe) return list;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-ref-"));
  try {
    let background = "E5E5E5";
    if (sourceFile?.buffer?.length) {
      const sourcePath = path.join(tempDir, "source.mp4");
      await fsp.writeFile(sourcePath, sourceFile.buffer);
      background = sampleSourceBackground(binary, sourcePath);
    }
    const out = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      if (!/^image\//i.test(file?.mimetype || "") || !file.buffer?.length) {
        out.push(file);
        continue;
      }
      const input = path.join(tempDir, `ref-${index}.img`);
      await fsp.writeFile(input, file.buffer);
      let width = 0;
      let height = 0;
      let pixFmt = "";
      try {
        const raw = execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "csv=p=0", input], { encoding: "utf8", timeout: 20000 });
        const parts = raw.trim().split(",");
        width = Number(parts[0]);
        height = Number(parts[1]);
        pixFmt = parts[2] || "";
      } catch {
        out.push(file);
        continue;
      }
      // 无 alpha 的参考图保持原样，避免无谓转码。
      if (!width || !height || !/a/i.test(pixFmt)) {
        out.push(file);
        continue;
      }
      const flattened = path.join(tempDir, `ref-${index}-flat.png`);
      try {
        execFileSync(binary, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${background}:s=${width}x${height}`, "-i", input, "-filter_complex", "[0][1]overlay=format=auto", "-frames:v", "1", flattened], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        out.push({
          ...file,
          buffer: await fsp.readFile(flattened),
          originalname: `${String(file.originalname || "ref").replace(/\.[^.]+$/, "")}.png`,
          mimetype: "image/png",
        });
      } catch {
        out.push(file);
      }
    }
    return out;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function mapPins(raw, segment) {
  const pins = String(raw || "").split(/[,\s]+/).filter(Boolean).map(Number);
  if (!pins.length) return "";
  if (!pins.every((pin) => Number.isInteger(pin) && pin >= segment.start && pin < segment.start + segment.frames)) return "";
  return pins.map((pin) => pin - segment.start).join(", ");
}

async function runFfmpeg(binary, args, label) {
  try {
    await execFileAsync(binary, args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new GenerationError(`${label}失败：${error?.message || error}`, { status: 500, code: "ffmpeg_failed" });
  }
}

export async function runViggleLongVideo({
  entry,
  context,
  comfy,
  sourceFile,
  segmentFrames,
  config = {},
  timeoutMs,
  pollIntervalMs,
  signal,
  requestId,
  logger,
  onProgress,
  modelAliasFor = null,
  loaderSpecs,
  loraCatalog,
}) {
  const total = Number(context.sourceTotalFrames) || Number(context.sourceVideoFrames) || 0;
  const plan = planViggleSegments(total, segmentFrames);
  if (plan.length < 2) {
    throw new GenerationError("长视频切段计划不足 2 段", { status: 400, code: "segmentation_too_short" });
  }
  const resolvedEntry = resolveForMode(entry, context.mode);
  const sourceUpload = context.uploadedVideos?.[0];
  if (!sourceUpload) throw new GenerationError("长视频切段缺少已上传的源视频", { status: 400, code: "missing_source_video" });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "viggle-long-"));
  const binary = ffmpegBinary(config);
  const segmentFiles = [];
  let previous = null;
  let lastPromptId = null;
  let completed = 0;
  try {
    for (let index = 0; index < plan.length; index += 1) {
      const segment = plan[index];
      const workflow = deepClone(resolvedEntry.workflow);
      if (index > 0 && previous) {
        const uploaded = (await uploadImages(comfy, [{ buffer: previous.buffer, originalname: `viggle-prefix-${index}.mp4`, mimetype: previous.mimeType || "video/mp4" }]))[0];
        workflow["9300"] = {
          class_type: "VHS_LoadVideo",
          inputs: { video: uploaded.name, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" },
          _meta: { title: `Viggle prefix ${index}` },
        };
        workflow["9400"] = {
          class_type: "RemakePrefix",
          inputs: { vae: ["3", 0], latent: ["6", 1], prefix: ["9300", 0], prefix_frames: PREFIX_FRAMES, prefix_at: -1 },
          _meta: { title: `RemakePrefix ${index}` },
        };
        workflow["11"].inputs.latent_image = ["9400", 0];
      }
      const segmentEntry = { ...resolvedEntry, workflow };
      const params = { ...(context.params || {}) };
      const pins = mapPins(params.pins, segment);
      if (pins) params.pins = pins;
      else delete params.pins;
      let segmentSourceUpload = sourceUpload;
      if (index === plan.length - 1 && segment.start + segment.frames > total) {
        const padded = await padSourceForSegment(sourceFile, total, segment.start + segment.frames, config, tempDir);
        segmentSourceUpload = (await uploadImages(comfy, [{ buffer: padded, originalname: `viggle-source-padded-${index}.mp4`, mimetype: "video/mp4" }]))[0];
      }
      const segmentContext = {
        ...context,
        sourceVideoFrames: segment.frames,
        sourceSkipFrames: segment.start,
        uploadedVideos: [segmentSourceUpload],
        params,
      };
      const result = await runWorkflow({
        entry: segmentEntry,
        context: segmentContext,
        comfy,
        timeoutMs,
        pollIntervalMs,
        signal,
        requestId: `${requestId || "viggle"}-seg${index + 1}`,
        logger,
        loraCatalog,
        modelAliasFor,
        loaderSpecs,
        onProgress: (event) => onProgress?.({ ...event, segment: index + 1, segments: plan.length }),
      });
      const video = result.files.find((file) => /^video\//i.test(file.mimeType) || /\.(mp4|webm|mov)$/i.test(file.filename));
      if (!video) throw new GenerationError(`第 ${index + 1} 段没有返回视频`, { status: 502, code: "no_video_output" });
      previous = video;
      lastPromptId = result.promptId;
      const segmentPath = path.join(tempDir, `seg-${index + 1}.mp4`);
      await fsp.writeFile(segmentPath, video.buffer);
      segmentFiles.push({ path: segmentPath, trim: segment.trim, index });
      completed += 1;
      onProgress?.({ phase: "segment_done", progress: 0.05 + 0.85 * (completed / plan.length), segment: completed, segments: plan.length, promptId: result.promptId });
    }

    const normalized = [];
    for (const segment of segmentFiles) {
      const target = path.join(tempDir, `norm-${segment.index + 1}.mp4`);
      const args = ["-y", "-i", segment.path];
      if (segment.trim) args.push("-vf", `trim=start_frame=${segment.trim},setpts=PTS-STARTPTS`);
      args.push("-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", target);
      await runFfmpeg(binary, args, `第 ${segment.index + 1} 段裁剪`);
      normalized.push(target);
    }
    const listPath = path.join(tempDir, "concat.txt");
    await fsp.writeFile(listPath, normalized.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const sourcePath = path.join(tempDir, "source.mp4");
    await fsp.writeFile(sourcePath, sourceFile.buffer);
    const outputPath = path.join(tempDir, "viggle-long.mp4");
    await runFfmpeg(binary, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", sourcePath,
      "-map", "0:v:0", "-map", "1:a:0?",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", outputPath,
    ], "长视频拼接/音轨合并");
    const buffer = await fsp.readFile(outputPath);
    return {
      promptId: lastPromptId,
      files: [{ buffer, mimeType: "video/mp4", filename: "viggle-long.mp4" }],
      segments: plan.length,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
