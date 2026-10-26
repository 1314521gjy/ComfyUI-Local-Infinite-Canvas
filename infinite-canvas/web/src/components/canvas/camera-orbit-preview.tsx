import { useEffect, useRef } from "react";

import { CameraWidget } from "./camera-orbit-widget";
import type { CanvasImageAngleParams } from "./canvas-node-angle-dialog";

type CameraOrbitPreviewProps = {
    dataUrl: string;
    params: CanvasImageAngleParams;
    onChange: (params: CanvasImageAngleParams) => void;
};

const clampDistance = (value: number) => Math.min(10, Math.max(1, value));

export function CameraOrbitPreview({ dataUrl, params, onChange }: CameraOrbitPreviewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetRef = useRef<CameraWidget | null>(null);
    const paramsRef = useRef(params);
    const onChangeRef = useRef(onChange);
    paramsRef.current = params;
    onChangeRef.current = onChange;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren();
        const initial = paramsRef.current;
        const widget = new CameraWidget({
            container,
            initialState: {
                azimuth: initial.horizontalAngle,
                elevation: initial.pitchAngle,
                distance: 10 - initial.cameraDistance,
            },
            onStateChange: (state) => {
                const current = paramsRef.current;
                const next: CanvasImageAngleParams = {
                    horizontalAngle: ((state.azimuth % 360) + 360) % 360,
                    pitchAngle: Math.round(state.elevation),
                    cameraDistance: clampDistance(Math.round((10 - state.distance) * 10) / 10),
                    wideAngle: current.wideAngle,
                };
                if (
                    Math.abs(next.horizontalAngle - current.horizontalAngle) < 0.01 &&
                    Math.abs(next.pitchAngle - current.pitchAngle) < 0.01 &&
                    Math.abs(next.cameraDistance - current.cameraDistance) < 0.01
                ) {
                    return;
                }
                onChangeRef.current(next);
            },
        });
        widgetRef.current = widget;
        widget.updateImage(dataUrl);
        return () => {
            widget.dispose();
            widgetRef.current = null;
            container.replaceChildren();
        };
    }, [dataUrl]);

    useEffect(() => {
        const widget = widgetRef.current;
        if (!widget) return;
        const state = widget.getState();
        const azimuth = params.horizontalAngle;
        const elevation = params.pitchAngle;
        const distance = 10 - params.cameraDistance;
        if (
            Math.abs(state.azimuth - azimuth) > 0.01 ||
            Math.abs(state.elevation - elevation) > 0.01 ||
            Math.abs(state.distance - distance) > 0.01
        ) {
            widget.setState({ azimuth, elevation, distance });
        }
    }, [params.horizontalAngle, params.pitchAngle, params.cameraDistance]);

    return <div className="relative min-h-[340px] w-full flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />
    </div>;
}
