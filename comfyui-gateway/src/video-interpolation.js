import fs from "node:fs";
import path from "node:path";

import { sleep } from "./util.js";

export function createVideoInterpolator({ config, logger } = {}) {
  const workflowPath = path.join(config.workflowDir, "_internal", "video-rife.json");

  function template() {
    return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  }

  async function interpolate({ comfy, buffer, filename, multiplier, requestId, signal, timeoutMs = 10 * 60 * 1000 }) {
    const factor = Number(multiplier);
    if (factor !== 2 && factor !== 3) throw new Error("插帧倍率仅支持 2× 或 3×");
    if (!buffer?.length) throw new Error("插帧缺少输入视频");
    const safeRequest = String(requestId || Date.now()).replace(/[^\w.-]+/g, "_");
    const uploaded = await comfy.uploadImage(buffer, `rife-${safeRequest}.mp4`, "video/mp4");
    const workflow = template();
    workflow["1"].inputs.video = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    workflow["2"].inputs.multiplier = factor;
    workflow["3"].inputs.frame_rate = 24 * factor;
    workflow["3"].inputs.filename_prefix = `rife/${safeRequest}`;
    const submitted = await comfy.submit(workflow, { signal, requestId, clientId: `rife-${Date.now()}` });
    const promptId = submitted.promptId;
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await comfy.cancel?.(promptId).catch(() => undefined);
        throw new Error("插帧已取消");
      }
      const history = await comfy.history(promptId);
      const item = history?.[promptId] || history;
      if (item) {
        const status = item.status || {};
        if (status.status_str === "error") {
          const messages = Array.isArray(status.messages) ? status.messages.flat() : [];
          const detail = messages
            .map((entry) => (typeof entry === "string" ? entry : entry?.message || ""))
            .filter(Boolean)
            .join("；");
          throw new Error(`插帧失败：${detail || "ComfyUI 执行错误"}`);
        }
        const files = [];
        for (const output of Object.values(item.outputs || {})) {
          for (const key of ["gifs", "videos"]) {
            for (const file of output?.[key] || []) files.push(file);
          }
        }
        if (files.length) {
          const file = files[0];
          const viewed = await comfy.view({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
          logger?.info?.(`video interpolation ${factor}x ${promptId} ${Date.now() - started}ms`);
          return { buffer: viewed.buffer, filename: file.filename, mimeType: viewed.contentType || "video/mp4" };
        }
        if (status.completed) throw new Error("插帧工作流没有返回视频");
      }
      await sleep(1500);
    }
    throw new Error("插帧超时");
  }

  return { interpolate };
}
