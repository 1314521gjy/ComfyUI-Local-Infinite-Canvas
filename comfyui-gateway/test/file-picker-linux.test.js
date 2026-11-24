import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pickFileLinux } from "../src/file-picker-linux.js";

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function makeBinDir(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-picker-test-"));
  const file = path.join(dir, "zenity");
  fs.writeFileSync(file, script, { mode: 0o755 });
  return dir;
}

test("linux picker returns the configured path in fake mode", async () => {
  const target = path.join(os.tmpdir(), "picked-model.safetensors");
  await withEnv({ FILE_PICKER_FAKE: target, FILE_PICKER_FAKE_CANCELED: undefined }, async () => {
    const result = await pickFileLinux({ title: "选择模型文件" });
    assert.equal(result.canceled, false);
    assert.equal(result.path, path.resolve(target));
  });
});

test("linux picker reports cancellation in fake mode", async () => {
  await withEnv({ FILE_PICKER_FAKE: os.tmpdir(), FILE_PICKER_FAKE_CANCELED: "1" }, async () => {
    const result = await pickFileLinux({ title: "选择文件夹", directory: true });
    assert.equal(result.canceled, true);
    assert.equal(result.path, "");
  });
});

test("linux picker uses zenity when available", async () => {
  const target = path.join(os.tmpdir(), "from-zenity.safetensors");
  const binDir = makeBinDir(`#!/bin/sh\nprintf '%s\\n' '${target}'\n`);
  try {
    await withEnv({ FILE_PICKER_FAKE: undefined, PATH: `${binDir}:${process.env.PATH}` }, async () => {
      const result = await pickFileLinux({ title: "选择模型文件", initialDir: os.tmpdir() });
      assert.equal(result.canceled, false);
      assert.equal(result.path, path.resolve(target));
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("linux picker treats zenity exit 1 as cancellation", async () => {
  const binDir = makeBinDir("#!/bin/sh\nexit 1\n");
  try {
    await withEnv({ FILE_PICKER_FAKE: undefined, PATH: `${binDir}:${process.env.PATH}` }, async () => {
      const result = await pickFileLinux({ title: "选择模型文件" });
      assert.equal(result.canceled, true);
      assert.equal(result.path, "");
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("linux picker reports an error when no backend is installed", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-picker-empty-"));
  try {
    await withEnv({ FILE_PICKER_FAKE: undefined, PATH: binDir }, async () => {
      const result = await pickFileLinux({ title: "选择模型文件" });
      assert.equal(result.canceled, false);
      assert.equal(result.path, "");
      assert.match(result.error, /未找到可用的本机文件选择器/);
    });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
