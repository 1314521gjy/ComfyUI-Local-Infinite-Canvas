import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledNodes } from "../bootstrap-nodes.mjs";

async function fixture(version, content) {
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
