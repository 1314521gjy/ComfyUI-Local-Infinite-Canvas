const CN_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function stripImageLabelPreamble(prompt) {
  return String(prompt || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^参考图片编号：[\s\S]*?\r?\n\r?\n/, "")
    .replace(/^Reference image labels:[\s\S]*?\r?\n\r?\n/, "")
    .trim();
}

export function reorderQwenEditFiles(files) {
  return Array.isArray(files) && files.length > 1 ? [...files.slice(1), files[0]] : files;
}

export function reorderQwenEditPrompt(prompt, count) {
  const total = Math.max(0, Number(count) || 0);
  if (total < 2) return stripImageLabelPreamble(prompt);
  let text = stripImageLabelPreamble(prompt);
  const target = total;
  const mapped = (index) => (index === 1 ? target : index >= 2 && index <= total ? index - 1 : index);
  text = text.replace(/原图|底图|目标图/g, "__TARGET_IMAGE__");
  text = text.replace(/图片\s*([1-9]|10)/g, (_match, value) => `图片${mapped(Number(value))}`);
  text = text.replace(/图(?!片)\s*([1-9]|10)/g, (_match, value) => `图片${mapped(Number(value))}`);
  text = text.replace(/图片([一二三四五六七八九十])/g, (_match, value) => `图片${mapped(CN_NUMERALS.indexOf(value) + 1)}`);
  text = text.replace(/图([一二三四五六七八九十])/g, (_match, value) => `图片${mapped(CN_NUMERALS.indexOf(value) + 1)}`);
  text = text.replace(/第\s*([1-9]|10)\s*张/g, (_match, value) => `图片${mapped(Number(value))}`);
  text = text.replace(/第\s*([一二三四五六七八九十])\s*张/g, (_match, value) => `图片${mapped(CN_NUMERALS.indexOf(value) + 1)}`);
  text = text.replace(/__TARGET_IMAGE__/g, `图片${target}`);
  const labels = Array.from({ length: total }, (_, index) => `图片${index + 1}`).join("、");
  return `图片顺序：${labels}；其中图片${target}是目标图/原图，只编辑图片${target}，其他图片仅作为元素参考。\n\n${text}`;
}
