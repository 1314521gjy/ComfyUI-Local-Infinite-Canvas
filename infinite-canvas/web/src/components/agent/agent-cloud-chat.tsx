import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { App, Button, Popconfirm, Popover, Tooltip } from "antd";
import { Bot, Code2, Gauge, LoaderCircle, MessagesSquare, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentChatComposer } from "./agent-chat-composer";
import { AgentChatMessage, AgentPendingToolCard, type AgentChatAttachment, type AgentChatMessageItem } from "./agent-chat-message";
import { summarizeCanvasAgentOps, type CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { canvasThemes } from "@/lib/canvas-theme";
import { useEffectiveCardSkin } from "@/lib/canvas/use-canvas-theme";
import { readImageMeta } from "@/lib/image-utils";
import { useAgentChatStore } from "@/stores/use-agent-chat-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useDevAgentStore } from "@/stores/use-dev-agent-store";
import { syncAgentProvider } from "@/services/api/agent-provider";
import { resolvePiAgentUrl, sendPiAgentToolResult, streamPiAgentChat } from "@/services/api/assistant";
import { ensureAssistantRuntime, fetchAssistantRuntimeStatus, type AssistantRuntimeStatus } from "@/services/api/resources";
import { activePromptCloudApi, modelOptionLabel, modelOptionName, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type CloudAttachment = AgentChatAttachment & { dataUrl: string; mimeType: string; size: number };

const MAX_ATTACHMENTS = 6;
const MAX_PAYLOAD_BYTES = 30 * 1024 * 1024;

function readFileDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function canvasFeatureCatalog() {
    const config = useConfigStore.getState().config;
    const imageModels = selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) }));
    const videoModels = selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) }));
    return {
        note: "这是你自己查用的能力目录。回答时只摘与问题相关的 1-2 句，不要把整段贴给用户。",
        modelUsage: "创建生成卡时 metadata.model 必须使用 models.image[].value；label 只用于匹配用户说法。用户指定了模型就不要替换，Z Image 不能用 Krea2。",
        directExecution: "Agent 可直接执行的只有 canvas_apply_ops：读取、添加/更新/删除节点、连接/删除连线、选中、视口、run_generation。区域布局编辑器、局部编辑、四视图、提示词优化/反推、视频超分/插帧等是独立 UI，说明入口即可，不要声称已经执行。",
        features: [
            {
                id: "moss-layout",
                name: "MOSS 区域布局",
                entry: "MOSS 模型（8步/50步）的配置卡或图片卡 → 图像设置 → 区域布局 → 打开区域布局编辑器",
                when: "一张图里需要多个区域，每个区域单独填写提示词或文字",
                how: "在编辑器里画框，为每个区域填写提示词/文字；背景框先画，人物、物体、文字框后画；确认后生成。区域类型：背景/人物/物体/文字",
                limits: "仅 MOSS 模型可用；普通文生图不会使用旧布局；这不是局部编辑",
            },
            {
                id: "local-edit",
                name: "局部编辑（蒙版）",
                entry: "图片卡悬浮工具 → 局部编辑",
                when: "只修改图片中的一块区域，其他区域保持原样",
                how: "在图上涂蓝色蒙版并填写修改要求，确认后生成编辑结果；默认走 Qwen Image 2.1 编辑",
                limits: "入口在图片卡悬浮工具；不是 MOSS 区域布局；不是整图重绘",
            },
            {
                id: "four-view",
                name: "四视图",
                entry: "图片卡悬浮工具 → 四视图",
                when: "从一张角色图生成角色设定四视图",
                how: "以原图为参考，调用固定 image-krea2-four-view 工作流，输出一张四视图角色设定图",
                limits: "需要角色图片；画布会自动使用固定四视图提示词，不需要写拼图/分栏排版词；输出是一张四视图设定图，不是四张普通图，也不是多角度",
            },
            {
                id: "prompt",
                name: "提示词优化 / 反推 / 提示词库",
                entry: "配置卡或提示词面板 → 优化提示词；图片卡 → 反推提示词；左侧提示词库",
                when: "把简短描述扩写成提示词，或从图片反推提示词",
                how: "反推引擎可选 Qwen3.5-9B、Florence-2 PromptGen、云端 API；优化提示词使用当前提示词优化 API；提示词库可搜索",
                limits: "反推需要图片参考，输出文本；不会自动生成图片",
            },
            {
                id: "image-tools",
                name: "图片工具",
                entry: "图片卡悬浮工具",
                tools: ["复制提示词", "反推提示词", "替换图片", "锁/自由比例", "局部编辑", "裁剪", "切图", "放大", "AI 超分", "多角度", "四视图", "查看大图", "存资产", "存为风格"],
                multiAngle: "多角度是换机位生成新图，和四视图不同",
            },
            {
                id: "video",
                name: "视频工具",
                entry: "视频卡悬浮工具 / 视频工作台",
                tools: ["首尾帧 / 全能参考模式", "视频超分（SeedVR2）", "RIFE 插帧 2×/3×", "H3 角色替换", "极速草稿", "对比", "同步播放"],
                draft: "极速草稿用首尾帧快速预览，最终成片仍用 VDN 或多参工作流",
            },
            {
                id: "style-recipe",
                name: "风格配方",
                entry: "左侧「风格配方」页签；图片菜单 → 存为风格",
                how: "保存底模、LoRA 与案例图；套用时新建生成卡并还原独立 LoRA 卡和连线",
                limits: "不保存提示词、尺寸、张数；这些由生成卡自己设置",
            },
            {
                id: "lora",
                name: "LoRA 叠层",
                entry: "画布上的 LoRA 卡，连接到图片或视频卡",
                how: "单卡最多 10 条 LoRA，每条独立强度；生成时一起注入",
            },
            {
                id: "assets",
                name: "资产与自由卡片",
                entry: "左侧「资产」「自由卡片」；画布顶部可插入",
                how: "资产可复用为参考图；自由卡片可导入 ComfyUI 工作流",
            },
            {
                id: "node-types",
                name: "画布卡片类型",
                how: "图片、文本、配置、视频、音频、分组、自由卡片；配置卡负责模型/尺寸/数量/输入顺序，图片和视频卡负责生成与展示",
            },
        ],
        models: {
            image: imageModels,
            video: videoModels,
            defaults: {
                image: modelOptionLabel(config, config.imageModel || config.model),
                video: modelOptionLabel(config, config.videoModel || config.model),
            },
        },
    };
}

function compactCanvasState() {
    const snapshot = useAgentStore.getState().canvasContext?.snapshot;
    if (!snapshot) return { error: "当前不在画布页面，请先打开一个画布。" };
    return {
        projectId: snapshot.projectId,
        title: snapshot.title,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes.slice(0, 120).map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            prompt: typeof node.metadata?.prompt === "string" ? node.metadata.prompt.slice(0, 500) : "",
            model: node.metadata?.model || "",
            status: node.metadata?.status || "",
            generationMode: node.metadata?.generationMode || "",
            generationType: node.metadata?.generationType || "",
            imageMode: node.metadata?.imageMode || "",
            size: node.metadata?.size || "",
            count: node.metadata?.count || "",
            seed: node.metadata?.seed || "",
            seconds: node.metadata?.seconds || "",
            vquality: node.metadata?.vquality || "",
            videoMode: node.metadata?.videoMode || "",
            frameMode: node.metadata?.frameMode || "",
            aspectRatio: node.metadata?.aspectRatio || "",
            params: node.metadata?.params || null,
            freeCard: node.metadata?.freeCard ? { name: node.metadata.freeCard.name, workflowId: node.metadata.freeWorkflowId || "" } : null,
        })),
        connections: snapshot.connections.map((connection) => ({ id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
    };
}

function AgentSettingToggle({ icon, title, description, checked, theme, onChange, disabled = false }: { icon: ReactNode; title: string; description: string; checked: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: () => void; disabled?: boolean }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            disabled={disabled}
            className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition ${disabled ? "cursor-not-allowed opacity-55" : ""}`}
            style={{ borderColor: checked ? theme.node.muted : theme.node.stroke, background: checked ? theme.toolbar.activeBg : "transparent", color: theme.node.text }}
            aria-pressed={checked}
            aria-disabled={disabled}
            onClick={disabled ? undefined : onChange}
        >
            <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0">{icon}</span>
                <span className="min-w-0">
                    <span className="block font-medium">{title}</span>
                    <span className="mt-0.5 block text-[11px] leading-4" style={{ color: theme.node.muted }}>{description}</span>
                </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: theme.node.muted }}>
                {checked ? t("agent.dev.enabled") : t("agent.dev.disabled")}
                <span className="relative inline-flex h-4 w-7 items-center rounded-full transition" style={{ background: checked ? "#16a34a" : theme.node.stroke }}>
                    <span className="absolute size-3 rounded-full bg-white transition-all" style={{ left: checked ? 14 : 2 }} />
                </span>
            </span>
        </button>
    );
}

export function AgentCloudChat() {    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const config = useConfigStore((state) => state.config);
    const api = activePromptCloudApi(config);
    const conversations = useAgentChatStore((state) => state.conversations);
    const activeId = useAgentChatStore((state) => state.activeId);
    const activeConversation = conversations.find((conversation) => conversation.id === activeId);
    const loadedConversationRef = useRef<string | null>(null);
    const lastSavedActiveIdRef = useRef(activeId);
    const [prompt, setPrompt] = useState("");
    const [attachments, setAttachments] = useState<CloudAttachment[]>([]);
    const [messages, setMessages] = useState<AgentChatMessageItem[]>([]);
    const [sending, setSending] = useState(false);
    const [pending, setPending] = useState<{ summary: string; resolve: (approved: boolean) => void } | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [error, setError] = useState("");
    const [piUrl, setPiUrl] = useState(() => (typeof window === "undefined" ? "" : localStorage.getItem("canvas-pi-agent-url") || ""));
    const [piStatus, setPiStatus] = useState<AssistantRuntimeStatus | null>(null);
    const [piError, setPiError] = useState("");
    const piEnsureInFlightRef = useRef(false);
    const piEnsureLastAtRef = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const pendingRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);
    const attachmentUrlsRef = useRef(new Set<string>());
    const scrollTimerRef = useRef<number | null>(null);
    const queueRef = useRef<Array<{ text: string; attachments: CloudAttachment[] }>>([]);
    const [queueCount, setQueueCount] = useState(0);
    const confirmTools = useAgentStore((state) => state.confirmTools);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const skin = useEffectiveCardSkin() as string;
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const devAgent = useDevAgentStore();
    const devEnabled = devAgent.enabled;
    const providerReady = Boolean(api?.baseUrl?.trim() && api?.apiKey?.trim() && api?.model?.trim());
    const piInstalled = Boolean(piStatus?.available);
    const piOnline = Boolean(piStatus?.running && piStatus.online && piUrl);
    const backend = { source: piOnline && providerReady ? ("pi" as const) : ("none" as const) };
    const developerAvailable = piOnline && providerReady;
    const modeLabel = developerAvailable && devEnabled ? t("agent.dev.title") : t("agent.dev.normalMode");
    const cloudApi = api;
    const runtimeLabel = piOnline ? `pi Agent · ${api?.model || ""}`.trim() : t("agent.dev.idle");
    const runtimeModel = api?.model || "—";

    const refreshPi = useCallback(async ({ ensure = false, force = false }: { ensure?: boolean; force?: boolean } = {}) => {
        const applyStatus = (status: AssistantRuntimeStatus) => {
            setPiStatus(status);
            const nextUrl = status.running && status.online && status.url ? status.url : "";
            setPiUrl(nextUrl);
            if (nextUrl) {
                localStorage.setItem("canvas-pi-agent-url", nextUrl);
                setPiError("");
            } else {
                localStorage.removeItem("canvas-pi-agent-url");
            }
        };
        try {
            let status = await fetchAssistantRuntimeStatus();
            applyStatus(status);
            const online = Boolean(status.running && status.online && status.url);
            const now = Date.now();
            if (ensure && status.available && !online && !piEnsureInFlightRef.current && (force || now - piEnsureLastAtRef.current > 3000)) {
                piEnsureInFlightRef.current = true;
                piEnsureLastAtRef.current = now;
                setPiError("");
                try {
                    await ensureAssistantRuntime(false);
                    status = await fetchAssistantRuntimeStatus();
                    applyStatus(status);
                } catch (reason) {
                    setPiError(reason instanceof Error ? reason.message : String(reason));
                } finally {
                    piEnsureInFlightRef.current = false;
                }
            }
        } catch (reason) {
            setPiStatus(null);
            setPiUrl("");
            setPiError(reason instanceof Error ? reason.message : String(reason));
        }
    }, []);

    useEffect(() => {
        void refreshPi({ ensure: true });
    }, [refreshPi]);

    useEffect(() => {
        const timer = window.setInterval(() => void refreshPi({ ensure: panelOpen }), 5000);
        return () => window.clearInterval(timer);
    }, [refreshPi, panelOpen]);

    useEffect(() => {
        if (panelOpen) void refreshPi({ ensure: true });
    }, [panelOpen, refreshPi]);

    useEffect(() => {
        if (!cloudApi) return;
        void syncAgentProvider({ baseUrl: cloudApi.baseUrl.trim(), apiKey: cloudApi.apiKey.trim(), model: cloudApi.model.trim(), label: cloudApi.name }).catch(() => undefined);
    }, [cloudApi?.id, cloudApi?.baseUrl, cloudApi?.apiKey, cloudApi?.model]);
    useEffect(() => {
        const state = useAgentStore.getState();
        if (state.canvasReferences.length || state.attachments.length) state.setAgentState({ canvasReferences: [], attachments: [] });
        return () => {
            pendingRef.current?.resolve(false);
            pendingRef.current = null;
            abortRef.current?.abort();
            attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        };
    }, []);
    useEffect(() => {
        useAgentStore.getState().setAgentState({ sending, waiting: sending });
    }, [sending]);
    useEffect(() => {
        const state = useAgentChatStore.getState();
        const active = state.conversations.find((conversation) => conversation.id === state.activeId);
        if (!active || loadedConversationRef.current === active.id) return;
        loadedConversationRef.current = active.id;
        setMessages(active.messages);
        setError("");
    }, [conversations, activeId]);
    useEffect(() => {
        if (sending || loadedConversationRef.current !== activeId) return;
        if (lastSavedActiveIdRef.current !== activeId) {
            lastSavedActiveIdRef.current = activeId;
            return;
        }
        useAgentChatStore.getState().saveMessages(activeId, messages);
    }, [messages, sending, activeId]);
    useEffect(() => {
        if (scrollTimerRef.current !== null) return;
        scrollTimerRef.current = window.setTimeout(() => {
            scrollTimerRef.current = null;
            listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
        }, 80);
    }, [messages, pending, sending, error]);
    useEffect(() => () => {
        if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    }, []);

    const appendMessage = (item: Omit<AgentChatMessageItem, "id">) => {
        setMessages((current) => [...current, { ...item, id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length));
        if (!images.length) return;
        try {
            const next = await Promise.all(images.map(async (file) => {
                const dataUrl = await readFileDataUrl(file);
                const meta = await readImageMeta(dataUrl);
                const url = URL.createObjectURL(file);
                attachmentUrlsRef.current.add(url);
                return { id: `cloud-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, url, dataUrl, mimeType: file.type, size: file.size, width: meta.width, height: meta.height };
            }));
            const merged = [...attachments, ...next];
            if (merged.reduce((sum, item) => sum + item.size, 0) > MAX_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                message.error(t("agent.runtime.imageLimit"));
                return;
            }
            setAttachments(merged);
        } catch (err) {
            message.error(err instanceof Error ? err.message : t("agent.runtime.imageReadFailed"));
        }
    };

    const removeAttachment = (id: string) => {
        setAttachments((current) => {
            const target = current.find((item) => item.id === id);
            if (target) {
                URL.revokeObjectURL(target.url);
                attachmentUrlsRef.current.delete(target.url);
            }
            return current.filter((item) => item.id !== id);
        });
    };

    const requestApproval = (summary: string) => new Promise<boolean>((resolve) => {
        pendingRef.current = { resolve };
        setPending({ summary, resolve });
    });

    const updateConfirmTools = (next: boolean) => {
        localStorage.setItem("canvas-agent-confirm-tools", next ? "1" : "0");
        useAgentStore.getState().setAgentState({ confirmTools: next });
    };

    const executeTool = async (name: string, input: Record<string, unknown>) => {
        if (name === "canvas_get_state") return compactCanvasState();
        if (name === "canvas_get_features") return canvasFeatureCatalog();
        if (name === "site_navigate") {
            const path = typeof input.path === "string" ? input.path : "/";
            navigate(path);
            return { ok: true, path };
        }
        if (name === "canvas_apply_ops") {
            const context = useAgentStore.getState().canvasContext;
            if (!context) return { error: "当前不在画布页面，请先打开一个画布。" };
            const ops = Array.isArray(input.ops) ? (input.ops as CanvasAgentOp[]) : [];
            if (!ops.length) return { error: "ops 不能为空。" };
            if (useAgentStore.getState().confirmTools) {
                const summary = summarizeCanvasAgentOps(ops) || "修改当前画布";
                const approved = await requestApproval(summary);
                if (!approved) return { error: "用户拒绝了本次画布操作。" };
            }
            const result = context.applyOps(ops);
            return {
                ok: true,
                nodeCount: result.nodes.length,
                connectionCount: result.connections.length,
                selectedNodeIds: result.selectedNodeIds,
                message: ops.some((op) => op.type === "run_generation") ? "已触发生成，任务在画布中运行。" : "画布已更新。",
            };
        }
        return { error: `未知工具：${name}` };
    };

    const runPiChat = async (userText: string, userAttachments: CloudAttachment[]) => {
        if (!cloudApi) {
            openConfigDialog(false, "cloud-api");
            return;
        }
        if (userAttachments.length) {
            message.warning(t("agent.dev.noAttachments"));
            return;
        }
        setError("");
        setSending(true);
        const controller = new AbortController();
        abortRef.current = controller;
        const history = messages
            .filter((item) => (item.role === "user" || item.role === "assistant") && item.text.trim())
            .slice(-12)
            .map((item) => ({ role: item.role, content: item.text }));
        appendMessage({ role: "user", text: userText });
        setPrompt("");
        let liveId: string | null = null;
        let content = "";
        const ensureLive = () => {
            if (liveId) return liveId;
            liveId = `pi-live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const id = liveId;
            setMessages((current) => [...current, { id, role: "assistant", text: "", streamId: id }]);
            return id;
        };
        const patchLive = (patch: Partial<AgentChatMessageItem>) => {
            if (!liveId) return;
            const id = liveId;
            setMessages((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
        };
        try {
            await syncAgentProvider({ baseUrl: cloudApi.baseUrl.trim(), apiKey: cloudApi.apiKey.trim(), model: cloudApi.model.trim(), label: cloudApi.name }).catch(() => undefined);
            const url = piUrl || (await resolvePiAgentUrl());
            let streamError = "";
            let finalText = "";
            await streamPiAgentChat(
                url,
                {
                    threadId: activeConversation?.id,
                    message: userText,
                    gatewayUrl: "",
                    history,
                    context: compactCanvasState(),
                    mode: devEnabled ? "developer" : "normal",
                },
                {
                    signal: controller.signal,
                    onEvent: ({ event, data }) => {
                        if (event === "delta") {
                            const delta = String(data.text || "");
                            if (!delta) return;
                            content += delta;
                            const id = ensureLive();
                            patchLive({ text: content, streamId: id });
                        } else if (event === "tool_start") {
                            const label = String(data.label || data.name || "工具");
                            appendMessage({ role: "tool", title: label, text: label });
                        } else if (event === "canvas_tool") {
                            const callId = String(data.callId || "");
                            const name = String(data.name || "");
                            const args = data.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : {};
                            const label = name === "canvas_get_state" ? "读取画布" : name === "canvas_get_features" ? "查询画布功能" : name === "canvas_apply_ops" ? "操作画布" : name === "site_navigate" ? "打开页面" : name || "画布工具";
                            appendMessage({ role: "tool", title: label, text: label });
                            void (async () => {
                                try {
                                    const result = await executeTool(name, args);
                                    await sendPiAgentToolResult(url, { callId, result });
                                } catch (reason) {
                                    await sendPiAgentToolResult(url, { callId, error: reason instanceof Error ? reason.message : String(reason) }).catch(() => undefined);
                                }
                            })();
                        } else if (event === "error") {
                            streamError = String(data.message || "pi Agent 请求失败");
                        } else if (event === "done") {
                            finalText = String(data.text || "");
                        }
                    },
                },
            );
            if (streamError) throw new Error(streamError);
            const answer = (finalText || content).trim();
            if (!answer) throw new Error("pi Agent 返回了空消息。");
            ensureLive();
            patchLive({ text: answer, streamId: undefined });
            liveId = null;
        } catch (reason) {
            if (liveId) {
                patchLive({ streamId: undefined });
                liveId = null;
            }
            if (controller.signal.aborted) {
                appendMessage({ role: "system", text: t("agent.runtime.taskStopped") });
            } else {
                const text = reason instanceof Error ? reason.message : String(reason);
                setError(text);
                appendMessage({ role: "error", text: `pi Agent：${text}` });
            }
        } finally {
            abortRef.current = null;
            const next = queueRef.current.shift();
            setQueueCount(queueRef.current.length);
            if (next) {
                void dispatch(next.text, next.attachments);
            } else {
                setSending(false);
            }
        }
    };

    const dispatch = (text: string, userAttachments: CloudAttachment[]) => {
        if (!canUse) {
            void refreshPi({ ensure: true, force: true });
            return;
        }
        void runPiChat(text, userAttachments);
    };

    const canUse = backend.source !== "none";
    const modelLabel = runtimeModel;
    const contextChars = messages.reduce((total, item) => total + item.text.length + (item.reasoning?.length || 0), 0) + prompt.length;
    const contextTokens = Math.ceil(contextChars / 4);
    const snapshot = useAgentStore((state) => state.canvasContext?.snapshot);
    const statusTitle = !piStatus ? t("agent.dev.checking") : !piInstalled ? t("agent.dev.notInstalled") : !piOnline ? t("agent.dev.notLoaded") : t("agent.dev.apiMissing");
    const statusHint = !piStatus
        ? ""
        : !piInstalled
          ? [piStatus.reason || piStatus.missing?.join("、"), t("agent.dev.notInstalledHint")].filter(Boolean).join(" · ")
          : !piOnline
            ? piError || piStatus.reason || piStatus.lastError || t("agent.dev.notLoadedHint")
            : t("agent.cloud.noApiHint");
    const statusAction = !piStatus ? "refresh" : !piInstalled ? "install" : !piOnline ? "retry" : "config";

    const submit = () => {
        if (!canUse) {
            void refreshPi({ ensure: true, force: true });
            return;
        }
        const text = prompt.trim();
        if (!text && !attachments.length) return;
        if (sending) {
            queueRef.current.push({ text, attachments });
            setQueueCount(queueRef.current.length);
            setPrompt("");
            setAttachments([]);
            message.success(t("agent.dev.queued", { count: queueRef.current.length }));
            return;
        }
        void dispatch(text, attachments);
    };
    const stop = () => {
        pendingRef.current?.resolve(false);
        pendingRef.current = null;
        setPending(null);
        abortRef.current?.abort();
    };
    const newConversation = () => {
        if (sending) return;
        useAgentChatStore.getState().createConversation();
    };
    const switchConversation = (id: string) => {
        if (sending) return;
        useAgentChatStore.getState().selectConversation(id);
    };
    const deleteConversation = (id: string) => {
        if (sending) return;
        useAgentChatStore.getState().deleteConversation(id);
    };

    const conversationMenu = (
        <div className="w-64 text-xs" style={{ color: theme.node.text }}>
            <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                onClick={newConversation}
            >
                <Plus className="size-3.5" />
                {t("agent.dev.newChat")}
            </button>
            <div className="thin-scrollbar mt-1 max-h-64 overflow-y-auto">
                {conversations.map((conversation) => (
                    <div
                        key={conversation.id}
                        className="group flex items-center gap-1 rounded-lg px-2 py-1.5 transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ background: conversation.id === activeId ? theme.toolbar.activeBg : "transparent", color: conversation.id === activeId ? theme.toolbar.activeText : theme.node.text }}
                    >
                        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => switchConversation(conversation.id)} title={conversation.title}>
                            {conversation.title}
                        </button>
                        {conversations.length > 1 ? (
                            <Popconfirm title={t("agent.dev.deleteChat")} okText={t("agent.dev.delete")} cancelText={t("agent.dev.cancel")} onConfirm={() => deleteConversation(conversation.id)}>
                                <button type="button" className="grid size-5 shrink-0 place-items-center rounded opacity-0 transition group-hover:opacity-70 hover:opacity-100" aria-label={t("agent.dev.delete")}>
                                    <Trash2 className="size-3" />
                                </button>
                            </Popconfirm>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
    const contextPanel = (
        <div className="w-64 space-y-1.5 text-xs" style={{ color: theme.node.text }}>
            {[
                [t("agent.dev.contextAgent"), runtimeLabel],
                [t("agent.dev.contextModel"), modelLabel],
                [t("agent.dev.contextMode"), modeLabel],
                [t("agent.dev.contextSession"), `${activeConversation?.title || t("agent.dev.newChat")} · ${t("agent.dev.messages", { count: messages.length })}`],
                [t("agent.dev.contextCanvas"), `${snapshot?.nodes.length || 0} ${t("agent.dev.nodes")} · ${snapshot?.connections.length || 0} ${t("agent.dev.connections")}`],
                [t("agent.dev.contextTokens"), t("agent.dev.tokens", { count: contextTokens.toLocaleString() })],
                [t("agent.dev.contextSkills"), developerAvailable && devEnabled ? t("agent.dev.skillsDev") : t("agent.dev.skillsNormal")],
            ].map(([label, value]) => (
                <div key={String(label)} className="flex items-start justify-between gap-3">
                    <span className="shrink-0" style={{ color: theme.node.muted }}>{label}</span>
                    <span className="min-w-0 truncate text-right" title={String(value)}>{value}</span>
                </div>
            ))}
            <div className="pt-1 text-[11px] leading-5" style={{ color: theme.node.muted }}>{t("agent.dev.contextNote")}</div>
        </div>
    );

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ color: theme.node.text }}>
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: theme.node.stroke }}>
                <span className="grid size-7 place-items-center rounded-full" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>
                    <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-semibold leading-5">
                        <span className="truncate" title={runtimeLabel}>{runtimeLabel}</span>
                    </div>
                    <div className="truncate text-[10px] leading-4" style={{ color: theme.node.muted }}>
                        {activeConversation?.title || t("agent.dev.newChat")} · {piOnline ? "pi Agent" : !piInstalled ? t("agent.dev.notInstalled") : !piStatus ? t("agent.dev.checking") : t("agent.dev.notLoaded")}
                    </div>
                </div>
                <Popover trigger="click" placement="bottomRight" content={conversationMenu}>
                    <Tooltip title={t("agent.dev.switchConversation")}>
                        <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<MessagesSquare className="size-4" />} aria-label={t("agent.dev.switchConversation")} />
                    </Tooltip>
                </Popover>
                <Popover trigger="click" placement="bottomRight" content={contextPanel}>
                    <Tooltip title={t("agent.dev.context")}>
                        <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<Gauge className="size-4" />} aria-label={t("agent.dev.context")} />
                    </Tooltip>
                </Popover>
                <Tooltip title={t("agent.permissions.title")}>
                    <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<ShieldCheck className="size-4" />} onClick={() => setSettingsOpen((open) => !open)} aria-label={t("agent.permissions.title")} />
                </Tooltip>
            </div>
            {settingsOpen ? (
                <div className="shrink-0 border-b px-4 py-2.5 text-xs" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <div className="mt-1.5 text-[11px] leading-5" style={{ color: theme.node.muted }}>
                        <span>{piOnline ? `pi Agent：${api?.model || "—"} · ${modeLabel} · ${developerAvailable && devEnabled ? t("agent.dev.skillsDev") : t("agent.dev.skillsNormal")}` : !piInstalled ? t("agent.dev.notInstalledHint") : t("agent.dev.notLoadedHint")}</span>
                    </div>
                    <div className="mt-2 space-y-2">
                        <AgentSettingToggle
                            icon={<Code2 className="size-4" />}
                            title={t("agent.dev.title")}
                            description={developerAvailable ? t("agent.dev.description") : !piInstalled ? t("agent.dev.notInstalledHint") : !piOnline ? t("agent.dev.notLoadedHint") : t("agent.dev.apiMissing")}
                            checked={developerAvailable && devEnabled}
                            theme={theme}
                            disabled={!developerAvailable}
                            onChange={() => devAgent.setEnabled(!devEnabled)}
                        />
                        <AgentSettingToggle
                            icon={<ShieldCheck className="size-4" />}
                            title={t("agent.permissions.canvasTitle")}
                            description={t("agent.permissions.canvasDescription")}
                            checked={confirmTools}
                            theme={theme}
                            onChange={() => updateConfirmTools(!confirmTools)}
                        />
                    </div>
                </div>
            ) : null}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {!messages.length && !pending && !sending ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <Bot className="size-8 opacity-35" />
                        <div className="text-sm font-medium">{canUse ? t("agent.cloud.emptyTitle") : statusTitle}</div>
                        <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{canUse ? t("agent.cloud.emptyHint") : statusHint}</div>
                        {!canUse ? (
                            <div className="mt-2 flex flex-wrap justify-center gap-2">
                                {statusAction === "retry" || statusAction === "refresh" ? (
                                    <Button type={statusAction === "retry" ? "primary" : "default"} size="small" onClick={() => void refreshPi({ ensure: true, force: true })}>
                                        {t("agent.dev.retry")}
                                    </Button>
                                ) : null}
                                {statusAction === "config" ? (
                                    <Button type="primary" size="small" onClick={() => openConfigDialog(false, "cloud-api")}>
                                        {t("agent.cloud.configureApi")}
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
                <div className="space-y-4">
                    {messages.map((item) => <AgentChatMessage key={item.id} item={item} theme={theme} />)}
                    {!canUse ? (
                        <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            {statusTitle}
                            {statusHint ? ` · ${statusHint}` : ""}
                        </div>
                    ) : null}
                    {pending ? <AgentPendingToolCard summary={pending.summary} theme={theme} onReject={() => { pending.resolve(false); pendingRef.current = null; setPending(null); }} onApprove={() => { pending.resolve(true); pendingRef.current = null; setPending(null); }} /> : null}
                    {sending ? (
                        <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                            <LoaderCircle className="size-3.5 animate-spin" />
                            {t("agent.cloud.thinking")}
                        </div>
                    ) : null}
                    {error ? <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>{error}</div> : null}
                </div>
            </div>
            {queueCount ? (
                <div className="px-4 pb-1 text-[11px]" style={{ color: theme.node.muted }}>{t("agent.dev.queued", { count: queueCount })}</div>
            ) : null}
            <AgentChatComposer
                prompt={prompt}
                attachments={attachments.map(({ id, name, url }) => ({ id, name, url }))}
                disabled={!canUse}
                sending={sending}
                placeholder={canUse ? t("agent.cloud.placeholder") : !piStatus ? t("agent.dev.checking") : !piInstalled ? t("agent.dev.notInstalled") : !piOnline ? t("agent.dev.notLoaded") : t("agent.dev.apiMissing")}
                theme={theme}
                onPromptChange={setPrompt}
                onSubmit={submit}
                onStop={stop}
                onAddFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                confirmTools={confirmTools}
                onConfirmToolsChange={updateConfirmTools}
            />
        </div>
    );
}
