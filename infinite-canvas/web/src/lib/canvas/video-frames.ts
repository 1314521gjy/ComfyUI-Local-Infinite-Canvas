export type ExtractedVideoFrame = { id: string; name: string; type: string; dataUrl: string };

export async function extractVideoFrames(src: string, count = 5, maxEdge = 768): Promise<ExtractedVideoFrame[]> {
    if (!src) return [];
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video load failed"));
    });
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!duration || !video.videoWidth || !video.videoHeight) return [];
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return [];
    const frames: ExtractedVideoFrame[] = [];
    for (let index = 0; index < count; index += 1) {
        const time = Math.min(Math.max(0, duration - 0.05), (duration * index) / Math.max(1, count - 1));
        video.currentTime = time;
        await new Promise<void>((resolve) => {
            video.onseeked = () => resolve();
        });
        const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({
            id: `source-frame-${index}`,
            name: `source-frame-${index}.jpg`,
            type: "image/jpeg",
            dataUrl: canvas.toDataURL("image/jpeg", 0.85),
        });
    }
    return frames;
}
