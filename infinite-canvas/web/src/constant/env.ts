export const APP_VERSION = __APP_VERSION__ || "dev";

export const GITHUB_REPO_URL = import.meta.env.VITE_GITHUB_REPO_URL || "https://github.com/1314521gjy/ComfyUI-Local-Infinite-Canvas";

export const GITHUB_REPO_RAW_URL = import.meta.env.VITE_GITHUB_REPO_RAW_URL || "https://raw.githubusercontent.com/1314521gjy/ComfyUI-Local-Infinite-Canvas/main";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Official plugin registry URL: CI publishes to plugins-dist for jsDelivr delivery; an environment variable may override it for self-hosting.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";
