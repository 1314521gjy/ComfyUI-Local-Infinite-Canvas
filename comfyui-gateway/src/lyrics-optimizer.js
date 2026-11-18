import fs from "node:fs";
import path from "node:path";

import { cloudChat, PromptOptimizeError } from "./prompt-optimizer.js";

export function lyricsLineTarget(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? Math.max(4, Math.round(value / 6)) : null;
}

function buildLyricsSystemPrompt(targetLines) {
  return `You are a Mandarin lyricist. Return ONLY JSON {"lyrics": "..."}.
If the input already contains [Verse] and [Chorus], keep the section structure and improve singability, imagery and rhythm without changing the meaning.
Otherwise write new lyrics from the theme.
Use exactly [Verse] and [Chorus]; no other bracket tags.
${targetLines ? `Write about ${targetLines} lines in total (one line is roughly 6 seconds of singing).` : "Write a complete lyric with enough lines for the requested duration."}
Each line must be 8-14 Chinese characters. Put one blank line between sections. Keep the language natural and singable.`;
}

function readProvider(appRoot) {
  const file = path.join(appRoot, "assistant", "agent-provider.json");
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  const baseUrl = String(data?.baseUrl || "").trim();
  const apiKey = String(data?.apiKey || "").trim();
  const model = String(data?.model || "").trim();
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

function parseLyricsPayload(content) {
  let text = String(content || "").trim();
  if (!text) return "";
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1));
      const lyrics = String(data?.lyrics || "").trim();
      if (lyrics) return lyrics;
    } catch {
      // Fall through to the raw text so a non-JSON reply still has a chance.
    }
  }
  return text;
}

export function createLyricsOptimizer({ appRoot }) {
  async function optimize({ prompt, style, duration, signal }) {
    const idea = String(prompt || "").trim();
    if (!idea) {
      throw new PromptOptimizeError("先输入歌词或主题", { status: 400, code: "lyrics_empty_input" });
    }
    const provider = readProvider(appRoot);
    if (!provider) {
      throw new PromptOptimizeError("歌词优化未配置文本 API：请先在服务端配置 assistant/agent-provider.json（baseUrl/apiKey/model）", {
        status: 400,
        code: "lyrics_provider_missing",
      });
    }
    const seconds = Number(String(duration || "").trim());
    const targetLines = lyricsLineTarget(seconds);
    const target = targetLines ? `\n目标时长：约 ${Math.round(seconds)} 秒；请写约 ${targetLines} 行（每行 8–14 字），段间空行，结构完整。` : "";
    const userText = `主题/歌词：${idea}\n风格要求：${String(style || "").trim() || "Mandarin pop"}${target}`;
    const system = buildLyricsSystemPrompt(targetLines);
    const ask = (temperature) => cloudChat({
      system,
      userText,
      cloud: provider,
      signal,
      temperature,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
    });
    let result = await ask(0.8);
    let lyrics = parseLyricsPayload(result.content);
    if (!lyrics && !signal?.aborted) {
      result = await ask(0.5);
      lyrics = parseLyricsPayload(result.content);
    }
    if (!lyrics) {
      throw new PromptOptimizeError(`歌词优化返回为空（finish_reason=${result.finishReason || "unknown"}）`, { status: 502, code: "lyrics_empty" });
    }
    const model = result.model;
    if (!lyrics.includes("[Verse]") || !lyrics.includes("[Chorus]")) {
      throw new PromptOptimizeError("模型没有返回 [Verse]/[Chorus] 结构的歌词", {
        status: 502,
        code: "lyrics_invalid",
        details: { excerpt: lyrics.slice(0, 300) },
      });
    }
    return { lyrics, model };
  }
  return { optimize };
}
