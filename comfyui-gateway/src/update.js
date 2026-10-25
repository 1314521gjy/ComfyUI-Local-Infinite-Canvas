import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let applying = false;

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
  if (!config.updateManifestUrl) throw new Error("未配置更新清单地址");
  const response = await fetch(config.updateManifestUrl, {
    signal: AbortSignal.timeout(config.updateFetchTimeoutMs),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`更新清单 HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest?.version) throw new Error("update.json 缺少 version");
  return manifest;
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
  let gitError = "";
  let branch = config.updateBranch;

  if (installType === "git") {
    branch = await resolveBranch(config);
    try {
      const status = await git(config, ["status", "--porcelain", "--untracked-files=no"], 8000);
      dirty = status.stdout.trim().length > 0;
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
  let applyReason = "";
  if (!config.updateEnabled) applyReason = "自动更新已关闭";
  else if (!updateAvailable) applyReason = "已是最新版本";
  else if (installType !== "git") applyReason = "当前安装不是 Git 克隆，无法一键更新；请重新 clone 或手动下载";
  else if (gitError) applyReason = `Git 不可用：${gitError}`;
  else if (dirty) applyReason = "工作区有未提交的修改，已拒绝自动更新";

  const canApply = config.updateEnabled && updateAvailable && installType === "git" && !dirty && !gitError;
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
    notes: String(manifest?.notes || ""),
    publishedAt: String(manifest?.publishedAt || ""),
    repository: String(manifest?.repository || ""),
    downloadUrl: String(manifest?.downloadUrl || ""),
    remote: { name: config.updateRemote, branch, fetched: fetchRemote },
    warnings,
  };
}

/**
 * Apply a fast-forward update for a git install. Archive installs are refused on purpose.
 * No config/data/model files are touched; a restart is required after the pull.
 */
export async function applyUpdate(config, { dryRun = false } = {}) {
  if (applying) throw updateError("更新正在进行中", "update_in_progress");
  if (!config.updateEnabled) throw updateError("自动更新已关闭", "update_disabled");
  if (!isGitRepo(config)) throw updateError("当前安装不是 Git 克隆，无法一键更新", "not_git_install");

  applying = true;
  try {
    const check = await checkForUpdate(config, { fetchRemote: true });
    if (!check.updateAvailable) throw updateError("已是最新版本", "up_to_date");
    if (check.installType !== "git") throw updateError(check.applyReason || "当前安装不支持一键更新", "not_git_install");
    if (check.dirty) throw updateError(check.applyReason || "工作区有未提交的修改", "dirty_worktree");

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
    let pullOutput = "";
    try {
      pullOutput = (await git(config, ["pull", "--ff-only", config.updateRemote, branch], config.updateApplyTimeoutMs)).stdout;
    } catch (error) {
      throw updateError(`git pull 失败：${describeGitError(error)}`, "pull_failed");
    }
    const afterHead = (await git(config, ["rev-parse", "HEAD"], 8000)).stdout.trim();

    let changedFiles = [];
    if (beforeHead && afterHead && beforeHead !== afterHead) {
      const diff = await git(config, ["diff", "--name-only", beforeHead, afterHead], 10000);
      changedFiles = diff.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const installRequired = changedFiles.some((file) => /(^|\/)package-lock\.json$/.test(file));
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
  } finally {
    applying = false;
  }
}
