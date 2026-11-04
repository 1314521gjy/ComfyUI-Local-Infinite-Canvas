import type { ReactNode } from "react";
import { Check, Hand, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { canvasThemes } from "@/lib/canvas-theme";
import type { AgentPermissionMode } from "@/stores/use-agent-store";

type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function AgentPermissionsView({
    theme,
    permissionMode,
    confirmTools,
    onPermissionModeChange,
    onConfirmToolsChange,
}: {
    theme: Theme;
    permissionMode: AgentPermissionMode;
    confirmTools: boolean;
    onPermissionModeChange: (mode: AgentPermissionMode) => void;
    onConfirmToolsChange: (confirmTools: boolean) => void;
}) {
    const { t } = useTranslation();
    const permissionOptions: Array<{ key: AgentPermissionMode; title: string; description: string; icon: ReactNode }> = [
        { key: "request", title: t("agent.composer.permission.request"), description: t("agent.composer.permission.requestDescription"), icon: <ShieldAlert className="size-4" /> },
        { key: "automatic", title: t("agent.composer.permission.automatic"), description: t("agent.composer.permission.automaticDescription"), icon: <ShieldCheck className="size-4" /> },
        { key: "full", title: t("agent.composer.permission.full"), description: t("agent.composer.permission.fullDescription"), icon: <ShieldOff className="size-4" /> },
    ];
    const toolOptions = [
        { key: true, title: t("agent.composer.tools.manual"), description: t("agent.composer.tools.manualDescription"), icon: <Hand className="size-4" /> },
        { key: false, title: t("agent.composer.tools.automatic"), description: t("agent.composer.tools.automaticDescription"), icon: <RefreshCw className="size-4" /> },
    ];
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">{t("agent.permissions.title")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.permissions.description")}</div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="text-sm font-medium leading-5">{t("agent.permissions.systemTitle")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.permissions.systemDescription")}</div>
                    <div className="mt-3 grid gap-2">
                        {permissionOptions.map((option) => {
                            const selected = permissionMode === option.key;
                            return (
                                <button
                                    key={option.key}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition"
                                    style={{ borderColor: selected ? theme.node.muted : theme.node.stroke, background: selected ? theme.toolbar.activeBg : "transparent", color: selected ? theme.toolbar.activeText : theme.node.text }}
                                    onClick={() => onPermissionModeChange(option.key)}
                                >
                                    <span className="mt-0.5 shrink-0">{option.icon}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium">{option.title}</span>
                                        <span className="mt-0.5 block text-xs leading-5 opacity-60">{option.description}</span>
                                    </span>
                                    {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="text-sm font-medium leading-5">{t("agent.permissions.canvasTitle")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.permissions.canvasDescription")}</div>
                    <div className="mt-3 grid gap-2">
                        {toolOptions.map((option) => {
                            const selected = confirmTools === option.key;
                            return (
                                <button
                                    key={String(option.key)}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition"
                                    style={{ borderColor: selected ? theme.node.muted : theme.node.stroke, background: selected ? theme.toolbar.activeBg : "transparent", color: selected ? theme.toolbar.activeText : theme.node.text }}
                                    onClick={() => onConfirmToolsChange(option.key)}
                                >
                                    <span className="mt-0.5 shrink-0">{option.icon}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium">{option.title}</span>
                                        <span className="mt-0.5 block text-xs leading-5 opacity-60">{option.description}</span>
                                    </span>
                                    {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="rounded-lg border px-3 py-2.5 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                    {t("agent.permissions.note")}
                </div>
            </div>
        </div>
    );
}
