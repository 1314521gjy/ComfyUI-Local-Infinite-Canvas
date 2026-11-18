import { truncate } from "./util.js";

const PREVIEW_EVENT = "kj_preview_override";
const PROGRESS_EVENT = "progress_state";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

export function createPreviewHub({ comfyUrl, logger, ttlMs = DEFAULT_TTL_MS } = {}) {
  const previews = new Map();
  const progressByPrompt = new Map();
  const promptByRequest = new Map();
  const sockets = new Map();
  const listeners = new Set();

  function wsEndpoint(clientId) {
    // comfyUrl 可以是 getter：ComfyUI 端口自动发现后，预览 WebSocket 也要跟着切。
    const url = new URL(typeof comfyUrl === "function" ? comfyUrl() : comfyUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.searchParams.set("clientId", clientId);
    return url.toString();
  }

  function emitEvent(requestId, promptId) {
    if (!requestId) return;
    for (const listener of listeners) {
      try { listener({ requestId, promptId }); } catch {}
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function createProgress(socket, promptId) {
    const record = {
      previewEnabled: socket.previewEnabled !== false,
      promptId,
      requestId: socket.requestId || null,
      total: socket.plan?.total || 0,
      planNodes: socket.plan?.steps || {},
      absoluteNodes: socket.plan?.absolute || {},
      nodeRatios: new Map(),
      nodeValues: new Map(),
      fallbackStep: null,
      fallbackTotal: null,
      step: 0,
      state: "queued",
      updatedAt: Date.now(),
    };
    progressByPrompt.set(promptId, record);
    if (record.requestId) promptByRequest.set(record.requestId, promptId);
    return record;
  }

  function ensureProgress(socket, promptId) {
    return progressByPrompt.get(promptId) || createProgress(socket, promptId);
  }

  function computeStep(record) {
    if (record.planNodes && Object.keys(record.planNodes).length) {
      let steps = 0;
      for (const [nodeId, planned] of Object.entries(record.planNodes)) {
        if (record.absoluteNodes?.[nodeId]) {
          steps += Math.min(planned, Math.max(0, record.nodeValues.get(nodeId) || 0));
          continue;
        }
        const ratio = record.nodeRatios.get(nodeId) || 0;
        steps += Math.min(1, Math.max(0, ratio)) * planned;
      }
      record.step = Math.min(record.total, Math.round(steps));
      return;
    }
    if (record.fallbackTotal) {
      record.step = Math.min(record.fallbackTotal, Math.max(0, record.fallbackStep || 0));
    }
  }

  function handleProgressState(socket, data) {
    const promptId = data?.prompt_id;
    if (!promptId) return;
    const record = ensureProgress(socket, promptId);
    for (const node of Object.values(data.nodes || {})) {
      const nodeId = String(node?.node_id ?? node?.display_node_id ?? "");
      if (!record.planNodes?.[nodeId]) continue;
      const value = Number(node.value);
      const max = Number(node.max);
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
      if (record.absoluteNodes?.[nodeId]) {
        record.nodeValues.set(nodeId, Math.max(record.nodeValues.get(nodeId) || 0, value));
        continue;
      }
      const ratio = Math.min(1, Math.max(0, value / max));
      record.nodeRatios.set(nodeId, Math.max(record.nodeRatios.get(nodeId) || 0, ratio));
    }
    record.state = "running";
    record.updatedAt = Date.now();
    computeStep(record);
    emitEvent(record.requestId, promptId);
  }

  function finishPrompt(socket, promptId, state) {
    const id = promptId || socket.promptId;
    const record = id ? progressByPrompt.get(id) : null;
    if (!record) return;
    record.state = state;
    record.step = record.total || record.step;
    record.updatedAt = Date.now();
    emitEvent(record.requestId, id);
  }

  function handlePreview(socket, data) {
    const promptId = socket.promptId;
    if (!promptId || !data.image) return;
    const record = progressByPrompt.get(promptId);
    if (record && record.previewEnabled === false) return;
    previews.set(promptId, {
      data: String(data.image),
      mime: String(data.mime || "image/jpeg"),
      step: Number.isFinite(Number(data.step)) ? Number(data.step) : (record?.step ?? null),
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : (record?.total ?? null),
      nodeId: data.node_id || null,
      updatedAt: Date.now(),
    });
    emitEvent(record?.requestId || socket.requestId, promptId);
    const step = Number(data.step);
    const total = Number(data.total);
    if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
      const record = progressByPrompt.get(promptId);
      if (record && !record.total) {
        record.fallbackStep = step;
        record.fallbackTotal = total;
        record.total = total;
        record.state = "running";
        record.updatedAt = Date.now();
        computeStep(record);
      }
    }
  }

  function handleBinary(clientId, buffer) {
    const socket = sockets.get(clientId);
    if (!socket || !buffer || buffer.byteLength <= 8) return;
    const view = new DataView(buffer);
    const type = view.getUint32(0);
    let offset = 8;
    let mime = "image/jpeg";
    let meta = null;
    if (type === 1) {
      const imageType = view.getUint32(4);
      if (imageType !== 1 && imageType !== 2) return;
      mime = imageType === 2 ? "image/png" : "image/jpeg";
    } else if (type === 4) {
      const metaLength = view.getUint32(4);
      if (metaLength > buffer.byteLength - 8) return;
      try {
        meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, metaLength)));
      } catch {
        return;
      }
      mime = meta?.image_type || "image/jpeg";
      offset = 8 + metaLength;
    } else {
      return;
    }
    const promptId = meta?.prompt_id || socket.promptId;
    if (!promptId) return;
    const record = progressByPrompt.get(promptId);
    if (record && record.previewEnabled === false) return;
    const base64 = Buffer.from(new Uint8Array(buffer, offset)).toString("base64");
    previews.set(promptId, {
      data: base64,
      mime,
      step: Number.isFinite(Number(meta?.step)) ? Number(meta.step) : (record?.step ?? null),
      total: Number.isFinite(Number(meta?.total)) ? Number(meta.total) : (record?.total ?? null),
      nodeId: meta?.node_id || null,
      updatedAt: Date.now(),
    });
    emitEvent(record?.requestId || socket.requestId, promptId);
    socket.lastActivity = Date.now();
  }

  function handleMessage(clientId, raw) {
    if (typeof raw !== "string") return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const socket = sockets.get(clientId);
    if (!socket) return;
    if (message?.type === PREVIEW_EVENT) {
      handlePreview(socket, message.data || {});
    } else if (message?.type === PROGRESS_EVENT) {
      handleProgressState(socket, message.data || {});
    } else if (message?.type === "execution_success") {
      finishPrompt(socket, message.data?.prompt_id, "done");
    } else if (message?.type === "execution_error") {
      finishPrompt(socket, message.data?.prompt_id, "error");
    } else if (message?.type === "execution_interrupted") {
      finishPrompt(socket, message.data?.prompt_id, "cancelled");
    } else {
      return;
    }
    socket.lastActivity = Date.now();
  }

  function ensure(clientId) {
    if (!clientId || typeof WebSocket !== "function") return Promise.resolve(false);
    const existing = sockets.get(clientId);
    if (existing && existing.ws.readyState <= 1) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      let ws;
      try {
        ws = new WebSocket(wsEndpoint(clientId));
      } catch (error) {
        logger?.warn?.(`预览 WebSocket 创建失败：${error?.message || error}`);
        finish(false);
        return;
      }
      const entry = { ws, promptId: null, requestId: null, plan: null, lastActivity: Date.now() };
      sockets.set(clientId, entry);
      try { ws.binaryType = "arraybuffer"; } catch {}
      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }));
        } catch {
          // Preview negotiation is best-effort.
        }
        finish(true);
      });
      ws.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") { handleMessage(clientId, data); return; }
        if (data instanceof ArrayBuffer) { handleBinary(clientId, data); return; }
        if (typeof data?.arrayBuffer === "function") { data.arrayBuffer().then((buffer) => handleBinary(clientId, buffer)).catch(() => {}); }
      });
      ws.addEventListener("error", () => {
        logger?.warn?.(`预览 WebSocket 连接失败：${truncate(clientId, 80)}`);
        finish(false);
      });
      ws.addEventListener("close", () => {
        if (sockets.get(clientId) === entry) sockets.delete(clientId);
        finish(false);
      });
      setTimeout(() => finish(ws.readyState === 1), 2500).unref?.();
    });
  }

  function bindPrompt(clientId, promptId, { requestId = null, plan = null, previewEnabled = true } = {}) {
    const socket = sockets.get(clientId);
    if (!socket || !promptId) return;
    socket.promptId = promptId;
    socket.requestId = requestId;
    socket.plan = plan;
    socket.previewEnabled = previewEnabled !== false;
    createProgress(socket, promptId);
  }

  function get(promptId) {
    const preview = previews.get(promptId);
    if (!preview) return null;
    if (Date.now() - preview.updatedAt > ttlMs) {
      previews.delete(promptId);
      return null;
    }
    return preview;
  }

  function getProgress(promptId) {
    const progress = progressByPrompt.get(promptId);
    if (!progress) return null;
    if (Date.now() - progress.updatedAt > ttlMs) {
      progressByPrompt.delete(promptId);
      return null;
    }
    return progress;
  }

  function getByRequest(requestId) {
    const promptId = promptByRequest.get(requestId);
    return promptId ? getProgress(promptId) : null;
  }

  function closeIdle() {
    const now = Date.now();
    for (const [clientId, entry] of sockets) {
      if (now - entry.lastActivity < IDLE_CLOSE_MS) continue;
      try {
        entry.ws.close();
      } catch {
        // ignore
      }
      sockets.delete(clientId);
    }
    for (const [promptId, preview] of previews) {
      if (now - preview.updatedAt > ttlMs) previews.delete(promptId);
    }
    for (const [promptId, progress] of progressByPrompt) {
      if (now - progress.updatedAt > ttlMs) {
        progressByPrompt.delete(promptId);
        if (progress.requestId && promptByRequest.get(progress.requestId) === promptId) promptByRequest.delete(progress.requestId);
      }
    }
  }

  const timer = setInterval(closeIdle, 60 * 1000);
  timer.unref?.();

  return { ensure, bindPrompt, get, getProgress, getByRequest, subscribe, closeIdle };
}
