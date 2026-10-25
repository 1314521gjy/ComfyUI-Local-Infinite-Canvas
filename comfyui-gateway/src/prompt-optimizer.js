import fs from "node:fs";
import path from "node:path";

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

export function createPromptOptimizer({ config, comfy, logger }) {
  const workflowPath = path.join(config.rootDir, "prompts", "h3-prompt-enhance.json");
  const imageWorkflowPath = path.join(config.rootDir, "prompts", "image-prompt-enhance.json");
  let template = null;
  let imageTemplate = null;

  function workflowTemplate() {
    if (!template) template = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
    return deepClone(template);
  }

  function imageWorkflowTemplate() {
    if (!imageTemplate) imageTemplate = JSON.parse(fs.readFileSync(imageWorkflowPath, "utf8"));
    return deepClone(imageTemplate);
  }

  async function optimize({ prompt, mode, duration, referenceNote, uploadedImages = [], signal }) {
    const text = String(prompt || "").trim();
    if (!text) throw new PromptOptimizeError("缺少提示词", { status: 400, code: "missing_prompt" });
    if (text.length > 8000) throw new PromptOptimizeError("提示词过长", { status: 400, code: "prompt_too_long" });
    const taskType = String(mode || "文生视频(T2VA)").trim();
    if (!MODES.has(taskType)) throw new PromptOptimizeError(`不支持的任务类型：${taskType}`, { status: 400, code: "invalid_mode" });
    const seconds = Number(duration);
    const optimizeSeconds = Number.isFinite(seconds) ? Math.min(15, Math.max(1, seconds)) : 5;
    const images = uploadedImages.slice(0, 8);

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
      const result = outputText(history).trim();
      if (!result) {
        throw new PromptOptimizeError("提示词工作流没有返回文本", {
          status: 502,
          code: "no_prompt_output",
          details: history.outputs,
        });
      }
      logger?.info?.(`prompt optimize ${taskType} images=${images.length} ${promptId} ${Date.now() - started}ms`);
      return { prompt: result, mode: taskType, duration: optimizeSeconds, promptId, elapsedMs: Date.now() - started };
    } finally {
      running = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function optimizeImage({ prompt, mode, language, uploadedImages = [], signal }) {
    const text = String(prompt || "").trim();
    if (!text) throw new PromptOptimizeError("缺少提示词", { status: 400, code: "missing_prompt" });
    if (text.length > 8000) throw new PromptOptimizeError("提示词过长", { status: 400, code: "prompt_too_long" });
    const images = uploadedImages.slice(0, 8);
    const taskMode = String(mode || "").toLowerCase() === "image" ? "图生图" : images.length ? "图生图" : "文生图";
    if (taskMode === "图生图" && !images.length) {
      throw new PromptOptimizeError("图生图提示词优化需要至少 1 张参考图", { status: 400, code: "missing_reference_image" });
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
      const result = outputText(history).trim();
      if (!result) {
        throw new PromptOptimizeError("提示词工作流没有返回文本", {
          status: 502,
          code: "no_prompt_output",
          details: history.outputs,
        });
      }
      logger?.info?.(`image prompt optimize ${taskMode} images=${images.length} ${promptId} ${Date.now() - started}ms`);
      return { prompt: result, mode: taskMode, promptId, elapsedMs: Date.now() - started };
    } finally {
      running = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return { optimize, optimizeImage };
}
