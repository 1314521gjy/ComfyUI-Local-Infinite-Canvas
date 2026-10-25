function positiveInt(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function linkedNode(workflow, input) {
  if (!Array.isArray(input) || !input.length) return null;
  return workflow?.[String(input[0])] || null;
}

function sigmaSteps(workflow, node) {
  if (!node) return 0;
  const inputs = node.inputs || {};
  if (node.class_type === "ManualSigmas") {
    const values = String(inputs.sigmas || "").split(/[,\s]+/).map(Number).filter(Number.isFinite);
    return Math.max(0, values.length - 1);
  }
  if (node.class_type === "BasicScheduler") return positiveInt(inputs.steps);
  if (node.class_type === "H3SigmaRefiner") {
    return sigmaSteps(workflow, linkedNode(workflow, inputs.sigmas)) + positiveInt(inputs.extra_steps);
  }
  return 0;
}

/** Per-sampler step counts, so a multi-stage workflow maps onto one continuous bar. */
export function estimateStepPlan(workflow) {
  const steps = {};
  const absolute = {};
  let total = 0;
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const inputs = node?.inputs || {};
    let value = 0;
    if (node?.class_type === "KSampler") {
      value = positiveInt(inputs.steps);
    } else if (node?.class_type === "KSamplerAdvanced") {
      const count = positiveInt(inputs.steps);
      const start = Math.max(0, Math.floor(Number(inputs.start_at_step) || 0));
      const end = Math.min(count, Math.floor(Number(inputs.end_at_step) || count));
      value = Math.max(0, end - start);
    } else if (node?.class_type === "SamplerCustomAdvanced") {
      value = sigmaSteps(workflow, linkedNode(workflow, inputs.sigmas));
    } else if (node?.class_type === "SelfLiftH3Sampler") {
      value = sigmaSteps(workflow, linkedNode(workflow, inputs.sigmas));
      // SelfLift reports the low-res stage against its own shorter total, then the
      // high-res stage continues from transition_step. Its value is a global step index.
      if (value > 0) absolute[nodeId] = true;
    }
    if (value > 0) {
      steps[nodeId] = value;
      total += value;
    }
  }
  return { total, steps, absolute };
}
