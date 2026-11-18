import { reconcileWorkflowFields } from "@/lib/canvas/custom-workflow-fields";
import { fetchFreeWorkflowGraph } from "@/services/api/free-workflow";
import type { AiConfig } from "@/stores/use-config-store";
import { customWorkflowView, useCustomWorkflowStore, type CustomWorkflow } from "@/stores/use-custom-workflow-store";

/** 设置面板直接打开时也补一次字段选项，避免要先进一次参数披露才变成下拉。 */
export async function refreshWorkflowFieldOptions(config: AiConfig, workflow: CustomWorkflow) {
    const view = customWorkflowView(workflow);
    const params = view.params || [];
    if (!params.some((field) => !(field.options || []).length)) return false;
    const page = view.flows?.find((flow) => flow.id === view.flowId);
    const pageId = page && !page.main ? view.flowId || "" : "";
    const graph = await fetchFreeWorkflowGraph(config, view.freeId, pageId);
    const reconciled = reconcileWorkflowFields(params, graph);
    if (!reconciled.some((field, index) => field !== params[index])) return false;
    const fieldLayout = (view.blocks || []).filter((id) => id.startsWith("field:")).map((id) => id.slice("field:".length));
    useCustomWorkflowStore.getState().setParams(view.id, reconciled, fieldLayout, view.spans || {}, view.blocks || []);
    return true;
}
