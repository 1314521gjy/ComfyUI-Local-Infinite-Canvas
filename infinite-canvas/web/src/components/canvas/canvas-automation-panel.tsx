import { useEffect, useMemo, useState } from "react";
import { Alert, App, AutoComplete, Button, Input, InputNumber, Progress, Select, Switch, Tag } from "antd";
import { Link2, Play, Sparkles, Square, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { channelModelOf, modelOptionName, selectableModelsByCapability, useEffectiveConfig, workflowModelOptions } from "@/stores/use-config-store";
import type { CanvasAutomationSettings, CanvasAutomationStage, CanvasAutomationState, CanvasNodeData } from "@/types/canvas";

export type CanvasAutomationStartInput = {
    sourceText: string;
    sourceUrl?: string;
    settings: CanvasAutomationSettings;
};

type CanvasAutomationPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onStart: (input: CanvasAutomationStartInput) => void;
    onStop: () => void;
    onRetry: () => void;
};

const DEFAULT_SETTINGS: CanvasAutomationSettings = {
    pageCount: 12,
    pageCountAuto: true,
    segmentation: "short",
    grid: "2x3",
    style: "新海诚风格",
    aspect: "16:9",
    mossSteps: "8",
    videoSeconds: "auto",
    videoVariant: "auto",
    vquality: "720",
    generateAudio: true,
    generateCharacterSheets: true,
    generateSceneSheets: true,
    storyboardWhiteModel: true,
};

const STYLE_OPTIONS = [
    { value: "新海诚风格", label: "新海诚风格（彩色动漫/蓝天云层/逆光）" },
    { value: "宫崎骏风格", label: "宫崎骏风格（彩色动漫/手绘水彩）" },
    { value: "彩色动漫", label: "彩色动漫" },
    { value: "黑白漫画", label: "黑白漫画" },
    { value: "日漫网点", label: "日漫网点" },
    { value: "彩色条漫", label: "彩色条漫" },
    { value: "美式写实", label: "美式写实" },
];

const ASPECT_OPTIONS = ["3:4", "4:3", "1:1", "16:9", "9:16"].map((value) => ({ value, label: value }));

export function CanvasAutomationPanel({ node, isRunning, onChange, onStart, onStop, onRetry }: CanvasAutomationPanelProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const config = useEffectiveConfig();
    const { message } = App.useApp();
    const automation = node.metadata?.automation;
    const [sourceText, setSourceText] = useState(automation?.sourceText || "");
    const [sourceUrl, setSourceUrl] = useState(automation?.sourceUrl || "");
    const [reading, setReading] = useState(false);
    const [settings, setSettings] = useState<CanvasAutomationSettings>({ ...DEFAULT_SETTINGS, ...(automation?.settings || {}) });

    const textModels = useMemo(() => selectableModelsByCapability(config, "text"), [config]);
    const textModelOptions = useMemo(
        () => [
            ...textModels.map((value) => ({ value, label: channelModelOf(config, value)?.model.label || modelOptionName(value) || value })),
            ...(config.promptCloudApis || []).map((api) => ({ value: `prompt-cloud::${api.id}`, label: `${api.name || "Cloud"} · ${api.model}` })),
        ],
        [config, textModels],
    );

    useEffect(() => {
        const next = node.metadata?.automation;
        if (!next) return;
        setSourceText(next.sourceText || "");
        setSourceUrl(next.sourceUrl || "");
        setSettings({ ...DEFAULT_SETTINGS, ...(next.settings || {}) });
    }, [node.id, node.metadata?.automation?.sourceText, node.metadata?.automation?.sourceUrl, node.metadata?.automation?.settings]);

    useEffect(() => {
        if (settings.textModel || !textModelOptions.length) return;
        setSettings((current) => ({ ...current, textModel: config.textModel || textModelOptions[0].value }));
    }, [config.textModel, settings.textModel, textModelOptions]);

    const mossAvailable = useMemo(() => {
        const options = workflowModelOptions(config, "image");
        const list = options.length ? options : selectableModelsByCapability(config, "image");
        const tier = settings.mossSteps === "50" ? "ultra" : "fast";
        return list.some((value) => {
            const model = channelModelOf(config, value)?.model;
            return model?.workflowId === "image-moss-image" && model.moss?.tiers?.[tier]?.available !== false;
        });
    }, [config, settings.mossSteps]);
    const pages = automation?.pages || [];
    const imageDone = pages.filter((page) => page.imageState === "done").length;
    const videoDone = pages.filter((page) => page.videoState === "done").length;
    const imagePercent = pages.length ? Math.round((imageDone / pages.length) * 100) : 0;
    const videoPercent = pages.length ? Math.round((videoDone / pages.length) * 100) : 0;
    const stage = automation?.stage || "idle";
    const canStart = !isRunning && mossAvailable && ((sourceText.trim().length > 0) || (sourceUrl.trim().length > 0));

    const patchSettings = (patch: Partial<CanvasAutomationSettings>) => {
        const next = { ...settings, ...patch };
        setSettings(next);
        onChange({ automation: { ...(automation || emptyAutomation()), sourceText, sourceUrl, settings: next } });
    };

    const patchSource = (nextText: string, nextUrl = sourceUrl) => {
        setSourceText(nextText);
        setSourceUrl(nextUrl);
        onChange({ automation: { ...(automation || emptyAutomation()), sourceText: nextText, sourceUrl: nextUrl, settings, script: undefined, scriptText: undefined } });
    };

    const readUrl = async () => {
        const url = sourceUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
            message.warning(t("canvas.automation.urlInvalid"));
            return;
        }
        setReading(true);
        try {
            const response = await fetch(url, { headers: { Accept: "text/plain,text/html,*/*" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const raw = await response.text();
            const plain = /html/i.test(response.headers.get("content-type") || "") ? new DOMParser().parseFromString(raw, "text/html").body.innerText : raw;
            const text = plain.replace(/\n{3,}/g, "\n\n").trim().slice(0, 30000);
            if (!text) throw new Error(t("canvas.automation.urlEmpty"));
            patchSource(text, url);
            message.success(t("canvas.automation.urlRead", { count: text.length }));
        } catch (error) {
            message.error(`${t("canvas.automation.urlFailed")} ${error instanceof Error ? error.message : ""}`.trim());
        } finally {
            setReading(false);
        }
    };

    const start = () => {
        const text = sourceText.trim();
        if (!text) {
            message.warning(t("canvas.automation.sourceRequired"));
            return;
        }
        if (!settings.textModel) {
            message.warning(t("canvas.automation.textModelRequired"));
            return;
        }
        onStart({ sourceText: text, sourceUrl: sourceUrl.trim() || undefined, settings });
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex size-7 items-center justify-center rounded-lg" style={{ background: theme.toolbar.activeBg }}>
                    <Workflow className="size-4 opacity-75" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{t("canvas.automation.title")}</div>
                    <div className="text-[11px] opacity-55">{t("canvas.automation.subtitle")}</div>
                </div>
                <Tag color={stage === "error" ? "red" : stage === "done" ? "green" : isRunning ? "processing" : "default"}>{t(`canvas.automation.stage.${stage}`)}</Tag>
            </div>
            {automation?.progress ? <div className="mb-2 truncate text-[11px] opacity-60">{automation.progress}</div> : null}

            <div className="grid gap-2">
                <Input.TextArea
                    value={sourceText}
                    onChange={(event) => patchSource(event.target.value)}
                    placeholder={t("canvas.automation.sourcePlaceholder")}
                    autoSize={{ minRows: 4, maxRows: 8 }}
                    disabled={isRunning}
                />
                <div className="flex gap-2">
                    <Input value={sourceUrl} onChange={(event) => patchSource(sourceText, event.target.value)} placeholder={t("canvas.automation.urlPlaceholder")} disabled={isRunning} prefix={<Link2 className="size-3.5 opacity-50" />} />
                    <Button icon={<Link2 className="size-3.5" />} loading={reading} disabled={isRunning} onClick={() => void readUrl()}>
                        {t("canvas.automation.readUrl")}
                    </Button>
                </div>

                {automation?.scriptText ? (
                    <details className="rounded-xl border p-2 text-[11px]" style={{ borderColor: theme.toolbar.border }}>
                        <summary className="cursor-pointer select-none opacity-70">{t("canvas.automation.scriptSummary", { count: automation.script?.beats.length || 0 })}</summary>
                        <div className="mt-1 opacity-50">{t("canvas.automation.scriptHint")}</div>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">{automation.scriptText}</pre>
                        <Button
                            size="small"
                            type="text"
                            className="mt-1"
                            onClick={() => {
                                if (!navigator.clipboard?.writeText) return;
                                void navigator.clipboard.writeText(automation.scriptText || "").then(() => message.success(t("canvas.automation.scriptCopied"))).catch(() => undefined);
                            }}
                        >
                            {t("canvas.automation.scriptCopy")}
                        </Button>
                    </details>
                ) : null}

                <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-[11px] opacity-70">
                        <span className="flex items-center justify-between gap-2">
                            {t("canvas.automation.pageCount")}
                            <span className="flex items-center gap-1 text-[10px] opacity-70">
                                {t("canvas.automation.pageCountAuto")}
                                <Switch size="small" checked={settings.pageCountAuto === true} disabled={isRunning} onChange={(checked) => patchSettings({ pageCountAuto: checked })} />
                            </span>
                        </span>
                        {settings.pageCountAuto === true ? (
                            <span className="flex h-8 items-center rounded-lg border px-2 text-[11px] opacity-60" style={{ borderColor: theme.toolbar.border }}>
                                {t("canvas.automation.pageCountAutoHint")}
                            </span>
                        ) : (
                            <InputNumber min={2} max={24} value={settings.pageCount} disabled={isRunning} onChange={(value) => patchSettings({ pageCount: Math.max(2, Math.min(24, Number(value) || 12)) })} className="w-full" />
                        )}
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.segmentation")}
                        <Select
                            value={settings.segmentation || "short"}
                            options={[
                                { value: "short", label: t("canvas.automation.segmentationShort") },
                                { value: "long", label: t("canvas.automation.segmentationLong") },
                            ]}
                            disabled={isRunning}
                            onChange={(value) => patchSettings({ segmentation: value as "short" | "long" })}
                        />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.grid")}
                        <Select
                            value={settings.grid}
                            options={[
                                { value: "2x2", label: t("canvas.automation.gridFour") },
                                { value: "2x3", label: t("canvas.automation.gridSix") },
                                { value: "3x3", label: t("canvas.automation.gridNine") },
                            ]}
                            disabled={isRunning}
                            onChange={(value) => patchSettings({ grid: value as CanvasAutomationSettings["grid"] })}
                        />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.style")}
                        <AutoComplete
                            value={settings.style}
                            options={STYLE_OPTIONS}
                            disabled={isRunning}
                            placeholder={t("canvas.automation.styleCustom")}
                            className="w-full"
                            onChange={(value) => patchSettings({ style: value })}
                            filterOption={(input, option) => String(option?.value || "").toLowerCase().includes(input.toLowerCase())}
                        />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.aspect")}
                        <Select value={settings.aspect} options={ASPECT_OPTIONS} disabled={isRunning} onChange={(value) => patchSettings({ aspect: value })} />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.textModel")}
                        <Select value={settings.textModel} options={textModelOptions} placeholder={t("canvas.automation.textModelEmpty")} disabled={isRunning || !textModelOptions.length} onChange={(value) => patchSettings({ textModel: value })} />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.mossSteps")}
                        <Select value={settings.mossSteps} options={[{ value: "8", label: "MOSS 8 step" }, { value: "50", label: "MOSS 50 step" }]} disabled={isRunning} onChange={(value) => patchSettings({ mossSteps: value as "8" | "50" })} />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.videoSeconds")}
                        <Select value={settings.videoSeconds} options={[{ value: "auto", label: t("canvas.automation.videoSecondsAuto") }, ...["2", "4", "6", "8", "9", "10", "12", "15", "18", "20", "25"].map((value) => ({ value, label: `${value}s` }))]} disabled={isRunning} onChange={(value) => patchSettings({ videoSeconds: value })} />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.vquality")}
                        <Select value={settings.vquality} options={["480", "720", "1080"].map((value) => ({ value, label: `${value}p` }))} disabled={isRunning} onChange={(value) => patchSettings({ vquality: value })} />
                    </label>
                    <label className="grid gap-1 text-[11px] opacity-70">
                        {t("canvas.automation.videoVariant")}
                        <Select
                            value={settings.videoVariant || "auto"}
                            options={[
                                { value: "auto", label: t("canvas.automation.videoVariantAuto") },
                                { value: "vdn", label: "VDN" },
                                { value: "novdn", label: t("canvas.automation.videoVariantNoVdn") },
                            ]}
                            disabled={isRunning}
                            onChange={(value) => patchSettings({ videoVariant: value as "auto" | "vdn" | "novdn" })}
                        />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-[11px] opacity-70">
                        {t("canvas.automation.generateAudio")}
                        <Switch size="small" checked={settings.generateAudio} disabled={isRunning} onChange={(checked) => patchSettings({ generateAudio: checked })} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-[11px] opacity-70">
                        {t("canvas.automation.characterSheets")}
                        <Switch size="small" checked={settings.generateCharacterSheets !== false} disabled={isRunning} onChange={(checked) => patchSettings({ generateCharacterSheets: checked })} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-[11px] opacity-70">
                        {t("canvas.automation.sceneSheets")}
                        <Switch size="small" checked={settings.generateSceneSheets !== false} disabled={isRunning} onChange={(checked) => patchSettings({ generateSceneSheets: checked })} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-[11px] opacity-70">
                        {t("canvas.automation.storyboardWhiteModel")}
                        <Switch size="small" checked={settings.storyboardWhiteModel !== false} disabled={isRunning} onChange={(checked) => patchSettings({ storyboardWhiteModel: checked })} />
                    </label>
                    <div className="col-span-2 text-[10px] leading-4 opacity-50">{t("canvas.automation.segmentationHint")}</div>
                </div>
                <div className="text-[11px] opacity-55">{t("canvas.automation.modelRouting")}</div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button type="primary" icon={<Play className="size-3.5" />} disabled={!canStart} loading={isRunning && stage !== "images" && stage !== "videos"} onClick={start}>
                        {pages.length ? t("canvas.automation.continue") : t("canvas.automation.start")}
                    </Button>
                    <Button danger icon={<Square className="size-3.5" />} disabled={!isRunning} onClick={onStop}>
                        {t("canvas.automation.stop")}
                    </Button>
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] opacity-55">
                        <Sparkles className="size-3.5" />
                        {t("canvas.automation.agentHint")}
                    </span>
                </div>

                {pages.length ? (
                    <div className="grid gap-1.5 rounded-xl border p-2" style={{ borderColor: theme.toolbar.border }}>
                        <div className="flex items-center justify-between text-[11px] opacity-70">
                            <span>{t("canvas.automation.imageProgress")}</span>
                            <span className="tabular-nums">
                                {imageDone}/{pages.length}
                            </span>
                        </div>
                        <Progress percent={imagePercent} size="small" showInfo={false} />
                        <div className="flex items-center justify-between text-[11px] opacity-70">
                            <span>{t("canvas.automation.videoProgress")}</span>
                            <span className="tabular-nums">
                                {videoDone}/{pages.length}
                            </span>
                        </div>
                        <Progress percent={videoPercent} size="small" showInfo={false} />
                    </div>
                ) : null}

                {!textModelOptions.length ? <Alert type="warning" showIcon message={t("canvas.automation.textModelEmpty")} /> : null}
                {!mossAvailable ? <Alert type="warning" showIcon message={t("canvas.automation.mossMissing")} /> : null}
            </div>
        </div>
    );
}

function emptyAutomation(): CanvasAutomationState {
    return { template: "novel-comic-video", stage: "idle" as CanvasAutomationStage, sourceText: "", settings: { ...DEFAULT_SETTINGS } };
}
