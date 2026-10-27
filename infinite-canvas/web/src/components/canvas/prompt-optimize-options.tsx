import { Button } from "antd";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";

export type PromptOptimizeEngine = "local" | "cloud";
export type PromptOptimizeLanguage = "zh" | "en";

type PromptOptimizeOptionsProps = {
    engine: PromptOptimizeEngine;
    language: PromptOptimizeLanguage;
    cloudReady: boolean;
    cloudModel?: string;
    title?: string;
    disabled?: boolean;
    className?: string;
    onEngineChange: (engine: PromptOptimizeEngine) => void;
    onLanguageChange: (language: PromptOptimizeLanguage) => void;
    onOpenSettings: () => void;
    onStart: () => void;
    onClose: () => void;
};

export function PromptOptimizeOptions({
    engine,
    language,
    cloudReady,
    cloudModel,
    title,
    disabled = false,
    className = "",
    onEngineChange,
    onLanguageChange,
    onOpenSettings,
    onStart,
    onClose,
}: PromptOptimizeOptionsProps) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    return (
        <div
            className={`space-y-2 rounded-xl border p-2 ${className}`}
            style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{title || t("canvas.promptPanel.optimizeOptions")}</span>
                <Button
                    type="text"
                    size="small"
                    className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                    icon={<X className="size-3.5" />}
                    onClick={onClose}
                    aria-label={t("canvas.promptPanel.optimizeClose")}
                />
            </div>
            <div>
                <div className="mb-1 text-[11px] opacity-70">{t("canvas.promptPanel.optimizeEngine")}</div>
                <div className="grid grid-cols-2 gap-2">
                    <Button size="small" type={engine === "local" ? "primary" : "default"} onClick={() => onEngineChange("local")}>
                        {t("canvas.promptPanel.optimizeEngineLocal")}
                    </Button>
                    <Button size="small" type={engine === "cloud" ? "primary" : "default"} onClick={() => onEngineChange("cloud")}>
                        {t("canvas.promptPanel.optimizeEngineCloud")}
                    </Button>
                </div>
                {engine === "cloud" ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] opacity-70">
                        <span className="min-w-0 truncate">
                            {cloudReady
                                ? t("canvas.promptPanel.optimizeCloudReady", { model: cloudModel || "" })
                                : t("canvas.promptPanel.optimizeCloudMissing")}
                        </span>
                        {!cloudReady ? (
                            <Button size="small" className="shrink-0" onClick={onOpenSettings}>
                                {t("canvas.promptPanel.optimizeOpenSettings")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div>
                <div className="mb-1 text-[11px] opacity-70">{t("canvas.promptPanel.optimizeLanguage")}</div>
                <div className="grid grid-cols-2 gap-2">
                    <Button size="small" type={language === "zh" ? "primary" : "default"} onClick={() => onLanguageChange("zh")}>
                        {t("canvas.promptPanel.optimizeLanguageZh")}
                    </Button>
                    <Button size="small" type={language === "en" ? "primary" : "default"} onClick={() => onLanguageChange("en")}>
                        {t("canvas.promptPanel.optimizeLanguageEn")}
                    </Button>
                </div>
            </div>
            <div className="flex justify-end gap-2">
                <Button size="small" onClick={onClose}>
                    {t("canvas.promptPanel.optimizeClose")}
                </Button>
                <Button size="small" type="primary" disabled={disabled || (engine === "cloud" && !cloudReady)} onClick={onStart}>
                    {t("canvas.promptPanel.optimizeStart")}
                </Button>
            </div>
        </div>
    );
}
