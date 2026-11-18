import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Select } from "antd";
import { RefreshCw, Sparkles } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { fetchFreeWorkflowSources, type FreeWorkflowSource } from "@/services/api/free-workflow";
import type { CustomWorkflowKind, CustomWorkflowMode } from "@/stores/use-custom-workflow-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

type CategoryOption = {
    id: string;
    label: string;
    hint: string;
    kind: CustomWorkflowKind;
    mode: CustomWorkflowMode;
    enabled: boolean;
};

const CATEGORIES: CategoryOption[] = [
    { id: "image", label: "生图", hint: "文字/参考图生成图片", kind: "image", mode: "t2i", enabled: true },
    { id: "video", label: "生视频", hint: "版式待接", kind: "video", mode: "text", enabled: false },
    { id: "other", label: "其他", hint: "版式待接", kind: "other", mode: "generic", enabled: false },
];

type CanvasFreeCardSetupPanelProps = {
    node: CanvasNodeData;
    config: AiConfig;
    onConfirm: (source: string, kind: CustomWorkflowKind) => Promise<void>;
};

export function CanvasFreeCardSetupPanel({ node, config, onConfirm }: CanvasFreeCardSetupPanelProps) {
    const theme = useCanvasTheme();
    const [sources, setSources] = useState<FreeWorkflowSource[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [source, setSource] = useState(node.metadata?.freeCard?.sourceRel || "");
    const [category, setCategory] = useState<string>("");
    const [confirming, setConfirming] = useState(false);

    const loadSources = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const items = await fetchFreeWorkflowSources(config);
            setSources(items.filter((item) => item.format !== "invalid"));
        } catch (err) {
            setSources([]);
            setError(err instanceof Error ? err.message : "读取工作流列表失败");
        } finally {
            setLoading(false);
        }
    }, [config]);

    useEffect(() => {
        void loadSources();
    }, [loadSources]);

    const options = useMemo(() => {
        const list = sources.map((item) => ({
            value: item.relative,
            label: `${item.name}${item.folder ? ` · ${item.folder}` : ""}${item.format === "ui" ? " · UI" : " · API"}`,
        }));
        if (source && !list.some((item) => item.value === source)) list.unshift({ value: source, label: source });
        return list;
    }, [source, sources]);
    const selectedCategory = CATEGORIES.find((item) => item.id === category) || null;
    const confirm = async () => {
        if (!source || !selectedCategory?.enabled) return;
        setConfirming(true);
        setError("");
        try {
            await onConfirm(source, selectedCategory.kind);
        } catch (err) {
            setError(err instanceof Error ? err.message : "切换到标准卡片失败");
        } finally {
            setConfirming(false);
        }
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className="thin-scrollbar max-h-[72vh] w-[540px] space-y-4 overflow-y-auto rounded-2xl border px-4 py-4 shadow-[0_18px_50px_rgba(28,25,23,.18)]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                    <Sparkles className="size-4" style={{ color: theme.node.text }} />
                    <span className="text-sm font-semibold">自由卡片</span>
                    <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }}>{node.title}</span>
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>工作流</div>
                    <div className="flex items-center gap-2">
                        <Select
                            className="min-w-0 flex-1"
                            showSearch
                            optionFilterProp="label"
                            value={source || undefined}
                            placeholder="选择工作流"
                            options={options}
                            loading={loading}
                            onChange={(value) => setSource(value)}
                            notFoundContent={loading ? "正在读取工作流…" : error || "没有可用工作流"}
                        />
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} title="刷新工作流" disabled={loading} onClick={() => void loadSources()} />
                    </div>
                    <div className="text-[11px]" style={{ color: theme.node.muted }}>第一次使用会把 UI 工作流转为 API 工作流。</div>
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>工作流类别</div>
                    <div className="grid grid-cols-2 gap-2">
                        {CATEGORIES.map((item) => {
                            const active = category === item.id;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    disabled={!item.enabled}
                                    onClick={() => { if (!item.enabled) return; setCategory(item.id); }}
                                    className="rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                                    style={{ background: active ? theme.node.fill : "transparent", borderColor: active ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                >
                                    <div className="text-xs font-medium">{item.label}</div>
                                    <div className="mt-0.5 text-[10px]" style={{ color: theme.node.muted }}>{item.hint}</div>
                                </button>
                            );
                        })}
                    </div>
                </div>
                {error ? <div className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: theme.node.fill, color: "#f87171" }}>{error}</div> : null}
                <Button type="primary" block loading={confirming} disabled={!source || !selectedCategory?.enabled || confirming} onClick={() => void confirm()}>
                    确定
                </Button>
            </div>
        </ImageSettingsTheme>
    );
}
