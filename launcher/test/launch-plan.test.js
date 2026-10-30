import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { browseHostFor, comfyInstallInfo, comfyPortCandidates, isLoopbackHost, listenCanvasServer, normalizeHost, probeAnyComfy, requestGatewayShutdown, resolveLaunchPlan } from "../start.mjs";

async function fake(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "launch-plan-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content || "");
  }
  return root;
}

test("desktop install launches the Electron exe", async () => {
  const dir = await fake({ "ComfyUI.exe": "", "resources/ComfyUI/main.py": "" });
  try {
    const info = comfyInstallInfo(dir);
    assert.ok(info, "desktop install should be recognized");
    const plan = resolveLaunchPlan(info);
    assert.equal(plan.kind, "desktop");
    assert.match(plan.file, /ComfyUI\.exe$/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("portable or integrated package launches python main.py directly", async () => {
  const dir = await fake({ "python_embeded/python.exe": "", "ComfyUI/main.py": "" });
  try {
    const info = comfyInstallInfo(dir);
    const plan = resolveLaunchPlan(info);
    assert.equal(plan.kind, "python");
    assert.match(plan.file, /python\.exe$/);
    assert.match(plan.mainPy, /main\.py$/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("falls back to a vendor bat, including oddly named ones that call main.py", async () => {
  const official = await fake({ "run_nvidia_gpu.bat": "python ComfyUI\main.py --listen 127.0.0.1" });
  const odd = await fake({ "ComfyUI/main.py": "", "整合包启动.bat": "python ComfyUI\main.py" });
  const unnamed = await fake({ "ComfyUI/main.py": "", "go.bat": "python ComfyUI\main.py" });
  try {
    assert.equal(resolveLaunchPlan(comfyInstallInfo(official)).kind, "script");
    assert.match(resolveLaunchPlan(comfyInstallInfo(odd)).file, /整合包启动\.bat$/);
    assert.match(resolveLaunchPlan(comfyInstallInfo(unnamed)).file, /go\.bat$/);
  } finally {
    for (const dir of [official, odd, unnamed]) await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("port candidates cover desktop 8000 and honor COMFY_PORT_SCAN", () => {
  const ports = comfyPortCandidates({ comfyUrl: "http://127.0.0.1:8188" });
  assert.ok(ports.includes(8188));
  assert.ok(ports.includes(8000), "desktop default port");
  assert.ok(ports.includes(7860));
  const previous = process.env.COMFY_PORT_SCAN;
  process.env.COMFY_PORT_SCAN = "9000-9002,9100";
  try {
    const scanned = comfyPortCandidates({ comfyUrl: "http://127.0.0.1:8188" });
    for (const port of [9000, 9001, 9002, 9100]) assert.ok(scanned.includes(port), `missing ${port}`);
  } finally {
    if (previous === undefined) delete process.env.COMFY_PORT_SCAN;
    else process.env.COMFY_PORT_SCAN = previous;
  }
});

test("dynamic probing finds ComfyUI on a non-standard port", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ system: { os: "nt" }, devices: [] }));
  });
  await new Promise((resolve) => server.listen(18123, "127.0.0.1", resolve));
  try {
    const hit = await probeAnyComfy([18122, 18123], 500);
    assert.ok(hit, "should find the stub");
    assert.match(hit.url, /:18123$/);
  } finally {
    server.close();
  }
});

test("finds the python bundled under an integration package's env/python directory", async () => {
  const dir = await fake({ "ComfyUI/main.py": "", "env/python/python.exe": "" });
  try {
    const info = comfyInstallInfo(dir);
    assert.ok(info, "integrated package should be recognized");
    assert.match(info.pythonExe.replaceAll("\\", "/"), /env\/python\/python\.exe$/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("host binding helpers keep loopback defaults and accept LAN hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(normalizeHost("http://192.168.1.10/"), "192.168.1.10");
  assert.equal(browseHostFor("0.0.0.0"), "127.0.0.1");
  assert.equal(browseHostFor("192.168.1.10"), "192.168.1.10");
});

test("canvas server falls back to a free port when 3000 is occupied", async () => {
  const http = await import("node:http");
  const blocker = http.createServer((_req, res) => res.end("occupied"));
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const occupied = blocker.address().port;
  try {
    const result = await listenCanvasServer({ canvasDist: os.tmpdir(), gatewayUrl: "http://127.0.0.1:8190", gatewayPort: 8190 }, occupied);
    try {
      assert.notEqual(result.port, occupied);
      assert.equal(result.port, occupied + 1);
    } finally {
      result.server.close();
    }
  } finally {
    blocker.close();
  }
});

test("gateway shutdown request posts to the local stop endpoint with the token", async () => {
  let captured;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured = { method: req.method, path: req.url, token: req.headers["x-gateway-token"], body: raw };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await requestGatewayShutdown(`http://127.0.0.1:${server.address().port}`, { token: "test-token" });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(captured.method, "POST");
    assert.equal(captured.path, "/api/system/shutdown");
    assert.equal(captured.token, "test-token");
    assert.equal(captured.body, "{}");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
