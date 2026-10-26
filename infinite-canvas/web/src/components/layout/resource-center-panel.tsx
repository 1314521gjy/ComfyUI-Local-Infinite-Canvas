import { App, Button, Checkbox, Progress, Tag } from "antd";
import { AlertTriangle, CheckCircle2, Download, HardDriveDownload, RefreshCw, Server, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    cancelResourceJob,
    fetchResourceJob,
    fetchResourceStatus,
    formatBytes,
    installResources,
    refreshResourceStatus,
    type ResourceItem,
    type ResourceJob,
    type ResourcePack,
    type ResourceStatus,
} from "@/services/api/resources";

const copyByLocale = {
    zh: {
        title: "资源中心",
        subtitle: "只下载缺失的资源；已有同名模型会直接复用，不会重复下载。",
        refresh: "重新扫描",
        installSelected: "安装选中",
        installAllMissing: "安装全部缺失",
        cancel: "取消安装",
        skip: "跳过",
        none: "未找到资源索引",
        comfyRoot: "ComfyUI",
        indexVersion: "资源索引",
        present: "已具备",
        missing: "缺少",
        blocked: "待前置资源",
        planned: "后续包",
        ready: "已齐全",
        size: "下载体积",
        sources: "下载源",
        localBake: "本地烘焙",
        noResources: "此包没有需要下载的资源。",
        downloadProgress: "安装进度",
        done: "安装完成",
        failed: "部分资源安装失败",
        notReachable: "ComfyUI 当前未连接，资源状态可能不准确。",
        indexError: "资源索引读取失败，当前使用内置清单。",
        selectHint: "选择需要安装的功能包；已具备的资源会自动跳过。",
        target: "目标",
        license: "许可",
        note: "说明",
        emptyMissing: "所有需要的资源都已具备。",
        scanFirst: "正在读取资源状态…",
    },
    en: {
        title: "Resource Center",
        subtitle: "Only missing files are downloaded. Existing models with the same name are reused.",
        refresh: "Rescan",
        installSelected: "Install selected",
        installAllMissing: "Install all missing",
        cancel: "Cancel",
        skip: "Skip",
        none: "No resource index found",
        comfyRoot: "ComfyUI",
        indexVersion: "Index",
        present: "Ready",
        missing: "Missing",
        blocked: "Waiting",
        planned: "Planned",
        ready: "Ready",
        size: "Download size",
        sources: "Sources",
        localBake: "Local bake",
        noResources: "This pack has no downloadable resources.",
        downloadProgress: "Install progress",
        done: "Install complete",
        failed: "Some resources failed",
        notReachable: "ComfyUI is not reachable; resource status may be stale.",
        indexError: "Failed to load the resource index; using the bundled manifest.",
        selectHint: "Select the packs to install; existing resources are skipped.",
        target: "Target",
        license: "License",
        note: "Note",
        emptyMissing: "All required resources are ready.",
        scanFirst: "Loading resources…",
    },
};

function statusTag(item: ResourceItem, copy: typeof copyByLocale.zh) {
    if (item.status === "present") return <Tag color="green">{copy.present}</Tag>;
    if (item.status === "blocked") return <Tag color="gold">{copy.blocked}</Tag>;
    return <Tag color="orange">{copy.missing}</Tag>;
}

function packState(pack: ResourcePack, copy: typeof copyByLocale.zh) {
    if (pack.planned) return <Tag>{copy.planned}</Tag>;
    if (!pack.total) return <Tag color="green">{copy.ready}</Tag>;
    if (!pack.missing) return <Tag color="green">{copy.ready}</Tag>;
    return <Tag color="orange">{copy.missing} {pack.missing}</Tag>;
}

export function ResourceCenterPanel({ compact = false, footer }: { compact?: boolean; footer?: React.ReactNode }) {
    const { message } = App.useApp();
    const { i18n } = useTranslation();
    const copy = i18n.language.startsWith("zh") ? copyByLocale.zh : copyByLocale.en;
    const [status, setStatus] = useState<ResourceStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [job, setJob] = useState<ResourceJob | null>(null);
    const [selectedPacks, setSelectedPacks] = useState<Set<string>>(new Set());
    const pollRef = useRef<number | null>(null);
    const selectedInitialized = useRef(false);

    const stopPolling = useCallback(() => {
        if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const applyStatus = useCallback((next: ResourceStatus) => {
        setStatus(next);
        if (!selectedInitialized.current) {
            const initial = next.packs.filter((pack) => !pack.planned && pack.missing > 0).map((pack) => pack.id);
            setSelectedPacks(new Set(initial));
            selectedInitialized.current = true;
        }
    }, []);

    const load = useCallback(async (refresh = false) => {
        setError("");
        if (refresh) setRefreshing(true);
        else setLoading(true);
        try {
            const next = refresh ? await refreshResourceStatus() : await fetchResourceStatus();
            applyStatus(next);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [applyStatus]);

    useEffect(() => {
        void load();
        return () => stopPolling();
    }, [load, stopPolling]);

    const watchJob = useCallback((initial: ResourceJob) => {
        stopPolling();
        setJob(initial);
        const tick = async () => {
            try {
                const next = await fetchResourceJob(initial.id);
                setJob(next);
                if (["done", "error", "canceled"].includes(next.status)) {
                    stopPolling();
                    if (next.status === "done") message.success(copy.done);
                    else if (next.status === "error") message.error(next.message || copy.failed);
                    await load(true);
                }
            } catch (pollError) {
                stopPolling();
                setError(pollError instanceof Error ? pollError.message : String(pollError));
            }
        };
        pollRef.current = window.setInterval(() => void tick(), 900);
        void tick();
    }, [copy.done, copy.failed, load, message, stopPolling]);

    const startInstall = async (packs: string[]) => {
        if (!packs.length) {
            message.info(copy.emptyMissing);
            return;
        }
        try {
            const next = await installResources({ packs });
            watchJob(next);
        } catch (installError) {
            message.error(installError instanceof Error ? installError.message : String(installError));
        }
    };

    const missingIds = useMemo(() => status?.resources.filter((item) => item.status !== "present").map((item) => item.id) || [], [status]);
    const missingPacks = useMemo(() => status?.packs.filter((pack) => !pack.planned && pack.missing > 0) || [], [status]);
    const selectedMissingPacks = useMemo(() => {
        if (!status) return [];
        return status.packs.filter((pack) => selectedPacks.has(pack.id) && !pack.planned && pack.missing > 0).map((pack) => pack.id);
    }, [selectedPacks, status]);

    const togglePack = (id: string, checked: boolean) => {
        setSelectedPacks((current) => {
            const next = new Set(current);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    if (loading && !status) {
        return <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-stone-200 p-8 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400"><RefreshCw className="size-4 animate-spin" />{copy.scanFirst}</div>;
    }

    return (
        <div className="space-y-3">
            <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-white/[.03]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <HardDriveDownload className="size-4" />
                            {copy.title}
                        </div>
                        <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.subtitle}</div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400">
                            <span className="inline-flex items-center gap-1"><Server className="size-3" />{copy.comfyRoot}: {status?.comfyRoot || "—"}</span>
                            <span>{copy.indexVersion}: {status?.indexVersion || "—"}</span>
                            <span>{copy.present}: {status?.summary.present || 0}/{status?.summary.resources || 0}</span>
                            <span>{copy.missing}: {status?.summary.missing || 0}</span>
                            {status?.summary.missingSize ? <span>{copy.size}: {formatBytes(status.summary.missingSize)}</span> : null}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />} loading={refreshing} onClick={() => void load(true)}>
                            {copy.refresh}
                        </Button>
                        <Button size="small" type="primary" icon={<Download className="size-3.5" />} disabled={!selectedMissingPacks.length || Boolean(job && ["running"].includes(job.status))} onClick={() => void startInstall(selectedMissingPacks)}>
                            {copy.installSelected}
                        </Button>
                    </div>
                </div>
                {status?.comfyRoot && !status.comfyReachable ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.notReachable}</div> : null}
                {status?.indexError ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.indexError}</div> : null}
            </div>

            {error ? <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"><XCircle className="size-3.5 shrink-0" />{error}</div> : null}

            {job ? (
                <div className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium">{copy.downloadProgress}</span>
                        <span className="text-stone-500 dark:text-stone-400">{job.message || job.status}</span>
                    </div>
                    <Progress percent={job.progress} size="small" status={job.status === "error" ? "exception" : job.status === "done" ? "success" : "active"} />
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto text-[11px]">
                        {job.items.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-stone-600 dark:text-stone-300">{item.label}</span>
                                <span className={item.status === "error" ? "shrink-0 text-red-500" : "shrink-0 text-stone-400 dark:text-stone-500"}>
                                    {item.status === "downloading" ? `${formatBytes(item.bytes)} / ${formatBytes(item.size)}` : item.status === "baking" ? copy.localBake : item.status}
                                </span>
                            </div>
                        ))}
                    </div>
                    {job.status === "running" ? (
                        <div className="mt-2 flex justify-end">
                            <Button size="small" onClick={() => { void cancelResourceJob(job.id).then(setJob).catch(() => undefined); }}>{copy.cancel}</Button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="space-y-2">
                {(status?.packs || []).map((pack) => (
                    <div key={pack.id} className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-start gap-2">
                            {!pack.planned && pack.total > 0 ? (
                                <Checkbox checked={selectedPacks.has(pack.id)} disabled={!pack.missing} onChange={(event) => togglePack(pack.id, event.target.checked)} />
                            ) : (
                                <span className="mt-0.5 grid size-4 place-items-center text-stone-300 dark:text-stone-600">·</span>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{pack.label}</span>
                                    {packState(pack, copy)}
                                    {pack.missingSize ? <span className="text-[11px] text-stone-500 dark:text-stone-400">{copy.size} {formatBytes(pack.missingSize)}</span> : null}
                                    {pack.minVramGb ? <span className="text-[11px] text-stone-400 dark:text-stone-500">≥ {pack.minVramGb}GB VRAM</span> : null}
                                </div>
                                <div className="mt-0.5 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{pack.description}</div>
                                {!pack.total ? <div className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">{copy.noResources}</div> : null}
                                {pack.missing > 0 ? (
                                    <div className="mt-2 flex justify-end">
                                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void startInstall([pack.id])} disabled={Boolean(job && job.status === "running")}>
                                            {copy.installSelected}
                                        </Button>
                                    </div>
                                ) : null}
                                {!compact && pack.resources.length ? (
                                    <div className="mt-2 space-y-1 border-t border-stone-100 pt-2 dark:border-stone-800/70">
                                        {pack.resources.map((item) => (
                                            <div key={item.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
                                                <div className="min-w-0">
                                                    <span className="font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                                                    <span className="ml-2 text-stone-400 dark:text-stone-500">{item.target}</span>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-2">
                                                    {item.type === "bake" ? <Tag>{copy.localBake}</Tag> : <span className="text-stone-400 dark:text-stone-500">{copy.sources} {item.sources.length}</span>}
                                                    <span className="text-stone-400 dark:text-stone-500">{formatBytes(item.size)}</span>
                                                    {item.status === "present" ? <CheckCircle2 className="size-3.5 text-green-600 dark:text-green-400" /> : null}
                                                    {statusTag(item, copy)}
                                                </div>
                                                {item.note ? <div className="w-full text-stone-400 dark:text-stone-500">{copy.note}: {item.note}</div> : null}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {missingIds.length === 0 && status?.summary.resources ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300">
                    <CheckCircle2 className="size-4" />{copy.emptyMissing}
                </div>
            ) : null}
            {footer}
        </div>
    );
}
