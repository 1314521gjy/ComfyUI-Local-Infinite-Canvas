import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-patch.mjs", import.meta.url));
const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";

async function makeFixture(base) {
    const root = path.join(base, "staging");
    const directories = [
        "launcher",
        "comfyui-gateway/src",
        "comfyui-gateway/comfyui-bridge",
        "comfyui-gateway/scripts",
        "comfyui-gateway/prompts",
        "comfyui-gateway/workflows",
        "comfyui-gateway/resources/nodes",
        "assistant",
        "infinite-canvas/web/dist/assets",
    ];
    for (const directory of directories) await fsp.mkdir(path.join(root, directory), { recursive: true });
    const files = {
        VERSION: "v1.2.3\n",
        "CHANGELOG.md": "## v1.2.3\n- test\n",
        "README.md": "fixture\n",
        LICENSE: "fixture\n",
        "NOTICE.md": "fixture\n",
        "THIRD_PARTY_NOTICES.md": "fixture\n",
        "start-local.bat": "@echo off\n",
        "launcher/start.mjs": "export const launcher = true;\n",
        "comfyui-gateway/src/server.js": "export const server = true;\n",
        "comfyui-gateway/workflows/registry.json": "{}\n",
        "comfyui-gateway/workflow-baseline.json": "{}\n",
        "comfyui-gateway/resources/index.json": "{}\n",
        "comfyui-gateway/package.json": "{}\n",
        "comfyui-gateway/package-lock.json": "{}\n",
        "infinite-canvas/web/dist/index.html": "<script src=\"/assets/index-v1.js\"></script>\n",
        "infinite-canvas/web/dist/assets/index-v1.js": "export const version = 'v1.2.3';\n",
        "infinite-canvas/VERSION": "v1.2.3\n",
        "launcher/examples.js": [
            "const API_KEY = 'your-api-key-here';",
            "const password = 'changeme';",
            "const aws = 'AKIAIOSFODNN7EXAMPLE';",
            "const token = 'sk-example-placeholder-token';",
            "const token_method = 'connected_clip_tokenizer';",
            "",
        ].join("\n"),
        "launcher/nested/.git/config": "token = 'not-for-package'\n",
        "launcher/nested/.npmrc": "//registry.example/:_authToken=not-for-package\n",
        "launcher/nested/id_rsa": "-----BEGIN PRIVATE KEY-----\nnot-for-package\n-----END PRIVATE KEY-----\n",
        "launcher/digest.json": JSON.stringify({
            normalization_report_sha256: "a".repeat(64),
            private_key_sha256: "b".repeat(64),
        }),
        "launcher/ui-copy.js": [
            "const password = 'Password must be at least 8 characters';",
            "const token = '连接 Token';",
            "",
        ].join("\n"),
    };
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, relative);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, content, "utf8");
    }
    return root;
}

function build(root, out) {
    return spawnSync(process.execPath, [script, "--root", root, "--out", out], { encoding: "utf8", timeout: 120000, windowsHide: true });
}

test("build-patch excludes secret files recursively but accepts documented placeholders", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "build-patch-placeholder-test-"));
    try {
        const root = await makeFixture(base);
        const out = path.join(base, "patch.zip");
        const result = build(root, out);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const entries = execFileSync(tar, ["-tf", "patch.zip"], { cwd: base, encoding: "utf8" }).replace(/\\/g, "/");
        assert.ok(entries.includes("launcher/examples.js"));
        assert.ok(entries.includes("launcher/digest.json"), "digest fields are not secrets");
        assert.ok(entries.includes("launcher/ui-copy.js"), "UI copy is not a secret");
        assert.equal(/(^|\/)\.git(\/|$)/i.test(entries), false);
        assert.equal(/(^|\/)\.npmrc(\/|$)/i.test(entries), false);
        assert.equal(/(^|\/)id_rsa(\/|$)/i.test(entries), false);
    } finally {
        await fsp.rm(base, { recursive: true, force: true });
    }
});

test("build-patch rejects an obvious executable-config secret without leaking its value", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "build-patch-secret-test-"));
    try {
        const root = await makeFixture(base);
        const secret = "sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
        await fsp.writeFile(path.join(root, "launcher", "secret-config.js"), `const apiKey = '${secret}';\n`, "utf8");
        const result = build(root, path.join(base, "patch.zip"));
        assert.notEqual(result.status, 0, "an obvious secret must fail the build");
        assert.match(result.stderr, /launcher\/secret-config\.js/);
        assert.match(result.stderr, /密钥|秘密/);
        assert.equal(result.stderr.includes(secret), false);
    } finally {
        await fsp.rm(base, { recursive: true, force: true });
    }
});
