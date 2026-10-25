import assert from "node:assert/strict";
import { test } from "node:test";

import { createPreviewHub } from "../src/preview-hub.js";

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  send() {}

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const handler of this.listeners[type] || []) handler(event);
  }

  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

test("progress_state is aggregated across samplers into the planned step count", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const hub = createPreviewHub({ comfyUrl: "http://127.0.0.1:8188" });
    await hub.ensure("client-1");
    hub.bindPrompt("client-1", "prompt-1", {
      requestId: "req-1",
      plan: { total: 13, steps: { 7: 7, 9: 6 } },
    });
    const socket = FakeWebSocket.instances.at(-1);
    socket.message({
      type: "progress_state",
      data: {
        prompt_id: "prompt-1",
        nodes: {
          7: { node_id: "7", value: 3, max: 7, state: "running" },
          9: { node_id: "9", value: 0, max: 1, state: "pending" },
        },
      },
    });
    assert.equal(hub.getByRequest("req-1").step, 3);
    socket.message({
      type: "progress_state",
      data: {
        prompt_id: "prompt-1",
        nodes: {
          7: { node_id: "7", value: 7, max: 7, state: "finished" },
          9: { node_id: "9", value: 3, max: 6, state: "running" },
        },
      },
    });
    assert.equal(hub.getByRequest("req-1").step, 10);
    socket.message({ type: "execution_success", data: { prompt_id: "prompt-1" } });
    const progress = hub.getByRequest("req-1");
    assert.equal(progress.step, 13);
    assert.equal(progress.state, "done");
  } finally {
    globalThis.WebSocket = original;
  }
});

test("SelfLift stage one keeps room for the high-res stage", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const hub = createPreviewHub({ comfyUrl: "http://127.0.0.1:8188" });
    await hub.ensure("client-3");
    hub.bindPrompt("client-3", "prompt-3", {
      requestId: "req-3",
      plan: { total: 9, steps: { 78: 9 }, absolute: { 78: true } },
    });
    const socket = FakeWebSocket.instances.at(-1);
    socket.message({
      type: "progress_state",
      data: { prompt_id: "prompt-3", nodes: { 78: { node_id: "78", value: 6, max: 6, state: "running" } } },
    });
    assert.equal(hub.getByRequest("req-3").step, 6);
    socket.message({
      type: "progress_state",
      data: { prompt_id: "prompt-3", nodes: { 78: { node_id: "78", value: 7, max: 9, state: "running" } } },
    });
    assert.equal(hub.getByRequest("req-3").step, 7);
    socket.message({
      type: "progress_state",
      data: { prompt_id: "prompt-3", nodes: { 78: { node_id: "78", value: 9, max: 9, state: "finished" } } },
    });
    assert.equal(hub.getByRequest("req-3").step, 9);
  } finally {
    globalThis.WebSocket = original;
  }
});

test("preview step metadata is used when the workflow has no sampler plan", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const hub = createPreviewHub({ comfyUrl: "http://127.0.0.1:8188" });
    await hub.ensure("client-2");
    hub.bindPrompt("client-2", "prompt-2", { requestId: "req-2", plan: { total: 0, steps: {} } });
    const socket = FakeWebSocket.instances.at(-1);
    socket.message({
      type: "kj_preview_override",
      data: { image: "AAAA", mime: "image/jpeg", step: 2, total: 8 },
    });
    const progress = hub.getByRequest("req-2");
    assert.equal(progress.step, 2);
    assert.equal(progress.total, 8);
  } finally {
    globalThis.WebSocket = original;
  }
});
