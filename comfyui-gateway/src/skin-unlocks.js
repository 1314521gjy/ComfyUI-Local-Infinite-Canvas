import fsp from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "skin-unlocks.json";
const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function normalizeSkinId(value) {
  return String(value || "").trim().toLowerCase();
}

export function createSkinUnlockStore({ dataDir, logger } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  const unlocked = new Map();

  async function load() {
    try {
      const raw = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      const items = Array.isArray(raw?.unlocked) ? raw.unlocked : [];
      for (const item of items) {
        const skinId = normalizeSkinId(typeof item === "string" ? item : item?.skinId);
        if (!SKIN_ID_PATTERN.test(skinId)) continue;
        const unlockedAt = typeof item === "object" && item?.unlockedAt ? String(item.unlockedAt) : new Date().toISOString();
        unlocked.set(skinId, { skinId, unlockedAt });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn(`读取皮肤解锁记录失败：${error.message}`);
    }
    return list();
  }

  function list() {
    return [...unlocked.keys()];
  }

  function entries() {
    return [...unlocked.values()];
  }

  function isUnlocked(skinId) {
    return unlocked.has(normalizeSkinId(skinId));
  }

  async function persist() {
    await fsp.mkdir(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ version: 1, unlocked: entries() }, null, 2), "utf8");
    await fsp.rename(temp, file);
  }

  async function unlock(value) {
    const skinId = normalizeSkinId(value);
    if (!SKIN_ID_PATTERN.test(skinId)) {
      const error = new Error("无效的皮肤 ID");
      error.status = 400;
      error.code = "invalid_skin_id";
      throw error;
    }
    if (!unlocked.has(skinId)) {
      const entry = { skinId, unlockedAt: new Date().toISOString() };
      unlocked.set(skinId, entry);
      await persist();
      return entry;
    }
    return unlocked.get(skinId);
  }

  return { load, list, entries, isUnlocked, unlock, file };
}
