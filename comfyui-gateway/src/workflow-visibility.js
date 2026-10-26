import fsp from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./util.js";

const FILE_NAME = "workflow-visibility.json";

export function createWorkflowVisibilityStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const hidden = new Set();

  async function load() {
    try {
      const raw = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      for (const id of Array.isArray(raw?.hidden) ? raw.hidden : []) {
        const key = String(id || "").trim();
        if (key) hidden.add(key);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.(`读取工作流启用状态失败：${error.message}`);
    }
    return list();
  }

  function list() {
    return [...hidden];
  }

  function isHidden(id) {
    return hidden.has(String(id || "").trim());
  }

  async function setHidden(id, value) {
    const key = String(id || "").trim();
    if (!key) throw new Error("缺少工作流 ID");
    if (value) hidden.add(key);
    else hidden.delete(key);
    await writeJsonAtomic(file, { version: 1, hidden: list(), updatedAt: new Date().toISOString() });
    return isHidden(key);
  }

  return { load, list, isHidden, setHidden };
}
