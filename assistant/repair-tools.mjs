import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Type } from "@mariozechner/pi-ai";

const MAX_READ_BYTES = 260_000;
const MAX_WRITE_BYTES = 500_000;
const MAX_LIST_ENTRIES = 220;
const MAX_SEARCH_FILES = 1500;
const MAX_SEARCH_RESULTS = 60;
const MAX_REMOTE_BYTES = 260_000;
const TEXT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".less",
    ".json", ".md", ".txt", ".yaml", ".yml", ".html", ".svg", ".xml",
    ".py", ".ps1", ".bat", ".sh", ".toml", ".ini", ".gitignore", ".example",
]);
const DENY_SEGMENTS = new Set([".git", "node_modules", "data", "models", "backups", ".assistant-backups", "dist", ".update-backup", "output", ".assistant-downloads"]);
const DENY_FILES = new Set(["profiles.local.json", "launcher/config.json", ".env"]);
const REMOTE_ALLOW = [
    { host: "modelscope.cn", prefix: "/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/" },
    { host: "www.modelscope.cn", prefix: "/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/" },
    { host: "raw.githubusercontent.com", prefix: "/1314521gjy/ComfyUI-Local-Infinite-Canvas/" },
];

function clip(value, size) {
    const text = String(value || "");
    return text.length > size ? `${text.slice(0, size)}…` : text;
}

function normalizeRelative(value) {
    return String(value || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/^(\.\/)+/, "");
}

function resolveInside(root, relative) {
    const rel = normalizeRelative(relative);
    if (!rel || rel === ".") return root;
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error("只接受工作区内的相对路径");
    const parts = rel.split("/");
    for (const part of parts) {
        if (!part || part === ".") continue;
        if (part === "..") throw new Error("路径不能跳出工作区");
        if (DENY_SEGMENTS.has(part.toLowerCase())) throw new Error(`禁止访问目录：${part}`);
    }
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("路径不能跳出工作区");
    if (DENY_FILES.has(rel.toLowerCase())) throw new Error(`禁止访问文件：${rel}`);
    if (/(^|\/)\.env(\.|$)/i.test(rel)) throw new Error("禁止访问环境变量文件");
    return target;
}

function assertTextFile(file, rel) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(path.basename(file).toLowerCase())) {
        throw new Error(`只支持文本源码文件：${rel}`);
    }
}

function readTextFile(file, rel) {
    assertTextFile(file, rel);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`不是文件：${rel}`);
    if (stat.size > MAX_READ_BYTES) throw new Error(`文件过大：${rel}（${stat.size} B）`);
    return fs.readFileSync(file, "utf8");
}

function walk(root, relative, depth, list, maxDepth) {
    if (list.length >= MAX_LIST_ENTRIES) return;
    const dir = resolveInside(root, relative);
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (list.length >= MAX_LIST_ENTRIES) return;
        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (entry.isDirectory() && DENY_SEGMENTS.has(name.toLowerCase())) continue;
        if (entry.isFile() && DENY_FILES.has(name.toLowerCase())) continue;
        const rel = normalizeRelative(path.posix.join(relative, name));
        if (entry.isDirectory()) {
            list.push({ path: `${rel}/`, type: "dir" });
            if (depth < maxDepth) walk(root, rel, depth + 1, list, maxDepth);
        } else {
            let size = 0;
            try {
                size = fs.statSync(path.join(dir, name)).size;
            } catch {
                size = 0;
            }
            list.push({ path: rel, type: "file", size });
        }
    }
}

function collectTextFiles(root, relative, out) {
    if (out.length >= MAX_SEARCH_FILES) return;
    const dir = resolveInside(root, relative);
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_SEARCH_FILES) return;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && DENY_SEGMENTS.has(entry.name.toLowerCase())) continue;
        if (entry.isFile() && DENY_FILES.has(entry.name.toLowerCase())) continue;
        const rel = normalizeRelative(path.posix.join(relative, entry.name));
        if (entry.isDirectory()) {
            collectTextFiles(root, rel, out);
            continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(entry.name.toLowerCase())) continue;
        out.push(rel);
    }
}

function remoteAllowed(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    const rule = REMOTE_ALLOW.find((item) => item.host === parsed.hostname.toLowerCase());
    if (!rule) return false;
    return parsed.pathname.startsWith(rule.prefix);
}

async function fetchText(url) {
    if (!remoteAllowed(url)) throw new Error("只允许读取本项目在魔搭/GitHub 的源码地址");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "text/plain, application/json, text/markdown" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_REMOTE_BYTES) throw new Error("远程文件过大");
        return text;
    } finally {
        clearTimeout(timer);
    }
}

function runNpm(webDir, kind) {
    return new Promise((resolve) => {
        const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "sh";
        const args = process.platform === "win32" ? ["/d", "/s", "/c", `npm run ${kind}`] : ["-lc", `npm run ${kind}`];
        execFile(
            command,
            args,
            { cwd: webDir, timeout: kind === "build" ? 360000 : 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
            (error, stdout, stderr) => {
                const output = `${stdout || ""}\n${stderr || ""}`.trim();
                resolve({ ok: !error, code: error?.code ?? 0, output: output.length > 6000 ? output.slice(-6000) : output });
            },
        );
    });
}

function runGitStatus(workspaceRoot) {
    return new Promise((resolve) => {
        execFile("git", ["status", "--short", "--", "."], { cwd: workspaceRoot, timeout: 20000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
            resolve({ ok: !error, output: `${stdout || ""}\n${stderr || ""}`.trim().slice(0, 6000) });
        });
    });
}

function makeProposal(root, summary, edits) {
    const prepared = [];
    for (const edit of edits) {
        const rel = normalizeRelative(edit.path);
        const file = resolveInside(root, rel);
        assertTextFile(file, rel);
        if (!rel.startsWith("infinite-canvas/web/")) {
            throw new Error("本版只自动应用画布前端源码（infinite-canvas/web）；网关/启动器/其他目录请先只给方案，不自动部署");
        }
        if (/^infinite-canvas\/web\/(vite|postcss|tailwind|tsconfig[^/]*\.json|package(-lock)?\.json|pnpm-lock\.yaml|bun\.lock|index\.html)$/i.test(rel)) {
            throw new Error("不能修改构建配置、依赖清单或入口 HTML；这些文件会影响构建/执行安全");
        }
        if (["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].includes(path.basename(file).toLowerCase())) {
            throw new Error("不能直接修改依赖清单或锁文件；需要新依赖时先征得用户同意");
        }
        const exists = fs.existsSync(file);
        const isCreate = edit.create === true;
        if (isCreate) {
            if (exists) throw new Error(`文件已存在，不能按新建处理：${rel}`);
            prepared.push({
                path: rel,
                isCreate: true,
                oldContent: "",
                newContent: String(edit.replace || ""),
                search: "",
                replace: String(edit.replace || ""),
                oldPreview: "",
                newPreview: clip(edit.replace, 500),
            });
            continue;
        }
        if (!exists) throw new Error(`文件不存在：${rel}`);
        const oldContent = readTextFile(file, rel);
        const search = String(edit.search || "");
        if (!search) throw new Error(`修改 ${rel} 需要 search 原文`);
        const first = oldContent.indexOf(search);
        if (first < 0) throw new Error(`${rel} 中找不到 search 原文`);
        if (oldContent.indexOf(search, first + search.length) >= 0) throw new Error(`${rel} 中 search 原文出现多次，请给更长的上下文`);
        const newContent = `${oldContent.slice(0, first)}${String(edit.replace ?? "")}${oldContent.slice(first + search.length)}`;
        if (Buffer.byteLength(newContent, "utf8") > MAX_WRITE_BYTES) throw new Error(`${rel} 修改后文件过大`);
        if (newContent === oldContent) throw new Error(`${rel} 没有产生变化`);
        prepared.push({
            path: rel,
            isCreate: false,
            oldContent,
            newContent,
            search,
            replace: String(edit.replace ?? ""),
            oldPreview: clip(search, 500),
            newPreview: clip(String(edit.replace ?? ""), 500),
        });
    }
    if (prepared.length > 8) throw new Error("一次最多提议 8 个文件修改");
    return {
        id: randomUUID(),
        summary: clip(summary, 500) || "画布修复",
        edits: prepared,
        createdAt: Date.now(),
        status: "pending",
    };
}

export function createRepairTools({ workspaceRoot, proposals, webDir, beforeBuild, runTask }) {
    const root = path.resolve(workspaceRoot);
    const runBuild = async (kind) => {
        if (kind === "build" && typeof beforeBuild === "function") {
            const allowed = await beforeBuild();
            if (!allowed?.ok) throw new Error(allowed?.reason || "当前环境不适合构建");
        }
        if (typeof runTask === "function") return runTask(kind);
        return runNpm(webDir, kind);
    };
    return [
        {
            name: "list_workspace",
            label: "查看工作区",
            description: "列出画布修复工作区内的目录和文本源码文件。参数 path 为相对路径，默认根目录；不会进入 node_modules/.git/data/models。",
            parameters: Type.Object({
                path: Type.Optional(Type.String({ description: "相对路径，默认 ." })),
                depth: Type.Optional(Type.Number({ description: "递归深度 0-4，默认 2" })),
            }),
            execute: async (_id, params) => {
                const list = [];
                walk(root, params.path || "", 0, list, Math.max(0, Math.min(4, Number(params.depth ?? 2))));
                return { content: [{ type: "text", text: JSON.stringify({ workspace: root, entries: list }, null, 2) }], details: {} };
            },
        },
        {
            name: "read_source",
            label: "读取源码",
            description: "读取工作区内的文本源码。返回真实内容，不做行号改写；大文件请配合 search_source 定位。",
            parameters: Type.Object({
                path: Type.String({ description: "相对路径" }),
                startLine: Type.Optional(Type.Number({ description: "起始行，1 开始" })),
                endLine: Type.Optional(Type.Number({ description: "结束行" })),
            }),
            execute: async (_id, params) => {
                const rel = normalizeRelative(params.path);
                const file = resolveInside(root, rel);
                const content = readTextFile(file, rel);
                const lines = content.split(/\r?\n/);
                const start = Math.max(1, Number(params.startLine || 1));
                const end = Math.min(lines.length, Number(params.endLine || Math.min(lines.length, start + 500)));
                const body = lines.slice(start - 1, end).join("\n");
                return {
                    content: [{ type: "text", text: `# ${rel} (lines ${start}-${end}/${lines.length})\n${body}` }],
                    details: { path: rel, totalLines: lines.length },
                };
            },
        },
        {
            name: "search_source",
            label: "搜索源码",
            description: "在工作区内按普通文本搜索（不区分大小写），返回 path:line 和上下文片段。",
            parameters: Type.Object({
                query: Type.String({ description: "要搜索的文本" }),
                path: Type.Optional(Type.String({ description: "限定相对目录，默认全工作区" })),
            }),
            execute: async (_id, params) => {
                const query = String(params.query || "").trim();
                if (!query) throw new Error("query 为空");
                const files = [];
                collectTextFiles(root, params.path || "", files);
                const matches = [];
                for (const rel of files) {
                    if (matches.length >= MAX_SEARCH_RESULTS) break;
                    let content = "";
                    try {
                        content = readTextFile(path.resolve(root, rel), rel);
                    } catch {
                        continue;
                    }
                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i += 1) {
                        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                            matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
                            if (matches.length >= MAX_SEARCH_RESULTS) break;
                        }
                    }
                }
                return { content: [{ type: "text", text: JSON.stringify({ query, matches }, null, 2) }], details: { count: matches.length } };
            },
        },
        {
            name: "read_remote_source",
            label: "读取官方源码",
            description: "读取无界工作台在魔搭或 GitHub 上的源码/更新说明，用于对比版本或移植修复。只允许本项目仓库的 https 地址。",
            parameters: Type.Object({
                url: Type.String({ description: "魔搭 resolve 或 GitHub raw 地址" }),
            }),
            execute: async (_id, params) => {
                const text = await fetchText(String(params.url || ""));
                const isLfs = /^version https:\/\/git-lfs\.github\.com\/spec\/v1/.test(text.trim());
                return {
                    content: [{ type: "text", text: isLfs ? "这是 Git LFS 指针，不是源码内容；请改用源码文件或 GitHub raw。" : clip(text, MAX_REMOTE_BYTES) }],
                    details: { lfs: isLfs },
                };
            },
        },
        {
            name: "propose_edit",
            label: "提出修复",
            description:
                "提出源码修改方案，但不会直接写入。每个 edit 用 path + search + replace 精确替换一次；新建文件用 create:true + replace。生成后必须等用户在卡片点「应用修复」。不要声称已经修改。",
            parameters: Type.Object({
                summary: Type.String({ description: "一句话说明这次修什么" }),
                edits: Type.Array(
                    Type.Object({
                        path: Type.String({ description: "工作区内相对路径" }),
                        search: Type.Optional(Type.String({ description: "要替换的原文；新建时省略" })),
                        replace: Type.String({ description: "替换后的内容；新建时为完整文件内容" }),
                        create: Type.Optional(Type.Boolean({ description: "是否新建文件" })),
                    }),
                    { minItems: 1, maxItems: 8 },
                ),
            }),
            execute: async (_id, params) => {
                const proposal = makeProposal(root, params.summary, params.edits || []);
                proposals.set(proposal.id, proposal);
                const files = proposal.edits.map((edit) => ({
                    path: edit.path,
                    isCreate: edit.isCreate,
                    oldPreview: edit.oldPreview,
                    newPreview: edit.newPreview,
                }));
                return {
                    content: [
                        {
                            type: "text",
                            text: `已生成修复方案 ${proposal.id}，涉及 ${files.length} 个文件。已等待用户在卡片点击「应用修复」，本轮没有写入任何文件。不要重复提交同一方案。`,
                        },
                    ],
                    details: { proposalId: proposal.id, summary: proposal.summary, files },
                };
            },
        },
        {
            name: "run_check",
            label: "运行检查",
            description: "在工作区运行只读检查：typecheck / build / git-diff。不能执行任意 shell；build 只写工作区 dist，不部署。",
            parameters: Type.Object({
                kind: Type.Union([Type.Literal("typecheck"), Type.Literal("build"), Type.Literal("git-diff")]),
            }),
            execute: async (_id, params) => {
                if (params.kind === "git-diff") {
                    const result = await runGitStatus(root);
                    return { content: [{ type: "text", text: result.output || "(clean)" }], details: result };
                }
                const result = await runBuild(params.kind);
                return {
                    content: [{ type: "text", text: JSON.stringify({ kind: params.kind, ok: result.ok, output: result.output }, null, 2) }],
                    details: result,
                };
            },
        },
    ];
}

export function applyProposalFiles({ proposal, workspaceRoot, backupRoot }) {
    const root = path.resolve(workspaceRoot);
    const backupDir = path.join(backupRoot, proposal.id);
    const plan = proposal.edits.map((edit) => {
        const file = resolveInside(root, edit.path);
        if (edit.isCreate) {
            if (fs.existsSync(file)) throw new Error(`文件已被创建，方案过期：${edit.path}`);
        } else {
            if (!fs.existsSync(file)) throw new Error(`文件已不存在，方案过期：${edit.path}`);
            const current = fs.readFileSync(file, "utf8");
            if (current !== edit.oldContent) throw new Error(`文件已被其他操作修改，请重新生成方案：${edit.path}`);
        }
        return { edit, file };
    });
    fs.mkdirSync(backupDir, { recursive: true });
    for (const { edit, file } of plan) {
        if (edit.isCreate) continue;
        const backupFile = path.join(backupDir, edit.path);
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.copyFileSync(file, backupFile);
    }
    const applied = [];
    for (const { edit, file } of plan) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, edit.newContent, "utf8");
        applied.push({ path: edit.path, isCreate: edit.isCreate });
    }
    return { backupDir, applied };
}

export function rollbackProposalFiles({ proposal, workspaceRoot, backupRoot }) {
    const root = path.resolve(workspaceRoot);
    const backupDir = path.join(backupRoot, proposal.id);
    for (const edit of proposal.edits) {
        const file = resolveInside(root, edit.path);
        if (edit.isCreate) {
            if (fs.existsSync(file)) fs.rmSync(file, { force: true });
            continue;
        }
        const backupFile = path.join(backupDir, edit.path);
        if (!fs.existsSync(backupFile)) throw new Error(`缺少回滚备份：${edit.path}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(backupFile, file);
    }
}
