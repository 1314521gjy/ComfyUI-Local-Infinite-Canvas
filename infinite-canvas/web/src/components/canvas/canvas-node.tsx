import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Copy, Download, Group, Image as ImageIcon, Music2, Puzzle, RefreshCw, Sparkles, Star, Trash2, Video } from "lucide-react";

import { canvasThemes, getCardBackground } from "@/lib/canvas-theme";
import { useCanvasTheme, useEffectiveCardSkin } from "@/lib/canvas/use-canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { formatBytes } from "@/lib/image-utils";
import { pickImageSource } from "@/lib/image-thumbnail";
import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision } from "@/services/image-storage";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeProgressRing } from "./canvas-node-progress-ring";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage, type CanvasNodeText, type Position } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useTranslation } from "react-i18next";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";

type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    referenceSelectionState?: "target" | "disabled" | "available";
    showPanel: boolean;
    showImageInfo: boolean;
    mentionReferences?: CanvasResourceReference[];
    pluginHost?: CanvasPluginHost;
    registryVersion?: number;
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    isGroupDropTarget?: boolean;
    batchExpanded?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onVideoDimensions?: (nodeId: string, width: number, height: number) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (nodeId: string, itemId: string) => void;
    onDuplicateBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDownloadBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage?: (nodeId: string, imageId: string) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData, imageId?: string) => void;
    onSelectReference?: (nodeId: string) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    scale: number;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    pluginContext?: CanvasNodeContext | null;
    onContentChange: (nodeId: string, content: string) => void;
    onVideoDimensions?: (nodeId: string, width: number, height: number) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (itemId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
    groupChildCount: number;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    referenceSelectionState,
    showPanel,
    showImageInfo,
    mentionReferences = [],
    pluginHost,
    renderPanel,
    renderNodeContent,
    groupChildCount = 0,
    isGroupDropTarget = false,
    batchExpanded = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onVideoDimensions,
    onTitleChange,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onRetry,
    onViewImage,
    onSelectReference,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = useCanvasTheme();
    const colorTheme = useThemeStore((state) => state.theme);
    const fishWhipEnabled = useThemeStore((state) => state.fishWhipEnabled);
    const fishWhipSide = useThemeStore((state) => state.fishWhipSide);
    const cardSkin = useEffectiveCardSkin();
    const fishSkin = cardSkin === "fish";
    const fishArtSize = Math.round(Math.max(15, Math.min(58, Math.min(data.height * 0.24, data.width * 0.15))));
    const fishArtStroke = Math.max(1, Math.round(fishArtSize * 0.045));
    const cardBackground = getCardBackground(colorTheme, cardSkin);
    const titleTheme = canvasThemes[colorTheme].node;
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const pluginContext = useMemo<CanvasNodeContext | null>(() => (pluginHost ? buildNodeContext(pluginHost, data, theme, scale, isSelected) : null), [pluginHost, data, theme, scale, isSelected]);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title || "");
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isGroup = data.type === CanvasNodeType.Group;
    const isGenerating = !isGroup && !referenceSelectionState && (data.metadata?.status === "loading" || Boolean(data.metadata?.stepProgress && data.metadata.stepProgress.total > 0 && !data.metadata.stepProgress.complete));
    const batchCount = data.type === CanvasNodeType.Image ? data.metadata?.images?.length || 0 : data.type === CanvasNodeType.Text ? data.metadata?.texts?.length || 0 : 0;
    const isBatchRoot = batchCount > 1;
    // Nodes with the interaction/move toggle ignore content pointer events in move mode and allow interaction in interactive mode.
    // forceInteractive states such as editing stay interactive, as do empty nodes so their upload and generation actions remain usable.
    const supportsInteractionToggle = Boolean(definition?.interactionToggle);
    const forceInteractive = supportsInteractionToggle ? Boolean(definition?.forceInteractive?.(data)) : false;
    const contentInteractive = !supportsInteractionToggle || forceInteractive || !data.metadata?.content ? true : Boolean(data.metadata?.interactive);
    // Transparent nodes such as SVGs blend into the canvas while retaining outlines for selected or related states.
    const transparentBg = Boolean(definition?.transparentBackground);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        setTitleDraft(data.title || "");
    }, [data.title]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    const finishTitleEditing = useCallback(() => {
        const title = titleDraft.trim() || data.title || t("canvas.node.untitled");
        setTitleDraft(title);
        setIsEditingTitle(false);
        if (title !== data.title) onTitleChange(data.id, title);
    }, [data.id, data.title, onTitleChange, t, titleDraft]);

    useEffect(() => {
        if (!isEditingTitle) return;
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && titleInputRef.current?.contains(target)) return;
            finishTitleEditing();
        };
        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTitleEditing, isEditingTitle]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video || Boolean(definition?.keepAspectRatio?.(data)),
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            data-card-skin={cardSkin}
            className={`node-element group/node absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"} ${referenceSelectionState === "available" ? "cursor-pointer" : referenceSelectionState ? "cursor-not-allowed" : ""}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => {
                if (!referenceSelectionState) onSelectCapture?.(event, data.id);
            }}
            onContextMenu={(event) => {
                if (referenceSelectionState) event.preventDefault();
                else onContextMenu(event, data.id);
            }}
        >
            {!referenceSelectionState && (isSelected || hovered || isEditingTitle) && (
                <div className="absolute left-3 top-[-28px] z-[65] max-w-[calc(100%-24px)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {isEditingTitle ? (
                        <input
                            ref={titleInputRef}
                            value={titleDraft}
                            maxLength={64}
                            className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
                            style={{ borderColor: titleTheme.muted, color: titleTheme.text }}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={finishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") finishTitleEditing();
                                if (event.key === "Escape") {
                                    setTitleDraft(data.title || "");
                                    setIsEditingTitle(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="block max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
                            style={{ color: titleTheme.text }}
                            title={t("canvas.node.renameHint")}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                setIsEditingTitle(true);
                            }}
                        >
                            {data.title || t("canvas.node.untitled")}
                        </button>
                    )}
                </div>
            )}

            <div
                className="relative h-full w-full overflow-visible rounded-3xl border-2"
                style={{
                    background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : fishSkin ? cardBackground : theme.node.fill,
                    borderColor: isGroup ? (isGroupDropTarget || isActive ? selectionBlue : theme.node.stroke) : hasImageContent ? imageBorderColor : isActive ? selectionBlue : isRelated ? theme.node.muted : transparentBg ? "transparent" : theme.node.stroke,
                    borderStyle: isGroup ? "dashed" : "solid",
                    boxShadow: isGroupDropTarget ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10` : isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => {
                    if (!referenceSelectionState) onMouseDown(event, data.id);
                    else if (event.button === 0 && referenceSelectionState === "available") {
                        event.stopPropagation();
                        onSelectReference?.(data.id);
                    }
                }}
                onDoubleClick={(event) => {
                    if (referenceSelectionState) {
                        event.stopPropagation();
                        return;
                    }
                    if (definition?.onDoubleClick && pluginContext) {
                        if (definition.onDoubleClick(pluginContext)) event.stopPropagation();
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
            >
                {fishSkin && !isGroup && !hasImageContent && !hasVideoContent && !transparentBg ? (
                    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
                        <div className="absolute left-0 top-0 h-[62%] w-[58%]" style={{ background: "radial-gradient(circle at 0% 0%, rgba(3,15,26,.62), transparent 72%)" }} />
                        <div className="absolute bottom-[-24%] right-[-14%] h-[86%] w-[58%] rounded-full" style={{ background: "radial-gradient(circle, rgba(74,186,255,.30), transparent 66%)" }} />
                        <img
                            src="/skins/blue-whale-girl.png"
                            alt=""
                            draggable={false}
                            className="absolute select-none opacity-95 drop-shadow-[0_10px_22px_rgba(0,8,20,.55)]"
                            style={{ height: "78%", width: "auto", maxWidth: "58%", right: "-2%", bottom: "-5%", objectFit: "contain", objectPosition: "bottom right" }}
                        />
                        <div className="absolute flex items-baseline whitespace-nowrap" style={{ left: "6%", top: "50%", transform: "translateY(-50%) rotate(-9deg)", fontSize: fishArtSize }}>
                            <span
                                style={{
                                    fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
                                    fontWeight: 900,
                                    fontStyle: "italic",
                                    lineHeight: 0.9,
                                    letterSpacing: "0.02em",
                                    color: "#eafaff",
                                    WebkitTextStroke: `${fishArtStroke}px #08263d`,
                                    textShadow: "0 0 18px rgba(90,200,255,.75), 0 4px 0 rgba(5,20,34,.4)",
                                }}
                            >
                                牛<span style={{ color: "#9be9ff" }}>啤</span>
                            </span>
                            <span
                                style={{
                                    marginLeft: "0.08em",
                                    fontSize: "0.66em",
                                    fontWeight: 900,
                                    fontStyle: "italic",
                                    color: "#8fe4ff",
                                    textShadow: "0 0 12px rgba(110,215,255,.85), 0 2px 0 rgba(5,20,34,.45)",
                                    transform: "translateY(-0.12em)",
                                }}
                            >
                                ！！
                            </span>
                        </div>
                        <span className="absolute right-[42%] top-[24%] size-1.5 rounded-full bg-cyan-100/25" />
                        <span className="absolute right-[35%] top-[38%] size-1 rounded-full bg-cyan-100/20" />
                        <span className="absolute right-[47%] top-[12%] size-1 rounded-full bg-cyan-100/15" />
                    </div>
                ) : null}
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : fishSkin ? "transparent" : theme.node.fill,
                            pointerEvents: contentInteractive ? undefined : "none",
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        scale={scale}
                        renderNodeContent={renderNodeContent}
                        pluginContext={pluginContext}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onVideoDimensions={onVideoDimensions}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={(itemId) => onSetBatchPrimary?.(data.id, itemId)}
                        onDuplicateBatchImage={(imageId) => onDuplicateBatchImage?.(data, imageId)}
                        onDownloadBatchImage={(imageId) => onDownloadBatchImage?.(data, imageId)}
                        onRetryBatchImage={(imageId) => onRetryBatchImage?.(data, imageId)}
                        onDeleteBatchImage={(imageId) => onDeleteBatchImage?.(data.id, imageId)}
                        onViewBatchImage={(imageId) => onViewImage?.(data, imageId)}
                        groupChildCount={groupChildCount}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {!isGroup && !hasImageContent && !hasVideoContent && !hasAudioContent ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                {referenceSelectionState && (referenceSelectionState !== "available" || hovered) ? (
                    <div className="pointer-events-none absolute inset-0 z-[60] grid place-items-center rounded-[inherit]" style={{ background: `color-mix(in srgb, ${theme.canvas.background} ${referenceSelectionState === "target" ? 78 : referenceSelectionState === "disabled" ? 60 : 34}%, transparent)`, boxShadow: referenceSelectionState === "available" ? `inset 0 0 0 2px ${selectionBlue}` : undefined }}>
                        {referenceSelectionState !== "disabled" ? <span className="rounded-lg px-3 py-2 text-sm font-medium shadow-sm" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{t(referenceSelectionState === "target" ? "canvas.references.selecting" : "canvas.references.choose")}</span> : null}
                    </div>
                ) : null}

                {!isGroup && !referenceSelectionState && data.metadata?.stepProgress && data.metadata.stepProgress.total > 0 ? (
                    <CanvasNodeProgressRing width={data.width} height={data.height} step={data.metadata.stepProgress.step} total={data.metadata.stepProgress.total} complete={data.metadata.stepProgress.complete} />
                ) : null}

                {!referenceSelectionState ? <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} /> : null}
            </div>

            {fishSkin && isGenerating && fishWhipEnabled ? (
                <div
                    className="pointer-events-none absolute z-[66] select-none"
                    style={fishWhipSide === "left" ? { left: -120, bottom: 0, width: 140, height: 210 } : { right: -120, bottom: 0, width: 140, height: 210 }}
                    aria-hidden="true"
                    data-fish-whip
                >
                    <div
                        className={`whale-whip-bubble absolute bottom-[200px] ${fishWhipSide === "left" ? "left-0" : "right-0"} w-max max-w-[190px] rounded-2xl border px-2.5 py-1.5 text-[12px] font-semibold leading-none shadow-lg`}
                        style={{ background: "rgba(7,21,33,.94)", borderColor: "rgba(120,210,255,.35)", color: "#eaf7ff" }}
                    >
                        {t("canvas.fishWhip.bubble")}
                        <span className="absolute -bottom-1 right-4 size-2 rotate-45 border-b border-r" style={{ background: "rgba(7,21,33,.94)", borderColor: "rgba(120,210,255,.35)" }} />
                    </div>
                    <img
                        src="/skins/whale-whip.webp"
                        alt=""
                        draggable={false}
                        data-side={fishWhipSide}
                        className={`whale-whip-mascot absolute bottom-0 ${fishWhipSide === "left" ? "left-0" : "right-0"} h-[200px] w-auto select-none drop-shadow-[0_8px_16px_rgba(0,8,20,.55)]`}
                    />
                </div>
            ) : null}

            {!referenceSelectionState && !isGroup ? <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} /> : null}
            {!referenceSelectionState && (definition?.hasSourceHandle ?? true) && data.type !== CanvasNodeType.Config ? <ConnectionHandleDot side="right" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "source")} /> : null}

            {/* Counter-scale the panel so its on-screen size stays constant while the canvas zooms. */}
            {showPanel && !isGroup && renderPanel ? (
                <div className="absolute left-1/2 top-full z-[70] w-[600px] pt-4" style={{ transform: `translateX(-50%) scale(${1 / scale})`, transformOrigin: "top center" }} data-node-panel={data.id}>
                    {renderPanel(data)}
                </div>
            ) : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.type === CanvasNodeType.Config && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot && props.node.type === CanvasNodeType.Image) return <ImageNodeContent {...props} />;
    if (props.node.type === CanvasNodeType.Text && props.node.metadata?.texts?.length && (props.node.metadata.status !== "error" || props.node.metadata.texts.some((text) => text.content))) return <TextContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} node={props.node} />;

    const Renderer = nodeContentRenderers[props.node.type as CanvasNodeType];
    const definition = getNodeDefinition(props.node.type);
    let content: ReactNode;
    if (Renderer) content = <Renderer {...props} />;
    else if (definition?.Content && props.pluginContext) {
        const PluginContent = definition.Content;
        content = <PluginContent ctx={props.pluginContext} />;
    } else content = <MissingPluginContent theme={props.theme} type={props.node.type} />;

    if (props.node.metadata?.status === "error") {
        return (
            <div className="relative h-full w-full">
                {content}
                <NodeErrorBanner node={props.node} onRetry={props.onRetry} />
            </div>
        );
    }
    return content;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.FreeCard]: FreeCardNodeContent,
    [CanvasNodeType.Group]: GroupNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function FreeCardNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const info = node.metadata?.freeCard;
    const fishSkin = useEffectiveCardSkin() === "fish";
    const kind = info ? (info.outputType === "video" ? t("canvas.freeCard.videoWorkflow") : info.outputType === "image" ? t("canvas.freeCard.imageWorkflow") : t("canvas.freeCard.otherWorkflow")) : t("canvas.freeCard.emptyHint");
    if (fishSkin) {
        return (
            <div className="flex h-full w-full flex-col items-start justify-start gap-1 px-4 pt-4 text-left">
                <div className="flex items-center gap-1.5">
                    <Sparkles className="size-3.5" style={{ color: theme.node.muted }} />
                    <span className="text-[11px] font-medium" style={{ color: theme.node.muted }}>
                        {kind}
                    </span>
                </div>
                <div className="max-w-[72%] truncate text-sm font-semibold drop-shadow-[0_2px_6px_rgba(0,8,18,.8)]" style={{ color: theme.node.text }}>
                    {info?.name || t("canvas.freeCard.emptyTitle")}
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid size-12 place-items-center rounded-2xl" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>
                <Sparkles className="size-6" />
            </div>
            <div className="max-w-full truncate text-sm font-semibold" style={{ color: theme.node.text }}>
                {info?.name || t("canvas.freeCard.emptyTitle")}
            </div>
            <div className="text-xs" style={{ color: theme.node.muted }}>
                {kind}
            </div>
        </div>
    );
}

function GroupNodeContent({ node, theme, groupChildCount }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full p-3">
            <div className="flex h-7 max-w-full items-center gap-2 px-1 text-xs font-medium" style={{ color: theme.node.text }}>
                <Group className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                <span className="truncate">{node.title || t("canvas.node.group")}</span>
                <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.muted }}>
                    {t("canvas.node.nodeCount", { count: groupChildCount })}
                </span>
            </div>
        </div>
    );
}

function LoadingContent({ theme, node }: Pick<NodeContentRendererProps, "theme" | "node">) {
    const { t } = useTranslation();
    const previewUrl = node.metadata?.previewUrl;
    if (previewUrl) {
        const isVideo = Boolean(node.metadata?.previewMime?.startsWith("video/"));
        const step = node.metadata?.previewStep;
        const total = node.metadata?.previewTotal;
        return (
            <div className="relative h-full w-full overflow-hidden rounded-[18px] bg-black">
                {isVideo ? (
                    <video src={previewUrl} className="pointer-events-none h-full w-full select-none object-contain" autoPlay muted loop playsInline draggable={false} onDragStart={(event) => event.preventDefault()} />
                ) : (
                    <img src={previewUrl} alt="" className="pointer-events-none h-full w-full select-none object-contain" draggable={false} onDragStart={(event) => event.preventDefault()} />
                )}
                <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-medium tracking-wider text-white backdrop-blur-sm">
                    {t("canvas.node.generating")}
                    {step && total ? ` ${step}/${total}` : ""}
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span>
        </div>
    );
}

function NodeErrorBanner({ node, onRetry }: Pick<NodeContentRendererProps, "node" | "onRetry">) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-30 flex justify-center">
            <div className="pointer-events-auto flex max-w-[92%] items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] leading-none shadow-lg" style={{ background: "rgba(88,18,18,.92)", borderColor: "rgba(255,140,140,.45)", color: "#ffecec" }}>
                <span className="min-w-0 truncate">{node.metadata?.errorDetails || t("canvas.node.failed")}</span>
                <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition hover:opacity-80"
                    style={{ borderColor: "rgba(255,255,255,.35)" }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onRetry?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <RefreshCw className="size-3" />
                    {t("canvas.node.retry")}
                </button>
            </div>
        </div>
    );
}

function MissingPluginContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingPlugin")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingPluginDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, batchExpanded, onContentChange, onStopEditing, onToggleBatch, onSetBatchPrimary }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const texts = node.metadata?.texts || [];
    const batchCount = texts.length;
    const isBatchRoot = batchCount > 1;
    const primaryTextId = node.metadata?.primaryTextId || texts[0]?.id;
    const primaryText = texts.find((text) => text.id === primaryTextId);
    const content = primaryText?.content || node.metadata?.content || "";
    const paddingClass = isBatchRoot ? "px-4 pb-4 pt-14" : "p-4";

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? texts
                      .filter((text) => text.id !== primaryTextId)
                      .map((text, index) => <ExpandedTextCard key={text.id} node={node} text={text} index={index} onSetPrimary={() => onSetBatchPrimary?.(text.id)} />)
                : null}
            <div className="flex h-full w-full flex-col overflow-hidden rounded-3xl">
                {isEditingContent ? (
                    <CanvasResourceMentionTextarea
                        ref={textareaRef}
                        className={`thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent m-0 font-mono outline-none select-text appearance-none ${paddingClass}`}
                        style={textStyle}
                        value={content}
                        references={mentionReferences}
                        highlightLabels={false}
                        onChange={(value) => onContentChange(node.id, value)}
                        onBlur={onStopEditing}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") onStopEditing();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                    />
                ) : content ? (
                    <div className={`thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono ${paddingClass}`} style={textStyle} onWheel={(event) => event.stopPropagation()}>
                        {content}
                    </div>
                ) : primaryText ? (
                    <TextSlotStatus text={primaryText} />
                ) : (
                    <div className="p-4 font-mono" style={{ color: theme.node.placeholder }}>
                        {t("canvas.node.editText")}
                    </div>
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.12)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.textBatchExpanded") : t("canvas.node.textBatchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.texts", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedTextCard({ node, text, index, onSetPrimary }: { node: CanvasNodeData; text: CanvasNodeText; index: number; onSetPrimary: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const count = node.metadata?.texts?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const x = (slot % columns) * (node.width + 18);
    const y = (Math.floor(slot / columns) - rows + 1) * (node.height + 18);

    return (
        <div
            className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.14)]"
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: theme.node.panel,
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {text.content ? (
                <>
                    <div className="thin-scrollbar h-full overflow-y-auto whitespace-pre-wrap break-words px-4 pb-4 pt-14 font-mono text-sm leading-6" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
                        {text.content}
                    </div>
                    <button type="button" className="pointer-events-none absolute right-2.5 top-2.5 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-0 transition duration-150 hover:bg-black/5 group-hover/node:pointer-events-auto group-hover/node:opacity-100 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={(event) => (event.stopPropagation(), onSetPrimary())}>
                        <Star className="size-3.5" style={{ color: selectionBlue }} />
                        {t("canvas.node.setPrimaryText")}
                    </button>
                </>
            ) : (
                <TextSlotStatus text={text} />
            )}
        </div>
    );
}

function TextSlotStatus({ text }: { text: CanvasNodeText }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const failed = text.status === "error";
    const loading = text.status === "loading";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? <span className="text-xs leading-5">{text.errorDetails || t("canvas.node.failed")}</span> : loading ? <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} /> : <span className="text-xs">{t("apiErrors.noContent")}</span>}
            {loading ? <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span> : null}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && !props.isBatchRoot) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            batchExpanded={props.batchExpanded}
            scale={props.scale}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onDownloadBatchImage={props.onDownloadBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
        />
    );
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

function VideoNodeContent({ node, theme, onVideoDimensions }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    return (
        <video
            src={node.metadata.content}
            controls
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (video.videoWidth && video.videoHeight) onVideoDimensions?.(node.id, video.videoWidth, video.videoHeight);
            }}
            className="h-full w-full rounded-[18px] bg-black object-contain"
            data-canvas-video={node.id}
            data-canvas-no-zoom
        />
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{t("canvas.node.audio")}</span>
            </div>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    batchExpanded,
    scale,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onViewBatchImage,
}: {
    node: CanvasNodeData;
    batchExpanded: boolean;
    scale: number;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
}) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const images = node.metadata?.images || [];
    const batchCount = images.length;
    const isBatchRoot = batchCount > 1;
    const primaryImageId = node.metadata?.primaryImageId || images[0]?.id;
    const primaryImage = images.find((image) => image.id === primaryImageId);
    const primaryContent = primaryImage?.content || node.metadata?.content;
    const primaryPreviewUrl = previewUrlFor(primaryImage?.storageKey || node.metadata?.storageKey);
    const primarySource = primaryContent
        ? pickImageSource({
              previewUrl: primaryPreviewUrl,
              originalUrl: primaryContent,
              naturalWidth: primaryImage?.naturalWidth || node.metadata?.naturalWidth,
              naturalHeight: primaryImage?.naturalHeight || node.metadata?.naturalHeight,
              renderedWidth: node.width,
              renderedHeight: node.height,
              scale,
          })
        : undefined;

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? images
                      .filter((image) => image.id !== primaryImageId)
                      .map((image, index) => <ExpandedImageCard key={image.id} node={node} image={image} index={index} scale={scale} onView={() => onViewBatchImage?.(image.id)} onSetPrimary={() => onSetBatchPrimary?.(image.id)} onDuplicate={() => onDuplicateBatchImage?.(image.id)} onDownload={() => onDownloadBatchImage?.(image.id)} onRetry={() => onRetryBatchImage?.(image.id)} onDelete={() => onDeleteBatchImage?.(image.id)} />)
                : null}
            <div className="h-full w-full overflow-hidden rounded-3xl">
                {primaryContent ? (
                    <img
                        src={primarySource}
                        alt={node.title}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                ) : (
                    <ImageSlotStatus image={primaryImage} />
                )}
            </div>
            {primaryImage?.status === "error" ? <BatchImageFailureActions placement="left" onRetry={() => onRetryBatchImage?.(primaryImage.id)} onDelete={() => onDeleteBatchImage?.(primaryImage.id)} /> : null}
            {primaryImage?.content ? (
                <button type="button" className="pointer-events-none absolute left-2.5 top-2.5 z-30 flex h-8 items-center gap-1 rounded-lg border px-2 text-[10px] font-medium opacity-0 shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02] group-hover/node:pointer-events-auto group-hover/node:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("common.download")} onClick={(event) => (event.stopPropagation(), onDownloadBatchImage?.(primaryImage.id))}>
                    <Download className="size-3" />
                    {t("common.download")}
                </button>
            ) : null}
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.batchExpanded") : t("canvas.node.batchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.images", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedImageCard({ node, image, index, scale, onView, onSetPrimary, onDuplicate, onDownload, onRetry, onDelete }: { node: CanvasNodeData; image: CanvasNodeImage; index: number; scale: number; onView: () => void; onSetPrimary: () => void; onDuplicate: () => void; onDownload: () => void; onRetry: () => void; onDelete: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = column * (node.width + 18);
    const y = (row - rows + 1) * (node.height + 18);
    const source = image.content
        ? pickImageSource({
              previewUrl: previewUrlFor(image.storageKey),
              originalUrl: image.content,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              renderedWidth: node.width,
              renderedHeight: node.height,
              scale,
          })
        : undefined;

    return (
        <div
            className={`absolute z-20 overflow-hidden rounded-3xl ${image.content ? "" : "border shadow-[0_18px_50px_rgba(28,25,23,.18)]"}`}
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: "transparent",
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!image.content || (event.target instanceof Element && event.target.closest("button"))) return;
                event.stopPropagation();
                onView();
            }}
        >
            {image.content ? <img src={source} alt={node.title} draggable={false} className="pointer-events-none h-full w-full select-none object-contain" /> : <ImageSlotStatus image={image} />}
            {image.content ? (
                <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:pointer-events-auto group-hover/node:opacity-100">
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("common.download")} onClick={(event) => (event.stopPropagation(), onDownload())}>
                        <Download className="size-3 shrink-0" />
                        <span className="truncate">{t("common.download")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.createCopy")} onClick={(event) => (event.stopPropagation(), onDuplicate())}>
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.setPrimary")} onClick={(event) => (event.stopPropagation(), onSetPrimary())}>
                        <Star className="size-3 shrink-0" style={{ color: selectionBlue }} />
                        <span className="truncate">{t("canvas.node.setPrimary")}</span>
                    </button>
                </div>
            ) : null}
            {image.status === "error" ? <BatchImageFailureActions placement="right" onRetry={onRetry} onDelete={onDelete} /> : null}
        </div>
    );
}

function BatchImageFailureActions({ placement, onRetry, onDelete }: { placement: "left" | "right"; onRetry: () => void; onDelete: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    return (
        <div className={`absolute top-3 z-30 flex items-center gap-1.5 ${placement === "left" ? "left-3" : "right-3"}`}>
            <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onClick={(event) => (event.stopPropagation(), onRetry())}>
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
            <button type="button" className="grid size-8 place-items-center rounded-lg border shadow-sm transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onClick={(event) => (event.stopPropagation(), onDelete())} aria-label={t("common.delete")} title={t("common.delete")}>
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function ImageSlotStatus({ image }: { image?: CanvasNodeImage }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    const failed = image?.status === "error";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? <span className="text-xs leading-5">{image.errorDetails || t("canvas.node.failed")}</span> : <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />}
            {!failed ? <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span> : null}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, children }: { batchCount: number; batchExpanded: boolean; children: ReactNode }) {
    const theme = useCanvasTheme();
    const isBatchRoot = batchCount > 1;
    return (
        <div className="group/batch relative h-full w-full overflow-visible">
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300 group-hover/batch:translate-x-1"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded ? 0 : 1,
                                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = useCanvasTheme();

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}
