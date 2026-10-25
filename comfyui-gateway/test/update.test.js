import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { applyUpdate, checkForUpdate, compareVersions } from "../src/update.js";

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
