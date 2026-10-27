import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function buildCloudH3System(mode, duration) {
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
输出语言：官方字段名保留英文；字段正文默认中文；台词、旁白、歌词保留原文语言。
对齐句由系统在正文前补充，正文不要另写。
只输出最终 H3 提示词正文，不要输出思考过程、分析、解释、Markdown 代码块或前后缀。`;
}

const CLOUD_IMAGE_SYSTEM_PROMPT = `你是 AI 生图提示词专家。请把用户输入改写为一条可直接使用的生图/图生图提示词，只输出最终提示词本身，不要输出任何思考过程、分析、解释、Markdown 代码块、标题或前后缀。

要求：主体明确，构图、镜头、光线、材质与风格具体；保留用户的主体和意图，不要编造品牌或画面文字；图生图时说明需要保留与需要改变的部分；输出语言与“输出语言”字段一致。`;

function cloudContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

async function cloudChat({ system, userText, cloud = {}, signal, temperature = 0.6, maxTokens = 4096 }) {
  const baseUrl = String(cloud.baseUrl || "").trim();
  const apiKey = String(cloud.apiKey || "").trim();
  const model = String(cloud.model || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new PromptOptimizeError("云端 API 未配置：请先在设置中填写 Base URL、API Key 和模型", { status: 400, code: "cloud_not_configured" });
  }
  const endpoint = cloudChatUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("云端 API 超时")), 120000);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText },
        ],
        temperature,
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
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      throw new PromptOptimizeError(`云端 API 失败：${truncate(String(message), 800)}`, { status: 502, code: "cloud_api_failed", details: data });
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

async function cloudOptimize({ prompt, mode, duration, referenceNote, uploadedImages = [], cloud = {}, signal }) {
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
    frameGuide ? `画面路径：${frameGuide}` : "",
    referenceNote ? `参考素材说明：${referenceNote}` : "",
    uploadedImages.length ? `参考图片：${uploadedImages.length} 张（云端模式仅使用文字说明）` : "",
    `用户原始提示词：\n${prompt}`,
  ].filter(Boolean).join("\n");
  const system = buildCloudH3System(mode, duration);
  const { content, model, elapsedMs } = await cloudChat({ system, userText, cloud, signal });
  const result = sanitizeH3Prompt(content);
  if (!result) throw new PromptOptimizeError("云端 API 没有返回提示词", { status: 502, code: "no_prompt_output" });
  return { prompt: result, mode, duration, provider: "cloud", model, elapsedMs };
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

export function createPromptOptimizer({ config, comfy, logger }) {
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

  async function optimize({ prompt, mode, duration, referenceNote, uploadedImages = [], signal, engine = "local", cloud = {} }) {
    const text = String(prompt || "").trim();
    if (!text) throw new PromptOptimizeError("缺少提示词", { status: 400, code: "missing_prompt" });
    if (text.length > 8000) throw new PromptOptimizeError("提示词过长", { status: 400, code: "prompt_too_long" });
    const taskType = String(mode || "文生视频(T2VA)").trim();
    if (!MODES.has(taskType)) throw new PromptOptimizeError(`不支持的任务类型：${taskType}`, { status: 400, code: "invalid_mode" });
    const seconds = Number(duration);
    const optimizeSeconds = Number.isFinite(seconds) ? Math.min(15, Math.max(1, seconds)) : 5;
    const images = uploadedImages.slice(0, 8);

    if (String(engine || "local").toLowerCase() === "cloud") {
      const cloudResult = await cloudOptimize({ prompt: text, mode: taskType, duration: optimizeSeconds, referenceNote, uploadedImages: images, cloud, signal });
      return { ...cloudResult, prompt: ensureFrameAlignmentPrompt(cloudResult.prompt, taskType, optimizeSeconds) };
    }

    const workflow = workflowTemplate();
    workflow["2"].inputs["输入提示词"] = text;
    workflow["2"].inputs["任务类型"] = taskType;
    workflow["2"].inputs["视频时长"] = optimizeSeconds;
    workflow["2"].inputs["参考素材说明"] = String(referenceNote || "").slice(0, 4000);
    if (images.length) {
      workflow["3"].inputs["输入模式"] = "图片";
      images.forEach((uploaded, index) => {
        const nodeId = String(9101 + index);
        workflow[nodeId] = {
          class_type: "LoadImage",
          inputs: { image: imageValue(uploaded) },
          _meta: { title: `H3 Ref ${index + 1}` },
        };
        workflow["3"].inputs[index === 0 ? "图片" : `图片${index + 1}`] = [nodeId, 0];
      });
    } else {
      workflow["3"].inputs["输入模式"] = "文本";
    }
    const baseSystemPrompt = String(workflow["3"].inputs["系统提示词"] || "").trim();
    workflow["3"].inputs["系统提示词"] = `${baseSystemPrompt}${baseSystemPrompt ? "\n" : ""}只输出最终提示词正文；禁止输出思考过程、分析、推理、解释、Markdown 代码块、前后缀或自我说明。`;

    const started = Date.now();
    const submitted = await comfy.submit(workflow, { signal });
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
      const result = sanitizeH3Prompt(raw);
      if (raw !== result) logger?.info?.(`prompt optimize sanitized ${raw.length}->${result.length}`);
      if (!result) {
        throw new PromptOptimizeError("提示词工作流没有返回文本", {
          status: 502,
          code: "no_prompt_output",
          details: history.outputs,
        });
      }
      logger?.info?.(`prompt optimize ${taskType} images=${images.length} ${promptId} ${Date.now() - started}ms`);
      return {
        prompt: ensureFrameAlignmentPrompt(result, taskType, optimizeSeconds),
        mode: taskType,
        duration: optimizeSeconds,
        promptId,
        elapsedMs: Date.now() - started,
        provider: "local",
      };
    } finally {
      running = false;
      signal?.removeEventListener("abort", onAbort);
    }
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
    const submitted = await comfy.submit(workflow, { signal });
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

  async function captionImage({ uploadedImages = [], language = "zh", instruction = "", engine = "qwen35", signal }) {
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
    const submitted = await comfy.submit(workflow, { signal });
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
