import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskStore } from "../src/tasks.js";

function tempStore(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-retention-"));
  const store = createTaskStore({ dataDir, publicBaseUrl: "http://127.0.0.1:8190", ...options });
  return { dataDir, store };
}

async function finishedTask(store, ageMs) {
  const task = store.create({ model: "test" });
  const saved = await store.saveOutput(task.id, Buffer.from("video"), "mp4");
  task.status = "completed";
  task.progress = 1;
  task.file = saved.file;
  task.url = saved.url;
  task.completedAt = new Date(Date.now() - ageMs).toISOString();
  task.updatedAt = task.completedAt;
  return task;
}

test("retention removes expired terminal tasks and their output files", async () => {
  const { dataDir, store } = tempStore();
  const oldTask = await finishedTask(store, 2 * 86400000);
  const freshTask = await finishedTask(store, 1000);
  const running = store.create({ model: "test" });
  running.status = "running";

  const result = await store.cleanup({ retentionDays: 1 });
  assert.deepEqual(result, { removed: 1, filesDeleted: 1 });
  assert.equal(store.get(oldTask.id), null);
  assert.equal(fs.existsSync(oldTask.file), false);
  assert.ok(store.get(freshTask.id));
  assert.ok(store.get(running.id));

  await store.persistNow();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("maxStoredTasks removes oldest terminal tasks first", async () => {
  const { dataDir, store } = tempStore();
  const first = await finishedTask(store, 3000);
  const second = await finishedTask(store, 2000);
  const third = await finishedTask(store, 1000);

  const result = await store.cleanup({ maxTasks: 2 });
  assert.deepEqual(result, { removed: 1, filesDeleted: 1 });
  assert.equal(store.get(first.id), null);
  assert.ok(store.get(second.id));
  assert.ok(store.get(third.id));

  await store.persistNow();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
