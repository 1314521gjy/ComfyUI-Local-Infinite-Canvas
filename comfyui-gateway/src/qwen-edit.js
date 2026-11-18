export function stripImageLabelPreamble(prompt) {
  return String(prompt || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^参考图片编号：[\s\S]*?\r?\n\r?\n/, "")
    .replace(/^Reference image labels:[\s\S]*?\r?\n\r?\n/, "")
    .trim();
}

export function reorderQwenEditFiles(files) {
  return files;
}

export function reorderQwenEditPrompt(prompt) {
  return stripImageLabelPreamble(prompt);
}

export function normalizeH3ImageEditPrompt(prompt, count) {
  let text = stripImageLabelPreamble(prompt);
  text = text.replace(/@?图片\s*([1-9]|1[0-6])/g, (_match, value) => `<Picture ${value}>`);
  text = text.replace(/图(?!片)\s*([1-9]|1[0-6])/g, (_match, value) => `<Picture ${value}>`);
  text = text.replace(/第\s*([1-9]|1[0-6])\s*张/g, (_match, value) => `<Picture ${value}>`);
  const total = Math.max(0, Number(count) || 0);
  if (total > 0) {
    const labels = Array.from({ length: total }, (_, index) => `<Picture ${index + 1}>`).join(", ");
    text = `Picture references: ${labels}. <Picture 1> is the image to edit; the remaining pictures are reference images.\n\n${text}`;
  }
  return text;
}
