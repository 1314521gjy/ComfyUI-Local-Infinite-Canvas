import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GPU_FIELDS = "index,name,memory.used,memory.total,utilization.gpu,temperature.gpu";
const GPU_TIMEOUT_MS = 8000;

let cached = null;
let cachedAt = 0;
let pending = null;
let lastGoodGpu = null;

function readRam() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

function nvidiaSmiCandidates() {
  const candidates = ["nvidia-smi"];
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  candidates.push(path.join(systemRoot, "System32", "nvidia-smi.exe"));
  return candidates;
}

async function readGpu() {
  let lastError = "";
  for (const bin of nvidiaSmiCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, [`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits"], {
        timeout: GPU_TIMEOUT_MS,
        windowsHide: true,
      });
      const gpu = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, fallbackIndex) => {
          const [index, name, used, total, utilization, temperature] = line.split(",").map((part) => part.trim());
          return {
            index: Number(index) || fallbackIndex,
            name: name || "GPU",
            memoryUsedMb: Number(used) || 0,
            memoryTotalMb: Number(total) || 0,
            utilization: Number(utilization) || 0,
            temperature: Number(temperature) || 0,
          };
        });
      if (!gpu.length) {
        lastError = "nvidia-smi 没有返回显卡信息";
        continue;
      }
      return { gpu, gpuError: null };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  return { gpu: [], gpuError: lastError || "无法读取显存信息" };
}

// 显卡满载时 nvidia-smi 很容易超时；返回空列表会让界面变成「显存 --」。
// 有上次读数就沿用，并标记 gpuStale，让界面能区分“读取失败”和“真的没显卡”。
export function mergeGpuSnapshot(previous, next) {
  if (Array.isArray(next?.gpu) && next.gpu.length) {
    return { gpu: next.gpu, gpuError: null, gpuStale: false };
  }
  if (Array.isArray(previous) && previous.length) {
    return { gpu: previous, gpuError: next?.gpuError || "读取显存超时", gpuStale: true };
  }
  return { gpu: [], gpuError: next?.gpuError || "无法读取显存信息", gpuStale: false };
}

export async function readSystemStats({ cacheMs = 1500 } = {}) {
  const now = Date.now();
  if (cached && now - cachedAt < cacheMs) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const [gpuInfo, ram] = await Promise.all([readGpu(), Promise.resolve(readRam())]);
      const merged = mergeGpuSnapshot(lastGoodGpu, gpuInfo);
      if (!merged.gpuStale && merged.gpu.length) lastGoodGpu = merged.gpu;
      cached = { at: new Date().toISOString(), ...merged, ram };
      cachedAt = Date.now();
      return cached;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
