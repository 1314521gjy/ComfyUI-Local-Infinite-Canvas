// 让只绑回环的内置 assistant 服务（画布里的 pi Agent）在非本机设备上也可用。
//
// assistant.js 用 listen(0, "127.0.0.1") 起服务，并把该地址原样返回给浏览器；
// 远程设备（手机、另一台电脑）拿到 127.0.0.1 只会解析成自己的回环，于是画布里的
// pi Agent 必然 Failed to fetch。这里做两件事：
//   1) ensure/status 返回体里的 url 改写为网关下的同源代理路径，原地址保留在 directUrl，
//      本机调用方（启动器、健康检查）仍可直连；
//   2) /api/assistant/proxy/* 以原始流转发到本机服务，SSE 与带 body 的 POST 都能透传，
//      并且在服务因闲置退出时自动拉起一次。
//
// 挂载位置有硬性要求：必须在 express.json() 之前。否则请求体已被 JSON 中间件消费，
// 转发会抛 "Response body object should not be disturbed or locked"，表现为
// assistant_proxy_upstream_failed。
export function assistantProxyBase(config) {
  const base = String((config && config.publicBaseUrl) || "").replace(/\/+$/, "");
  return base ? `${base}/api/assistant/proxy` : "";
}

export function withAssistantProxyUrl(config, payload) {
  const base = assistantProxyBase(config);
  if (!base || !payload || !payload.url) return payload;
  return { ...payload, directUrl: payload.url, url: base };
}

export function attachAssistantProxy(app, assistant, config) {
  app.use("/api/assistant/proxy", async (req, res) => {
    try {
      if (!assistant.running) {
        const ensured = await assistant.ensure({});
        if (!ensured.ok) {
          res.status(503).json({ ok: false, error: ensured.error || "assistant_unavailable" });
          return;
        }
      }
      const target = String(assistant.url || "");
      if (!target) {
        res.status(503).json({ ok: false, error: "assistant_url_missing" });
        return;
      }
      const sub = req.originalUrl.replace(/^\/api\/assistant\/proxy/, "") || "/";
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const name = key.toLowerCase();
        if (name === "host" || name === "connection" || name === "keep-alive"
          || name === "transfer-encoding" || name === "content-length") continue;
        headers[key] = value;
      }
      const upstream = await fetch(target + sub, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        duplex: "half",
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
      res.status(upstream.status);
      for (const [key, value] of upstream.headers) {
        const name = key.toLowerCase();
        if (name === "content-encoding" || name === "transfer-encoding" || name === "content-length") continue;
        res.setHeader(key, value);
      }
      if (upstream.body) {
        const { Readable } = await import("node:stream");
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) {
        res.status(502).json({ ok: false, error: "assistant_proxy_upstream_failed", message: String((error && error.message) || error) });
      } else {
        res.destroy();
      }
    }
  });
}
