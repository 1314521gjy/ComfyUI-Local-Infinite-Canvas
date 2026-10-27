const QUOTE_PATTERNS = [
  /“([^”]{1,300})”/g,
  /「([^」]{1,300})」/g,
  /『([^』]{1,300})』/g,
  /"([^"\n]{1,300})"/g,
];

const SPEECH_CONTEXT_RE = /(?:说道?|问道?|喊道?|叫道?|吼道?|回答(?:道)?|低语|嘟囔|念道?|旁白|画外音|声音|台词|对白|唱(?:道)?)\s*[:：]?\s*$/;
const SPEECH_AFTER_RE = /^\s*[,，]?\s*(?:说道?|问道?|喊道?|叫道?|吼道?|回答|嘟囔|低语)/;
const VISIBLE_TEXT_RE = /(?:写着|写有|印着|招牌|标语|字幕|横幅|屏幕|海报|牌匾|告示|书名|标题|文字)/;

const UNQUOTED_SPEECH_RE = /(?:说道?|问道?|喊道?|叫道?|吼道?|回答(?:道)?|嘟囔|低语|念道?|旁白|画外音|声音|台词|对白|唱(?:道)?)\s*[:：]\s*([^。！？!?\n“”"「」『』]{1,160}[。！？!?]?)/g;

const SPEAKER_WORDS = ["老头", "老太太", "老人", "男人", "女人", "男孩", "女孩", "孩子", "少年", "少女", "旁白"];

function cleanSpoken(value) {
  return String(value || "")
    .replace(/[\u201c\u201d\u2018\u2019「」『』"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:：,，\s]+|[:：,，\s]+$/g, "");
}

function sourceOrdered(lines, source) {
  return lines
    .map((line) => ({ line, index: source.indexOf(line) }))
    .sort((a, b) => (a.index < 0 ? Number.MAX_SAFE_INTEGER : a.index) - (b.index < 0 ? Number.MAX_SAFE_INTEGER : b.index))
    .map((item) => item.line);
}

export function extractDialogueLines(prompt) {
  const source = String(prompt || "");
  const lines = [];
  const seen = new Set();
  const add = (value) => {
    const line = cleanSpoken(value);
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };

  for (const pattern of QUOTE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const before = source.slice(Math.max(0, index - 40), index);
      const beforeClause = before.split(/[。！？!?；;\n]/).pop();
      const after = source.slice(index + match[0].length, index + match[0].length + 16);
      if (VISIBLE_TEXT_RE.test(beforeClause)) continue;
      if (!SPEECH_CONTEXT_RE.test(before) && !SPEECH_AFTER_RE.test(after)) continue;
      add(match[1]);
    }
  }

  UNQUOTED_SPEECH_RE.lastIndex = 0;
  for (const match of source.matchAll(UNQUOTED_SPEECH_RE)) add(match[1]);
  return sourceOrdered(lines, source);
}

export function normalizeSpeakerIds(prompt) {
  return String(prompt || "").replace(
    /（\s*(S\d+(?:\s*[,，]\s*S\d+)*)\s*）/g,
    (_match, ids) => `(${String(ids).replace(/\s*[,，]\s*/g, ",")})`,
  );
}

function spokenTagTexts(prompt) {
  return [...String(prompt || "").matchAll(/<d(?:\s[^>]*)?>([\s\S]*?)<\/d>/gi)].map((match) =>
    cleanSpoken(String(match[1]).replace(/^\s*\[[^\]]{1,24}\]\s*/, "")),
  );
}

function descriptionText(prompt) {
  const text = String(prompt || "");
  const match = text.match(/(?:integrated_multimodal_description|detailed_description)\s*:([\s\S]*?)(?=\n\s*(?:overall_soundscape|non_diegetic_music)\s*:|$)/i);
  return match ? match[1] : text;
}

function stripDialogueFromSoundSections(prompt) {
  return String(prompt || "").replace(
    /\b(overall_soundscape|non_diegetic_music)\s*:([\s\S]*?)(?=(?:\n\s*(?:overall_soundscape|non_diegetic_music)\s*:)|$)/gi,
    (_match, header, body) =>
      `${header}:${body
        .replace(/\s*\(S\d+(?:\s*,\s*S\d+)*\)\s*<d(?:\s[^>]*)?>[\s\S]*?<\/d>/gi, "")
        .replace(/\s*<d(?:\s[^>]*)?>[\s\S]*?<\/d>/gi, "")}`,
  );
}

function speakerKey(before) {
  const segments = String(before || "")
    .split(/[，。！？!?；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const normalized = segments[index]
      .replace(/[\u201c\u201d\u2018\u2019「」『』":：]/g, "")
      .replace(/画面外|画外|同一个|一个|那个|这个|的|声音|台词|对白|旁白|说道?|问道?|喊道?|叫道?|吼道?|回答(?:道)?|低语|嘟囔|念道?|唱(?:道)?|质问|语气|轻蔑|低声|沙哑|苍老|年轻/g, "")
      .trim();
    if (!normalized) continue;
    for (const word of SPEAKER_WORDS) {
      if (normalized.includes(word)) return word;
    }
    return normalized.slice(-6);
  }
  return "";
}

function inferSpeakers(source, lines) {
  const order = [];
  const assignments = [];
  for (const line of lines) {
    const index = source.indexOf(line);
    const before = index >= 0 ? source.slice(Math.max(0, index - 60), index) : "";
    const key = speakerKey(before) || "说话人";
    if (!order.includes(key)) order.push(key);
    assignments.push(order.indexOf(key) + 1);
  }
  return assignments.map((number) => `S${number}`);
}

function lineLanguage(line, fallback) {
  return /[\u4e00-\u9fa5]/.test(line) ? "Chinese" : fallback;
}

function insertDialogue(prompt, lines, source, language) {
  const ordered = sourceOrdered(lines, source);
  const speakers = inferSpeakers(source, ordered);
  const block = ordered
    .map((line, index) => `(${speakers[index]}) <d>[${lineLanguage(line, language)}]${line}</d>`)
    .join("\n");
  const header = /detailed_description\s*:/i.test(prompt)
    ? "detailed_description"
    : /integrated_multimodal_description\s*:/i.test(prompt)
      ? "integrated_multimodal_description"
      : "";
  if (!header) return prompt.trim() ? `${prompt.trim()}\n\n${block}` : block;
  const match = prompt.match(new RegExp(`${header}\\s*:`, "i"));
  const bodyStart = match.index + match[0].length;
  const rest = prompt.slice(bodyStart);
  const next = rest.match(/\n\s*(?:overall_soundscape|non_diegetic_music)\s*:/i);
  const bodyEnd = next ? bodyStart + next.index : prompt.length;
  const before = prompt.slice(0, bodyEnd).replace(/\s+$/, "");
  const after = prompt.slice(bodyEnd).replace(/^\s+/, "");
  return after ? `${before}\n${block}\n\n${after}` : `${before}\n${block}`;
}

export function ensureDialoguePreserved(output, source, { language = "Chinese" } = {}) {
  const prompt = normalizeSpeakerIds(output);
  const dialogues = extractDialogueLines(source);
  if (!dialogues.length) return { prompt, dialogues, missing: [], inserted: [] };
  const cleaned = stripDialogueFromSoundSections(prompt);
  const tagTexts = spokenTagTexts(descriptionText(cleaned));
  const missing = dialogues.filter((line) => !tagTexts.some((tag) => tag.includes(line)));
  if (!missing.length) return { prompt: cleaned, dialogues, missing: [], inserted: [] };
  return { prompt: insertDialogue(cleaned, missing, String(source || ""), language), dialogues, missing, inserted: missing };
}
