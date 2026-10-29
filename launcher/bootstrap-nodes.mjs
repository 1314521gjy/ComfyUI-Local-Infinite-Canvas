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

export async function installBundledNodes({ root, comfyRoot, comfyUrl = "", log = console.log } = {}) {
    const gatewayRoot = path.join(root, "comfyui-gateway");
    const indexPath = path.join(gatewayRoot, "resources", "index.json");
    if (!comfyRoot || !isFile(indexPath)) return [];
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
        const target = path.join(comfyRoot, "custom_nodes", ...parts.slice(1));
        if (isDir(target)) continue;
        // 用户可能已经装了同一个插件的另一个目录名；ComfyUI 能提供同样的类就不再重复复制。
        const provides = Array.isArray(resource.provides) ? resource.provides.filter(Boolean) : [];
        if (provides.length && (await comfyHasClasses(comfyUrl, provides))) {
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
        const installRoot = path.join(comfyRoot, ".canvas-install", `${resource.id}-${process.pid}-${Date.now()}`);
        const temp = path.join(installRoot, "payload");
        try {
            let prepared = false;
            if (bundleDir && isDir(bundleDir)) {
                await fsp.cp(bundleDir, temp, { recursive: true });
                prepared = true;
                log(`[bootstrap] 复制内置目录：${resource.label || resource.id}`);
            }
            if (!prepared) {
                if (!archive || !isFile(archive)) throw new Error("缺少内置节点包");
                if (resource.size && fs.statSync(archive).size !== Number(resource.size)) throw new Error("内置节点包大小不一致");
                if (resource.sha256 && (await sha256File(archive)).toLowerCase() !== String(resource.sha256).toLowerCase()) throw new Error("内置节点包 SHA256 校验失败");
                await extractZip(archive, temp);
            }
            const sourceDir = await findNodeRoot(temp);
            if (!sourceDir) throw new Error("没有找到 __init__.py");
            await fsp.mkdir(path.dirname(target), { recursive: true });
            if (isDir(target)) {
                log(`[bootstrap] 节点目录已存在，跳过：${resource.label || resource.id}`, "WARN");
                continue;
            }
            await fsp.rename(sourceDir, target);
            installed.push(resource.label || resource.id);
            log(`[bootstrap] 已放置内置节点：${resource.label || resource.id}`);
        } catch (error) {
            log(`[bootstrap] 节点放置失败 ${resource.id}：${error.message}`, "WARN");
        } finally {
            await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
    return installed;
}
