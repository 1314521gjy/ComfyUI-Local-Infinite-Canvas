import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createComfyClient } from "../src/comfy-client.js";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("GET requests retry transient 5xx responses", async () => {
  let calls = 0;
  const { server, port } = await listen((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "starting" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ abc: { outputs: { 1: { images: [] } } } }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    const history = await comfy.history("abc");
    assert.equal(calls, 2);
    assert.ok(history);
  } finally {
    await close(server);
  }
});

test("POST submissions are never retried", async () => {
  let calls = 0;
  const { server, port } = await listen((_req, res) => {
    calls += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    await assert.rejects(
      () => comfy.submit({ 1: { class_type: "Test", inputs: {} } }),
      (error) => error.code === "comfy_http_error" && error.httpStatus === 503,
    );
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("4xx responses are not retried", async () => {
  let calls = 0;
  const { server, port } = await listen((_req, res) => {
    calls += 1;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const comfy = createComfyClient({ baseUrl: `http://127.0.0.1:${port}`, retryAttempts: 3, retryDelayMs: 10 });
  try {
    await assert.rejects(
      () => comfy.history("missing"),
      (error) => error.code === "comfy_http_error" && error.httpStatus === 404,
    );
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});
