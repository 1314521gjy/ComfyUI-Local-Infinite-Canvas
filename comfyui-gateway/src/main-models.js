import fsp from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./util.js";

const FILE_NAME = "main-models.json";

export function createMainModelStore({ dataDir, logger } = {}) {
    const storePath = path.join(dataDir, FILE_NAME);
    const packs = new Map();
    let workflowFiles = new Map();

    function rebuildIndex() {
        workflowFiles = new Map();
        for (const [packId, entry] of packs) {
            for (const workflowId of entry.workflows || []) workflowFiles.set(workflowId, entry.file);
        }
    }

    function snapshot() {
        return Object.fromEntries(
            [...packs].map(([packId, entry]) => [packId, { file: entry.file, workflows: [...(entry.workflows || [])] }])
        );
    }

    async function load() {
        try {
            const raw = JSON.parse((await fsp.readFile(storePath, "utf8")).replace(/^\uFEFF/, ""));
            for (const [packId, entry] of Object.entries(raw?.packs || {})) {
                const value = String(entry?.file || "").trim();
                if (!value) continue;
                packs.set(packId, {
                    file: value,
                    workflows: (Array.isArray(entry.workflows) ? entry.workflows : []).map(String).filter(Boolean),
                });
            }
            rebuildIndex();
        } catch (error) {
            if (error?.code !== "ENOENT") logger?.warn?.(`读取主模型选择失败：${error.message}`);
        }
        return snapshot();
    }

    function fileForPack(packId) {
        return packs.get(String(packId || ""))?.file || "";
    }

    function fileForWorkflow(workflowId) {
        return workflowFiles.get(String(workflowId || "")) || "";
    }

    async function set(packId, { file, workflows } = {}) {
        const id = String(packId || "").trim();
        if (!id) throw new Error("缺少功能包 ID");
        const value = String(file || "").trim();
        if (value) packs.set(id, { file: value, workflows: (workflows || []).map(String).filter(Boolean) });
        else packs.delete(id);
        rebuildIndex();
        await writeJsonAtomic(storePath, { version: 1, packs: snapshot(), updatedAt: new Date().toISOString() });
        return value;
    }

    return { load, fileForPack, fileForWorkflow, set, snapshot };
}
