import { localForageStorage } from "@/lib/localforage-storage";
import type { FreeWorkflowSummary } from "@/services/api/free-workflow";
import { customWorkflowModelValue, normalizeCustomWorkflow, useCustomWorkflowStore, type CustomWorkflowAddOptions } from "@/stores/use-custom-workflow-store";
import type { CanvasFreeCardInfo, CanvasNodeData } from "@/types/canvas";

const STORE_KEY = "infinite-canvas:custom_workflow_store";

async function persistedWorkflows() {
    try {
        const raw = await localForageStorage.getItem(STORE_KEY);
        if (!raw) return null;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const workflows = parsed?.state?.workflows;
        return Array.isArray(workflows) ? workflows : null;
    } catch {
        return null;
    }
}

export function freeCardInfoFromSummary(summary: FreeWorkflowSummary): CanvasFreeCardInfo {
    return {
        id: summary.id,
        name: summary.name,
        sourceRel: summary.sourceRel,
        sourceFormat: summary.sourceFormat,
        outputType: summary.outputType === "video" ? "video" : summary.outputType === "image" ? "image" : "other",
        prompt: summary.prompt,
        imageInputs: summary.imageInputs,
        size: summary.size,
        aspectRatio: summary.aspectRatio,
        aspectRatios: summary.aspectRatios,
        count: summary.count,
        hasSeed: summary.hasSeed,
        seed: summary.seed,
        warnings: summary.warnings,
        archived: summary.archived,
        snapshot: summary.snapshot,
        snapshotPageLabel: summary.snapshotPageLabel,
        pageCount: summary.pageCount,
    };
}

/** 自由卡与主卡共用一条工作流设置；已有条目只取 id，不重置本地参数/块布局。 */
export async function ensureFreeCardWorkflowEntry(summary: FreeWorkflowSummary, options: CustomWorkflowAddOptions = {}) {
    // 工作流库存在 localforage，首屏比画布晚恢复；没恢复完就判断“不存在”会新建空条目，把用户参数冲掉。
    if (!useCustomWorkflowStore.persist.hasHydrated()) {
        await Promise.race([
            Promise.resolve(useCustomWorkflowStore.persist.rehydrate()).catch(() => undefined),
            new Promise<void>((resolve) => window.setTimeout(resolve, 10000)),
        ]);
    }
    const store = useCustomWorkflowStore.getState();
    const existing = store.workflows.find((workflow) => workflow.freeId === summary.id);
    if (existing) return { id: existing.id, existing: true };
    // 内存里还没恢复时，直接读持久化库，避免把已有条目再建一份空的。
    const saved = await persistedWorkflows();
    const persisted = saved?.find((workflow) => workflow?.freeId === summary.id);
    if (persisted) {
        const current = useCustomWorkflowStore.getState();
        if (!current.workflows.some((workflow) => workflow.id === persisted.id)) {
            // 连其余条目一起放回内存，随后的持久化写入仍是完整集合，不会只剩一条。
            const restored = (saved || []).map((workflow) => normalizeCustomWorkflow(workflow));
            const extra = current.workflows.filter((workflow) => !(saved || []).some((item) => item?.id === workflow.id));
            useCustomWorkflowStore.setState({ workflows: [...restored, ...extra] });
        }
        return { id: persisted.id, existing: true };
    }
    return { id: store.addWorkflow(summary, options), existing: false };
}

export function freeCardMetadataPatch(summary: FreeWorkflowSummary, customWorkflowId: string, resetSettings: boolean): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const card = freeCardInfoFromSummary(summary);
    const patch: Partial<NonNullable<CanvasNodeData["metadata"]>> = {
        freeCard: card,
        freeWorkflowId: summary.id,
        model: customWorkflowModelValue(customWorkflowId),
    };
    if (resetSettings) {
        patch.size = summary.size ? `${summary.size.width}x${summary.size.height}` : undefined;
        patch.aspectRatio = card.aspectRatio || "";
        patch.count = summary.count ?? 1;
        patch.seed = summary.seed || "";
    }
    return patch;
}
