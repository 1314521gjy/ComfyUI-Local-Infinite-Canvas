import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Dropdown } from "antd";
import { ArrowLeft } from "lucide-react";
import localforage from "localforage";

import { buildRailItems, CustomWorkflowBlockList } from "@/components/layout/custom-workflow-block-editor";
import { CustomWorkflowGraphPanel } from "@/components/layout/custom-workflow-import-panels";
import { OptionPill } from "@/components/image-settings-panel";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { createWorkflowField, isSpecialWorkflowInput, reconcileWorkflowFields } from "@/lib/canvas/custom-workflow-fields";
import { openWorkflowInComfyUI } from "@/lib/canvas/open-in-comfyui";
import { fetchFreeWorkflowGraph, saveFreeWorkflowParams, type FreeWorkflowGraph, type FreeWorkflowGraphInput, type FreeWorkflowGraphNode, type FreeWorkflowParam } from "@/services/api/free-workflow";
import { customWorkflowModeLabels, customWorkflowModeOptions, customWorkflowView, defaultCustomWorkflowBlocks, useCustomWorkflowStore, type CustomWorkflow, type CustomWorkflowMode, type CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";
import type { AiConfig } from "@/stores/use-config-store";

const PAGE_MODE_ITEMS: Array<{ key: CustomWorkflowMode; label: string; hint: string }> = [
    { key: "t2i", label: "文生图", hint: "纯提示词生成，不需要参考图" },
    { key: "i2i", label: "图生图", hint: "需要连接参考图，按连线顺序写入" },
    { key: "edit", label: "局部编辑", hint: "需要原图与蒙版" },
];

type CustomWorkflowInlineDisclosureProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    workflow: CustomWorkflow;
    onClose: () => void;
};

// 节点图缓存：会话级 Map + localforage 持久化，保存后跨刷新秒开，不再重复扫描。整合流按页分开缓存。
// 带 sourceRevision：源文件被 ComfyUI 保存并由网关自动同步后，旧图缓存失效、重新扫描。
type GraphCacheEntry = { revision: number; graph: FreeWorkflowGraph };
const graphCache = new Map<string, GraphCacheEntry>();
const graphKey = (cacheId: string) => "custom-workflow-graph:11:" + cacheId;
const persistGraph = (cacheId: string, revision: number, graph: FreeWorkflowGraph) => {
    graphCache.set(cacheId, { revision, graph });
    void localforage.setItem(graphKey(cacheId), { revision, graph }).catch(() => undefined);
};

export function CustomWorkflowInlineDisclosure({ config, onConfigChange, workflow: rawWorkflow, onClose }: CustomWorkflowInlineDisclosureProps) {
    const theme = useCanvasTheme();
    const storedWorkflow = useCustomWorkflowStore((state) => state.workflows.find((item) => item.id === rawWorkflow.id));
    const workflow = useMemo(() => customWorkflowView(storedWorkflow || rawWorkflow), [storedWorkflow, rawWorkflow]);
    const pageId = rawWorkflow.flows && rawWorkflow.flows.length > 1 ? rawWorkflow.flowId || rawWorkflow.flows.find((flow) => flow.main)?.id || "" : "";
    const isMainPage = !pageId || Boolean(rawWorkflow.flows?.find((flow) => flow.id === pageId)?.main);
    const cacheId = isMainPage ? workflow.freeId : `${workflow.freeId}:${pageId}`;
    const revision = Number(workflow.sourceRevision) || 0;
    const { message } = App.useApp();
    const setParams = useCustomWorkflowStore((state) => state.setParams);
    const setTextSelection = useCustomWorkflowStore((state) => state.setTextSelection);
    const [graph, setGraph] = useState<FreeWorkflowGraph | null>(null);
    const [loading, setLoading] = useState(false);
    const [fields, setFields] = useState<FreeWorkflowParam[]>([]);
    const [layout, setLayout] = useState<string[]>([]);
    const [spans, setSpans] = useState<Record<string, CustomWorkflowSpan>>({});
    const [blocks, setBlocks] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [openFlowId, setOpenFlowId] = useState<string | null>(null);
    const [editingFlow, setEditingFlow] = useState<{ id: string; value: string } | null>(null);
    const configRef = useRef(config);
    configRef.current = config;
    const initRef = useRef("");
    // 切页时保留每页未保存的本地草稿，切回来不丢正在编辑的字段/块。
    const draftRef = useRef(new Map<string, { fields: FreeWorkflowParam[]; layout: string[]; spans: Record<string, CustomWorkflowSpan>; blocks: string[] }>());
    const draftStateRef = useRef({ fields, layout, spans, blocks });
    draftStateRef.current = { fields, layout, spans, blocks };
    const lastCacheRef = useRef("");
    const applyPageMode = (flowId: string, key: string) => {
        const store = useCustomWorkflowStore.getState();
        store.setPageMode(rawWorkflow.id, flowId, key as CustomWorkflowMode);
        store.setFlowId(rawWorkflow.id, flowId);
    };
    const modeKind = workflow.kind || (workflow.outputType === "video" ? "video" : "image");
    const modeOptions = customWorkflowModeOptions(modeKind);
    const setSingleMode = (nextMode: CustomWorkflowMode) => {
        useCustomWorkflowStore.getState().setPageMode(rawWorkflow.id, "", nextMode);
        message.success(`已切换为${customWorkflowModeLabels[nextMode] || nextMode}`);
    };

    useEffect(() => {
        if (lastCacheRef.current && lastCacheRef.current !== cacheId) {
            draftRef.current.set(lastCacheRef.current, { ...draftStateRef.current });
        }
        lastCacheRef.current = cacheId;
        const draft = draftRef.current.get(cacheId);
        const initKey = `${cacheId}@${revision}`;
        if (initRef.current === initKey) return;
        initRef.current = initKey;
        const token = initKey;
        setError("");
        const initial = draft?.fields?.length ? draft.fields : workflow.params?.length ? workflow.params : [];
        setLayout(draft?.layout || initial.map((field) => field.key));
        setSpans(draft?.spans || workflow.spans || {});
        setBlocks(draft?.blocks?.length ? draft.blocks : workflow.blocks?.length ? workflow.blocks : defaultCustomWorkflowBlocks(workflow.kind, initial, workflow.general, workflow.stages));
        const applyGraph = (nextGraph: FreeWorkflowGraph) => {
            if (initRef.current !== token) return;
            setGraph(nextGraph);
            setLoading(false);
            const base = draft?.fields?.length ? draft.fields : workflow.params?.length ? workflow.params : isMainPage ? nextGraph.params || [] : [];
            const reconciled = reconcileWorkflowFields(base, nextGraph);
            const restored = draft?.fields?.length
                ? draft.fields.map((field) => {
                      const fresh = reconciled.find((item) => item.key === field.key);
                      return fresh ? { ...fresh, ...field } : field;
                  })
                : reconciled;
            setFields(restored);
            // 补回来的类型/选项写回 store，设置面板里的同一批字段也立刻变成下拉。
            if (!draft?.fields?.length && base.length && reconciled.some((field, index) => field !== base[index])) {
                const fieldLayout = (workflow.blocks || []).filter((id) => id.startsWith("field:")).map((id) => id.slice("field:".length));
                useCustomWorkflowStore.getState().setParams(rawWorkflow.id, reconciled, fieldLayout, workflow.spans || {}, workflow.blocks || []);
            }
            if (!draft?.fields?.length && !workflow.params?.length) {
                const seed = isMainPage ? nextGraph.params || [] : [];
                setLayout(seed.map((field) => field.key));
                setBlocks(defaultCustomWorkflowBlocks(workflow.kind, seed, workflow.general, workflow.stages));
            }
        };
        // 旧字段可能是在 ComfyUI 未就绪时加的，没有类型和选项；这时不吃缓存，强制拉一次当前图。
        const needsOptionRefresh = (workflow.params || []).some((field) => !(field.options || []).length);
        const cached = graphCache.get(cacheId);
        if (!needsOptionRefresh && cached?.revision === revision) {
            applyGraph(cached.graph);
            return;
        }
        setLoading(true);
        void (async () => {
            try {
                const stored = await localforage.getItem<GraphCacheEntry>(graphKey(cacheId));
                if (!needsOptionRefresh && stored?.revision === revision && stored.graph?.nodes?.length) {
                    graphCache.set(cacheId, stored);
                    applyGraph(stored.graph);
                    return;
                }
            } catch {
                // 本地缓存不可用时回退到扫描
            }
            try {
                const nextGraph = await fetchFreeWorkflowGraph(configRef.current, workflow.freeId, isMainPage ? "" : pageId);
                const hasOptions = nextGraph.nodes.some((node) => node.inputs.some((input) => (input.options || []).length));
                if (!needsOptionRefresh || hasOptions) persistGraph(cacheId, revision, nextGraph);
                applyGraph(nextGraph);
            } catch (err) {
                if (initRef.current !== token) return;
                setError(err instanceof Error ? err.message : "读取工作流节点失败");
                setLoading(false);
            }
        })();
    }, [workflow, cacheId, revision, isMainPage, pageId]);

    const availableInputs = useMemo(() => {
        if (!graph) return [] as Array<{ node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput }>;
        const existing = new Set(fields.map((field) => `${field.node}\u0000${field.input}`));
        const selectedText = new Set(workflow.textSelection || []);
        const seen = new Set<string>();
        const result: Array<{ node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput }> = [];
        for (const node of graph.nodes) {
            for (const input of node.inputs) {
                const id = `${node.id}\u0000${input.name}`;
                if (seen.has(id) || existing.has(id) || selectedText.has(id) || !isSpecialWorkflowInput(node, input)) continue;
                seen.add(id);
                result.push({ node, input });
            }
        }
        return result;
    }, [fields, graph, workflow.textSelection]);

    const addInputAt = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => {
        const field = createWorkflowField(node, input);
        setFields((current) => (current.some((item) => item.key === field.key) ? current : [...current, field]));
        setLayout((current) => {
            const next = current.filter((key) => key !== field.key);
            next.splice(Math.max(0, Math.min(index, next.length)), 0, field.key);
            return next;
        });
        setSpans((current) => ({ ...current, [field.key]: current[field.key] || { w: field.type === "string" ? 2 : 1, h: 1 } }));
        return field.key;
    };
    const addInput = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => {
        const key = addInputAt(node, input, index);
        setBlocks((current) => {
            const blockId = `field:${key}`;
            if (current.includes(blockId)) return current;
            const next = [...current];
            next.splice(Math.max(0, Math.min(index, next.length)), 0, blockId);
            return next;
        });
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
    const toggleTextInput = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => {
        const key = `${node.id}\u0000${input.name}`;
        const current = workflow.textSelection || [];
        if (current.includes(key)) {
            setTextSelection(workflow.id, pageId, current.filter((item) => item !== key));
            return;
        }
        if (current.length >= 4) {
            message.warning("最多指定 4 个文本输入");
            return;
        }
        setTextSelection(workflow.id, pageId, [...current, key]);
        const field = fields.find((item) => item.node === node.id && item.input === input.name);
        if (field) removeField(field.key);
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
    const railItems = useMemo(() => buildRailItems(fields, blocks, availableInputs, workflow.general, workflow.stages), [availableInputs, blocks, fields, workflow.general, workflow.stages]);
    const addRail = (railId: string, index: number) => {
        if (railId.startsWith("setting:") || railId.startsWith("field:") || railId.startsWith("stage:")) {
            setBlocks((current) => {
                if (current.includes(railId)) return current;
                const next = [...current];
                next.splice(Math.max(0, Math.min(index, next.length)), 0, railId);
                return next;
            });
            return;
        }
        if (!railId.startsWith("input:")) return;
        const rest = railId.slice("input:".length);
        const split = rest.indexOf(":");
        if (split < 0) return;
        const nodeId = rest.slice(0, split);
        const inputName = rest.slice(split + 1);
        const item = availableInputs.find((candidate) => candidate.node.id === nodeId && candidate.input.name === inputName);
        if (!item) return;
        const field = createWorkflowField(item.node, item.input);
        setFields((current) => (current.some((existing) => existing.key === field.key) ? current : [...current, field]));
        setLayout((current) => (current.includes(field.key) ? current : [...current, field.key]));
        setSpans((current) => ({ ...current, [field.key]: current[field.key] || { w: 1, h: 1 } }));
        setBlocks((current) => {
            const blockId = `field:${field.key}`;
            if (current.includes(blockId)) return current;
            const next = [...current];
            next.splice(Math.max(0, Math.min(index, next.length)), 0, blockId);
            return next;
        });
    };
    const removeBlock = (blockId: string) => {
        // 字段定义保留在编辑态，× 只是收进竖栏；保存时只写活跃字段。
        setBlocks((current) => current.filter((item) => item !== blockId));
    };
    const moveBlock = (blockId: string, index: number) => {
        setBlocks((current) => {
            if (!current.includes(blockId)) return current;
            const next = current.filter((item) => item !== blockId);
            next.splice(Math.max(0, Math.min(index, next.length)), 0, blockId);
            return next;
        });
    };
    const updateFieldValue = (key: string, value: unknown) => {
        setFields((current) => current.map((field) => (field.key === key ? { ...field, value: value as FreeWorkflowParam["value"] } : field)));
    };
    const save = async () => {
        setSaving(true);
        setError("");
        try {
            const activeFields = fields.filter((field) => blocks.includes(`field:${field.key}`));
            const fieldLayout = blocks.filter((blockId) => blockId.startsWith("field:")).map((blockId) => blockId.slice("field:".length));
            // 网关端参数只服务主流程的生成；其他页的参数只存在本地页数据里，生成时随请求带上。
            if (isMainPage) await saveFreeWorkflowParams(config, workflow.freeId, activeFields);
            setParams(workflow.id, activeFields, fieldLayout, spans, blocks);
            draftRef.current.delete(cacheId);
            const cached = graphCache.get(cacheId);
            if (cached) persistGraph(cacheId, revision, { ...cached.graph, params: activeFields });
            message.success("参数披露已更新");
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存参数披露失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex items-center gap-2">
                <Button size="small" type="text" icon={<ArrowLeft className="size-4" />} onClick={onClose}>返回设置</Button>
                <span className="shrink-0 text-sm font-medium" title={workflow.name}>参数披露</span>
                {graph?.comfyUrl ? (
                    <a
                        href={graph.comfyUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                            event.preventDefault();
                            void openWorkflowInComfyUI(config, workflow.freeId)
                                .then((target) => {
                                    if (!target.bridge) message.warning(`ComfyUI 工作流桥未就绪：${target.bridgeReason || "请重启网关后重试"}`);
                                    else message.info(`已在 ComfyUI 打开「${target.name || workflow.name}」`);
                                })
                                .catch((error) => message.error(error instanceof Error ? error.message : "无法在 ComfyUI 中打开工作流"));
                        }}
                        className="ml-auto shrink-0 text-xs text-stone-500 underline-offset-2 hover:text-stone-800 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
                    >
                        在 ComfyUI 打开此工作流
                    </a>
                ) : null}
            </div>
            {(!rawWorkflow.flows || rawWorkflow.flows.length <= 1) && modeOptions.length > 1 ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 text-xs" style={{ color: theme.node.muted }}>生成方式</span>
                    {modeOptions.map((option) => (
                        <OptionPill key={option.value} selected={workflow.mode === option.value} theme={theme} onClick={() => setSingleMode(option.value)}>
                            {option.label}
                        </OptionPill>
                    ))}
                </div>
            ) : null}
            {rawWorkflow.flows && rawWorkflow.flows.length > 1 ? (
                <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                    {rawWorkflow.flows.map((flow, index) => {
                        const pageMode = rawWorkflow.pages?.[flow.id]?.mode || rawWorkflow.mode;
                        const typeLabel = customWorkflowModeLabels[pageMode] || pageMode;
                        const displayName = (rawWorkflow.flowNames?.[flow.id] || "").trim() || `工作流${index + 1}`;
                        const commitName = () => {
                            if (!editingFlow) return;
                            useCustomWorkflowStore.getState().setFlowName(rawWorkflow.id, editingFlow.id, editingFlow.value);
                            setEditingFlow(null);
                        };
                        return editingFlow?.id === flow.id ? (
                            <div key={flow.id} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-full border px-3 text-sm" style={{ borderColor: theme.node.text, color: theme.node.text }}>
                                <input
                                    autoFocus
                                    value={editingFlow.value}
                                    onFocus={(event) => event.currentTarget.select()}
                                    onChange={(event) => setEditingFlow({ id: flow.id, value: event.target.value })}
                                    onBlur={commitName}
                                    onClick={(event) => event.stopPropagation()}
                                    onDoubleClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            event.currentTarget.blur();
                                        } else if (event.key === "Escape") {
                                            event.preventDefault();
                                            setEditingFlow(null);
                                        }
                                    }}
                                    className="min-w-0 flex-1 bg-transparent text-center outline-none"
                                />
                                <span className="shrink-0 text-xs opacity-60">{`· ${typeLabel}`}</span>
                            </div>
                        ) : (
                            <div key={`${flow.id}:${pageMode}`} className="relative min-w-0">
                                <Dropdown
                                    trigger={[]}
                                    open={openFlowId === flow.id}
                                    onOpenChange={(next) => setOpenFlowId(next ? flow.id : null)}
                                    styles={{ root: { zIndex: 1500 } }}
                                    menu={{
                                        selectable: true,
                                        selectedKeys: [pageMode],
                                        items: PAGE_MODE_ITEMS.map((item) => ({ key: item.key, label: <span onClick={() => applyPageMode(flow.id, item.key)}>{item.label}</span> })),
                                        onClick: ({ key }) => applyPageMode(flow.id, key),
                                        onSelect: ({ key }) => applyPageMode(flow.id, key),
                                    }}
                                >
                                    <span
                                        className="block min-w-0 [&>button]:w-full"
                                        onDoubleClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setOpenFlowId(null);
                                            setEditingFlow({ id: flow.id, value: displayName });
                                        }}
                                    >
                                        <OptionPill
                                            selected={flow.id === pageId}
                                            theme={theme}
                                            onClick={() => {
                                                useCustomWorkflowStore.getState().setFlowId(rawWorkflow.id, flow.id);
                                                setOpenFlowId(flow.id);
                                            }}
                                        >
                                            <span className="block w-full truncate pr-14 text-center">{displayName}</span>
                                        </OptionPill>
                                    </span>
                                </Dropdown>
                                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs opacity-60">{`· ${typeLabel}`}</span>
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {rawWorkflow.flows && rawWorkflow.flows.length > 1 ? (
                <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                    {`${customWorkflowModeLabels[workflow.mode] || workflow.mode}：${PAGE_MODE_ITEMS.find((item) => item.key === workflow.mode)?.hint || "选择页签可切换生成方式"}`}
                </div>
            ) : null}
            {workflow.problems?.length ? (
                <div className="space-y-1 text-[11px] leading-4 text-red-600 dark:text-red-400">
                    {workflow.problems.map((problem, index) => (
                        <div key={`${problem.node}-${problem.input}-${index}`}>
                            #{problem.node} {problem.title}
                            {problem.input ? ` · ${problem.input}` : ""}：{problem.reason}
                        </div>
                    ))}
                </div>
            ) : null}
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
                <CustomWorkflowGraphPanel graph={graph} loading={loading} fields={fields} onToggleField={() => undefined} interactive={false} panZoom draggableInputs searchable problems={workflow.problems} textInputs={workflow.textInputs} textSelection={workflow.textSelection} textNames={workflow.textNames} textPrimary={workflow.primaryText} onToggleTextInput={toggleTextInput} />
                <CustomWorkflowBlockList config={config} onConfigChange={onConfigChange} fields={fields} values={{}} blocks={blocks} spans={spans} editable railItems={railItems} showTitle title={workflow.kind === "video" ? "视频设置" : "图像设置"} kind={workflow.kind === "video" ? "video" : "image"} onValueChange={updateFieldValue} onRemoveBlock={removeBlock} onMoveBlock={moveBlock} onAddRail={addRail} onAddInput={addInput} stages={workflow.stages} disabledStages={workflow.disabledStages} enabledGroups={workflow.enabledGroups} onToggleStage={(id, on) => { if (id.startsWith("group:")) { const groups = workflow.enabledGroups || []; useCustomWorkflowStore.getState().setEnabledGroups(workflow.id, on ? [...groups.filter((x) => x !== id), id] : groups.filter((x) => x !== id)); return; } const current = workflow.disabledStages || []; useCustomWorkflowStore.getState().setDisabledStages(workflow.id, on ? current.filter((x) => x !== id) : [...current, id]); }} />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
                <Button type="primary" loading={saving} onClick={() => void save()}>保存</Button>
            </div>
        </div>
    );
}
