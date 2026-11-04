import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export const REFERENCE_ACCELERATION_MAX = 9;
const ACCELERATION_CELL_SCALE = 1.5;

export function referenceAccelerationGrid(count: number) {
    const total = Math.max(1, Math.min(REFERENCE_ACCELERATION_MAX, Math.floor(Number(count) || 1)));
    const cols = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / cols);
    return { cols, rows, total };
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("reference acceleration image load failed"));
        image.src = src;
    });
}

function drawContained(context: CanvasRenderingContext2D, image: HTMLImageElement, left: number, top: number, width: number, height: number) {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = Math.max(1, image.naturalWidth * scale);
    const drawHeight = Math.max(1, image.naturalHeight * scale);
    context.drawImage(image, left + (width - drawWidth) / 2, top + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
}

function drawOrderLabel(context: CanvasRenderingContext2D, left: number, top: number, cellWidth: number, cellHeight: number, index: number) {
    const fontSize = Math.max(18, Math.round(cellHeight * 0.05));
    const padX = Math.round(fontSize * 0.55);
    const padY = Math.round(fontSize * 0.32);
    const text = `图${index}`;
    context.font = `700 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    const width = context.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    const x = left + Math.round(cellWidth * 0.018);
    const y = top + Math.round(cellHeight * 0.018);
    context.fillStyle = "rgba(0, 0, 0, 0.64)";
    roundedRect(context, x, y, width, height, Math.round(fontSize * 0.28));
    context.fill();
    context.strokeStyle = "rgba(255, 255, 255, 0.24)";
    context.lineWidth = Math.max(1, Math.round(fontSize * 0.05));
    context.stroke();
    context.fillStyle = "#ffffff";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(text, x + padX, y + height / 2 + 1);
}

/** 参考加速：先按连接顺序拼成高分辨率单图并标注 图1、图2…，再整图压到目标分辨率。 */
export async function buildAcceleratedReference(references: ReferenceImage[], target: { width: number; height: number }): Promise<ReferenceImage> {
    const selected = references.slice(0, REFERENCE_ACCELERATION_MAX);
    const images = await Promise.all(selected.map(async (reference) => loadImage(await imageToDataUrl(reference))));
    const { cols, rows } = referenceAccelerationGrid(images.length);
    const cellWidth = Math.max(32, Math.round(target.width * ACCELERATION_CELL_SCALE));
    const cellHeight = Math.max(32, Math.round(target.height * ACCELERATION_CELL_SCALE));
    const canvas = document.createElement("canvas");
    canvas.width = cols * cellWidth;
    canvas.height = rows * cellHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("reference acceleration canvas unavailable");
    context.fillStyle = "#202020";
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
        const left = (index % cols) * cellWidth;
        const top = Math.floor(index / cols) * cellHeight;
        drawContained(context, image, left, top, cellWidth, cellHeight);
        context.strokeStyle = "rgba(255, 255, 255, 0.12)";
        context.lineWidth = 1;
        context.strokeRect(left + 0.5, top + 0.5, cellWidth - 1, cellHeight - 1);
        drawOrderLabel(context, left, top, cellWidth, cellHeight, index + 1);
    });
    const output = document.createElement("canvas");
    output.width = Math.max(32, Math.round(target.width));
    output.height = Math.max(32, Math.round(target.height));
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("reference acceleration output canvas unavailable");
    outputContext.imageSmoothingEnabled = true;
    outputContext.imageSmoothingQuality = "high";
    outputContext.drawImage(canvas, 0, 0, output.width, output.height);
    return {
        id: `accelerated-ref-${Date.now()}`,
        name: "reference-accelerated.png",
        type: "image/png",
        dataUrl: output.toDataURL("image/png"),
    };
}
