function problemText(problems) {
  return (Array.isArray(problems) ? problems : [])
    .map((problem) => String(problem?.message || "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("；");
}

// 网关是最后一道闸门：旧页面、直接 API 和缓存模型列表都可能提交当前不可用的工作流。
// 这里只返回可序列化的问题描述，由 server 转成 409，避免把原始 ComfyUI 校验错误丢给用户。
export function workflowAvailabilityProblem(setup, entry, { mode = "", allowUnavailable = false } = {}) {
  if (allowUnavailable || !entry || typeof setup?.workflowStatus !== "function") return null;
  const status = setup.workflowStatus(entry.id) || {};
  if (status.available === false) {
    const detail = problemText(status.problems) || "工作流所需的模型或节点尚未就绪";
    return {
      code: "workflow_unavailable",
      message: `模型 ${entry.name || entry.id} 当前不可用：${detail}。请在资源中心补齐缺失项，或重新扫描后再试。`,
      details: { workflowId: entry.id, problems: status.problems || [] },
    };
  }
  const variant = mode ? status.variants?.[mode] : null;
  if (variant && variant.available === false) {
    const detail = problemText(variant.problems) || "该功能所需的模型或节点尚未就绪";
    return {
      code: "workflow_mode_unavailable",
      message: `模型 ${entry.name || entry.id} 的「${mode}」功能当前不可用：${detail}。请在资源中心补齐缺失项，或重新扫描后再试。`,
      details: { workflowId: entry.id, mode, problems: variant.problems || [] },
    };
  }
  return null;
}
