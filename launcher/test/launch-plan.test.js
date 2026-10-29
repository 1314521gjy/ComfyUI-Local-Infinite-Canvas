import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { comfyInstallInfo, comfyPortCandidates, resolveLaunchPlan } from "../start.mjs";

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
