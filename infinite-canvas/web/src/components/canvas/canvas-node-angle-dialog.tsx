import { useEffect, useState } from "react";
import { Button, Modal, Segmented, Slider } from "antd";
import { RotateCcw, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CameraOrbitPreview } from "./camera-orbit-preview";

export type CanvasImageAngleParams = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

const defaultParams: CanvasImageAngleParams = {
    horizontalAngle: 0,
    pitchAngle: 9,
    cameraDistance: 4.8,
    wideAngle: false,
};

export function CanvasNodeAngleDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageAngleParams) => void }) {
    const { t } = useTranslation();
    const [params, setParams] = useState(defaultParams);

    useEffect(() => {
        if (open) setParams(defaultParams);
    }, [dataUrl, open]);

    const update = <Key extends keyof CanvasImageAngleParams>(key: Key, value: CanvasImageAngleParams[Key]) => setParams((current) => ({ ...current, [key]: value }));

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1000} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.angleTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.angleDescription")}</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(380px,1fr)_360px]">
                    <div className="flex min-h-[380px] flex-col overflow-hidden rounded-xl border">
                        <CameraOrbitPreview dataUrl={dataUrl} params={params} onChange={setParams} />
                        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-black/10 px-3 py-2 dark:border-white/10">
                            <Button size="small" className="w-fit" icon={<RotateCcw className="size-4" />} onClick={() => setParams(defaultParams)}>
                                {t("canvas.editors.reset")}
                            </Button>
                            <span className="text-[11px] opacity-50">{t("canvas.editors.orbitHint")}</span>
                        </div>
                    </div>
                    <div className="space-y-6 py-2">
                        <AngleSlider label={t("canvas.editors.horizontal")} value={params.horizontalAngle} min={0} max={360} step={1} suffix="deg" onChange={(value) => update("horizontalAngle", value)} />
                        <AngleSlider label={t("canvas.editors.pitch")} value={params.pitchAngle} min={-30} max={60} step={1} suffix="deg" onChange={(value) => update("pitchAngle", value)} />
                        <AngleSlider label={t("canvas.editors.distance")} value={params.cameraDistance} min={1} max={10} step={0.1} onChange={(value) => update("cameraDistance", value)} />
                        <div className="grid grid-cols-[88px_1fr_72px] items-center gap-4">
                            <span className="font-medium opacity-75">{t("canvas.editors.lens")}</span>
                            <Segmented
                                className="w-fit"
                                value={params.wideAngle ? "wide" : "standard"}
                                options={[
                                    { label: t("canvas.editors.standard"), value: "standard" },
                                    { label: t("canvas.editors.wide"), value: "wide" },
                                ]}
                                onChange={(value) => update("wideAngle", value === "wide")}
                            />
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<WandSparkles className="size-4" />} onClick={() => onConfirm(params)}>
                        {t("canvas.editors.aiGenerate")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function AngleSlider({ label, value, min, max, step, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
    return (
        <div className="grid grid-cols-[88px_1fr_72px] items-center gap-4">
            <span className="font-medium opacity-75">{label}</span>
            <Slider min={min} max={max} step={step} value={value} onChange={onChange} />
            <span className="whitespace-nowrap text-right font-semibold">
                {Number.isInteger(value) ? value : value.toFixed(1)}
                {suffix}
            </span>
        </div>
    );
}
