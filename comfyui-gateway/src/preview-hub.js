import { truncate } from "./util.js";

const PREVIEW_EVENT = "kj_preview_override";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

export function createPreviewHub({ comfyUrl, logger, ttlMs = DEFAULT_TTL_MS } = {}) {
  const previews = new Map();
  const sockets = new Map();

  function wsEndpoint(clientId) {
    const url = new URL(comfyUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.searchParams.set("clientId", clientId);
    return url.toString();
  }

  function handleMessage(clientId, raw) {
    if (typeof raw !== "string") return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== PREVIEW_EVENT) return;
    const data = message.data || {};
    if (!data.image) return;
    const socket = sockets.get(clientId);
    const promptId = socket?.promptId;
    if (!promptId) return;
    previews.set(promptId, {
      data: String(data.image),
      mime: String(data.mime || "image/jpeg"),
      step: Number.isFinite(Number(data.step)) ? Number(data.step) : null,
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : null,
      nodeId: data.node_id || null,
      updatedAt: Date.now(),
    });
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
      const entry = { ws, promptId: null, lastActivity: Date.now() };
      sockets.set(clientId, entry);
      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }));
        } catch {
          // Preview negotiation is best-effort.
        }
        finish(true);
      });
      ws.addEventListener("message", (event) => handleMessage(clientId, event.data));
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

  function bindPrompt(clientId, promptId) {
    const socket = sockets.get(clientId);
    if (socket && promptId) socket.promptId = promptId;
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
  }

  const timer = setInterval(closeIdle, 60 * 1000);
  timer.unref?.();

  return { ensure, bindPrompt, get, closeIdle };
}
