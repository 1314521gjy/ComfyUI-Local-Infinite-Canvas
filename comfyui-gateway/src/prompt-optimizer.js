import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyModelAliases } from "./runner.js";
import { ensureSpeakerTags } from "./speaker-tags.js";
import { deepClone, sleep, truncate } from "./util.js";

const MODES = new Set([
  "全参考模式(Reference to Video)",
  "文生视频(T2VA)",
  "首帧图生视频(I2VA)",
  "首尾帧视频(FL2VA)",
  "尾帧图生视频(L2VA)",
]);

export class PromptOptimizeError extends Error {
  constructor(message, { status = 500, code = "prompt_optimize_failed", details } = {}) {
    super(message);
    this.name = "PromptOptimizeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function historyCompleted(history) {
  if (!history) return false;
  if (history.status?.completed === true) return true;
  if (history.status?.status_str === "success") return true;
  return Boolean(history.outputs && Object.keys(history.outputs).length);
}

function historyError(history) {
  if (history?.status?.status_str !== "error") return "";
  const messages = Array.isArray(history.status.messages) ? history.status.messages.flat() : [];
  return messages
    .map((item) => (typeof item === "string" ? item : item?.message || JSON.stringify(item)))
    .filter(Boolean)
    .join("；") || "ComfyUI 执行失败";
}

function imageValue(uploaded) {
  if (!uploaded) return "";
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function outputText(history) {
  const outputs = history?.outputs || {};
  const direct = outputs["4"]?.text?.[0] || outputs["4"]?.input_text?.[0];
  if (typeof direct === "string" && direct.trim()) return direct;
  for (const output of Object.values(outputs)) {
    for (const key of ["text", "input_text"]) {
      const value = output?.[key]?.[0];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "";
}

const THINK_BLOCK_RE = /<(think|thinking|analysis|reasoning|scratchpad)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
const META_LINE_RE = /^(?:[-*#>\s]*)?(?:\*\*)?(?:思考过程|思考|分析|推理|说明|解释|备注|注意|Thinking|Analysis|Reasoning|Explanation|Notes?)(?:\*\*)?\s*[:：]/i;

function stripReasoning(text) {
  let out = String(text || "");
  out = out.replace(THINK_BLOCK_RE, "");
  out = out.replace(/<\|[^|]{1,60}\|>/g, "");
  out = out.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  const kept = [];
  for (const line of out.split(/\r?\n/)) {
    if (META_LINE_RE.test(line.trim())) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function sanitizeH3Prompt(text) {
  let out = stripReasoning(text);
  const reference = out.search(/subject_definitions\s*:/i);
  const main = out.search(/integrated_multimodal_description\s*:/i);
  if (reference >= 0 && (main < 0 || reference < main)) out = out.slice(reference);
  else if (main > 0) out = out.slice(main);
  else if (main < 0) {
    const alt = out.search(/overall_soundscape\s*:|non_diegetic_music\s*:/i);
    if (alt > 0) out = out.slice(alt);
  }
  out = out.replace(/\n{2,}(?:思考过程|分析|推理|解释|备注|说明)\s*[:：][\s\S]*$/i, "");
  out = out.replace(/^(最终提示词|输出结果|输出|结果|Prompt)\s*[:：]\s*/i, "");
  return out.trim();
}

function lastShotIndex(text) {
  const matches = [...String(text || "").matchAll(/\[Shot\s+(\d+)\]/gi)].map((match) => Number(match[1]));
  return matches.length ? Math.max(...matches) : 1;
}

function ensureFrameAlignmentPrompt(text, mode, duration) {
  const body = String(text || "").trim();
  if (!body) return body;
  if (!/首帧图生视频|首尾帧视频|尾帧图生视频|I2VA|FL2VA|L2VA/i.test(String(mode || ""))) return body;
  const content = body.replace(/^(?:For the target video, at 0\.00 seconds[^\n]*|How the reference pictures align[^\n]*)\s*\n+/i, "").trim();
  const seconds = Number(duration) > 0 ? Number(duration) : 5;
  const time = seconds.toFixed(2);
  const last = lastShotIndex(content);
  if (/首帧图生视频|I2VA/i.test(mode)) {
    return `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${content}`;
  }
  if (/首尾帧视频|FL2VA/i.test(mode)) {
    return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${last}) aligns with the ${time}-second mark of the target video.\n\n${content}`;
  }
  return `How the reference pictures align with the target video — <Picture 1> (from [Shot ${last}]) aligns with the ${time}-second mark of the target video.\n\n${content}`;
}

function sanitizeImagePrompt(text) {
  let out = stripReasoning(text);
  for (const marker of ["最终提示词：", "最终提示词:", "提示词：", "提示词:", "**Prompt:**", "Prompt:", "输出：", "输出:"]) {
    const index = out.lastIndexOf(marker);
    if (index >= 0) out = out.slice(index + marker.length).trim();
  }
  const paragraphs = out.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const metaStart = /^(?:思考|分析|推理|我们|首先|用户|需求|要求|说明|注|最终|The user|We need|Let me|I need|Analysis|Reasoning|Explanation|Here'?s|Okay|Sure)/i;
  while (paragraphs.length > 1 && metaStart.test(paragraphs[0])) paragraphs.shift();
  out = paragraphs.join("\n\n").trim();
  out = out.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  out = out.replace(/^["“「']+|["”」']+$/g, "").trim();
  return out;
}

function sanitizeCaption(text) {
  let out = stripReasoning(text);
  out = out.replace(/^(?:画面描述|图片描述|描述|Caption)\s*[:：]\s*/i, "");
  const paragraphs = out.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const metaStart = /^(?:思考|分析|推理|我们|首先|用户|需求|要求|说明|注|The user|We need|Let me|I need|Analysis|Reasoning|Explanation|Here'?s|Okay|Sure)/i;
  while (paragraphs.length > 1 && metaStart.test(paragraphs[0])) paragraphs.shift();
  return paragraphs.join("\n\n").trim();
}

function cloudChatUrl(baseUrl) {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw new PromptOptimizeError("云端 API 未配置 Base URL", { status: 400, code: "cloud_not_configured" });
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

const H3_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "skills", "h3-prompt-writing");
let h3SkillFiles = null;

function loadH3SkillFiles() {
  if (h3SkillFiles !== null) return h3SkillFiles;
  try {
    h3SkillFiles = {
      skill: fs.readFileSync(path.join(H3_SKILL_DIR, "SKILL.md"), "utf8").trim(),
      base: fs.readFileSync(path.join(H3_SKILL_DIR, "references", "base-en.txt"), "utf8").trim(),
      reference: fs.readFileSync(path.join(H3_SKILL_DIR, "references", "ref-en.txt"), "utf8").trim(),
    };
  } catch (error) {
    h3SkillFiles = { error };
  }
  return h3SkillFiles;
}

function normalizePromptLanguage(value) {
  return String(value || "").toLowerCase() === "en" ? "en" : "zh";
}

function h3LanguageDirective(language) {
  if (normalizePromptLanguage(language) === "en") {
    return "Write every field body in English. Keep dialogue, lyrics, and on-screen visible text in their original language; Chinese dialogue stays Chinese inside <d>[Chinese]...</d>. Official field names stay English.";
  }
  return "字段正文全部使用中文（覆盖 skill 默认英文）；台词、旁白、歌词保留原文语言（中文仍为中文）；官方字段名保留英文。";
}

function buildCloudH3System(mode, duration, language) {
  const files = loadH3SkillFiles();
  if (files.error) {
    throw new PromptOptimizeError("H3 提示词 Skill 文件缺失，请检查 comfyui-gateway/prompts/skills/h3-prompt-writing", {
      status: 500,
      code: "missing_h3_skill",
    });
  }
  const reference = /全参考|Ref2VA|Reference to Video/i.test(mode);
  const guide = reference ? `${files.base}\n\n${files.reference}` : files.base;
  return `${files.skill}\n\n${guide}\n\n## 本次任务
模式：${mode}
时长：${duration} 秒
输出语言：${h3LanguageDirective(language)}
参考图片（若有）已随消息附上：以图片内容为准，不要编造图中不存在的室内外、家具、陈设或光线。
对齐句由系统在正文前补充，正文不要另写。
只输出最终 H3 提示词正文，不要输出思考过程、分析、解释、Markdown 代码块或前后缀。`;
}

const CLOUD_IMAGE_SYSTEM_PROMPT = `你是 AI 生图提示词专家。请把用户输入改写为一条可直接使用的生图/图生图提示词，只输出最终提示词本身，不要输出任何思考过程、分析、解释、Markdown 代码块、标题或前后缀。

要求：主体明确，构图、镜头、光线、材质与风格具体；保留用户的主体和意图，不要编造品牌或画面文字；图生图时说明需要保留与需要改变的部分；输出语言与“输出语言”字段一致。`;

// [h3-local-fix] 本地 9B 专用精简 H3 规则：完整 skill 约 20K 字会让 9B 本地推理
// 跑 127~309s 并触发 KV 碎片整理，超过前端 240s 超时。这里只保留三段式骨架与
// 本地兼容规则，实测 42~60s。云端分支仍用完整 skill（buildCloudH3System），互不影响。
const LOCAL_H3_SYSTEM_PROMPT = `你是 MiniMax H3 视频提示词改写器。把用户需求改写成可直接用于视频生成的提示词，只输出提示词正文，禁止输出思考过程、分析、解释、Markdown 代码块或前后缀。

输出结构（严格按以下顺序，英文官方字段名，字段正文用中文，台词/旁白/歌词与画面文字保留原语言）：
integrated_multimodal_description: 用 [Shot 1]...[Shot N] 分镜描述画面主体、服装、环境、光线、镜头运动、动作声音，每段 2-4 句。
overall_soundscape: 1-4 句描述环境音、动作音、非语言人声。
non_diegetic_music: 1-3 句描述背景音乐（乐器、速度、节奏、情绪）。

本地兼容规则（VDN / cfg=1）：
1. 描述性文字用正向事实表述，不要 no/not/without/avoid；否定词在 cfg=1 下会作为普通 token 反向生效（如 no blood 改为干净完好的皮肤）。不要改台词、旁白、歌词和画面文字。
2. 有参考图时用 <Picture 1>、<Picture 2> 标注身份/服装/场景来源，标签须与实际输入一致；纯文本 T2VA 不得伪造 Picture 标签。
3. 用户要单段或不切镜时写 one continuous locked-off shot from a tripod；要切镜就按意图分镜。
4. 少堆 cinematic/photorealistic/8k/masterpiece 泛化词，优先具体光位、色温、镜头、材质、运动。`;

function cloudContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

function assertCloudBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new PromptOptimizeError("云端 Base URL 无效", { status: 400, code: "cloud_invalid_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PromptOptimizeError("云端 Base URL 只支持 http/https", { status: 400, code: "cloud_invalid_url" });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isPrivate =
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host) ||
    host.endsWith(".local");
  if (isPrivate && String(process.env.ALLOW_PRIVATE_CLOUD || "") !== "1") {
    throw new PromptOptimizeError("云端 Base URL 指向本机或内网地址，已拒绝；如确需本地模型，请设置 ALLOW_PRIVATE_CLOUD=1", { status: 400, code: "cloud_private_url" });
  }
  return url.toString();
}

async function cloudChat({ system, userText, images = [], cloud = {}, signal, temperature = 0.6, maxTokens = 4096 }) {
  const baseUrl = String(cloud.baseUrl || "").trim();
  const apiKey = String(cloud.apiKey || "").trim();
  const model = String(cloud.model || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new PromptOptimizeError("云端 API 未配置：请先在设置中填写 Base URL、API Key 和模型", { status: 400, code: "cloud_not_configured" });
  }
  assertCloudBaseUrl(baseUrl);
  const endpoint = cloudChatUrl(baseUrl);
  const userContent = images.length
    ? [{ type: "text", text: userText }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("云端 API 超时")), 120000);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const started = Date.now();
  const post = async (requestTemperature) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        temperature: requestTemperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { response, text, data };
  };
  try {
    let { response, text, data } = await post(temperature);
    if (!response.ok && temperature !== 1) {
      const message = data?.error?.message || data?.message || text || "";
      // Kimi 等思考模型只接受 temperature=1；按报错重试一次，不维护模型名白名单。
      if (/invalid temperature|only\s+1\s+is\s+allowed|temperature.*not\s+supported/i.test(String(message))) {
        ({ response, text, data } = await post(1));
      }
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      const imageHint = images.length && [400, 415, 422].includes(response.status)
        ? "（若当前模型不支持图片输入，请换支持视觉的模型或改用本地优化）"
        : "";
      throw new PromptOptimizeError(`云端 API 失败：${truncate(String(message), 800)}${imageHint}`, { status: 502, code: "cloud_api_failed", details: data });
    }
    return { content: cloudContent(data), model, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof PromptOptimizeError) throw error;
    if (error?.name === "AbortError") {
      throw new PromptOptimizeError("云端 API 请求已取消或超时", { status: 504, code: "cloud_api_timeout" });
    }
    throw new PromptOptimizeError(`云端 API 请求失败：${error?.message || error}`, { status: 502, code: "cloud_api_failed" });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function cloudOptimize({ prompt, mode, duration, referenceNote, language, uploadedImages = [], cloudImages = [], imageCount = 0, cloud = {}, signal }) {
  const outputLanguage = normalizePromptLanguage(language);
  const imageTotal = cloudImages.length || uploadedImages.length || Number(imageCount) || 0;
  const imageLine = imageTotal
    ? cloudImages.length
      ? `参考图片：${imageTotal} 张（已随消息附上，以图片为准；不要编造图中不存在的场景、陈设、家具或光线）`
      : `参考图片：${imageTotal} 张（云端未附图片，仅使用文字说明；不要编造未看到的场景细节）`
    : "";
  const frameGuide = /I2VA/i.test(mode)
    ? "首帧图生视频：从 <Picture 1> 的 0.00 秒首帧开始向后发展，不要换成别的底图。"
    : /FL2VA/i.test(mode)
      ? "首尾帧视频：从 Picture 1 连续过渡到 Picture 2，优先单镜头，最后一镜落到尾帧。"
      : /L2VA/i.test(mode)
        ? "尾帧图生视频：从合理的前置状态收敛到结尾的 <Picture 1>。"
        : "";
  const userText = [
    `任务类型：${mode}`,
    `视频时长：${duration} 秒`,
    `输出语言：${outputLanguage === "en" ? "英文（正文英文，台词保留原文语言）" : "中文"}`,
    frameGuide ? `画面路径：${frameGuide}` : "",
    referenceNote ? `参考素材说明：${referenceNote}` : "",
    imageLine,
    `用户原始提示词：\n${prompt}`,
  ].filter(Boolean).join("\n");
  const system = buildCloudH3System(mode, duration, outputLanguage);
  const { content, model, elapsedMs } = await cloudChat({ system, userText, images: cloudImages, cloud, signal });
  const sanitized = sanitizeH3Prompt(content);
  if (!sanitized) throw new PromptOptimizeError("云端 API 没有返回提示词", { status: 502, code: "no_prompt_output" });
  const speaker = ensureSpeakerTags(sanitized);
  return {
    prompt: speaker.prompt,
    mode,
    duration,
    provider: "cloud",
    model,
    elapsedMs,
    speakerTags: { fixed: speaker.fixed, issues: speaker.issues },
  };
}

async function cloudOptimizeImage({ prompt, mode, language, imageCount = 0, cloud = {}, signal }) {
  const userText = [
    `任务模式：${mode}`,
    `输出语言：${String(language || "zh").toLowerCase() === "en" ? "英文" : "中文"}`,
    imageCount ? `参考图片：${imageCount} 张（云端模式仅使用文字说明）` : "",
    `用户原始提示词：\n${prompt}`,
  ].filter(Boolean).join("\n");
  const { content, model, elapsedMs } = await cloudChat({ system: CLOUD_IMAGE_SYSTEM_PROMPT, userText, cloud, signal });
  const result = sanitizeImagePrompt(content);
  if (!result) throw new PromptOptimizeError("云端 API 没有返回提示词", { status: 502, code: "no_prompt_output" });
  return { prompt: result, mode, provider: "cloud", model, elapsedMs };
}

export function createPromptOptimizer({ config, comfy, logger, modelAliasFor = null, loaderSpecs = undefined }) {
  // 反推/优化提交的是打包模板，模型名写死在模板里；必须和出图路径一样套别名。
  // loaderSpecs 允许传 getter：网关启动扫描可能还没完成，不能拿旧快照。
  function withAliases(workflow) {
    const specs = typeof loaderSpecs === "function" ? loaderSpecs() : loaderSpecs;
    const aliased = applyModelAliases(workflow, modelAliasFor, specs);
    if (aliased !== workflow) logger?.info?.("提示词优化/反推模板已应用模型别名");
    return aliased;
  }
  // [h3-local-fix] 提交一个「文本输出」类 ComfyUI 工作流并轮询取回文本。
  async function runTextWorkflow(workflow, { signal, timeoutMs = 180000, label = "text workflow" } = {}) {
    const started = Date.now();
    const submitted = await comfy.submit(withAliases(workflow), { signal });
    const promptId = submitted.promptId;
    let running = true;
    let cancelPromise = null;
    const cancel = () => {
      if (!running) return Promise.resolve();
      if (!cancelPromise) cancelPromise = typeof comfy.cancel === "function" ? comfy.cancel(promptId) : comfy.interrupt(promptId);
      return cancelPromise;
    };
    if (signal) signal.addEventListener("abort", () => void cancel(), { once: true });
    try {
      let history = null;
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) {
          await cancel();
          throw new PromptOptimizeError(`${label}已取消`, { status: 400, code: "cancelled" });
        }
        history = await comfy.history(promptId);
        const failure = historyError(history);
        if (failure) {
          running = false;
          throw new PromptOptimizeError(`${label}失败：${truncate(failure, 1200)}`, {
            status: 502, code: "comfy_execution_failed", details: failure,
          });
        }
        if (historyCompleted(history)) break;
        await sleep(1000);
      }
      running = false;
      if (!historyCompleted(history)) {
        throw new PromptOptimizeError(`${label}超时`, { status: 504, code: "prompt_optimize_timeout" });
      }
      const raw = outputText(history).trim();
      if (!raw) {
        throw new PromptOptimizeError(`${label}没有返回文本`, { status: 502, code: "no_prompt_output", details: history.outputs });
      }
      return { raw, promptId, elapsedMs: Date.now() - started };
    } finally {
      running = false;
    }
  }

  // [h3-local-fix] 把 N 张上传图接成 instruct 节点 images 输入要的单条 [node_id, slot] link。
  // llama_cpp_instruct_adv.images 是单个 IMAGE 输入（不是列表）：多图先经 ImageBatch 链
  // 合成一个 IMAGE 再接，写成列表的列表会被 ComfyUI 校验拒绝（Bad linked input）。
  // [h3-local-fix] 节点包的 images 模式只在多图时才做 max_size 缩放，单图原图直塞
  // mmproj 会编码出海量 vision tokens 直接超时；所有图先经 ImageResizeKJv2 保比例
  // 压到 768 长边再进 LLM（同一张 3MB 大图实测：不缩放 235~309s，缩放后 ~52s）。
  function linkImageInputs(workflow, uploads) {
    const ids = [];
    uploads.forEach((uploaded, index) => {
      const nid = String(9101 + index);
      workflow[nid] = { class_type: "LoadImage", inputs: { image: imageValue(uploaded) } };
      const rid = String(9300 + index);
      workflow[rid] = {
        class_type: "ImageResizeKJv2",
        inputs: {
          image: [nid, 0],
          width: 768,
          height: 768,
          upscale_method: "lanczos",
          keep_proportion: "resize",
          pad_color: "0, 0, 0",
          crop_position: "center",
          divisible_by: 16,
          device: "cpu",
        },
      };
      ids.push(rid);
    });
    let link = [ids[0], 0];
    for (let j = 1; j < ids.length; j += 1) {
      const batchId = String(9200 + j);
      workflow[batchId] = { class_type: "ImageBatch", inputs: { image1: link, image2: [ids[j], 0] } };
      link = [batchId, 0];
    }
    return link;
  }

  const workflowPath = path.join(config.rootDir, "prompts", "h3-prompt-enhance.json");
  const imageWorkflowPath = path.join(config.rootDir, "prompts", "image-prompt-enhance.json");
  const captionWorkflowPath = path.join(config.rootDir, "prompts", "image-caption.json");
  const captionFlorenceWorkflowPath = path.join(config.rootDir, "prompts", "image-caption-florence.json");
  let template = null;
  let imageTemplate = null;
  let captionTemplate = null;
  let captionFlorenceTemplate = null;

  function workflowTemplate() {
    if (!template) template = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
    return deepClone(template);
  }

  function imageWorkflowTemplate() {
    if (!imageTemplate) imageTemplate = JSON.parse(fs.readFileSync(imageWorkflowPath, "utf8"));
    return deepClone(imageTemplate);
  }

  function captionWorkflowTemplate(engine) {
    if (engine === "florence") {
      if (!captionFlorenceTemplate) captionFlorenceTemplate = JSON.parse(fs.readFileSync(captionFlorenceWorkflowPath, "utf8"));
      return deepClone(captionFlorenceTemplate);
    }
    if (!captionTemplate) captionTemplate = JSON.parse(fs.readFileSync(captionWorkflowPath, "utf8"));
    return deepClone(captionTemplate);
  }

  async function optimize({ prompt, mode, duration, referenceNote, language, uploadedImages = [], cloudImages = [], imageCount = 0, signal, engine = "local", cloud = {} }) {
    const text = String(prompt || "").trim();
    if (!text) throw new PromptOptimizeError("缺少提示词", { status: 400, code: "missing_prompt" });
    if (text.length > 8000) throw new PromptOptimizeError("提示词过长", { status: 400, code: "prompt_too_long" });
    const taskType = String(mode || "文生视频(T2VA)").trim();
    if (!MODES.has(taskType)) throw new PromptOptimizeError(`不支持的任务类型：${taskType}`, { status: 400, code: "invalid_mode" });
    const seconds = Number(duration);
    const optimizeSeconds = Number.isFinite(seconds) ? Math.min(15, Math.max(1, seconds)) : 5;
    const outputLanguage = normalizePromptLanguage(language);
    const images = uploadedImages.slice(0, 8);

    if (String(engine || "local").toLowerCase() === "cloud") {
      const cloudResult = await cloudOptimize({ prompt: text, mode: taskType, duration: optimizeSeconds, referenceNote, language: outputLanguage, uploadedImages: images, cloudImages: cloudImages.slice(0, 8), imageCount, cloud, signal });
      return { ...cloudResult, prompt: ensureFrameAlignmentPrompt(cloudResult.prompt, taskType, optimizeSeconds) };
    }

    // [h3-local-fix] 本地 H3 优化改走资源中心分发的 llama.cpp 节点族
    // （llama_cpp_model_loader → llama_cpp_instruct_adv → TE_text_display），
    // 不再依赖未随包分发的私有 QwenTE 节点（任何非作者安装都会报 node not found）。
    // system 用精简版规则（完整 skill 对 9B 太重会超时），云端分支不受影响。
    const workflow = workflowTemplate();
    const userText = [
      `任务类型：${taskType}`,
      `视频时长：${optimizeSeconds} 秒`,
      `输出语言：${outputLanguage === "en" ? "英文（正文英文，台词保留原文语言）" : "中文"}`,
      referenceNote ? `参考素材说明：${String(referenceNote).slice(0, 4000)}` : "",
      images.length ? `参考图片：${images.length} 张（已随消息附上，以图片为准；不要编造图中不存在的场景、陈设或光线）` : "",
      `用户原始提示词：\n${text}`,
    ].filter(Boolean).join("\n");
    workflow["3"].inputs["custom_prompt"] = userText;
    workflow["3"].inputs["system_prompt"] = `${LOCAL_H3_SYSTEM_PROMPT}\n\n## 本次任务\n模式：${taskType}\n时长：${optimizeSeconds} 秒\n输出语言：${h3LanguageDirective(outputLanguage)}\n只输出最终提示词正文；禁止输出思考过程、分析、推理、解释、Markdown 代码块、前后缀或自我说明。`;
    if (images.length) {
      workflow["3"].inputs["images"] = linkImageInputs(workflow, images);
      workflow["3"].inputs["inference_mode"] = "images";
    }
    let wfResult;
    try {
      wfResult = await runTextWorkflow(workflow, { signal, timeoutMs: 210000, label: "本地 H3 提示词优化" });
    } finally {
      // force_offload 的卸载实测不彻底（9B 仍常驻数 GB），收尾显式 /free 保底。
      if (typeof comfy?.freeMemory === "function") {
        try { await comfy.freeMemory(); } catch (e) { logger?.info?.(`h3 local freeMemory skipped: ${e?.message || e}`); }
      }
    }
    const { raw, promptId, elapsedMs } = wfResult;
    const sanitized = sanitizeH3Prompt(raw);
    if (!sanitized) throw new PromptOptimizeError("本地 H3 提示词优化没有返回文本", { status: 502, code: "no_prompt_output" });
    logger?.info?.(`h3 prompt optimize local-llm ${taskType} images=${images.length} ${promptId} ${elapsedMs}ms`);
    const speaker = ensureSpeakerTags(sanitized);
    return {
      prompt: ensureFrameAlignmentPrompt(speaker.prompt, taskType, optimizeSeconds),
      mode: taskType,
      duration: optimizeSeconds,
      promptId,
      elapsedMs,
      provider: "local-llm",
      speakerTags: { fixed: speaker.fixed, issues: speaker.issues },
      note: "已用本地 Qwen3.5-9B 按 H3 规则优化（首次加载约 30 秒，用完自动卸载显存）。本地 9B 对复杂分镜/字段格式的遵循弱于云端，字段可能偏简，关键分镜请核对；追求完整度可用云端优化。",
    };
  }
  async function optimizeImage({ prompt, mode, language, uploadedImages = [], imageCount = 0, signal, engine = "local", cloud = {} }) {
    const text = String(prompt || "").trim();
    if (!text) throw new PromptOptimizeError("缺少提示词", { status: 400, code: "missing_prompt" });
    if (text.length > 8000) throw new PromptOptimizeError("提示词过长", { status: 400, code: "prompt_too_long" });
    const images = uploadedImages.slice(0, 8);
    const useCloud = String(engine || "local").toLowerCase() === "cloud";
    const referenceCount = images.length || Math.max(0, Number(imageCount) || 0);
    const taskMode = String(mode || "").toLowerCase() === "image" ? "图生图" : referenceCount ? "图生图" : "文生图";
    if (!useCloud && taskMode === "图生图" && !images.length) {
      throw new PromptOptimizeError("图生图提示词优化需要至少 1 张参考图", { status: 400, code: "missing_reference_image" });
    }
    if (useCloud) {
      return cloudOptimizeImage({ prompt: text, mode: taskMode, language, imageCount: referenceCount, cloud, signal });
    }

    const workflow = imageWorkflowTemplate();
    workflow["1"].inputs["输入提示词"] = text;
    workflow["1"].inputs["任务模式"] = taskMode;
    workflow["1"].inputs["输出语言"] = language === "en" ? "英文" : "中文";
    workflow["1"].inputs["增强方式"] = "本地官方PE";
    workflow["1"].inputs["生成后自动卸载模型"] = true;
    images.forEach((uploaded, index) => {
      const nodeId = String(9101 + index);
      workflow[nodeId] = {
        class_type: "LoadImage",
        inputs: { image: imageValue(uploaded) },
        _meta: { title: `Image Ref ${index + 1}` },
      };
      workflow["1"].inputs[index === 0 ? "图片" : `图片${index + 1}`] = [nodeId, 0];
    });

    const started = Date.now();
    const submitted = await comfy.submit(withAliases(workflow), { signal });
    const promptId = submitted.promptId;
    let running = true;
    let cancelPromise = null;
    const cancel = () => {
      if (!running) return Promise.resolve();
      if (!cancelPromise) cancelPromise = typeof comfy.cancel === "function" ? comfy.cancel(promptId) : comfy.interrupt(promptId);
      return cancelPromise;
    };
    const onAbort = () => void cancel();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const deadline = Date.now() + 180000;
      let history = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await cancel();
          throw new PromptOptimizeError("提示词优化已取消", { status: 400, code: "cancelled" });
        }
        history = await comfy.history(promptId);
        const failure = historyError(history);
        if (failure) {
          running = false;
          throw new PromptOptimizeError(`提示词优化失败：${truncate(failure, 1200)}`, {
            status: 502,
            code: "comfy_execution_failed",
            details: failure,
          });
        }
        if (historyCompleted(history)) break;
        await sleep(1000);
      }
      running = false;
      if (!historyCompleted(history)) {
        throw new PromptOptimizeError("提示词优化超时", { status: 504, code: "prompt_optimize_timeout" });
      }
      const raw = outputText(history).trim();
      const result = sanitizeImagePrompt(raw);
      if (raw !== result) logger?.info?.(`image prompt optimize sanitized ${raw.length}->${result.length}`);
      if (!result) {
        throw new PromptOptimizeError("提示词工作流没有返回文本", {
          status: 502,
          code: "no_prompt_output",
          details: history.outputs,
        });
      }
      logger?.info?.(`image prompt optimize ${taskMode} images=${images.length} ${promptId} ${Date.now() - started}ms`);
      return { prompt: result, mode: taskMode, promptId, elapsedMs: Date.now() - started, provider: "local" };
    } finally {
      running = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function captionImage({ uploadedImages = [], cloudImages = [], language = "zh", instruction = "", engine = "qwen35", cloud = {}, signal }) {
    if (String(engine || "").toLowerCase() === "cloud") {
      const startedCloud = Date.now();
      if (!cloudImages.length) throw new PromptOptimizeError("云端反推需要 1 张图片", { status: 400, code: "missing_reference_image" });
      const englishCloud = String(language || "zh").toLowerCase() === "en";
      const systemCloud = String(instruction || "").trim() || (englishCloud ? CAPTION_SYSTEM_EN : CAPTION_SYSTEM_ZH);
      const { content, model } = await cloudChat({
        system: systemCloud,
        userText: englishCloud ? CAPTION_USER_EN : CAPTION_USER_ZH,
        images: cloudImages,
        cloud,
        signal,
      });
      return { prompt: content, engine: "cloud", model, elapsedMs: Date.now() - startedCloud };
    }
    const image = uploadedImages[0];
    if (!image) throw new PromptOptimizeError("反推提示词需要 1 张图片", { status: 400, code: "missing_reference_image" });
    const engineName = engine === "florence" ? "florence" : "qwen35";
    const english = String(language || "zh").toLowerCase() === "en";
    const workflow = captionWorkflowTemplate(engineName);
    workflow["1"].inputs["image"] = imageValue(image);
    if (engineName === "qwen35") {
      workflow["3"].inputs["system_prompt"] = String(instruction || "").trim() || (english ? CAPTION_SYSTEM_EN : CAPTION_SYSTEM_ZH);
      workflow["3"].inputs["custom_prompt"] = english ? CAPTION_USER_EN : CAPTION_USER_ZH;
    }

    const started = Date.now();
    const submitted = await comfy.submit(withAliases(workflow), { signal });
    const promptId = submitted.promptId;
    let running = true;
    let cancelPromise = null;
    const cancel = () => {
      if (!running) return Promise.resolve();
      if (!cancelPromise) cancelPromise = typeof comfy.cancel === "function" ? comfy.cancel(promptId) : comfy.interrupt(promptId);
      return cancelPromise;
    };
    const onAbort = () => {
      void cancel();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const deadline = Date.now() + 180000;
      let history = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await cancel();
          throw new PromptOptimizeError("反推提示词已取消", { status: 400, code: "cancelled" });
        }
        history = await comfy.history(promptId);
        const failure = historyError(history);
        if (failure) {
          throw new PromptOptimizeError(`反推提示词失败：${truncate(failure, 1200)}`, {
            status: 502,
            code: "comfy_execution_failed",
            details: failure,
          });
        }
        if (historyCompleted(history)) break;
        await sleep(1000);
      }
      running = false;
      if (!historyCompleted(history)) {
        throw new PromptOptimizeError("反推提示词超时", { status: 504, code: "caption_timeout" });
      }
      const raw = outputText(history).trim();
      const result = sanitizeCaption(raw);
      if (raw !== result) logger?.info?.(`image caption sanitized ${raw.length}->${result.length}`);
      if (!result) {
        throw new PromptOptimizeError("反推工作流没有返回文本", {
          status: 502,
          code: "no_caption_output",
          details: history.outputs,
        });
      }
      logger?.info?.(`image caption ${engineName} ${english ? "en" : "zh"} ${promptId} ${Date.now() - started}ms`);
      return { prompt: result, engine: engineName, promptId, elapsedMs: Date.now() - started };
    } finally {
      running = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return { optimize, optimizeImage, captionImage };
}

const CAPTION_SYSTEM_ZH =
  "你是一位专业的AI图像生成提示词工程师。请详细描述这张图像主体、前景、中景、背景、构图、视觉引导、光影氛围等细节并创作出具有深度、氛围和艺术感或日常业余设备拍摄的图像提示词。\n\n要求：中文提示词，不用出现对图像水印的描述，不要出现无关的文字和符号，不需要总结，限制在800字以内";
const CAPTION_USER_ZH = "请把这张图片反推成可直接用于 AI 生图的中文提示词。";
const CAPTION_SYSTEM_EN =
  "You are a professional prompt engineer for AI image generation. Describe the subject, foreground, middle ground, background, composition, visual guidance, lighting and atmosphere, then write a detailed prompt with depth and mood. Requirements: English prompt only; do not describe watermarks; no irrelevant text or symbols; no summary; at most 800 words.";
const CAPTION_USER_EN = "Write a detailed English prompt that could recreate this image.";
