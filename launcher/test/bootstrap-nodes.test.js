import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledNodes } from "../bootstrap-nodes.mjs";

async function fixture(version, content, provides = []) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bootstrap-nodes-test-"));
    const comfyRoot = path.join(root, "ComfyUI");
    const bundleDir = path.join(root, "comfyui-gateway", "resources", "nodes", "TestNode");
    await fsp.mkdir(bundleDir, { recursive: true });
    await fsp.mkdir(path.join(comfyRoot, "custom_nodes"), { recursive: true });
    await fsp.writeFile(path.join(bundleDir, "__init__.py"), content, "utf8");
    const writeIndex = async (nextVersion) => fsp.writeFile(
        path.join(root, "comfyui-gateway", "resources", "index.json"),
        JSON.stringify({
            schema: 1,
            version: nextVersion,
            resources: [{
                id: "test-node",
                type: "node",
                label: "Test node",
                target: "custom_nodes/TestNode",
                autoInstall: true,
                bundleDir: "resources/nodes/TestNode",
                provides,
                sources: [],
            }],
        }),
        "utf8",
    );
    await writeIndex(version);
    return { root, comfyRoot, bundleDir, writeIndex, target: path.join(comfyRoot, "custom_nodes", "TestNode") };
}

test("managed unchanged nodes upgrade by hash and repeat runs are idempotent", async () => {
    const state = await fixture("v1", "VERSION = 1\n");
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), ["Test node"]);
        const manifestPath = path.join(state.target, ".canvas-bootstrap.json");
        const firstManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        assert.equal(firstManifest.version, "v1");
        assert.match(firstManifest.sourceHash, /^[0-9a-f]{64}$/);
        assert.match(firstManifest.files["__init__.py"], /^[0-9a-f]{64}$/);

        await fsp.writeFile(path.join(state.bundleDir, "__init__.py"), "VERSION = 2\n", "utf8");
        await state.writeIndex("v2");
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), ["Test node"]);
        assert.equal(await fsp.readFile(path.join(state.target, "__init__.py"), "utf8"), "VERSION = 2\n");
        assert.equal(JSON.parse(await fsp.readFile(manifestPath, "utf8")).version, "v2");
        const backupRoot = path.join(state.comfyRoot, ".canvas-install-backups");
        const backups = await fsp.readdir(backupRoot);
        assert.equal(backups.filter((name) => name.endsWith("-previous")).length, 1);
        const previous = backups.find((name) => name.endsWith("-previous"));
        assert.equal(await fsp.readFile(path.join(backupRoot, previous, "__init__.py"), "utf8"), "VERSION = 1\n");

        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), []);
        assert.deepEqual(await fsp.readdir(backupRoot), backups);
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("bundled nodes install into the configured manual custom node directory", async () => {
    const state = await fixture("v1", "VERSION = 1\n");
    const manual = path.join(state.root, "manual-nodes");
    await fsp.mkdir(manual, { recursive: true });
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, customNodesDirs: [manual], log: () => {} }), ["Test node"]);
        const target = path.join(manual, "TestNode");
        assert.equal(await fsp.readFile(path.join(target, "__init__.py"), "utf8"), "VERSION = 1\n");
        assert.equal(fs.existsSync(path.join(target, ".canvas-bootstrap.json")), true);
        assert.equal(fs.existsSync(path.join(state.comfyRoot, "custom_nodes", "TestNode")), false);

        await fsp.writeFile(path.join(state.bundleDir, "__init__.py"), "VERSION = 2\n", "utf8");
        await state.writeIndex("v2");
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, customNodesDirs: [manual], log: () => {} }), ["Test node"]);
        assert.equal(await fsp.readFile(path.join(target, "__init__.py"), "utf8"), "VERSION = 2\n");
        const backupRoot = path.join(manual, ".canvas-install-backups.disabled");
        const backups = await fsp.readdir(backupRoot);
        assert.equal(backups.filter((name) => name.endsWith("-previous")).length, 1);
        assert.equal(fs.existsSync(path.join(manual, ".canvas-install")), false, "temporary install dir must be cleaned up");
        assert.equal(fs.existsSync(path.join(manual, ".canvas-install.disabled")), false, "temporary install dir must be cleaned up");
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, customNodesDirs: [manual], log: () => {} }), []);
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("invalid manual plugin dirs do not fall back to the default custom_nodes", async () => {
    const state = await fixture("v1", "VERSION = 1\n");
    const missing = path.join(state.root, "missing-nodes");
    const logs = [];
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, customNodesDirs: [missing], log: (message) => logs.push(message) }), []);
        assert.equal(fs.existsSync(path.join(state.comfyRoot, "custom_nodes", "TestNode")), false);
        assert.ok(logs.some((line) => line.includes("手动插件目录不可用")), "must report the invalid manual dir");
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("existing default installation is not duplicated into the manual plugin dir", async () => {
    const state = await fixture("v1", "VERSION = 1\n");
    const manual = path.join(state.root, "manual-nodes");
    await fsp.mkdir(manual, { recursive: true });
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), ["Test node"]);
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, customNodesDirs: [manual], log: () => {} }), []);
        assert.equal(fs.existsSync(path.join(state.comfyRoot, "custom_nodes", "TestNode")), true);
        assert.equal(fs.existsSync(path.join(manual, "TestNode")), false);
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("user-modified nodes are backed up and never overwritten", async () => {
    const state = await fixture("v1", "VERSION = 1\n");
    try {
        await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} });
        await fsp.writeFile(path.join(state.target, "__init__.py"), "USER_EDIT = True\n", "utf8");
        await fsp.writeFile(path.join(state.bundleDir, "__init__.py"), "VERSION = 2\n", "utf8");
        await state.writeIndex("v2");
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), []);
        assert.equal(await fsp.readFile(path.join(state.target, "__init__.py"), "utf8"), "USER_EDIT = True\n");
        const backupRoot = path.join(state.comfyRoot, ".canvas-install-backups");
        const backups = await fsp.readdir(backupRoot);
        const userBackups = backups.filter((name) => name.endsWith("-user"));
        assert.equal(userBackups.length, 1);
        assert.equal(await fsp.readFile(path.join(backupRoot, userBackups[0], "__init__.py"), "utf8"), "USER_EDIT = True\n");

        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), []);
        assert.deepEqual(await fsp.readdir(backupRoot), backups, "a preserved directory must not create a new backup every launch");
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("offline install skips a pack already registered under another folder name", async () => {
    const state = await fixture("v1", "NODE_CLASS_MAPPINGS = {\"TestNodeClass\": object}\n", ["TestNodeClass"]);
    const existing = path.join(state.comfyRoot, "custom_nodes", "TestNode-main");
    await fsp.mkdir(existing, { recursive: true });
    await fsp.writeFile(path.join(existing, "__init__.py"), "NODE_CLASS_MAPPINGS = {\"TestNodeClass\": object}\n", "utf8");
    const logs = [];
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: (message) => logs.push(message) }), []);
        assert.equal(fs.existsSync(state.target), false, "must not duplicate a node supplied by another folder");
        assert.ok(logs.some((line) => line.includes("已有插件目录注册同类节点")), "must explain the skip");
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});

test("offline install still copies when no existing pack maps the classes", async () => {
    const state = await fixture("v1", "NODE_CLASS_MAPPINGS = {\"TestNodeClass\": object}\n", ["TestNodeClass"]);
    const existing = path.join(state.comfyRoot, "custom_nodes", "OtherNode");
    await fsp.mkdir(existing, { recursive: true });
    await fsp.writeFile(path.join(existing, "__init__.py"), "NODE_CLASS_MAPPINGS = {\"OtherClass\": object}\n", "utf8");
    try {
        assert.deepEqual(await installBundledNodes({ root: state.root, comfyRoot: state.comfyRoot, log: () => {} }), ["Test node"]);
        assert.equal(fs.existsSync(state.target), true);
    } finally {
        await fsp.rm(state.root, { recursive: true, force: true });
    }
});
