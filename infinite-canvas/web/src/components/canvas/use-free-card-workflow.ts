import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";

import { ensureFreeCardWorkflowEntry, freeCardMetadataPatch } from "@/lib/canvas/free-card-workflow";
import { openWorkflowInComfyUI } from "@/lib/canvas/open-in-comfyui";
import {
    createFreeWorkflowSnapshot,
    fetchFreeWorkflow,
    fetchFreeWorkflowHealth,
    fetchFreeWorkflows,
    fetchFreeWorkflowSources,
    importFreeWorkflow,
    syncFreeWorkflow,
    type FreeWorkflowSource,
    type FreeWorkflowSummary,
} from "@/services/api/free-workflow";
import { customWorkflowLocalId, useCustomWorkflowStore } from "@/stores/use-custom-workflow-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

type UseFreeCardWorkflowOptions = {
    node: CanvasNodeData;
    config: AiConfig;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
};

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
}

export function useFreeCardWorkflow({ node, config, onChange }: UseFreeCardWorkflowOptions) {
    const { message } = App.useApp();
    const configRef = useRef(config);
    configRef.current = config;
    const info = node.metadata?.freeCard || null;
    const customWorkflow = useCustomWorkflowStore((state) => {
        const id = node.metadata?.model ? customWorkflowLocalId(node.metadata.model) : "";
        return id ? state.workflows.find((workflow) => workflow.id === id) || null : null;
    });
    const [sources, setSources] = useState<FreeWorkflowSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [sourcesError, setSourcesError] = useState("");
    const [summary, setSummary] = useState<FreeWorkflowSummary | null>(null);
    const [importing, setImporting] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [ensureError, setEnsureError] = useState("");
    const ensureKeyRef = useRef("");

    const loadSources = useCallback(async () => {
        setSourcesLoading(true);
        setSourcesError("");
        try {
            setSources(await fetchFreeWorkflowSources(configRef.current));
        } catch (error) {
            setSources([]);
            setSourcesError(errorMessage(error, "读取工作流列表失败"));
        } finally {
            setSourcesLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadSources();
    }, [loadSources]);

    const ensureFromInfo = useCallback(async () => {
        if (!info) return;
        setEnsureError("");
        try {
            const next = await fetchFreeWorkflow(configRef.current, info.id);
            setSummary(next);
            const { id } = await ensureFreeCardWorkflowEntry(next, { params: next.params || [] });
            const patch = freeCardMetadataPatch(next, id, false);
            if (info.healthWarnings?.length && patch.freeCard) patch.freeCard = { ...patch.freeCard, healthWarnings: info.healthWarnings };
            onChange(patch);
        } catch (error) {
            setEnsureError(errorMessage(error, "读取源工作流失败"));
        }
    }, [info?.id, onChange]);

    useEffect(() => {
        if (!info) return;
        const key = `${node.id}:${info.id}:${customWorkflow?.id || ""}`;
        if (ensureKeyRef.current === key) return;
        ensureKeyRef.current = key;
        void ensureFromInfo();
    }, [customWorkflow?.id, ensureFromInfo, info?.id, node.id]);

    const retryEnsure = useCallback(() => {
        ensureKeyRef.current = "";
        void ensureFromInfo();
    }, [ensureFromInfo]);

    const selectSource = useCallback(
        async (relative: string) => {
            if (!relative) return;
            setImporting(true);
            setEnsureError("");
            try {
                const existing = await fetchFreeWorkflows(configRef.current);
                const next = existing.find((workflow) => workflow.sourceRel === relative) || (await importFreeWorkflow(configRef.current, relative));
                if (next.outputType !== "image" && next.outputType !== "video") {
                    message.warning("自由卡片目前只接图片/视频工作流；其他请用标准卡");
                    return;
                }
                const { id } = await ensureFreeCardWorkflowEntry(next, { params: next.params || [] });
                let healthWarnings: string[] = [];
                try {
                    const health = await fetchFreeWorkflowHealth(configRef.current, next.id);
                    if (health.missingModels?.length) {
                        const names = health.missingModels.map((item) => item.value || item.node).slice(0, 3).join("、");
                        healthWarnings.push(`缺模型：${names}${health.missingModels.length > 3 ? ` 等 ${health.missingModels.length} 项` : ""}`);
                    }
                    if (health.missingNodes?.length) {
                        healthWarnings.push(`缺节点：${health.missingNodes.slice(0, 3).join("、")}${health.missingNodes.length > 3 ? ` 等 ${health.missingNodes.length} 个` : ""}`);
                    }
                } catch {
                    // 体检失败不阻断绑卡；生成前仍会由 ComfyUI 校验。
                }
                const patch = freeCardMetadataPatch(next, id, true);
                if (healthWarnings.length && patch.freeCard) patch.freeCard = { ...patch.freeCard, healthWarnings };
                onChange(patch);
                setSummary(next);
                if (healthWarnings.length) message.warning(healthWarnings.join("；"));
                else message.success("已选择自由卡工作流");
            } catch (error) {
                message.error(errorMessage(error, "切换自由卡工作流失败"));
            } finally {
                setImporting(false);
            }
        },
        [message, onChange],
    );

    const syncCard = useCallback(async () => {
        if (!info?.id) return;
        setSyncing(true);
        try {
            const result = await syncFreeWorkflow(configRef.current, info.id);
            setSummary(result.workflow);
            const { id } = await ensureFreeCardWorkflowEntry(result.workflow, { params: result.workflow.params || [] });
            useCustomWorkflowStore.getState().applySourceUpdate(id, result.workflow);
            onChange(freeCardMetadataPatch(result.workflow, id, false));
            message.success(result.changed ? "已同步源工作流" : "源工作流没有变化");
        } catch (error) {
            message.error(errorMessage(error, "同步自由卡工作流失败"));
        } finally {
            setSyncing(false);
        }
    }, [info?.id, message, onChange]);

    const archiveCard = useCallback(async () => {
        if (!info?.id || (info.archived && !info.snapshot)) return;
        const stored = useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.freeId === info.id);
        const card = {
            prompt: node.metadata?.prompt || "",
            customTexts: node.metadata?.customTexts || {},
            customTextActive: node.metadata?.customTextActive || "",
            size: node.metadata?.size || "",
            aspectRatio: node.metadata?.aspectRatio || "",
            count: node.metadata?.count ?? 1,
            seed: node.metadata?.seed || "",
            seedFixed: node.metadata?.seedFixed || "false",
        };
        setArchiving(true);
        try {
            const next = await createFreeWorkflowSnapshot(configRef.current, info.id, {
                name: info.name,
                config: stored ? { ...stored, flowId: stored.flowId || "", sourceRel: stored.sourceRel } : { flowId: "", textInputs: [], flows: [] },
                card,
                flowId: stored?.flowId || "",
                mode: stored?.mode,
            });
            if (stored) useCustomWorkflowStore.getState().addSnapshotWorkflow(next, stored);
            window.dispatchEvent(new Event("infinite-canvas:free-workflows-changed"));
            message.success("已归档自由卡工作流");
        } catch (error) {
            message.error(errorMessage(error, "归档自由卡工作流失败"));
        } finally {
            setArchiving(false);
        }
    }, [info?.archived, info?.id, info?.name, info?.snapshot, message, node.metadata?.aspectRatio, node.metadata?.count, node.metadata?.customTextActive, node.metadata?.customTexts, node.metadata?.prompt, node.metadata?.seed, node.metadata?.seedFixed, node.metadata?.size]);

    const openComfyUI = useCallback(async () => {
        if (!info?.id) return;
        try {
            const target = await openWorkflowInComfyUI(configRef.current, info.id);
            if (target.bridge) message.info(`已在 ComfyUI 打开「${target.name || info.name}」`);
            else message.warning(`ComfyUI 工作流桥未就绪：${target.bridgeReason || "请重启网关后重试"}`);
        } catch (error) {
            message.error(errorMessage(error, "无法在 ComfyUI 中打开自由卡工作流"));
        }
    }, [info?.id, info?.name, message]);

    const sourceMissing = Boolean(summary?.sourceMissing) || Boolean(ensureError);
    const warnings = [...(info?.warnings || []), ...(summary?.warnings || [])].filter((item, index, list) => list.indexOf(item) === index);

    return {
        info,
        summary,
        customWorkflow,
        sources,
        sourcesLoading,
        sourcesError,
        importing,
        syncing,
        archiving,
        ensureError,
        sourceMissing,
        sourceChanged: Boolean(summary?.sourceChanged),
        warnings,
        loadSources,
        selectSource,
        syncCard,
        archiveCard,
        openComfyUI,
        retryEnsure,
    };
}
