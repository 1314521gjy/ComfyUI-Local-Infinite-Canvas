import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createModelEventBus } from "../src/model-events.js";

function mockResponse() {
  const res = new EventEmitter();
  res.chunks = [];
  res.headers = {};
  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value;
  };
  res.flushHeaders = () => {};
  res.write = (chunk) => {
    res.chunks.push(String(chunk));
    return true;
  };
  return res;
}

test("model event bus sends the current revision and broadcasts changes", () => {
  const bus = createModelEventBus();
  const req = new EventEmitter();
  const res = mockResponse();
  bus.subscribe(req, res);
  assert.equal(bus.clientCount(), 1);
  assert.match(res.chunks.join(""), /event: models/);
  assert.match(res.chunks.join(""), /"revision":0/);

  const event = bus.broadcast("visibility");
  assert.equal(event.revision, 1);
  assert.match(res.chunks.at(-1), /event: models/);
  assert.match(res.chunks.at(-1), /"reason":"visibility"/);

  req.emit("close");
  assert.equal(bus.clientCount(), 0);
});
