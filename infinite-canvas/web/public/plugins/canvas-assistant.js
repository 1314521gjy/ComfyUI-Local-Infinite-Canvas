export default function (runtime) {
    const { React } = runtime;
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const NODE_TYPE = "canvas-assistant:repair";
    const CONFIG_KEY = "infinite-canvas:ai_config_store";
    const ACCENT = "#2f80ff";
    const ONLINE_POLL_MS = 15000;

    const QUICK_PROMPTS = [
        { label: "工作流启用了但下拉没有", text: "资源卡已经启用，工作流也显示可用，但画布模型下拉里没有这个模型。帮我按证据排查。" },
        { label: "模型未匹配 / 缺资源", text: "资源卡显示模型未匹配或缺少资源。先体检，再告诉我应该自选替换还是重新下载。" },
        { label: "生成失败 / 出图异常", text: "生成失败或出图异常。先查网关、系统状态和最近一次 OOM，再给排查步骤。" },
        { label: "ComfyUI 连不上", text: "画布连不上 ComfyUI 或网关。先确认是哪个服务不可达，再给恢复步骤。" },
    ];

    function readConfig() {
        try {
            const raw = window.localStorage.getItem(CONFIG_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && parsed.state && parsed.state.config ? parsed.state.config : null;
        } catch {
            return null;
        }
    }

    function isLoopbackUrl(value) {
        try {
            const host = new URL(String(value || "")).hostname.toLowerCase();
            return host === "127.0.0.1" || host === "localhost" || host === "::1";
        } catch {
            return false;
        }
    }

    function hostLabel(value) {
        try {
            return new URL(String(value || "")).host;
        } catch {
            return String(value || "");
        }
    }

    function originOf(value) {
        try {
            return new URL(String(value || "")).origin;
        } catch {
            return "";
        }
    }

    function recoveryText(report) {
        if (!report) return "";
        if (report.state === "running") return "正在恢复上次应用的修复…";
        if (report.state === "failed") return "上次修复自动恢复失败，请重新生成方案。";
        if (Array.isArray(report.conflicts) && report.conflicts.length) return `有 ${report.conflicts.length} 个历史修复无法自动重放，请重新生成方案。`;
        if (report.reapplied > 0) return `已自动恢复 ${report.reapplied} 个修复并重新构建部署。`;
        return "";
    }

    function listProfiles() {
        const config = readConfig();
        const out = [];
        const seen = new Set();
        const add = (profile) => {
            const api = profile.api || {};
            if (!api.baseUrl || !api.model) return;
            const key = `${api.baseUrl.replace(/\/+$/, "")}|${api.model}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(profile);
        };
        for (const api of (config && config.promptCloudApis) || []) {
            if (!api || !api.baseUrl || !api.model) continue;
            add({
                id: `cloud:${api.id}`,
                label: `${api.name || hostLabel(api.baseUrl)} · ${api.model}`,
                api: { baseUrl: api.baseUrl, apiKey: api.apiKey || "", model: api.model, name: api.name || "" },
            });
        }
        for (const channel of (config && config.channels) || []) {
            if (!channel || isLoopbackUrl(channel.baseUrl)) continue;
            for (const model of channel.models || []) {
                if (model.capability !== "text") continue;
                add({
                    id: `channel:${channel.id}:${model.name}`,
                    label: `${channel.name || hostLabel(channel.baseUrl)} · ${model.name}`,
                    api: { baseUrl: channel.baseUrl, apiKey: channel.apiKey || "", model: model.name, name: channel.name || "", format: channel.apiFormat },
                });
            }
        }
        return out;
    }

    function localGatewayUrl() {
        const runtime = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};
        if (runtime.LOCAL_GATEWAY_URL) {
            const origin = originOf(runtime.LOCAL_GATEWAY_URL);
            if (origin) return origin;
        }
        if (runtime.LOCAL_GATEWAY_PORT) return `http://127.0.0.1:${runtime.LOCAL_GATEWAY_PORT}`;
        const config = readConfig();
        for (const channel of (config && config.channels) || []) {
            if (!channel || !isLoopbackUrl(channel.baseUrl)) continue;
            const origin = originOf(channel.baseUrl);
            if (!origin) continue;
            if (origin.includes(":8291")) return origin;
        }
        for (const channel of (config && config.channels) || []) {
            if (!channel || !isLoopbackUrl(channel.baseUrl)) continue;
            const origin = originOf(channel.baseUrl);
            if (origin) return origin;
        }
        return "http://127.0.0.1:8190";
    }

    function truncate(value, size) {
        const text = String(value || "");
        return text.length > size ? `${text.slice(0, size)}…` : text;
    }

    function miniNode(node) {
        if (!node) return null;
        const metadata = node.metadata || {};
        return {
            id: node.id,
            type: node.type,
            title: node.title,
            status: metadata.status || "",
            model: metadata.model || "",
            error: truncate(metadata.errorDetails, 300),
            generationMode: metadata.generationMode || "",
            imageMode: metadata.imageMode || "",
            videoMode: metadata.videoMode || "",
            freeWorkflowId: metadata.freeWorkflowId || "",
            size: node.width && node.height ? `${Math.round(node.width)}×${Math.round(node.height)}` : "",
        };
    }

    function buildContext(ctx) {
        const nodes = ctx.getNodes();
        const counts = {};
        for (const node of nodes) {
            const key = String(node.type || "unknown");
            counts[key] = (counts[key] || 0) + 1;
        }
        const config = readConfig();
        const channels = ((config && config.channels) || []).map((channel) => ({
            name: channel.name,
            baseUrl: channel.baseUrl,
            models: (channel.models || []).length,
        }));
        return {
            capturedAt: new Date().toISOString(),
            nodeCount: nodes.length,
            nodeTypes: counts,
            current: miniNode(ctx.node),
            upstream: ctx.getUpstream().map(miniNode),
            downstream: ctx.getDownstream().map(miniNode),
            aiConfig: config
                ? {
                      channelMode: config.channelMode,
                      imageModel: config.imageModel,
                      videoModel: config.videoModel,
                      textModel: config.textModel,
                      channels,
                  }
                : null,
        };
    }

    function newId() {
        try {
            return crypto.randomUUID();
        } catch {
            return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        }
    }

    function chatStorageKey(nodeId) {
        return `canvas-assistant:chat:${nodeId}`;
    }

    function readChat(nodeId) {
        try {
            const raw = window.localStorage.getItem(chatStorageKey(nodeId));
            if (!raw) return { messages: [], threadId: "" };
            const parsed = JSON.parse(raw);
            const stored = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
            return {
                messages: stored.map((message) =>
                    message && message.pending
                        ? {
                              ...message,
                              pending: false,
                              failed: true,
                              activity: "",
                              text: message.text ? `${message.text}\n\n会话已中断，请重试。` : "会话已中断，请重试。",
                          }
                        : message,
                ),
                threadId: parsed && parsed.threadId ? String(parsed.threadId) : "",
            };
        } catch {
            return { messages: [], threadId: "" };
        }
    }

    function writeChat(nodeId, messages, threadId) {
        try {
            const trimmed = Array.isArray(messages) ? messages.slice(-60) : [];
            window.localStorage.setItem(chatStorageKey(nodeId), JSON.stringify({ messages: trimmed, threadId, updatedAt: Date.now() }));
        } catch {
            // 本地存储满或不可用时忽略，不影响当前会话。
        }
    }

    function Icon({ name, size = 14 }) {
        const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
        if (name === "spark") {
            return h(
                "svg",
                common,
                h("path", { d: "M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" }),
                h("circle", { cx: 12, cy: 12, r: 3 }),
            );
        }
        if (name === "send") return h("svg", common, h("path", { d: "M12 19V5M5 12l7-7 7 7" }));
        if (name === "stop") return h("svg", common, h("rect", { x: 7, y: 7, width: 10, height: 10, rx: 2 }));
        if (name === "trash") return h("svg", common, h("path", { d: "M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" }));
        if (name === "pulse") return h("svg", common, h("path", { d: "M3 12h4l2-5 4 10 2-5h6" }));
        if (name === "lock") return h("svg", common, h("rect", { x: 5, y: 11, width: 14, height: 9, rx: 2 }), h("path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }));
        return h("svg", common, h("circle", { cx: 12, cy: 12, r: 8 }));
    }

    function Content({ ctx }) {
        const theme = ctx.theme;
        const nodePanel = theme.node.panel;
        const nodeStroke = theme.node.stroke;
        const nodeText = theme.node.text;
        const nodeMuted = theme.node.muted;
        const nodeFaint = theme.node.faint;

        const [messages, setMessages] = useState(() => readChat(ctx.node.id).messages);
        const [input, setInput] = useState("");
        const [streaming, setStreaming] = useState(false);
        const [lifecycle, setLifecycle] = useState("unknown");
        const [serviceUrl, setServiceUrl] = useState("");
        const [serviceError, setServiceError] = useState("");
        const [recoveryNotice, setRecoveryNotice] = useState("");
        const [threadId, setThreadId] = useState(() => readChat(ctx.node.id).threadId);
        const [profiles, setProfiles] = useState(() => listProfiles());
        const [apiId, setApiId] = useState(() => String((ctx.node.metadata && ctx.node.metadata.params && ctx.node.metadata.params.assistantApiProfileId) || ""));

        const scrollRef = useRef(null);
        const contentRef = useRef(null);
        const composerRef = useRef(null);
        const inputRef = useRef(null);
        const headerRef = useRef(null);
        const apiRef = useRef(null);
        const autoHeightRef = useRef(null);
        const abortRef = useRef(null);
        const threadRef = useRef("");
        const serviceUrlRef = useRef("");
        const stickRef = useRef(true);
        threadRef.current = threadId;
        const gatewayUrl = useMemo(() => localGatewayUrl(), []);

        const allProfiles = profiles;
        const selectedProfile = useMemo(() => {
            const found = allProfiles.find((profile) => profile.id === apiId);
            if (found) return found;
            const withKey = allProfiles.find((profile) => profile.api && profile.api.apiKey);
            return withKey || allProfiles[0] || null;
        }, [allProfiles, apiId]);

        useEffect(() => {
            const timer = setTimeout(() => writeChat(ctx.node.id, messages, threadId), 450);
            return () => clearTimeout(timer);
        }, [ctx.node.id, messages, threadId]);

        useEffect(() => {
            const node = scrollRef.current;
            if (!node || !stickRef.current) return;
            node.scrollTop = node.scrollHeight;
        }, [messages]);

        useLayoutEffect(() => {
            const el = inputRef.current;
            if (!el) return;
            el.style.height = "auto";
            const next = Math.min(96, Math.max(34, el.scrollHeight));
            el.style.height = `${next}px`;
            el.style.overflowY = el.scrollHeight > 96 ? "auto" : "hidden";
        }, [input]);

        useEffect(() => {
            if (streaming) return;
            const content = contentRef.current;
            const composer = composerRef.current;
            if (!content || !composer) return;
            const height = (headerRef.current?.offsetHeight || 36) + (apiRef.current?.offsetHeight || 34);
            const desired = Math.round(Math.max(320, Math.min(680, height + content.offsetHeight + composer.offsetHeight + 20)));
            if (autoHeightRef.current !== null && Math.abs(ctx.node.height - autoHeightRef.current) > 4) return;
            autoHeightRef.current = desired;
            if (Math.abs(ctx.node.height - desired) > 6) ctx.updateNode({ height: desired });
        }, [ctx.node.height, input, messages, streaming]);

        const applyServiceStatus = useCallback((payload) => {
            if (!payload || payload.ok === false) {
                setLifecycle("error");
                setServiceError((payload && (payload.error || payload.reason)) || "网关没有返回 Agent 状态");
                return;
            }
            if (payload.needFullPackage) {
                serviceUrlRef.current = "";
                setServiceUrl("");
                setLifecycle("need-package");
                setServiceError(payload.reason || "");
                return;
            }
            if (!payload.available) {
                serviceUrlRef.current = "";
                setServiceUrl("");
                setLifecycle("error");
                setServiceError(payload.reason || "Agent 不可用");
                return;
            }
            if (payload.running && payload.online && payload.url) {
                serviceUrlRef.current = payload.url;
                setServiceUrl(payload.url);
                setLifecycle("online");
                setServiceError("");
            } else if (payload.running) {
                setLifecycle("starting");
                setServiceError("");
            } else {
                serviceUrlRef.current = "";
                setServiceUrl("");
                setLifecycle("sleep");
                setServiceError("");
            }
            const notice = recoveryText(payload.recovery);
            if (notice) setRecoveryNotice(notice);
        }, []);

        const refreshStatus = useCallback(async () => {
            try {
                const response = await fetch(`${gatewayUrl}/api/assistant/status`, { cache: "no-store" });
                const data = await response.json().catch(() => ({}));
                applyServiceStatus({ ...data, ok: response.ok && data.ok !== false });
            } catch {
                setLifecycle("error");
                setServiceError("无法连接本地网关");
            }
        }, [applyServiceStatus, gatewayUrl]);

        const ensureService = useCallback(async () => {
            if (serviceUrlRef.current) return serviceUrlRef.current;
            setLifecycle("starting");
            setServiceError("");
            try {
                const response = await fetch(`${gatewayUrl}/api/assistant/ensure`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.ok) {
                    if (data.needFullPackage) {
                        setLifecycle("need-package");
                        setServiceError(data.error || "");
                    } else {
                        setLifecycle("error");
                        setServiceError(data.error || `HTTP ${response.status}`);
                    }
                    return "";
                }
                serviceUrlRef.current = data.url;
                setServiceUrl(data.url);
                setLifecycle("online");
                setServiceError("");
                return data.url;
            } catch {
                setLifecycle("error");
                setServiceError("无法连接本地网关");
                return "";
            }
        }, [gatewayUrl]);

        useEffect(() => {
            let alive = true;
            void (async () => {
                await ensureService();
                if (alive) void refreshStatus();
            })();
            const timer = setInterval(() => {
                if (alive) void refreshStatus();
            }, ONLINE_POLL_MS);
            return () => {
                alive = false;
                clearInterval(timer);
            };
        }, [ensureService, refreshStatus]);

        const updateAssistant = useCallback((id, updater) => {
            setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)));
        }, []);

        const handleEvent = useCallback(
            (event, data, assistantId) => {
                if (event === "meta") {
                    if (data.threadId) setThreadId(String(data.threadId));
                    if (data.recreated) {
                        setMessages((prev) =>
                            prev.map((message) =>
                                Array.isArray(message.proposals)
                                    ? {
                                          ...message,
                                          proposals: message.proposals.map((item) =>
                                              item.status === "pending" || item.status === "applying" ? { ...item, status: "expired" } : item,
                                          ),
                                      }
                                    : message,
                            ),
                        );
                    }
                    const notice = recoveryText(data.recovery);
                    if (notice) setRecoveryNotice(notice);
                    return;
                }
                if (event === "delta") {
                    if (!data.text) return;
                    updateAssistant(assistantId, (message) => ({ ...message, text: `${message.text || ""}${data.text}` }));
                    return;
                }
                if (event === "patch" && data.proposalId) {
                    updateAssistant(assistantId, (message) => {
                        const proposals = Array.isArray(message.proposals) ? message.proposals.slice() : [];
                        if (!proposals.some((item) => item.id === data.proposalId)) {
                            proposals.push({
                                id: data.proposalId,
                                summary: data.summary || "画布修复",
                                files: Array.isArray(data.files) ? data.files : [],
                                status: "pending",
                            });
                        }
                        return { ...message, proposals };
                    });
                    return;
                }
                if (event === "error") {
                    const text = String(data.message || "请求失败");
                    updateAssistant(assistantId, (message) => ({
                        ...message,
                        pending: false,
                        failed: true,
                        text: message.text ? `${message.text}\n\n请求失败：${text}` : `请求失败：${text}`,
                    }));
                    return;
                }
                if (event === "done") {
                    updateAssistant(assistantId, (message) => ({
                        ...message,
                        pending: false,
                        stopped: data.stopped === true,
                        failed: data.failed === true || message.failed === true,
                        text: typeof data.text === "string" && data.text.trim() ? data.text : message.text,
                    }));
                }
            },
            [updateAssistant],
        );

        const parseStream = useCallback(
            (chunk, assistantId) => {
                let event = "message";
                const dataLines = [];
                for (const line of chunk.split("\n")) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
                }
                if (!dataLines.length) return;
                let data;
                try {
                    data = JSON.parse(dataLines.join("\n"));
                } catch {
                    return;
                }
                handleEvent(event, data || {}, assistantId);
            },
            [handleEvent],
        );

        const send = useCallback(
            async (raw) => {
                const text = String(raw === undefined ? input : raw).trim();
                if (!text || streaming) return;
                if (!selectedProfile) {
                    setMessages((prev) => [
                        ...prev,
                        { id: newId(), role: "assistant", text: "还没有可用的 API。请在右上角设置 → 云端 API 里添加一个文本 API，然后回到这张卡重试。", pending: false, failed: true, tools: [] },
                    ]);
                    return;
                }
                if (!selectedProfile.api.apiKey) {
                    setMessages((prev) => [
                        ...prev,
                        { id: newId(), role: "assistant", text: `API「${selectedProfile.label}」没有填写 Key。请先在设置里补全，再回来重试。`, pending: false, failed: true, tools: [] },
                    ]);
                    return;
                }
                if (lifecycle === "need-package") {
                    setMessages((prev) => [
                        ...prev,
                        { id: newId(), role: "assistant", text: "当前是应用内小补丁，Agent 工作区没有安装。请下载 v0.23.1 完整包后使用；画布其他功能不受影响。", pending: false, failed: true, tools: [] },
                    ]);
                    return;
                }
                let url = serviceUrlRef.current;
                if (!url) url = await ensureService();
                if (!url) {
                    const reason = serviceError || (lifecycle === "need-package" ? "当前安装缺少 Agent 工作区，请下载完整包。" : "助手服务没有启动成功，请稍后重试。");
                    setMessages((prev) => [
                        ...prev,
                        { id: newId(), role: "assistant", text: `无法唤起修复引擎：${reason}`, pending: false, failed: true, tools: [] },
                    ]);
                    return;
                }
                const assistantId = newId();
                stickRef.current = true;
                const history = messages
                    .filter((message) => message.text && message.text.trim())
                    .slice(-12)
                    .map((message) => ({ role: message.role === "user" ? "user" : "assistant", content: message.text }));
                setMessages((prev) => [...prev, { id: newId(), role: "user", text }, { id: assistantId, role: "assistant", text: "", tools: [], pending: true }]);
                setInput("");
                setStreaming(true);
                const controller = new AbortController();
                abortRef.current = controller;
                const payload = {
                    threadId: threadRef.current,
                    message: text,
                    gatewayUrl,
                    history,
                    context: buildContext(ctx),
                    api: {
                        baseUrl: selectedProfile.api.baseUrl,
                        apiKey: selectedProfile.api.apiKey,
                        model: selectedProfile.api.model,
                        name: selectedProfile.api.name,
                        format: selectedProfile.api.format,
                    },
                };
                try {
                    const response = await fetch(`${url}/api/assistant/chat`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        signal: controller.signal,
                        body: JSON.stringify(payload),
                    });
                    if (!response.ok) {
                        const payload = await response.json().catch(() => ({}));
                        throw new Error(payload.error || `HTTP ${response.status}`);
                    }
                    if (!response.body) throw new Error("当前浏览器不支持流式响应");
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        let index = buffer.indexOf("\n\n");
                        while (index >= 0) {
                            const chunk = buffer.slice(0, index);
                            buffer = buffer.slice(index + 2);
                            if (chunk.trim()) parseStream(chunk, assistantId);
                            index = buffer.indexOf("\n\n");
                        }
                    }
                    if (buffer.trim()) parseStream(buffer, assistantId);
                    updateAssistant(assistantId, (message) =>
                        message.pending
                            ? {
                                  ...message,
                                  pending: false,
                                  failed: true,
                                  activity: "",
                                  text: message.text ? `${message.text}\n\n连接中断，请重试。` : "连接中断，请重试。",
                              }
                            : message,
                    );
                } catch (error) {
                    if (error && error.name === "AbortError") {
                        updateAssistant(assistantId, (message) => ({ ...message, pending: false, stopped: true, activity: "" }));
                    } else {
                        const message = String((error && error.message) || error);
                        updateAssistant(assistantId, (current) => ({
                            ...current,
                            pending: false,
                            failed: true,
                            activity: "",
                            text: current.text ? `${current.text}\n\n请求失败：${message}` : `请求失败：${message}`,
                        }));
                        void refreshStatus();
                    }
                } finally {
                    setStreaming(false);
                    abortRef.current = null;
                }
            },
            [ctx, ensureService, gatewayUrl, input, lifecycle, messages, parseStream, refreshStatus, selectedProfile, serviceError, streaming, updateAssistant],
        );

        const retryMessage = useCallback(
            (assistantId) => {
                if (streaming) return;
                const index = messages.findIndex((message) => message.id === assistantId);
                for (let i = index - 1; i >= 0; i -= 1) {
                    if (messages[i].role === "user" && messages[i].text) {
                        void send(messages[i].text);
                        return;
                    }
                }
            },
            [messages, send, streaming],
        );

        const stop = useCallback(() => {
            if (abortRef.current) abortRef.current.abort();
            const id = threadRef.current;
            const url = serviceUrlRef.current;
            if (id && url) {
                void fetch(`${url}/api/assistant/stop`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ threadId: id }),
                }).catch(() => undefined);
            }
        }, []);

        const clear = useCallback(() => {
            if (abortRef.current) abortRef.current.abort();
            const id = threadRef.current;
            const url = serviceUrlRef.current;
            if (id && url) void fetch(`${url}/api/assistant/threads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
            setMessages([]);
            setThreadId("");
            try {
                window.localStorage.removeItem(chatStorageKey(ctx.node.id));
            } catch {
                // ignore
            }
        }, [ctx]);

        const patchProposal = useCallback(
            (assistantId, proposalId, patch) => {
                updateAssistant(assistantId, (message) => ({
                    ...message,
                    proposals: (Array.isArray(message.proposals) ? message.proposals : []).map((item) => (item.id === proposalId ? { ...item, ...patch } : item)),
                }));
            },
            [updateAssistant],
        );

        const applyProposal = useCallback(
            async (assistantId, proposal) => {
                const url = serviceUrlRef.current;
                if (!url) {
                    patchProposal(assistantId, proposal.id, { status: "expired", error: "助手服务已休眠，修复方案已失效，请重新生成" });
                    return;
                }
                patchProposal(assistantId, proposal.id, { status: "applying", error: "", output: "" });
                try {
                    const response = await fetch(`${url}/api/assistant/proposals/${encodeURIComponent(proposal.id)}/apply`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ confirm: true }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || !data.ok) {
                        const expired = response.status === 404 || response.status === 410;
                        patchProposal(assistantId, proposal.id, {
                            status: expired ? "expired" : "failed",
                            stage: data.stage || "apply",
                            error: data.error || `HTTP ${response.status}`,
                            output: data.output || "",
                            rollbackAvailable: Boolean(data.rollbackAvailable),
                            applied: data.applied || null,
                        });
                        return;
                    }
                    patchProposal(assistantId, proposal.id, { status: "applied", output: data.output || "", applied: data.applied || [], reload: true });
                } catch (error) {
                    patchProposal(assistantId, proposal.id, { status: "failed", stage: "network", error: String((error && error.message) || error), rollbackAvailable: true });
                }
            },
            [patchProposal],
        );

        const rollbackProposal = useCallback(
            async (assistantId, proposal) => {
                const url = serviceUrlRef.current || (await ensureService());
                if (!url) {
                    patchProposal(assistantId, proposal.id, { status: "failed", stage: "network", error: "助手服务没有启动，无法回滚" });
                    return;
                }
                patchProposal(assistantId, proposal.id, { status: "rolling_back", error: "", output: "" });
                try {
                    const response = await fetch(`${url}/api/assistant/proposals/${encodeURIComponent(proposal.id)}/rollback`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ confirm: true }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || !data.ok) {
                        patchProposal(assistantId, proposal.id, { status: "failed", stage: data.stage || "rollback", error: data.error || `HTTP ${response.status}`, output: data.output || "" });
                        return;
                    }
                    patchProposal(assistantId, proposal.id, { status: "rolled_back", output: data.output || "" });
                } catch (error) {
                    patchProposal(assistantId, proposal.id, { status: "failed", stage: "network", error: String((error && error.message) || error) });
                }
            },
            [ensureService, patchProposal],
        );

        const refreshProfiles = useCallback(() => {
            const next = listProfiles();
            setProfiles(next);
            const saved = String((ctx.node.metadata && ctx.node.metadata.params && ctx.node.metadata.params.assistantApiProfileId) || "");
            if (saved && next.some((profile) => profile.id === saved) && saved !== apiId) setApiId(saved);
        }, [apiId, ctx]);

        const selectApi = useCallback(
            (value) => {
                setApiId(value);
                const params = Object.assign({}, (ctx.node.metadata && ctx.node.metadata.params) || {}, { assistantApiProfileId: value });
                ctx.updateMetadata({ params });
            },
            [ctx],
        );

        const statusText =
            lifecycle === "need-package"
                ? "需要完整包"
                : lifecycle === "starting"
                  ? "正在唤起"
                  : lifecycle === "sleep"
                    ? "已休眠，发消息唤醒"
                    : lifecycle === "online"
                      ? "修复引擎在线"
                      : lifecycle === "error"
                        ? "服务未就绪"
                        : "连接中";
        const dotColor = lifecycle === "need-package" ? "#f59e0b" : lifecycle === "error" ? "#ef4444" : lifecycle === "online" ? "#22c55e" : nodeFaint;
        const needPackage = lifecycle === "need-package";
        const canSend = Boolean(input.trim()) && !streaming && !needPackage;

        const headerStyle = { display: "flex", alignItems: "center", gap: 8, padding: "9px 11px 7px", color: nodeText };
        const controlStyle = { border: `1px solid ${nodeStroke}`, background: "transparent", color: nodeText, borderRadius: 7, cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "5px 7px" };
        const selectStyle = { ...controlStyle, flex: 1, minWidth: 0, width: "auto", padding: "6px 8px", outline: "none", appearance: "none", background: nodePanel };
        const iconButtonStyle = { ...controlStyle, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 6px" };

        const empty = messages.length === 0;
        return h(
            "div",
            {
                style: { width: "100%", minWidth: 0, height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: nodePanel, color: nodeText, overflow: "hidden", borderRadius: "inherit", boxSizing: "border-box" },
            },
            h(
                "div",
                { ref: headerRef, style: { ...headerStyle, borderBottom: `1px solid ${nodeStroke}`, flexWrap: "wrap" } },
                h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 } },
                    h("span", { style: { color: ACCENT, display: "inline-flex" } }, h(Icon, { name: "spark", size: 15 })),
                    h("span", { style: { fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" } }, "画布修复"),
                    h("span", { style: { width: 6, height: 6, borderRadius: 999, background: dotColor, flexShrink: 0 } }),
                    h("span", { style: { fontSize: 10, color: nodeFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, statusText),
                ),
                h("button", { type: "button", style: iconButtonStyle, title: "做一次只读体检", onMouseDown: (event) => event.stopPropagation(), onPointerDown: (event) => event.stopPropagation(), onClick: () => void send("先做一次画布体检：按证据顺序检查网关、扫描状态、工作流可用性、资源缺失和目录设置，然后给出结论。") }, h(Icon, { name: "pulse" }), "体检"),
                lifecycle === "error"
                    ? h("button", { type: "button", style: iconButtonStyle, title: "重新唤起助手服务", onMouseDown: (event) => event.stopPropagation(), onPointerDown: (event) => event.stopPropagation(), onClick: () => void ensureService() }, "重试")
                    : null,
                h("button", { type: "button", style: iconButtonStyle, title: "清空这张卡的对话", onMouseDown: (event) => event.stopPropagation(), onPointerDown: (event) => event.stopPropagation(), onClick: clear }, h(Icon, { name: "trash" })),
            ),
            needPackage || (lifecycle === "error" && serviceError) || recoveryNotice
                ? h(
                      "div",
                      { style: { padding: "7px 11px", borderBottom: `1px solid ${nodeStroke}`, background: needPackage ? "#f59e0b12" : lifecycle === "error" ? "#ef444410" : `${ACCENT}0d`, color: needPackage ? "#b45309" : lifecycle === "error" ? "#ef4444" : nodeMuted, fontSize: 10, lineHeight: 1.6 } },
                      needPackage
                          ? "当前是应用内小补丁，Agent 工作区未安装。请从夸克网盘下载 v0.23.1 完整包后使用；画布其他功能不受影响。"
                          : lifecycle === "error"
                            ? `助手服务未就绪：${serviceError}`
                            : recoveryNotice,
                  )
                : null,
            h(
                "div",
                { ref: apiRef, style: { display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderBottom: `1px solid ${nodeStroke}` } },
                h("span", { style: { fontSize: 10, color: nodeFaint, whiteSpace: "nowrap", flexShrink: 0 } }, "API"),
                h(
                    "select",
                    {
                        value: selectedProfile ? selectedProfile.id : "",
                        style: selectStyle,
                        onFocus: () => {
                            refreshProfiles();
                            void ensureService();
                        },
                        onMouseDown: (event) => event.stopPropagation(),
                        onPointerDown: (event) => event.stopPropagation(),
                        onChange: (event) => selectApi(event.target.value),
                        title: selectedProfile ? `${selectedProfile.api.model} · ${hostLabel(selectedProfile.api.baseUrl)}` : "未配置 API",
                    },
                    allProfiles.length
                        ? allProfiles.map((profile) =>
                              h(
                                  "option",
                                  { key: profile.id, value: profile.id },
                                  `${profile.label}${profile.api.apiKey ? "" : "（无 Key）"}`,
                              ),
                          )
                        : h("option", { value: "" }, "未配置 API（设置 → 云端 API）"),
                ),
            ),
            h(
                "div",
                {
                    ref: scrollRef,
                    onMouseDown: (event) => event.stopPropagation(),
                    onPointerDown: (event) => event.stopPropagation(),
                    onWheel: (event) => event.stopPropagation(),
                    onScroll: (event) => {
                        const el = event.currentTarget;
                        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    },
                    style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 11px" },
                },
                h(
                    "div",
                    { ref: contentRef, style: { display: "flex", flexDirection: "column", gap: 9 } },
                    empty
                        ? h(
                              "div",
                              { style: { padding: "8px 0 4px", display: "flex", flexDirection: "column", gap: 10, alignItems: "center", textAlign: "center" } },
                              h("div", { style: { color: nodeFaint, fontSize: 11, lineHeight: 1.7, maxWidth: 340 } }, needPackage ? "Agent 工作区需要完整包。当前仍可正常使用画布、生成和模型功能。" : "描述你看到的现象。我会先查网关、扫描、工作流和资源，必要时读源码，给出可确认的修复方案。"),
                              selectedProfile
                                  ? h(
                                        "div",
                                        { style: { color: nodeFaint, fontSize: 10, maxWidth: 300, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                                        `已选 API：${selectedProfile.label}`,
                                    )
                                  : null,
                              h(
                                  "div",
                                  { style: { display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" } },
                                  QUICK_PROMPTS.map((item) =>
                                      h(
                                          "button",
                                          {
                                              key: item.label,
                                              type: "button",
                                              style: { ...controlStyle, fontSize: 10, padding: "5px 8px", borderRadius: 999, color: nodeMuted },
                                              onMouseDown: (event) => event.stopPropagation(),
                                              onPointerDown: (event) => event.stopPropagation(),
                                              onClick: () => void send(item.text),
                                          },
                                          item.label,
                                      ),
                                  ),
                              ),
                          )
                        : messages.map((message) => renderMessage(message, theme, applyProposal, rollbackProposal, retryMessage)),
                ),
            ),
            h(
                "div",
                { ref: composerRef, style: { borderTop: `1px solid ${nodeStroke}`, padding: "8px 11px 6px", background: nodePanel } },
                h(
                    "div",
                    {
                        onMouseDown: (event) => event.stopPropagation(),
                        onPointerDown: (event) => event.stopPropagation(),
                        style: { display: "flex", alignItems: "flex-end", gap: 6 },
                    },
                    h("textarea", {
                        ref: inputRef,
                        value: input,
                        placeholder: needPackage ? "需要下载 v0.23.1 完整包" : selectedProfile ? "描述问题，Enter 发送" : "先在设置里配置一个文本 API",
                        title: needPackage ? "Agent 工作区未安装" : "Enter 发送，Shift+Enter 换行",
                        disabled: needPackage,
                        rows: 1,
                        onMouseDown: (event) => event.stopPropagation(),
                        onPointerDown: (event) => event.stopPropagation(),
                        onKeyDown: (event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        },
                        onChange: (event) => setInput(event.target.value),
                        style: {
                            flex: 1,
                            minWidth: 0,
                            minHeight: 34,
                            maxHeight: 96,
                            overflowY: "hidden",
                            resize: "none",
                            border: `1px solid ${nodeStroke}`,
                            borderRadius: 9,
                            background: "transparent",
                            color: nodeText,
                            padding: "8px 9px",
                            fontSize: 12,
                            lineHeight: 1.5,
                            outline: "none",
                            boxSizing: "border-box",
                            fontFamily: "inherit",
                        },
                    }),
                    streaming
                        ? h(
                              "button",
                              {
                                  type: "button",
                                  title: "停止",
                                  style: { ...iconButtonStyle, width: 32, height: 32, justifyContent: "center", borderColor: `${ACCENT}66`, color: ACCENT },
                                  onMouseDown: (event) => event.stopPropagation(),
                                  onPointerDown: (event) => event.stopPropagation(),
                                  onClick: stop,
                              },
                              h(Icon, { name: "stop" }),
                          )
                        : h(
                              "button",
                              {
                                  type: "button",
                                  title: "发送",
                                  disabled: !canSend,
                                  style: { ...iconButtonStyle, width: 32, height: 32, justifyContent: "center", borderColor: canSend ? `${ACCENT}66` : nodeStroke, color: canSend ? ACCENT : nodeFaint, opacity: canSend ? 1 : 0.6 },
                                  onMouseDown: (event) => event.stopPropagation(),
                                  onPointerDown: (event) => event.stopPropagation(),
                                  onClick: () => void send(),
                              },
                              h(Icon, { name: "send" }),
                          ),
                ),
                h(
                    "div",
                    { style: { display: "flex", alignItems: "center", gap: 5, marginTop: 5, color: nodeFaint, fontSize: 9.5 } },
                    h(Icon, { name: "lock", size: 11 }),
                    h("span", null, "需确认后写入 · 不碰模型/Key"),
                    streaming ? h("span", { style: { marginLeft: "auto" } }, "正在检查…") : null,
                ),
            ),
        );
    }

    function renderInline(text, theme, prefix) {
        const nodes = [];
        const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let last = 0;
        let match;
        let index = 0;
        while ((match = regex.exec(text))) {
            if (match.index > last) nodes.push(text.slice(last, match.index));
            const token = match[0];
            if (token.startsWith("**")) {
                nodes.push(
                    h(
                        "strong",
                        { key: `${prefix}-b${index}`, style: { fontWeight: 600, color: theme.node.text } },
                        renderInline(token.slice(2, -2), theme, `${prefix}-b${index}`),
                    ),
                );
            } else {
                nodes.push(
                    h(
                        "code",
                        {
                            key: `${prefix}-c${index}`,
                            style: {
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                                fontSize: 11,
                                padding: "1px 4px",
                                borderRadius: 4,
                                background: theme.node.fill,
                                color: theme.node.text,
                            },
                        },
                        token.slice(1, -1),
                    ),
                );
            }
            last = match.index + token.length;
            index += 1;
        }
        if (last < text.length) nodes.push(text.slice(last));
        return nodes;
    }

    function renderRichText(text, theme) {
        const lines = String(text || "").split(/\r?\n/);
        const blocks = [];
        lines.forEach((line, lineIndex) => {
            const trimmed = line.trim();
            if (!trimmed) {
                blocks.push(h("div", { key: `s-${lineIndex}`, style: { height: 5 } }));
                return;
            }
            const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
            if (heading) {
                blocks.push(
                    h(
                        "div",
                        { key: `h-${lineIndex}`, style: { fontWeight: 600, fontSize: 12.5, lineHeight: 1.6, marginTop: blocks.length ? 6 : 0 } },
                        renderInline(heading[1], theme, `h-${lineIndex}`),
                    ),
                );
                return;
            }
            const bullet = trimmed.match(/^[-*]\s+(.*)$/);
            if (bullet) {
                blocks.push(
                    h(
                        "div",
                        { key: `b-${lineIndex}`, style: { display: "flex", gap: 6, alignItems: "flex-start" } },
                        h("span", { style: { color: theme.node.faint, lineHeight: 1.6, flexShrink: 0 } }, "•"),
                        h("span", { style: { flex: 1, minWidth: 0 } }, renderInline(bullet[1], theme, `b-${lineIndex}`)),
                    ),
                );
                return;
            }
            const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
            if (numbered) {
                blocks.push(
                    h(
                        "div",
                        { key: `n-${lineIndex}`, style: { display: "flex", gap: 6, alignItems: "flex-start" } },
                        h("span", { style: { color: theme.node.faint, lineHeight: 1.6, flexShrink: 0, minWidth: 12 } }, `${numbered[1]}.`),
                        h("span", { style: { flex: 1, minWidth: 0 } }, renderInline(numbered[2], theme, `n-${lineIndex}`)),
                    ),
                );
                return;
            }
            blocks.push(h("div", { key: `p-${lineIndex}`, style: { margin: 0 } }, renderInline(trimmed, theme, `p-${lineIndex}`)));
        });
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } }, blocks);
    }

    function renderMessage(message, theme, onApply, onRollback, onRetry) {
        const isUser = message.role === "user";
        const bubbleStyle = {
            maxWidth: "88%",
            padding: "7px 9px",
            borderRadius: 10,
            background: isUser ? `${ACCENT}14` : message.failed ? "#ef44440d" : "transparent",
            border: isUser ? `1px solid ${ACCENT}33` : message.failed ? "1px solid #ef444455" : `1px solid ${theme.node.stroke}66`,
            color: theme.node.text,
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            alignSelf: isUser ? "flex-end" : "flex-start",
        };
        return h(
            "div",
            { key: message.id, style: { display: "flex", flexDirection: "column", gap: 5, alignItems: isUser ? "flex-end" : "stretch", width: "100%", maxWidth: "100%" } },
            h("div", { style: { fontSize: 9, color: message.failed ? "#ef4444" : theme.node.faint, paddingInline: 2 } }, isUser ? "你" : message.pending ? "检查中…" : message.failed ? "修复助手 · 请求失败" : "修复助手"),
            h(
                "div",
                { style: bubbleStyle },
                message.text ? renderRichText(message.text, theme) : message.pending ? h("span", { style: { color: theme.node.faint } }, "正在读取本机状态…") : null,
                message.stopped ? h("div", { style: { marginTop: 4, fontSize: 10, color: theme.node.faint } }, "已停止") : null,
                !isUser && (message.failed || message.stopped)
                    ? h(
                          "div",
                          { style: { marginTop: 6 } },
                          h(
                              "button",
                              {
                                  type: "button",
                                  onMouseDown: (event) => event.stopPropagation(),
                                  onPointerDown: (event) => event.stopPropagation(),
                                  onClick: () => onRetry(message.id),
                                  style: { border: `1px solid ${ACCENT}55`, background: `${ACCENT}10`, color: ACCENT, borderRadius: 6, padding: "3px 8px", fontSize: 10, cursor: "pointer" },
                              },
                              "重试",
                          ),
                      )
                    : null,
            ),
            Array.isArray(message.proposals) && message.proposals.length
                ? h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: 6, width: "100%" } },
                      message.proposals.map((proposal) => renderProposal(proposal, theme, message.id, onApply, onRollback)),
                  )
                : null,
        );
    }

    function renderProposal(proposal, theme, messageId, onApply, onRollback) {
        const status = proposal.status || "pending";
        const files = Array.isArray(proposal.files) ? proposal.files : [];
        const failed = status === "failed";
        const expired = status === "expired";
        const done = status === "applied";
        const busy = status === "applying" || status === "rolling_back";
        const label = expired ? "已失效" : done ? "已应用" : failed ? "失败" : status === "rolled_back" ? "已回滚" : status === "applying" ? "应用中" : "修复方案";
        const color = expired ? theme.node.faint : failed ? "#ef4444" : done ? "#22c55e" : ACCENT;
        const fileLine = files.length === 1 ? files[0].path : `${files.length} 个文件`;
        const button = (text, onClick, primary) =>
            h(
                "button",
                {
                    type: "button",
                    disabled: busy,
                    onMouseDown: (event) => event.stopPropagation(),
                    onPointerDown: (event) => event.stopPropagation(),
                    onClick,
                    style: {
                        border: `1px solid ${primary ? `${ACCENT}66` : theme.node.stroke}`,
                        background: primary ? `${ACCENT}16` : "transparent",
                        color: primary ? ACCENT : theme.node.text,
                        borderRadius: 7,
                        padding: "4px 8px",
                        fontSize: 10.5,
                        fontWeight: primary ? 600 : 500,
                        cursor: busy ? "default" : "pointer",
                        opacity: busy ? 0.6 : 1,
                    },
                },
                text,
            );
        const details = [
            ...files.map((file) =>
                h(
                    "div",
                    { key: file.path, style: { fontSize: 9.5, color: theme.node.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" } },
                    `${file.isCreate ? "+ " : "~ "}${file.path}`,
                ),
            ),
            ...files
                .filter((file) => file.oldPreview || file.newPreview)
                .map((file) =>
                    h(
                        "pre",
                        { key: `${file.path}-diff`, style: { margin: "3px 0 0", maxHeight: 120, overflow: "auto", background: theme.node.panel, borderRadius: 6, padding: "4px 5px", fontSize: 9, lineHeight: 1.45, whiteSpace: "pre-wrap", color: theme.node.muted } },
                        `${file.oldPreview ? `- ${file.oldPreview}\n` : ""}+ ${file.newPreview || ""}`,
                    ),
                ),
            proposal.output
                ? h(
                      "pre",
                      { style: { margin: "3px 0 0", maxHeight: 140, overflow: "auto", background: theme.node.panel, borderRadius: 6, padding: "4px 5px", fontSize: 9, lineHeight: 1.45, whiteSpace: "pre-wrap", color: theme.node.muted } },
                      String(proposal.output).slice(-3000),
                  )
                : null,
        ].filter(Boolean);
        return h(
            "div",
            { key: proposal.id, style: { border: `1px solid ${failed ? "#ef444455" : done ? "#22c55e55" : `${ACCENT}44`}`, borderRadius: 8, padding: "7px 8px", background: theme.node.fill } },
            h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
                h("span", { style: { fontSize: 10.5, fontWeight: 600, color } }, label),
                h("span", { style: { fontSize: 10, color: theme.node.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, proposal.summary || ""),
            ),
            h(
                "div",
                { title: fileLine, style: { marginTop: 3, fontSize: 9.5, color: theme.node.faint, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                fileLine,
            ),
            failed ? h("div", { style: { marginTop: 3, fontSize: 9.5, color: "#ef4444" } }, `${proposal.stage || "失败"}${proposal.error ? ` · ${proposal.error}` : ""}`) : null,
            expired ? h("div", { style: { marginTop: 3, fontSize: 9.5, color: theme.node.faint } }, "助手服务已重启，方案已失效；请重新生成。") : null,
            h(
                "div",
                { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                status === "pending" ? button("应用修复", () => void onApply(messageId, proposal), true) : null,
                busy ? h("span", { style: { fontSize: 9.5, color: theme.node.muted } }, status === "applying" ? "正在构建…" : "正在回滚…") : null,
                done ? button("刷新", () => window.location.reload(), true) : null,
                done || (failed && proposal.rollbackAvailable) ? button("回滚", () => void onRollback(messageId, proposal)) : null,
                status === "rolled_back" ? h("span", { style: { fontSize: 9.5, color: theme.node.muted } }, "已恢复") : null,
            ),
            details.length
                ? h(
                      "details",
                      { style: { marginTop: 5 } },
                      h("summary", { style: { fontSize: 9.5, color: theme.node.faint, cursor: "pointer" } }, "详情"),
                      h("div", { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 3 } }, details),
                  )
                : null,
        );
    }

    const css = `
@keyframes canvas-assistant-spin { to { transform: rotate(360deg); } }
`;

    return {
        id: "canvas-assistant",
        name: "画布修复助手",
        version: "0.3.1",
        description: "画布原生修复 Agent：按需唤起、只读诊断、读源码、提出修改，用户确认后应用、构建并部署；3 分钟无提问自动休眠。",
        defaultEnabled: true,
        css,
        nodes: [
            {
                type: NODE_TYPE,
                title: "画布修复助手",
                icon: h(Icon, { name: "spark", size: 16 }),
                description: "诊断并修复画布问题",
                defaultSize: { width: 520, height: 640 },
                defaultMetadata: {},
                minimapColor: ACCENT,
                hasSourceHandle: false,
                Content,
            },
        ],
    };
}
