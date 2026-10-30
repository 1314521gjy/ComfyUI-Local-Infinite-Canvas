#!/usr/bin/env node
// 生成 comfyui-gateway/workflow-baseline.json：
// previous = 最近几个发布版本的官方 workflow 哈希（用于判断本地是否被用户改过）
// current  = 当前工作区的官方 workflow 哈希（下一次升级使用）
// 用法：node tools/build-workflow-baseline.mjs --root . --previous 46c2284 --previous 800a65f
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function values(name) {
    const out = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === `--${name}` && args[index + 1]) out.push(args[index + 1]);
    }
    return out;
}
const root = path.resolve(values("root")[0] || "");
const previousRefs = values("previous");
if (!root || !fs.existsSync(path.join(root, "comfyui-gateway"))) {
    console.error("缺少 --root（需指向发布仓位根目录）");
    process.exit(1);
}
const workflowDir = path.join(root, "comfyui-gateway", "workflows");
const files = fs
    .readdirSync(workflowDir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort();

function hash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

const previous = {};
for (const name of files) {
    const rel = `comfyui-gateway/workflows/${name}`;
    const hashes = new Set();
    for (const ref of previousRefs) {
        try {
            const buffer = execFileSync("git", ["show", `${ref}:${rel}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
            hashes.add(hash(buffer));
        } catch {
            // 该版本没有这个文件（新增工作流）。
        }
    }
    if (hashes.size) previous[rel] = [...hashes];
}
const current = {};
for (const name of files) {
    const rel = `comfyui-gateway/workflows/${name}`;
    current[rel] = hash(fs.readFileSync(path.join(workflowDir, name)));
}
const target = path.join(root, "comfyui-gateway", "workflow-baseline.json");
fs.writeFileSync(
    target,
    `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), previous, current }, null, 2)}\n`,
    "utf8",
);
console.log(JSON.stringify({ ok: true, target, files: files.length, previousRefs: previousRefs.length }, null, 2));
