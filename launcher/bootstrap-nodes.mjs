import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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

async function extractZip(archive, destination) {
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.mkdir(destination, { recursive: true });
    try {
        await run("tar", ["-xf", archive, "-C", destination]);
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

export async function installBundledNodes({ root, comfyRoot, log = console.log } = {}) {
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
        const bundled = (resource.sources || []).find((source) => source && typeof source === "object" && (source.kind === "bundled" || source.path));
        if (!bundled) continue;
        const archive = path.resolve(gatewayRoot, String(bundled.path || "").replace(/^[/\\]+/, ""));
        if (!isFile(archive)) {
            log(`[bootstrap] 缺少内置节点包：${resource.id}`, "WARN");
            continue;
        }
        const temp = path.join(root, "launcher", ".bootstrap", `${resource.id}-${process.pid}-${Date.now()}`);
        try {
            await fsp.mkdir(temp, { recursive: true });
            await extractZip(archive, temp);
            const sourceDir = await findNodeRoot(temp);
            if (!sourceDir) throw new Error("没有找到 __init__.py");
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.cp(sourceDir, target, { recursive: true, force: false, errorOnExist: false });
            installed.push(resource.label || resource.id);
            log(`[bootstrap] 已放置内置节点：${resource.label || resource.id}`);
        } catch (error) {
            log(`[bootstrap] 节点放置失败 ${resource.id}：${error.message}`, "WARN");
        } finally {
            await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
        }
    }
    return installed;
}
