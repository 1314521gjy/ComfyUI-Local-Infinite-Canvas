import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createLegacyProxyServer } from "../../launcher/start.mjs";

function listen(server) {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

test("legacy gateway proxy forwards API requests and bodies", async () => {
    const target = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ method: req.method, url: req.url, body, header: req.headers["x-test"] || "" }));
        });
    });
    const targetPort = await listen(target);
    const proxy = createLegacyProxyServer(`http://127.0.0.1:${targetPort}`);
    const proxyPort = await listen(proxy);
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session/open`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test": "yes" },
            body: JSON.stringify({ id: "abc" }),
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.method, "POST");
        assert.equal(payload.url, "/api/session/open");
        assert.equal(payload.body, '{"id":"abc"}');
        assert.equal(payload.header, "yes");
    } finally {
        await close(proxy);
        await close(target);
    }
});

test("legacy gateway proxy returns a readable 502 when the gateway is down", async () => {
    const target = http.createServer(() => {});
    const targetPort = await listen(target);
    await close(target);
    const proxy = createLegacyProxyServer(`http://127.0.0.1:${targetPort}`);
    const proxyPort = await listen(proxy);
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
        assert.equal(response.status, 502);
        const payload = await response.json();
        assert.match(payload.error.message, /本地网关暂不可用/);
    } finally {
        await close(proxy);
    }
});
