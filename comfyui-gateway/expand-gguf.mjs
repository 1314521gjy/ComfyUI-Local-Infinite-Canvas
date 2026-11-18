import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertUiWorkflow } from "./src/ui-workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const SRC_DIR = "D:/ComfyUI/ComfyUI/user/default/workflows/";
const OUT_DIR = path.join(__dirname, "workflows");

const TARGETS = [
  { src: "Qwen-Image-2.1-T2I-GGUF-Multi-Queue.json", out: "qwen21-t2i-gguf.json", label: "Qwen Image 2.1 T2I GGUF" },
  { src: "Qwen-Image-2.1-I2I-GGUF-Multi-Queue.json", out: "qwen21-i2i-gguf.json", label: "Qwen Image 2.1 I2I GGUF" },
];

async function getObjectInfo() {
  const r = await fetch(`${COMFY}/object_info`);
  if (!r.ok) throw new Error(`object_info HTTP ${r.status}`);
  return await r.json();
}

function arrayLinkId(l) {
  return Array.isArray(l) ? l[0] : l?.id;
}
function linkFrom(l) {
  return Array.isArray(l) ? l[1] : l?.from;
}
function linkFromSlot(l) {
  return Array.isArray(l) ? l[2] : l?.fromSlot;
}
function linkTo(l) {
  return Array.isArray(l) ? l[3] : l?.to;
}
function linkToSlot(l) {
  return Array.isArray(l) ? l[4] : l?.toSlot;
}

function expandSubgraphs(ui) {
  const clone = JSON.parse(JSON.stringify(ui));
  const defs = clone.definitions?.subgraphs || [];
  if (!defs.length) return clone;
  let parentNodes = clone.nodes;
  let parentLinks = (clone.links || []).map((l) => (Array.isArray(l) ? l : [l.id, l.from, l.fromSlot, l.to, l.toSlot, l.type]));
  let maxNodeId = Math.max(0, ...parentNodes.map((n) => Number(n.id) || 0));
  let maxLinkId = Math.max(0, ...parentLinks.map((l) => Number(l[0]) || 0));
  let linkCounter = maxLinkId;

  for (const def of defs) {
    const sgid = def.id;
    const inst = parentNodes.find((n) => n.type === sgid);
    if (!inst) continue;
    const internalRaw = def.nodes.filter((n) => n.id !== -10 && n.id !== -20);
    const base = maxNodeId + 1;
    const idMap = new Map();
    for (const n of internalRaw) idMap.set(n.id, base + Number(n.id));

    const newParentLinks = [];
    const internalNodes = internalRaw.map((n) => JSON.parse(JSON.stringify(n)));

    for (const rawL of def.links || []) {
      const L = Array.isArray(rawL) ? rawL : rawL;
      const oid = Array.isArray(rawL) ? rawL[1] : rawL.origin_id;
      const os = Array.isArray(rawL) ? rawL[2] : rawL.origin_slot;
      const tid = Array.isArray(rawL) ? rawL[3] : rawL.target_id;
      const ts = Array.isArray(rawL) ? rawL[4] : rawL.target_slot;
      const ltype = Array.isArray(rawL) ? rawL[5] : rawL.type;

      if (oid === -10) {
        const instInput = (inst.inputs || [])[os];
        if (instInput && instInput.link != null) {
          const P = parentLinks.find((p) => p[0] === instInput.link);
          if (P) {
            const id = ++linkCounter;
            newParentLinks.push([id, P[1], P[2], idMap.get(tid), ts, ltype]);
            const tNode = internalNodes.find((n) => n.id === tid);
            if (tNode && Array.isArray(tNode.inputs) && tNode.inputs[ts]) tNode.inputs[ts].link = id;
          }
        } else {
          const tNode = internalNodes.find((n) => n.id === tid);
          if (tNode && Array.isArray(tNode.inputs) && tNode.inputs[ts]) {
            const name = tNode.inputs[ts].name;
            const named = (inst.widgets_values_named && inst.widgets_values_named[name] !== undefined)
              ? inst.widgets_values_named[name]
              : (inst.widgets_values ? inst.widgets_values[os] : undefined);
            tNode.widgets_values_named = tNode.widgets_values_named || {};
            if (named !== undefined) tNode.widgets_values_named[name] = named;
            tNode.inputs[ts].link = null;
          }
        }
      } else if (tid === -20) {
        const instOutput = (inst.outputs || [])[ts];
        const consumers = (instOutput && instOutput.links) || [];
        for (const clid of consumers) {
          const P = parentLinks.find((p) => p[0] === clid);
          if (!P) continue;
          const id = ++linkCounter;
          newParentLinks.push([id, idMap.get(oid), os, P[3], P[4], ltype]);
          const pNode = parentNodes.find((n) => n.id === P[3]);
          if (pNode && Array.isArray(pNode.inputs) && pNode.inputs[P[4]]) pNode.inputs[P[4]].link = id;
        }
      } else {
        const id = ++linkCounter;
        newParentLinks.push([id, idMap.get(oid), os, idMap.get(tid), ts, ltype]);
        const tNode = internalNodes.find((n) => n.id === tid);
        if (tNode && Array.isArray(tNode.inputs) && tNode.inputs[ts]) tNode.inputs[ts].link = id;
      }
    }

    // remap internal node ids
    for (const n of internalNodes) n.id = idMap.get(n.id);
    // drop instance + its links
    parentNodes = parentNodes.filter((n) => n !== inst);
    parentLinks = parentLinks.filter((p) => p[3] !== inst.id && p[1] !== inst.id);
    parentNodes = parentNodes.concat(internalNodes);
    parentLinks = parentLinks.concat(newParentLinks);
    maxNodeId = Math.max(maxNodeId, ...internalNodes.map((n) => Number(n.id)));
    maxLinkId = Math.max(maxLinkId, ...newParentLinks.map((l) => l[0]));
  }

  delete clone.definitions;
  clone.nodes = parentNodes;
  clone.links = parentLinks;
  return clone;
}

function dumpWorkflow(workflow) {
  const rows = [];
  for (const [id, node] of Object.entries(workflow)) {
    const ins = Object.entries(node.inputs || {})
      .filter(([, v]) => typeof v !== "object" || Array.isArray(v))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v[0]},${v[1]}]` : JSON.stringify(v)}`);
    rows.push(`  ${id} ${node.class_type} { ${ins.join(", ")} }`);
  }
  return rows.join("\n");
}

function normalizeSchedulers(workflow) {
  const VALID = new Set(["simple", "sgm_uniform", "karras", "exponential", "ddim_uniform", "beta", "normal", "linear_quadratic", "kl_optimal"]);
  for (const node of Object.values(workflow)) {
    if (node?.class_type === "KSampler" && node.inputs?.scheduler != null && !VALID.has(node.inputs.scheduler)) {
      node.inputs.scheduler = "simple";
    }
  }
}

async function main() {
  const objectInfo = await getObjectInfo();
  for (const t of TARGETS) {
    const ui = JSON.parse(fs.readFileSync(path.join(SRC_DIR, t.src), "utf8"));
    const flat = expandSubgraphs(ui);
    const hasSub = (flat.definitions?.subgraphs || []).length;
    const { workflow, warnings } = convertUiWorkflow(flat, objectInfo);
    normalizeSchedulers(workflow);
    fs.writeFileSync(path.join(OUT_DIR, t.out), JSON.stringify(workflow, null, 2));
    console.log(`\n===== ${t.label} (${t.out}) =====`);
    console.log(`subgraphs remaining: ${hasSub}`);
    console.log("warnings:", JSON.stringify(warnings));
    console.log(dumpWorkflow(workflow));
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
