#!/usr/bin/env node
// 组装 Agent 运行时 zip：服务源码 + 依赖 + 工作区源码/构建依赖。
// 用法：node tools/build-assistant-runtime.mjs --root <staging> [--out assistant/runtime.zip]
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] || fallback : fallback;
};
const root = path.resolve(arg("root", ""));
if (!root || !fs.existsSync(path.join(root, "VERSION"))) {
    console.error("缺少 --root（需指向包含 VERSION 的发布树）");
    process.exit(1);
}
const assistantDir = path.join(root, "assistant");
const depsDir = path.resolve(arg("assistant-deps", path.join(root, "..", "07842353-assistant-trial", "node_modules")));
const webModulesDir = path.resolve(arg("workspace-node-modules", path.join(root, "infinite-canvas", "web", "node_modules")));
const out = path.resolve(arg("out", path.join(assistantDir, "runtime.zip")));
const sourceFiles = ["server.mjs", "diagnostics.mjs", "repair-tools.mjs", "skill.mjs", "package.json", "package-lock.json"];
for (const file of sourceFiles) {
    if (!fs.existsSync(path.join(assistantDir, file))) throw new Error(`缺少 assistant/${file}`);
}
if (!fs.existsSync(path.join(depsDir, "@mariozechner", "pi-agent-core"))) throw new Error(`Agent 依赖目录不完整：${depsDir}`);
if (!fs.existsSync(path.join(webModulesDir, "vite"))) throw new Error(`前端构建依赖不完整：${webModulesDir}`);

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "assistant-runtime-"));
const payload = path.join(temp, "payload");
const log = (message) => console.log(`[assistant-runtime] ${message}`);
try {
    await fsp.mkdir(payload, { recursive: true });
    for (const file of sourceFiles) await fsp.copyFile(path.join(assistantDir, file), path.join(payload, file));
    log(`复制 Agent 服务依赖：${depsDir}`);
    await fsp.cp(depsDir, path.join(payload, "node_modules"), { recursive: true, dereference: true, force: true });
    log("同步工作区源码");
    const workspace = path.join(payload, "workspace");
    await fsp.mkdir(path.join(workspace, "infinite-canvas", "web"), { recursive: true });
    await fsp.cp(path.join(root, "infinite-canvas", "web"), path.join(workspace, "infinite-canvas", "web"), {
        recursive: true,
        dereference: false,
        force: true,
        filter: (source) => !/[\\/](node_modules|dist|\.next)([\\/]|$)/.test(source),
    });
    for (const file of ["VERSION", "CHANGELOG.md", "README.md"]) {
        await fsp.copyFile(path.join(root, file), path.join(workspace, file));
    }
    await fsp.mkdir(path.join(workspace, "infinite-canvas"), { recursive: true });
    await fsp.copyFile(path.join(root, "infinite-canvas", "VERSION"), path.join(workspace, "infinite-canvas", "VERSION"));
    log(`复制前端构建依赖：${webModulesDir}`);
    await fsp.cp(webModulesDir, path.join(workspace, "infinite-canvas", "web", "node_modules"), { recursive: true, dereference: true, force: true });
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.rm(out, { force: true });
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
    log("压缩运行时（这一步通常需要几分钟）");
    execFileSync(tar, ["-a", "-c", "-f", out, "-C", payload, "."], { timeout: 1_200_000, stdio: "inherit" });
    const stat = fs.statSync(out);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
    log(`完成：${out} ${stat.size} B sha256=${sha256}`);
    console.log(JSON.stringify({ ok: true, out, size: stat.size, sha256 }, null, 2));
} finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
}
