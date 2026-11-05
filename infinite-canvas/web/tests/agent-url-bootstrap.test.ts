import { expect, test } from "bun:test";

import { hasAgentUrlBootstrap, readAgentUrlBootstrap } from "../src/lib/agent/agent-url-bootstrap";

test("reads hash links", () => {
    expect(readAgentUrlBootstrap("#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=abc&x=1")).toEqual({
        url: "http://127.0.0.1:17371",
        token: "abc",
        remainingHash: "#x=1",
        remainingSearch: "",
    });
});

test("reads query links", () => {
    expect(readAgentUrlBootstrap("", "?mode=new&agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=abc")).toEqual({
        url: "http://127.0.0.1:17371",
        token: "abc",
        remainingHash: "",
        remainingSearch: "?mode=new",
    });
});

test("prefers hash values when both forms are present", () => {
    const result = readAgentUrlBootstrap("#agentUrl=http%3A%2F%2Fhash&agentToken=hash-token", "?agentUrl=http%3A%2F%2Fquery&agentToken=query-token");
    expect(result?.url).toBe("http://hash");
    expect(result?.token).toBe("hash-token");
});

test("keeps missing token so the caller can show a readable error", () => {
    const result = readAgentUrlBootstrap("#agentUrl=http%3A%2F%2F127.0.0.1%3A17371");
    expect(result).toEqual({ url: "http://127.0.0.1:17371", token: "", remainingHash: "", remainingSearch: "" });
});

test("detects either bootstrap form", () => {
    expect(hasAgentUrlBootstrap("#agentToken=abc")).toBe(true);
    expect(hasAgentUrlBootstrap("", "?agentUrl=http%3A%2F%2F127.0.0.1%3A17371")).toBe(true);
    expect(hasAgentUrlBootstrap("#unrelated=1", "?mode=new")).toBe(false);
});
