import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, Download, LoaderCircle, RotateCcw } from "lucide-react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";

import type { CanvasNodeContext } from "@/types/canvas-plugin";
import { SceneMeshNodeContent } from "./scene-mesh-node-content";
import { uploadImage } from "@/services/image-storage";

type ViewerStatus = "idle" | "loading" | "ready" | "error";
type OrbitView = {
    rotate: (movementX: number, movementY: number) => void;
    zoom: (deltaY: number) => void;
    reset: () => void;
};

export function Model3DNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    if (ctx.node.metadata?.model3d?.format === "glb") return <SceneMeshNodeContent ctx={ctx} />;
    return <SplatNodeContent ctx={ctx} />;
}

function SplatNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const node = ctx.node;
    const model = node.metadata?.model3d;
    const url = model?.url || "";
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<OrbitView | null>(null);
    const captureRef = useRef<null | (() => Promise<string>)>(null);
    const [capturing, setCapturing] = useState(false);
    const [status, setStatus] = useState<ViewerStatus>("loading");
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState("");

    const downloadModel = useCallback(async () => {
        if (!url) return;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            saveAs(await response.blob(), model?.filename || "model.ply");
        } catch (err) {
            message.error(t("canvas.model3d.loadFailed"));
            console.error("[model3d] download failed", err);
        }
    }, [model?.filename, t, url]);

    const addPhoto = useCallback(async () => {
        const capture = captureRef.current;
        if (!capture || capturing) return;
        setCapturing(true);
        try {
            const dataUrl = await capture();
            const uploaded = await uploadImage(dataUrl);
            const scale = Math.min(1, 640 / Math.max(uploaded.width, uploaded.height));
            const width = Math.max(80, Math.round(uploaded.width * scale));
            const height = Math.max(80, Math.round(uploaded.height * scale));
            ctx.applyOps([
                {
                    type: "add_node",
                    nodeType: "image",
                    title: t("canvas.model3d.photoTitle"),
                    position: { x: ctx.node.position.x + ctx.node.width + 48, y: ctx.node.position.y },
                    width,
                    height,
                    metadata: {
                        content: uploaded.url,
                        storageKey: uploaded.storageKey,
                        mimeType: uploaded.mimeType,
                        naturalWidth: uploaded.width,
                        naturalHeight: uploaded.height,
                        bytes: uploaded.bytes,
                        status: "success",
                        prompt: "",
                    },
                },
            ]);
            message.success(t("canvas.model3d.photoAdded"));
        } catch (err) {
            message.error(t("canvas.model3d.loadFailed"));
            console.error("[model3d] capture failed", err);
        } finally {
            setCapturing(false);
        }
    }, [capturing, ctx, t]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !url) {
            // 生成失败时没有模型 URL：让节点错误条统一显示原因，避免这里再弹一次“载入失败”。
            setStatus(url ? "loading" : "idle");
            setError("");
            return;
        }
        let cancelled = false;
        let frame = 0;
        const cleanups: Array<() => void> = [];
        setStatus("loading");
        setProgress(0);
        setError("");

        void (async () => {
            try {
                const THREE = (await import("three/webgpu")) as any;
                const { GaussianSplatPLYLoader } = await import("three/addons/loaders/GaussianSplatPLYLoader.js");
                const { GaussianSplat } = await import("three/addons/objects/GaussianSplat.js");
                if (cancelled) return;

                const width = Math.max(1, container.clientWidth);
                const height = Math.max(1, container.clientHeight);
                let renderer: any;
                const makeRenderer = (forceWebGL: boolean) => new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL });
                try {
                    renderer = makeRenderer(!(navigator as Navigator & { gpu?: unknown }).gpu);
                    await renderer.init();
                } catch (firstError) {
                    renderer?.dispose?.();
                    if (cancelled) return;
                    console.warn("[model3d] WebGPU init failed, retrying with WebGL", firstError);
                    renderer = makeRenderer(true);
                    await renderer.init();
                }
                if (cancelled) {
                    renderer.dispose?.();
                    return;
                }
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                renderer.setClearColor(0x000000, 0);
                renderer.setSize(width, height, false);
                renderer.domElement.style.width = "100%";
                renderer.domElement.style.height = "100%";
                renderer.domElement.style.display = "block";
                renderer.domElement.style.touchAction = "none";
                container.appendChild(renderer.domElement);

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 1000);

                const geometry = await new GaussianSplatPLYLoader().loadAsync(url, (event: ProgressEvent) => {
                    if (!cancelled && event.total) setProgress(Math.max(0, Math.min(1, event.loaded / event.total)));
                });
                if (cancelled) {
                    geometry.dispose?.();
                    renderer.dispose?.();
                    return;
                }
                // Idol 的高斯偏小，透明画布上容易露出背景；放大协方差填满表面。
                const covariance = geometry.getAttribute("covariance");
                if (covariance?.array) {
                    const factor = 4.0;
                    for (let index = 0; index < covariance.array.length; index += 1) covariance.array[index] *= factor;
                    covariance.needsUpdate = true;
                }
                const splat = new GaussianSplat(geometry);
                // Idol 的 PLY 是 Y 向下（底座在 +Y）；转 180° 让 Three 的 Y 向上视角正立。
                splat.rotation.x = Math.PI;
                splat.frustumCulled = false;
                scene.add(splat);

                if (!geometry.boundingSphere) geometry.computeBoundingSphere();
                const sphere = geometry.boundingSphere;
                const center = sphere?.center?.clone?.() || new THREE.Vector3(0, 0, 0);
                const radius = Math.max(0.001, sphere?.radius || 1);
                const defaultTheta = Math.PI * 0.25;
                const defaultPhi = 1.31;
                const defaultDistance = radius * 2.12;
                let theta = defaultTheta;
                let phi = defaultPhi;
                let distance = defaultDistance;

                const applyView = () => {
                    camera.position.set(
                        center.x + distance * Math.sin(phi) * Math.sin(theta),
                        center.y + distance * Math.cos(phi),
                        center.z + distance * Math.sin(phi) * Math.cos(theta),
                    );
                    camera.lookAt(center);
                    camera.near = radius / 100;
                    camera.far = radius * 100;
                    camera.updateProjectionMatrix();
                };
                const resetView = () => {
                    theta = defaultTheta;
                    phi = defaultPhi;
                    distance = defaultDistance;
                    applyView();
                };
                viewRef.current = {
                    rotate: (movementX, movementY) => {
                        theta -= movementX * 0.006;
                        phi = Math.max(0.35, Math.min(Math.PI - 0.2, phi - movementY * 0.006));
                        applyView();
                    },
                    zoom: (deltaY) => {
                        distance = Math.max(radius * 1.2, Math.min(radius * 6, distance * Math.exp(deltaY * 0.0012)));
                        applyView();
                    },
                    reset: resetView,
                };
                resetView();
                captureRef.current = async () => {
                    const previousBackground = scene.background;
                    scene.background = new THREE.Color(0x0b0b0e);
                    renderer.render(scene, camera);
                    const dataUrl = renderer.domElement.toDataURL("image/png");
                    scene.background = previousBackground;
                    return dataUrl;
                };

                const onResize = () => {
                    const nextWidth = Math.max(1, container.clientWidth);
                    const nextHeight = Math.max(1, container.clientHeight);
                    renderer.setSize(nextWidth, nextHeight, false);
                    camera.aspect = nextWidth / nextHeight;
                    camera.updateProjectionMatrix();
                };
                const observer = new ResizeObserver(onResize);
                observer.observe(container);

                const stop = (event: Event) => event.stopPropagation();
                let dragging = false;
                let lastX = 0;
                let lastY = 0;
                const onPointerDown = (event: PointerEvent) => {
                    event.stopPropagation();
                    if (event.button !== 0) return;
                    dragging = true;
                    lastX = event.clientX;
                    lastY = event.clientY;
                    container.style.cursor = "grabbing";
                    container.setPointerCapture?.(event.pointerId);
                };
                // 节点拖动挂在 mousedown 上；这里拦掉，避免旋转时整块对象跟着卡片移动。
                const onMouseDown = (event: MouseEvent) => {
                    event.stopPropagation();
                    event.preventDefault();
                };
                const onPointerMove = (event: PointerEvent) => {
                    if (!dragging) return;
                    const dx = event.clientX - lastX;
                    const dy = event.clientY - lastY;
                    lastX = event.clientX;
                    lastY = event.clientY;
                    viewRef.current?.rotate(dx, dy);
                };
                const onPointerUp = (event: PointerEvent) => {
                    if (!dragging) return;
                    dragging = false;
                    container.style.cursor = "grab";
                    container.releasePointerCapture?.(event.pointerId);
                };
                const onWheel = (event: WheelEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    viewRef.current?.zoom(event.deltaY);
                };
                container.style.cursor = "grab";
                container.addEventListener("mousedown", onMouseDown);
                container.addEventListener("pointerdown", onPointerDown);
                container.addEventListener("pointermove", onPointerMove);
                container.addEventListener("pointerup", onPointerUp);
                container.addEventListener("pointercancel", onPointerUp);
                container.addEventListener("wheel", onWheel, { passive: false });
                container.addEventListener("dblclick", stop);

                const tick = () => {
                    renderer.render(scene, camera);
                    frame = window.requestAnimationFrame(tick);
                };
                tick();
                setStatus("ready");

                cleanups.push(() => {
                    window.cancelAnimationFrame(frame);
                    observer.disconnect();
                    container.removeEventListener("mousedown", onMouseDown);
                    container.removeEventListener("pointerdown", onPointerDown);
                    container.removeEventListener("pointermove", onPointerMove);
                    container.removeEventListener("pointerup", onPointerUp);
                    container.removeEventListener("pointercancel", onPointerUp);
                    container.removeEventListener("wheel", onWheel);
                    container.style.cursor = "";
                    container.removeEventListener("dblclick", stop);
                    scene.remove(splat);
                    geometry.dispose?.();
                    renderer.dispose?.();
                    renderer.domElement.remove();
                });
            } catch (err) {
                if (cancelled) return;
                console.error("[model3d] load failed", err);
                setError(err instanceof Error ? err.message : String(err));
                setStatus("error");
            }
        })();

        return () => {
            cancelled = true;
            for (const cleanup of cleanups) cleanup();
            viewRef.current = null;
            captureRef.current = null;
        };
    }, [t, url]);

    if (!url) return <div className="h-full w-full" style={{ background: "transparent" }} />;

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: "transparent" }}>
            <div ref={containerRef} className="absolute inset-0" />
            {status === "loading" ? (
                <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs" style={{ background: "rgba(11,11,14,.78)", color: "#cbd5e1" }}>
                    <LoaderCircle className="size-6 animate-spin" />
                    <span>
                        {t("canvas.model3d.loading")}
                        {progress > 0 ? ` ${Math.round(progress * 100)}%` : ""}
                    </span>
                </div>
            ) : null}
            {status === "error" ? (
                <div className="absolute left-1/2 top-1/2 flex max-w-[90%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-2 rounded-lg px-4 py-3 text-center text-xs" style={{ background: "rgba(11,11,14,.82)", color: "#fca5a5" }}>
                    <span>{t("canvas.model3d.loadFailed")}</span>
                    <span className="max-w-full truncate opacity-70" title={error}>
                        {error}
                    </span>
                    <button
                        type="button"
                        className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
                        style={{ background: "#1f2937", color: "#e2e8f0" }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void downloadModel()}
                    >
                        <Download className="size-3.5" />
                        {t("canvas.model3d.download")}
                    </button>
                </div>
            ) : null}
            {status === "ready" ? (
                <div className="pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "rgba(0,0,0,0.45)", color: "#cbd5e1" }}>
                    {t("canvas.model3d.dragHint")}
                </div>
            ) : null}
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <button
                    type="button"
                    title={t("canvas.model3d.photo")}
                    disabled={capturing || status !== "ready"}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] backdrop-blur disabled:opacity-40"
                    style={{ background: "rgba(240,248,255,.16)", color: "#f1f5f9" }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        void addPhoto();
                    }}
                >
                    <Camera className="size-3.5" />
                    {t("canvas.model3d.photo")}
                </button>
                <ViewerButton label={t("canvas.model3d.reset")} onClick={() => viewRef.current?.reset()} icon={<RotateCcw className="size-3.5" />} />
                <ViewerButton label={t("canvas.model3d.downloadTitle")} onClick={() => void downloadModel()} icon={<Download className="size-3.5" />} />
            </div>
        </div>
    );
}

function ViewerButton({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            title={label}
            className="inline-flex size-7 items-center justify-center rounded-md backdrop-blur"
            style={{ background: "rgba(0,0,0,0.45)", color: "#cbd5e1" }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {icon}
        </button>
    );
}
