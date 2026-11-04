import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Camera, LoaderCircle, Minus, Plus, RotateCcw, RotateCw, Trash2, X } from "lucide-react";
import { message } from "antd";
import { useTranslation } from "react-i18next";

import { uploadImage } from "@/services/image-storage";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

type StageTransform = { x: number; y: number; z: number; rotation: number; scale: number };
type CharacterMeta = { id?: string; url: string; filename?: string; bytes?: number; transform?: Partial<StageTransform> };
type CharacterEntry = {
    id: string;
    meta: CharacterMeta;
    group: any;
    geometry: any;
    bottom: number;
    height: number;
    centerX: number;
    centerZ: number;
    baseScale: number;
    transform: StageTransform;
};
type StageView = {
    rotate: (delta: number) => void;
    scaleBy: (factor: number) => void;
    raise: (delta: number) => void;
    reset: () => void;
    select: (id: string) => void;
    remove: (id: string) => void;
    removeSelected: () => void;
    capture: () => Promise<string>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const defaultTransform = (source?: Partial<StageTransform>): StageTransform => ({ x: 0, y: 0, z: 0, rotation: 0, scale: 1, ...(source || {}) });

function characterMetasOf(stage: any): CharacterMeta[] {
    if (!stage) return [];
    if (Array.isArray(stage.characters) && stage.characters.length) return stage.characters;
    if (stage.character?.url) return [{ id: "legacy", ...stage.character, transform: stage.transform }];
    return [];
}

export function Stage3DNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const stage = ctx.node.metadata?.stage3d;
    const sceneUrl = stage?.scene?.url || "";
    const characterMetas = useMemo(() => characterMetasOf(stage), [stage]);
    const removedIdsRef = useRef<Set<string>>(new Set());
    const charactersKey = [...new Set([...characterMetas.map((item) => item.id || item.url), ...removedIdsRef.current])].sort().join("|");
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<StageView | null>(null);
    const ctxRef = useRef(ctx);
    const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(sceneUrl ? "loading" : "error");
    const [error, setError] = useState("");
    const [capturing, setCapturing] = useState(false);
    const [characterItems, setCharacterItems] = useState<Array<{ id: string; label: string }>>([]);
    const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
    const markerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        ctxRef.current = ctx;
    }, [ctx]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !sceneUrl) {
            setStatus("error");
            setError(t("canvas.model3d.stageMissing"));
            return;
        }
        let cancelled = false;
        let frame = 0;
        const cleanups: Array<() => void> = [];
        setStatus("loading");
        setError("");

        void (async () => {
            try {
                const THREE = (await import("three/webgpu")) as any;
                const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
                const { GaussianSplatPLYLoader } = await import("three/addons/loaders/GaussianSplatPLYLoader.js");
                const { GaussianSplat } = await import("three/addons/objects/GaussianSplat.js");
                if (cancelled) return;

                const width = Math.max(1, container.clientWidth);
                const height = Math.max(1, container.clientHeight);
                const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
                await renderer.init();
                if (cancelled) {
                    renderer.dispose?.();
                    return;
                }
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                renderer.setClearColor(0x0b0b0e, 1);
                renderer.setSize(width, height, false);
                renderer.domElement.style.width = "100%";
                renderer.domElement.style.height = "100%";
                renderer.domElement.style.display = "block";
                renderer.domElement.style.touchAction = "none";
                container.appendChild(renderer.domElement);

                const scene = new THREE.Scene();
                scene.background = new THREE.Color(0x0b0b0e);
                scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.4));
                const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
                keyLight.position.set(2.5, 3.5, 2.5);
                scene.add(keyLight);
                const fillLight = new THREE.DirectionalLight(0xbfd4ff, 0.7);
                fillLight.position.set(-2, 1, -2);
                scene.add(fillLight);
                const camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 1000);

                const gltf = await new GLTFLoader().loadAsync(sceneUrl);
                if (cancelled) return;
                const room = gltf.scene;
                room.traverse((child: any) => {
                    if (!child?.isMesh) return;
                    const materials = Array.isArray(child.material) ? child.material : [child.material];
                    for (const material of materials) {
                        if (!material) continue;
                        material.side = THREE.DoubleSide;
                        material.needsUpdate = true;
                    }
                    child.frustumCulled = false;
                });
                const rawBox = new THREE.Box3().setFromObject(room);
                const rawSize = rawBox.getSize(new THREE.Vector3());
                const rawCenter = rawBox.getCenter(new THREE.Vector3());
                const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
                const sceneScale = 2.6 / maxDim;
                room.scale.setScalar(sceneScale);
                room.position.set(-rawCenter.x * sceneScale, -rawBox.min.y * sceneScale, -rawCenter.z * sceneScale);
                scene.add(room);
                const sceneBox = new THREE.Box3().setFromObject(room);
                const floorY = sceneBox.min.y;
                const sceneHeight = Math.max(0.001, sceneBox.max.y - sceneBox.min.y);
                const sceneWidth = Math.max(0.001, sceneBox.max.x - sceneBox.min.x);
                const sceneDepth = Math.max(0.001, sceneBox.max.z - sceneBox.min.z);
                const limitX = sceneWidth * 0.42;
                const limitZ = sceneDepth * 0.42;

                const entries: CharacterEntry[] = [];
                for (const [index, meta] of characterMetas.entries()) {
                    if (!meta.url) continue;
                    const geometry = await new GaussianSplatPLYLoader().loadAsync(meta.url);
                    if (cancelled) return;
                    const covariance = geometry.getAttribute("covariance");
                    if (covariance?.array) {
                        const factor = 4;
                        for (let i = 0; i < covariance.array.length; i += 1) covariance.array[i] *= factor;
                        covariance.needsUpdate = true;
                    }
                    const splat = new GaussianSplat(geometry);
                    splat.rotation.x = Math.PI;
                    splat.frustumCulled = false;
                    const group = new THREE.Group();
                    group.add(splat);
                    scene.add(group);

                    const positionAttribute = geometry.getAttribute("position");
                    let bottom = -0.5;
                    let charHeight = 1;
                    let centerX = 0;
                    let centerZ = 0;
                    if (positionAttribute?.array) {
                        const values: number[] = [];
                        const xs: number[] = [];
                        const zs: number[] = [];
                        const positions = positionAttribute.array as Float32Array;
                        const step = Math.max(3, Math.floor(positions.length / 3 / 20000) * 3);
                        for (let i = 0; i + 2 < positions.length; i += step) {
                            values.push(-positions[i + 1]);
                            xs.push(positions[i]);
                            zs.push(positions[i + 2]);
                        }
                        const trim = (list: number[]) => {
                            list.sort((a, b) => a - b);
                            if (!list.length) return [0, 0] as const;
                            const low = list[Math.max(0, Math.floor(list.length * 0.01))];
                            const high = list[Math.min(list.length - 1, Math.floor(list.length * 0.99))];
                            return [low, high] as const;
                        };
                        const [yLow, yHigh] = trim(values);
                        const [xLow, xHigh] = trim(xs);
                        const [zLow, zHigh] = trim(zs);
                        bottom = yLow;
                        charHeight = Math.max(0.001, yHigh - yLow);
                        centerX = (xLow + xHigh) * 0.5;
                        centerZ = -(zLow + zHigh) * 0.5;
                    }
                    const baseScale = (sceneHeight * 0.45) / charHeight;
                    const transform = defaultTransform(meta.transform);
                    if (!meta.transform && index > 0) {
                        transform.x = (index - (characterMetas.length - 1) / 2) * 0.5;
                    }
                    entries.push({ id: meta.id || `char-${index}`, meta, group, geometry, bottom, height: charHeight, centerX, centerZ, baseScale, transform });
                }
                if (cancelled) return;

                const applyEntry = (entry: CharacterEntry) => {
                    const scale = entry.baseScale * entry.transform.scale;
                    entry.group.scale.setScalar(scale);
                    entry.group.rotation.y = entry.transform.rotation;
                    entry.group.position.set(
                        clamp(entry.transform.x, -limitX, limitX),
                        floorY - entry.bottom * scale + (Number.isFinite(entry.transform.y) ? entry.transform.y : 0),
                        clamp(entry.transform.z, -limitZ, limitZ),
                    );
                };
                entries.forEach(applyEntry);

                const target = new THREE.Vector3(0, sceneHeight * 0.45, 0);
                let theta = Math.PI * 0.25;
                let phi = 1.25;
                let distance = Math.max(sceneWidth, sceneDepth, sceneHeight) * 1.45;
                const applyCamera = () => {
                    camera.position.set(
                        target.x + distance * Math.sin(phi) * Math.sin(theta),
                        target.y + distance * Math.cos(phi),
                        target.z + distance * Math.sin(phi) * Math.cos(theta),
                    );
                    camera.lookAt(target);
                    camera.near = Math.max(0.0001, distance / 1000);
                    camera.far = distance * 20;
                    camera.updateProjectionMatrix();
                };
                applyCamera();

                let selectedId = entries.length ? entries[entries.length - 1].id : null;
                const setSelection = (id: string | null) => {
                    selectedId = id;
                    setSelectedCharacterId(id);
                };
                const refreshCharacterItems = () => setCharacterItems(entries.map((entry, index) => ({ id: entry.id, label: t("canvas.model3d.characterLabel", { index: index + 1 }) })));
                refreshCharacterItems();
                setSelectedCharacterId(selectedId);
                const selectedEntry = () => entries.find((entry) => entry.id === selectedId) || null;
                const persist = () => {
                    ctxRef.current.updateMetadata({
                        stage3d: {
                            scene: stage?.scene || { url: sceneUrl },
                            characters: entries.map((entry) => ({ id: entry.id, url: entry.meta.url, filename: entry.meta.filename, bytes: entry.meta.bytes, transform: entry.transform })),
                        },
                    });
                };
                const removeEntry = (id: string) => {
                    const index = entries.findIndex((entry) => entry.id === id);
                    if (index < 0) return;
                    const [entry] = entries.splice(index, 1);
                    scene.remove(entry.group);
                    entry.geometry.dispose?.();
                    removedIdsRef.current.add(id);
                    setSelection(entries.length ? entries[Math.min(index, entries.length - 1)].id : null);
                    refreshCharacterItems();
                    persist();
                };

                let dragging: "orbit" | CharacterEntry | null = null;
                let lastX = 0;
                let lastY = 0;
                const raycaster = new THREE.Raycaster();
                const pointer = new THREE.Vector2();
                const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
                const planePoint = new THREE.Vector3();
                const moveCharacter = (entry: CharacterEntry, event: PointerEvent) => {
                    const rect = container.getBoundingClientRect();
                    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
                    raycaster.setFromCamera(pointer, camera);
                    if (!raycaster.ray.intersectPlane(floorPlane, planePoint)) return;
                    entry.transform = { ...entry.transform, x: clamp(planePoint.x, -limitX, limitX), z: clamp(planePoint.z, -limitZ, limitZ) };
                    applyEntry(entry);
                };
                const projected = new THREE.Vector3();
                const nearestCharacter = (event: { clientX: number; clientY: number }) => {
                    const rect = container.getBoundingClientRect();
                    let best: CharacterEntry | null = null;
                    let bestDistance = 110;
                    for (const entry of entries) {
                        projected.copy(entry.group.position);
                        projected.y += (entry.bottom + entry.height * 0.5) * entry.group.scale.y;
                        projected.project(camera);
                        const sx = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
                        const sy = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
                        const distanceToPointer = Math.hypot(event.clientX - sx, event.clientY - sy);
                        if (distanceToPointer < bestDistance) {
                            best = entry;
                            bestDistance = distanceToPointer;
                        }
                    }
                    return best;
                };

                const onMouseDown = (event: MouseEvent) => {
                    if (event.button !== 0) {
                        event.stopPropagation();
                        return;
                    }
                    // 空白处不拦截，交给画布拖动整张 3D 台；角色和 Alt 视角留在台内。
                    if (event.altKey || nearestCharacter(event)) {
                        event.stopPropagation();
                        event.preventDefault();
                    }
                };
                const onPointerDown = (event: PointerEvent) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    if (event.altKey) {
                        dragging = "orbit";
                        lastX = event.clientX;
                        lastY = event.clientY;
                    } else {
                        const entry = nearestCharacter(event);
                        if (!entry) return;
                        setSelection(entry.id);
                        dragging = entry;
                        moveCharacter(entry, event);
                    }
                    container.setPointerCapture?.(event.pointerId);
                };
                const onPointerMove = (event: PointerEvent) => {
                    if (!dragging) return;
                    if (dragging === "orbit") {
                        theta -= (event.clientX - lastX) * 0.006;
                        phi = clamp(phi - (event.clientY - lastY) * 0.006, 0.35, Math.PI - 0.2);
                        lastX = event.clientX;
                        lastY = event.clientY;
                        applyCamera();
                    } else {
                        moveCharacter(dragging, event);
                    }
                };
                const onPointerUp = (event: PointerEvent) => {
                    if (!dragging) return;
                    if (dragging !== "orbit") persist();
                    dragging = null;
                    container.releasePointerCapture?.(event.pointerId);
                };
                const onWheel = (event: WheelEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    distance = clamp(distance * Math.exp(event.deltaY * 0.0012), 0.2, 500);
                    applyCamera();
                };
                container.addEventListener("mousedown", onMouseDown);
                container.addEventListener("pointerdown", onPointerDown);
                container.addEventListener("pointermove", onPointerMove);
                container.addEventListener("pointerup", onPointerUp);
                container.addEventListener("pointercancel", onPointerUp);
                container.addEventListener("wheel", onWheel, { passive: false });

                const updateSelected = (mutate: (entry: CharacterEntry) => void) => {
                    const entry = selectedEntry();
                    if (!entry) return;
                    mutate(entry);
                    applyEntry(entry);
                    persist();
                };
                viewRef.current = {
                    rotate: (delta) => updateSelected((entry) => { entry.transform = { ...entry.transform, rotation: entry.transform.rotation + delta }; }),
                    scaleBy: (factor) => updateSelected((entry) => { entry.transform = { ...entry.transform, scale: clamp(entry.transform.scale * factor, 0.2, 3) }; }),
                    raise: (delta) => updateSelected((entry) => { entry.transform = { ...entry.transform, y: (entry.transform.y || 0) + delta }; }),
                    reset: () => {
                        updateSelected((entry) => { entry.transform = defaultTransform(); });
                        theta = Math.PI * 0.25;
                        phi = 1.25;
                        distance = Math.max(sceneWidth, sceneDepth, sceneHeight) * 1.45;
                        applyCamera();
                    },
                    select: (id) => {
                        if (!entries.some((entry) => entry.id === id)) return;
                        setSelection(id);
                    },
                    remove: (id) => removeEntry(id),
                    removeSelected: () => {
                        if (selectedId) removeEntry(selectedId);
                    },
                    capture: async () => {
                        renderer.render(scene, camera);
                        return renderer.domElement.toDataURL("image/png");
                    },
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

                const markerCenter = new THREE.Vector3();
                const markerTop = new THREE.Vector3();
                const updateMarker = () => {
                    const marker = markerRef.current;
                    if (!marker) return;
                    const entry = selectedEntry();
                    if (!entry) {
                        marker.style.opacity = "0";
                        return;
                    }
                    const scale = entry.group.scale.y;
                    const middleY = (entry.bottom + entry.height * 0.5) * scale;
                    markerCenter.copy(entry.group.position);
                    markerCenter.x += entry.centerX * scale;
                    markerCenter.y += middleY;
                    markerCenter.z += entry.centerZ * scale;
                    markerTop.copy(entry.group.position);
                    markerTop.x += entry.centerX * scale;
                    markerTop.y += middleY + entry.height * 0.5 * scale;
                    markerTop.z += entry.centerZ * scale;
                    markerCenter.project(camera);
                    markerTop.project(camera);
                    if (markerCenter.z > 1) {
                        marker.style.opacity = "0";
                        return;
                    }
                    // 标记在节点内部，left/top 是未缩放坐标；画布缩放后不能用屏幕尺寸。
                    const viewWidth = container.clientWidth;
                    const viewHeight = container.clientHeight;
                    const screenX = (markerCenter.x * 0.5 + 0.5) * viewWidth;
                    const screenY = (-markerCenter.y * 0.5 + 0.5) * viewHeight;
                    const topY = (-markerTop.y * 0.5 + 0.5) * viewHeight;
                    const radius = Math.max(16, Math.abs(screenY - topY) * 1.2);
                    marker.style.opacity = "1";
                    marker.style.width = `${radius * 2}px`;
                    marker.style.height = `${radius * 2}px`;
                    marker.style.left = `${screenX}px`;
                    marker.style.top = `${screenY}px`;
                };
                const tick = () => {
                    renderer.render(scene, camera);
                    updateMarker();
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
                    for (const entry of entries) entry.geometry.dispose?.();
                    renderer.dispose?.();
                    renderer.domElement.remove();
                });
            } catch (err) {
                if (cancelled) return;
                console.error("[stage3d] load failed", err);
                setError(err instanceof Error ? err.message : String(err));
                setStatus("error");
            }
        })();

        return () => {
            cancelled = true;
            for (const cleanup of cleanups) cleanup();
            viewRef.current = null;
        };
    }, [charactersKey, sceneUrl, t]);

    const addPhoto = useCallback(async () => {
        const capture = viewRef.current?.capture;
        if (!capture || capturing) return;
        setCapturing(true);
        try {
            const dataUrl = await capture();
            const uploaded = await uploadImage(dataUrl);
            const scale = Math.min(1, 720 / Math.max(uploaded.width, uploaded.height));
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
            console.error("[stage3d] capture failed", err);
        } finally {
            setCapturing(false);
        }
    }, [capturing, ctx, t]);

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: "#0b0b0e" }}>
            <div ref={containerRef} className="absolute inset-0" />
            <div
                ref={markerRef}
                className="pointer-events-none absolute rounded-full"
                style={{ left: 0, top: 0, width: 0, height: 0, opacity: 0, border: "2px solid rgba(34,211,238,.8)", boxShadow: "0 0 0 1px rgba(8,47,73,.5), 0 0 20px rgba(34,211,238,.35)", transform: "translate(-50%, -50%)" }}
            />
            {status === "ready" && characterItems.length ? (
                <div className="absolute left-2 top-2 flex max-w-[calc(100%-16px)] flex-wrap gap-1">
                    {characterItems.map((item) => {
                        const active = item.id === selectedCharacterId;
                        return (
                            <div
                                key={item.id}
                                className="flex h-7 items-center overflow-hidden rounded-md text-[11px] backdrop-blur"
                                style={{
                                    background: active ? "rgba(34,211,238,.2)" : "rgba(0,0,0,.5)",
                                    border: active ? "1px solid rgba(34,211,238,.7)" : "1px solid rgba(255,255,255,.12)",
                                    color: "#e2e8f0",
                                }}
                                onPointerDown={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <button type="button" className="h-full px-2" onClick={() => viewRef.current?.select(item.id)}>
                                    {item.label}
                                </button>
                                <button
                                    type="button"
                                    className="flex h-full w-7 items-center justify-center opacity-70 hover:opacity-100"
                                    title={t("canvas.model3d.removeCharacter")}
                                    onClick={() => viewRef.current?.remove(item.id)}
                                >
                                    <X className="size-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {status === "loading" ? (
                <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-lg px-4 py-3 text-xs" style={{ background: "rgba(11,11,14,.85)", color: "#cbd5e1" }}>
                    <LoaderCircle className="size-6 animate-spin" />
                    <span>{t("canvas.model3d.stageLoading")}</span>
                </div>
            ) : null}
            {status === "error" ? (
                <div className="absolute left-1/2 top-1/2 flex max-w-[90%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-lg px-4 py-3 text-center text-xs" style={{ background: "rgba(11,11,14,.85)", color: "#fca5a5" }}>
                    <span>{t("canvas.model3d.stageFailed")}</span>
                    <span className="max-w-full truncate opacity-70" title={error}>{error}</span>
                </div>
            ) : null}
            {status === "ready" ? (
                <div className="pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "rgba(0,0,0,0.45)", color: "#cbd5e1" }}>
                    {t("canvas.model3d.stageHint")}
                </div>
            ) : null}
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <ToolButton label={t("canvas.model3d.photo")} disabled={capturing || status !== "ready"} accent onClick={() => void addPhoto()} icon={<Camera className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.rotateLeft")} disabled={status !== "ready"} onClick={() => viewRef.current?.rotate(-Math.PI / 12)} icon={<RotateCcw className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.rotateRight")} disabled={status !== "ready"} onClick={() => viewRef.current?.rotate(Math.PI / 12)} icon={<RotateCw className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.scaleDown")} disabled={status !== "ready"} onClick={() => viewRef.current?.scaleBy(0.9)} icon={<Minus className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.scaleUp")} disabled={status !== "ready"} onClick={() => viewRef.current?.scaleBy(1.1)} icon={<Plus className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.lower")} disabled={status !== "ready"} onClick={() => viewRef.current?.raise(-0.05)} icon={<ArrowDown className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.raise")} disabled={status !== "ready"} onClick={() => viewRef.current?.raise(0.05)} icon={<ArrowUp className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.reset")} disabled={status !== "ready"} onClick={() => viewRef.current?.reset()} icon={<RotateCcw className="size-3.5" />} />
                <ToolButton label={t("canvas.model3d.removeCharacter")} disabled={status !== "ready"} onClick={() => viewRef.current?.removeSelected()} icon={<Trash2 className="size-3.5" />} />
            </div>
        </div>
    );
}

function ToolButton({ label, icon, onClick, disabled, accent }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; accent?: boolean }) {
    return (
        <button
            type="button"
            title={label}
            disabled={disabled}
            className="inline-flex h-7 items-center justify-center rounded-md px-2 text-[11px] backdrop-blur disabled:opacity-40"
            style={{ background: accent ? "rgba(240,248,255,.16)" : "rgba(0,0,0,0.45)", color: "#e2e8f0" }}
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
