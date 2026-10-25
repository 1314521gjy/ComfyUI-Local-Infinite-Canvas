import { app } from "../../scripts/app.js";

const LOADED_KEY = "__localCanvasOpenWorkflowLoaded";
const PARAM_ID = "local_canvas_open";
const PARAM_GATEWAY = "local_canvas_gw";
const DEBOUNCE_MS = 900;
const FALLBACK_MS = 12000;

function showError(message) {
  console.error("[LocalCanvas]", message);
  const banner = document.createElement("div");
  banner.textContent = `本地无限画布：${message}`;
  Object.assign(banner.style, {
    position: "fixed",
    left: "50%",
    bottom: "28px",
    transform: "translateX(-50%)",
    zIndex: "100000",
    padding: "10px 16px",
    borderRadius: "10px",
    background: "#3b1f1f",
    color: "#ffd7d7",
    border: "1px solid #a55",
    font: "13px/1.4 system-ui, sans-serif",
    boxShadow: "0 10px 40px rgba(0,0,0,.45)",
    maxWidth: "70vw",
  });
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 10000);
}

function readTarget() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get(PARAM_ID);
  if (!id) return null;
  let gateway;
  try {
    gateway = new URL(params.get(PARAM_GATEWAY) || "", window.location.href);
  } catch {
    return null;
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") return null;
  const sameHost = gateway.hostname === window.location.hostname;
  const loopback = gateway.hostname === "127.0.0.1" || gateway.hostname === "localhost" || gateway.hostname === "::1" || gateway.hostname === "[::1]";
  if (!sameHost && !loopback) return null;
  return { id, gateway: gateway.origin };
}

function cleanUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM_ID);
  url.searchParams.delete(PARAM_GATEWAY);
  window.history.replaceState(window.history.state, "", url.toString());
}

function looksLikeApiWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((node) => node && typeof node === "object" && typeof node.class_type === "string");
}

async function loadRequestedWorkflow() {
  if (window[LOADED_KEY]) return;
  const target = readTarget();
  if (!target) return;
  window[LOADED_KEY] = true;
  try {
    const response = await fetch(`${target.gateway}/api/free-workflows/${encodeURIComponent(target.id)}/ui`, { cache: "no-store" });
    if (!response.ok) throw new Error(`网关返回 HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.workflow) throw new Error("工作流内容为空");
    if (data.format === "api" || looksLikeApiWorkflow(data.workflow)) {
      await app.loadApiJson(data.workflow, data.name || "自由工作流");
    } else {
      await app.loadGraphData(data.workflow, true, true, data.sourceRel || null);
    }
    cleanUrl();
  } catch (error) {
    window[LOADED_KEY] = false;
    showError(`无法自动打开工作流「${target.id}」：${error?.message || error}`);
  }
}

let timer = null;
function scheduleLoad(delay = DEBOUNCE_MS) {
  if (window[LOADED_KEY]) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void loadRequestedWorkflow();
  }, delay);
}

app.registerExtension({
  name: "LocalCanvas.OpenWorkflow",
  setup() {
    if (readTarget()) scheduleLoad(FALLBACK_MS);
  },
  afterLoadGraph() {
    // ComfyUI restores the last session / workflow tabs after app.setup().
    // Debouncing the loader until those loads settle keeps our target workflow
    // as the active one instead of being replaced by the restored session.
    if (readTarget()) scheduleLoad();
  },
});
