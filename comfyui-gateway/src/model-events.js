import { nowIso } from "./util.js";

/**
 * 轻量模型变更广播：工作流启用/隐藏、扫描完成、资源安装后通知所有画布。
 * SSE 只承载“去重新拉 /v1/models”的信号，不直接推送模型正文。
 */
export function createModelEventBus({ logger } = {}) {
  const clients = new Set();
  let revision = 0;
  let lastReason = "";

  function snapshot() {
    return { revision, reason: lastReason, updatedAt: nowIso() };
  }

  function write(res, event, payload) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      clients.delete(res);
      return false;
    }
  }

  function broadcast(reason = "change") {
    revision += 1;
    lastReason = String(reason || "change");
    const payload = snapshot();
    for (const res of [...clients]) write(res, "models", payload);
    return payload;
  }

  function subscribe(req, res) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    clients.add(res);
    write(res, "models", { ...snapshot(), reason: "subscribe" });
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25000);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on("close", close);
    req.on("aborted", close);
    logger?.debug?.(`model events client connected (${clients.size})`);
  }

  return { subscribe, broadcast, snapshot, clientCount: () => clients.size };
}
