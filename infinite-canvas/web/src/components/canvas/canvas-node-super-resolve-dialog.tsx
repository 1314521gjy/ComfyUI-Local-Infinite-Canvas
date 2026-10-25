import { useEffect, useMemo, useState } from "react";
import { Button, Collapse, InputNumber, Modal, Segmented, Select } from "antd";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import { requestUpscaleWorkflows, type UpscaleParameter, type UpscaleWorkflow } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

export type CanvasSuperResolveParams = { workflowId: string; params: Record<string, unknown> };

const SCALES = [2, 3, 4];
const MAX_OUTPUT_EDGE = 4096;

function optionValue(option: string | { value: string; label: string }) {
    return typeof option === "string" ? option : option.value;
}

function optionLabel(option: string | { value: string; label: string }) {
    return typeof option === "string" ? option : option.label;
}

function prettyModel(value: string) {
    const lower = value.toLowerCase();
    if (/seedvr2/.test(lower)) {
        const size = /(\d+b)/.exec(lower)?.[1]?.toUpperCase() || "";
        const sharp = /sharp/.test(lower) ? "Sharp" : "";
        const quant = /q4/.test(lower) ? "Q4" : /q8/.test(lower) ? "Q8" : /fp8/.test(lower) ? "fp8" : /fp16/.test(lower) ? "fp16" : "";
        return ["SeedVR2", size, sharp, quant].filter(Boolean).join(" ");
    }
    return value.replace(/\.(safetensors|pth|gguf)$/i, "").replace(/_/g, " ");
}

function even(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

function clampResolution(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, even(value)));
}

function resolveOutput(width: number, height: number, resolution: number) {
    if (!width || !height || !resolution) return null;
    const scale = resolution / Math.min(width, height);
    let outWidth = width * scale;
    let outHeight = height * scale;
    const capped = Math.max(outWidth, outHeight) > MAX_OUTPUT_EDGE;
    if (capped) {
        const factor = MAX_OUTPUT_EDGE / Math.max(outWidth, outHeight);
        outWidth *= factor;
        outHeight *= factor;
    }
    return { width: even(outWidth), height: even(outHeight), capped };
}

function modelScaleOf(value: string) {
    const lower = value.toLowerCase();
    const match = /(?:^|[^0-9])([234])\s*x/.exec(lower) || /x\s*([234])/.exec(lower);
    return match ? Number(match[1]) : 1;
}

function resolveScaleOutput(width: number, height: number, scale: number) {
    if (!width || !height || !scale) return null;
    return { width: even(width * scale), height: even(height * scale), capped: false };
}

export function CanvasNodeSuperResolveDialog({
    dataUrl,
    open,
    config,
    onClose,
    onConfirm,
    preferredWorkflowId,
    title,
    actionLabel,
    note,
}: {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    onClose: () => void;
    onConfirm: (params: CanvasSuperResolveParams) => void;
    preferredWorkflowId?: string;
    title?: string;
    actionLabel?: string;
    note?: string;
}) {
    const { t } = useTranslation();
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [workflows, setWorkflows] = useState<UpscaleWorkflow[]>([]);
    const [workflowId, setWorkflowId] = useState("");
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [scale, setScale] = useState(2);
    const [resolution, setResolution] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const workflow = workflows.find((item) => item.id === workflowId) || null;
    const modelParameter = workflow?.parameters.find((parameter) => parameter.key === "dit_model" || parameter.key === "upscale_model") || null;
    const resolutionParameter = workflow?.parameters.find((parameter) => parameter.key === "resolution") || null;
    const advancedParameters = (workflow?.parameters || []).filter((parameter) => parameter !== modelParameter && parameter !== resolutionParameter);
    const shortEdge = image ? Math.min(image.width, image.height) : 0;
    const minResolution = Number(resolutionParameter?.min) || 512;
    const maxResolution = Number(resolutionParameter?.max) || MAX_OUTPUT_EDGE;
    const selectedModel = modelParameter ? String(values[modelParameter.key] ?? "") : "";
    const output = useMemo(() => {
        if (!image) return null;
        if (resolutionParameter) return resolveOutput(image.width, image.height, resolution);
        return resolveScaleOutput(image.width, image.height, modelScaleOf(selectedModel));
    }, [image, resolution, resolutionParameter, selectedModel]);

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setError("");
        setLoading(true);
        setWorkflows([]);
        setWorkflowId("");
        setScale(2);
        setResolution(0);
        void readImageMeta(dataUrl).then(setImage);
        let alive = true;
        requestUpscaleWorkflows(config)
            .then((items) => {
                if (!alive) return;
                setWorkflows(items);
                const first = items.find((item) => item.id === preferredWorkflowId) || items.find((item) => item.available) || items[0];
                setWorkflowId(first?.id || "");
                if (!items.length) setError(t("apiErrors.upscaleNoWorkflow"));
            })
            .catch((reason) => {
                if (alive) setError(reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [open, dataUrl, config, preferredWorkflowId, t]);

    useEffect(() => {
        if (!workflow) return;
        const defaults: Record<string, unknown> = {};
        for (const parameter of workflow.parameters) {
            if (parameter === resolutionParameter) continue;
            defaults[parameter.key] = parameter.default ?? (parameter.type === "boolean" ? false : "");
        }
        setValues(defaults);
    }, [workflow, resolutionParameter]);

    useEffect(() => {
        if (!open || !shortEdge || !resolutionParameter) return;
        setResolution(clampResolution(shortEdge * scale, minResolution, maxResolution));
    }, [open, shortEdge, scale, resolutionParameter, minResolution, maxResolution]);

    const canRun = Boolean(
        workflow?.available &&
            image &&
            (resolutionParameter ? resolution > shortEdge && resolution >= minResolution && resolution <= maxResolution : Boolean(selectedModel)),
    );
    const workflowOptions = workflows.map((item) => ({ value: item.id, label: `${item.label}${item.available ? "" : ` (${t("canvas.superResolve.unavailable")})`}` }));

    const confirm = () => {
        if (!workflow || !canRun) return;
        const params: Record<string, unknown> = { ...values };
        if (resolutionParameter) params.resolution = Math.round(resolution);
        onConfirm({ workflowId: workflow.id, params });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={820} centered destroyOnHidden>
            <div className="space-y-5">
                <h2 className="text-xl font-semibold">{title || t("canvas.superResolve.title")}</h2>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[280px] place-items-center rounded-lg bg-black/5">
                            <img src={dataUrl} alt="" className="max-h-[320px] max-w-full rounded-lg object-contain shadow-xl" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.superResolve.source")}</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : t("canvas.editors.loading")}</span>
                        </div>
                    </div>
                    <div className="space-y-5 py-1">
                        {!preferredWorkflowId ? (
                            <div className="space-y-2">
                                <div className="font-medium opacity-75">{t("canvas.superResolve.workflow")}</div>
                                <Select
                                    className="w-full"
                                    value={workflowId}
                                    options={workflowOptions}
                                    loading={loading}
                                    placeholder={t("canvas.superResolve.workflow")}
                                    onChange={(value) => setWorkflowId(value)}
                                    notFoundContent={t("canvas.superResolve.noWorkflow")}
                                />
                                {workflow && !workflow.available ? (
                                    <div className="text-xs text-[#ef4444]">{workflow.problems?.[0]?.message || t("canvas.superResolve.unavailable")}</div>
                                ) : null}
                            </div>
                        ) : null}

                        {modelParameter ? (
                            <div className="space-y-2">
                                <div className="font-medium opacity-75">{modelParameter.label || t("canvas.superResolve.model")}</div>
                                <Select
                                    className="w-full"
                                    value={String(values[modelParameter.key] ?? "")}
                                    options={(modelParameter.options || []).map((option) => ({ value: optionValue(option), label: prettyModel(optionLabel(option)) }))}
                                    onChange={(value) => setValues((current) => ({ ...current, [modelParameter.key]: value }))}
                                    optionFilterProp="label"
                                    showSearch
                                />
                            </div>
                        ) : null}

                        {resolutionParameter ? (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <div className="font-medium opacity-75">{t("canvas.superResolve.scale")}</div>
                                    <span className="text-xs opacity-55">
                                        {t("canvas.superResolve.targetShortEdge")} {resolution || "—"}px
                                    </span>
                                </div>
                                <Segmented
                                    block
                                    value={scale}
                                    options={SCALES.map((value) => ({ label: `${value}×`, value }))}
                                    onChange={(value) => setScale(Number(value))}
                                />
                            </div>
                        ) : null}

                        {advancedParameters.length ? (
                            <Collapse
                                ghost
                                size="small"
                                items={[
                                    {
                                        key: "advanced",
                                        label: t("canvas.superResolve.advanced"),
                                        children: (
                                            <div className="grid grid-cols-2 gap-2">
                                                {advancedParameters.map((parameter) => (
                                                    <ParameterField
                                                        key={parameter.key}
                                                        parameter={parameter}
                                                        value={values[parameter.key]}
                                                        onChange={(value) => setValues((current) => ({ ...current, [parameter.key]: value }))}
                                                    />
                                                ))}
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        ) : null}

                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.superResolve.output")}</span>
                                <span className="font-semibold">{output ? `${output.width} x ${output.height} px` : t("canvas.editors.unknown")}</span>
                            </div>
                            {output?.capped ? <div className="mt-1 text-xs opacity-55">{t("canvas.superResolve.capped")}</div> : null}
                        </div>
                        {error ? <div className="text-xs text-[#ef4444]">{error}</div> : null}
                        <div className="text-xs leading-5 opacity-55">{note || t("canvas.superResolve.note")}</div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<Sparkles className="size-4" />} disabled={!canRun} onClick={confirm}>
                        {actionLabel || t("canvas.superResolve.run")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function ParameterField({ parameter, value, onChange }: { parameter: UpscaleParameter; value: unknown; onChange: (value: unknown) => void }) {
    const { t } = useTranslation();
    if (parameter.type === "select") {
        return (
            <label className="flex flex-col gap-1 text-xs opacity-75">
                <span>{parameter.label}</span>
                <Select
                    size="small"
                    value={String(value ?? "")}
                    options={(parameter.options || []).map((option) => ({ value: optionValue(option), label: optionLabel(option) }))}
                    onChange={onChange}
                />
            </label>
        );
    }
    if (parameter.type === "boolean") {
        return (
            <label className="flex flex-col gap-1 text-xs opacity-75">
                <span>{parameter.label}</span>
                <Select
                    size="small"
                    value={value ? "true" : "false"}
                    options={[
                        { value: "true", label: t("common.yes") },
                        { value: "false", label: t("common.no") },
                    ]}
                    onChange={(next) => onChange(next === "true")}
                />
            </label>
        );
    }
    if (parameter.type === "number") {
        return (
            <label className="flex flex-col gap-1 text-xs opacity-75">
                <span>{parameter.label}</span>
                <InputNumber size="small" min={parameter.min} max={parameter.max} step={parameter.step} value={Number(value) || 0} onChange={(next) => onChange(Number(next) || 0)} />
            </label>
        );
    }
    return (
        <label className="flex flex-col gap-1 text-xs opacity-75">
            <span>{parameter.label}</span>
            <input className="rounded-md border border-current/20 bg-transparent px-2 py-1" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        </label>
    );
}
