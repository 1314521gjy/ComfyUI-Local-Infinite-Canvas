import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(webDir, "../..");
const versionPath = existsSync(resolve(appRoot, "VERSION")) ? resolve(appRoot, "VERSION") : resolve(webDir, "../VERSION");
const changelogPath = existsSync(resolve(appRoot, "CHANGELOG.md")) ? resolve(appRoot, "CHANGELOG.md") : resolve(webDir, "../CHANGELOG.md");
const localVersion = readFileSync(versionPath, "utf8").trim() || "dev";
const localChangelog = readFileSync(changelogPath, "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    // 重新构建时保留旧 hash 资源，已打开的页面不会被新包打断（刷新后走新入口）。
    build: { emptyOutDir: false },
    plugins: [react(), localPluginsManifest()],
    server: {
        host: "127.0.0.1",
        port: 5199,
        strictPort: true,
        fs: { allow: [webDir, resolve(webDir, "..")] },
        proxy: {
            "/api": { target: "http://127.0.0.1:8190", changeOrigin: true },
            "/v1": { target: "http://127.0.0.1:8190", changeOrigin: true },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
