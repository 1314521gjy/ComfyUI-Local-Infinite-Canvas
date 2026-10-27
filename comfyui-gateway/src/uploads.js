import { uniqueFileName } from "./util.js";

export async function uploadImages(comfy, files) {
  const uploaded = [];
  for (const [index, file] of files.entries()) {
    const filename = uniqueFileName(file.originalname || `input-${index + 1}.png`);
    const result = await comfy.uploadImage(file.buffer, filename, file.mimetype || "image/png");
    uploaded.push({ ...result, originalName: filename, bytes: file.buffer.length });
  }
  return uploaded;
}
