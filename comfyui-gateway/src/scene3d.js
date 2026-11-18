import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCENE3D_PANO_ID = "image-scene3d-pano";
export const SCENE3D_SEAM_ID = "image-scene3d-seam";
export const SCENE3D_PUBLIC_ID = "image-scene-3d";

const EQUIRECT_PREFIX =
  "Equirectangular 360-degree panorama, full spherical projection: 360 degrees horizontal by 180 degrees vertical field of view. " +
  "The image must be a flat equirectangular latitude-longitude map, NOT a normal wide-angle photograph, NOT a fisheye lens, and NOT a single-perspective vanishing-point image. " +
  "Horizon line exactly at vertical center; top edge is the zenith and bottom edge is the nadir. " +
  "Left and right edges represent the same longitude and must wrap seamlessly. " +
  "All straight architectural lines must curve naturally toward the poles as in a true equirectangular panorama. " +
  "Camera fixed at the center of the scene at eye level, surrounded by the environment in every direction, including behind the camera.";

const SUBJECT_RULE =
  "Use <Picture 1> as the reference: preserve the subject's identity and appearance; the subject appears exactly once in the front sector at natural scale and must not be duplicated or stretched around the sphere.";

const EQUIRECT_SUFFIX =
  "Consistent lighting and shadows across the whole sphere and across the seam; no border, no frame, no text, ultra-detailed cinematic quality.";

const DEFAULT_SCENE = "the environment shown in <Picture 1>, extended into a complete surrounding scene";

const CONTINUITY_RULE =
  "The scene continues in every direction around the full circle, including behind the camera; do not collapse the scene into one central vanishing point.";

export function buildScene3dPrompt(scene) {
  const text = (String(scene || "").trim() || DEFAULT_SCENE).replace(/[.。]\s*$/, "");
  const continuity = /continues in every direction/i.test(text) ? "" : ` ${CONTINUITY_RULE}`;
  return `${EQUIRECT_PREFIX} ${SUBJECT_RULE} Scene: ${text}.${continuity} ${EQUIRECT_SUFFIX}`;
}

export function resolveScene3dPython(config = {}) {
  const candidates = [];
  if (process.env.SCENE3D_PYTHON) candidates.push(process.env.SCENE3D_PYTHON);
  const comfyDir = String(config.comfyDir || "").trim();
  if (comfyDir) {
    candidates.push(path.join(comfyDir, "python_embeded", "python.exe"));
    candidates.push(path.join(comfyDir, "python_embedded", "python.exe"));
    candidates.push(path.join(path.dirname(comfyDir), "python_embeded", "python.exe"));
  }
  candidates.push("python");
  for (const candidate of candidates) {
    if (candidate === "python") return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function scene3dScriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "scene3d_pano.py");
}

async function runHelper(python, script, args, { signal } = {}) {
  if (!python) {
    throw new Error("找不到可用于 scene3d 图像处理的 Python（需要 Pillow/numpy/cv2）。请设置 SCENE3D_PYTHON，或用本机 ComfyUI 的 python_embeded。");
  }
  const { stdout } = await execFileAsync(python, [script, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    signal,
  });
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      /* keep scanning */
    }
  }
  throw new Error(`scene3d 图像脚本没有返回 JSON：${String(stdout || "").slice(0, 500)}`);
}

export async function placeSource({ python, script, inputBuffer, offsetX = 0.5, offsetY = 0.5, signal }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "scene3d-"));
  const inputPath = path.join(dir, "input.bin");
  const outPath = path.join(dir, "placed.png");
  try {
    await fs.promises.writeFile(inputPath, inputBuffer);
    const info = await runHelper(python, script, [
      "place",
      "--input",
      inputPath,
      "--out",
      outPath,
      "--offset-x",
      String(offsetX),
      "--offset-y",
      String(offsetY),
    ], { signal });
    return { buffer: await fs.promises.readFile(outPath), info };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareSeamAssets({ python, script, panoBuffer, inputBuffer, signal }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "scene3d-"));
  const panoPath = path.join(dir, "pano.png");
  const inputPath = path.join(dir, "input.bin");
  const stripPath = path.join(dir, "strip.png");
  const maskPath = path.join(dir, "mask.png");
  try {
    await fs.promises.writeFile(panoPath, panoBuffer);
    let inputArg = [];
    if (inputBuffer) {
      await fs.promises.writeFile(inputPath, inputBuffer);
      inputArg = ["--input", inputPath];
    }
    const info = await runHelper(python, script, [
      "prepare",
      "--pano",
      panoPath,
      "--strip-out",
      stripPath,
      "--mask-out",
      maskPath,
      ...inputArg,
    ], { signal });
    return {
      stripBuffer: await fs.promises.readFile(stripPath),
      maskBuffer: await fs.promises.readFile(maskPath),
      info,
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function stitchPanorama({ python, script, panoBuffer, repairedBuffer, maskBuffer, inputBuffer, signal }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "scene3d-"));
  const panoPath = path.join(dir, "pano.png");
  const stripPath = path.join(dir, "strip.png");
  const maskPath = path.join(dir, "mask.png");
  const inputPath = path.join(dir, "input.bin");
  const outPath = path.join(dir, "final.png");
  const metricsPath = path.join(dir, "metrics.json");
  try {
    await fs.promises.writeFile(panoPath, panoBuffer);
    await fs.promises.writeFile(stripPath, repairedBuffer);
    await fs.promises.writeFile(maskPath, maskBuffer);
    let inputArg = [];
    if (inputBuffer) {
      await fs.promises.writeFile(inputPath, inputBuffer);
      inputArg = ["--input", inputPath];
    }
    const metrics = await runHelper(python, script, [
      "stitch",
      "--pano",
      panoPath,
      "--strip",
      stripPath,
      "--mask",
      maskPath,
      "--out",
      outPath,
      "--metrics",
      metricsPath,
      ...inputArg,
    ], { signal });
    return { buffer: await fs.promises.readFile(outPath), metrics };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function evaluateScene3dMetrics(metrics = {}) {
  const reasons = [];
  if (!metrics.dimensions_ok) reasons.push("输出尺寸不是 5664×2832");
  if (Number(metrics.edge_mae) > 4) reasons.push(`左右边缘 MAE ${metrics.edge_mae} > 4`);
  if (Number(metrics.luma_delta) > 2) reasons.push(`左右亮度差 ${metrics.luma_delta} > 2`);
  const inputFaces = Number.isFinite(Number(metrics.input_faces)) ? Number(metrics.input_faces) : null;
  const outputFaces = Number.isFinite(Number(metrics.output_faces)) ? Number(metrics.output_faces) : null;
  const limit = inputFaces && inputFaces > 0 ? Math.max(1, inputFaces) : 1;
  let person = "unknown";
  if (outputFaces !== null) {
    person = outputFaces <= limit ? "pass" : "fail";
    if (outputFaces > limit) reasons.push(`人物/人脸检测 ${outputFaces} 处 > 门槛 ${limit}`);
  }
  return { passed: reasons.length === 0, reasons, person };
}
