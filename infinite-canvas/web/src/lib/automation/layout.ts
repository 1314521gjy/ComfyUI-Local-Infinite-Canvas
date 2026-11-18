import type { CanvasNodeData } from "@/types/canvas";
import { automationGridSpec } from "@/lib/automation/skills";

export type AutomationLayoutSlot = {
    x: number;
    y: number;
    width: number;
    height: number;
};

const ROWS = 6;
const TEXT_WIDTH = 340;
const TEXT_HEIGHT = 300;
const ROW_GAP = 48;
const PAIR_GAP = 32;
const GROUP_GAP = 120;

export function automationImageSize(aspect: string): { width: number; height: number } {
    switch (aspect) {
        case "4:3":
            return { width: 360, height: 270 };
        case "1:1":
            return { width: 320, height: 320 };
        case "16:9":
            return { width: 420, height: 236 };
        case "9:16":
            return { width: 236, height: 420 };
        default:
            return { width: 300, height: 400 };
    }
}

const CARD_MAX_WIDTH = 300;
const CARD_MAX_HEIGHT = 420;

function cellRatio(aspect: string) {
    switch (aspect) {
        case "4:3":
            return 4 / 3;
        case "1:1":
            return 1;
        case "16:9":
            return 16 / 9;
        case "3:4":
            return 3 / 4;
        case "9:16":
        default:
            return 9 / 16;
    }
}

/** Each cell uses the selected aspect (default 16:9); the page card aspect follows rows/cols. */
export function automationPageCardSize(grid: "2x2" | "2x3" | "3x3", aspect: string) {
    const spec = automationGridSpec(grid);
    const ratio = cellRatio(aspect) * (spec.cols / spec.rows);
    let width = CARD_MAX_WIDTH;
    let height = width / ratio;
    if (height > CARD_MAX_HEIGHT) {
        height = CARD_MAX_HEIGHT;
        width = height * ratio;
    }
    return { width: Math.round(width), height: Math.round(height) };
}

export function computeAutomationLayout(parent: CanvasNodeData, pageCount: number, aspect: string, grid: "2x2" | "2x3" | "3x3", leftOffset = 0) {
    const image = automationPageCardSize(grid, aspect);
    const video = automationImageSize(aspect);
    const startX = parent.position.x + parent.width + GROUP_GAP + leftOffset;
    const startY = parent.position.y;
    const rowHeight = Math.max(TEXT_HEIGHT, image.height, video.height) + ROW_GAP;
    const pairWidth = TEXT_WIDTH + PAIR_GAP + image.width;
    const pairGroups = Math.max(1, Math.ceil(pageCount / ROWS));
    const videoStartX = startX + pairGroups * (pairWidth + GROUP_GAP);

    const texts: AutomationLayoutSlot[] = [];
    const images: AutomationLayoutSlot[] = [];
    const videos: AutomationLayoutSlot[] = [];

    for (let index = 0; index < pageCount; index += 1) {
        const group = Math.floor(index / ROWS);
        const row = index % ROWS;
        const x = startX + group * (pairWidth + GROUP_GAP);
        const y = startY + row * rowHeight;
        texts.push({ x, y, width: TEXT_WIDTH, height: TEXT_HEIGHT });
        images.push({ x: x + TEXT_WIDTH + PAIR_GAP, y, width: image.width, height: image.height });
        const videoGroup = Math.floor(index / ROWS);
        videos.push({ x: videoStartX + videoGroup * (video.width + GROUP_GAP), y, width: video.width, height: video.height });
    }
    return { texts, images, videos };
}
