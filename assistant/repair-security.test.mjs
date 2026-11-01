import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    applyProposalFiles,
    createAsyncMutex,
    createRepairTools,
    resolveInside,
    rollbackProposalFiles,
} from "./repair-tools.mjs";
import {
    deployWorkspace,
    rebuildAndDeploy,
    recoverAppliedFixes,
    rollbackProposalAndRebuild,
    serializeAppliedProposals,
} from "./server.mjs";

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-repair-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeFixture(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
}

function sourcePath(root, name = "a.txt") {
    return path.join(root, "infinite-canvas", "web", "src", name);
}

function recoveryOptions(root, fixes, overrides = {}) {
    return {
        workspaceRoot: root,
        load: () => fixes,
        save: () => {},
        rebuild: async () => ({ ok: true }),
        version: () => "test",
        writeLog: () => {},
        ...overrides,
    };
}

test("resolveInside 拒绝目录链接/Junction 的读写逃逸", async (t) => {
    const root = tempDir(t);
    const outside = path.join(tempDir(t), "outside");
    writeFixture(path.join(outside, "outside.txt"), "unchanged");
    fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveInside(root, "linked/outside.txt"), /链接|Junction|真实路径/);
    assert.throws(() => resolveInside(root, "linked/new.txt"), /链接|Junction|真实路径/);

    const tools = createRepairTools({ workspaceRoot: root, proposals: new Map() });
    await assert.rejects(tools.find((tool) => tool.name === "read_source").execute("1", { path: "linked/outside.txt" }), /链接|Junction|真实路径/);
    assert.throws(() => applyProposalFiles({
        workspaceRoot: root,
        backupRoot: path.join(root, "backup"),
        proposal: { id: "linked", edits: [{ path: "linked/outside.txt", oldContent: "unchanged", newContent: "escaped" }] },
    }), /链接|Junction|真实路径/);
    assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "unchanged");
});

test("常见 secret/token/credential/key 文件均被拒绝，普通键盘源码不受影响", (t) => {
    const root = tempDir(t);
    for (const name of ["secrets.json", "token.yaml", "credentials.ini", "key.json", "private.pem", ".env.local", ".npmrc", "id_ed25519"]) {
        assert.throws(() => resolveInside(root, name), /敏感文件/, name);
    }
    assert.equal(resolveInside(root, "keyboard.ts"), path.join(root, "keyboard.ts"));
});

test("proposals 仅保留路径和摘要，最小记录仍可回滚", (t) => {
    const root = tempDir(t);
    const file = sourcePath(root);
    writeFixture(file, "before");
    const proposal = {
        id: "p1",
        summary: "test",
        createdAt: 1,
        status: "applied",
        edits: [{
            path: "infinite-canvas/web/src/a.txt",
            isCreate: false,
            oldContent: "before SECRET_SENTINEL",
            newContent: "after SECRET_SENTINEL",
            search: "before",
            replace: "after",
        }],
    };
    proposal.edits[0].oldContent = "before";
    const serialized = serializeAppliedProposals([proposal])[0];
    const json = JSON.stringify(serialized);
    assert.doesNotMatch(json, /SECRET_SENTINEL|oldContent|newContent|search|replace|Preview/);
    assert.match(serialized.edits[0].oldSha, /^[a-f0-9]{64}$/);
    assert.match(serialized.edits[0].newSha, /^[a-f0-9]{64}$/);

    proposal.edits[0].newContent = "after";
    applyProposalFiles({ proposal, workspaceRoot: root, backupRoot: path.join(root, "backups") });
    assert.equal(fs.readFileSync(file, "utf8"), "after");
    rollbackProposalFiles({ proposal: serialized, workspaceRoot: root, backupRoot: path.join(root, "backups") });
    assert.equal(fs.readFileSync(file, "utf8"), "before");
});

test("run_check 经共享异步互斥串行，异常后锁可继续获取", async (t) => {
    const root = tempDir(t);
    const lock = createAsyncMutex();
    let active = 0;
    let maxActive = 0;
    const tools = createRepairTools({
        workspaceRoot: root,
        proposals: new Map(),
        operationLock: lock,
        runTask: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
            return { ok: true, output: "fake" };
        },
    });
    const check = tools.find((tool) => tool.name === "run_check");
    await Promise.all([check.execute("1", { kind: "typecheck" }), check.execute("2", { kind: "typecheck" })]);
    assert.equal(maxActive, 1);
    await assert.rejects(lock(async () => { throw new Error("expected"); }), /expected/);
    assert.equal(await lock(async () => "released"), "released");
});

test("guard:false 不能绕过生成/内存护栏", async () => {
    let checks = 0;
    let tasks = 0;
    const result = await rebuildAndDeploy({
        guard: false,
        checkAllowed: async () => { checks += 1; return { ok: false, reason: "busy" }; },
        runTask: async () => { tasks += 1; return { ok: true, output: "" }; },
    });
    assert.equal(result.stage, "preflight");
    assert.equal(checks, 1);
    assert.equal(tasks, 0);
});

test("恢复先完整预检，任一冲突时不写源码、不保存也不构建", async (t) => {
    const root = tempDir(t);
    const a = sourcePath(root);
    const b = sourcePath(root, "b.txt");
    writeFixture(a, "a");
    writeFixture(b, "b");
    const fixes = { records: [
        { id: "r1", status: "applied", edits: [{ path: "infinite-canvas/web/src/a.txt", search: "a", replace: "A" }] },
        { id: "r2", status: "applied", edits: [{ path: "infinite-canvas/web/src/b.txt", search: "missing", replace: "B" }] },
    ] };
    let saves = 0;
    let builds = 0;
    const report = await recoverAppliedFixes(recoveryOptions(root, fixes, {
        save: () => { saves += 1; },
        rebuild: async () => { builds += 1; return { ok: true }; },
    }));
    assert.equal(report.conflicts.length, 1);
    assert.equal(fs.readFileSync(a, "utf8"), "a");
    assert.equal(fs.readFileSync(b, "utf8"), "b");
    assert.equal(saves, 0);
    assert.equal(builds, 0);
});

test("恢复预检通过后统一提交并可重放多个修复", async (t) => {
    const root = tempDir(t);
    const a = sourcePath(root);
    const b = sourcePath(root, "b.txt");
    writeFixture(a, "a");
    writeFixture(b, "b");
    const fixes = { records: [
        { id: "r1", status: "applied", edits: [{ path: "infinite-canvas/web/src/a.txt", search: "a", replace: "A" }] },
        { id: "r2", status: "applied", edits: [{ path: "infinite-canvas/web/src/b.txt", search: "b", replace: "B" }] },
    ] };
    let saves = 0;
    let builds = 0;
    const report = await recoverAppliedFixes(recoveryOptions(root, fixes, {
        save: () => { saves += 1; },
        rebuild: async () => { builds += 1; return { ok: true }; },
    }));
    assert.equal(report.reapplied, 2);
    assert.equal(fs.readFileSync(a, "utf8"), "A");
    assert.equal(fs.readFileSync(b, "utf8"), "B");
    assert.equal(saves, 1);
    assert.equal(builds, 1);
});

test("恢复提交写故障会还原已提交文件", async (t) => {
    const root = tempDir(t);
    const a = sourcePath(root);
    const b = sourcePath(root, "b.txt");
    writeFixture(a, "a");
    writeFixture(b, "b");
    const fixes = { records: [{ id: "r1", status: "applied", edits: [
        { path: "infinite-canvas/web/src/a.txt", search: "a", replace: "A" },
        { path: "infinite-canvas/web/src/b.txt", search: "b", replace: "B" },
    ] }] };
    const originalWrite = fs.writeFileSync;
    t.after(() => { fs.writeFileSync = originalWrite; });
    fs.writeFileSync = (file, content, ...args) => {
        if (path.resolve(file) === b && content === "B") throw new Error("injected write failure");
        return originalWrite(file, content, ...args);
    };
    let builds = 0;
    const report = await recoverAppliedFixes(recoveryOptions(root, fixes, {
        rebuild: async () => { builds += 1; return { ok: true }; },
    }));
    assert.equal(report.state, "failed");
    assert.equal(fs.readFileSync(a, "utf8"), "a");
    assert.equal(fs.readFileSync(b, "utf8"), "b");
    assert.equal(builds, 0);
});

test("部署换名故障恢复旧 dist，成功后切换新 dist", (t) => {
    const root = tempDir(t);
    const workspaceWeb = path.join(root, "workspace-web");
    const webDist = path.join(root, "public", "dist");
    writeFixture(path.join(workspaceWeb, "dist", "index.html"), "new");
    writeFixture(path.join(webDist, "index.html"), "old");
    writeFixture(path.join(webDist, "config.js"), "old-config");
    const options = { workspaceWeb, webDist, backupRoot: path.join(root, "backups") };
    const originalRename = fs.renameSync;
    let injected = false;
    t.after(() => { fs.renameSync = originalRename; });
    fs.renameSync = (from, to) => {
        if (!injected && String(from).includes(".assistant-new-") && path.resolve(to) === webDist) {
            injected = true;
            throw new Error("injected rename failure");
        }
        return originalRename(from, to);
    };
    const failed = deployWorkspace(options);
    assert.equal(failed.ok, false);
    assert.equal(fs.readFileSync(path.join(webDist, "index.html"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(webDist, "config.js"), "utf8"), "old-config");
    fs.renameSync = originalRename;
    const deployed = deployWorkspace(options);
    assert.equal(deployed.ok, true);
    assert.equal(fs.readFileSync(path.join(webDist, "index.html"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(webDist, "config.js"), "utf8"), "old-config");
});

test("回滚部署失败保留记录清理回调，成功后才清理", async (t) => {
    const root = tempDir(t);
    const file = sourcePath(root);
    writeFixture(file, "before");
    const proposal = {
        id: "rollback",
        edits: [{ path: "infinite-canvas/web/src/a.txt", isCreate: false, oldContent: "before", newContent: "after" }],
    };
    const backupRoot = path.join(root, "backups");
    applyProposalFiles({ proposal, workspaceRoot: root, backupRoot });
    let cleanups = 0;
    const failed = await rollbackProposalAndRebuild({
        proposal,
        workspaceRoot: root,
        backupRoot,
        rebuild: async () => ({ ok: false, stage: "build" }),
        onDeployed: () => { cleanups += 1; },
    });
    assert.equal(failed.ok, false);
    assert.equal(cleanups, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "before");
    const succeeded = await rollbackProposalAndRebuild({
        proposal,
        workspaceRoot: root,
        backupRoot,
        rebuild: async () => ({ ok: true }),
        onDeployed: () => { cleanups += 1; },
    });
    assert.equal(succeeded.ok, true);
    assert.equal(cleanups, 1);
});
