import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickWorkflowDir, workflowDirCandidates } from "../src/workflow-dir.js";

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "workflow-dir-test-"));
}

test("derives the user workflow directory from comfyDir", async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workflows = path.join(root, "user", "default", "workflows");
  await fsp.mkdir(workflows, { recursive: true });
  await fsp.writeFile(path.join(workflows, "saved.json"), "{}");

  const candidates = workflowDirCandidates({ comfyDir: root });
  assert.equal(pickWorkflowDir(candidates), workflows);
});

test("infers the ComfyUI root from folder_paths when comfyDir is empty", async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const modelDir = path.join(root, "models", "diffusers");
  const workflows = path.join(root, "user", "default", "workflows");
  await fsp.mkdir(modelDir, { recursive: true });
  await fsp.mkdir(path.join(root, "custom_nodes"), { recursive: true });
  await fsp.mkdir(workflows, { recursive: true });
  await fsp.writeFile(path.join(workflows, "saved.json"), "{}");

  const candidates = workflowDirCandidates({ folderPaths: { diffusers: [modelDir] } });
  assert.equal(pickWorkflowDir(candidates), workflows);
});

test("prefers a populated fallback over an empty configured directory", async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const empty = path.join(root, "empty");
  const actual = path.join(root, "ComfyUI", "user", "default", "workflows");
  await fsp.mkdir(empty, { recursive: true });
  await fsp.mkdir(actual, { recursive: true });
  await fsp.writeFile(path.join(actual, "saved.json"), "{}");

  const candidates = workflowDirCandidates({ configured: empty, comfyDir: root });
  assert.equal(pickWorkflowDir(candidates), actual);
});

test("returns an empty string when nothing exists", async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const candidates = workflowDirCandidates({ configured: path.join(root, "missing"), comfyDir: root });
  assert.equal(pickWorkflowDir(candidates), "");
});
