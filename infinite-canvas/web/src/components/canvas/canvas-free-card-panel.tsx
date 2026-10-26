import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Popover, Select } from "antd";
import { Archive, ExternalLink, RefreshCw, Settings2, Sparkles, Square, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasNodeReferenceBar } from "@/components/canvas/canvas-node-reference-bar";
import { ImageSettingsPanel, ImageSettingsTheme, OptionPill } from "@/components/image-settings-panel";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { normalizePixelSize } from "@/lib/media-size";
import { requestImagePromptOptimize } from "@/services/api/image";
import {
    archiveFreeWorkflow,
    fetchFreeWorkflow,
    fetchFreeWorkflowSources,
    freeWorkflowComfyUrl,
    importFreeWorkflow,
    syncFreeWorkflow,
    type FreeWorkflowPreset,
    type FreeWorkflowSource,
    type FreeWorkflowSummary,
} from "@/services/api/free-workflow";
import { CanvasNodeType, type CanvasFreeCardInfo, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

type CanvasFreeCardPanelProps = {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    connectedNodes: CanvasNodeData[];
    isRunning: boolean;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, prompt: string) => void;
    onStop: (nodeId: string) => void;
    onDisconnectReference: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection: (nodeId: string) => void;
};

const RATIO_ORDER = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"];

// Reuse one named ComfyUI window for this tab so repeated clicks do not pile
// up editor tabs. Browsers keep the name across reloads of the canvas page.
let comfyEditorWindow: Window | null = null;
let comfyEditorUrl = "";

export function freeCardInfoFromSummary(summary: FreeWorkflowSummary): CanvasFreeCardInfo {
    return {
        id: summary.id,
        name: summary.name,
        sourceRel: summary.sourceRel,
        sourceFormat: summary.sourceFormat,
        outputType: summary.outputType || "image",
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
    };
}

function pixelSize(size: string | undefined) {
    const match = String(size || "").match(/^(\d+)x(\d+)$/i);
    return match ? `${match[1]}×${match[2]}` : size || "";
}

function settingsSizeLabel(size: string | undefined) {
    const normalized = normalizePixelSize(size);
    if (normalized && normalized !== size) return `${size} → ${pixelSize(normalized)}`;
    return pixelSize(size);
}

export function CanvasFreeCardPanel({ node, nodes, connectedNodes, isRunning, onChange, onGenerate, onStop, onDisconnectReference, onStartReferenceSelection }: CanvasFreeCardPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();
    const info = node.metadata?.freeCard;
    const [sources, setSources] = useState<FreeWorkflowSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [sourcesError, setSourcesError] = useState("");
    const [summary, setSummary] = useState<FreeWorkflowSummary | null>(null);
    const [prompt, setPrompt] = useState(node.metadata?.prompt || "");
    const [importing, setImporting] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        setPrompt(node.metadata?.prompt || "");
    }, [node.id, node.metadata?.prompt]);

    const loadSources = useCallback(async () => {
        setSourcesLoading(true);
        setSourcesError("");
        try {
            setSources(await fetchFreeWorkflowSources(config));
        } catch (error) {
            setSources([]);
            setSourcesError(error instanceof Error ? error.message : t("canvas.freeCard.sourcesFailed"));
        } finally {
            setSourcesLoading(false);
        }
    }, [config, t]);

    useEffect(() => {
        void loadSources();
    }, [loadSources]);

    useEffect(() => {
        if (!info?.id) {
            setSummary(null);
            return;
        }
        let canceled = false;
        void fetchFreeWorkflow(config, info.id)
            .then((next) => {
                if (!canceled) setSummary(next);
            })
            .catch(() => {
                if (!canceled) setSummary(null);
            });
        return () => {
            canceled = true;
        };
    }, [config, info?.id]);

    const imageConnectedNodes = useMemo(() => connectedNodes.filter((item) => item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Group), [connectedNodes]);
    const imageReferences = useMemo(() => {
        const resources = connectedNodes.flatMap((item) => (item.type === CanvasNodeType.Group ? getGroupResourceNodes(item.id, nodes) : [item]));
        return resources
            .filter((item) => item.type === CanvasNodeType.Image && item.metadata?.content)
            .map((item): ReferenceImage => ({
                id: item.id,
                name: `${item.title || item.id}.png`,
                type: item.metadata?.mimeType || "image/png",
                dataUrl: item.metadata?.content || "",
                storageKey: item.metadata?.storageKey,
            }));
    }, [connectedNodes, nodes]);

    const sizeText = node.metadata?.size || (info?.size ? `${info.size.width}x${info.size.height}` : "");
    const countValue = node.metadata?.count ?? info?.count ?? 1;
    const seedValue = node.metadata?.seed || info?.seed || "";
    const seedFixed = node.metadata?.seedFixed || "false";
    const ratioOptions = useMemo(() => {
        const available = new Set(info?.aspectRatios || []);
        const ordered = RATIO_ORDER.filter((ratio) => available.has(ratio));
        const extra = [...available].filter((ratio) => !RATIO_ORDER.includes(ratio));
        return [...ordered, ...extra];
    }, [info?.aspectRatios]);
    const ratioValue = node.metadata?.aspectRatio || info?.aspectRatio || ratioOptions[0] || "";
    const sourceMissing = Boolean(summary?.sourceMissing);
    const hasSeedSetting = Boolean(info && (info.hasSeed || info.seed != null));
    const hasSettings = Boolean(info && (info.size || ratioOptions.length || info.count != null || hasSeedSetting));
    const settingsSummary = [
        info?.size && sizeText ? settingsSizeLabel(sizeText) : "",
        ratioOptions.length && ratioValue ? ratioValue : "",
        info?.count != null ? t("canvas.freeCard.countSummary", { count: countValue }) : "",
        hasSeedSetting && seedFixed === "true" && seedValue ? t("canvas.freeCard.seedSummary", { seed: seedValue }) : "",
    ]
        .filter(Boolean)
        .join(" · ");

    const setCard = (next: FreeWorkflowSummary, { resetSettings = false } = {}) => {
        const card = freeCardInfoFromSummary(next);
        const patch: Partial<CanvasNodeData["metadata"]> = { freeCard: card };
        const current = node.metadata || {};
        if (resetSettings) {
            patch.size = next.size ? `${next.size.width}x${next.size.height}` : undefined;
            patch.aspectRatio = card.aspectRatio || "";
            patch.count = next.count ?? 1;
            patch.seed = next.seed || "";
            patch.seedFixed = current.seedFixed || "false";
        } else {
            if (!current.size && next.size) patch.size = `${next.size.width}x${next.size.height}`;
            if (!current.aspectRatio && card.aspectRatio) patch.aspectRatio = card.aspectRatio;
            if (current.count == null && next.count != null) patch.count = next.count;
            if (!current.seed && next.seed) patch.seed = next.seed;
        }
        onChange(patch);
        setSummary(next);
    };

    const selectSource = async (relative: string) => {
        if (!relative) return;
        setImporting(true);
        try {
            const next = await importFreeWorkflow(config, relative);
            setCard(next, { resetSettings: true });
            message.success(t("canvas.freeCard.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.importFailed"));
        } finally {
            setImporting(false);
        }
    };

    const syncCard = async () => {
        if (!info?.id) return;
        setSyncing(true);
        try {
            const result = await syncFreeWorkflow(config, info.id);
            setCard(result.workflow);
            message.success(result.changed ? t("canvas.freeCard.synced") : t("canvas.freeCard.noChange"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        } finally {
            setSyncing(false);
        }
    };

    const archiveCard = async () => {
        if (!info?.id || info.archived) return;
        const preset: FreeWorkflowPreset = {
            size: info.size ? normalizePixelSize(sizeText) || undefined : undefined,
            aspectRatio: ratioOptions.length ? ratioValue || undefined : undefined,
            count: info.count != null ? countValue : undefined,
            seed: hasSeedSetting ? seedValue || undefined : undefined,
            seedFixed,
        };
        setArchiving(true);
        try {
            const next = await archiveFreeWorkflow(config, info.id, true, preset);
            setCard(next);
            message.success(t("canvas.freeCard.cardArchived"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        } finally {
            setArchiving(false);
        }
    };

    const openComfyUI = async () => {
        if (!info?.id) return;
        try {
            const target = await freeWorkflowComfyUrl(config, info.id);
            if (comfyEditorWindow && !comfyEditorWindow.closed) {
                if (comfyEditorUrl !== target.url) {
                    comfyEditorWindow.location.href = target.url;
                    comfyEditorUrl = target.url;
                }
                comfyEditorWindow.focus();
            } else {
                const nextWindow = window.open(target.url, "infinite-canvas-comfyui");
                if (!nextWindow) {
                    message.warning(t("canvas.freeCard.openBlocked"));
                    return;
                }
                comfyEditorWindow = nextWindow;
                comfyEditorUrl = target.url;
                nextWindow.focus();
            }
            if (target.bridge) message.info(t("canvas.freeCard.openHint", { name: target.name || info.name }));
            else message.warning(t("canvas.freeCard.openBridgeMissing", { name: target.name || info.name, reason: target.bridgeReason || "" }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        }
    };

    const optimizePrompt = async () => {
        const text = prompt.trim();
        if (!text) {
            message.warning(t("canvas.freeCard.needPrompt"));
            return;
        }
        setOptimizing(true);
        try {
            const result = await requestImagePromptOptimize(config, { prompt: text, mode: "image", language: "zh", images: imageReferences });
            setPrompt(result.prompt);
            onChange({ prompt: result.prompt, composerContent: result.prompt });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.freeCard.saveFailed"));
        } finally {
            setOptimizing(false);
        }
    };

    const commitPrompt = () => {
        if (prompt !== (node.metadata?.prompt || "")) onChange({ prompt, composerContent: prompt });
    };

    const generate = () => {
        if (!info) {
            message.warning(t("canvas.freeCard.selectFirst"));
            return;
        }
        if (info.prompt && !prompt.trim()) {
            message.warning(t("canvas.freeCard.needPrompt"));
            return;
        }
        commitPrompt();
        onGenerate(node.id, prompt.trim());
    };

    const sourceOptions = useMemo(
        () =>
            sources.map((source) => ({
                value: source.relative,
                label: `${source.name}${source.folder ? ` · ${source.folder}` : ""}${source.format === "ui" ? " · UI" : source.format === "api" ? " · API" : ` · ${t("canvas.freeCard.unavailable")}`}`,
                disabled: source.format === "invalid",
            })),
        [sources, t],
    );

    const settingsConfig = {
        ...config,
        size: sizeText || "auto",
        count: String(countValue),
        seed: seedValue,
        seedFixed,
    };
    const warnings = [...(info?.warnings || []), ...(summary?.warnings || [])].filter((item, index, list) => list.indexOf(item) === index);
    const ratioBlock = ratioOptions.length ? (
        <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                {t("canvas.freeCard.aspectRatio")}
            </div>
            <div className="grid grid-cols-4 gap-2">
                {ratioOptions.map((ratio) => (
                    <OptionPill key={ratio} selected={ratioValue === ratio} theme={theme} onClick={() => onChange({ aspectRatio: ratio })}>
                        {ratio}
                    </OptionPill>
                ))}
            </div>
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {t("canvas.freeCard.aspectRatioHint")}
            </div>
        </div>
    ) : null;

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className="thin-scrollbar max-h-[72vh] w-[540px] space-y-3 overflow-y-auto rounded-2xl border px-4 py-4 shadow-[0_18px_50px_rgba(28,25,23,.18)]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                    <Sparkles className="size-4" style={{ color: theme.node.text }} />
                    <span className="text-sm font-semibold">{t("canvas.freeCard.title")}</span>
                    <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }}>
                        {info?.name || t("canvas.freeCard.emptyTitle")}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <Select
                        className="min-w-0 flex-1"
                        showSearch
                        optionFilterProp="label"
                        value={info?.sourceRel}
                        placeholder={t("canvas.freeCard.selectWorkflow")}
                        options={sourceOptions}
                        loading={sourcesLoading || importing}
                        onChange={(value) => void selectSource(value)}
                        notFoundContent={sourcesLoading ? t("canvas.freeCard.loadingSources") : sourcesError || t("canvas.freeCard.sourcesEmpty")}
                    />
                    <Button size="small" icon={<RefreshCw className={`size-3.5 ${sourcesLoading ? "animate-spin" : ""}`} />} title={t("canvas.freeCard.refreshSources")} disabled={importing} onClick={() => void loadSources()} />
                    {info ? (
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />} disabled={syncing || isRunning || sourceMissing} title={sourceMissing ? t("canvas.freeCard.sourceMissing") : undefined} onClick={() => void syncCard()}>
                            {syncing ? t("canvas.freeCard.syncing") : t("canvas.freeCard.sync")}
                        </Button>
                    ) : null}
                </div>
                <div className="text-[11px]" style={{ color: sourcesError ? "#f87171" : theme.node.muted }}>
                    {sourcesError || t("canvas.freeCard.sourceHint")}
                </div>

                {info ? (
                    <>
                        <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                            <span>{info.outputType === "video" ? t("canvas.freeCard.videoWorkflow") : t("canvas.freeCard.imageWorkflow")}</span>
                            <span>·</span>
                            <span>{info.sourceFormat.toUpperCase()}</span>
                            {info.archived ? <span>· {t("canvas.freeCard.archived")}</span> : null}
                            {sourceMissing ? <span className="text-red-400">· {t("canvas.freeCard.sourceMissing")}</span> : summary?.sourceChanged ? <span className="text-amber-500">· {t("canvas.freeCard.sourceChanged")}</span> : null}
                        </div>
                        {sourceMissing ? (
                            <div className="rounded-lg px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, color: "#f87171" }}>
                                {t("canvas.freeCard.sourceMissingHint")}
                            </div>
                        ) : null}

                        {hasSettings ? (
                            <div className="rounded-lg px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, color: theme.node.muted }}>
                                <span className="font-medium">{t("canvas.freeCard.currentSettings")}</span>
                                <span>：{settingsSummary || t("canvas.freeCard.noSettings")}</span>
                            </div>
                        ) : null}

                        {info.prompt ? (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                        {t("canvas.freeCard.prompt")}
                                    </span>
                                    <Button size="small" type="text" icon={<Sparkles className="size-3.5" />} loading={optimizing} onClick={() => void optimizePrompt()}>
                                        {optimizing ? t("canvas.freeCard.optimizing") : t("canvas.freeCard.optimize")}
                                    </Button>
                                </div>
                                <textarea
                                    className="min-h-20 w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm outline-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                    value={prompt}
                                    placeholder={t("canvas.freeCard.promptPlaceholder")}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    onBlur={commitPrompt}
                                />
                            </div>
                        ) : null}

                        {info.imageInputs > 0 ? (
                            <div>
                                <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                                    <span>{t("canvas.freeCard.imageInputs")}</span>
                                    <span>
                                        {imageReferences.length}/{info.imageInputs}
                                    </span>
                                </div>
                                <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={imageConnectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
                            </div>
                        ) : null}

                        {warnings.length ? (
                            <div className="rounded-lg px-2.5 py-2 text-[11px] leading-5" style={{ background: theme.node.fill, color: theme.node.muted }}>
                                <div className="mb-0.5 font-medium">{t("canvas.freeCard.warnings")}</div>
                                {warnings.slice(0, 3).map((warning) => (
                                    <div key={warning}>· {warning}</div>
                                ))}
                            </div>
                        ) : null}

                        <div className="flex items-center justify-between gap-2 pt-1">
                            <div className="flex items-center gap-2">
                                {hasSettings ? (
                                    <Popover
                                        trigger="click"
                                        open={settingsOpen}
                                        onOpenChange={setSettingsOpen}
                                        placement="topLeft"
                                        content={
                                            <div className="space-y-4" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                                                {ratioBlock}
                                                <ImageSettingsPanel
                                                    config={settingsConfig}
                                                    onConfigChange={(key, value) => {
                                                        if (key === "count") onChange({ count: Number(value) || 1 });
                                                        else if (key === "seed") onChange({ seed: value });
                                                        else if (key === "seedFixed") onChange({ seedFixed: value });
                                                        else if (key === "size") onChange({ size: value });
                                                    }}
                                                    theme={theme}
                                                    showTitle={false}
                                                    showSize={Boolean(info.size)}
                                                    showTransparent={false}
                                                    showCount={info.count != null}
                                                    showSeed={hasSeedSetting}
                                                    className="w-[320px] space-y-4"
                                                />
                                            </div>
                                        }
                                    >
                                        <Button size="small" icon={<Settings2 className="size-3.5" />} title={settingsSummary ? `${t("canvas.freeCard.settings")} · ${settingsSummary}` : undefined}>
                                            {settingsSummary ? `${t("canvas.freeCard.settings")} · ${settingsSummary}` : t("canvas.freeCard.settings")}
                                        </Button>
                                    </Popover>
                                ) : null}
                                <Button size="small" icon={<ExternalLink className="size-3.5" />} disabled={isRunning || sourceMissing} title={sourceMissing ? t("canvas.freeCard.sourceMissing") : undefined} onClick={() => void openComfyUI()}>
                                    {t("canvas.freeCard.openInComfy")}
                                </Button>
                                <Button size="small" icon={<Archive className="size-3.5" />} loading={archiving} disabled={isRunning || info.archived} onClick={() => void archiveCard()}>
                                    {t("canvas.freeCard.archive")}
                                </Button>
                            </div>
                            {isRunning ? (
                                <Button danger icon={<Square className="size-3.5" />} onClick={() => onStop(node.id)}>
                                    {t("canvas.freeCard.stop")}
                                </Button>
                            ) : (
                                <Button type="primary" icon={<ArrowUp className="size-3.5" />} onClick={generate}>
                                    {t("canvas.freeCard.generate")}
                                </Button>
                            )}
                        </div>
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}
