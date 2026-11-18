import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Empty, Modal, Popconfirm, Select, Spin, Tag } from "antd";
import { FileJson, FolderOpen } from "lucide-react";

import { CustomWorkflowGraphPanel } from "@/components/layout/custom-workflow-import-panels";
import { CustomWorkflowBubblePanel } from "@/components/layout/custom-workflow-bubble-panel";
import { CustomWorkflowT2iPanel } from "@/components/layout/custom-workflow-t2i-panel";
import { createWorkflowField, isSpecialWorkflowInput, suggestWorkflowFields } from "@/lib/canvas/custom-workflow-fields";
import { deleteFreeWorkflow, fetchFreeWorkflowGraph, fetchFreeWorkflowSources, importFreeWorkflow, importUploadedFreeWorkflow, saveFreeWorkflowParams, type FreeWorkflowGraph, type FreeWorkflowGraphInput, type FreeWorkflowGraphNode, type FreeWorkflowParam, type FreeWorkflowSource, type FreeWorkflowSummary } from "@/services/api/free-workflow";
import {
    customWorkflowModeLabels,
    customWorkflowModeOptions,
    defaultCustomWorkflowTemplate,
    useCustomWorkflowStore,
    type CustomWorkflowKind,
    type CustomWorkflowMode,
    type CustomWorkflowSpan,
} from "@/stores/use-custom-workflow-store";
import type { AiConfig } from "@/stores/use-config-store";

type CustomWorkflowImportDialogProps = {
    open: boolean;
    config: AiConfig;
    onClose: () => void;
};

const KIND_OPTIONS: Array<{ value: CustomWorkflowKind; label: string; hint: string }> = [
    { value: "image", label: "生图", hint: "输出图片" },
    { value: "video", label: "生视频", hint: "输出视频" },
    { value: "other", label: "其他", hint: "需要适配或安装" },
];

export function CustomWorkflowImportDialog({ open, config, onClose }: CustomWorkflowImportDialogProps) {
    const { message } = App.useApp();
    const workflows = useCustomWorkflowStore((state) => state.workflows);
    const removeWorkflow = useCustomWorkflowStore((state) => state.removeWorkflow);
    const setCustomWorkflowEnabled = useCustomWorkflowStore((state) => state.setEnabled);
    const visibleWorkflows = workflows.filter((workflow) => !workflow.snapshot);
    const [sources, setSources] = useState<FreeWorkflowSource[]>([]);
    const [source, setSource] = useState("");
    const [loading, setLoading] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanned, setScanned] = useState<FreeWorkflowSummary | null>(null);
    const [kind, setKind] = useState<CustomWorkflowKind | null>(null);
    const [mode, setMode] = useState<CustomWorkflowMode | null>(null);
    const [template, setTemplate] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [manualOpen, setManualOpen] = useState(false);
    const [manualFiles, setManualFiles] = useState<Array<{ path: string; file: File }>>([]);
    const [manualPick, setManualPick] = useState("");
    const [manualImporting, setManualImporting] = useState(false);
    const [workspaceOpen, setWorkspaceOpen] = useState(false);
    const manualFolderRef = useRef<HTMLInputElement>(null);
    const manualFileRef = useRef<HTMLInputElement>(null);
    const kindTouchedRef = useRef(false);
    const modeTouchedRef = useRef(false);
    const scanSeqRef = useRef(0);
    const lastScanSourceRef = useRef("");
    const skipAutoScanRef = useRef("");

    useEffect(() => {
        manualFolderRef.current?.setAttribute("webkitdirectory", "");
        manualFolderRef.current?.setAttribute("directory", "");
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setError("");
        setScanned(null);
        setSource("");
        setKind(null);
        setMode(null);
        setTemplate([]);
        setWorkspaceOpen(false);
        setManualOpen(false);
        setManualFiles([]);
        setManualPick("");
        setManualImporting(false);
        kindTouchedRef.current = false;
        modeTouchedRef.current = false;
        scanSeqRef.current = 0;
        lastScanSourceRef.current = "";
        skipAutoScanRef.current = "";
        setLoading(true);
        fetchFreeWorkflowSources(config)
            .then((items) => setSources(items.filter((item) => item.format !== "invalid")))
            .catch((err) => setError(err instanceof Error ? err.message : "读取工作流列表失败"))
            .finally(() => setLoading(false));
    }, [config, open]);

    const options = useMemo(
        () => sources.map((item) => ({ value: item.relative, label: `${item.name}${item.folder ? ` · ${item.folder}` : ""}`, format: item.format })),
        [sources],
    );
    const selectKind = (nextKind: CustomWorkflowKind) => {
        const nextMode = nextKind === "other" ? "generic" : nextKind === "image" ? "t2i" : "text";
        setKind(nextKind);
        setMode(nextMode);
        setTemplate(defaultCustomWorkflowTemplate(nextKind, nextMode));
        kindTouchedRef.current = true;
        modeTouchedRef.current = nextKind === "other";
    };
    const selectMode = (nextMode: CustomWorkflowMode) => {
        setMode(nextMode);
        setTemplate(defaultCustomWorkflowTemplate(kind || "image", nextMode));
        modeTouchedRef.current = true;
    };
    const scanSource = async (relative: string) => {
        const request = ++scanSeqRef.current;
        setScanning(true);
        setError("");
        setScanned(null);
        setWorkspaceOpen(false);
        try {
            const workflow = await importFreeWorkflow(config, relative);
            if (request !== scanSeqRef.current) return;
            setScanned(workflow);
            const nextKind = kindTouchedRef.current && kind ? kind : workflow.kind || kind || "image";
            const nextMode = modeTouchedRef.current && mode ? mode : workflow.mode || mode || (nextKind === "image" ? "t2i" : nextKind === "video" ? "text" : "generic");
            if (!kindTouchedRef.current) setKind(nextKind);
            if (!modeTouchedRef.current) setMode(nextMode);
            if (!kindTouchedRef.current || !modeTouchedRef.current) setTemplate(defaultCustomWorkflowTemplate(nextKind, nextMode));
            setWorkspaceOpen(true);
        } catch (err) {
            if (request !== scanSeqRef.current) return;
            setError(err instanceof Error ? err.message : "扫描工作流失败");
        } finally {
            if (request === scanSeqRef.current) setScanning(false);
        }
    };
    useEffect(() => {
        if (!open || !source) return;
        if (skipAutoScanRef.current === source) {
            skipAutoScanRef.current = "";
            return;
        }
        if (lastScanSourceRef.current === source) return;
        lastScanSourceRef.current = source;
        void scanSource(source);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, source]);

    const pickManualFiles = (files: FileList | null) => {
        const picked = Array.from(files || [])
            .filter((file) => /\.json$/i.test(file.name))
            .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
            .sort((a, b) => a.path.localeCompare(b.path));
        setManualFiles(picked);
        setManualPick(picked[0]?.path || "");
        if (!picked.length) setError("这个文件夹里没有 .json 工作流");
        else setError("");
    };
    const importManual = async () => {
        const target = manualFiles.find((item) => item.path === manualPick);
        if (!target) return;
        setManualImporting(true);
        setError("");
        try {
            const workflow = await importUploadedFreeWorkflow(config, target.file.name, await target.file.text());
            setScanned(workflow);
            skipAutoScanRef.current = workflow.sourceRel;
            setSource(workflow.sourceRel);
            setSources((prev) =>
                prev.some((item) => item.relative === workflow.sourceRel)
                    ? prev
                    : [...prev, { id: workflow.sourceRel, name: workflow.name, folder: "_manual", relative: workflow.sourceRel, format: workflow.sourceFormat, updatedAt: workflow.updatedAt }],
            );
            const nextKind = kindTouchedRef.current && kind ? kind : workflow.kind || kind || "image";
            const nextMode = modeTouchedRef.current && mode ? mode : workflow.mode || mode || (nextKind === "image" ? "t2i" : nextKind === "video" ? "text" : "generic");
            if (!kindTouchedRef.current) setKind(nextKind);
            if (!modeTouchedRef.current) setMode(nextMode);
            if (!kindTouchedRef.current || !modeTouchedRef.current) setTemplate(defaultCustomWorkflowTemplate(nextKind, nextMode));
            setWorkspaceOpen(true);
            setManualOpen(false);
            message.success(`已导入手动选择的工作流，并保存到 ComfyUI 工作流目录：${workflow.sourceRel}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "手动导入工作流失败");
        } finally {
            setManualImporting(false);
        }
    };
    const remove = async (id: string, freeId: string) => {
        removeWorkflow(id);
        await deleteFreeWorkflow(config, freeId).catch(() => undefined);
        message.success("已删除自选工作流");
    };
    const selectedModeOptions = kind ? customWorkflowModeOptions(kind) : [];
    const suggestion = scanned?.kind && scanned?.mode ? { kind: scanned.kind, mode: scanned.mode } : null;
    const suggestionDiffers = Boolean(suggestion && (suggestion.kind !== kind || suggestion.mode !== mode));

    return (
        <>
            <Modal open={open} onCancel={onClose} footer={null} width={920} title="自选工作流" styles={{ body: { maxHeight: "80vh", overflowY: "auto" } }}>
                <div className="space-y-3 text-sm">
                    <div className="text-xs leading-5 text-stone-500">选择工作流后自动扫描，扫描完会打开独立的配置窗口；左侧是节点图，右侧是参数披露。</div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            showSearch
                            value={source || undefined}
                            loading={loading}
                            options={options}
                            optionFilterProp="label"
                            onChange={(value) => {
                                setSource(value);
                                lastScanSourceRef.current = "";
                                setScanned(null);
                                setKind(null);
                                setMode(null);
                                setTemplate([]);
                                setWorkspaceOpen(false);
                                kindTouchedRef.current = false;
                                modeTouchedRef.current = false;
                                setError("");
                            }}
                            placeholder="选择工作流"
                            className="min-w-[420px] flex-1"
                        />
                        <span className="text-[11px] text-stone-400 dark:text-stone-500">{scanning ? "正在自动扫描…" : "选中后自动扫描"}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] text-stone-400 dark:text-stone-500">扫描不到工作流？可以直接指定本地文件夹。</span>
                        <Button size="small" type="text" icon={<FolderOpen className="size-3.5" />} onClick={() => setManualOpen((current) => !current)}>手动指定文件夹</Button>
                    </div>
                    {manualOpen ? (
                        <div className="space-y-2 rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                            <input ref={manualFolderRef} type="file" multiple className="hidden" onChange={(event) => { pickManualFiles(event.target.files); event.currentTarget.value = ""; }} />
                            <input ref={manualFileRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => { pickManualFiles(event.target.files); event.currentTarget.value = ""; }} />
                            <div className="flex flex-wrap items-center gap-2">
                                <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={() => manualFolderRef.current?.click()}>选择文件夹</Button>
                                <Button size="small" icon={<FileJson className="size-3.5" />} onClick={() => manualFileRef.current?.click()}>选择单个 JSON</Button>
                                {manualFiles.length ? <Select showSearch optionFilterProp="label" value={manualPick || undefined} options={manualFiles.map((item) => ({ value: item.path, label: item.path }))} onChange={setManualPick} placeholder="选择要导入的工作流" className="min-w-[240px] flex-1" /> : null}
                                <Button type="primary" size="small" loading={manualImporting} disabled={!manualPick || manualImporting} onClick={() => void importManual()}>导入并扫描</Button>
                            </div>
                            <div className="text-[11px] leading-4 text-stone-500 dark:text-stone-400">{manualFiles.length ? `文件夹里有 ${manualFiles.length} 个 JSON 工作流。` : "导入时会复制到 ComfyUI 工作流目录的 _manual 子目录。"}</div>
                        </div>
                    ) : null}
                    <div className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                        <div className="mb-2 text-xs font-medium text-stone-500">这是什么工作流？</div>
                        <div className="flex flex-wrap gap-2">
                            {KIND_OPTIONS.map((option) => (
                                <button key={option.value} type="button" className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${kind === option.value ? "border-stone-500 bg-stone-700 text-white shadow-sm" : "border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"}`} style={kind === option.value ? { backgroundColor: "#44403c", borderColor: "#78716c", color: "#ffffff" } : { backgroundColor: "transparent" }} onClick={() => selectKind(option.value)}>
                                    {option.label}<span className={`ml-1.5 text-[10px] ${kind === option.value ? "opacity-70" : "text-stone-400"}`}>{option.hint}</span>
                                </button>
                            ))}
                        </div>
                        {kind ? (
                            <div className="mt-2.5 flex flex-wrap gap-2">
                                {selectedModeOptions.map((option) => (
                                    <button key={option.value} type="button" className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${mode === option.value ? "border-stone-500 bg-stone-700 text-white shadow-sm" : "border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"}`} style={mode === option.value ? { backgroundColor: "#44403c", borderColor: "#78716c", color: "#ffffff" } : { backgroundColor: "transparent" }} onClick={() => selectMode(option.value)}>
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {suggestionDiffers && suggestion ? (
                            <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">扫描建议：{suggestion.kind === "image" ? "生图" : suggestion.kind === "video" ? "生视频" : "其他"} · {customWorkflowModeLabels[suggestion.mode]}<button type="button" className="ml-1.5 underline" onClick={() => { setKind(suggestion.kind); setMode(suggestion.mode); setTemplate(defaultCustomWorkflowTemplate(suggestion.kind, suggestion.mode)); kindTouchedRef.current = true; modeTouchedRef.current = true; }}>应用建议</button></div>
                        ) : null}
                        {kind === "other" ? <Alert className="mt-2.5" type="warning" showIcon message="其他类型可能需要适配" description="请用内置 Agent 的开发者模式帮助安装/适配工作流；适配完成后重新扫描再归类。" /> : null}
                    </div>
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {scanning ? (
                        <div className="flex justify-center rounded-xl border border-stone-200 py-8 dark:border-stone-800"><Spin /></div>
                    ) : scanned ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/30 px-3 py-2 dark:border-emerald-900/60 dark:bg-emerald-950/10">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-medium">{scanned.name}</div>
                                <div className="text-[11px] text-stone-500">{kind ? `${KIND_OPTIONS.find((option) => option.value === kind)?.label} · ${mode ? customWorkflowModeLabels[mode] : ""}` : "已扫描"}</div>
                            </div>
                            <Button type="primary" size="small" onClick={() => setWorkspaceOpen(true)}>打开配置窗口</Button>
                        </div>
                    ) : (
                        <div className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-xs text-stone-400 dark:border-stone-700 dark:text-stone-500">选择一个工作流，自动扫描并打开配置窗口</div>
                    )}
                    <details className="border-t border-stone-200 pt-3 dark:border-stone-800">
                        <summary className="cursor-pointer text-xs font-medium text-stone-500">已添加的自选工作流（{visibleWorkflows.length}）</summary>
                        <div className="mt-2 max-h-40 overflow-y-auto pr-1">
                            {visibleWorkflows.length ? (
                                <div className="space-y-1.5">
                                    {visibleWorkflows.map((workflow) => {
                                        const enabled = workflow.enabled !== false;
                                        const problemCount = workflow.flows?.length
                                            ? workflow.flows.reduce((sum, flow) => sum + (flow.problems?.length || 0), 0)
                                            : workflow.problems?.length || 0;
                                        return (
                                            <div key={workflow.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm">{workflow.name}</div>
                                                    <div className="truncate text-[11px] text-stone-500">{workflow.kind === "image" ? "生图" : workflow.kind === "video" ? "生视频" : "其他"} · {customWorkflowModeLabels[workflow.mode]} · {workflow.params.length} 个参数{problemCount ? ` · 问题 ${problemCount}` : ""}</div>
                                                </div>
                                                <div className="flex shrink-0 flex-col items-end gap-1">
                                                    <label className="flex cursor-pointer items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                                                        <Checkbox checked={enabled} onChange={(event) => setCustomWorkflowEnabled(workflow.id, event.target.checked)} />
                                                        <span className={enabled ? "text-emerald-600 dark:text-emerald-400" : ""}>{enabled ? "启用" : "未启用"}</span>
                                                    </label>
                                                    <Popconfirm title="删除这个自选工作流？" okText="删除" cancelText="取消" onConfirm={() => void remove(workflow.id, workflow.freeId)}>
                                                        <Button size="small" danger type="text" className="h-6 px-1 text-[10px]">删除</Button>
                                                    </Popconfirm>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有自选工作流" />}
                        </div>
                    </details>
                </div>
            </Modal>
            {scanned && kind && mode ? (
                <CustomWorkflowWorkspace
                    open={workspaceOpen}
                    config={config}
                    workflow={scanned}
                    kind={kind}
                    mode={mode}
                    template={template}
                    onClose={() => setWorkspaceOpen(false)}
                    onAdded={() => {
                        setWorkspaceOpen(false);
                        onClose();
                    }}
                />
            ) : null}
        </>
    );
}

type CustomWorkflowWorkspaceProps = {
    open: boolean;
    config: AiConfig;
    workflow: FreeWorkflowSummary;
    kind: CustomWorkflowKind;
    mode: CustomWorkflowMode;
    template: string[];
    onClose: () => void;
    onAdded: () => void;
};

function CustomWorkflowWorkspace({ open, config, workflow, kind, mode, template, onClose, onAdded }: CustomWorkflowWorkspaceProps) {
    const { message } = App.useApp();
    const addWorkflow = useCustomWorkflowStore((state) => state.addWorkflow);
    const [graph, setGraph] = useState<FreeWorkflowGraph | null>(null);
    const [graphLoading, setGraphLoading] = useState(false);
    const [fields, setFields] = useState<FreeWorkflowParam[]>([]);
    const [layout, setLayout] = useState<string[]>([]);
    const [spans, setSpans] = useState<Record<string, CustomWorkflowSpan>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const fieldsTouchedRef = useRef(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setGraph(null);
        setGraphLoading(true);
        setError("");
        fetchFreeWorkflowGraph(config, workflow.id)
            .then((nextGraph) => {
                if (cancelled) return;
                setGraph(nextGraph);
                const saved = workflow.params?.length ? workflow.params : nextGraph.params || [];
                fieldsTouchedRef.current = saved.length > 0;
                setFields(saved);
                setLayout(saved.map((field) => field.key));
                setSpans({});
            })
            .catch((err) => {
                if (!cancelled) setError(err instanceof Error ? err.message : "读取工作流节点失败");
            })
            .finally(() => {
                if (!cancelled) setGraphLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [config, open, workflow]);

    useEffect(() => {
        if (!open || !graph || fieldsTouchedRef.current) return;
        const suggested = suggestWorkflowFields(graph, mode);
        if (!suggested.length) return;
        setFields(suggested);
        setLayout(suggested.map((field) => field.key));
        setSpans({});
    }, [graph, mode, open]);

    const toggleField = (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput) => {
        fieldsTouchedRef.current = true;
        const existing = fields.find((field) => field.node === node.id && field.input === input.name);
        if (existing) {
            setFields((current) => current.filter((field) => field.key !== existing.key));
            setLayout((current) => current.filter((key) => key !== existing.key));
            setSpans((current) => {
                const next = { ...current };
                delete next[existing.key];
                return next;
            });
            return;
        }
        const field = { ...createWorkflowField(node, input) };
        setFields((current) => [...current, field]);
        setLayout((current) => [...current, field.key]);
        setSpans((current) => ({ ...current, [field.key]: { w: 1, h: 1 } }));
    };
    const updateField = (key: string, patch: Partial<FreeWorkflowParam>) => {
        fieldsTouchedRef.current = true;
        setFields((current) => current.map((field) => (field.key === key ? { ...field, ...patch } : field)));
    };
    const removeField = (key: string) => {
        fieldsTouchedRef.current = true;
        setFields((current) => current.filter((field) => field.key !== key));
        setLayout((current) => current.filter((item) => item !== key));
        setSpans((current) => {
            const next = { ...current };
            delete next[key];
            return next;
        });
    };
    const reorderField = (key: string, index: number) => {
        fieldsTouchedRef.current = true;
        setLayout((current) => {
            if (!current.includes(key)) return current;
            const next = current.filter((item) => item !== key);
            const target = Math.max(0, Math.min(index, next.length));
            next.splice(target, 0, key);
            return next;
        });
    };
    const changeSpan = (key: string, span: CustomWorkflowSpan) => setSpans((current) => ({ ...current, [key]: span }));
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
        fieldsTouchedRef.current = true;
        const field = createWorkflowField(node, input);
        setFields((current) => (current.some((item) => item.key === field.key) ? current : [...current, field]));
        setLayout((current) => {
            const next = current.filter((key) => key !== field.key);
            const target = Math.max(0, Math.min(index, next.length));
            next.splice(target, 0, field.key);
            return next;
        });
        setSpans((current) => ({ ...current, [field.key]: current[field.key] || { w: 1, h: 1 } }));
        return field.key;
    };
    const add = async () => {
        setSaving(true);
        setError("");
        try {
            await saveFreeWorkflowParams(config, workflow.id, fields);
            addWorkflow(workflow, { kind, mode, template, params: fields, layout, spans });
            message.success(`已添加自选工作流「${workflow.name}」，默认启用`);
            onAdded();
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存参数失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal open={open} onCancel={onClose} footer={null} width="92vw" title={`配置 · ${workflow.name}`} style={{ top: 16, maxWidth: "92vw" }} styles={{ body: { height: "calc(100vh - 112px)", overflow: "hidden", padding: 16 } }}>
            <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <Tag>{kind === "image" ? "生图" : kind === "video" ? "生视频" : "其他"} · {customWorkflowModeLabels[mode]}</Tag>
                    <span>提示词、画幅、分辨率、尺寸、张数、种子由主卡接管；这里只暴露步数、CFG、降噪、采样器、LoRA 强度等特殊参数。点星标加入，右侧胶囊可拖动展开。</span>
                </div>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {graph?.problems?.length ? (
                    <div className="space-y-1 text-[11px] leading-4 text-red-600 dark:text-red-400">
                        {graph.problems.map((problem, index) => (
                            <div key={`${problem.node}-${problem.input}-${index}`}>
                                #{problem.node} {problem.title}
                                {problem.input ? ` · ${problem.input}` : ""}：{problem.reason}
                            </div>
                        ))}
                    </div>
                ) : null}
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_390px]">
                    <CustomWorkflowGraphPanel graph={graph} loading={graphLoading} fields={fields} onToggleField={toggleField} problems={graph?.problems} />
                    {kind === "image" && mode === "t2i" ? (
                        <CustomWorkflowT2iPanel config={config} fields={fields} layout={layout} spans={spans} availableInputs={availableInputs} onAddInput={addInputAt} onRemoveField={removeField} onUpdateField={updateField} onReorderField={reorderField} onSpanChange={changeSpan} />
                    ) : (
                        <CustomWorkflowBubblePanel fields={fields} layout={layout} spans={spans} availableInputs={availableInputs} onAddInput={addInputAt} onRemoveField={removeField} onUpdateField={updateField} onReorderField={reorderField} onSpanChange={changeSpan} />
                    )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
                    <span className="text-[11px] text-stone-400 dark:text-stone-500">参数会写回主卡设置；标准尺寸/张数/种子仍在主卡原有设置里。</span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>返回选择</Button>
                        <Button type="primary" loading={saving} onClick={() => void add()} disabled={!template.length && !fields.length}>添加到主卡片</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
