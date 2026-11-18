import { Select } from "antd";

import { ImageSettingsTheme, SettingTitle } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { isModelFileInput } from "@/lib/canvas/custom-workflow-fields";
import type { FreeWorkflowParam } from "@/services/api/free-workflow";
import type { CustomWorkflow } from "@/stores/use-custom-workflow-store";

type CustomWorkflowParamsSectionProps = {
    workflow: CustomWorkflow;
    values: Record<string, unknown>;
    theme: CanvasTheme;
    onChange: (params: Record<string, unknown>) => void;
};

export function ParamControl({ param, value, onChange, theme }: { param: FreeWorkflowParam; value: unknown; onChange: (value: unknown) => void; theme: CanvasTheme }) {
    if (param.type === "select") {
        if (!param.options?.length) {
            return <span className="max-w-[150px] truncate text-[11px]" style={{ color: theme.node.muted }} title="没有拿到可选项，重新扫描工作流">{String(value ?? "—")}</span>;
        }
        return (
            <Select
                size="small"
                showSearch
                optionFilterProp="label"
                popupMatchSelectWidth={false}
                dropdownStyle={{ zIndex: 1400 }}
                className="w-full min-w-0"
                value={String(value ?? "")}
                options={param.options.map((option) => ({ value: option, label: option }))}
                onChange={onChange}
            />
        );
    }
    if (param.type === "boolean") {
        return <input type="checkbox" className="size-4 accent-emerald-600" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
    }
    if (param.type === "string" && isModelFileInput(param.input)) {
        const current = String(value ?? "");
        const options = param.options || [];
        if (!options.length) {
            return (
                <div className="space-y-0.5">
                    <input
                        type="text"
                        className="h-7 w-full min-w-0 rounded-md border bg-transparent px-1.5 text-right text-xs outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        value={current}
                        onChange={(event) => onChange(event.target.value)}
                    />
                    <span className="block truncate text-[10px] leading-3 text-red-500">没有拿到可用模型列表，可直接输入文件名</span>
                </div>
            );
        }
        const inList = options.includes(current);
        const list = inList ? options : current ? [current, ...options] : options;
        return (
            <Select
                size="small"
                showSearch
                optionFilterProp="label"
                popupMatchSelectWidth={false}
                dropdownStyle={{ zIndex: 1400 }}
                className="w-full min-w-0"
                value={current}
                options={list.map((option) => ({ value: option, label: option === current && !inList ? `${option}（当前 / 不在列表）` : option }))}
                onChange={onChange}
            />
        );
    }
    if (param.type === "string") {
        return (
            <input
                type="text"
                className="h-7 w-full min-w-0 rounded-md border bg-transparent px-1.5 text-right text-xs outline-none"
                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                value={String(value ?? "")}
                onChange={(event) => onChange(event.target.value)}
            />
        );
    }
    return (
        <input
            type="number"
            className="h-7 w-full min-w-0 rounded-md border bg-transparent px-1.5 text-right text-xs outline-none"
            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
            value={value === undefined ? "" : String(value)}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
    );
}

export function CustomWorkflowParamsSection({ workflow, values, theme, onChange }: CustomWorkflowParamsSectionProps) {
    const setValue = (key: string, value: unknown) => {
        const next = { ...values };
        if (value === "" || value === undefined || value === null) delete next[key];
        else next[key] = value;
        onChange(next);
    };
    const byKey = new Map(workflow.params.map((param) => [param.key, param]));
    const layout = workflow.layout?.length ? workflow.layout : workflow.params.map((param) => param.key);
    const blocks = layout.map((key) => byKey.get(key)).filter((param): param is FreeWorkflowParam => Boolean(param));
    if (blocks.length) {
        return (
            <ImageSettingsTheme theme={theme}>
                <div className="grid grid-cols-2 gap-2" style={{ gridAutoRows: "minmax(44px, auto)", color: theme.node.text }}>
                    {blocks.map((param) => {
                        const span = workflow.spans?.[param.key] || { w: 1, h: 1 };
                        return (
                            <div key={param.key} className="flex h-full min-w-0 flex-col justify-center gap-1 rounded-xl px-2.5 py-1.5" style={{ gridColumn: `span ${span.w}`, gridRow: `span ${span.h}`, background: theme.node.fill, color: theme.node.text }}>
                                <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }} title={`${param.group} · ${param.label}`}>{param.label}</span>
                                <ParamControl param={param} value={values[param.key] ?? param.value} onChange={(value) => setValue(param.key, value)} theme={theme} />
                            </div>
                        );
                    })}
                </div>
            </ImageSettingsTheme>
        );
    }
    const groups = new Map<string, FreeWorkflowParam[]>();
    for (const param of workflow.params) {
        const group = param.group || "参数";
        groups.set(group, [...(groups.get(group) || []), param]);
    }
    if (!groups.size) return null;
    return (
        <ImageSettingsTheme theme={theme}>
            <div className="space-y-4" style={{ color: theme.node.text }}>
                {[...groups.entries()].map(([group, params]) => (
                    <div key={group} className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>{group}</SettingTitle>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                            {params.map((param) => (
                                <label key={param.key} className="flex min-w-0 items-center justify-between gap-2 rounded-xl px-2.5 py-1.5" style={{ background: theme.node.fill, color: theme.node.text }}>
                                    <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }} title={param.label}>{param.label}</span>
                                    <ParamControl param={param} value={values[param.key] ?? param.value} onChange={(value) => setValue(param.key, value)} theme={theme} />
                                </label>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </ImageSettingsTheme>
    );
}
