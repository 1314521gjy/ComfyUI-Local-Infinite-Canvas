import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { attachAssistantProxy, assistantProxyBase, withAssistantProxyUrl } from "../src/assistant-proxy.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// keep-alive 连接会让测试进程挂在事件循环上，收摊时必须显式断开。
function shutdown(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

function fakeApp() {
  const routes = [];
  return { routes, use: (path, handler) => routes.push({ path, handler }) };
}

// 用真实 HTTP 服务器承载 express 中间件签名，测试因此不依赖 express。
async function serveThrough(handler, request) {
  const server = http.createServer((req, res) => {
    req.originalUrl = `/api/assistant/proxy${req.url}`;
    // 中间件按 express 的 API 写，这里补出 .status()/.json() 两个糖，其余用原生实现。
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (value) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
      return res;
    };
    handler(req, res);
  });
  const base = await listen(server);
  try {
    const response = await fetch(base + request.path, request.init);
    return { status: response.status, text: await response.text() };
  } finally {
    await shutdown(server);
  }
}

test("assistantProxyBase / withAssistantProxyUrl：改写 url，保留原地址", () => {
  const config = { publicBaseUrl: "http://192.168.3.89:8190/" };
  assert.equal(assistantProxyBase(config), "http://192.168.3.89:8190/api/assistant/proxy");
  const rewritten = withAssistantProxyUrl(config, { ok: true, url: "http://127.0.0.1:50740", pid: 4242 });
  assert.equal(rewritten.url, "http://192.168.3.89:8190/api/assistant/proxy");
  assert.equal(rewritten.directUrl, "http://127.0.0.1:50740");
  assert.equal(rewritten.pid, 4242);
  // 纯本机安装（没有 publicBaseUrl）时原样返回，不改任何既有行为。
  assert.equal(withAssistantProxyUrl({}, { url: "http://127.0.0.1:1" }).url, "http://127.0.0.1:1");
  assert.equal(withAssistantProxyUrl({ publicBaseUrl: "http://x:1" }, { ok: true }).url, undefined);
});

test("POST 请求体与查询串原样透传，上游状态码与响应体回传", async () => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString("utf8") }));
  });
  const url = await listen(upstream);
  try {
    const app = fakeApp();
    attachAssistantProxy(app, { running: true, url }, { publicBaseUrl: "http://lan:8190" });
    const result = await serveThrough(app.routes[0].handler, {
      path: "/api/assistant/chat?stream=1",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "pi" }) },
    });
    assert.equal(result.status, 201);
    const data = JSON.parse(result.text);
    assert.equal(data.path, "/api/assistant/chat?stream=1");
    assert.equal(data.method, "POST");
    assert.equal(data.body, JSON.stringify({ hello: "pi" }));
  } finally {
    await shutdown(upstream);
  }
});

test("服务因闲置退出后自动 ensure，并转发鉴权相关请求头", async () => {
  const seen = {};
  const upstream = http.createServer((req, res) => {
    seen.authorization = req.headers.authorization;
    seen.cookie = req.headers.cookie;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: ok\n\n");
  });
  const url = await listen(upstream);
  try {
    let ensureCalls = 0;
    const assistant = {
      running: false,
      url,
      ensure: async () => {
        ensureCalls += 1;
        assistant.running = true;
        return { ok: true };
      },
    };
    const app = fakeApp();
    attachAssistantProxy(app, assistant, { publicBaseUrl: "http://lan:8190" });
    const result = await serveThrough(app.routes[0].handler, {
      path: "/health",
      init: { method: "GET", headers: { authorization: "Bearer t", cookie: "a=b" } },
    });
    assert.equal(result.status, 200);
    assert.equal(result.text, "data: ok\n\n");
    assert.equal(ensureCalls, 1);
    assert.equal(seen.authorization, "Bearer t");
    assert.equal(seen.cookie, "a=b");
  } finally {
    await shutdown(upstream);
  }
});

test("上游不可达返回 502，assistant 起不来返回 503", async () => {
  const app = fakeApp();
  attachAssistantProxy(app, { running: true, url: "http://127.0.0.1:1" }, { publicBaseUrl: "http://lan:8190" });
  const dead = await serveThrough(app.routes[0].handler, { path: "/health", init: { method: "GET" } });
  assert.equal(dead.status, 502);
  assert.equal(JSON.parse(dead.text).error, "assistant_proxy_upstream_failed");

  const app2 = fakeApp();
  const failing = { running: false, url: "", ensure: async () => ({ ok: false, error: "assistant_runtime_missing" }) };
  attachAssistantProxy(app2, failing, { publicBaseUrl: "http://lan:8190" });
  const missing = await serveThrough(app2.routes[0].handler, { path: "/health", init: { method: "GET" } });
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.text).error, "assistant_runtime_missing");
});
