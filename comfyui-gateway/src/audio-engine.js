import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

import { safeFileName } from "./util.js";

const AUDIO_TIMEOUT_MS = 600 * 1000;

function audioError(message, status, code, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // 进程可能已退出。
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 同上。
  }
}

function runProcess({ command, args, cwd, signal, timeoutMs = AUDIO_TIMEOUT_MS, onLog, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child = null;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      killTree(child);
      finish(reject, audioError("音频任务已取消", 400, "cancelled"));
    };
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
    } catch (error) {
      finish(reject, audioError(`${label}启动失败：${error.message}`, 503, "audio_engine_missing"));
      return;
    }
    let stdout = "";
    let stderr = "";
    timer = setTimeout(() => {
      killTree(child);
      finish(reject, audioError(`${label}超时（${Math.round(timeoutMs / 1000)}s）`, 504, "audio_timeout"));
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      onLog?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onLog?.(text);
    });
    child.on("error", (error) => finish(reject, audioError(`${label}启动失败：${error.message}`, 503, "audio_engine_missing")));
    child.on("exit", (code) => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      const detail = (stderr || stdout).trim().slice(-1500);
      if (/SoulX/i.test(label) && (/AssertionError/.test(detail) || /sample rate/i.test(detail) || /采样率/.test(detail))) {
        finish(reject, audioError(
          "SoulX 输入采样率不一致：已自动重采样，请重试；若仍失败请把目标音频/音色参考统一为 24k/44.1k/48k WAV。可复制给 AI Agent：SoulX 报采样率断言，请统一 source_vocal/instrumental/reference 采样率后重试。",
          422,
          "audio_sample_rate_mismatch",
          { exitCode: code },
        ));
        return;
      }
      finish(reject, audioError(`${label}失败（exit ${code}）${detail ? `：${detail}` : ""}`, 502, "audio_engine_failed", { exitCode: code }));
    });
  });
}

function audioTools(appRoot) {
  return path.join(appRoot, "tools");
}

function missingYs(paths) {
  return paths.filter((item) => !fs.existsSync(item));
}

function yue2Paths(appRoot) {
  const tools = audioTools(appRoot);
  return {
    tools,
    python: path.join(tools, "yue2-tools", ".venv-yue2", "Scripts", "python.exe"),
    script: path.join(tools, "song-quality", "run_song.py"),
    config: path.join(tools, "song-quality", "song_engine.json"),
    official: path.join(tools, "yue2-tools", "YuE-official"),
    model: path.join(tools, "yue2-tools", "YuE-official", "models", "YuE2-3B"),
    vae: path.join(tools, "yue2-tools", "YuE-official", "models", "YuE2-Vae"),
  };
}

function soulxPaths(appRoot) {
  const tools = audioTools(appRoot);
  return {
    tools,
    python: path.join(tools, "svc-tools", ".venv", "Scripts", "python.exe"),
    script: path.join(tools, "svc-pipeline", "run_voice_replace.py"),
    model: path.join(tools, "svc-tools", "soulx_ckpt", "model-svc.pt"),
    rmvpe: path.join(tools, "svc-tools", "soulx_ckpt", "rmvpe", "rmvpe.pt"),
    source: path.join(tools, "svc-tools", "SoulX-Singer-main"),
    gender: path.join(tools, "svc-gender", "run_gender_svc.py"),
    autotune: path.join(tools, "svc-user", "autotune_world.py"),
  };
}

export function audioDependencyProblems(appRoot, kind) {
  const paths = kind === "song" ? yue2Paths(appRoot) : soulxPaths(appRoot);
  const required = kind === "song"
    ? [paths.python, paths.script, paths.config, paths.official, paths.model, paths.vae]
    : [paths.python, paths.script, paths.model, paths.rmvpe, paths.source, paths.gender, paths.autotune];
  const missing = missingYs(required);
  if (!missing.length) return [];
  const label = kind === "song" ? "YuE2 写歌" : "SoulX+WORLD 换声";
  return missing.map((item) => `${label}缺少 ${item}`);
}

function dependencyHint(kind) {
  if (kind === "song") {
    return "请安装 YuE2 运行环境：tools/yue2-tools/.venv-yue2、YuE-official 权重（YuE2-3B / YuE2-Vae）与 tools/song-quality/run_song.py；本机已有权重，不需要重新下载。";
  }
  return "请安装 SoulX 运行环境：tools/svc-tools/.venv、SoulX-Singer-main、soulx_ckpt/model-svc.pt 与 rmvpe.pt，以及 tools/svc-gender、tools/svc-user 脚本；本机已有权重，不需要重新下载。";
}

function assertDeps(appRoot, kind) {
  const problems = audioDependencyProblems(appRoot, kind);
  if (!problems.length) return;
  throw audioError(`${problems.join("；")}。${dependencyHint(kind)}`, 503, "audio_engine_missing", { missing: problems, kind });
}

async function writeUpload(tempDir, name, file) {
  if (!file?.buffer?.length) return "";
  const ext = path.extname(String(file.originalname || "")) || (/\bwav\b/i.test(file.mimetype || "") ? ".wav" : ".mp3");
  const target = path.join(tempDir, `${safeFileName(name).replace(/[^a-zA-Z0-9_-]/g, "") || "audio"}-${Date.now()}${ext}`);
  await fsp.writeFile(target, file.buffer);
  return target;
}

export function countLyricLines(lyrics) {
  return String(lyrics || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]+\]$/.test(line)).length;
}

export function autoSongDuration(lyrics, { maxSeconds = 300, minSeconds = 10, secondsPerLine = 6, fallbackSeconds = 120 } = {}) {
  const lines = countLyricLines(lyrics);
  if (!lines) return fallbackSeconds;
  return Math.max(minSeconds, Math.min(maxSeconds, Math.round(lines * secondsPerLine)));
}

export function buildSongStyle({ tags = "", gender = "", bpm, language = "", keyscale = "", instrumental = false } = {}) {
  const rawStyle = String(tags || "").trim();
  const vocalTag = /(?:^|[^a-z])(vocal|vocals|voice|singer|singing|choir|chorus|rap|rapper)(?:[^a-z]|$)/i;
  const styleText = instrumental
    ? rawStyle.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag && !vocalTag.test(tag)).join(", ")
    : rawStyle;
  const parts = [];
  if (instrumental) parts.push("Instrumental, no vocals, no singing, no choir, no spoken words");
  parts.push(styleText);
  if (!instrumental && gender) parts.push(`${gender} vocal`);
  const bpmValue = Number(bpm);
  if (Number.isFinite(bpmValue) && bpmValue > 0) parts.push(`${Math.trunc(bpmValue)} BPM`);
  if (!instrumental) {
    const languageLabel = { zh: "Chinese", en: "English", ja: "Japanese" }[String(language || "").trim().toLowerCase()] || String(language || "").trim();
    if (languageLabel) parts.push(languageLabel);
  }
  if (String(keyscale || "").trim()) parts.push(`key ${String(keyscale).trim()}`);
  if (!instrumental) parts.push("clear diction");
  return parts.filter(Boolean).join(", ");
}

export function lyricsDurationIssue(lyrics, duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const actual = countLyricLines(lyrics);
  const expected = Math.max(4, Math.round(seconds / 6));
  const min = Math.max(3, Math.round(expected * 0.6));
  const max = Math.max(min + 1, Math.round(expected * 1.5));
  if (actual >= min && actual <= max) return null;
  return {
    actual,
    expected,
    min,
    max,
    seconds: Math.round(seconds),
    message: `歌词行数与目标时长不匹配：当前 ${actual} 行，目标 ${Math.round(seconds)} 秒建议约 ${expected} 行（可接受 ${min}–${max} 行，每行 8–14 字）。请先让 AI 优化歌词或调整目标时长。`,
  };
}

export async function runYue2Song({ appRoot, style, lyrics, duration, seed, cot = "full", signal, onLog }) {
  const durationIssue = lyricsDurationIssue(lyrics, duration);
  if (durationIssue) throw audioError(durationIssue.message, 400, "invalid_lyrics_duration", durationIssue);
  assertDeps(appRoot, "song");
  const paths = yue2Paths(appRoot);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "canvas-yue2-"));
  try {
    const requestPath = path.join(tempDir, "request.json");
    const outputDir = path.join(tempDir, "out");
    await fsp.writeFile(requestPath, JSON.stringify({
      id: `canvas_${Date.now().toString(36)}`,
      style: String(style || "").trim(),
      lyrics: String(lyrics || "").trim(),
      cot: String(cot || "full"),
      seed: Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : Math.floor(Math.random() * 2 ** 31),
    }, null, 2), "utf8");
    await runProcess({
      command: paths.python,
      args: [paths.script, "--request", requestPath, "--output", outputDir],
      cwd: paths.tools,
      signal,
      onLog,
      label: "YuE2 写歌",
    });
    const song = path.join(outputDir, "yue2_song.flac");
    const buffer = await fsp.readFile(song).catch(() => null);
    if (!buffer?.length) throw audioError("YuE2 没有产出音频文件；请检查运行日志", 502, "audio_output_missing");
    return { buffer, mimeType: "audio/flac", meta: { engine: "yue2", file: song } };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runSoulXVoice({ appRoot, sourceSong, sourceVocal, instrumental, reference, strength = 1, seed = 1234, label = "voice", signal, onLog }) {
  assertDeps(appRoot, "voice");
  const paths = soulxPaths(appRoot);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "canvas-soulx-"));
  try {
    const songPath = await writeUpload(tempDir, "source-song", sourceSong);
    const vocalPath = await writeUpload(tempDir, "source-vocal", sourceVocal);
    const instPath = await writeUpload(tempDir, "instrumental", instrumental);
    const refPath = await writeUpload(tempDir, "reference", reference);
    if (!refPath) throw audioError("换声需要参考音色音频", 400, "missing_reference_audio");
    if (!songPath && !vocalPath) throw audioError("换声需要源歌曲或源干声", 400, "missing_source_audio");
    if (vocalPath && !instPath) throw audioError("提供源干声时必须同时提供伴奏", 400, "missing_instrumental");
    const outDir = path.join(tempDir, "out");
    const args = [paths.script];
    if (songPath) args.push("--source-song", songPath);
    else args.push("--source-vocal", vocalPath, "--instrumental", instPath);
    args.push("--reference", refPath, "--out-dir", outDir, "--label", String(label || "voice"), "--strength", String(Math.min(1, Math.max(0, Number(strength) || 1))), "--seed", String(Math.trunc(Number(seed) || 1234)));
    await runProcess({
      command: paths.python,
      args,
      cwd: paths.tools,
      signal,
      onLog,
      label: "SoulX+WORLD 换声",
    });
    const output = path.join(outDir, `${String(label || "voice")}_song.wav`);
    const buffer = await fsp.readFile(output).catch(() => null);
    if (!buffer?.length) throw audioError("SoulX 没有产出音频文件；请检查运行日志", 502, "audio_output_missing");
    return { buffer, mimeType: "audio/wav", meta: { engine: "soulx", file: output } };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const AUDIO_REQUIRED_VRAM_MB = { song: 10240, voice: 8192 };
