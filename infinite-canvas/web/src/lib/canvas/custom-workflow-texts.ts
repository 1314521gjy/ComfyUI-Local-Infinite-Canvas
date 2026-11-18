import type { FreeWorkflowTextBinding, FreeWorkflowTextInput } from "@/services/api/free-workflow";
import { customWorkflowView, type CustomWorkflow } from "@/stores/use-custom-workflow-store";

export type CustomTextRequest = {
    texts: Array<{ node: string; input: string; value: string }>;
    primaryText: FreeWorkflowTextBinding | null;
};

const keyOf = (item: { node: string; input: string }) => `${item.node}\u0000${item.input}`;

// 卡片只发送当前页面已指定的标签；没指定时回退到工作流默认主提示词。
// 值按卡片独立，缺省值取工作流扫描时的默认值。
export function buildCustomTextRequest(workflow: CustomWorkflow, customTexts?: Record<string, string> | null): CustomTextRequest {
    const view = customWorkflowView(workflow);
    const candidates = view.textInputs || [];
    const selected = (view.textSelection || [])
        .map((key) => candidates.find((item) => keyOf(item) === key))
        .filter((item): item is FreeWorkflowTextInput => Boolean(item));
    const defaultPrimary = view.primaryText
        ? candidates.find((item) => keyOf(item) === keyOf(view.primaryText!))
        : undefined;
    const tabs = selected.length ? selected : defaultPrimary ? [defaultPrimary] : candidates.slice(0, 1);
    const values = customTexts || {};
    const texts = tabs.map((item) => ({
        node: item.node,
        input: item.input,
        value: String(values[keyOf(item)] ?? item.default ?? ""),
    }));
    const primary = selected[0] || defaultPrimary || tabs[0] || null;
    return {
        texts,
        primaryText: primary ? { node: primary.node, input: primary.input } : null,
    };
}
