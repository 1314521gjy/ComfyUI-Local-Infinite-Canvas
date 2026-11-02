import fs from "node:fs";
import path from "node:path";

import { detectComfyLayout } from "./directories.js";
import { inferComfyRootFromFolderPaths } from "./resources.js";

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasJson(dir) {
  try {
    return fs.readdirSync(dir).some((name) => !name.startsWith(".") && name.toLowerCase().endsWith(".json"));
  } catch {
    return false;
  }
}

export function workflowDirCandidates({ configured = "", comfyDir = "", comfyRoot = "", folderPaths = {} } = {}) {
  const out = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!out.some((item) => item.toLowerCase() === resolved.toLowerCase())) out.push(resolved);
  };
  add(configured);
  for (const base of [comfyDir, comfyRoot].filter(Boolean)) {
    add(path.join(base, "user", "default", "workflows"));
    add(path.join(base, "ComfyUI", "user", "default", "workflows"));
    add(path.join(base, "resources", "ComfyUI", "user", "default", "workflows"));
    const layout = detectComfyLayout(base);
    if (layout?.workflowsDir) add(layout.workflowsDir);
  }
  const inferredRoot = inferComfyRootFromFolderPaths(folderPaths);
  if (inferredRoot) {
    add(path.join(inferredRoot, "user", "default", "workflows"));
    add(path.join(inferredRoot, "ComfyUI", "user", "default", "workflows"));
    const layout = detectComfyLayout(inferredRoot);
    if (layout?.workflowsDir) add(layout.workflowsDir);
  }
  return out;
}

export function pickWorkflowDir(candidates, { exists = isDir, populated = hasJson } = {}) {
  const dirs = (candidates || []).filter(exists);
  return dirs.find(populated) || dirs[0] || "";
}
