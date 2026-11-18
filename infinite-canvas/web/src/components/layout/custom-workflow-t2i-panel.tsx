import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { CustomWorkflowParamPanel } from "@/components/layout/custom-workflow-param-panel";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { FreeWorkflowGraphInput, FreeWorkflowGraphNode, FreeWorkflowParam } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";
import type { CustomWorkflowSpan } from "@/stores/use-custom-workflow-store";

type AvailableInput = { node: FreeWorkflowGraphNode; input: FreeWorkflowGraphInput };

type CustomWorkflowT2iPanelProps = {
    config: AiConfig;
    onConfigChange?: (key: keyof AiConfig, value: string) => void;
    readOnly?: boolean;
    fields: FreeWorkflowParam[];
    layout: string[];
    spans: Record<string, CustomWorkflowSpan>;
    availableInputs: AvailableInput[];
    onAddInput: (node: FreeWorkflowGraphNode, input: FreeWorkflowGraphInput, index: number) => string;
    onRemoveField: (key: string) => void;
    onUpdateField: (key: string, patch: Partial<FreeWorkflowParam>) => void;
    onReorderField: (key: string, index: number) => void;
    onSpanChange: (key: string, span: CustomWorkflowSpan) => void;
};

export function CustomWorkflowT2iPanel({ config, onConfigChange, readOnly = true, fields, layout, spans, availableInputs, onAddInput, onRemoveField, onUpdateField, onReorderField, onSpanChange }: CustomWorkflowT2iPanelProps) {
    const theme = useCanvasTheme();
    return (
        <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
            <div className={`shrink-0 px-1 ${readOnly ? "pointer-events-none" : ""}`} aria-hidden={readOnly || undefined}>
                <ImageSettingsPanel config={config} onConfigChange={onConfigChange || (() => undefined)} theme={theme} showTitle showSize showResolution showRatio showTransparent showCount showSeed className="space-y-4" />
            </div>
            <div className="flex min-h-[320px] flex-1 flex-col">
                <CustomWorkflowParamPanel fields={fields} layout={layout} spans={spans} availableInputs={availableInputs} onAddInput={onAddInput} onRemoveField={onRemoveField} onUpdateField={onUpdateField} onReorderField={onReorderField} onSpanChange={onSpanChange} />
            </div>
        </div>
    );
}
