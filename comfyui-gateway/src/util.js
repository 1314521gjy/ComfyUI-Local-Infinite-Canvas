import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nowIso = () => new Date().toISOString();
export const randomId = (prefix = "") => `${prefix}${crypto.randomUUID()}`;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepClone(value) {
  return structuredClone(value);
}

export function parseSize(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, raw: `${width}x${height}` };
}

export function parseRatio(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function slugify(value, fallback = "workflow") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

export function safeFileName(value) {
  return path.basename(String(value || "file")).replace(/[^\w.-]+/g, "_");
}

export function uniqueFileName(value, suffix = crypto.randomUUID().slice(0, 8)) {
  const safe = safeFileName(value || "image.png");
  const ext = path.extname(safe) || ".png";
  const stem = path.basename(safe, ext).slice(0, 60) || "image";
  return safeFileName(`${stem}-${suffix}${ext}`);
}

export async function readTextFile(file, maxBytes) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
  if (maxBytes && stat.size > maxBytes) throw new Error(`文件过大：${stat.size} bytes`);
  return fs.readFile(file, "utf8");
}

export async function readJsonFile(file, maxBytes) {
  return JSON.parse(await readTextFile(file, maxBytes));
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  return "application/octet-stream";
}

export function extFromMime(mimeType, filename, fallback = "bin") {
  const fromName = path.extname(String(filename || "")).replace(/^\./, "").toLowerCase();
  if (fromName) return fromName;
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/mpeg") return "mp3";
  return fallback;
}

export function jsonError(message, { code, type, details } = {}) {
  return {
    error: {
      message: String(message || "Request failed"),
      type: type || "invalid_request_error",
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    },
  };
}

export function truncate(value, max = 2000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
