import path from "node:path";

import { applyBindings } from "./bindings.js";
import { applyLoraChain } from "./lora-chain.js";
import { mimeFromFilename, sleep, truncate } from "./util.js";

export class GenerationError extends Error {
  constructor(message, { status = 500, code = "generation_failed", details } = {}) {
    super(message);
    this.name = "GenerationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function resolveForMode(entry, mode) {
  const variant = mode ? entry?.variants?.[mode] : null;
  if (!variant) return entry;
  return {
    ...entry,
    ...variant,
    workflow: variant.workflow || entry.workflow,
    bindings: variant.bindings || entry.bindings,
    defaults: variant.defaults || entry.defaults,
  };
}

function applyMainModelFile(workflow, file) {
  if (!file) return workflow;
  const nodeId = Object.keys(workflow || {}).find((id) => {
    const node = workflow[id];
    return node?.class_type === "UNETLoader" && typeof node.inputs?.unet_name === "string";
  });
  if (!nodeId || workflow[nodeId].inputs.unet_name === file) return workflow;
  return { ...workflow, [nodeId]: { ...workflow[nodeId], inputs: { ...workflow[nodeId].inputs, unet_name: file } } };
}

function historyCompleted(history) {
  if (!history) return false;
  if (history.status?.completed === true) return true;
  if (history.status?.status_str === "success") return true;
  return Boolean(history.outputs && Object.keys(history.outputs).length);
}

function historyError(history) {
  if (!history) return "";
  if (history.status?.status_str === "error") {
    const messages = Array.isArray(history.status.messages) ? history.status.messages.flat() : [];
    const text = messages
      .map((item) => (typeof item === "string" ? item : item?.message || JSON.stringify(item)))
      .filter(Boolean)
      .join("；");
    return text || "ComfyUI 执行失败";
  }
  return "";
}

function collectOutputFiles(history, { includePreview = false } = {}) {
  const files = [];
  const seen = new Set();
  for (const [nodeId, output] of Object.entries(history?.outputs || {})) {
    for (const key of ["images", "gifs", "videos"]) {
      for (const item of output?.[key] || []) {
        if (!item?.filename) continue;
        if (item.type && item.type !== "output" && !(includePreview && item.type === "temp")) continue;
        const dedupe = `${item.type || "output"}:${item.subfolder || ""}:${item.filename}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        files.push({ ...item, nodeId });
      }
    }
  }
  return files;
}

export async function runWorkflow({ entry, context, comfy, timeoutMs = 10 * 60 * 1000, pollIntervalMs = 750, signal, requestId, onProgress, logger, loraCatalog, includePreviewOutputs = false }) {
  if (signal?.aborted) throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
  const resolved = resolveForMode(entry, context.mode);
  const params = resolved.baseModelParams ? { ...resolved.baseModelParams, ...(context.params || {}) } : context.params;
  const bound = applyMainModelFile(applyBindings(resolved.workflow, resolved, { ...context, params }, { logger }), resolved.mainModelFile);
  const loraResult = applyLoraChain(bound, params, {
    available: loraCatalog,
    filter: resolved.lora?.filter,
    sourceNode: resolved.lora?.source,
    loaderClass: resolved.lora?.loader || "LoraLoaderModelOnly",
  });
  const workflow = loraResult.workflow;
  if (loraResult.applied.length) {
    logger?.info?.(`LoRA ${entry.name}: ${loraResult.applied.map((item) => `${path.basename(item.name)}@${item.strength}`).join(" -> ")}`);
  }
  const submitted = await comfy.submit(workflow, { signal, requestId });
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
    if (signal?.aborted) {
      await cancel();
      throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
    }
    onProgress?.({ phase: "submitted", promptId, progress: 0.05 });

    const timeout = Number(timeoutMs);
    const deadline = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
    let history = null;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await cancel();
        throw new GenerationError("生成已取消", { status: 400, code: "cancelled" });
      }
      history = await comfy.history(promptId);
      const failure = historyError(history);
      if (failure) {
        running = false;
        throw new GenerationError(`ComfyUI 执行失败：${truncate(failure, 1200)}`, { status: 502, code: "comfy_execution_failed", details: failure });
      }
      if (historyCompleted(history)) {
        running = false;
        break;
      }
      await sleep(pollIntervalMs);
    }
    if (!historyCompleted(history)) {
      running = false;
      throw new GenerationError("生成超时", { status: 504, code: "generation_timeout" });
    }
    onProgress?.({ phase: "completed", promptId, progress: 0.65 });

    const files = collectOutputFiles(history, { includePreview: includePreviewOutputs });
    if (!files.length) throw new GenerationError("ComfyUI 没有返回任何输出文件", { status: 502, code: "no_output_files" });

    const outputs = [];
    for (const file of files) {
      const viewed = await comfy.view(file);
      const mimeType = /^application\/octet-stream$/i.test(viewed.contentType) ? mimeFromFilename(file.filename) : viewed.contentType;
      outputs.push({
        buffer: viewed.buffer,
        mimeType,
        filename: path.basename(file.filename),
        subfolder: file.subfolder || "",
        type: file.type || "output",
        nodeId: file.nodeId,
      });
    }
    onProgress?.({ phase: "downloaded", promptId, progress: 0.95 });
    return { promptId, files: outputs, workflow };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runImage({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, onProgress, logger, loraCatalog, includePreviewOutputs = false }) {
  const count = context.count || 1;
  const all = [];
  let lastPromptId;
  // 工作流如果支持 batch，一次就能返回 count 张；不支持时按张补跑，避免画布静默少图。
  for (let attempt = 0; attempt < count && all.length < count; attempt += 1) {
    const result = await runWorkflow({
      entry,
      context,
      comfy,
      timeoutMs,
      pollIntervalMs,
      signal,
      requestId,
      logger,
      loraCatalog,
      includePreviewOutputs,
      onProgress: (event) => onProgress?.({ ...event, attempt, attempts: count }),
    });
    lastPromptId = result.promptId;
    all.push(...result.files);
  }
  return { promptId: lastPromptId, files: all.slice(0, count) };
}

export async function runVideo({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, onProgress, logger, loraCatalog, includePreviewOutputs = false }) {
  const result = await runWorkflow({ entry, context, comfy, timeoutMs, pollIntervalMs, signal, requestId, logger, loraCatalog, includePreviewOutputs, onProgress });
  const video = result.files.find((file) => /^video\//i.test(file.mimeType) || /\.(mp4|webm|mov)$/i.test(file.filename));
  if (!video) {
    throw new GenerationError("视频工作流没有返回视频文件（只拿到了图片/动图）", { status: 502, code: "no_video_output", details: result.files.map((file) => file.filename) });
  }
  return { promptId: result.promptId, files: [video] };
}
