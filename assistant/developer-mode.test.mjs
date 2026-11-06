import assert from "node:assert/strict";
import { test } from "node:test";

import { createCanvasTools, resolveCanvasToolCall, toolsForMode } from "./server.mjs";

const byName = (tools, name) => tools.find((tool) => tool.name === name);

test("normal mode keeps canvas and read-only tools but blocks write/command tools", async () => {
    const tools = toolsForMode({ mode: "normal" });
    for (const name of ["canvas_get_state", "canvas_get_features", "canvas_apply_ops", "site_navigate", "read_source", "search_source", "list_workspace", "gateway_health", "system_stats"]) {
        assert.ok(byName(tools, name), `normal mode should expose ${name}`);
    }
    for (const name of ["propose_edit", "run_check", "restart_comfy", "replace_model"]) {
        const tool = byName(tools, name);
        assert.ok(tool, `normal mode should keep the gated ${name}`);
        await assert.rejects(tool.execute("call", name === "run_check" ? { kind: "git-diff" } : {}), /开发者模式/);
    }
});

test("developer mode exposes the full repair and action toolset", () => {
    const tools = toolsForMode({ mode: "developer" });
    for (const name of ["propose_edit", "run_check", "restart_comfy", "replace_model", "read_source", "canvas_apply_ops"]) {
        assert.ok(byName(tools, name), `developer mode should expose ${name}`);
    }
    assert.notEqual(byName(tools, "run_check").execute, byName(toolsForMode({ mode: "normal" }), "run_check").execute);
});

test("canvas tools round-trip through the browser bridge", async () => {
    const sent = [];
    const tools = createCanvasTools((payload) => {
        sent.push(payload);
        return true;
    }, "thread-test");
    const pending = byName(tools, "canvas_get_state").execute("call-1", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, "canvas_get_state");
    assert.equal(resolveCanvasToolCall(sent[0].callId, { projectId: "canvas-test" }), true);
    const result = await pending;
    assert.match(result.content[0].text, /canvas-test/);
});

test("canvas tools fail honestly when no browser is connected", async () => {
    const tools = createCanvasTools(() => false, "thread-test");
    await assert.rejects(byName(tools, "canvas_get_features").execute("call-2", {}), /画布页面未连接/);
});
