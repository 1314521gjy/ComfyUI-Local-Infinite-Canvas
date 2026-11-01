import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  comfyListenerPidsForKill,
  isComfySystemStats,
  isTrustedControlRequest,
  probeComfy,
} from "../../launcher/start.mjs";

const validStats = {
  system: { ram_total: 1024, ram_free: 512, comfyui_version: "test" },
  devices: [{ name: "cpu", type: "cpu", vram_total: 0, vram_free: 0 }],
};

function controlRequest(headers = {}, remoteAddress = "127.0.0.1") {
  return { socket: { remoteAddress }, headers: { host: "127.0.0.1:8290", ...headers } };
}

test("ComfyUI probe validates the system_stats response structure", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/valid/system_stats") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(validStats));
      return;
    }
    if (req.url === "/malformed/system_stats") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await probeComfy(`${base}/valid`), true);
    assert.equal(await probeComfy(`${base}/malformed`), false);
    assert.equal(await probeComfy(`${base}/missing`), false);
    assert.equal(isComfySystemStats(validStats), true);
    assert.equal(isComfySystemStats({ system: {}, devices: [] }), false);
    assert.equal(isComfySystemStats({ ...validStats, devices: [{ name: "other-service" }] }), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("launcher control accepts legacy local calls but rejects browser cross-site and spoofed sources", () => {
  assert.equal(isTrustedControlRequest(controlRequest()), true);
  assert.equal(isTrustedControlRequest(controlRequest({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" })), true);
  assert.equal(isTrustedControlRequest(controlRequest({ origin: "https://evil.example" })), false);
  assert.equal(isTrustedControlRequest(controlRequest({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isTrustedControlRequest(controlRequest({ origin: "null" })), false);
  assert.equal(isTrustedControlRequest(controlRequest({ host: "evil.example" })), false);
  assert.equal(isTrustedControlRequest(controlRequest({}, "192.0.2.10")), false);
});

test("kill candidate verification probes between stable listener snapshots", async () => {
  const events = [];
  const pids = await comfyListenerPidsForKill("http://127.0.0.1:8188", {
    listeners: () => {
      events.push("listeners");
      return ["42"];
    },
    probe: async () => {
      events.push("probe");
      return true;
    },
  });
  assert.deepEqual(pids, ["42"]);
  assert.deepEqual(events, ["listeners", "probe", "listeners"]);

  await assert.rejects(
    comfyListenerPidsForKill("http://127.0.0.1:8188", {
      listeners: () => ["42"],
      probe: async () => false,
    }),
    (error) => error.status === 409 && /身份复核/.test(error.message),
  );

  let snapshot = 0;
  await assert.rejects(
    comfyListenerPidsForKill("http://127.0.0.1:8188", {
      listeners: () => [snapshot++ === 0 ? "42" : "43"],
      probe: async () => true,
    }),
    (error) => error.status === 409 && /发生变化/.test(error.message),
  );
});
