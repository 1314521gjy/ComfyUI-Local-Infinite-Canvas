import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Spin } from "antd";
import { Gauge } from "lucide-react";

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type GpuStats = {
    index: number;
    name: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    utilization: number;
    temperature: number;
};

type SystemStats = {
    at: string;
    gpu: GpuStats[];
    gpuError?: string | null;
    gpuStale?: boolean;
    ram: { totalBytes: number; usedBytes: number; freeBytes: number };
    comfy: { url: string; reachable: boolean };
    restartAvailable: boolean;
    lastOOM: { at: string; message: string } | null;
};

type RestartStep = { name: string; durationMs?: number; url?: string; freedMb?: number; ok?: boolean };
type RestartResult = {
    ok: boolean;
    freedMb?: number;
    durationMs?: number;
    comfyUrl?: string;
    steps?: RestartStep[];
    before?: Pick<SystemStats, "gpu" | "ram">;
    afterKill?: Pick<SystemStats, "gpu" | "ram">;
    afterStart?: Pick<SystemStats, "gpu" | "ram">;
    error?: string;
};

type FreeResult = {
    ok: boolean;
    freedVramMb?: number;
    freedRamBytes?: number;
    durationMs?: number;
    error?: string;
};

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

function gb(bytes: number) {
    return (bytes / 1024 ** 3).toFixed(1);
}

function vramGb(mb: number) {
    return (mb / 1024).toFixed(1);
}

function percent(used: number, total: number) {
    return total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
}

export function CanvasSystemStatus() {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [open, setOpen] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [restartResult, setRestartResult] = useState<RestartResult | null>(null);
    const [restartError, setRestartError] = useState("");
    const [freeing, setFreeing] = useState(false);
    const [freeResult, setFreeResult] = useState<FreeResult | null>(null);
    const [freeError, setFreeError] = useState("");

    const refresh = useCallback(async () => {
        try {
            const response = await fetch(`${gatewayRoot}/api/system/stats`);
            if (!response.ok) return;
            setStats(await response.json());
        } catch {
            /* 网关未就绪时保留上一次数据 */
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => {
            if (document.visibilityState !== "hidden") void refresh();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
        if (!open) setConfirming(false);
    }, [open]);

    const gpu = stats?.gpu?.[0];
    const vramPercent = gpu ? percent(gpu.memoryUsedMb, gpu.memoryTotalMb) : 0;
    const ramPercent = stats ? percent(stats.ram.usedBytes, stats.ram.totalBytes) : 0;
    const oom = stats?.lastOOM;

    const freeMemory = async () => {
        setFreeing(true);
        setFreeError("");
        setFreeResult(null);
        try {
            const response = await fetch(`${gatewayRoot}/api/system/free-memory`, { method: "POST" });
            const data = (await response.json().catch(() => ({}))) as FreeResult;
            if (!response.ok || data.ok === false) throw new Error(data.error || "清理显存失败");
            setFreeResult(data);
            await refresh();
        } catch (error) {
            setFreeError(error instanceof Error ? error.message : String(error));
        } finally {
            setFreeing(false);
        }
    };

    const restart = async () => {
        setRestarting(true);
        setRestartError("");
        setRestartResult(null);
        try {
            const response = await fetch(`${gatewayRoot}/api/system/restart-comfy`, { method: "POST" });
            const data = (await response.json().catch(() => ({}))) as RestartResult;
            if (!response.ok || data.ok === false) throw new Error(data.error || "重启 ComfyUI 失败");
            setRestartResult(data);
            setConfirming(false);
            await refresh();
        } catch (error) {
            setRestartError(error instanceof Error ? error.message : String(error));
        } finally {
            setRestarting(false);
        }
    };

    const barStyle = (value: number) => ({ width: `${value}%`, background: value >= 90 ? "#dc2626" : theme.node.text });

    return (
        <>
            <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.node.muted, background: "transparent" }}
                title="查看显存、内存与 ComfyUI 状态"
                onClick={() => setOpen(true)}
            >
                <Gauge className="size-3.5" />
                <span>{gpu ? `显存 ${vramGb(gpu.memoryUsedMb)}/${vramGb(gpu.memoryTotalMb)}G` : "显存 --"}</span>
                <span className="hidden opacity-40 lg:inline">·</span>
                <span className="hidden lg:inline">内存 {stats ? `${gb(stats.ram.usedBytes)}/${gb(stats.ram.totalBytes)}G` : "--"}</span>
                {oom ? <span className="size-1.5 rounded-full" style={{ background: "#dc2626" }} title="最近发生过 OOM" /> : null}
            </button>
            <Modal title="系统资源" open={open} onCancel={() => setOpen(false)} footer={null} centered width={440} destroyOnHidden>
                <div className="space-y-4 pt-1 text-sm" style={{ color: theme.node.text }}>
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                            <span>显存</span>
                            <span>{gpu ? `${vramGb(gpu.memoryUsedMb)} / ${vramGb(gpu.memoryTotalMb)} GB` : "--"}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: theme.node.fill }}>
                            <div className="h-full rounded-full transition-[width]" style={barStyle(vramPercent)} />
                        </div>
                        {gpu ? (
                            <div className="flex items-center justify-between text-[11px]" style={{ color: theme.node.faint }}>
                                <span className="truncate">{gpu.name}{stats.gpuStale ? "（读取超时，显示上次读数）" : ""}</span>
                                <span>
                                    利用率 {gpu.utilization}% · {gpu.temperature}°C
                                </span>
                            </div>
                        ) : (
                            <div className="text-[11px]" style={{ color: theme.node.faint }}>
                                {stats?.gpuError ? `显存信息不可用：${stats.gpuError}` : "显存信息读取中…"}
                            </div>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                            <span>内存</span>
                            <span>{stats ? `${gb(stats.ram.usedBytes)} / ${gb(stats.ram.totalBytes)} GB` : "--"}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: theme.node.fill }}>
                            <div className="h-full rounded-full transition-[width]" style={barStyle(ramPercent)} />
                        </div>
                    </div>
                    <div className="flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                        <span>ComfyUI</span>
                        <span style={{ color: stats?.comfy.reachable ? theme.node.text : "#dc2626" }}>{stats?.comfy.reachable ? "在线" : "离线"}</span>
                    </div>
                    {oom ? (
                        <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: "#fca5a5", color: "#b91c1c" }}>
                            最近一次 OOM：{oom.message}
                        </div>
                    ) : null}
                    <div className="border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        {restarting ? (
                            <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                                <Spin size="small" />
                                <span>正在强制停止 ComfyUI、检测显存并重新拉起，通常需要 20–90 秒…</span>
                            </div>
                        ) : confirming ? (
                            <div className="space-y-2">
                                <div className="text-xs" style={{ color: theme.node.muted }}>
                                    会强制结束 ComfyUI 进程，确认显存释放后重新启动。当前任务会中断，是否继续？
                                </div>
                                <div className="flex justify-end gap-2">
                                    <Button size="small" onClick={() => setConfirming(false)}>
                                        取消
                                    </Button>
                                    <Button size="small" danger type="primary" onClick={() => void restart()}>
                                        确认重启
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-start justify-between gap-3">
                                    <span className="text-[11px]" style={{ color: theme.node.faint }}>
                                        显存紧张时先清理模型缓存；清理不会停止 ComfyUI 进程。
                                    </span>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <Button
                                            size="small"
                                            loading={freeing}
                                            disabled={!stats?.comfy.reachable || restarting}
                                            onClick={() => void freeMemory()}
                                            style={{ background: "#16a34a", borderColor: "#16a34a", color: "#fff" }}
                                        >
                                            清理显存内存
                                        </Button>
                                        <Button size="small" danger disabled={freeing || !stats?.restartAvailable} onClick={() => setConfirming(true)}>
                                            一键重启 ComfyUI
                                        </Button>
                                    </div>
                                </div>
                                {freeing ? (
                                    <div className="flex items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                                        <Spin size="small" />
                                        <span>正在卸载模型并释放显存缓存…</span>
                                    </div>
                                ) : null}
                                {freeResult?.ok ? (
                                    <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                        已清理：释放显存 {freeResult.freedVramMb || 0} MB · 内存 {gb(freeResult.freedRamBytes || 0)} GB，用时 {Math.round((freeResult.durationMs || 0) / 1000)} 秒（进程未停止）。
                                    </div>
                                ) : null}
                                {freeError ? (
                                    <div className="text-[11px]" style={{ color: "#b91c1c" }}>
                                        {freeError}
                                    </div>
                                ) : null}
                                {stats && !stats.restartAvailable ? (
                                    <div className="text-[11px]" style={{ color: theme.node.faint }}>
                                        启动器控制接口未连接；重启不可用，但仍可清理模型缓存。
                                    </div>
                                ) : null}
                                {restartResult?.ok ? (
                                    <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                        已完成：释放显存 {restartResult.freedMb || 0} MB，用时 {Math.round((restartResult.durationMs || 0) / 1000)} 秒。
                                        {restartResult.before && restartResult.afterKill ? (
                                            <div className="mt-0.5">
                                                显存 {vramGb(restartResult.before.gpu?.[0]?.memoryUsedMb || 0)} → {vramGb(restartResult.afterKill.gpu?.[0]?.memoryUsedMb || 0)} GB · 内存 {gb(restartResult.before.ram.usedBytes)} → {gb(restartResult.afterKill.ram.usedBytes)} GB
                                            </div>
                                        ) : null}
                                        {restartResult.steps?.length ? (
                                            <div className="mt-1 space-y-0.5">
                                                {restartResult.steps.map((step) => (
                                                    <div key={step.name}>
                                                        {step.name}
                                                        {typeof step.durationMs === "number" ? ` · ${Math.round(step.durationMs / 1000)}s` : ""}
                                                        {step.url ? ` · ${step.url}` : ""}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                                {restartError ? (
                                    <div className="text-[11px]" style={{ color: "#b91c1c" }}>
                                        {restartError}
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
        </>
    );
}
