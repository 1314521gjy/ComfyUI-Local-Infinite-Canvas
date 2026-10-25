import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createComfyBridge } from "../src/comfy-bridge.js";

test("comfy bridge installs the open-workflow extension into a detected frontend dir", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "comfy-bridge-"));
  try {
    await fsp.mkdir(path.join(root, "scripts"), { recursive: true });
    await fsp.writeFile(path.join(root, "scripts", "app.js"), "export const app = {};\n");
    await fsp.writeFile(path.join(root, "index.html"), "<html></html>\n");
    const bridge = createComfyBridge({ config: { comfyFrontendDir: root }, logger: { info() {} } });
    const result = await bridge.ensure({ force: true });
    assert.equal(result.installed, true);
    assert.equal(result.frontendDir, root);
    const source = await fsp.readFile(path.join(root, "extensions", "local-canvas", "open-workflow.js"), "utf8");
    assert.match(source, /LocalCanvas\.OpenWorkflow/);
    assert.match(source, /loadGraphData/);
    const second = await bridge.ensure({ force: true });
    assert.equal(second.updated, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
