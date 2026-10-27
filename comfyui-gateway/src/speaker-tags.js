const TAG_RE = /<d(?:\s[^>]*)?>[\s\S]*?<\/d>/gi;
const SPEAKER_ID_RE = /\((S\d+(?:\s*[,，]\s*S\d+)*)\)/g;
const OFFSCREEN_RE = /画(?:面)?[^，。！？!?；;\n]{0,10}外|画外音|旁白|\boff-screen\b|\bvoice-?over\b/i;
const SUBJECT_RE = /(老头儿|老头|老太太|老人|男人|女人|男孩|女孩|孩子|少年|少女|旁白|\bold man\b|\bold woman\b|\bman\b|\bwoman\b|\bboy\b|\bgirl\b|\bnarrator\b)/gi;
const OFFSCREEN_NOTE_ZH = "（不在画面中，不对应任何参考图）";
const OFFSCREEN_NOTE_EN = " (off-screen voice, not in any reference picture)";

function isChineseText(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ""));
}

function descriptionBounds(prompt) {
  const match = String(prompt || "").match(/(integrated_multimodal_description|detailed_description)\s*:/i);
  if (!match) return { start: 0, end: String(prompt || "").length };
  const start = match.index + match[0].length;
  const rest = String(prompt).slice(start);
  const next = rest.match(/\n\s*(?:overall_soundscape|non_diegetic_music)\s*:/i);
  return { start, end: next ? start + next.index : String(prompt).length };
}

function normalizeSpeakerIds(text) {
  return String(text || "").replace(/（\s*(S\d+(?:\s*[,，]\s*S\d+)*)\s*）/g, (_match, ids) => `(${String(ids).replace(/\s*[,，]\s*/g, ",")})`);
}

function subjectKey(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("老头") || text.includes("old man")) return "old man";
  if (text.includes("老太太") || text.includes("old woman")) return "old woman";
  if (text.includes("男人") || text === "man") return "man";
  if (text.includes("女人") || text === "woman") return "woman";
  if (text.includes("男孩") || text === "boy") return "boy";
  if (text.includes("女孩") || text === "girl") return "girl";
  if (text.includes("旁白") || text === "narrator") return "narrator";
  return text;
}

function nextSpeakerId(used) {
  for (let index = 1; index <= 9; index += 1) {
    const id = `S${index}`;
    if (!used.has(id)) return id;
  }
  return "S1";
}

function addMissingSpeakerIds(description) {
  const issues = [];
  let fixed = 0;
  const used = new Set([...description.matchAll(SPEAKER_ID_RE)].map((match) => match[1].split(",")[0].trim()));
  const subjectIds = new Map();
  for (const match of description.matchAll(/(老头儿|老头|老太太|老人|男人|女人|男孩|女孩|孩子|少年|少女|旁白|\bold man\b|\bold woman\b|\bman\b|\bwoman\b|\bboy\b|\bgirl\b|\bnarrator\b)\s*\((S\d+)/gi)) {
    subjectIds.set(subjectKey(match[1]), match[2]);
  }
  const insertions = [];
  let lastTagEnd = 0;
  for (const tag of description.matchAll(TAG_RE)) {
    const segment = description.slice(lastTagEnd, tag.index);
    lastTagEnd = tag.index + tag[0].length;
    if (/\(S\d+/.test(segment)) continue;
    const subjects = [...segment.matchAll(SUBJECT_RE)];
    const subject = subjects.at(-1);
    if (!subject) {
      issues.push({ reason: "missing-speaker", text: tag[0].slice(0, 80) });
      continue;
    }
    const key = subjectKey(subject[1]);
    const id = subjectIds.get(key) || nextSpeakerId(used);
    if (!subjectIds.has(key)) {
      subjectIds.set(key, id);
      used.add(id);
    }
    const next = description[lastTagEnd - tag[0].length - segment.length + subject.index + subject[0].length] || "";
    const trailing = next && !/[\s，。！？!?；;、：:）)]/.test(next) ? " " : "";
    insertions.push({ at: lastTagEnd - tag[0].length - segment.length + subject.index + subject[0].length, text: ` (${id})${trailing}` });
    fixed += 1;
  }
  let output = description;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    output = output.slice(0, insertion.at) + insertion.text + output.slice(insertion.at);
  }
  return { description: output, fixed, issues };
}

function addOffScreenMarkers(description) {
  let fixed = 0;
  let hasNote = /(?:不在画面|不对应任何参考图|not in any reference picture)/i.test(description);
  let output = description.replace(
    /([^，。！？!?；;\n]{0,60}?)(\((?:S\d+)(?:\s*[,，]\s*S\d+)*\))([^，。！？!?；;\n]{0,30})/g,
    (match, before, id, after) => {
      if (!OFFSCREEN_RE.test(before)) return match;
      if (/\boff-screen\b/i.test(before) || /\boff-screen\b/i.test(after)) return match;
      const note = hasNote ? "" : (isChineseText(before + after) ? OFFSCREEN_NOTE_ZH : OFFSCREEN_NOTE_EN);
      hasNote = true;
      fixed += 1;
      return `${before}${id} off-screen${note}${after}`;
    },
  );
  if (!hasNote) {
    output = output.replace(/\boff-screen\b/i, (match) => {
      fixed += 1;
      return `${match}${isChineseText(output) ? OFFSCREEN_NOTE_ZH : OFFSCREEN_NOTE_EN}`;
    });
  }
  return { description: output, fixed };
}

export function ensureSpeakerTags(output) {
  const prompt = String(output || "");
  const bounds = descriptionBounds(prompt);
  let description = normalizeSpeakerIds(prompt.slice(bounds.start, bounds.end));
  const missing = addMissingSpeakerIds(description);
  description = missing.description;
  const offscreen = addOffScreenMarkers(description);
  description = offscreen.description;
  return {
    prompt: `${prompt.slice(0, bounds.start)}${description}${prompt.slice(bounds.end)}`,
    fixed: missing.fixed + offscreen.fixed,
    issues: missing.issues,
  };
}
