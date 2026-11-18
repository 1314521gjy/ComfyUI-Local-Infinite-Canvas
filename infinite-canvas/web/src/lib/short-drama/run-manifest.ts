import type { CanvasDramaStoryboardShot, CanvasNodeData } from "@/types/canvas";

export type DramaRunItem = {
    shotNumber: number;
    shot: CanvasDramaStoryboardShot;
    storyNodeId?: string;
    frameNodeId?: string;
    videoNodeId?: string;
    compiledPrompt?: string;
    lastError?: string;
    done?: boolean;
};

export type DramaRun = {
    episodeId: string;
    storyboardsDone: boolean;
    items: DramaRunItem[];
    updatedAt: string;
};

export type DramaResumeStoryAction = "skip" | "create" | "recreate";

export type DramaResumeFrameAction = { kind: "skip" } | { kind: "generate"; recreate: boolean };

export type DramaResumeVideoAction = { kind: "skip" } | { kind: "resume" } | { kind: "generate"; recreate: boolean };

export type DramaResumeItemPlan = {
    shot: CanvasDramaStoryboardShot;
    storyNodeId?: string;
    frameNodeId?: string;
    videoNodeId?: string;
    compiledPrompt?: string;
    storyAction: DramaResumeStoryAction;
    frameAction: DramaResumeFrameAction;
    videoAction: DramaResumeVideoAction;
};

export type DramaResumePlan = {
    storyboard: "reuse" | "generate";
    items: DramaResumeItemPlan[];
    complete: boolean;
};

export function createDramaRun(episodeId: string, shots: CanvasDramaStoryboardShot[], at = new Date().toISOString()): DramaRun {
    return {
        episodeId,
        storyboardsDone: false,
        items: shots.map((shot) => ({ shotNumber: shot.shotNumber, shot })),
        updatedAt: at,
    };
}

export function markDramaRunStoryboardsDone(run: DramaRun, storyNodeIds: Record<number, string>, at = new Date().toISOString()): DramaRun {
    return {
        ...run,
        storyboardsDone: true,
        updatedAt: at,
        items: run.items.map((item) => ({ ...item, storyNodeId: storyNodeIds[item.shotNumber] || item.storyNodeId })),
    };
}

export function updateDramaRunItem(run: DramaRun, shotNumber: number, patch: Partial<Omit<DramaRunItem, "shotNumber" | "shot">>, at = new Date().toISOString()): DramaRun {
    return {
        ...run,
        updatedAt: at,
        items: run.items.map((item) => (item.shotNumber === shotNumber ? { ...item, ...patch } : item)),
    };
}

export function buildDramaResumePlan(options: {
    run?: DramaRun | null;
    shots: CanvasDramaStoryboardShot[];
    nodes: CanvasNodeData[];
    useReference: boolean;
}): DramaResumePlan {
    const { run, shots, nodes, useReference } = options;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const canReuse = Boolean(run?.storyboardsDone && run.items.length && shots.length);
    const items = shots.map((shot): DramaResumeItemPlan => {
        const item = canReuse ? run?.items.find((candidate) => candidate.shotNumber === shot.shotNumber) : undefined;
        const storyNode = item?.storyNodeId ? nodeById.get(item.storyNodeId) : undefined;
        const storyAction: DramaResumeStoryAction = !canReuse || !item ? "create" : storyNode ? "skip" : "recreate";
        const frameNode = item?.frameNodeId ? nodeById.get(item.frameNodeId) : undefined;
        const videoNode = item?.videoNodeId ? nodeById.get(item.videoNodeId) : undefined;
        let videoAction: DramaResumeVideoAction;
        if (!videoNode) videoAction = { kind: "generate", recreate: true };
        else if (videoNode.metadata?.content) videoAction = { kind: "skip" };
        else if (videoNode.metadata?.videoTaskId) videoAction = { kind: "resume" };
        else videoAction = { kind: "generate", recreate: false };
        let frameAction: DramaResumeFrameAction = { kind: "skip" };
        if (!useReference && videoAction.kind === "generate") {
            if (!frameNode) frameAction = { kind: "generate", recreate: true };
            else if (!frameNode.metadata?.content) frameAction = { kind: "generate", recreate: false };
        }
        return {
            shot,
            storyNodeId: item?.storyNodeId,
            frameNodeId: item?.frameNodeId,
            videoNodeId: item?.videoNodeId,
            compiledPrompt: item?.compiledPrompt,
            storyAction,
            frameAction,
            videoAction,
        };
    });
    const complete = canReuse && items.every((item) => item.storyAction === "skip" && item.frameAction.kind === "skip" && item.videoAction.kind === "skip");
    return { storyboard: canReuse ? "reuse" : "generate", items, complete };
}

export function summarizeDramaRun(run: DramaRun) {
    const total = run.items.length;
    const failed = run.items.filter((item) => Boolean(item.lastError)).length;
    return { total, failed };
}
