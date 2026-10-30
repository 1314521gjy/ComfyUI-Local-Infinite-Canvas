import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { applyUpdate, checkForUpdate, compareVersions, getUpdateProgress } from "../src/update.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configFor(appRoot) {
  return {
    appRoot,
    updateManifestPath: path.join(appRoot, "update.json"),
    updateManifestUrl: "",
    updateRemote: "origin",
    updateBranch: "main",
    updateFetchTimeoutMs: 10000,
    updateApplyTimeoutMs: 30000,
    updateEnabled: true,
  };
}

function writeManifest(root, version, notes = "") {
  fs.writeFileSync(path.join(root, "update.json"), JSON.stringify({ version, notes, repository: "https://example.test/repo" }, null, 2));
}

function writeVersion(root, version) {
  fs.mkdirSync(path.join(root, "infinite-canvas"), { recursive: true });
  fs.writeFileSync(path.join(root, "infinite-canvas", "VERSION"), version);
}

test("compareVersions handles v-prefix and numeric segments", () => {
  assert.equal(compareVersions("v0.20.1", "v0.20.0"), 1);
  assert.equal(compareVersions("0.20.0", "v0.20.0"), 0);
  assert.equal(compareVersions("v0.20.10", "v0.20.9"), 1);
  assert.equal(compareVersions("bad", "v0.20.0"), 0);
});

test("archive install reports an update but refuses to apply it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-archive-"));
  try {
    writeVersion(root, "v0.20.0");
    writeManifest(root, "v0.20.1", "archive test");
    const result = await checkForUpdate(configFor(root));
    assert.equal(result.installType, "archive");
    assert.equal(result.updateAvailable, true);
    assert.equal(result.canApply, false);
    assert.match(result.applyReason, /Git/);
    await assert.rejects(() => applyUpdate(configFor(root)), (error) => error.code === "not_git_install");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("archive install applies a verified code patch and preserves local data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-patch-"));
  const payload = path.join(root, "payload");
  const patchFile = path.join(root, "patch.zip");
  const write = (rel, content) => {
    const file = path.join(payload, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("VERSION", "v0.20.1\n");
  write("comfyui-gateway/src/new.js", "export const updated = true;\n");
  write("PATCH-DELETE.txt", "comfyui-gateway/src/old.js\n");
  write("data/keep.txt", "overwritten-by-patch");
  write("comfyui-gateway/node_modules/marker", "overwritten-by-patch");
  write("launcher/config.json", '{"bad":true}');
  execFileSync("tar", ["-a", "-c", "-f", "patch.zip", "-C", "payload", "."], { cwd: root, stdio: "ignore" });
  const bytes = fs.readFileSync(patchFile);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");

  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "keep.txt"), "keep");
  fs.mkdirSync(path.join(root, "comfyui-gateway", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "comfyui-gateway", "node_modules", "marker"), "deps");
  fs.mkdirSync(path.join(root, "launcher"), { recursive: true });
  fs.writeFileSync(path.join(root, "launcher", "config.json"), "{}");
  fs.mkdirSync(path.join(root, "comfyui-gateway", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "comfyui-gateway", "src", "old.js"), "export const retired = true;\n");
  writeVersion(root, "v0.20.0");

  const server = http.createServer((req, res) => {
    if (req.url === "/update.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        version: "v0.20.1",
        notes: "patch test",
        patch: { url: `http://127.0.0.1:${server.address().port}/patch.zip`, sha256: sha, size: bytes.length },
      }));
      return;
    }
    if (req.url === "/patch.zip") {
      res.setHeader("content-type", "application/zip");
      res.end(bytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    ...configFor(root),
    updateManifestUrl: `http://127.0.0.1:${server.address().port}/update.json`,
  };
  try {
    const check = await checkForUpdate(config, { fetchRemote: true });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.installType, "archive");
    assert.equal(check.canApply, true);
    const result = await applyUpdate(config);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), "v0.20.1");
    assert.equal(fs.existsSync(path.join(root, "comfyui-gateway", "src", "new.js")), true);
    assert.equal(fs.readFileSync(path.join(root, "data", "keep.txt"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(root, "comfyui-gateway", "node_modules", "marker"), "utf8"), "deps");
    assert.equal(fs.readFileSync(path.join(root, "launcher", "config.json"), "utf8"), "{}");
    assert.equal(fs.existsSync(path.join(root, "comfyui-gateway", "src", "old.js")), false);
    assert.equal(fs.existsSync(path.join(root, "PATCH-DELETE.txt")), false);
    assert.equal(fs.existsSync(path.join(root, ".update-backup", "v0.20.1", "comfyui-gateway", "src", "old.js")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "update.json"), "utf8")).version, "v0.20.1");
    assert.equal(result.launcherChanged, false);
    const progress = getUpdateProgress();
    assert.equal(progress.phase, "done");
    assert.equal(progress.percent, 100);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git install fetches, dry-runs and fast-forwards an update", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-git-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const app = path.join(base, "app");
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    writeVersion(seed, "v0.20.0");
    writeManifest(seed, "v0.20.0", "initial");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    execFileSync("git", ["clone", remote, app], { stdio: "ignore" });

    writeVersion(seed, "v0.20.1");
    writeManifest(seed, "v0.20.1", "new version");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "v0.20.1");
    git(seed, "push", "origin", "main");

    const check = await checkForUpdate(configFor(app), { fetchRemote: true });
    assert.equal(check.installType, "git");
    assert.equal(check.updateAvailable, true);
    assert.equal(check.latestVersion, "v0.20.1");
    assert.equal(check.canApply, true);

    const dry = await applyUpdate(configFor(app), { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.commands.length, 2);

    const applied = await applyUpdate(configFor(app), { dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.restartRequired, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, "update.json"), "utf8")).version, "v0.20.1");
    assert.equal(fs.readFileSync(path.join(app, "infinite-canvas", "VERSION"), "utf8").trim(), "v0.20.1");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("runtime config.js does not block git updates; real edits can force a patch", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-dirty-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const app = path.join(base, "app");
  const payload = path.join(base, "payload");
  const patchFile = path.join(base, "patch.zip");
  const write = (rootDir, rel, content) => {
    const file = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(payload, "VERSION", "v0.20.1\n");
  write(payload, "comfyui-gateway/src/new.js", "export const updated = true;\n");
  write(payload, "data/keep.txt", "overwritten-by-patch");
  write(payload, "PATCH-DELETE.txt", "comfyui-gateway/src/old.js\n");
  execFileSync("tar", ["-a", "-c", "-f", "patch.zip", "-C", "payload", "."], { cwd: base, stdio: "ignore" });
  const bytes = fs.readFileSync(patchFile);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const server = http.createServer((req, res) => {
    if (req.url === "/patch.zip") {
      res.setHeader("content-type", "application/zip");
      res.end(bytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const patchUrl = `http://127.0.0.1:${server.address().port}/patch.zip`;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
    writeVersion(seed, "v0.20.0");
    write(seed, "update.json", JSON.stringify({ version: "v0.20.0", notes: "initial" }, null, 2));
    write(seed, "README.md", "seed\n");
    write(seed, "infinite-canvas/web/dist/config.js", "window.__RUNTIME_CONFIG__ = {};\n");
    write(seed, "comfyui-gateway/src/old.js", "export const retired = true;\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    execFileSync("git", ["clone", remote, app], { stdio: "ignore" });

    // 启动器每次启动都会改写 config.js；这不应再被当成“未提交的修改”。
    write(app, "infinite-canvas/web/dist/config.js", 'window.__RUNTIME_CONFIG__ = {"LOCAL_GATEWAY_PORT":"8190"};\n');
    write(app, "data/keep.txt", "keep");

    writeVersion(seed, "v0.20.1");
    write(seed, "update.json", JSON.stringify({
      version: "v0.20.1",
      notes: "force test",
      patch: { url: patchUrl, sha256: sha, size: bytes.length },
    }, null, 2));
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "v0.20.1");
    git(seed, "push", "origin", "main");

    let check = await checkForUpdate(configFor(app), { fetchRemote: true });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.dirty, false);
    assert.deepEqual(check.dirtyFiles, []);
    assert.deepEqual(check.ignoredDirtyFiles, ["infinite-canvas/web/dist/config.js"]);
    assert.equal(check.canApply, true);

    fs.appendFileSync(path.join(app, "README.md"), "local edit\n");
    check = await checkForUpdate(configFor(app), { fetchRemote: true });
    assert.equal(check.dirty, true);
    assert.ok(check.dirtyFiles.includes("README.md"));
    assert.equal(check.canApply, false);
    assert.equal(check.forceAvailable, true);
    await assert.rejects(() => applyUpdate(configFor(app)), (error) => error.code === "dirty_worktree");

    const result = await applyUpdate(configFor(app), { force: true });
    assert.equal(result.forced, true);
    assert.equal(fs.readFileSync(path.join(app, "VERSION"), "utf8").trim(), "v0.20.1");
    assert.equal(fs.readFileSync(path.join(app, "infinite-canvas/web/dist/config.js"), "utf8"), 'window.__RUNTIME_CONFIG__ = {"LOCAL_GATEWAY_PORT":"8190"};\n');
    assert.equal(fs.readFileSync(path.join(app, "README.md"), "utf8").replace(/\r\n/g, "\n"), "seed\nlocal edit\n");
    assert.equal(fs.readFileSync(path.join(app, "data/keep.txt"), "utf8"), "keep");
    assert.equal(fs.existsSync(path.join(app, "comfyui-gateway/src/old.js")), false);
    assert.equal(fs.existsSync(path.join(app, "comfyui-gateway/src/new.js")), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("git install auto-detects master when the configured branch is main", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-master-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const app = path.join(base, "app");
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=master", seed], { stdio: "ignore" });
    writeVersion(seed, "v0.20.0");
    writeManifest(seed, "v0.20.0", "initial");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "master");
    execFileSync("git", ["clone", remote, app], { stdio: "ignore" });

    writeVersion(seed, "v0.20.1");
    writeManifest(seed, "v0.20.1", "master update");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "v0.20.1");
    git(seed, "push", "origin", "master");

    const check = await checkForUpdate(configFor(app), { fetchRemote: true });
    assert.equal(check.remote.branch, "master");
    assert.equal(check.latestVersion, "v0.20.1");
    assert.equal(check.updateAvailable, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
