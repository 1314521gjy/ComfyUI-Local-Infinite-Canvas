import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let applying = false;
let updateProgress = { phase: "idle", percent: 0, downloaded: 0, total: 0, speed: 0, message: "", updatedAt: 0 };

function setUpdateProgress(patch) {
  updateProgress = { ...updateProgress, ...patch, updatedAt: Date.now() };
}

export function getUpdateProgress() {
  return { ...updateProgress };
}

function updateError(message, code = "update_failed", status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cleanVersion(value) {
  return String(value || "").trim();
}

function parseVersion(value) {
  const match = cleanVersion(value).match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function isGitRepo(config) {
  return fs.existsSync(path.join(config.appRoot, ".git"));
}

const PATCH_PROTECTED = [
  ".git",
  ".update",
  ".update-backup",
  "data",
  "models",
  "node",
  "update.json",
  "launcher/config.json",
  "infinite-canvas/web/dist/config.js",
  "launcher/launcher.log",
  "comfyui-gateway/data",
  "comfyui-gateway/node_modules",
  "comfyui-gateway/resources/bundled",
];

const PATCH_DELETE_LIST = "PATCH-DELETE.txt";

// 启动器每次启动都会重写这个文件；它被 git 跟踪时会让所有 git 安装永远显示“未提交修改”。
const RUNTIME_DIRTY_PATHS = ["infinite-canvas/web/dist/config.js"];

function isRuntimeDirtyPath(relative) {
  return RUNTIME_DIRTY_PATHS.includes(String(relative || "").replace(/\\/g, "/").replace(/^\/+/, ""));
}

function parseGitStatusPaths(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      let relative = line.slice(3).trim();
      if (relative.startsWith('"') && relative.endsWith('"')) relative = relative.slice(1, -1);
      const rename = relative.lastIndexOf(" -> ");
      if (rename >= 0) relative = relative.slice(rename + 4);
      return relative.replace(/\\/g, "/");
    })
    .filter(Boolean);
}

function isProtectedPath(relative) {
  const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return PATCH_PROTECTED.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadPatch(url, destination, expectedSize = 0, timeoutMs = 600000, onProgress = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("补丁下载超时")), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    const limit = Math.max(Number(expectedSize) || 0, 512 * 1024 * 1024);
    if (length && length > limit) throw new Error("补丁体积异常");
    if (!response.body) throw new Error("补丁响应没有内容");
    const total = length || Number(expectedSize) || 0;
    let received = 0;
    let lastAt = Date.now();
    let lastBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(new Error("补丁体积异常"));
          return;
        }
        const now = Date.now();
        if (now - lastAt >= 250) {
          onProgress?.({ downloaded: received, total, speed: (received - lastBytes) / ((now - lastAt) / 1000) });
          lastAt = now;
          lastBytes = received;
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination));
    onProgress?.({ downloaded: received, total: total || received, speed: 0 });
    return received;
  } finally {
    clearTimeout(timer);
  }
}

async function extractPatch(archive, destination) {
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });
  const errors = [];
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const bsdtar = path.join(systemRoot, "System32", "tar.exe");
  const tarCommand = process.platform === "win32" && fs.existsSync(bsdtar) ? bsdtar : "tar";
  try {
    await execFileAsync(tarCommand, ["-xf", path.basename(archive), "-C", destination], {
      cwd: path.dirname(archive),
      timeout: 120000,
      windowsHide: true,
    });
    return;
  } catch (error) {
    errors.push(`tar: ${String(error?.stderr || error?.message || error).trim()}`);
  }
  try {
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    await execFileAsync(
      powershell,
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`],
      { timeout: 120000, windowsHide: true },
    );
  } catch (error) {
    errors.push(`PowerShell: ${String(error?.stderr || error?.message || error).trim()}`);
    throw new Error(`补丁解压失败：${errors.join("；")}`);
  }
}

async function listFiles(root) {
  const files = [];
  const stack = [{ dir: root, rel: "" }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const full = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push({ dir: full, rel });
      else if (entry.isFile()) files.push({ rel, full });
    }
  }
  return files;
}

function git(config, args, timeoutMs = config.updateFetchTimeoutMs) {
  return execFileAsync("git", ["-C", config.appRoot, ...args], {
    cwd: config.appRoot,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function describeGitError(error) {
  return String(error?.stderr || error?.stdout || error?.message || "git 命令失败").trim();
}

function readLocalManifest(config) {
  const manifest = readJson(config.updateManifestPath);
  return manifest && typeof manifest === "object" ? manifest : null;
}

function readCurrentVersion(config) {
  const appVersion = readText(path.join(config.appRoot, "VERSION"));
  if (appVersion) return cleanVersion(appVersion);
  const canvasVersion = readText(path.join(config.appRoot, "infinite-canvas", "VERSION"));
  if (canvasVersion) return cleanVersion(canvasVersion);
  return cleanVersion(readLocalManifest(config)?.version) || "v0.0.0";
}

async function resolveBranch(config) {
  const remote = config.updateRemote;
  const candidates = [];
  if (config.updateBranch) candidates.push(config.updateBranch);
  try {
    const { stdout } = await git(config, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], 3000);
    const head = stdout.trim().replace(new RegExp(`^${remote}/`), "");
    if (head) candidates.push(head);
  } catch {
    // origin/HEAD 不存在时按 main/master 探测。
  }
  candidates.push("main", "master");
  const seen = new Set();
  for (const branch of candidates) {
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    try {
      await git(config, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`], 3000);
      return branch;
    } catch {
      // 试下一个分支。
    }
  }
  return config.updateBranch || "main";
}

async function readRemoteManifest(config, branch) {
  await git(config, ["fetch", "--quiet", "--prune", config.updateRemote, branch], config.updateFetchTimeoutMs);
  const ref = `${config.updateRemote}/${branch}`;
  try {
    const { stdout } = await git(config, ["show", `${ref}:update.json`], 10000);
    const manifest = JSON.parse(stdout);
    if (!manifest?.version) throw new Error("update.json 缺少 version");
    return manifest;
  } catch (error) {
    try {
      const { stdout } = await git(config, ["show", `${ref}:infinite-canvas/VERSION`], 10000);
      const version = stdout.trim();
      if (version) return { version };
    } catch {
      // 落到下面的统一错误。
    }
    throw error;
  }
}

async function readRemoteManifestNoFetch(config, branch) {
  try {
    const ref = `${config.updateRemote}/${branch}`;
    const { stdout } = await git(config, ["show", `${ref}:update.json`], 5000);
    const manifest = JSON.parse(stdout);
    return manifest?.version ? manifest : null;
  } catch {
    return null;
  }
}

async function fetchManifestUrl(config) {
  const urls = [config.updateManifestUrl, config.updateManifestUrlBackup].filter(Boolean);
  if (!urls.length) throw new Error("未配置更新清单地址");
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.updateFetchTimeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      if (!manifest?.version) throw new Error("update.json 缺少 version");
      return manifest;
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error.message}`);
    }
  }
  throw new Error(`更新清单不可用（${errors.join("；")}）`);
}

async function readPatchDeleteList(root) {
  try {
    const text = await fsp.readFile(path.join(root, PATCH_DELETE_LIST), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/\\/g, "/").replace(/^\/+/, ""));
  } catch {
    return [];
  }
}

async function syncLocalManifest(config) {
  if (!config.updateManifestUrl) return;
  try {
    const manifest = await fetchManifestUrl(config);
    await fsp.writeFile(config.updateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    // 本地清单只用于离线展示；下载失败不应让已完成的更新回滚。
  }
}

async function applyArchivePatch(config, { patch, version, dryRun = false }) {
  if (!patch?.url || !patch?.sha256) throw updateError("更新清单缺少代码补丁", "patch_missing");
  const staging = path.join(config.appRoot, ".update", version);
  const backupDir = path.join(config.appRoot, ".update-backup", version);
  const archive = path.join(staging, "patch.zip");
  const payload = path.join(staging, "payload");
  await fsp.mkdir(staging, { recursive: true });
  setUpdateProgress({ phase: "downloading", percent: 0, downloaded: 0, total: Number(patch.size) || 0, speed: 0, message: "" });
  let downloaded = 0;
  try {
    downloaded = await downloadPatch(patch.url, archive, Number(patch.size) || 0, config.updateApplyTimeoutMs || 600000, ({ downloaded: received, total, speed }) => {
      setUpdateProgress({
        phase: "downloading",
        downloaded: received,
        total,
        speed,
        percent: total ? Math.min(84, Math.round((received / total) * 84)) : 0,
      });
    });
    if (patch.size && downloaded !== Number(patch.size)) throw updateError(`补丁大小不一致（${downloaded} / ${patch.size}）`, "patch_size_mismatch");
    setUpdateProgress({ phase: "verifying", percent: 86, downloaded, total: Number(patch.size) || downloaded, speed: 0 });
    const digest = await sha256File(archive);
    if (digest.toLowerCase() !== String(patch.sha256).toLowerCase()) throw updateError("补丁 SHA256 校验失败", "patch_hash_mismatch");
    setUpdateProgress({ phase: "extracting", percent: 90, speed: 0 });
    await extractPatch(archive, payload);

    let payloadRoot = payload;
    let files = await listFiles(payload);
    if (!files.some((file) => file.rel === "VERSION" || file.rel === "comfyui-gateway")) {
      const entries = await fsp.readdir(payload, { withFileTypes: true }).catch(() => []);
      const dirs = entries.filter((entry) => entry.isDirectory());
      if (dirs.length === 1) {
        payloadRoot = path.join(payload, dirs[0].name);
        files = await listFiles(payloadRoot);
      }
    }
    const deleteList = await readPatchDeleteList(payloadRoot);
    const deleteSet = new Set(deleteList.map((rel) => rel.toLowerCase()));
    const candidates = files.filter(
      (file) => !isProtectedPath(file.rel) && file.rel !== PATCH_DELETE_LIST && !deleteSet.has(file.rel.toLowerCase()),
    );
    if (!candidates.length && !deleteList.length) throw updateError("补丁内没有可更新的文件", "patch_empty");
    if (dryRun) return { files: candidates.map((file) => file.rel), deleted: deleteList };

    setUpdateProgress({ phase: "applying", percent: 95, speed: 0 });

    const written = [];
    const backups = [];
    try {
      for (const relative of deleteList) {
        if (isProtectedPath(relative)) continue;
        const target = path.resolve(config.appRoot, relative);
        if (!target.startsWith(`${path.resolve(config.appRoot)}${path.sep}`)) throw updateError(`补丁路径非法：${relative}`, "patch_path_invalid");
        if (!fs.existsSync(target)) continue;
        const backup = path.join(backupDir, relative);
        await fsp.mkdir(path.dirname(backup), { recursive: true });
        await fsp.copyFile(target, backup);
        backups.push({ target, backup });
        await fsp.rm(target, { force: true });
      }
      for (const file of candidates) {
        const target = path.resolve(config.appRoot, file.rel);
        if (!target.startsWith(`${path.resolve(config.appRoot)}${path.sep}`)) throw updateError(`补丁路径非法：${file.rel}`, "patch_path_invalid");
        const backup = path.join(backupDir, file.rel);
        if (fs.existsSync(target)) {
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.copyFile(target, backup);
          backups.push({ target, backup });
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(file.full, target);
        written.push(target);
      }
    } catch (error) {
      for (const target of written.reverse()) {
        await fsp.rm(target, { force: true }).catch(() => {});
      }
      for (const item of backups.reverse()) {
        await fsp.mkdir(path.dirname(item.target), { recursive: true }).catch(() => {});
        await fsp.copyFile(item.backup, item.target).catch(() => {});
      }
      throw updateError(`补丁应用失败，已回滚：${error.message}`, "patch_apply_failed");
    }
    await syncLocalManifest(config);
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    setUpdateProgress({ phase: "done", percent: 100, speed: 0, message: "更新完成" });
    return { files: candidates.map((file) => file.rel), deleted: deleteList, changedFiles: candidates.length };
  } finally {
    await fsp.rm(payload, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compare the local manifest with the remote/tracking manifest.
 * A git install fetches only when fetchRemote is true; a plain archive install can use UPDATE_MANIFEST_URL.
 */
export async function checkForUpdate(config, { fetchRemote = false } = {}) {
  const currentVersion = readCurrentVersion(config);
  const installType = isGitRepo(config) ? "git" : "archive";
  const warnings = [];
  let manifest = readLocalManifest(config);
  let source = manifest ? "local" : "none";
  let dirty = false;
  let dirtyFiles = [];
  let ignoredDirtyFiles = [];
  let gitError = "";
  let branch = config.updateBranch;

  if (installType === "git") {
    branch = await resolveBranch(config);
    try {
      const status = await git(config, ["status", "--porcelain", "--untracked-files=no"], 8000);
      const changedPaths = parseGitStatusPaths(status.stdout);
      ignoredDirtyFiles = changedPaths.filter(isRuntimeDirtyPath);
      dirtyFiles = changedPaths.filter((relative) => !isRuntimeDirtyPath(relative));
      dirty = dirtyFiles.length > 0;
    } catch (error) {
      gitError = describeGitError(error);
      dirty = true;
      warnings.push(`无法读取 Git 状态：${gitError}`);
    }

    if (fetchRemote) {
      try {
        manifest = await readRemoteManifest(config, branch);
        source = "git";
      } catch (error) {
        warnings.push(`无法获取远端更新：${describeGitError(error)}`);
      }
    } else {
      const remoteManifest = await readRemoteManifestNoFetch(config, branch);
      if (remoteManifest) {
        manifest = remoteManifest;
        source = "git-tracking";
      }
    }
  } else if (fetchRemote && config.updateManifestUrl) {
    try {
      manifest = await fetchManifestUrl(config);
      source = "url";
    } catch (error) {
      warnings.push(`无法获取更新清单：${error.message}`);
    }
  }

  const latestVersion = cleanVersion(manifest?.version) || currentVersion;
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  let patch = null;
  const rawPatch = manifest?.patch && typeof manifest.patch === "object" ? manifest.patch : null;
  if (rawPatch?.url && rawPatch?.sha256) {
    try {
      patch = {
        url: new URL(String(rawPatch.url), config.updateManifestUrl || config.updateManifestUrlBackup || "https://modelscope.cn").toString(),
        sha256: String(rawPatch.sha256),
        size: Number(rawPatch.size) || 0,
      };
    } catch {
      patch = null;
    }
  }
  const patchAvailable = Boolean(patch);
  let applyReason = "";
  if (!config.updateEnabled) applyReason = "自动更新已关闭";
  else if (!updateAvailable) applyReason = "已是最新版本";
  else if (installType === "git" && gitError) applyReason = `Git 不可用：${gitError}`;
  else if (installType === "git" && dirty) applyReason = "工作区有未提交的修改，已拒绝自动更新";
  else if (installType !== "git" && !patchAvailable) applyReason = "当前安装不是 Git 克隆，且此版本没有代码补丁；请下载完整包";

  const canApply = config.updateEnabled && updateAvailable && (installType === "git" ? !dirty && !gitError : patchAvailable);
  // 真脏或 Git 不可用时，仍可用已签名的代码补丁强制更新；补丁只覆盖程序文件。
  const forceAvailable = Boolean(config.updateEnabled && updateAvailable && installType === "git" && patchAvailable && (dirty || gitError));
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    currentVersion,
    latestVersion,
    updateAvailable,
    canApply,
    applyReason,
    installType,
    source,
    dirty,
    dirtyFiles,
    ignoredDirtyFiles,
    gitError,
    forceAvailable,
    patch,
    patchAvailable,
    notes: String(manifest?.notes || ""),
    publishedAt: String(manifest?.publishedAt || ""),
    repository: String(manifest?.repository || ""),
    downloadUrl: String(manifest?.downloadUrl || ""),
    remote: { name: config.updateRemote, branch, fetched: fetchRemote },
    warnings,
  };
}

function scheduleGatewayRestart(config) {
  if (!config.launcherControlUrl) return false;
  setTimeout(() => {
    fetch(`${config.launcherControlUrl}/restart-gateway`, { method: "POST" }).catch(() => {});
  }, 1500).unref?.();
  return true;
}

/**
 * Apply an update. Git installs fast-forward; archive installs apply a signed code patch.
 * Config/data/models/bundled weights are never touched; a restart is required.
 */
export async function applyUpdate(config, { dryRun = false, force = false } = {}) {
  if (applying) throw updateError("更新正在进行中", "update_in_progress");
  if (!config.updateEnabled) throw updateError("自动更新已关闭", "update_disabled");

  applying = true;
  setUpdateProgress({ phase: "checking", percent: 0, downloaded: 0, total: 0, speed: 0, message: "" });
  try {
    const check = await checkForUpdate(config, { fetchRemote: true });
    if (!check.updateAvailable) throw updateError("已是最新版本", "up_to_date");
    if (check.installType !== "git") {
      if (!check.patch) throw updateError(check.applyReason || "此版本没有代码补丁，请下载完整包", "not_git_install");
      const result = await applyArchivePatch(config, { patch: check.patch, version: check.latestVersion, dryRun });
      if (dryRun) {
        return { ok: true, dryRun: true, currentVersion: check.currentVersion, latestVersion: check.latestVersion, files: result.files };
      }
      const restarting = scheduleGatewayRestart(config);
      const launcherChanged = result.files.some((file) => file.startsWith("launcher/"));
      return {
        ok: true,
        dryRun: false,
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        changedFiles: result.files,
        deletedFiles: result.deleted || [],
        launcherChanged,
        restartRequired: true,
        restarting,
        message: restarting
          ? "更新完成，网关正在重启，页面将自动刷新…"
          : "更新完成，请关闭工作台窗口后重新双击 start-local.bat",
      };
    }
    if (check.dirty || check.gitError) {
      if (!check.patch) throw updateError("工作区有未提交的修改，且此版本没有代码补丁；请先处理本地改动或下载完整包", "dirty_no_patch");
      if (!force) throw updateError(check.applyReason || "工作区有未提交的修改", "dirty_worktree");
      const result = await applyArchivePatch(config, { patch: check.patch, version: check.latestVersion, dryRun });
      if (dryRun) {
        return { ok: true, dryRun: true, forced: true, currentVersion: check.currentVersion, latestVersion: check.latestVersion, files: result.files };
      }
      const restarting = scheduleGatewayRestart(config);
      const launcherChanged = result.files.some((file) => file.startsWith("launcher/"));
      return {
        ok: true,
        dryRun: false,
        forced: true,
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        changedFiles: result.files,
        deletedFiles: result.deleted || [],
        launcherChanged,
        restartRequired: true,
        restarting,
        message: restarting
          ? "已强制更新，网关正在重启，页面将自动刷新…"
          : "已强制更新，请关闭工作台窗口后重新双击 start-local.bat",
      };
    }

    const branch = check.remote?.branch || config.updateBranch;
    const commands = [`git fetch ${config.updateRemote} ${branch}`, `git pull --ff-only ${config.updateRemote} ${branch}`];
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        commands,
      };
    }

    const beforeHead = (await git(config, ["rev-parse", "HEAD"], 8000)).stdout.trim();
    setUpdateProgress({ phase: "pulling", percent: 35, speed: 0, message: "正在拉取更新" });
    let pullOutput = "";
    try {
      pullOutput = (await git(config, ["pull", "--ff-only", config.updateRemote, branch], config.updateApplyTimeoutMs)).stdout;
    } catch (error) {
      throw updateError(`git pull 失败：${describeGitError(error)}`, "pull_failed");
    }
    const afterHead = (await git(config, ["rev-parse", "HEAD"], 8000)).stdout.trim();
    setUpdateProgress({ phase: "applying", percent: 90, speed: 0 });

    let changedFiles = [];
    if (beforeHead && afterHead && beforeHead !== afterHead) {
      const diff = await git(config, ["diff", "--name-only", beforeHead, afterHead], 10000);
      changedFiles = diff.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const installRequired = changedFiles.some((file) => /(^|\/)package-lock\.json$/.test(file));
    setUpdateProgress({ phase: "done", percent: 100, speed: 0, message: "更新完成" });
    return {
      ok: true,
      dryRun: false,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      beforeHead,
      afterHead,
      changedFiles,
      installRequired,
      restartRequired: true,
      summary: String(pullOutput || "").trim(),
      message: installRequired
        ? "更新完成，请先在 comfyui-gateway 运行 npm install，再重启 start-local.bat"
        : "更新完成，请重启 start-local.bat",
    };
  } catch (error) {
    setUpdateProgress({ phase: "error", speed: 0, message: error?.message || "更新失败" });
    throw error;
  } finally {
    applying = false;
  }
}
