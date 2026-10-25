import { deepClone } from "./util.js";

const MODEL_LOADERS = new Set(["UNETLoader", "CheckpointLoaderSimple", "CheckpointLoader"]);

export class LoraInjectionError extends Error {
  constructor(message, { status = 400, code = "lora_injection_failed" } = {}) {
    super(message);
    this.name = "LoraInjectionError";
    this.status = status;
    this.code = code;
  }
}

function normalizeLoras(params) {
  if (!params || typeof params !== "object") return [];
  const list = Array.isArray(params.loras) ? params.loras : [];
  const result = [];
  for (const item of list) {
    if (!item || item.enabled === false) continue;
    const name = String(item.name || item.lora_name || "").trim();
    if (!name) continue;
    const strength = Number(item.strength ?? item.strength_model ?? 1);
    result.push({ name, strength: Number.isFinite(strength) ? strength : 1 });
  }
  return result;
}

function nextNodeId(workflow) {
  let max = 0;
  for (const id of Object.keys(workflow || {})) {
    if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
  }
  let next = Math.max(max + 1, 9000);
  while (workflow[String(next)]) next += 1;
  return String(next);
}

function findModelSource(workflow, preferredId) {
  if (preferredId && workflow[String(preferredId)]) return String(preferredId);
  const candidates = Object.entries(workflow)
    .filter(([, node]) => MODEL_LOADERS.has(node?.class_type))
    .map(([id]) => String(id));
  if (!candidates.length) return null;
  const references = new Map(candidates.map((id) => [id, 0]));
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node?.inputs || {})) {
      if (!Array.isArray(value) || value.length < 2 || Number(value[1]) !== 0) continue;
      const source = String(value[0]);
      if (references.has(source)) references.set(source, references.get(source) + 1);
    }
  }
  const ranked = candidates
    .filter((id) => references.get(id) > 0)
    .sort((a, b) => {
      const score = references.get(b) - references.get(a);
      if (score) return score;
      if (workflow[a].class_type === "UNETLoader") return -1;
      if (workflow[b].class_type === "UNETLoader") return 1;
      return a.localeCompare(b);
    });
  return ranked[0] || null;
}

/**
 * 把 params.loras 插到模型加载器后面，返回克隆后的工作流。
 * 不修改工作流文件；每次请求独立生成 LoRA 链。
 */
export function applyLoraChain(workflow, params, { available, filter, sourceNode, loaderClass = "LoraLoaderModelOnly" } = {}) {
  const loras = normalizeLoras(params);
  if (!loras.length) return { workflow, applied: [] };
  const next = deepClone(workflow || {});
  const sourceId = findModelSource(next, sourceNode);
  if (!sourceId) {
    throw new LoraInjectionError("LoRA 无法注入：工作流里没有可识别的模型加载器");
  }
  const allowed = filter ? new RegExp(filter, "i") : null;
  for (const lora of loras) {
    if (allowed && !allowed.test(lora.name)) {
      throw new LoraInjectionError(`LoRA ${lora.name} 不适用于当前模型`);
    }
    if (Array.isArray(available) && available.length && !available.includes(lora.name)) {
      throw new LoraInjectionError(`LoRA 不存在：${lora.name}`);
    }
  }

  const targets = [];
  for (const node of Object.values(next)) {
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      if (Array.isArray(value) && value.length >= 2 && String(value[0]) === sourceId && Number(value[1]) === 0) {
        targets.push({ node, input });
      }
    }
  }
  if (!targets.length) {
    throw new LoraInjectionError("LoRA 无法注入：模型加载器没有下游消费者");
  }

  let last = [sourceId, 0];
  const applied = [];
  for (const lora of loras) {
    const id = nextNodeId(next);
    next[id] = {
      class_type: loaderClass,
      inputs: {
        model: last,
        lora_name: lora.name,
        strength_model: lora.strength,
      },
      _meta: { title: `LoRA ${pathName(lora.name)}` },
    };
    last = [id, 0];
    applied.push({ id, ...lora });
  }
  for (const { node, input } of targets) node.inputs[input] = last;
  return { workflow: next, applied };
}

function pathName(name) {
  return String(name || "").split(/[\\/]/).pop() || "LoRA";
}
