import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { getNodeSpec } from "@/constant/canvas";
import { DSH_EMBEDDED } from "@/constant/runtime-config";
import { useAgentStore } from "@/stores/use-agent-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, Position, ViewportTransform } from "@/types/canvas";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

type AgentBridgeParams = {
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    getCanvasCenter: () => Position;
    canvasToScreen: (x: number, y: number) => Position;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    focusNodeRef: MutableRefObject<((nodeId: string) => void) | null>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, title, nodes, connections, selectedNodeIds, viewport, getCanvasCenter, canvasToScreen, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu, focusNodeRef } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const center = getCanvasCenter();
            const gap = 40;
            const occupancy = nodesRef.current.map((node) => ({ x: node.position.x, y: node.position.y, w: node.width, h: node.height }));
            const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
                a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
            const findFreePosition = (width: number, height: number) => {
                const stepX = width + gap;
                const stepY = height + gap;
                for (let ring = 0; ring <= 12; ring += 1) {
                    for (let gx = -ring; gx <= ring; gx += 1) {
                        for (let gy = -ring; gy <= ring; gy += 1) {
                            if (Math.max(Math.abs(gx), Math.abs(gy)) !== ring) continue;
                            const x = center.x - width / 2 + gx * stepX;
                            const y = center.y - height / 2 + gy * stepY;
                            if (!occupancy.some((item) => intersects({ x, y, w: width, h: height }, item))) return { x, y };
                        }
                    }
                }
                const maxX = Math.max(center.x, ...occupancy.map((item) => item.x + item.w + gap));
                return { x: maxX, y: center.y - height / 2 };
            };
            const placedOps = safeOps.map((op) => {
                if (op.type !== "add_node") return op;
                const spec = getNodeSpec(op.nodeType || "text");
                const width = op.width || spec.width;
                const height = op.height || spec.height;
                const explicit = op.position || (op.x != null || op.y != null ? { x: op.x ?? 0, y: op.y ?? 0 } : null);
                const position = explicit || findFreePosition(width, height);
                occupancy.push({ x: position.x, y: position.y, w: width, h: height });
                return { ...op, position, width, height };
            });
            const generationOps = placedOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasAgentOps(
                before,
                placedOps.filter((op) => op.type !== "run_generation"),
            );
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            const beforeIds = new Set(before.nodes.map((node) => node.id));
            const addedNodes = next.nodes.filter((node) => !beforeIds.has(node.id));
            const targetIds = [...new Set([...addedNodes.map((node) => node.id), ...generationOps.map((op) => op.nodeId)])];
            const targetNode = addedNodes.at(-1) || next.nodes.find((node) => targetIds.includes(node.id));
            if (targetNode && targetIds.length) {
                const screen = canvasToScreen(targetNode.position.x, targetNode.position.y);
                const scale = viewportRef.current.k;
                const previousFocus = useAgentStore.getState().agentFocus;
                const mergedNodeIds = [...new Set([...(previousFocus?.nodeIds || []), ...targetIds])];
                useAgentStore.getState().setAgentFocus({
                    x: screen.x,
                    y: screen.y,
                    width: targetNode.width * scale,
                    height: targetNode.height * scale,
                    nodeIds: mergedNodeIds,
                    label: generationOps.length ? "正在生成…" : "已添加卡片",
                    generation: Boolean(previousFocus?.generation || generationOps.length),
                });
                focusNodeRef.current?.(targetNode.id);
            }
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [getCanvasCenter, canvasToScreen, projectTitle, projectId],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        useAgentStore.getState().clearAgentFocus();
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, projectTitle, projectId]);

    useEffect(() => {
        if (DSH_EMBEDDED) return;
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, setAgentCanvasContext, undoAgentOps]);
    useEffect(() => {
        if (DSH_EMBEDDED) return;
        return () => useAgentStore.getState().clearAgentFocus();
    }, []);

    useEffect(() => {
        if (!DSH_EMBEDDED) return;
        const bridge = {
            getState: () => ({
                projectId: agentSnapshot.projectId,
                title: agentSnapshot.title,
                selectedNodeIds: agentSnapshot.selectedNodeIds,
                viewport: agentSnapshot.viewport,
                nodes: agentSnapshot.nodes.map((node) => ({
                    id: node.id,
                    type: node.type,
                    title: node.title,
                    position: node.position,
                    width: node.width,
                    height: node.height,
                    status: node.metadata?.status ?? "",
                    prompt: node.metadata?.prompt ?? "",
                    generationMode: node.metadata?.generationMode ?? "",
                    model: node.metadata?.model ?? "",
                })),
                connections: agentSnapshot.connections.map((connection) => ({
                    id: connection.id,
                    fromNodeId: connection.fromNodeId,
                    toNodeId: connection.toNodeId,
                })),
            }),
            applyOps: (ops: CanvasAgentOp[]) => {
                const result = applyAgentOps(ops);
                return {
                    projectId: result?.projectId ?? projectId,
                    nodeCount: result?.nodes?.length ?? 0,
                    connectionCount: result?.connections?.length ?? 0,
                    selectedNodeIds: result?.selectedNodeIds ?? [],
                };
            },
        };
        (window as unknown as { __WUJIE_DSH_BRIDGE__?: typeof bridge }).__WUJIE_DSH_BRIDGE__ = bridge;
        return () => {
            const host = window as unknown as { __WUJIE_DSH_BRIDGE__?: typeof bridge };
            if (host.__WUJIE_DSH_BRIDGE__ === bridge) delete host.__WUJIE_DSH_BRIDGE__;
        };
    }, [agentSnapshot, applyAgentOps, projectId]);

    return { applyAgentOps };
}
