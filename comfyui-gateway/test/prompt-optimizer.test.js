import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptOptimizer } from "../src/prompt-optimizer.js";

process.env.ALLOW_PRIVATE_CLOUD = "1";

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
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /subject_definitions/);
        assert.match(captured.messages[0].content, /retention_analysis/);
        assert.match(captured.messages[0].content, /fully_preserved/);
        assert.match(captured.messages[0].content, /attribute_transfer/);
        assert.match(captured.messages[0].content, /fully_copy/);
        assert.match(captured.messages[0].content, /reference generation/);
        assert.match(captured.messages[0].content, /Preserve every original word and punctuation mark verbatim/);
        assert.match(captured.messages[0].content, /输出语言：字段正文全部使用中文/);
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
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /How the reference pictures align/);
        assert.match(captured.messages[0].content, /对齐句由系统在正文前补充/);
        assert.match(captured.messages[1]?.content || captured.messages[0].content, /首尾帧视频：从 Picture 1 连续过渡到 Picture 2/);
        assert.ok(result.prompt.startsWith("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 10.00-second mark of the target video.\n\n"), result.prompt);
        assert.match(result.prompt, /integrated_multimodal_description: \[Shot 1\]/);
        assert.match(result.prompt, /\[Shot 2\] At 00:05.000/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 three-part prompt keeps headings and defaults to Chinese content", async () => {
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
        assert.match(captured.messages[0].content, /Video Prompt Writing Guide/);
        assert.match(captured.messages[0].content, /Preserve every original word and punctuation mark verbatim/);
        assert.match(captured.messages[0].content, /integrated_multimodal_description/);
        assert.match(captured.messages[0].content, /字段正文全部使用中文/);
        assert.match(result.prompt, /^integrated_multimodal_description:/);
        assert.match(result.prompt, /overall_soundscape:/);
        assert.match(result.prompt, /non_diegetic_music:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 English output keeps Chinese dialogue", async () => {
    const output = `integrated_multimodal_description: [Shot 1] A man asks: <d>[Chinese]你就是沈三叔？</d>\noverall_soundscape: Room tone.\nnon_diegetic_music: 无配乐。`;
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
            prompt: "画面外男人问道：“你就是沈三叔？”",
            mode: "文生视频(T2VA)",
            duration: 5,
            language: "en",
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(captured.messages[0].content, /Write every field body in English/);
        assert.match(captured.messages[0].content, /Chinese dialogue stays Chinese/);
        assert.match(captured.messages[1].content, /输出语言：英文/);
        assert.match(result.prompt, /<d>\[Chinese\]你就是沈三叔？<\/d>/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 sends reference images to the vision model", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 画面与参考图一致。\noverall_soundscape: 环境声。\nnon_diegetic_music: 无。`;
    const image = "data:image/png;base64,iVBORw0KGgo=";
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
            cloudImages: [image],
            imageCount: 1,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        const content = captured.messages[1].content;
        assert.ok(Array.isArray(content), "image request must use multimodal content");
        assert.equal(content[0].type, "text");
        assert.match(content[0].text, /参考图片：1 张（已随消息附上/);
        assert.equal(content[1].type, "image_url");
        assert.equal(content[1].image_url.url, image);
        assert.match(result.prompt, /^How the reference pictures align/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud H3 fixes missing speaker ids and off-screen markers", async () => {
    const output = `integrated_multimodal_description: [Shot 1] 画面右侧外传来男人声音 (S1) 质问：<d>[Chinese] 你就是沈三叔？</d> 老头儿反问：<d>[Chinese] 沈什么叔？</d> 画面外同一个男人 (S1) 说：<d>[Chinese] 老东西。</d>\noverall_soundscape: 环境声。\nnon_diegetic_music: N/A`;
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
            prompt: "画面外男人问道：“你就是沈三叔？” 老头儿反问：“沈什么叔？”",
            mode: "文生视频(T2VA)",
            duration: 10,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        assert.match(result.prompt, /老头儿\s*\(S2\)/);
        assert.match(result.prompt, /男人声音\s*\(S1\) off-screen/);
        assert.match(result.prompt, /不在画面中，不对应任何参考图/);
        assert.ok(result.speakerTags.fixed >= 3, JSON.stringify(result.speakerTags));
        assert.equal(result.speakerTags.issues.length, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("local H3 passes the English language directive to the workflow", async () => {
    let submitted = null;
    const optimizer = createPromptOptimizer({
        config: { rootDir },
        comfy: {
            submit: async (workflow) => {
                submitted = workflow;
                return { promptId: "test-prompt" };
            },
            history: async () => ({ status: { completed: true }, outputs: { "4": { text: [REF_OUTPUT] } } }),
        },
        logger: null,
    });
    await optimizer.optimize({
        prompt: "人物看向镜头",
        mode: "文生视频(T2VA)",
        duration: 5,
        language: "en",
        engine: "local",
    });
    assert.ok(submitted, "workflow was not submitted");
    assert.match(submitted["3"].inputs["系统提示词"], /Write every field body in English/);
    assert.match(submitted["3"].inputs["系统提示词"], /Chinese dialogue stays Chinese/);
});


test("cloud caption sends the image as image_url and returns the prompt", async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            captured = JSON.parse(body);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: "一位身穿古装的年轻男子，神情沉静。" } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.captionImage({
            cloudImages: ["data:image/png;base64,AAAA"],
            language: "zh",
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "test-model" },
        });
        assert.ok(captured, "cloud request was not captured");
        const content = captured.messages[1].content;
        assert.ok(Array.isArray(content), "user content should carry text + image");
        assert.equal(content[0].type, "text");
        assert.equal(content[1].type, "image_url");
        assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
        assert.equal(result.engine, "cloud");
        assert.match(result.prompt, /古装/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cloud chat rejects private base urls by default", async () => {
    const previous = process.env.ALLOW_PRIVATE_CLOUD;
    delete process.env.ALLOW_PRIVATE_CLOUD;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        await assert.rejects(
            () => optimizer.captionImage({
                cloudImages: ["data:image/png;base64,AAAA"],
                engine: "cloud",
                cloud: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" },
            }),
            /内网|本机/,
        );
    } finally {
        process.env.ALLOW_PRIVATE_CLOUD = previous;
    }
});

test("cloud H3 retries with temperature=1 when the provider rejects 0.6", async () => {
    const bodies = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
            bodies.push(JSON.parse(body));
            res.setHeader("content-type", "application/json");
            if (bodies.length === 1) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: { message: "invalid temperature: only 1 is allowed for this model" } }));
                return;
            }
            res.end(JSON.stringify({ choices: [{ message: { content: "optimized prompt" } }] }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const optimizer = createPromptOptimizer({ config: { rootDir }, comfy: null, logger: null });
        const result = await optimizer.optimize({
            prompt: "a cat",
            mode: "文生视频(T2VA)",
            duration: 5,
            engine: "cloud",
            cloud: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", model: "kimi-thinking" },
        });
        assert.equal(bodies.length, 2);
        assert.equal(bodies[0].temperature, 0.6);
        assert.equal(bodies[1].temperature, 1);
        assert.equal(result.prompt, "optimized prompt");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
