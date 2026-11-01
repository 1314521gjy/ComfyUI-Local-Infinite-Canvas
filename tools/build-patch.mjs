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
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${version}`)) {
    console.error(`CHANGELOG.md 缺少 ${version} 条目；请先补 CHANGELOG 再构建补丁`);
    process.exit(1);
}
const distIndexPath = path.join(root, "infinite-canvas", "web", "dist", "index.html");
const distIndex = fs.readFileSync(distIndexPath, "utf8");
const jsAsset = distIndex.match(/\/assets\/(index-[^"]+\.js)/);
if (!jsAsset) {
    console.error("dist/index.html 没有引用 index JS，前端 dist 不完整");
    process.exit(1);
}
const jsText = fs.readFileSync(path.join(root, "infinite-canvas", "web", "dist", "assets", jsAsset[1]), "utf8");
if (!jsText.includes(version)) {
    console.error(`前端 dist 不是 ${version} 构建（${jsAsset[1]} 中找不到版本号）；请先改 VERSION/CHANGELOG，再 npm run build，最后打补丁`);
    process.exit(1);
}
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
    "comfyui-gateway/comfyui-bridge",
    "comfyui-gateway/scripts",
    "comfyui-gateway/prompts",
    "comfyui-gateway/workflows",
    "comfyui-gateway/workflow-baseline.json",
    "comfyui-gateway/resources/index.json",
    "comfyui-gateway/resources/nodes",
    "comfyui-gateway/package.json",
    "comfyui-gateway/package-lock.json",
    "assistant",
    "infinite-canvas/web/dist",
    "infinite-canvas/VERSION",
];

const EXCLUDE = [
    /^update\.json$/i,
    /^data(\/|$)/i,
    /^models(\/|$)/i,
    /^node(\/|$)/i,
    /(^|\/)\.git(\/|$)/i,
    /(^|\/)\.(?:npmrc|yarnrc|pnpmrc)$/i,
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i,
    /(^|\/)[^/]+\.(?:key|p12|pfx|jks|keystore|ppk)$/i,
    /(^|\/)[^/]*(?:private|secret)[^/]*\.pem$/i,
    /^\.update/i,
    /^launcher\/config\.json$/i,
    /^launcher\/.*\.log$/i,
    /^launcher\/.*\.bak.*$/i,
    /^\u521b\u5efa\u684c\u9762\u5feb\u6377\u65b9\u5f0f\.vbs$/,
    // 运行时配置由启动器按实际端口生成，补丁不能覆盖。
    /^infinite-canvas\/web\/dist\/config\.js$/i,
    /node_modules(\/|$)/i,
    /^assistant\/(workspace|data|backups|logs)(\/|$)/i,
    /^assistant\/runtime\.(zip|json)$/i,
    /^assistant\/.*\.log$/i,
    /^assistant\/fixes\.json$/i,
    /^comfyui-gateway\/resources\/nodes\/unpacked\/TE_MAN\/data(\/|$)/i,
    /^comfyui-gateway\/resources\/nodes\/unpacked\/TE_MAN\/te_bernini_backend\/text_embed_cache(\/|$)/i,
    /^comfyui-gateway\/resources\/nodes\/unpacked\/TE_MAN\/config[^/]*\.ini$/i,
    /\.db(?:-wal|-shm|-journal)?$/i,
    /resources\/bundled(\/|$)/i,
    /__pycache__(\/|$)/i,
    /\.pyc$/i,
];

function placeholderSecret(value) {
    const text = String(value || "").trim();
    if (text.length < 16) return true;
    return /example|sample|placeholder|dummy|test|fake|your[_ -]?|you[ru]|xxx|changeme|change[_ -]?me|replace|redacted|masked|insert|fill[_ -]?in|todo|process\.env|<|\$\{|\.\.\.|^\*+$|^x+$/i.test(text)
        || /^0+$/.test(text)
        || /^123[0-9a-z]*$/i.test(text);
}

function obviousSecretKind(text) {
    const privateKey = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;
    for (const match of text.matchAll(privateKey)) {
        const body = match[1].replace(/[^A-Za-z0-9+/=]/g, "");
        if (body.length >= 64 && !placeholderSecret(match[1])) return "私钥内容";
    }
    const patterns = [
        { kind: "AWS Access Key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
        { kind: "GitHub Token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,255}\b/g },
        { kind: "OpenAI 兼容密钥", regex: /\bsk-[A-Za-z0-9_-]{20,512}\b/g },
    ];
    for (const { kind, regex } of patterns) {
        for (const match of text.matchAll(regex)) {
            if (!placeholderSecret(match[0])) return kind;
        }
    }
    const assignment = /(?:^|[\s,{;])["']?([A-Za-z][A-Za-z0-9_]{2,64})["']?\s*[:=]\s*["']([^"'\r\n]{8,512})["']/g;
    for (const match of text.matchAll(assignment)) {
        const normalized = match[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        if (!/(^|_)(api_?key|access_?key|secret_?key|private_?key|auth_?key|token|secret|password|passwd|credential)$/.test(normalized)) continue;
        // 以 sha/md5/hash 等结尾的是摘要字段（如 private_key_sha256），不是密钥本体。
        if (/(?:^|_)(?:sha1|sha224|sha256|sha384|sha512|md5|hash|checksum|digest)$/i.test(normalized)) continue;
        // UI 文案/说明文字含空格或中文，不是可直接使用的密钥。
        if (/[\s\u4e00-\u9fff]/.test(match[2])) continue;
        if (!placeholderSecret(match[2])) return `疑似密钥配置（${match[1]}）`;
    }
    return "";
}

async function scanForObviousSecrets(source, rel) {
    const stat = await fsp.stat(source);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    const content = await fsp.readFile(source);
    if (content.includes(0)) return;
    const kind = obviousSecretKind(content.toString("utf8"));
    if (kind) throw new Error(`补丁包含${kind}：${rel}；请移除秘密后再构建`);
}

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
    if (stat.isSymbolicLink()) throw new Error(`待打包路径是符号链接，补丁可能会缺文件：${source}`);
    const rel = path.relative(root, source).replace(/\\/g, "/");
    if (EXCLUDE.some((pattern) => pattern.test(rel))) return;
    await scanForObviousSecrets(source, rel);
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
        if (!fs.existsSync(source)) throw new Error(`缺少待打包文件：${entry}`);
        await copyEntry(source, path.join(patchRoot, entry));
    }
    if (deleteFile) {
        const content = await fsp.readFile(path.resolve(deleteFile), "utf8");
        await fsp.writeFile(path.join(patchRoot, "PATCH-DELETE.txt"), content.replace(/\r?\n/g, "\n"), "utf8");
    }
    // 补丁必须包含所有运行时入口；缺一个都可能让用户升级后打不开。
    for (const required of [
        "VERSION",
        "launcher/start.mjs",
        "comfyui-gateway/src/server.js",
        "comfyui-gateway/workflows/registry.json",
        "infinite-canvas/web/dist/index.html",
    ]) {
        if (!fs.existsSync(path.join(patchRoot, required))) throw new Error(`补丁缺少运行时文件：${required}`);
    }
    // dist 入口引用的 JS/CSS 必须真的在补丁里，避免只发 index.html 或漏 asset。
    const patchIndex = await fsp.readFile(path.join(patchRoot, "infinite-canvas", "web", "dist", "index.html"), "utf8");
    for (const match of patchIndex.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
        const rel = match[1].replace(/^\/+/, "");
        if (!fs.existsSync(path.join(patchRoot, "infinite-canvas", "web", "dist", rel))) {
            throw new Error(`补丁缺少 dist 资源：${match[1]}`);
        }
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.rm(out, { force: true });
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
    // 输出必须放在 patch-root 之外，否则压缩包会把自己也打进去。
    execFileSync(tar, ["-a", "-c", "-f", archiveName, "-C", patchRoot, "."], { cwd: tempRoot, timeout: 300000 });
    // 解压后仍不能出现用户数据/依赖/运行时配置；PATCH_PROTECTED 不是唯一防线。
    const archiveList = execFileSync(tar, ["-tf", archivePath], { cwd: tempRoot, encoding: "utf8", timeout: 300000 })
        .split(/\r?\n/)
        .map((line) => line.replace(/^\.\//, "").replace(/\\/g, "/"))
        .filter(Boolean);
    const forbidden = archiveList.filter((rel) =>
        /^(data|models|node|comfyui-gateway\/data|comfyui-gateway\/node_modules|launcher\/config\.json|infinite-canvas\/web\/dist\/config\.js)(\/|$)/i.test(rel) ||
        /(^|\/)node_modules(\/|$)/i.test(rel) ||
        /\.env(?:\.|$)/i.test(rel)
    );
    if (forbidden.length) throw new Error(`补丁包含禁止发布的路径：${forbidden.slice(0, 8).join(", ")}`);
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
