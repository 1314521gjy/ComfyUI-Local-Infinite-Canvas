import i18n from "@/i18n";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const CONFIG_COMPOSER_ENABLED: boolean = false;

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.image"); } },
    [CanvasNodeType.Text]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.text"); } },
    [CanvasNodeType.Config]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.config"); } },
    [CanvasNodeType.Video]: { width: 420, height: 236, get title() { return i18n.t("canvas.nodeTypes.video"); } },
    [CanvasNodeType.Audio]: { width: 340, height: 120, get title() { return i18n.t("canvas.nodeTypes.audio"); } },
    [CanvasNodeType.FreeCard]: { width: 340, height: 240, get title() { return i18n.t("canvas.nodeTypes.freeCard"); } },
    [CanvasNodeType.Automation]: { width: 460, height: 320, get title() { return i18n.t("canvas.nodeTypes.automation"); } },
    [CanvasNodeType.Drama]: { width: 960, height: 760, title: "短剧" },
    [CanvasNodeType.Group]: { width: 760, height: 480, get title() { return i18n.t("canvas.nodeTypes.group"); } },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Image].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Text].title; },
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Config]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Config].title; },
        metadata: { content: "", status: "idle", generationMode: "image" },
    },
    [CanvasNodeType.Video]: {
        width: 420, height: 236, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Video].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        width: 340, height: 120, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Audio].title; },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.FreeCard]: {
        width: 340, height: 240, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.FreeCard].title; },
        metadata: { status: "idle", prompt: "", generationMode: "image" },
    },
    [CanvasNodeType.Automation]: {
        width: 460, height: 320, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Automation].title; },
        metadata: { status: "idle" },
    },
    [CanvasNodeType.Drama]: {
        width: 960, height: 760, title: "短剧",
        metadata: {
            status: "idle",
            dramaCard: {
                title: "斗破苍穹",
                style: "xianxia 3d",
                aspect: "16:9",
                imageWorkflow: "local-gateway::image-qwen21",
                videoWorkflow: "",
                videoMode: "frames",
                activeTab: "characters",
                episodes: [
                    { id: "ep-1", title: "第一章陨落的天才", synopsis: "斗之力，三段！望着测验魔石…", shots: 19, draft: true },
                    { id: "ep-2", title: "第二章斗气大陆", synopsis: "月如银盘，漫天繁星。山崖之…", shots: 0, draft: true },
                    { id: "ep-3", title: "第三章客人", synopsis: "床榻之上，少年闭目盘腿而坐…", shots: 0, draft: true },
                ],
            },
        },
    },
    [CanvasNodeType.Group]: {
        width: 760, height: 480, get title() { return NODE_DEFAULT_SIZE[CanvasNodeType.Group].title; },
        metadata: { status: "idle" },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return built-in specs directly and resolve plugin types from the registry.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, title: spec.title, metadata: spec.metadata };
}
