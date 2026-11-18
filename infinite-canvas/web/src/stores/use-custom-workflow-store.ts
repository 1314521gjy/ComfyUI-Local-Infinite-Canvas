import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { syncFreeWorkflow, type FreeWorkflowParam, type FreeWorkflowPass, type FreeWorkflowProblem, type FreeWorkflowSelfLift, type FreeWorkflowSummary, type FreeWorkflowTextBinding, type FreeWorkflowTextInput } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";

export type CustomWorkflowKind = "image" | "video" | "other";
export type CustomWorkflowMode = "t2i" | "i2i" | "edit" | "text" | "frames" | "reference" | "generic";
export type CustomWorkflowSpan = { w: 1 | 2; h: 1 | 2 };

export type CustomWorkflow = {
    id: string;
    freeId: string;
    name: string;
    outputType: "image" | "video" | "other";
    kind: CustomWorkflowKind;
    mode: CustomWorkflowMode;
    enabled: boolean;
    template: string[];
    maskInputs: number;
    maskMode: "separate" | "alpha" | null;
    scanVersion: number;
    sourceRel: string;
    params: FreeWorkflowParam[];
    layout?: string[];
    spans?: Record<string, CustomWorkflowSpan>;
    blocks?: string[];
    general?: string[];
    layoutVersion?: number;
    stages?: Array<{ id: string; label: string; nodes: string[]; defaultOff?: boolean }>;
    disabledStages?: string[];
    enabledGroups?: string[];
    textInputs?: FreeWorkflowTextInput[];
    primaryText?: FreeWorkflowTextBinding | null;
    textSelection?: string[];
    textNames?: Record<string, string>;
    textActive?: string;
    flows?: Array<{ id: string; label?: string; nodeIds: string[]; outputs: string[]; main: boolean; maskInputs?: number; stages?: Array<{ id: string; label: string; nodes: string[]; defaultOff?: boolean }>; problems?: FreeWorkflowProblem[]; textInputs?: FreeWorkflowTextInput[]; primaryText?: FreeWorkflowTextBinding | null }>;
    problems?: FreeWorkflowProblem[];
    sourceRevision?: number;
    flowId?: string;
    flowNames?: Record<string, string>;
    pages?: Record<string, Partial<CustomWorkflowPage>>;
    selfLift: FreeWorkflowSelfLift | null;
    passes: FreeWorkflowPass[];
    snapshot?: boolean;
    snapshotOf?: string;
    createdAt: number;
};

export type CustomWorkflowAddOptions = {
    kind?: CustomWorkflowKind;
    mode?: CustomWorkflowMode;
    template?: string[];
    params?: FreeWorkflowParam[];
    layout?: string[];
    spans?: Record<string, CustomWorkflowSpan>;
    blocks?: string[];
    general?: string[];
};

export const IMAGE_GENERAL_BLOCKS = ["setting:size", "setting:resolution", "setting:ratio", "setting:count", "setting:seed"];
export const VIDEO_GENERAL_BLOCKS = ["setting:resolution", "setting:size", "setting:ratio", "setting:seconds", "setting:seed", "setting:interpolation", "setting:mode"];

// 早期试做版写入过视频专用块 id；统一映射到和图片共用的一套 id。
const BLOCK_ALIASES: Record<string, string> = {
    "setting:vresolution": "setting:resolution",
    "setting:vmode": "setting:mode",
};

function normalizeBlockId(id: string) {
    return BLOCK_ALIASES[id] || id;
}

export function defaultCustomWorkflowBlocks(kind: CustomWorkflowKind, params: FreeWorkflowParam[] = [], general?: string[], stages: Array<{ id: string }> = []) {
    const base = kind === "image" || kind === "video" ? (general ?? (kind === "image" ? IMAGE_GENERAL_BLOCKS : VIDEO_GENERAL_BLOCKS)) : [];
    return [...base, ...stages.map((stage) => `stage:${stage.id}`), ...params.map((field) => `field:${field.key}`)];
}

export type CustomWorkflowPage = { params: FreeWorkflowParam[]; layout: string[]; spans: Record<string, CustomWorkflowSpan>; blocks: string[]; disabledStages: string[]; enabledGroups: string[]; mode?: CustomWorkflowMode; textSelection?: string[]; textNames?: Record<string, string>; textActive?: string };

const onSubPage = (workflow: CustomWorkflow) => Boolean(workflow.flowId) && !workflow.flows?.find((flow) => flow.id === workflow.flowId)?.main;

// 整合流分页：主页沿用顶层字段，其他页的参数/块/阶段开关存进 pages[flowId]。
function patchPage(workflow: CustomWorkflow, patch: Partial<CustomWorkflowPage>): CustomWorkflow {
    if (!onSubPage(workflow)) return { ...workflow, ...patch };
    const key = workflow.flowId as string;
    return { ...workflow, pages: { ...workflow.pages, [key]: { ...workflow.pages?.[key], ...patch } } };
}

function patchPageById(workflow: CustomWorkflow, flowId: string, patch: Partial<CustomWorkflowPage>): CustomWorkflow {
    const flow = workflow.flows?.find((item) => item.id === flowId);
    if (flow && !flow.main) return { ...workflow, pages: { ...workflow.pages, [flowId]: { ...workflow.pages?.[flowId], ...patch } } };
    return { ...workflow, ...patch };
}

// 当前页的只读视图：设置面板、编辑窗口、生成请求都读它，不用关心当前是哪一页。
export function customWorkflowView(workflow: CustomWorkflow): CustomWorkflow {
    if (!onSubPage(workflow)) return workflow;
    const page = workflow.pages?.[workflow.flowId as string];
    const flow = workflow.flows?.find((item) => item.id === workflow.flowId);
    const params = page?.params || [];
    return { ...workflow, mode: page?.mode || workflow.mode, maskInputs: flow?.maskInputs ?? workflow.maskInputs, problems: flow?.problems ?? workflow.problems ?? [], params, layout: page?.layout || [], spans: page?.spans || {}, blocks: page?.blocks || defaultCustomWorkflowBlocks(workflow.kind, params, workflow.general, flow?.stages || []), stages: flow?.stages || [], disabledStages: page?.disabledStages || [], enabledGroups: page?.enabledGroups || [], textInputs: flow?.textInputs || workflow.textInputs || [], primaryText: flow?.primaryText || workflow.primaryText || null, textSelection: page?.textSelection || [], textNames: page?.textNames || {}, textActive: page?.textActive || "" };
}

type CustomWorkflowStore = {
    workflows: CustomWorkflow[];
    addWorkflow: (summary: FreeWorkflowSummary, options?: CustomWorkflowAddOptions) => string;
    addSnapshotWorkflow: (summary: FreeWorkflowSummary, source: CustomWorkflow) => string;
    removeWorkflow: (id: string) => void;
    renameWorkflow: (id: string, name: string) => void;
    setEnabled: (id: string, enabled: boolean) => void;
    setTemplate: (id: string, template: string[]) => void;
    setParams: (id: string, params: FreeWorkflowParam[], layout: string[], spans: Record<string, CustomWorkflowSpan>, blocks?: string[]) => void;
    setDisabledStages: (id: string, disabledStages: string[]) => void;
    setEnabledGroups: (id: string, enabledGroups: string[]) => void;
    setFlowId: (id: string, flowId: string) => void;
    setFlowName: (id: string, flowId: string, name: string) => void;
    setPageMode: (id: string, flowId: string, mode: CustomWorkflowMode) => void;
    setTextSelection: (id: string, flowId: string, keys: string[]) => void;
    setTextName: (id: string, flowId: string, key: string, name: string) => void;
    setTextActive: (id: string, flowId: string, key: string) => void;
    applyScan: (id: string, summary: FreeWorkflowSummary) => void;
    applySourceUpdate: (id: string, summary: FreeWorkflowSummary) => void;
};

export const CUSTOM_WORKFLOW_PREFIX = "custom:";
export const customWorkflowModelValue = (id: string) => `${CUSTOM_WORKFLOW_PREFIX}${id}`;
export const customWorkflowLocalId = (value: string) => (value.startsWith(CUSTOM_WORKFLOW_PREFIX) ? value.slice(CUSTOM_WORKFLOW_PREFIX.length) : "");
export const isCustomWorkflowModel = (value: string) => value.startsWith(CUSTOM_WORKFLOW_PREFIX);
export const findCustomWorkflow = (value: string) => {
    const id = customWorkflowLocalId(value);
    return id ? useCustomWorkflowStore.getState().workflows.find((workflow) => workflow.id === id) || null : null;
};

export function defaultCustomWorkflowKind(outputType: CustomWorkflow["outputType"]): CustomWorkflowKind {
    return outputType === "video" ? "video" : outputType === "image" ? "image" : "other";
}

export function defaultCustomWorkflowMode(kind: CustomWorkflowKind): CustomWorkflowMode {
    return kind === "image" ? "t2i" : kind === "video" ? "text" : "generic";
}

export function defaultCustomWorkflowTemplate(kind: CustomWorkflowKind, mode?: CustomWorkflowMode): string[] {
    if (kind === "video") return ["settings:mode", "settings:resolution", "settings:ratio", "settings:seconds", "settings:audio", "settings:seed"];
    if (kind === "image") {
        if (mode === "i2i") return ["settings:mode", "settings:size", "settings:ratio", "settings:count", "settings:seed"];
        if (mode === "edit") return ["settings:mode", "settings:size", "settings:ratio", "settings:count", "settings:seed"];
        return ["settings:mode", "settings:size", "settings:resolution", "settings:ratio", "settings:transparent", "settings:count", "settings:seed"];
    }
    return ["settings:mode"];
}

export const customWorkflowModeLabels: Record<CustomWorkflowMode, string> = {
    t2i: "文生图",
    i2i: "图生图",
    edit: "局部编辑",
    text: "文生视频",
    frames: "首尾帧",
    reference: "参考生视频",
    generic: "通用",
};

export function customWorkflowModeOptions(kind: CustomWorkflowKind): Array<{ value: CustomWorkflowMode; label: string }> {
    if (kind === "image") {
        return [
            { value: "t2i", label: "文生图" },
            { value: "i2i", label: "图生图" },
            { value: "edit", label: "局部编辑" },
        ];
    }
    if (kind === "video") {
        return [
            { value: "text", label: "文生视频" },
            { value: "frames", label: "首尾帧" },
            { value: "reference", label: "参考生视频" },
        ];
    }
    return [{ value: "generic", label: "通用" }];
}

export function normalizeCustomWorkflow(workflow: CustomWorkflow): CustomWorkflow {
    const outputType = workflow.outputType === "video" || workflow.outputType === "image" ? workflow.outputType : "other";
    const kind = workflow.kind || defaultCustomWorkflowKind(outputType);
    const maskInputs = Number(workflow.maskInputs) || 0;
    const maskMode = workflow.maskMode || (maskInputs ? "separate" : null);
    const requestedMode = workflow.mode || defaultCustomWorkflowMode(kind);
    const mode = requestedMode;
    const template = Array.isArray(workflow.template) && workflow.template.length ? workflow.template : defaultCustomWorkflowTemplate(kind);
    const params = Array.isArray(workflow.params) ? workflow.params : [];
    const layout = Array.isArray(workflow.layout) && workflow.layout.length ? workflow.layout : params.map((param) => param.key);
    const spans = workflow.spans && typeof workflow.spans === "object" ? workflow.spans : {};
    const general = (kind === "image"
        ? [...new Set([...(Array.isArray(workflow.general) ? workflow.general : []), ...IMAGE_GENERAL_BLOCKS])]
        : kind === "video"
            ? [...new Set([...(Array.isArray(workflow.general) ? workflow.general : []), ...VIDEO_GENERAL_BLOCKS])]
            : (Array.isArray(workflow.general) ? workflow.general : [])).map(normalizeBlockId);
    const stages = Array.isArray(workflow.stages) ? workflow.stages : [];
    let rawBlocks = (Array.isArray(workflow.blocks) && workflow.blocks.length ? workflow.blocks : defaultCustomWorkflowBlocks(kind, params, general, stages)).map(normalizeBlockId);
    rawBlocks = [...new Set(rawBlocks)];
    // 一次性补全：固定模板默认块必须一开始就有；补全后用户再删不会再加。
    const layoutVersion = Number(workflow.layoutVersion) || 0;
    if (kind === "image" && layoutVersion < 2) {
        const missing = general.filter((id) => !rawBlocks.includes(id));
        if (missing.length) rawBlocks = [...missing, ...rawBlocks];
    }
    // 视频卡沿用同一套块：旧条目首次打开时补上视频标准块。
    if (kind === "video" && layoutVersion < 4) {
        const missing = general.filter((id) => !rawBlocks.includes(id));
        if (missing.length) rawBlocks = [...missing, ...rawBlocks];
    }
    // 阶段块同样默认带上，之后随用户增删。
    if (kind === "image" && layoutVersion < 3) {
        const missing = stages.map((stage) => `stage:${stage.id}`).filter((id) => !rawBlocks.includes(id));
        if (missing.length) rawBlocks = [...rawBlocks, ...missing];
    }
    const blocks = rawBlocks.filter((id) => id !== "setting:transparent");
    return {
        ...workflow,
        outputType,
        kind,
        mode,
        enabled: workflow.enabled !== false,
        template,
        params,
        layout,
        spans,
        general,
        blocks,
        layoutVersion: Math.max(layoutVersion, 4),
        stages,
        disabledStages: Array.isArray(workflow.disabledStages) ? workflow.disabledStages : [],
        enabledGroups: Array.isArray(workflow.enabledGroups) ? workflow.enabledGroups : [],
        textInputs: Array.isArray(workflow.textInputs) ? workflow.textInputs : [],
        primaryText: workflow.primaryText || null,
        textSelection: Array.isArray(workflow.textSelection) ? [...new Set(workflow.textSelection)].slice(0, 4) : [],
        textNames: workflow.textNames && typeof workflow.textNames === "object" ? workflow.textNames : {},
        textActive: typeof workflow.textActive === "string" ? workflow.textActive : "",
        flows: Array.isArray(workflow.flows) ? workflow.flows : [],
        problems: Array.isArray(workflow.problems) ? workflow.problems : [],
        flowId: typeof workflow.flowId === "string" ? workflow.flowId : "",
        flowNames: workflow.flowNames && typeof workflow.flowNames === "object" ? workflow.flowNames : {},
        maskInputs,
        maskMode,
        scanVersion: Number(workflow.scanVersion) || 0,
        sourceRel: workflow.sourceRel || "",
        snapshot: Boolean(workflow.snapshot),
        snapshotOf: workflow.snapshotOf || "",
    };
}

export const useCustomWorkflowStore = create<CustomWorkflowStore>()(    persist(
        (set, get) => ({
            workflows: [],
            addWorkflow: (summary, options = {}) => {
                const existing = get().workflows.find((item) => item.freeId === summary.id);
                const id = existing?.id || `cw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const outputType = summary.outputType === "image" || summary.outputType === "video" ? summary.outputType : "other";
                const kind = options.kind || summary.kind || defaultCustomWorkflowKind(outputType);
                const requestedMode = options.mode || summary.mode || defaultCustomWorkflowMode(kind);
                const maskInputs = Number(summary.maskInputs) || 0;
                const maskMode = summary.maskMode || (maskInputs ? "separate" : null);
                const mode = requestedMode;
                const params = options.params ?? summary.params ?? [];
                const general = kind === "image"
                    ? (options.general?.length ? options.general : IMAGE_GENERAL_BLOCKS)
                    : kind === "video"
                        ? (options.general?.length ? options.general : VIDEO_GENERAL_BLOCKS)
                        : [];
                const workflow: CustomWorkflow = {
                    id,
                    freeId: summary.id,
                    name: summary.name,
                    outputType: kind === "other" ? "other" : kind,
                    kind,
                    mode,
                    enabled: true,
                    template: options.template?.length ? options.template : defaultCustomWorkflowTemplate(kind, mode),
                    maskInputs,
                    maskMode,
                    scanVersion: Array.isArray(summary.textInputs) ? 10 : 9,
                    sourceRel: summary.sourceRel || "",
                    params,
                    layout: options.layout ?? params.map((param) => param.key),
                    spans: options.spans || {},
                    general,
                    layoutVersion: 4,
                    stages: summary.stages || [],
                    disabledStages: [],
                    enabledGroups: [],
                    textInputs: summary.textInputs || [],
                    primaryText: summary.primaryText || null,
                    textSelection: [],
                    textNames: {},
                    textActive: "",
                    flows: summary.flows || [],
                    problems: summary.problems || [],
                    flowId: "",
                    blocks: options.blocks?.length ? options.blocks : defaultCustomWorkflowBlocks(kind, params, general, summary.stages || []),
                    selfLift: summary.selfLift || null,
                    passes: summary.passes || [],
                    createdAt: existing?.createdAt || Date.now(),
                };
                set((state) => ({
                    workflows: existing ? state.workflows.map((item) => (item.id === existing.id ? workflow : item)) : [workflow, ...state.workflows],
                }));
                return id;
            },
            addSnapshotWorkflow: (summary, source) => {
                const existing = get().workflows.find((workflow) => workflow.freeId === summary.id);
                if (existing) return existing.id;
                const id = `cw-snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const snapshot: CustomWorkflow = {
                    ...source,
                    id,
                    freeId: summary.id,
                    name: summary.name,
                    enabled: true,
                    snapshot: true,
                    snapshotOf: summary.snapshotOf || source.freeId,
                    createdAt: Date.now(),
                };
                set((state) => ({ workflows: [snapshot, ...state.workflows] }));
                return id;
            },
            removeWorkflow: (id: string) => set((state) => ({ workflows: state.workflows.filter((workflow) => workflow.id !== id) })),
            renameWorkflow: (id: string, name: string) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? { ...workflow, name } : workflow)) })),
            setEnabled: (id: string, enabled: boolean) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? { ...workflow, enabled } : workflow)) })),
            setTemplate: (id: string, template: string[]) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? { ...workflow, template } : workflow)) })),
            setParams: (id, params, layout, spans, blocks) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? patchPage(workflow, { params, layout, spans, blocks: blocks?.length ? blocks : customWorkflowView(workflow).blocks }) : workflow)) })),
            setDisabledStages: (id, disabledStages) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? patchPage(workflow, { disabledStages }) : workflow)) })),
            setEnabledGroups: (id, enabledGroups) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? patchPage(workflow, { enabledGroups }) : workflow)) })),
            setFlowId: (id, flowId) => set((state) => ({ workflows: state.workflows.map((workflow) => (workflow.id === id ? { ...workflow, flowId } : workflow)) })),
            setFlowName: (id, flowId, name) =>
                set((state) => ({
                    workflows: state.workflows.map((workflow) => {
                        if (workflow.id !== id) return workflow;
                        const next = { ...(workflow.flowNames || {}) };
                        const trimmed = name.trim();
                        if (trimmed) next[flowId] = trimmed;
                        else delete next[flowId];
                        return { ...workflow, flowNames: next };
                    }),
                })),
            setPageMode: (id, flowId, mode) => set((state) => ({ workflows: state.workflows.map((workflow) => { if (workflow.id !== id) return workflow; const flow = workflow.flows?.find((item) => item.id === flowId); return flow && !flow.main ? { ...workflow, pages: { ...workflow.pages, [flowId]: { ...workflow.pages?.[flowId], mode } } } : { ...workflow, mode }; }) })),
            setTextSelection: (id, flowId, keys) => set((state) => ({
                workflows: state.workflows.map((workflow) => workflow.id === id
                    ? patchPageById(workflow, flowId, { textSelection: [...new Set(keys.filter(Boolean))].slice(0, 4) })
                    : workflow),
            })),
            setTextName: (id, flowId, key, name) => set((state) => ({
                workflows: state.workflows.map((workflow) => {
                    if (workflow.id !== id) return workflow;
                    const flow = workflow.flows?.find((item) => item.id === flowId);
                    const current = (flow && !flow.main ? workflow.pages?.[flowId]?.textNames : workflow.textNames) || {};
                    const next = { ...current };
                    const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 16);
                    if (trimmed) next[key] = trimmed;
                    else delete next[key];
                    return patchPageById(workflow, flowId, { textNames: next });
                }),
            })),
            setTextActive: (id, flowId, key) => set((state) => ({
                workflows: state.workflows.map((workflow) => workflow.id === id
                    ? patchPageById(workflow, flowId, { textActive: key })
                    : workflow),
            })),
            applyScan: (id: string, summary: FreeWorkflowSummary) =>
                set((state) => ({
                    workflows: state.workflows.map((workflow) => {
                        if (workflow.id !== id) return workflow;
                        const maskInputs = Number(summary.maskInputs) || 0;
                        const maskMode = summary.maskMode || (maskInputs ? "separate" : null);
                        const mode = workflow.mode === "i2i" && maskMode ? "edit" : workflow.mode;
                        return {
                            ...workflow,
                            name: summary.name || workflow.name,
                            outputType: summary.outputType || workflow.outputType,
                            mode,
                            maskInputs,
                            maskMode,
                            scanVersion: Array.isArray(summary.textInputs) ? 10 : 9,
                            // 网关没有声明参数时不要清掉用户手动从节点图加进来的字段。
                            params: summary.params?.length ? summary.params : workflow.params,
                            stages: summary.stages || [],
                            disabledStages: (workflow.disabledStages || []).filter((stageId) => (summary.stages || []).some((stage) => stage.id === stageId)),
                            enabledGroups: (workflow.enabledGroups || []).filter((stageId) => (summary.stages || []).some((stage) => stage.id === stageId)),
                            textInputs: summary.textInputs || workflow.textInputs || [],
                            primaryText: summary.primaryText || workflow.primaryText || null,
                            flows: summary.flows || [],
                            problems: summary.problems || [],
                            flowId: (summary.flows || []).some((flow) => flow.id === workflow.flowId) ? workflow.flowId : "",
                            selfLift: summary.selfLift || null,
                            passes: summary.passes || [],
                        };
                    }),
                })),
            // 源文件自动同步：只换结构/体检结果，保留用户本地页模式、pages 参数披露与布局。
            applySourceUpdate: (id, summary) => set((state) => ({
                workflows: state.workflows.map((workflow) => {
                    if (workflow.id !== id) return workflow;
                    const flows = Array.isArray(summary.flows) ? summary.flows : [];
                    const maskInputs = Number(summary.maskInputs) || 0;
                    return {
                        ...workflow,
                        name: summary.name || workflow.name,
                        outputType: summary.outputType || workflow.outputType,
                        maskInputs,
                        maskMode: summary.maskMode || (maskInputs ? "separate" : null),
                        textInputs: summary.textInputs || workflow.textInputs || [],
                        primaryText: summary.primaryText || workflow.primaryText || null,
                        flows,
                        problems: summary.problems || [],
                        sourceRevision: Date.now(),
                        scanVersion: Array.isArray(summary.textInputs) ? 10 : 9,
                        flowId: flows.some((flow) => flow.id === workflow.flowId) ? workflow.flowId : "",
                    };
                }),
            })),
        }),
        {
            name: "infinite-canvas:custom_workflow_store",
            version: 2,
            storage: createJSONStorage(() => localForageStorage),
            migrate: (persisted) => {
                const state = persisted as { workflows?: CustomWorkflow[] } | undefined;
                return {
                    ...state,
                    workflows: (state?.workflows || []).map((workflow) => normalizeCustomWorkflow(workflow)),
                };
            },
            merge: (persisted, current) => {
                const saved = persisted as { workflows?: CustomWorkflow[] } | undefined;
                return {
                    ...current,
                    ...saved,
                    workflows: (saved?.workflows || []).map((workflow) => normalizeCustomWorkflow(workflow)),
                };
            },
        },
    ),
);

let rescanPromise: Promise<void> | null = null;

/** Old entries were scanned before mask/alpha detection; force one rescan so exit badge/mask entry appears. */
export async function rescanStaleCustomWorkflows(config: AiConfig) {
    if (rescanPromise) return rescanPromise;
    rescanPromise = (async () => {
        const store = useCustomWorkflowStore.getState();
        const stale = store.workflows.filter((workflow) => !workflow.snapshot && (workflow.scanVersion || 0) < 10);
        for (const workflow of stale) {
            try {
                const result = await syncFreeWorkflow(config, workflow.freeId, true);
                useCustomWorkflowStore.getState().applyScan(workflow.id, result.workflow);
            } catch {
                // Source may have been deleted or renamed; leave the saved entry untouched.
            }
        }
    })().finally(() => {
        rescanPromise = null;
    });
    return rescanPromise;
}
