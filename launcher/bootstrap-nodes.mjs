import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isDir(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

function run(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, ...options });
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += String(data); });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))));
    });
}

async function sha256File(file) {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
}

const BOOTSTRAP_MANIFEST = ".canvas-bootstrap.json";

async function writeJsonAtomic(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
        await fsp.writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
        await fsp.rename(temp, file);
    } finally {
        await fsp.rm(temp, { force: true }).catch(() => {});
    }
}

async function directoryManifest(directory, resource, version = "") {
    const files = {};
    const hash = crypto.createHash("sha256");
    const walk = async (dir, relative = "") => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            if (!relative && entry.name === BOOTSTRAP_MANIFEST) continue;
            if (entry.isSymbolicLink()) throw new Error(`节点目录包含符号链接：${rel}`);
            if (entry.isDirectory()) {
                files[`${rel}/`] = null;
                hash.update(`${rel}/\0\0`);
                await walk(full, rel);
            } else if (entry.isFile()) {
                const digest = await sha256File(full);
                files[rel] = digest;
                hash.update(`${rel}\0${digest}\0`);
            }
        }
    };
    await walk(directory);
    return { schema: 1, resourceId: resource.id, version: String(version || ""), sourceHash: hash.digest("hex"), files };
}

function readBootstrapManifest(file, resourceId) {
    try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (value?.schema !== 1 || value?.resourceId !== resourceId) return null;
        if (!/^[0-9a-f]{64}$/i.test(String(value.sourceHash || "")) || !value.files || typeof value.files !== "object") return null;
        return value;
    } catch {
        return null;
    }
}

async function extractZip(archive, destination) {
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.mkdir(destination, { recursive: true });
    try {
        await run("tar", ["-xf", path.basename(archive), "-C", destination.replace(/\\/g, "/")], { cwd: path.dirname(archive) });
    } catch (error) {
        const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
        const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
        await run(powershell, ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`]).catch(() => {
            throw new Error(`无法解压节点包：${error.message}`);
        });
    }
}

async function findNodeRoot(directory, depth = 0) {
    if (depth > 3) return "";
    if (isFile(path.join(directory, "__init__.py"))) return directory;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(directory, entry.name);
        if (isFile(path.join(candidate, "__init__.py"))) return candidate;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = await findNodeRoot(path.join(directory, entry.name), depth + 1);
        if (nested) return nested;
    }
    return "";
}

async function comfyHasClasses(comfyUrl, classes) {
    if (!comfyUrl || !classes.length) return false;
    for (const name of classes) {
        try {
            const res = await fetch(`${String(comfyUrl).replace(/\/+$/, "")}/object_info/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return false;
            const data = await res.json();
            if (!data || !data[name]) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export async function installBundledNodes({ root, comfyRoot, comfyUrl = "", customNodesDirs = [], log = console.log } = {}) {
    const gatewayRoot = path.join(root, "comfyui-gateway");
    const indexPath = path.join(gatewayRoot, "resources", "index.json");
    if (!comfyRoot || !isFile(indexPath)) return [];
    const defaultNodesRoot = path.join(comfyRoot, "custom_nodes");
    const configuredRoots = (Array.isArray(customNodesDirs) ? customNodesDirs : [])
        .map((dir) => {
            try {
                return path.resolve(String(dir));
            } catch {
                return "";
            }
        })
        .filter(Boolean);
    const manualRoots = configuredRoots.filter(isDir);
    if (configuredRoots.length && !manualRoots.length) {
        // 用户显式配置了插件目录但全部不可用：报错并跳过，不能静默写回默认目录。
        log(`[bootstrap] 手动插件目录不可用：${configuredRoots.join("、")}；已跳过随包节点复制，避免写入默认目录`, "WARN");
        return [];
    }
    for (const dir of configuredRoots.filter((item) => !isDir(item))) {
        log(`[bootstrap] 忽略不存在的手动插件目录：${dir}`, "WARN");
    }
    const nodeRoots = [...new Set([...manualRoots, defaultNodesRoot])];
    let index;
    try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    } catch (error) {
        log(`[bootstrap] 资源索引读取失败：${error.message}`, "WARN");
        return [];
    }
    const installed = [];
    for (const resource of index.resources || []) {
        if (resource.type !== "node" || resource.autoInstall !== true) continue;
        const parts = String(resource.target || "").replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts[0] !== "custom_nodes" || parts.length < 2 || parts.some((part) => part === ".." || part === ".")) continue;
        // 已装在任一插件根（手动目录或默认目录）时沿用原位置升级，不自动搬移。
        let targetRoot = "";
        let target = "";
        for (const base of nodeRoots) {
            const candidate = path.join(base, ...parts.slice(1));
            if (fs.existsSync(candidate)) {
                targetRoot = base;
                target = candidate;
                break;
            }
        }
        if (!target) {
            targetRoot = manualRoots[0] || defaultNodesRoot;
            target = path.join(targetRoot, ...parts.slice(1));
        }
        // 手动插件目录在别的盘时，临时目录和备份必须与之同盘。
        // 放在 custom_nodes 根内时用 .disabled 后缀，避免 ComfyUI 启动时把临时目录当插件导入。
        const insideCustomRoot = targetRoot !== defaultNodesRoot;
        const workRoot = insideCustomRoot ? targetRoot : comfyRoot;
        const installDirName = insideCustomRoot ? ".canvas-install.disabled" : ".canvas-install";
        const backupDirName = insideCustomRoot ? ".canvas-install-backups.disabled" : ".canvas-install-backups";
        // 用户可能已经装了同一个插件的另一个目录名；目标不存在时才按类跳过。
        const provides = Array.isArray(resource.provides) ? resource.provides.filter(Boolean) : [];
        if (!fs.existsSync(target) && provides.length && (await comfyHasClasses(comfyUrl, provides))) {
            log(`[bootstrap] 已由其他目录提供同类节点，跳过：${resource.label || resource.id}`);
            continue;
        }

        const bundleDir = resource.bundleDir
            ? path.resolve(gatewayRoot, String(resource.bundleDir).replace(/^[/\\]+/, ""))
            : "";
        const bundled = (resource.sources || []).find((source) => source && typeof source === "object" && (source.kind === "bundled" || source.path));
        const archive = bundled
            ? path.resolve(gatewayRoot, String(bundled.path || "").replace(/^[/\\]+/, ""))
            : "";
        if ((!bundleDir || !isDir(bundleDir)) && (!archive || !isFile(archive))) {
            log(`[bootstrap] 缺少内置节点文件：${resource.id}`, "WARN");
            continue;
        }

        // 复制/解压都在 ComfyUI 同盘完成，最后 rename 到 custom_nodes，避免跨盘失败和半成品目录。
        const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const installRoot = path.join(workRoot, installDirName, `${resource.id}-${nonce}`);
        const temp = path.join(installRoot, "payload");
        try {
            let prepared = false;
            if (bundleDir && isDir(bundleDir)) {
                await fsp.cp(bundleDir, temp, { recursive: true });
                prepared = true;
            }
            if (!prepared) {
                if (!archive || !isFile(archive)) throw new Error("缺少内置节点包");
                if (resource.size && fs.statSync(archive).size !== Number(resource.size)) throw new Error("内置节点包大小不一致");
                if (resource.sha256 && (await sha256File(archive)).toLowerCase() !== String(resource.sha256).toLowerCase()) throw new Error("内置节点包 SHA256 校验失败");
                await extractZip(archive, temp);
            }
            const sourceDir = await findNodeRoot(temp);
            if (!sourceDir) throw new Error("没有找到 __init__.py");
            const official = await directoryManifest(sourceDir, resource, resource.version || index.version);
            await fsp.mkdir(path.dirname(target), { recursive: true });

            if (fs.existsSync(target)) {
                const manifestPath = path.join(target, BOOTSTRAP_MANIFEST);
                const previous = readBootstrapManifest(manifestPath, resource.id);
                const current = await directoryManifest(target, resource).catch(() => null);
                const officialUnchanged = Boolean(previous && current && current.sourceHash === previous.sourceHash);
                if (officialUnchanged) {
                    if (current.sourceHash === official.sourceHash) continue;
                    // 仅受管且逐文件未改的官方目录可升级；旧目录改名保留，失败则恢复。
                    const backup = path.join(workRoot, backupDirName, `${resource.id}-${nonce}-previous`);
                    await fsp.mkdir(path.dirname(backup), { recursive: true });
                    await fsp.rename(target, backup);
                    try {
                        await fsp.rm(path.join(sourceDir, BOOTSTRAP_MANIFEST), { force: true });
                        await writeJsonAtomic(path.join(sourceDir, BOOTSTRAP_MANIFEST), official);
                        await fsp.rename(sourceDir, target);
                    } catch (error) {
                        await fsp.rename(backup, target).catch(() => {});
                        throw error;
                    }
                    installed.push(resource.label || resource.id);
                    log(`[bootstrap] 已升级未修改的内置节点，旧版备份：${backup}`);
                    continue;
                }
                if (!previous && current?.sourceHash === official.sourceHash && !fs.existsSync(manifestPath)) {
                    // 兼容旧版：内容与当前官方副本完全一致时才登记，不接管未知/用户目录。
                    await writeJsonAtomic(manifestPath, official);
                    continue;
                }
                const suffix = current?.sourceHash?.slice(0, 12) || "unreadable";
                const backup = path.join(workRoot, backupDirName, `${resource.id}-${suffix}-user`);
                if (!fs.existsSync(backup)) {
                    await fsp.mkdir(path.dirname(backup), { recursive: true });
                    await fsp.cp(target, backup, { recursive: true, errorOnExist: true });
                }
                log(`[bootstrap] 节点目录无可靠官方清单或已被用户修改，保留原目录并备份，未覆盖：${backup}`, "WARN");
                continue;
            }

            await fsp.rm(path.join(sourceDir, BOOTSTRAP_MANIFEST), { force: true });
            await writeJsonAtomic(path.join(sourceDir, BOOTSTRAP_MANIFEST), official);
            await fsp.rename(sourceDir, target);
            installed.push(resource.label || resource.id);
            log(`[bootstrap] 已放置内置节点：${resource.label || resource.id}`);
        } catch (error) {
            log(`[bootstrap] 节点放置失败 ${resource.id}：${error.message}`, "WARN");
        } finally {
            await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
            // 只删除空的工作目录，避免在用户插件根留下会被扫描的空目录。
            await fsp.rmdir(path.join(workRoot, installDirName)).catch(() => {});
        }
    }
    return installed;
}
