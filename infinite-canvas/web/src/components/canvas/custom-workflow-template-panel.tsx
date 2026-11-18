import { GripVertical, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { inferMediaRatio, mediaRatioOptions, parsePixelSize, sizeForPixelBudget, videoRatioOptions } from "@/lib/media-size";
import type { FreeWorkflowParam } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";
import { customWorkflowModeLabels, type CustomWorkflow } from "@/stores/use-custom-workflow-store";

type CustomWorkflowTemplatePanelProps = {
    workflow: CustomWorkflow;
    mode: "card" | "editor";
    config?: AiConfig;
    theme?: CanvasTheme;
    params?: Record<string, unknown>;
    scannedParams?: FreeWorkflowParam[];
    onConfigChange?: (key: keyof AiConfig, value: string) => void;
    onParamsChange?: (params: Record<string, unknown>) => void;
    onScanParamChange?: (key: string, value: string | number) => void;
    onRemove?: (moduleId: string) => void;
};

const STANDARD_LABELS: Record<string, string> = {
    "settings:mode": "功能",
    "settings:size": "尺寸",
    "settings:ratio": "画幅比例",
    "settings:transparent": "透明背景",
    "settings:count": "生成张数",
    "settings:seed": "固定种子",
    "settings:resolution": "分辨率",
    "settings:seconds": "时长",
    "settings:audio": "生成音频",
};

function ModuleShell({ label, mode, moduleId, onRemove, children }: { label: string; mode: "card" | "editor"; moduleId: string; onRemove?: (id: string) => void; children: ReactNode }) {
    return (
        <div className="rounded-xl border border-stone-200 bg-white/70 p-2.5 dark:border-stone-700/80 dark:bg-white/[.03]">
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">{label}</span>
                {mode === "editor" && onRemove ? (
                    <button type="button" className="rounded p-0.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-white/10 dark:hover:text-stone-200" onClick={() => onRemove(moduleId)} aria-label={`删除模块 ${label}`}>
                        <X className="size-3.5" />
                    </button>
                ) : null}
            </div>
            {children}
        </div>
    );
}

export function CustomWorkflowTemplatePanel({ workflow, mode, config, theme, params, scannedParams, onConfigChange, onParamsChange, onScanParamChange, onRemove }: CustomWorkflowTemplatePanelProps) {
    const { t } = useTranslation();
    const isEditor = mode === "editor";
    const values = (params?.customParams as Record<string, unknown> | undefined) || {};
    const currentSize = String(config?.size || "");
    const sizeParts = parsePixelSize(currentSize);
    const currentRatio = inferMediaRatio(currentSize, "1:1");
    const currentPixels = sizeParts ? sizeParts.width * sizeParts.height : 1024 * 1024;
    const setSize = (value: string) => onConfigChange?.("size", value);
    const setRatio = (ratio: string) => {
        if (!ratio || ratio === "auto") return;
        setSize(sizeForPixelBudget(currentPixels, ratio));
    };
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config?.count)) || 1)));
    const seedFixed = String(config?.seedFixed || "") === "true";
    const setCustomValue = (key: string, value: unknown) => {
        const next = { ...values };
        if (value === "" || value === undefined || value === null) delete next[key];
        else next[key] = value;
        onParamsChange?.(next);
    };
    const paramValue = (param: FreeWorkflowParam) => {
        if (isEditor) return scannedParams?.find((item) => item.key === param.key)?.value ?? param.value;
        return values[param.key] ?? param.value;
    };
    const renderParam = (param: FreeWorkflowParam) => {
        const value = paramValue(param);
        if (param.type === "select") {
            if (!param.options?.length) {
                return (
                    <span className="max-w-[160px] truncate text-[11px] text-stone-400 dark:text-stone-500" title="没有拿到可选项，重新扫描工作流">
                        {String(value ?? "—")} · 重新扫描
                    </span>
                );
            }
            return (
                <select
                    className="h-7 max-w-[170px] rounded-md border border-stone-200 bg-white px-1.5 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                    value={String(value ?? "")}
                    onChange={(event) => (isEditor ? onScanParamChange?.(param.key, event.target.value) : setCustomValue(param.key, event.target.value))}
                >
                    {param.options.map((option) => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </select>
            );
        }
        if (param.type === "boolean") {
            return (
                <input
                    type="checkbox"
                    className="size-4 accent-emerald-600"
                    checked={Boolean(value)}
                    onChange={(event) => (isEditor ? onScanParamChange?.(param.key, event.target.checked ? "true" : "false") : setCustomValue(param.key, event.target.checked))}
                />
            );
        }
        if (param.type === "string") {
            return (
                <input
                    type="text"
                    className="h-7 w-32 rounded-md border border-stone-200 bg-white px-1.5 text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                    value={String(value ?? "")}
                    onChange={(event) => (isEditor ? onScanParamChange?.(param.key, event.target.value) : setCustomValue(param.key, event.target.value))}
                />
            );
        }
        return (
            <input
                type="number"
                className="h-7 w-20 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] text-stone-700 outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                value={value === undefined ? "" : String(value)}
                onChange={(event) => {
                    const next = event.target.value === "" ? "" : Number(event.target.value);
                    if (isEditor) onScanParamChange?.(param.key, next);
                    else setCustomValue(param.key, next);
                }}
            />
        );
    };
    const renderStandard = (moduleId: string) => {
        const label = STANDARD_LABELS[moduleId] || moduleId;
        return (
            <ModuleShell key={moduleId} label={label} mode={mode} moduleId={moduleId} onRemove={onRemove}>
                {moduleId === "settings:mode" ? (
                    <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-600 dark:bg-white/10 dark:text-stone-300">{customWorkflowModeLabels[workflow.mode]}</span>
                ) : moduleId === "settings:size" ? (
                    isEditor ? (
                        <span className="text-[11px] text-stone-400 dark:text-stone-500">卡片内可改宽高</span>
                    ) : (
                        <div className="flex items-center gap-1.5">
                            <input
                                type="number"
                                className="h-7 w-20 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] dark:border-stone-700 dark:bg-stone-900"
                                value={sizeParts?.width ?? 1024}
                                min={64}
                                step={16}
                                onChange={(event) => {
                                    const width = Math.max(64, Number(event.target.value) || 64);
                                    setSize(`${width}x${sizeParts?.height ?? 1024}`);
                                }}
                            />
                            <span className="text-[11px] text-stone-400">×</span>
                            <input
                                type="number"
                                className="h-7 w-20 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] dark:border-stone-700 dark:bg-stone-900"
                                value={sizeParts?.height ?? 1024}
                                min={64}
                                step={16}
                                onChange={(event) => {
                                    const height = Math.max(64, Number(event.target.value) || 64);
                                    setSize(`${sizeParts?.width ?? 1024}x${height}`);
                                }}
                            />
                        </div>
                    )
                ) : moduleId === "settings:ratio" ? (
                    <div className="grid grid-cols-5 gap-1">
                        {mediaRatioOptions.filter((item) => item.value !== "auto").map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                disabled={isEditor}
                                className={`rounded-md border px-1 py-1 text-[10px] transition-colors ${currentRatio === item.value ? "border-stone-500 text-stone-900 dark:border-stone-300 dark:text-stone-50" : "border-stone-200 text-stone-500 dark:border-stone-700 dark:text-stone-400"} ${isEditor ? "opacity-60" : "hover:border-stone-400"}`}
                                onClick={() => setRatio(item.value)}
                            >
                                {item.value}
                            </button>
                        ))}
                    </div>
                ) : moduleId === "settings:transparent" ? (
                    <label className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        开启后输出 PNG 透明背景
                        <input type="checkbox" className="size-4 accent-emerald-600" checked={config?.background === "transparent"} disabled={isEditor} onChange={(event) => onConfigChange?.("background", event.target.checked ? "transparent" : "")} />
                    </label>
                ) : moduleId === "settings:count" ? (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        <span>每次生成张数</span>
                        <input
                            type="number"
                            className="h-7 w-16 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] dark:border-stone-700 dark:bg-stone-900"
                            min={1}
                            max={15}
                            value={count}
                            disabled={isEditor}
                            onChange={(event) => onConfigChange?.("count", String(Math.max(1, Math.min(15, Number(event.target.value) || 1))))}
                        />
                    </div>
                ) : moduleId === "settings:seed" ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        <label className="flex items-center gap-1.5">
                            <input type="checkbox" className="size-4 accent-emerald-600" checked={seedFixed} disabled={isEditor} onChange={(event) => onConfigChange?.("seedFixed", event.target.checked ? "true" : "false")} />
                            固定种子
                        </label>
                        <input
                            type="number"
                            className="h-7 w-28 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] dark:border-stone-700 dark:bg-stone-900"
                            placeholder="随机"
                            value={config?.seed || ""}
                            disabled={isEditor || !seedFixed}
                            onChange={(event) => onConfigChange?.("seed", event.target.value)}
                        />
                    </div>
                ) : moduleId === "settings:resolution" ? (
                    workflow.kind === "video" ? (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        <span>视频分辨率</span>
                        <select
                            className="h-7 rounded-md border border-stone-200 bg-white px-1.5 text-[11px] dark:border-stone-700 dark:bg-stone-900"
                            value={["480", "720", "1080"].includes(String(config?.vquality)) ? String(config?.vquality) : "720"}
                            disabled={isEditor}
                            onChange={(event) => onConfigChange?.("vquality", event.target.value)}
                        >
                            <option value="480">480p</option>
                            <option value="720">720p</option>
                            <option value="1080">1080p</option>
                        </select>
                    </div>
                    ) : (
                        <span className="text-[11px] text-stone-400 dark:text-stone-500">卡片内可选 1k / 2k / 4k / 自动</span>
                    )
                ) : moduleId === "settings:seconds" ? (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        <span>时长（秒）</span>
                        <input
                            type="number"
                            className="h-7 w-20 rounded-md border border-stone-200 bg-white px-1.5 text-right text-[11px] dark:border-stone-700 dark:bg-stone-900"
                            min={2}
                            max={30}
                            value={config?.videoSeconds || "6"}
                            disabled={isEditor}
                            onChange={(event) => onConfigChange?.("videoSeconds", event.target.value)}
                        />
                    </div>
                ) : moduleId === "settings:audio" ? (
                    <label className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                        生成音频
                        <input type="checkbox" className="size-4 accent-emerald-600" checked={String(config?.videoGenerateAudio || "") === "true"} disabled={isEditor} onChange={(event) => onConfigChange?.("videoGenerateAudio", event.target.checked ? "true" : "false")} />
                    </label>
                ) : (
                    <span className="text-[11px] text-stone-400">卡片内可调</span>
                )}
            </ModuleShell>
        );
    };
    const renderGroup = (moduleId: string) => {
        const group = moduleId.slice("group:".length);
        const items = workflow.params.filter((param) => param.group === group);
        if (!items.length) return null;
        return (
            <ModuleShell key={moduleId} label={group} mode={mode} moduleId={moduleId} onRemove={onRemove}>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {items.map((param) => (
                        <label key={param.key} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-stone-200/70 px-2 py-1 dark:border-stone-700/70">
                            <span className="min-w-0 truncate text-[11px] text-stone-500 dark:text-stone-400" title={param.label}>{param.label}</span>
                            {renderParam(param)}
                        </label>
                    ))}
                </div>
            </ModuleShell>
        );
    };
    const hasImageSettings = ["settings:size", "settings:resolution", "settings:ratio", "settings:transparent", "settings:count", "settings:seed"].some((id) => workflow.template.includes(id));
    const useBuiltinImageSettings = !isEditor && workflow.kind === "image" && Boolean(config && theme);
    const imagePanel = useBuiltinImageSettings ? (
        <ImageSettingsPanel
            config={config!}
            onConfigChange={(key, value) => onConfigChange?.(key, value)}
            theme={theme!}
            showTitle={false}
            showSize={workflow.template.includes("settings:size")}
            showResolution={workflow.template.includes("settings:resolution")}
            showRatio={workflow.template.includes("settings:ratio")}
            showTransparent={workflow.template.includes("settings:transparent")}
            showCount={workflow.template.includes("settings:count")}
            showSeed={workflow.template.includes("settings:seed")}
            className="space-y-4"
        />
    ) : null;
    if (useBuiltinImageSettings) {
        return (
            <div className="space-y-1.5">
                {hasImageSettings ? imagePanel : null}
                {workflow.template.filter((moduleId) => moduleId.startsWith("group:")).map((moduleId) => renderGroup(moduleId))}
            </div>
        );
    }
    return (
        <div className="space-y-1.5">
            {workflow.template.length ? (
                workflow.template.map((moduleId) => (moduleId.startsWith("group:") ? renderGroup(moduleId) : renderStandard(moduleId)))
            ) : (
                <div className="rounded-xl border border-dashed border-stone-200 p-4 text-center text-[11px] text-stone-400 dark:border-stone-700 dark:text-stone-500">
                    {isEditor ? "模板是空的：从左侧把参数组拖进来" : "这个自选工作流没有可调模块"}
                </div>
            )}
            {isEditor && workflow.template.length ? <div className="flex items-center gap-1 px-1 pt-0.5 text-[10px] text-stone-400 dark:text-stone-500"><GripVertical className="size-3" />模块上的 × 可删除；左侧参数组可拖进这里</div> : null}
            {!isEditor ? null : <span className="sr-only">{t("canvas.customWorkflow.title")}</span>}
        </div>
    );
}
