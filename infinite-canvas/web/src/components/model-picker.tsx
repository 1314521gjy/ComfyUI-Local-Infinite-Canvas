import { useEffect, useId, useMemo, useState } from "react";
import { App } from "antd";
import { ClipboardCopy, Cpu, HelpCircle, Layers, RefreshCw, ScanText } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fetchSetupDiagnostics, modelPickerEmptyActions, pickerOpenPlan, requestGatewayRescan, resolveModelPickerEmptyKind, type ModelPickerEmptyKind } from "@/lib/local-gateway-sync";
import {
    baseModelOptions,
    channelModelOf,
    modelOptionLabel,
    modelOptionName,
    selectableModelsByCapability,
    useConfigStore,
    workflowModelOptions,
    workflowModelValue,
    type AiConfig,
    type LocalGatewaySyncStatus,
    type ModelCapability,
} from "@/stores/use-config-store";

type ModelPickerExtraOption = { value: string; label: string; disabled?: boolean };

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    extraOptions?: ModelPickerExtraOption[];
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, extraOptions = [], onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const localGatewaySync = useConfigStore((state) => state.localGatewaySync);
    const options = useMemo(
        () => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability), ...extraOptions.map((option) => option.value)].filter((model): model is string => Boolean(model)))),
        [capability, config, extraOptions, value],
    );
    const current = value || "";
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    const optionLabel = (model: string) => extraOptions.find((option) => option.value === model)?.label || modelOptionLabel(config, model);
    const currentExtra = extraOptions.find((option) => option.value === current);
    const hasLocalConfigAction = config.channelMode === "local";
    const emptyKind = resolveModelPickerEmptyKind({ optionCount: options.length, local: hasLocalConfigAction, status: localGatewaySync });
    const diagnosticWorkflowId = useMemo(() => channelModelOf(config, current)?.model.workflowId, [config, current]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                // 空列表不再自动弹配置；只保留与其他选择器互斥的展开逻辑。
                const plan = pickerOpenPlan(nextOpen);
                if (plan.broadcast) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(plan.open);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? optionLabel(current) : pickerPlaceholder}
            >
                {currentExtra ? <ScanText className="size-4 shrink-0 opacity-70" /> : <ModelIcon model={current} />}
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? optionLabel(current) : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => {
                        const extra = extraOptions.find((option) => option.value === model);
                        return (
                            <SelectItem key={model} value={model} textValue={optionLabel(model)} disabled={extra?.disabled}>
                                {extra ? (
                                    <span className="flex min-w-0 items-center gap-2">
                                        <ScanText className="size-4 shrink-0 opacity-70" />
                                        <span className="truncate">{extra.label}</span>
                                    </span>
                                ) : (
                                    <ModelLabel config={config} model={model} />
                                )}
                            </SelectItem>
                        );
                    })
                ) : emptyKind ? (
                    <ModelPickerEmptyState
                        kind={emptyKind}
                        capability={capability}
                        status={localGatewaySync}
                        workflowId={diagnosticWorkflowId}
                        onMissingConfig={onMissingConfig}
                        onClose={() => setOpen(false)}
                    />
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function clipboardWrite(text: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(
            () => true,
            () => fallbackClipboardWrite(text),
        );
    }
    return Promise.resolve(fallbackClipboardWrite(text));
}

function fallbackClipboardWrite(text: string) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch {
        copied = false;
    }
    textarea.remove();
    return copied;
}

const stopPickerClose = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
};

/** 空列表的具体原因 + 显式动作；动作只做扫描/诊断，绝不触发生成或自动弹配置。 */
function ModelPickerEmptyState({
    kind,
    capability,
    status,
    workflowId,
    onMissingConfig,
    onClose,
}: {
    kind: ModelPickerEmptyKind;
    capability?: ModelCapability;
    status: LocalGatewaySyncStatus;
    workflowId?: string;
    onMissingConfig?: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const [busy, setBusy] = useState<"" | "rescan" | "diagnostics">("");
    const actions = modelPickerEmptyActions({ local: true, hasMissingConfigHandler: Boolean(onMissingConfig) });
    const label = capability ? t(`settingsPanels.model.capabilities.${capability}`) : t("settingsPanels.model.capabilities.image");
    const text =
        kind === "scanning"
            ? t("settingsPanels.model.empty.scanning")
            : kind === "offline"
              ? t("settingsPanels.model.empty.offline")
              : kind === "unsynced"
                ? t("settingsPanels.model.empty.unsynced")
                : t("settingsPanels.model.empty.noModels", { capability: label });

    const rescan = async () => {
        setBusy("rescan");
        try {
            await requestGatewayRescan();
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
            message.success(t("settingsPanels.model.empty.rescanned"));
        } catch {
            message.error(t("settingsPanels.model.empty.rescanFailed"));
        } finally {
            setBusy("");
        }
    };

    const copyDiagnostics = async () => {
        setBusy("diagnostics");
        try {
            const { text: report } = await fetchSetupDiagnostics({ workflowId, sync: useConfigStore.getState().localGatewaySync });
            let copied = false;
            try {
                copied = await clipboardWrite(report);
            } catch {
                copied = false;
            }
            if (copied) message.success(t("settingsPanels.model.empty.diagnosticsCopied"));
            else {
                modal.info({
                    title: t("settingsPanels.model.empty.diagnosticsTitle"),
                    width: 720,
                    content: <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{report}</pre>,
                });
            }
        } catch {
            message.error(t("settingsPanels.model.empty.diagnosticsFailed"));
        } finally {
            setBusy("");
        }
    };

    return (
        <div
            className="flex flex-col gap-1.5 px-2 py-1.5 text-xs text-muted-foreground"
            title={status.stale ? t("settingsPanels.model.empty.stale") : undefined}
            onPointerDown={stopPickerClose}
            onMouseDown={stopPickerClose}
        >
            <span className="leading-snug">{text}</span>
            <div className="flex flex-wrap items-center gap-1">
                {actions.includes("rescan") ? (
                    <button
                        type="button"
                        disabled={busy !== ""}
                        className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                        onPointerDown={stopPickerClose}
                        onMouseDown={stopPickerClose}
                        onClick={() => void rescan()}
                    >
                        <RefreshCw className="size-3" />
                        {busy === "rescan" ? t("settingsPanels.model.empty.rescanning") : t("settingsPanels.model.empty.rescan")}
                    </button>
                ) : null}
                {actions.includes("reason") && onMissingConfig ? (
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent"
                        onPointerDown={stopPickerClose}
                        onMouseDown={stopPickerClose}
                        onClick={() => {
                            onMissingConfig();
                            onClose();
                        }}
                    >
                        <HelpCircle className="size-3" />
                        {t("settingsPanels.model.empty.reason")}
                    </button>
                ) : null}
                {actions.includes("diagnostics") ? (
                    <button
                        type="button"
                        disabled={busy !== ""}
                        className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                        onPointerDown={stopPickerClose}
                        onMouseDown={stopPickerClose}
                        onClick={() => void copyDiagnostics()}
                    >
                        <ClipboardCopy className="size-3" />
                        {busy === "diagnostics" ? t("settingsPanels.model.empty.copying") : t("settingsPanels.model.empty.diagnostics")}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}

type LevelOption = { value: string; label: string; title?: string };

type LevelPickerProps = {
    config: AiConfig;
    value: string;
    onChange: (model: string) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

/** 一级下拉：只选工作流；变体归到其所属工作流下。 */
export function WorkflowModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig }: LevelPickerProps & { capability?: ModelCapability }) {
    const options = useMemo<LevelOption[]>(
        () =>
            workflowModelOptions(config, capability)
                .filter((model) => channelModelOf(config, model)?.model.workflowId !== "video-h3-fast")
                .map((model) => ({ value: model, label: modelOptionLabel(config, model) })),
        [config, capability],
    );
    const selected = useMemo(() => workflowModelValue(config, value) || value, [config, value]);
    const diagnosticWorkflowId = useMemo(() => channelModelOf(config, value)?.model.workflowId, [config, value]);
    return (
        <LevelSelect
            value={selected}
            options={options}
            onChange={onChange}
            className={className}
            fullWidth={fullWidth}
            placeholder={placeholder || i18n.t("settingsPanels.model.select")}
            onMissingConfig={onMissingConfig}
            icon="workflow"
            width="w-72"
            capability={capability}
            diagnosticWorkflowId={diagnosticWorkflowId}
        />
    );
}

/** 二级下拉：同一工作流内切换默认底模 / 底模变体。 */
export function BaseModelPicker({ config, value, onChange, className, fullWidth = false, placeholder }: LevelPickerProps) {
    const { t } = useTranslation();
    const options = useMemo<LevelOption[]>(
        () =>
            baseModelOptions(config, value).map((option) => ({
                value: option.value,
                label: option.isDefault ? t("settingsPanels.model.defaultBase") : option.label,
                title: option.name,
            })),
        [config, value, t],
    );
    if (options.length < 2) return null;
    return <LevelSelect value={value} options={options} onChange={onChange} className={className} fullWidth={fullWidth} placeholder={placeholder || t("settingsPanels.model.select")} icon="base" width="w-64" />;
}

function LevelSelect({
    value,
    options,
    onChange,
    className,
    fullWidth,
    placeholder,
    onMissingConfig,
    icon,
    width,
    capability,
    diagnosticWorkflowId,
}: {
    value: string;
    options: LevelOption[];
    onChange: (model: string) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder: string;
    onMissingConfig?: () => void;
    icon: "workflow" | "base";
    width: string;
    capability?: ModelCapability;
    diagnosticWorkflowId?: string;
}) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const localGatewaySync = useConfigStore((state) => state.localGatewaySync);
    const channelMode = useConfigStore((state) => state.config.channelMode);
    const current = options.find((option) => option.value === value);
    const label = current?.label || placeholder;
    const local = channelMode === "local";
    const emptyKind = resolveModelPickerEmptyKind({ optionCount: options.length, local, status: localGatewaySync });

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={value}
            onOpenChange={(nextOpen) => {
                // 空列表不再自动弹配置；只保留与其他选择器互斥的展开逻辑。
                const plan = pickerOpenPlan(nextOpen);
                if (plan.broadcast) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(plan.open);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[8.5rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={label}
            >
                {icon === "workflow" ? <Cpu className="size-3.5 shrink-0 opacity-70" /> : <Layers className="size-3.5 shrink-0 opacity-70" />}
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{label}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className={cn("z-[1200] max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl", width)}
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((option) => (
                        <SelectItem key={option.value} value={option.value} textValue={option.label}>
                            <span className="flex min-w-0 items-center gap-2" title={option.title}>
                                {icon === "workflow" ? <Cpu className="size-3.5 shrink-0 opacity-70" /> : <Layers className="size-3.5 shrink-0 opacity-70" />}
                                <span className="truncate">{option.label}</span>
                            </span>
                        </SelectItem>
                    ))
                ) : emptyKind ? (
                    <ModelPickerEmptyState
                        kind={emptyKind}
                        capability={capability}
                        status={localGatewaySync}
                        workflowId={diagnosticWorkflowId}
                        onMissingConfig={onMissingConfig}
                        onClose={() => setOpen(false)}
                    />
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {placeholder}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}
