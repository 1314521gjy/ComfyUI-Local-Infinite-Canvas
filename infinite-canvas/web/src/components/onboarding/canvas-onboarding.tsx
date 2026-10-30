import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const STORAGE_KEY = "infinite-canvas:onboarding:v1";
const SAMPLE_PROMPT = "一只橘猫坐在窗台上晒太阳，午后柔光，电影感，细节丰富";
const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

type SetupInfo = {
    reachable: boolean;
    phase: string;
    available: number;
    total: number;
};

type CanvasOnboardingProps = {
    open: boolean;
    onClose: () => void;
    nodes: CanvasNodeData[];
    imageModel: string;
    hasActiveGeneration: (nodeId: string) => boolean;
    onCreateImageNode: () => void;
};

function panelFor(nodeId: string | null) {
    if (!nodeId) return null;
    return Array.from(document.querySelectorAll<HTMLElement>("[data-node-panel]")).find((element) => element.dataset.nodePanel === nodeId) || null;
}

function promptTextarea() {
    const areas = document.querySelectorAll<HTMLTextAreaElement>('[data-node-panel] [data-onboarding="prompt-input"]');
    return areas.item(areas.length - 1) || null;
}

function fillPrompt() {
    const textarea = promptTextarea();
    if (!textarea || textarea.value.trim()) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, SAMPLE_PROMPT);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    return true;
}

export function CanvasOnboarding({ open, onClose, nodes, imageModel, hasActiveGeneration, onCreateImageNode }: CanvasOnboardingProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const maskId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const tooltipRef = useRef<HTMLDivElement>(null);
    const initialImageIds = useRef<Set<string>>(new Set());
    const promptSeeded = useRef(false);
    const resourceOpened = useRef(false);
    const [stepIndex, setStepIndex] = useState(0);
    const [guideNodeId, setGuideNodeId] = useState<string | null>(null);
    const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [setup, setSetup] = useState<SetupInfo>({ reachable: false, phase: "idle", available: 0, total: 0 });
    const guideWasOpen = useRef(false);

    useEffect(() => {
        if (!open) return;
        initialImageIds.current = new Set(nodes.filter((node) => node.type === CanvasNodeType.Image).map((node) => node.id));
        setStepIndex(0);
        setGuideNodeId(null);
        setRect(null);
        promptSeeded.current = false;
        resourceOpened.current = false;
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const load = async () => {
            try {
                const response = await fetch(`${gatewayRoot}/api/system/stats`);
                const data = await response.json();
                if (cancelled) return;
                setSetup({
                    reachable: Boolean(data?.comfy?.reachable),
                    phase: String(data?.setup?.phase || "idle"),
                    available: Number(data?.setup?.counts?.available || 0),
                    total: Number(data?.setup?.counts?.total || 0),
                });
            } catch {
                if (!cancelled) setSetup({ reachable: false, phase: "idle", available: 0, total: 0 });
            }
        };
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState !== "hidden") void load();
        }, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [open]);

    useEffect(() => {
        if (!open || guideNodeId) return;
        const candidate = [...nodes].reverse().find((node) => node.type === CanvasNodeType.Image && !initialImageIds.current.has(node.id));
        if (candidate) setGuideNodeId(candidate.id);
    }, [nodes, open, guideNodeId]);

    const guideNode = nodes.find((node) => node.id === guideNodeId) || null;
    const modelValue = String(guideNode?.metadata?.model || imageModel || "").trim();
    const resultReady = Boolean(guideNode?.metadata?.content) || Boolean(guideNode?.metadata?.images?.some((image) => Boolean(image.content)));
    const generationError = guideNode?.metadata?.status === "error" ? String(guideNode.metadata.errorDetails || "").trim() : "";
    const running = Boolean(guideNodeId && hasActiveGeneration(guideNodeId));

    const steps = useMemo(
        () => [
            { id: "welcome", title: t("onboarding.welcomeTitle"), body: t("onboarding.welcomeBody"), target: () => document.querySelector<HTMLElement>('[data-onboarding="guide-button"]'), interactive: false },
            {
                id: "connect",
                title: t("onboarding.connectTitle"),
                body: setup.reachable && setup.phase === "ready" ? t("onboarding.connectReady", { available: setup.available, total: setup.total }) : t("onboarding.connectNotReady"),
                target: () => document.querySelector<HTMLElement>('[data-onboarding="settings-button"]'),
                interactive: true,
            },
            {
                id: "resources",
                title: t("onboarding.resourcesTitle"),
                body: t("onboarding.resourcesBody"),
                target: () => document.querySelector<HTMLElement>('[data-onboarding="resource-install"]'),
                interactive: true,
            },
            {
                id: "resource-problem",
                title: t("onboarding.resourceProblemTitle"),
                body: t("onboarding.resourceProblemBody"),
                target: () => document.querySelector<HTMLElement>('[data-onboarding="resource-problem"]'),
                interactive: true,
            },
            { id: "create", title: t("onboarding.createTitle"), body: guideNodeId ? t("onboarding.createDone") : t("onboarding.createBody"), target: () => document.querySelector<HTMLElement>('[data-onboarding="tool-image"]'), interactive: true },
            { id: "model", title: t("onboarding.modelTitle"), body: modelValue ? t("onboarding.modelBody", { model: modelValue }) : t("onboarding.modelMissing"), target: () => panelFor(guideNodeId)?.querySelector<HTMLElement>('[data-onboarding="image-model-picker"]') || null, interactive: true },
            { id: "prompt", title: t("onboarding.promptTitle"), body: t("onboarding.promptBody"), target: () => panelFor(guideNodeId)?.querySelector<HTMLElement>('[data-onboarding="prompt-input"]') || null, interactive: true },
            {
                id: "generate",
                title: t("onboarding.generateTitle"),
                body: resultReady ? t("onboarding.generateDone") : running ? t("onboarding.generating") : generationError ? `${t("onboarding.generateFailed")}\n${generationError.slice(0, 220)}` : t("onboarding.generateBody"),
                target: () => panelFor(guideNodeId)?.querySelector<HTMLElement>('[data-onboarding="generate-button"]') || null,
                interactive: true,
            },
            { id: "done", title: t("onboarding.doneTitle"), body: t("onboarding.doneBody"), target: () => (guideNodeId ? document.querySelector<HTMLElement>(`[data-node-id="${guideNodeId}"]`) : null), interactive: false },
        ],
        [generationError, guideNodeId, modelValue, resultReady, running, setup, t],
    );
    const current = steps[Math.min(stepIndex, steps.length - 1)];

    useEffect(() => {
        if (!open) return;
        if (current.id !== "resources" || resourceOpened.current) return;
        resourceOpened.current = true;
        openConfigDialog(false, "resources");
    }, [current.id, open, openConfigDialog]);

    useEffect(() => {
        if (!open) return;
        const target = current.target();
        const update = () => {
            const nextTarget = current.target();
            if (!nextTarget) {
                setRect(null);
                return;
            }
            const box = nextTarget.getBoundingClientRect();
            if (!box.width && !box.height) {
                setRect(null);
                return;
            }
            setRect({ x: box.left, y: box.top, width: box.width, height: box.height });
        };
        target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        update();
        const timer = window.setInterval(update, 180);
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [current, open]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                finish("skipped");
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, current.id]);

    useEffect(() => {
        if (open) {
            guideWasOpen.current = true;
            return;
        }
        if (!guideWasOpen.current) return;
        guideWasOpen.current = false;
        setConfigDialogOpen(false);
    }, [open, setConfigDialogOpen]);

    useEffect(() => {
        if (!open || current.id !== "prompt" || !guideNodeId) return;
        if (promptSeeded.current) return;
        const timer = window.setTimeout(() => {
            if (fillPrompt()) promptSeeded.current = true;
        }, 260);
        return () => window.clearTimeout(timer);
    }, [current.id, guideNodeId, open]);

    useEffect(() => {
        if (!open) return;
        if (current.id === "create" && guideNodeId) {
            const timer = window.setTimeout(() => setStepIndex((index) => Math.min(index + 1, steps.length - 1)), 550);
            return () => window.clearTimeout(timer);
        }
        if (current.id === "generate" && resultReady) {
            const timer = window.setTimeout(() => setStepIndex((index) => Math.min(index + 1, steps.length - 1)), 700);
            return () => window.clearTimeout(timer);
        }
        return undefined;
    }, [current.id, guideNodeId, open, resultReady, steps.length]);

    useEffect(() => {
        if (!open || current.interactive) return;
        tooltipRef.current?.focus({ preventScroll: true });
    }, [current.id, current.interactive, open]);

    useEffect(() => {
        if (!open) return;
        const close = () => {
            setConfigDialogOpen(false);
            onClose();
        };
        window.addEventListener("canvas-onboarding-close", close);
        return () => window.removeEventListener("canvas-onboarding-close", close);
    }, [onClose, open, setConfigDialogOpen]);

    const finish = (status: "completed" | "skipped") => {
        setConfigDialogOpen(false);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, at: Date.now() }));
        } catch {
            /* localStorage unavailable */
        }
        onClose();
    };

    const next = () => {
        if (current.id === "resource-problem") setConfigDialogOpen(false);
        if (stepIndex >= steps.length - 1) {
            finish("completed");
            return;
        }
        setStepIndex((index) => Math.min(index + 1, steps.length - 1));
    };

    const back = () => {
        if (current.id === "resources") setConfigDialogOpen(false);
        setStepIndex((index) => Math.max(0, index - 1));
    };
    const primaryDisabled = (current.id === "model" && !modelValue) || (current.id === "generate" && !resultReady);
    const primaryLabel =
        current.id === "welcome"
            ? t("onboarding.start")
            : current.id === "create" && !guideNodeId
              ? t("onboarding.createAction")
              : current.id === "done"
                ? t("onboarding.finish")
                : current.id === "generate" && resultReady
                  ? t("onboarding.next")
                  : t("onboarding.next");

    if (!open) return null;

    const hole = rect ? { x: Math.max(8, rect.x - 6), y: Math.max(8, rect.y - 6), width: rect.width + 12, height: rect.height + 12 } : null;
    const width = 348;
    const maxHeight = Math.min(360, window.innerHeight - 32);
    const below = hole ? hole.y + hole.height + 12 : 0;
    const above = hole ? hole.y - maxHeight - 12 : 0;
    const top = hole ? (below + maxHeight <= window.innerHeight ? below : Math.max(16, above)) : Math.max(16, (window.innerHeight - maxHeight) / 2);
    const left = hole ? Math.min(Math.max(16, hole.x + hole.width / 2 - width / 2), window.innerWidth - width - 16) : (window.innerWidth - width) / 2;
    const overlayZ = current.id === "resources" || current.id === "resource-problem" ? 1100 : 900;
    const blockerStyle = { position: "fixed" as const, zIndex: overlayZ, background: "transparent", pointerEvents: "auto" as const };

    return createPortal(
        <div className="pointer-events-none fixed inset-0" style={{ zIndex: overlayZ }}>
            <svg className="pointer-events-none fixed inset-0 h-full w-full" style={{ zIndex: overlayZ }}>
                <defs>
                    <mask id={maskId}>
                        <rect width="100%" height="100%" fill="white" />
                        {hole ? <rect x={hole.x} y={hole.y} width={hole.width} height={hole.height} rx="14" fill="black" /> : null}
                    </mask>
                </defs>
                <rect width="100%" height="100%" fill="rgba(10,10,10,.58)" mask={`url(#${maskId})`} />
            </svg>
            {current.interactive && hole ? (
                <>
                    <div style={{ ...blockerStyle, left: 0, top: 0, right: 0, height: hole.y }} />
                    <div style={{ ...blockerStyle, left: 0, top: hole.y, width: hole.x, height: hole.height }} />
                    <div style={{ ...blockerStyle, left: hole.x + hole.width, top: hole.y, right: 0, height: hole.height }} />
                    <div style={{ ...blockerStyle, left: 0, top: hole.y + hole.height, right: 0, bottom: 0 }} />
                    <div className="pointer-events-none fixed rounded-2xl border-2" style={{ zIndex: overlayZ + 1, left: hole.x, top: hole.y, width: hole.width, height: hole.height, borderColor: "#2f80ff", boxShadow: "0 0 0 4px rgba(47,128,255,.18), 0 0 28px rgba(47,128,255,.35)" }} />
                </>
            ) : (
                <div className="pointer-events-auto fixed inset-0" style={{ zIndex: overlayZ, background: "transparent" }} />
            )}
            {!current.interactive && hole ? <div className="pointer-events-none fixed rounded-2xl border-2" style={{ zIndex: overlayZ + 1, left: hole.x, top: hole.y, width: hole.width, height: hole.height, borderColor: "#2f80ff", boxShadow: "0 0 0 4px rgba(47,128,255,.18)" }} /> : null}
            <div
                ref={tooltipRef}
                tabIndex={-1}
                className="pointer-events-auto fixed flex max-h-[70vh] flex-col overflow-y-auto rounded-2xl border p-4 shadow-2xl outline-none"
                style={{ zIndex: overlayZ + 2, left, top, width, maxHeight, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full" style={{ background: "rgba(47,128,255,.14)", color: "#2f80ff" }}>
                            <Compass className="size-4" />
                        </span>
                        <span className="text-sm font-semibold leading-5">{current.title}</span>
                    </div>
                    <button type="button" className="grid size-6 shrink-0 place-items-center rounded-md opacity-55 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={() => finish("skipped")} aria-label={t("onboarding.skip")}>
                        <X className="size-4" />
                    </button>
                </div>
                <p className="mt-3 whitespace-pre-line text-xs leading-5" style={{ color: theme.node.muted }}>
                    {current.body}
                </p>
                {current.id === "model" && !modelValue ? (
                    <div className="mt-3">
                        <Button size="small" onClick={() => openConfigDialog(false, "resources")}>
                            {t("onboarding.openResources")}
                        </Button>
                    </div>
                ) : null}
                {current.id === "prompt" ? (
                    <div className="mt-3">
                        <Button
                            size="small"
                            onClick={() => {
                                if (fillPrompt()) promptSeeded.current = true;
                            }}
                        >
                            {t("onboarding.promptAction")}
                        </Button>
                    </div>
                ) : null}
                <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                        {steps.map((step, index) => (
                            <span key={step.id} className="size-1.5 rounded-full transition-colors" style={{ background: index === stepIndex ? "#2f80ff" : theme.node.stroke }} />
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        {stepIndex > 0 ? (
                            <Button size="small" type="text" icon={<ArrowLeft className="size-3.5" />} onClick={back}>
                                {t("onboarding.back")}
                            </Button>
                        ) : null}
                        <Button
                            size="small"
                            type="primary"
                            disabled={primaryDisabled}
                            icon={current.id === "done" ? undefined : <ArrowRight className="size-3.5" />}
                            onClick={() => {
                                if (current.id === "create" && !guideNodeId) {
                                    onCreateImageNode();
                                    return;
                                }
                                next();
                            }}
                        >
                            {primaryLabel}
                        </Button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
