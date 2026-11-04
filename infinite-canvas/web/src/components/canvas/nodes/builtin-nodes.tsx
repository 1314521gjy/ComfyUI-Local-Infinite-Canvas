import { Box, Download, FileText, Group, Image as ImageIcon, Layers3, Music2, Settings2, Sparkles, Video } from "lucide-react";
import { message } from "antd";
import { saveAs } from "file-saver";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { MODEL3D_DEFAULT_SIZE, MODEL3D_NODE_TYPE, STAGE3D_DEFAULT_SIZE, STAGE3D_NODE_TYPE } from "@/lib/canvas/model3d";
import { Model3DNodeContent } from "@/components/canvas/model3d-node-content";
import { Stage3DNodeContent } from "@/components/canvas/stage-3d-node-content";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    return null;
}

const iconClass = "size-4";

const MODEL3D_DEFINITION: CanvasNodeDefinition = {
    type: MODEL3D_NODE_TYPE,
    title: i18n.t("canvas.model3d.typeTitle"),
    icon: <Box className={iconClass} />,
    defaultSize: MODEL3D_DEFAULT_SIZE,
    defaultMetadata: { status: "idle", interactive: true },
    minimapColor: "#38bdf8",
    showInCreateMenu: false,
    hasSourceHandle: false,
    bare: true,
    transparentBackground: true,
    interactionToggle: true,
    keepAspectRatio: () => true,
    Content: Model3DNodeContent,
    toolbar: (ctx) => {
        const model = ctx.node.metadata?.model3d;
        if (!model?.url) return [];
        return [
            {
                id: "model3d-download",
                title: i18n.t("canvas.model3d.downloadTitle"),
                label: i18n.t("canvas.model3d.download"),
                icon: <Download className="size-4" />,
                onClick: () => {
                    void fetch(model.url)
                        .then((response) => {
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            return response.blob();
                        })
                        .then((blob) => saveAs(blob, model.filename || "model.ply"))
                        .catch((error) => {
                            console.error("[model3d] download failed", error);
                            message.error(i18n.t("canvas.model3d.loadFailed"));
                        });
                },
            },
        ];
    },
};

const STAGE3D_DEFINITION: CanvasNodeDefinition = {
    type: STAGE3D_NODE_TYPE,
    title: i18n.t("canvas.model3d.stageTitle"),
    icon: <Layers3 className={iconClass} />,
    defaultSize: STAGE3D_DEFAULT_SIZE,
    defaultMetadata: { status: "idle", interactive: true },
    minimapColor: "#22d3ee",
    showInCreateMenu: false,
    hasSourceHandle: false,
    bare: true,
    keepAspectRatio: () => true,
    Content: Stage3DNodeContent,
};

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, minimapColor: "#60a5fa", hasSourceHandle: false },
    { type: CanvasNodeType.FreeCard, title: i18n.t("canvas.freeCard.title"), icon: <Sparkles className={iconClass} />, minimapColor: "#eab308", hasSourceHandle: false },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
    MODEL3D_DEFINITION,
    STAGE3D_DEFINITION,
].map((def) => {
    if (def.type === MODEL3D_NODE_TYPE || def.type === STAGE3D_NODE_TYPE) return def;
    const spec = NODE_SPECS[def.type as CanvasNodeType];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(BUILTIN_DEFINITIONS, "builtin");
}
