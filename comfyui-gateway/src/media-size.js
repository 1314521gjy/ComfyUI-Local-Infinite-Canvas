import path from "node:path";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifSize(buffer) {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 4) !== "GIF8") return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function bmpSize(buffer) {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") return null;
  const width = Math.abs(buffer.readInt32LE(18));
  const height = Math.abs(buffer.readInt32LE(22));
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 9 <= buffer.length) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

function mp4Size(buffer) {
  if (buffer.length < 16) return null;
  const brand = buffer.toString("ascii", 4, 8);
  if (!["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(brand)) return null;
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const index = buffer.indexOf("tkhd", offset, "ascii");
    if (index < 0) break;
    const boxStart = index - 4;
    if (boxStart >= 0) {
      const size = buffer.readUInt32BE(boxStart);
      if (size >= 8 && boxStart + size <= buffer.length) {
        const version = buffer[boxStart + 8];
        const widthOffset = version === 1 ? boxStart + 96 : boxStart + 84;
        const heightOffset = version === 1 ? boxStart + 100 : boxStart + 88;
        if (heightOffset + 4 <= boxStart + size) {
          const width = buffer.readUInt32BE(widthOffset) >>> 16;
          const height = buffer.readUInt32BE(heightOffset) >>> 16;
          if (width > 0 && height > 0 && width < 100000 && height < 100000) return { width, height };
        }
      }
    }
    offset = index + 4;
  }
  return null;
}

export function mediaPixelSize(buffer, mimeType = "", filename = "") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const mime = String(mimeType || "").toLowerCase();
  const name = String(filename || "");
  const isVideo = mime.startsWith("video/") || VIDEO_EXT.test(name);
  if (isVideo) return mp4Size(buffer);
  if (mime.startsWith("image/") || IMAGE_EXT.test(name) || !path.extname(name)) {
    return pngSize(buffer) || jpegSize(buffer) || webpSize(buffer) || gifSize(buffer) || bmpSize(buffer);
  }
  return null;
}
