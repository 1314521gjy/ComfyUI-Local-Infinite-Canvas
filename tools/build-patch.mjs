#!/usr/bin/env node
// 从发布仓位生成代码补丁（真实 zip），并可选写回 update.json。
// 用法：node tools/build-patch.mjs --root <staging> [--out patches/v0.21.4.zip] [--write-manifest] [--delete PATCH-DELETE.txt]

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function arg(name, fallback = "") {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] || fallback : fallback;
}
const root = path.resolve(arg("root", ""));
if (!root || !fs.existsSync(path.join(root, "VERSION"))) {
    console.error("缺少 --root（需指向包含 VERSION 的发布仓位）");
    process.exit(1);
}
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const out = path.resolve(arg("out", path.join("patches", `${version}.zip`)));
const writeManifest = args.includes("--write-manifest");
const deleteFile = arg("delete", "");
const patchBase = arg("base", "https://modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/resolve/master");

const INCLUDE = [
    "VERSION",
    "CHANGELOG.md",
    "README.md",
    "LICENSE",
    "NOTICE.md",
    "THIRD_PARTY_NOTICES.md",
    "start-local.bat",
    "launcher",
    "comfyui-gateway/src",
    "comfyui-gateway/scripts",
    "comfyui-gateway/prompts",
    "comfyui-gateway/workflows",
    "comfyui-gateway/resources/index.json",
    "comfyui-gateway/resources/nodes",
    "comfyui-gateway/package.json",
    "comfyui-gateway/package-lock.json",
    "infinite-canvas/web/dist",
    "infinite-canvas/VERSION",
];

const EXCLUDE = [
    /^update\.json$/i,
    /^data(\/|$)/i,
    /^models(\/|$)/i,
    /^node(\/|$)/i,
    /^\.git(\/|$)/i,
    /^\.update/i,
    /^launcher\/config\.json$/i,
    /^launcher\/.*\.log$/i,
    /^launcher\/.*\.bak.*$/i,
    /^\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f\.vbs$/,
    /node_modules(\/|$)/i,
    /resources\/bundled(\/|$)/i,
    /__pycache__(\/|$)/i,
    /\.pyc$/i,
];

async function copyEntry(source, destination) {
    const stat = await fsp.lstat(source).catch(() => null);
    if (!stat) throw new Error(`缺少待打包文件：${source}`);
    if (stat.isDirectory()) {
        const entries = await fsp.readdir(source, { withFileTypes: true });
        for (const entry of entries) {
            const rel = path.relative(root, path.join(source, entry.name)).replace(/\\/g, "/");
            if (EXCLUDE.some((pattern) => pattern.test(rel))) continue;
            await copyEntry(path.join(source, entry.name), path.join(destination, entry.name));
        }
        return;
    }
    if (stat.isSymbolicLink()) return;
    const rel = path.relative(root, source).replace(/\\/g, "/");
    if (EXCLUDE.some((pattern) => pattern.test(rel))) return;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wujie-patch-"));
const patchRoot = path.join(tempRoot, "patch-root");
const archiveName = "patch.zip";
const archivePath = path.join(tempRoot, archiveName);
try {
    for (const entry of INCLUDE) {
        const source = path.join(root, entry);
        if (!fs.existsSync(source)) {
            console.warn(`跳过不存在的项：${entry}`);
            continue;
        }
        await copyEntry(source, path.join(patchRoot, entry));
    }
    if (deleteFile) {
        const content = await fsp.readFile(path.resolve(deleteFile), "utf8");
        await fsp.writeFile(path.join(patchRoot, "PATCH-DELETE.txt"), content.replace(/\r?\n/g, "\n"), "utf8");
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.rm(out, { force: true });
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
    // 输出必须放在 patch-root 之外，否则压缩包会把自己也打进去。
    execFileSync(tar, ["-a", "-c", "-f", archiveName, "-C", patchRoot, "."], { cwd: tempRoot, timeout: 300000 });
    await fsp.copyFile(archivePath, out);
} finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

const bytes = fs.statSync(out).size;
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
let manifest = null;
if (writeManifest) {
    const manifestPath = path.join(root, "update.json");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = version;
    const now = new Date();
    manifest.publishedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    manifest.patch = {
        url: `${patchBase}/patches/${version}.zip`,
        sha256,
        size: bytes,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ ok: true, version, out, size: bytes, sha256, manifestWritten: Boolean(manifest) }, null, 2));
