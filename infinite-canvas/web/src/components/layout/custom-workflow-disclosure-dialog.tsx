import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Modal } from "antd";

import { CustomWorkflowBubblePanel } from "@/components/layout/custom-workflow-bubble-panel";
import { CustomWorkflowGraphPanel } from "@/components/layout/custom-workflow-import-panels";
import { CustomWorkflowT2iPanel } from "@/components/layout/custom-workflow-t2i-panel";
import { createWorkflowField, isSpecialWorkflowInput } from "@/lib/canvas/custom-workflow-fields";
import { openWorkflowInComfyUI } from "@/lib/canvas/open-in-comfyui";
import { fetchFreeWorkflowGraph, saveFreeWorkflowParams, type FreeWorkflowGraph, type FreeWorkflowGraphInput, type FreeWorkflowGraphNode, type FreeWorkflowParam } from "@/services/api/free-workflow";
import { customWorkflowView, useCustomWorkflowStore, type CustomWorkflow, type CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";
import type { AiConfig } from "@/stores/use-config-store";

type CustomWorkflowDisclosureDialogProps = {
    open: boolean;
    config: AiConfig;
    workflow: CustomWorkflow;
    onClose: () => void;
};

export function CustomWorkflowDisclosureDialog({ open, config, workflow, onClose }: CustomWorkflowDisclosureDialogProps) {
    const { message } = App.useApp();
    const setParams = useCustomWorkflowStore((state) => state.setParams);
    const [graph, setGraph] = useState<FreeWorkflowGraph | null>(null);
    const [loading, setLoading] = useState(false);
    const [fields, setFields] = useState<FreeWorkflowParam[]>([]);
    const [layout, setLayout] = useState<string[]>([]);
    const [spans, setSpans] = useState<Record<string, CustomWorkflowSpan>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError("");
        fetchFreeWorkflowGraph(config, workflow.freeId)
            .then((nextGraph) => {
                if (cancelled) return;
                setGraph(nextGraph);
                const initial = workflow.params?.length ? workflow.params : nextGraph.params || [];
                setFields(initial);
                setLayout(initial.map((field) => field.key));
                setSpans(workflow.spans || {});
            })
            .catch((err) => {
                if (!cancelled) setError(err instanceof Error ? err.message : "读取工作流节点失败");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [config, open, workflow]);

    const availableInputs = useMemo(() => {
        if (!graph) return [] as Array<{ node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput }>;
        const existing = new Set(fields.map((field) => `${field.node}\u0000${field.input}`));
        const seen = new Set<string>();
        const result: Array<{ node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput }> = [];
        for (const node of graph.nodes) {
            for (const input of node.inputs) {
                const id = `${node.id}\u0000${input.name}`;
                if (seen.has(id) || existing.has(id) || !isSpecialWorkflowInput(node, input)) continue;
                seen.add(id);
                result.push({ node, input });
            }
        }
        return result;
    }, [fields, graph]);

    const addInputAt = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => {
        const field = createWorkflowField(node, input);
        setFields((current) => (current.some((item) => item.key === field.key) ? current : [...current, field]));
        setLayout((current) => {
            const next = current.filter((key) => key !== field.key);
            next.splice(Math.max(0, Math.min(index, next.length)), 0, field.key);
            return next;
        });
        setSpans((current) => ({ ...current, [field.key]: current[field.key] || { w: 1, h: 1 } }));
        return field.key;
    };
    const removeField = (key: string) => {
        setFields((current) => current.filter((field) => field.key !== key));
        setLayout((current) => current.filter((item) => item !== key));
        setSpans((current) => {
            const next = { ...current };
            delete next[key];
            return next;
        });
    };
    const updateField = (key: string, patch: Partial<FreeWorkflowParam>) => {
        setFields((current) => current.map((field) => (field.key === key ? { ...field, ...patch } : field)));
    };
    const reorderField = (key: string, index: number) => {
        setLayout((current) => {
            if (!current.includes(key)) return current;
            const next = current.filter((item) => item !== key);
            next.splice(Math.max(0, Math.min(index, next.length)), 0, key);
            return next;
        });
    };
    const changeSpan = (key: string, span: CustomWorkflowSpan) => setSpans((current) => ({ ...current, [key]: span }));
    const save = async () => {
        setSaving(true);
        setError("");
        try {
            await saveFreeWorkflowParams(config, workflow.freeId, fields);
            setParams(workflow.id, fields, layout, spans);
            message.success("参数披露已更新");
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存参数披露失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal open={open} onCancel={onClose} footer={null} width="92vw" title={`参数披露 · ${workflow.name}`} style={{ top: 16, maxWidth: "92vw" }} styles={{ body: { height: "calc(100vh - 112px)", overflow: "hidden", padding: 16 } }}>
            <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <span>左侧只读展示工作流；右侧拖拽特殊参数到标准面板，保存后主卡立即更新。</span>
                    {graph?.comfyUrl ? (
                        <a href={graph.comfyUrl} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openWorkflowInComfyUI(config, workflow.freeId).then((target) => { if (!target.bridge) message.warning(`ComfyUI 工作流桥未就绪：${target.bridgeReason || "请重启网关后重试"}`); else message.info(`已在 ComfyUI 打开「${target.name || workflow.name}」`); }).catch((error) => message.error(error instanceof Error ? error.message : "无法在 ComfyUI 中打开工作流")); }} className="ml-auto shrink-0 text-xs text-stone-500 underline-offset-2 hover:text-stone-800 hover:underline dark:text-stone-400 dark:hover:text-stone-100">
                            在 ComfyUI 打开此工作流
                        </a>
                    ) : null}
                </div>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {customWorkflowView(workflow).problems?.length ? (
                    <div className="space-y-1 text-[11px] leading-4 text-red-600 dark:text-red-400">
                        {customWorkflowView(workflow).problems?.map((problem, index) => (
                            <div key={`${problem.node}-${problem.input}-${index}`}>
                                #{problem.node} {problem.title}
                                {problem.input ? ` · ${problem.input}` : ""}：{problem.reason}
                            </div>
                        ))}
                    </div>
                ) : null}
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_390px]">
                    <CustomWorkflowGraphPanel graph={graph} loading={loading} fields={fields} onToggleField={() => undefined} interactive={false} panZoom problems={customWorkflowView(workflow).problems} />
                    {workflow.kind === "image" && workflow.mode === "t2i" ? (
                        <CustomWorkflowT2iPanel config={config} fields={fields} layout={layout} spans={spans} availableInputs={availableInputs} onAddInput={addInputAt} onRemoveField={removeField} onUpdateField={updateField} onReorderField={reorderField} onSpanChange={changeSpan} />
                    ) : (
                        <CustomWorkflowBubblePanel fields={fields} layout={layout} spans={spans} availableInputs={availableInputs} onAddInput={addInputAt} onRemoveField={removeField} onUpdateField={updateField} onReorderField={reorderField} onSpanChange={changeSpan} />
                    )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
                    <span className="text-[11px] text-stone-400 dark:text-stone-500">提示词、尺寸、画幅等标准参数仍由主卡接管。</span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" loading={saving} onClick={() => void save()}>保存</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
