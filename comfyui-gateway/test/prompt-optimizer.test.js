import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptOptimizer } from "../src/prompt-optimizer.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF_OUTPUT = `思考过程:
这里不应该出现在结果里。

subject_definitions:

<Subject 1> is the replacement character in <Picture 1>.
<Video 1> is the source video.

summary:

Replace the target person in <Video 1> with <Subject 1>.

retention_analysis:

<Subject 1>: fully_preserved.
<Video 1>: partially_preserved.

detailed_description:

[Shot 1] Keep the original action and camera.

overall_soundscape:

Street ambience.

non_diegetic_music:

No added music.`;

test("local H3 optimize keeps all full-reference sections", async () => {
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            submit: async () => ({ promptId: "test-prompt" }),
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: [REF_OUTPUT] } } }),
        },
        logger: null,
    });
    const result = await optimizer.optimize({
        prompt: "replace the dancer with the character in the image",
        mode: "全参考模式(Reference to Video)",
        duration: 5,
        uploadedImages: [{ name: "character.png" }],
        engine: "local",
    });
    assert.match(result.prompt, /^subject_definitions:/);
    assert.match(result.prompt, /retention_analysis:/);
    assert.match(result.prompt, /detailed_description:/);
    assert.doesNotMatch(result.prompt, /思考过程/);
});

test("cloud H3 optimize uses the full-reference prompt for reference mode", async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: REF_OUTPUT } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "replace the dancer with the character in the image",
            mode: "全参考模式(Reference to Video)",
            duration: 5,
            uploadedImages: [{ name: "character.png" }],
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /subject_definitions/);
        assert.match(captured.messages[0].content, /六段正文使用中文/);
        assert.match(captured.messages[0].content, /对话、旁白、歌词、画面文字默认使用中文/);
        assert.match(captured.messages[0].content, /每个标签单独一行/);
        assert.match(captured.messages[0].content, /attribute_transfer/);
        assert.match(captured.messages[0].content, /fully_copy/);
        assert.match(captured.messages[0].content, /人物替换/);
        assert.match(result.prompt, /^subject_definitions:/);
        assert.match(result.prompt, /retention_analysis:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 FL2VA prepends the official frame alignment line", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 开场画面。\n[Shot 2] At 00:05.000, 画面落到尾帧。\n\noverall_soundscape: 街道环境声。\n\nnon_diegetic_music: 无配乐。`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "人物从街道走到镜头前",
            mode: "首尾帧视频(FL2VA)",
            duration: 10,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /对齐句由系统在正文前补充/);
        assert.match(captured.messages[1]?.content || captured.messages[0].content, /首尾帧视频：从 Picture 1 连续过渡到 Picture 2/);
        assert.ok(result.prompt.startsWith("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 10.00-second mark of the target video.\n\n"), result.prompt);
        assert.match(result.prompt, /integrated_multimodal_description: \[Shot 1\]/);
        assert.match(result.prompt, /\[Shot 2\] At 00:05.000/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 three-part prompt keeps headings and asks for Chinese content", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 人物看向镜头。\noverall_soundscape: 街道环境声。\nnon_diegetic_music: 无配乐。`;
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "人物看向镜头",
            mode: "文生视频(T2VA)",
            duration: 5,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /integrated_multimodal_description/);
        assert.match(captured.messages[0].content, /字段正文使用中文/);
        assert.match(captured.messages[0].content, /对话、旁白、歌词、画面文字默认使用中文/);
        assert.match(result.prompt, /^integrated_multimodal_description:/);
        assert.match(result.prompt, /overall_soundscape:/);
        assert.match(result.prompt, /non_diegetic_music:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
