import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_SOURCE = fileURLToPath(new URL("../comfyui-bridge/open-workflow.js", import.meta.url));
const BRIDGE_DIR = path.join("extensions", "local-canvas");
const BRIDGE_FILE = "open-workflow.js";
const FRONTEND_CANDIDATES = [
  path.join("python_embeded", "Lib", "site-packages", "comfyui_frontend_package", "static"),
  path.join("ComfyUI", "python_embeded", "Lib", "site-packages", "comfyui_frontend_package", "static"),
  "web",
  path.join("ComfyUI", "web"),
];

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function installRoots(config) {
  const roots = new Set();
  const add = (dir) => {
    if (!dir) return;
    roots.add(path.resolve(dir));
  };
  if (config.comfyDir) add(config.comfyDir);
  const workflows = normalize(config.comfyWorkflowsDir);
  for (const suffix of ["/ComfyUI/user/default/workflows", "/user/default/workflows"]) {
    if (!workflows.endsWith(suffix)) continue;
    const base = workflows.slice(0, -suffix.length);
    add(base);
    add(path.dirname(base));
    add(path.join(base, "ComfyUI"));
  }
  return [...roots];
}

function frontendCandidates(config) {
  const candidates = [];
  if (config.comfyFrontendDir) candidates.push(path.resolve(config.comfyFrontendDir));
  for (const root of installRoots(config)) {
    for (const relative of FRONTEND_CANDIDATES) candidates.push(path.join(root, relative));
  }
  return [...new Set(candidates)];
}

async function isFrontendDir(dir) {
  if (!dir) return false;
  try {
    await fsp.access(path.join(dir, "scripts", "app.js"));
    await fsp.access(path.join(dir, "index.html"));
    return true;
  } catch {
    return false;
  }
}

async function findFrontendDir(config) {
  for (const candidate of frontendCandidates(config)) {
    if (await isFrontendDir(candidate)) return candidate;
  }
  return "";
}

export function createComfyBridge({ config, logger } = {}) {
  let cached = null;
  let checkedAt = 0;
  let checking = null;

  async function install() {
    const frontendDir = await findFrontendDir(config);
    if (!frontendDir) {
      return {
        installed: false,
        reason: "未找到 ComfyUI 前端目录（可设置 COMFY_FRONTEND_DIR 或 comfyFrontendDir）",
      };
    }
    const targetDir = path.join(frontendDir, BRIDGE_DIR);
    const targetFile = path.join(targetDir, BRIDGE_FILE);
    const source = await fsp.readFile(BRIDGE_SOURCE, "utf8");
    let current = "";
    try {
      current = await fsp.readFile(targetFile, "utf8");
    } catch {
      // First install.
    }
    if (current !== source) {
      await fsp.mkdir(targetDir, { recursive: true });
      await fsp.writeFile(targetFile, source, "utf8");
      logger?.info?.(`已安装 ComfyUI 工作流桥接扩展：${targetFile}`);
    }
    return { installed: true, frontendDir, file: targetFile, updated: current !== source };
  }

  async function ensure({ force = false } = {}) {
    if (!force && cached && Date.now() - checkedAt < 60 * 1000) return cached;
    if (!checking) {
      checking = install()
        .then((result) => {
          cached = result;
          checkedAt = Date.now();
          return result;
        })
        .catch((error) => {
          logger?.warn?.(`安装 ComfyUI 工作流桥接失败：${error.message}`);
          return { installed: false, reason: error.message };
        })
        .finally(() => {
          checking = null;
        });
    }
    return checking;
  }

  return { ensure, findFrontendDir };
}
