import fsp from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./util.js";

const FILE_NAME = "main-models.json";

export function createMainModelStore({ dataDir, logger } = {}) {
    const storePath = path.join(dataDir, FILE_NAME);
    const packs = new Map();
    // 单工作流覆盖优先于旧的“按包选择”；空字符串表示该工作流显式使用原底模。
    const workflowOverrides = new Map();
    let legacyWorkflowFiles = new Map();

    function rebuildIndex() {
        legacyWorkflowFiles = new Map();
        for (const [packId, entry] of packs) {
            for (const workflowId of entry.workflows || []) legacyWorkflowFiles.set(workflowId, entry.file);
        }
    }

    function snapshot() {
        return Object.fromEntries(
            [...packs].map(([packId, entry]) => [packId, { file: entry.file, workflows: [...(entry.workflows || [])] }])
        );
    }

    async function persist() {
        await writeJsonAtomic(storePath, {
            version: 2,
            packs: snapshot(),
            workflows: Object.fromEntries(workflowOverrides),
            updatedAt: new Date().toISOString(),
        });
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
            for (const [workflowId, file] of Object.entries(raw?.workflows || {})) {
                if (!workflowId) continue;
                workflowOverrides.set(String(workflowId), String(file || "").trim());
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
        const id = String(workflowId || "");
        if (workflowOverrides.has(id)) return workflowOverrides.get(id) || "";
        return legacyWorkflowFiles.get(id) || "";
    }

    async function set(packId, { file, workflows } = {}) {
        const id = String(packId || "").trim();
        if (!id) throw new Error("缺少功能包 ID");
        const value = String(file || "").trim();
        if (value) packs.set(id, { file: value, workflows: (workflows || []).map(String).filter(Boolean) });
        else packs.delete(id);
        rebuildIndex();
        await persist();
        return value;
    }

    async function setForWorkflow(workflowId, file) {
        const id = String(workflowId || "").trim();
        if (!id) throw new Error("缺少工作流 ID");
        workflowOverrides.set(id, String(file || "").trim());
        rebuildIndex();
        await persist();
        return workflowOverrides.get(id) || "";
    }

    return { load, fileForPack, fileForWorkflow, set, setForWorkflow, snapshot };
}
