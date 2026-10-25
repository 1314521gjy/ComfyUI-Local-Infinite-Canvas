import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { nowIso, randomId, safeFileName, writeJsonAtomic } from "./util.js";

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    object: "video",
    status: task.status,
    progress: task.progress,
    model: task.model,
    request: task.request,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    promptId: task.promptId || null,
    url: task.url || null,
    file: task.file || null,
    mimeType: task.mimeType || null,
    bytes: task.bytes || 0,
    error: task.error || null,
  };
}

export function createTaskStore({ dataDir, publicBaseUrl, logger, retentionDays = 0, maxTasks = 0 } = {}) {
  const tasks = new Map();
  const queue = [];
  const file = path.join(dataDir, "tasks.json");
  const outputDir = path.join(dataDir, "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  let running = false;
  let persistTimer = null;
  let loaded = false;

  function taskTime(task) {
    return Date.parse(task.completedAt || task.updatedAt || task.createdAt) || 0;
  }

  async function removeOutput(task) {
    if (!task?.file) return false;
    const resolved = path.resolve(task.file);
    const root = path.resolve(outputDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) return false;
    try {
      await fsp.unlink(resolved);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn?.(`删除输出文件失败：${error.message}`);
      return false;
    }
  }

  // 只清理终态任务；retentionDays / maxTasks 为 0 时保持现有行为，不删除任何记录。
  async function cleanup({ retentionDays: days = retentionDays, maxTasks: limit = maxTasks } = {}) {
    const terminal = [...tasks.values()].filter((task) => ["completed", "failed", "cancelled"].includes(task.status));
    const cutoff = days > 0 ? Date.now() - days * 86400000 : null;
    const drop = new Set();
    for (const task of terminal) {
      if (cutoff !== null && taskTime(task) < cutoff) drop.add(task.id);
    }
    if (limit > 0) {
      const oldest = terminal.filter((task) => !drop.has(task.id)).sort((a, b) => taskTime(a) - taskTime(b));
      while (tasks.size - drop.size > limit && oldest.length) drop.add(oldest.shift().id);
    }
    if (!drop.size) return { removed: 0, filesDeleted: 0 };
    let filesDeleted = 0;
    for (const id of drop) {
      if (await removeOutput(tasks.get(id))) filesDeleted += 1;
      tasks.delete(id);
    }
    await persistNow();
    logger?.info?.(`清理任务 ${drop.size} 个，删除输出文件 ${filesDeleted} 个`);
    return { removed: drop.size, filesDeleted };
  }

  async function persistNow() {
    const payload = { version: 1, updatedAt: nowIso(), tasks: [...tasks.values()].map(publicTask) };
    try {
      await writeJsonAtomic(file, payload);
    } catch (error) {
      logger?.warn?.(`保存任务失败：${error.message}`);
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, 250);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      for (const item of raw.tasks || []) {
        if (!item?.id) continue;
        const task = { ...item };
        // 旧版本任务记录没存 file；按 task id 在输出目录里找回，避免把已完成任务误判失败。
        if (!task.file) {
          const candidate = path.join(outputDir, `${task.id}.mp4`);
          if (fs.existsSync(candidate)) task.file = candidate;
        }
        if (task.file && fs.existsSync(task.file)) {
          task.url = task.url || `${publicBaseUrl}/files/${encodeURIComponent(path.basename(task.file))}`;
          if (task.status !== "completed") {
            task.status = "completed";
            task.progress = 1;
            task.error = null;
            task.completedAt = task.completedAt || nowIso();
          }
        } else if (task.status === "running" || task.status === "queued") {
          task.status = "failed";
          task.error = "网关在任务完成前重启";
          task.completedAt = nowIso();
        }
        if (task.status === "completed" && (!task.file || !fs.existsSync(task.file))) {
          task.status = "failed";
          task.error = "输出文件不存在";
          task.completedAt = nowIso();
        }
        tasks.set(task.id, task);
      }
      await persistNow();
    } catch {
      // 第一次运行没有 tasks.json。
    }
  }

  function get(id) {
    return tasks.get(id) || null;
  }

  function list() {
    return [...tasks.values()].map(publicTask).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function create({ model, request = {} } = {}) {
    const task = {
      id: randomId("task_"),
      object: "video",
      status: "queued",
      progress: 0,
      model,
      request,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      promptId: null,
      url: null,
      file: null,
      mimeType: null,
      bytes: 0,
      error: null,
    };
    tasks.set(task.id, task);
    void persistNow();
    return task;
  }

  function enqueue(task, run) {
    task._run = run;
    queue.push(task);
    void pump();
    return task;
  }

  async function pump() {
    if (running) return;
    const task = queue.shift();
    if (!task) return;
    running = true;
    const controller = new AbortController();
    task._controller = controller;
    try {
      task.status = "running";
      task.progress = 0.02;
      task.updatedAt = nowIso();
      schedulePersist();
      const result = await task._run(
        task,
        (event) => {
          const progress = typeof event === "number" ? event : event?.progress;
          if (Number.isFinite(progress)) task.progress = Math.max(task.progress || 0, progress);
          if (event?.promptId) task.promptId = event.promptId;
          task.updatedAt = nowIso();
          schedulePersist();
        },
        controller.signal,
      );
      if (task._cancelled) {
        task.status = "cancelled";
        task.error = "任务已取消";
      } else {
        const saved = await saveOutput(task.id, result.buffer, result.ext || "mp4");
        task.status = "completed";
        task.progress = 1;
        task.promptId = result.promptId || task.promptId;
        task.url = saved.url;
        task.file = saved.file;
        task.mimeType = result.mimeType || "video/mp4";
        task.bytes = result.buffer?.length || 0;
        task.completedAt = nowIso();
      }
    } catch (error) {
      task.status = task._cancelled || error?.code === "cancelled" ? "cancelled" : "failed";
      task.error = error?.message || String(error);
      task.completedAt = nowIso();
      logger?.warn?.(`任务 ${task.id} 失败：${task.error}`);
    } finally {
      delete task._run;
      delete task._controller;
      delete task._cancelled;
      task.updatedAt = nowIso();
      running = false;
      await persistNow();
      void pump();
    }
  }

  async function saveOutput(id, buffer, ext = "mp4") {
    const filename = `${id}.${safeFileName(ext).replace(/^\./, "") || "bin"}`;
    const target = path.join(outputDir, filename);
    await fsp.writeFile(target, buffer);
    return { file: target, url: `${publicBaseUrl}/files/${encodeURIComponent(filename)}`, bytes: buffer.length };
  }

  async function cancel(id, comfy) {
    const task = tasks.get(id);
    if (!task) return null;
    if (["completed", "failed", "cancelled"].includes(task.status)) return publicTask(task);
    task._cancelled = true;
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    task._controller?.abort();
    if (task.promptId && comfy) await (typeof comfy.cancel === "function" ? comfy.cancel(task.promptId) : comfy.interrupt(task.promptId));
    if (task.status === "queued") {
      task.status = "cancelled";
      task.error = "任务已取消";
      task.completedAt = nowIso();
      task.updatedAt = nowIso();
      await persistNow();
    }
    return publicTask(task);
  }

  function contentPath(id) {
    const task = tasks.get(id);
    if (!task?.file) return null;
    const resolved = path.resolve(task.file);
    const root = path.resolve(outputDir);
    return resolved.startsWith(`${root}${path.sep}`) && fs.existsSync(resolved) ? resolved : null;
  }

  return { load, create, enqueue, get, list, cancel, contentPath, publicTask, saveOutput, persistNow, cleanup };
}
