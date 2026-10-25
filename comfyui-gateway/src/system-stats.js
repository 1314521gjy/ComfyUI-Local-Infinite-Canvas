import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GPU_FIELDS = "index,name,memory.used,memory.total,utilization.gpu,temperature.gpu";

let cached = null;
let cachedAt = 0;
let pending = null;

function readRam() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

async function readGpu() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits"], {
      timeout: 3000,
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
    return { gpu, gpuError: null };
  } catch (error) {
    return { gpu: [], gpuError: error?.message || String(error) };
  }
}

export async function readSystemStats({ cacheMs = 1500 } = {}) {
  const now = Date.now();
  if (cached && now - cachedAt < cacheMs) return cached;
  if (pending) return pending;
  pending = (async () => {
    const [gpuInfo, ram] = await Promise.all([readGpu(), Promise.resolve(readRam())]);
    cached = { at: new Date().toISOString(), ...gpuInfo, ram };
    cachedAt = Date.now();
    pending = null;
    return cached;
  })();
  try {
    return await pending;
  } catch (error) {
    pending = null;
    throw error;
  }
}
