async function loadImage(url: string): Promise<HTMLImageElement> {
    const response = await fetch(url);
    if (!response.ok) throw new Error("读取图片失败");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("解码图片失败"));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

/** Local-repaint workflows that read LoadImage MASK expect the mask baked into the image alpha. */
export async function composeImageWithAlphaMask(sourceUrl: string, maskUrl: string): Promise<string> {
    const [source, mask] = await Promise.all([loadImage(sourceUrl), loadImage(maskUrl)]);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建合成画布");
    context.drawImage(source, 0, 0, width, height);
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) throw new Error("无法创建蒙版画布");
    maskContext.drawImage(mask, 0, 0, width, height);
    const maskPixels = maskContext.getImageData(0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    for (let index = 0; index < imageData.data.length; index += 4) {
        const luminance = (maskPixels.data[index] + maskPixels.data[index + 1] + maskPixels.data[index + 2]) / 3;
        imageData.data[index + 3] = Math.round((luminance * maskPixels.data[index + 3]) / 255);
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
}
