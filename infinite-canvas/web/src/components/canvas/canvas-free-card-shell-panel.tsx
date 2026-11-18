import { useState } from "react";
import { App, Button, Select, Tooltip } from "antd";
import { RefreshCw, Sparkles } from "lucide-react";

import { CanvasFreeCardPanel } from "@/components/canvas/canvas-free-card-panel";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { FreeCardWorkflowSection } from "@/components/canvas/free-card-workflow-section";
import { useFreeCardWorkflow } from "@/components/canvas/use-free-card-workflow";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { PI_AGENT_BASE_URL, useDevAgentStore } from "@/stores/use-dev-agent-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasFreeCardShellPanelProps = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    connectedNodes: CanvasNodeData[];
    isRunning: boolean;
    mentionReferences?: CanvasResourceReference[];
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onGenerate: (nodeId: string, prompt: string) => void;
    onStop: (nodeId: string) => void;
    onDisconnectReference: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection: (nodeId: string) => void;
};

export function CanvasFreeCardShellPanel({ node, nodes, connectedNodes, isRunning, mentionReferences, onChange, onConfigChange, onPromptChange, onGenerate, onStop, onDisconnectReference, onStartReferenceSelection }: CanvasFreeCardShellPanelProps) {
    const theme = useCanvasTheme();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const hook = useFreeCardWorkflow({ node, config, onChange });
    const info = hook.info;
    const [selectedSource, setSelectedSource] = useState("");
    const [aiStarting, setAiStarting] = useState(false);

    const startAiAdd = async () => {
        if (!selectedSource) {
            message.warning("先选择工作流");
            return;
        }
        setAiStarting(true);
        try {
            useAgentStore.getState().openPanel();
            const base = (useDevAgentStore.getState().baseUrl || PI_AGENT_BASE_URL).trim().replace(/\/+$/, "");
            const response = await fetch(`${/\/v1$/i.test(base) ? base : `${base}/v1`}/models`);
            if (!response.ok) throw new Error(`pi Agent 未连接（HTTP ${response.status}）`);
            const text = "$add-free-workflow 帮我把这个 ComfyUI 工作流添加成自由卡片，自动披露重要参数、给多子流改名、选重要输入和模式，并做不跑 GPU 的简单测试。";
            const context = [
                `当前卡片节点：${node.id}（自由卡片空态；建卡时把 nodeId 传给 free_workflow_create_card，直接绑成这张卡）。`,
                `用户已选择工作流源：${selectedSource}`,
                "按 add-free-workflow 的 G0–G6 顺序执行；G6 valid=true 后再调用 free_workflow_create_card 建卡；全程不跑 GPU。",
            ].join("\n");
            window.dispatchEvent(new CustomEvent("qoder:agent-send", { detail: { text, context, skill: "add-free-workflow" } }));
            message.success("已交给 pi Agent，正在按 skill 添加工作流");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "AI 添加工作流启动失败");
        } finally {
            setAiStarting(false);
        }
    };

    if (!info) {
        const options = hook.sources.map((source) => ({
            value: source.relative,
            label: `${source.name}${source.folder ? ` · ${source.folder}` : ""}${source.format === "ui" ? " · UI" : source.format === "api" ? " · API" : " · 不可用"}`,
            disabled: source.format === "invalid",
        }));
        return (
            <div
                className="w-[640px] max-w-[calc(100vw-32px)] rounded-2xl border p-3 shadow-2xl backdrop-blur"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="size-4" />
                    自由卡片
                </div>
                <div className="mt-1 text-xs leading-4" style={{ color: theme.node.muted }}>
                    选择工作流，结果落在子卡。
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <Select
                        className="min-w-0 flex-1"
                        showSearch
                        optionFilterProp="label"
                        value={selectedSource || undefined}
                        placeholder="选择工作流"
                        options={options}
                        loading={hook.sourcesLoading}
                        onChange={setSelectedSource}
                        notFoundContent={hook.sourcesLoading ? "正在读取工作流…" : hook.sourcesError || "没有可用工作流"}
                    />
                    <Button size="small" icon={<RefreshCw className={`size-3.5 ${hook.sourcesLoading ? "animate-spin" : ""}`} />} onClick={() => void hook.loadSources()} disabled={hook.sourcesLoading} title="刷新工作流列表" />
                </div>
                {hook.sourcesError ? <div className="mt-2 text-xs text-red-500">{hook.sourcesError}</div> : null}
                <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-[11px]" style={{ color: theme.node.muted }}>图片/视频工作流；其他用标准卡。</span>
                    <div className="flex items-center gap-2">
                        <Tooltip title={!selectedSource ? "先选择工作流" : undefined}>
                            <span>
                                <Button size="small" type="text" icon={<Sparkles className="size-3.5" />} loading={aiStarting} disabled={!selectedSource || aiStarting} onClick={() => void startAiAdd()}>
                                    AI 自动添加
                                </Button>
                            </span>
                        </Tooltip>
                        <Button type="primary" size="small" loading={hook.importing} disabled={!selectedSource || hook.importing} onClick={() => void hook.selectSource(selectedSource)}>
                            使用此工作流
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    if (info.outputType === "other") {
        return (
            <CanvasFreeCardPanel
                node={node}
                nodes={nodes}
                connectedNodes={connectedNodes}
                isRunning={isRunning}
                onChange={onChange}
                onGenerate={onGenerate}
                onStop={onStop}
                onDisconnectReference={onDisconnectReference}
                onStartReferenceSelection={onStartReferenceSelection}
            />
        );
    }

    if (!hook.customWorkflow) {
        return (
            <div
                className="w-[640px] max-w-[calc(100vw-32px)] rounded-2xl border p-3 shadow-2xl backdrop-blur"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="size-4" />
                    自由卡片 · {info.name}
                </div>
                <div className="mt-1 text-xs leading-4" style={{ color: theme.node.muted }}>
                    {hook.ensureError ? `读取源工作流失败：${hook.ensureError}` : "正在准备自由卡参数…"}
                </div>
                <div className="mt-3">
                    <FreeCardWorkflowSection {...hookSectionProps(hook)} />
                </div>
                {hook.ensureError ? (
                    <div className="mt-2 flex justify-end">
                        <Button size="small" onClick={hook.retryEnsure}>重试</Button>
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <CanvasNodePromptPanel
            node={node}
            nodes={nodes}
            connectedNodes={connectedNodes}
            mentionReferences={mentionReferences}
            isRunning={isRunning}
            modeOverride={info.outputType === "video" ? "video" : "image"}
            freeCardWorkflow={{ name: hook.customWorkflow.name || info.name }}
            freeCardWorkflowSection={hookSectionProps(hook)}
            hideMaskActions
            onPromptChange={onPromptChange}
            onConfigChange={onConfigChange}
            onGenerate={(nodeId, _mode, prompt) => onGenerate(nodeId, prompt)}
            onStop={onStop}
            onDisconnectReference={onDisconnectReference}
            onStartReferenceSelection={onStartReferenceSelection}
            onOpenMaskEditor={() => message.warning("自由卡不支持蒙版；请用标准卡")}
        />
    );
}

function hookSectionProps(hook: ReturnType<typeof useFreeCardWorkflow>) {
    return {
        info: hook.info,
        sources: hook.sources,
        sourcesLoading: hook.sourcesLoading,
        sourcesError: hook.sourcesError,
        importing: hook.importing,
        archiving: hook.archiving,
        sourceMissing: hook.sourceMissing,
        sourceChanged: hook.sourceChanged,
        warnings: hook.warnings,
        onSelectSource: hook.selectSource,
        onRefreshSources: () => void hook.loadSources(),
        onArchive: () => void hook.archiveCard(),
        onOpenComfyUI: () => void hook.openComfyUI(),
    };
}
