export function hasAgentUrlBootstrap(hash: string, search = "") {
    return Boolean(readAgentUrlBootstrap(hash, search));
}

export function readAgentUrlBootstrap(hash: string, search = "") {
    const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
    const searchParams = new URLSearchParams(search.replace(/^\?/, ""));
    const hasUrl = hashParams.has("agentUrl") || searchParams.has("agentUrl");
    const hasToken = hashParams.has("agentToken") || searchParams.has("agentToken");
    if (!hasUrl && !hasToken) return null;
    const url = hashParams.get("agentUrl")?.trim() || searchParams.get("agentUrl")?.trim() || "";
    const token = hashParams.get("agentToken")?.trim() || searchParams.get("agentToken")?.trim() || "";
    hashParams.delete("agentUrl");
    hashParams.delete("agentToken");
    searchParams.delete("agentUrl");
    searchParams.delete("agentToken");
    const remainingHash = hashParams.toString();
    const remainingSearch = searchParams.toString();
    return { url, token, remainingHash: remainingHash ? `#${remainingHash}` : "", remainingSearch: remainingSearch ? `?${remainingSearch}` : "" };
}
