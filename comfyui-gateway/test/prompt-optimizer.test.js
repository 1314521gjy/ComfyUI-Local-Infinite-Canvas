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
        assert.match(captured.messages[0].content, /人物替换/);
        assert.match(result.prompt, /^subject_definitions:/);
        assert.match(result.prompt, /retention_analysis:/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
