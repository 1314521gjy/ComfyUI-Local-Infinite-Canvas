import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export const DRAFT_REFERENCE_CELL = 256;
export const DRAFT_REFERENCE_MAX = 16;

export function draftReferenceGrid(count: number) {
    const total = Math.max(1, Math.min(DRAFT_REFERENCE_MAX, Math.floor(Number(count) || 1)));
    const cols = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / cols);
    return { cols, rows, total };
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("draft reference image load failed"));
        image.src = src;
    });
}

function drawContained(context: CanvasRenderingContext2D, image: HTMLImageElement, left: number, top: number, cell: number) {
    const scale = Math.min(cell / image.naturalWidth, cell / image.naturalHeight);
    const width = Math.max(1, image.naturalWidth * scale);
    const height = Math.max(1, image.naturalHeight * scale);
    context.drawImage(image, left + (cell - width) / 2, top + (cell - height) / 2, width, height);
}

function canvasToReference(canvas: HTMLCanvasElement, count: number): ReferenceImage {
    return {
        id: `draft-ref-${Date.now()}`,
        name: count > 1 ? "draft-references.jpg" : "draft-reference.jpg",
        type: "image/jpeg",
        dataUrl: canvas.toDataURL("image/jpeg", 0.86),
    };
}

/** 草稿参考：逐张压缩到 256 格，再按数量拼成一张自适应网格。 */
export async function prepareDraftReferenceImages(references: ReferenceImage[], mode: string): Promise<ReferenceImage[]> {
    if (mode !== "reference" || !references.length) return references;
    const selected = references.slice(0, DRAFT_REFERENCE_MAX);
    const images = await Promise.all(selected.map(async (reference) => loadImage(await imageToDataUrl(reference))));
    const { cols, rows } = draftReferenceGrid(images.length);
    const canvas = document.createElement("canvas");
    canvas.width = cols * DRAFT_REFERENCE_CELL;
    canvas.height = rows * DRAFT_REFERENCE_CELL;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("draft reference canvas unavailable");
    context.fillStyle = "#202020";
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
        const left = (index % cols) * DRAFT_REFERENCE_CELL;
        const top = Math.floor(index / cols) * DRAFT_REFERENCE_CELL;
        drawContained(context, image, left, top, DRAFT_REFERENCE_CELL);
    });
    return [canvasToReference(canvas, images.length)];
}
