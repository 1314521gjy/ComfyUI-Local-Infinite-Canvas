import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { Bot, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentCloudChat } from "./agent-cloud-chat";
import { canvasThemes } from "@/lib/canvas-theme";
import { useEffectiveCardSkin } from "@/lib/canvas/use-canvas-theme";
import { activePromptCloudApi, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PET_ART: Record<string, { idle: string; busy: string; label: string }> = {
    angel: { idle: "/skins/angel-girl-idle.webp", busy: "/skins/angel-girl-write.webp", label: "config.preferences.cardSkins.angel.label" },
    fish: { idle: "/skins/lantern-guard-idle.png", busy: "/skins/lantern-guard-raise.png", label: "config.preferences.cardSkins.fish.label" },
};
const PET_SIZE = 112;
const PET_MARGIN = 8;
const PANEL_GAP = 12;
const POSITION_KEY = "canvas-agent-pet-position";

type PetPosition = { x: number; y: number };

function viewportSize() {
    const width = typeof window === "undefined" ? 1280 : window.innerWidth || 1280;
    const height = typeof window === "undefined" ? 720 : window.innerHeight || 720;
    return { width, height };
}

function clampPosition(position: PetPosition, viewport = viewportSize()): PetPosition {
    return {
        x: Math.min(Math.max(PET_MARGIN, position.x), Math.max(PET_MARGIN, viewport.width - PET_SIZE - PET_MARGIN)),
        y: Math.min(Math.max(PET_MARGIN, position.y), Math.max(PET_MARGIN, viewport.height - PET_SIZE - PET_MARGIN)),
    };
}

function initialPosition(): PetPosition {
    if (typeof window === "undefined") return { x: PET_MARGIN, y: PET_MARGIN };
    try {
        const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || "");
        if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return clampPosition({ x: stored.x, y: stored.y });
    } catch {}
    const viewport = viewportSize();
    return { x: viewport.width - PET_SIZE - 16, y: viewport.height - PET_SIZE - 16 };
}

export function AgentPet() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const skin = useEffectiveCardSkin() as string;
    const agentAvatarEnabled = useThemeStore((state) => state.agentAvatarEnabled);
    const pet = agentAvatarEnabled ? PET_ART[skin] : undefined;
    const [broken, setBroken] = useState(false);
    const [position, setPositionState] = useState<PetPosition>(initialPosition);
    const [viewport, setViewport] = useState(viewportSize);
    const positionRef = useRef(position);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const movedRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const agentFocus = useAgentStore((state) => state.agentFocus);
    const cloudApi = activePromptCloudApi(useConfigStore((state) => state.config));
    const connected = Boolean(cloudApi?.baseUrl && cloudApi?.apiKey && cloudApi?.model);
    const busy = useAgentStore((state) => state.sending || state.waiting);
    useEffect(() => setBroken(false), [skin]);
    useEffect(() => {
        if (!agentFocus) return;
        let sawActive = false;
        let idleSince = 0;
        const started = Date.now();
        const timer = window.setInterval(() => {
            const nodes = useAgentStore.getState().canvasContext?.snapshot.nodes || [];
            const targets = agentFocus.nodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node) => Boolean(node));
            const active = targets.some((node) => node && ["loading", "queued", "running"].includes(String(node.metadata?.status || "")));
            if (active) {
                sawActive = true;
                idleSince = 0;
                return;
            }
            if (agentFocus.generation && !sawActive && Date.now() - started < 3000) return;
            if (!idleSince) idleSince = Date.now();
            if (Date.now() - idleSince >= 1400) useAgentStore.getState().clearAgentFocus();
        }, 400);
        return () => window.clearInterval(timer);
    }, [agentFocus]);
    useEffect(() => {
        if (!panelOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (wrapRef.current?.contains(target)) return;
            if (target.closest(".ant-modal-root, .ant-popover, .ant-select-dropdown, .ant-dropdown, [role='dialog'], [data-canvas-agent-keep-open]")) return;
            useAgentStore.getState().closePanel();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [panelOpen]);
    useEffect(() => {
        const onResize = () => {
            const nextViewport = viewportSize();
            setViewport(nextViewport);
            const next = clampPosition(positionRef.current, nextViewport);
            positionRef.current = next;
            setPositionState(next);
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const setPosition = (next: PetPosition) => {
        positionRef.current = next;
        setPositionState(next);
    };
    const persistPosition = () => {
        localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current));
    };

    const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (event.detail > 0 && movedRef.current) return;
        const state = useAgentStore.getState();
        if (state.panelOpen) {
            state.closePanel();
            return;
        }
        state.openPanel();
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: positionRef.current.x, originY: positionRef.current.y, moved: false };
        movedRef.current = false;
        setDragging(false);
    };
    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            movedRef.current = true;
            setDragging(true);
        }
        event.preventDefault();
        event.stopPropagation();
        setPosition(clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, viewport));
    };
    const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (drag.moved) {
            event.stopPropagation();
            setPosition(clampPosition(positionRef.current, viewport));
            persistPosition();
            setDragging(false);
        }
    };
    const handlePointerCancel = () => {
        dragRef.current = null;
        setDragging(false);
    };

    const panelWidth = Math.min(460, Math.max(240, viewport.width - 32));
    const spaceAbove = position.y - PANEL_GAP - PET_MARGIN;
    const spaceBelow = viewport.height - position.y - PET_SIZE - PANEL_GAP - PET_MARGIN;
    const placeAbove = spaceAbove >= spaceBelow;
    const panelHeight = Math.min(680, Math.max(240, Math.max(spaceAbove, spaceBelow)));
    const panelLeft = Math.min(Math.max(PET_MARGIN, position.x + PET_SIZE - panelWidth), Math.max(PET_MARGIN, viewport.width - panelWidth - PET_MARGIN));
    const panelTop = placeAbove ? Math.max(PET_MARGIN, position.y - PANEL_GAP - panelHeight) : Math.min(position.y + PET_SIZE + PANEL_GAP, Math.max(PET_MARGIN, viewport.height - panelHeight - PET_MARGIN));
    const bubbleAbove = position.y > 84;
    const art = pet && !broken ? (busy ? pet.busy : pet.idle) : "";
    const statusColor = connected ? "#16a34a" : busy ? "#d97706" : theme.node.muted;

    return (
        <div
            ref={wrapRef}
            className="fixed z-[90]"
            style={{ left: position.x, top: position.y }}
            data-canvas-shortcuts-ignore
        >
            {agentFocus ? (
                <div
                    className="pointer-events-none absolute left-1/2 z-20 w-max max-w-[260px] rounded-2xl border px-3 py-1.5 text-xs font-medium shadow-xl backdrop-blur"
                    style={{ top: bubbleAbove ? -8 : PET_SIZE + 8, transform: `translate(-50%, ${bubbleAbove ? "-100%" : "0"})`, background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                >
                    <span className="inline-flex items-center gap-1.5">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        {agentFocus.label}
                    </span>
                </div>
            ) : null}
            <div
                className="fixed flex flex-col overflow-hidden rounded-[26px] border shadow-2xl backdrop-blur"
                style={{ display: panelOpen ? "flex" : "none", left: panelLeft, top: panelTop, width: panelWidth, height: panelHeight, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                data-canvas-shortcuts-ignore
            >
                <AgentCloudChat />
            </div>
            <motion.button
                type="button"
                className="group relative flex size-28 items-end justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-black/15 dark:focus-visible:ring-white/20"
                style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                aria-label={t(panelOpen ? "agent.pet.close" : "agent.pet.open")}
                title={t(panelOpen ? "agent.pet.close" : "agent.pet.open")}
                animate={dragging ? { y: 0 } : { y: busy ? [0, -2, 0] : [0, -4, 0] }}
                transition={{ duration: busy ? 1.2 : 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
                {art ? (
                    <img
                        src={art}
                        alt={pet ? t(pet.label) : ""}
                        className="max-h-28 w-auto object-contain drop-shadow-[0_12px_26px_rgba(0,0,0,.35)] transition-transform duration-300 group-hover:-translate-y-1 group-hover:scale-[1.03]"
                        draggable={false}
                        onError={() => setBroken(true)}
                    />
                ) : (
                    <span
                        className="grid size-16 place-items-center rounded-full border shadow-xl transition-transform duration-300 group-hover:-translate-y-1"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                    >
                        <Bot className="size-7" />
                    </span>
                )}
                <span className="absolute bottom-2 right-2 grid size-5 place-items-center rounded-full border-2" style={{ background: theme.node.panel, borderColor: theme.node.panel }}>
                    <span className="size-2.5 rounded-full" style={{ background: statusColor }} />
                </span>
                {busy ? (
                    <span className="absolute left-1 top-3 grid size-7 place-items-center rounded-full border shadow-md" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <LoaderCircle className="size-3.5 animate-spin" />
                    </span>
                ) : null}
            </motion.button>
        </div>
    );
}
