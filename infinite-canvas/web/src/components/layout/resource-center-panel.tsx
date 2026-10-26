import { App, Button, Checkbox, Progress, Tag } from "antd";
import { AlertTriangle, CheckCircle2, ChevronDown, Download, HardDriveDownload, RefreshCw, Server, XCircle } from "lucide-react";
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
        title: "添加工作流",
        subtitle: "只下载缺失的资源；已有同名模型会直接复用，不会重复下载。",
        refresh: "重新扫描",
        installSelected: "安装选中",
        installPack: "安装此包",
        cancel: "终止安装",
        skip: "跳过",
        none: "未找到资源索引",
        comfyRoot: "ComfyUI",
        indexVersion: "资源索引",
        present: "已具备",
        missing: "缺少",
        recommended: "推荐",
        optional: "可选",
        offload: "内存卸载",
        showAll: "显示其他版本",
        hideAll: "收起其他版本",
        requiredSection: "必下内容",
        optionalSection: "选下内容",
        workflowSection: "工作流",
        workflowHint: "按工作流安装；资源齐备后才会出现在模型选择",
        installWorkflow: "安装此工作流",
        workflowReady: "可用",
        workflowRestart: "待重启",
        plugin: "插件",
        bakeRequires: "本地烘焙，依赖",
        optionalHint: "LoRA、低显存底模等，按需安装",
        optionalEmpty: "此包没有选下内容",
        optionalMissingLabel: "选下缺",
        hardwareDetected: "已识别",
        noHardware: "未识别到显卡，已显示全部版本，未做推荐。",
        noCompatible: "当前显卡暂无可推荐的版本，可展开查看全部。",
        incompatible: "不适用",
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
        emptyMissing: "所有必下资源都已具备。",
        scanFirst: "正在读取资源状态…",
        expand: "展开",
        collapse: "收起",
    },
    en: {
        title: "Add workflows",
        subtitle: "Only missing files are downloaded. Existing models with the same name are reused.",
        refresh: "Rescan",
        installSelected: "Install selected",
        installPack: "Install pack",
        cancel: "Stop install",
        skip: "Skip",
        none: "No resource index found",
        comfyRoot: "ComfyUI",
        indexVersion: "Index",
        present: "Ready",
        missing: "Missing",
        recommended: "Recommended",
        optional: "Optional",
        offload: "Memory offload",
        showAll: "Show other versions",
        hideAll: "Hide other versions",
        requiredSection: "Required",
        optionalSection: "Optional",
        workflowSection: "Workflows",
        workflowHint: "Install by workflow; only complete workflows appear in the model picker",
        installWorkflow: "Install workflow",
        workflowReady: "Ready",
        workflowRestart: "Restart needed",
        plugin: "Plugin",
        bakeRequires: "Local bake requires",
        optionalHint: "LoRAs, low-VRAM checkpoints, and other extras",
        optionalEmpty: "No optional items in this pack",
        optionalMissingLabel: "Optional missing",
        hardwareDetected: "Detected",
        noHardware: "No GPU detected; showing all versions without recommendations.",
        noCompatible: "No recommended version for this GPU; expand to see all.",
        incompatible: "Not suitable",
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
        expand: "Expand",
        collapse: "Collapse",
    },
};

type Copy = typeof copyByLocale.zh;

function statusTag(item: ResourceItem, copy: Copy) {
    if (item.status === "present") return <Tag color="green">{copy.present}</Tag>;
    if (item.status === "blocked") return <Tag color="gold">{copy.blocked}</Tag>;
    return <Tag color="orange">{copy.missing}</Tag>;
}

function packState(pack: ResourcePack, copy: Copy) {
    if (pack.planned) return <Tag>{copy.planned}</Tag>;
    if (!pack.total) return <Tag color="green">{copy.ready}</Tag>;
    if (!pack.missing) return <Tag color="green">{copy.ready}</Tag>;
    return <Tag color="orange">{copy.missing} {pack.missing}</Tag>;
}

function formatSpeed(bytesPerSecond: number) {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    return value > 0 ? `${formatBytes(value)}/s` : "";
}

function ResourceCard({
    item,
    copy,
    compact = false,
    optional = false,
    selected = false,
    onToggle,
}: {
    item: ResourceItem;
    copy: Copy;
    compact?: boolean;
    optional?: boolean;
    selected?: boolean;
    onToggle?: (checked: boolean) => void;
}) {
    return (
        <div className="rounded-lg border border-stone-200 bg-white/60 p-2 dark:border-stone-800 dark:bg-white/[.02]">
            <div className="flex items-start gap-2">
                {optional ? (
                    <Checkbox
                        checked={selected}
                        disabled={item.status === "present"}
                        onChange={(event) => onToggle?.(event.target.checked)}
                    />
                ) : (
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-600" />
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[11px] font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                        {item.type === "bake" ? <Tag className="m-0">{copy.localBake}</Tag> : null}
                        {statusTag(item, copy)}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-stone-400 dark:text-stone-500">{item.target}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-stone-400 dark:text-stone-500">
                        <span>{copy.sources} {item.sources.length}</span>
                        <span>{formatBytes(item.size)}</span>
                        {!compact && item.license ? <span>{copy.license}: {item.license}</span> : null}
                    </div>
                    {!compact && item.note ? <div className="mt-0.5 text-[10px] leading-4 text-stone-400 dark:text-stone-500">{copy.note}: {item.note}</div> : null}
                </div>
            </div>
        </div>
    );
}

function WorkflowResourceRow({ item, copy, requires = [] }: { item: ResourceItem; copy: Copy; requires?: ResourceItem[] }) {
    return (
        <div className="flex items-start gap-2 rounded-md px-2 py-1.5">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-600" />
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                    {item.type === "node" ? <Tag className="m-0">{copy.plugin}</Tag> : null}
                    {item.type === "bake" ? <Tag className="m-0">{copy.localBake}</Tag> : null}
                    {statusTag(item, copy)}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-stone-400 dark:text-stone-500">{item.target}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-stone-400 dark:text-stone-500">
                    <span>{copy.sources} {item.sources.length}</span>
                    <span>{formatBytes(item.size)}</span>
                </div>
                {item.type === "bake" && requires.length ? (
                    <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">{copy.bakeRequires}: {requires.map((entry) => entry.label).join(" + ")}</div>
                ) : null}
            </div>
        </div>
    );
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
    const [selectedOptional, setSelectedOptional] = useState<Set<string>>(new Set());
    const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set());
    const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set());
    const [speeds, setSpeeds] = useState<Record<string, number>>({});
    const [stopping, setStopping] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const pollRef = useRef<number | null>(null);
    const selectedInitialized = useRef(false);
    const speedSamples = useRef<Map<string, { bytes: number; time: number; speed: number }>>(new Map());
    const jobPanelRef = useRef<HTMLDivElement | null>(null);

    const stopPolling = useCallback(() => {
        if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const applyStatus = useCallback((next: ResourceStatus) => {
        setStatus(next);
        if (!selectedInitialized.current) {
            const initial = next.packs.filter((pack) => pack.recommended && pack.missing > 0).map((pack) => pack.id);
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

    useEffect(() => {
        if (!status) return;
        const available = new Set(status.resources.filter((item) => item.status !== "present").map((item) => item.id));
        setSelectedOptional((current) => {
            const next = new Set([...current].filter((id) => available.has(id)));
            return next.size === current.size ? current : next;
        });
    }, [status]);

    const watchJob = useCallback((initial: ResourceJob) => {
        stopPolling();
        setJob(initial);
        speedSamples.current.clear();
        setSpeeds({});
        window.requestAnimationFrame(() => jobPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        const tick = async () => {
            try {
                const next = await fetchResourceJob(initial.id);
                const now = Date.now();
                const nextSpeeds: Record<string, number> = {};
                for (const item of next.items) {
                    if (item.status !== "downloading") {
                        speedSamples.current.delete(item.id);
                        continue;
                    }
                    const previous = speedSamples.current.get(item.id);
                    if (previous && now > previous.time && item.bytes >= previous.bytes) {
                        const sample = (item.bytes - previous.bytes) / ((now - previous.time) / 1000);
                        const speed = previous.speed > 0 ? previous.speed * 0.5 + sample * 0.5 : sample;
                        nextSpeeds[item.id] = speed;
                        speedSamples.current.set(item.id, { bytes: item.bytes, time: now, speed });
                    } else {
                        speedSamples.current.set(item.id, { bytes: item.bytes, time: now, speed: 0 });
                    }
                }
                setSpeeds(nextSpeeds);
                setJob(next);
                if (["done", "error", "canceled"].includes(next.status)) {
                    stopPolling();
                    speedSamples.current.clear();
                    setSpeeds({});
                    if (next.status === "done") message.success(copy.done);
                    else if (next.status === "error") message.error(next.message || copy.failed);
                    await load(true);
                    window.dispatchEvent(new Event("local-gateway-refresh-models"));
                }
            } catch (pollError) {
                stopPolling();
                setError(pollError instanceof Error ? pollError.message : String(pollError));
            }
        };
        pollRef.current = window.setInterval(() => void tick(), 900);
        void tick();
    }, [copy.done, copy.failed, load, message, stopPolling]);

    const startInstall = async (input: { ids?: string[]; packs?: string[] }) => {
        if (!input.ids?.length && !input.packs?.length) {
            message.info(copy.emptyMissing);
            return;
        }
        try {
            const next = await installResources(input);
            watchJob(next);
        } catch (installError) {
            message.error(installError instanceof Error ? installError.message : String(installError));
        }
    };

    const stopInstall = async () => {
        if (!job || job.status !== "running" || stopping) return;
        setStopping(true);
        try {
            const next = await cancelResourceJob(job.id);
            setJob(next);
        } catch (stopError) {
            message.error(stopError instanceof Error ? stopError.message : String(stopError));
        } finally {
            setStopping(false);
        }
    };

    const recommendationAvailable = Boolean(status?.recommendationAvailable);
    const hardwareName = status?.hardware?.gpuName || "";
    const recommendedPresent = recommendationAvailable ? status?.summary.recommendedPresent || 0 : status?.summary.present || 0;
    const recommendedTotal = recommendationAvailable ? status?.summary.recommendedResources || 0 : status?.summary.resources || 0;
    const recommendedMissing = recommendationAvailable ? status?.summary.recommendedMissing || 0 : status?.summary.missing || 0;
    const recommendedMissingSize = recommendationAvailable ? status?.summary.recommendedMissingSize || 0 : status?.summary.missingSize || 0;
    const visiblePacks = showAll || !recommendationAvailable
        ? status?.packs || []
        : (status?.packs || []).filter((pack) => pack.recommended || pack.id === "core" || pack.planned || (pack.optional && pack.tier !== "lite"));
    const hiddenPackCount = (status?.packs || []).length - visiblePacks.length;

    const installIds = useMemo(() => {
        if (!status) return [];
        const required = status.packs
            .filter((pack) => selectedPacks.has(pack.id) && !pack.planned)
            .flatMap((pack) => pack.requiredItems.filter((item) => item.status !== "present").map((item) => item.id));
        const optional = status.resources.filter((item) => selectedOptional.has(item.id) && item.status !== "present").map((item) => item.id);
        return [...new Set([...required, ...optional])];
    }, [selectedOptional, selectedPacks, status]);

    const requiredMissingIds = useMemo(() => {
        if (!status) return [];
        return status.packs.filter((pack) => !pack.planned).flatMap((pack) => pack.requiredItems.filter((item) => item.status !== "present").map((item) => item.id));
    }, [status]);

    const resourceById = useMemo(() => new Map((status?.resources || []).map((item) => [item.id, item])), [status]);
    const totalSpeed = Object.values(speeds).reduce((sum, speed) => sum + speed, 0);

    const togglePack = (id: string, checked: boolean) => {
        setSelectedPacks((current) => {
            const next = new Set(current);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const toggleOptional = (id: string, checked: boolean) => {
        setSelectedOptional((current) => {
            const next = new Set(current);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const toggleExpanded = (id: string) => {
        setExpandedPacks((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleWorkflow = (id: string) => {
        setExpandedWorkflows((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
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
                            <span>{copy.present}: {recommendedPresent}/{recommendedTotal}</span>
                            <span>{copy.missing}: {recommendedMissing}</span>
                            {recommendedMissingSize ? <span>{copy.size}: {formatBytes(recommendedMissingSize)}</span> : null}
                            <span>{hardwareName ? `${copy.hardwareDetected}: ${hardwareName}` : copy.noHardware}</span>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />} loading={refreshing} onClick={() => void load(true)}>
                            {copy.refresh}
                        </Button>
                        <Button size="small" type="primary" icon={<Download className="size-3.5" />} disabled={!installIds.length || Boolean(job && ["running"].includes(job.status))} onClick={() => void startInstall({ ids: installIds })}>
                            {copy.installSelected}
                        </Button>
                    </div>
                </div>
                {status?.comfyRoot && !status.comfyReachable ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.notReachable}</div> : null}
                {status?.indexError ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.indexError}</div> : null}
                {hardwareName && !recommendationAvailable ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.noCompatible}</div> : null}
            </div>

            {error ? <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"><XCircle className="size-3.5 shrink-0" />{error}</div> : null}

            {job ? (
                <div ref={jobPanelRef} aria-live="polite" className="sticky top-0 z-30 rounded-xl border border-stone-200 bg-white/95 p-3 shadow-sm backdrop-blur dark:border-stone-800 dark:bg-stone-950/95">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 font-medium">{copy.downloadProgress}</span>
                            {job.status === "running" && totalSpeed > 0 ? <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">{formatSpeed(totalSpeed)}</span> : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate text-stone-500 dark:text-stone-400">{job.message || job.status}</span>
                            {job.status === "running" ? (
                                <Button size="small" danger loading={stopping} onClick={() => void stopInstall()}>{copy.cancel}</Button>
                            ) : null}
                        </div>
                    </div>
                    <Progress percent={job.progress} size="small" status={job.status === "error" ? "exception" : job.status === "done" ? "success" : "active"} />
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto text-[11px]">
                        {job.items.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-stone-600 dark:text-stone-300">{item.label}</span>
                                <span className={item.status === "error" ? "shrink-0 text-red-500" : "shrink-0 text-stone-400 dark:text-stone-500"}>
                                    {item.status === "downloading"
                                        ? `${formatBytes(item.bytes)} / ${formatBytes(item.size)}${speeds[item.id] ? ` · ${formatSpeed(speeds[item.id])}` : ""}`
                                        : item.status === "baking" ? copy.localBake : item.status}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="space-y-2">
                {hiddenPackCount > 0 ? (
                    <div className="flex justify-end">
                        <button type="button" className="text-[11px] text-stone-500 underline-offset-2 hover:underline dark:text-stone-400" onClick={() => setShowAll((value) => !value)}>
                            {showAll ? copy.hideAll : copy.showAll}
                        </button>
                    </div>
                ) : null}
                {visiblePacks.map((pack) => {
                    const expanded = expandedPacks.has(pack.id);
                    const workflowDependencies = pack.workflowDependencies || [];
                    const workflowResourceIds = new Set<string>();
                    for (const workflow of workflowDependencies) {
                        for (const item of workflow.resources) {
                            workflowResourceIds.add(item.id);
                            for (const requiredId of item.requires || []) workflowResourceIds.add(requiredId);
                        }
                    }
                    const extraOptionalItems = pack.optionalItems.filter((item) => !workflowResourceIds.has(item.id));
                    const extraOptionalMissing = extraOptionalItems.filter((item) => item.status !== "present");
                    const extraOptionalSize = extraOptionalMissing.reduce((sum, item) => sum + (item.size || 0), 0);
                    const selectedOptionalInPack = extraOptionalItems.filter((item) => selectedOptional.has(item.id) && item.status !== "present");
                    const packInstallIds = [
                        ...pack.requiredItems.filter((item) => item.status !== "present").map((item) => item.id),
                        ...selectedOptionalInPack.map((item) => item.id),
                    ];
                    return (
                        <div key={pack.id} className="rounded-xl border border-stone-200 dark:border-stone-800">
                            <div className="flex items-start gap-2 p-3">
                                {!pack.planned && pack.total > 0 ? (
                                    <Checkbox checked={selectedPacks.has(pack.id)} disabled={!pack.missing} onChange={(event) => togglePack(pack.id, event.target.checked)} />
                                ) : (
                                    <span className="mt-0.5 grid size-4 place-items-center text-stone-300 dark:text-stone-600">·</span>
                                )}
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleExpanded(pack.id)} aria-expanded={expanded}>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-medium">{pack.label}</span>
                                        {pack.recommended ? <Tag color="blue">{copy.recommended}</Tag> : null}
                                        {pack.offload ? <Tag color="gold">{copy.offload}</Tag> : null}
                                        {pack.optional && !pack.recommended ? <Tag>{copy.optional}</Tag> : null}
                                        {pack.eligible === false ? <Tag color="red">{copy.incompatible}</Tag> : null}
                                        {packState(pack, copy)}
                                        {workflowDependencies.length ? <Tag>{copy.workflowSection} {workflowDependencies.length}</Tag> : null}
                                        {extraOptionalItems.length ? <Tag>{copy.optionalSection} {extraOptionalItems.length}</Tag> : null}
                                        {pack.missingSize ? <span className="text-[11px] text-stone-500 dark:text-stone-400">{copy.size} {formatBytes(pack.missingSize)}</span> : null}
                                    </div>
                                    <div className={`mt-0.5 text-[11px] leading-5 text-stone-500 dark:text-stone-400 ${compact ? "line-clamp-1" : "line-clamp-2"}`}>{pack.description}</div>
                                </button>
                                <button type="button" className="mt-0.5 rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300" onClick={() => toggleExpanded(pack.id)} aria-label={expanded ? copy.collapse : copy.expand}>
                                    <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                                </button>
                            </div>
                            {expanded ? (
                                <div className="border-t border-stone-100 px-3 pb-3 pt-2 dark:border-stone-800/70">
                                    {workflowDependencies.length ? (
                                        <>
                                            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{copy.workflowSection}</span>
                                                <span className="text-stone-400 dark:text-stone-500">{copy.workflowHint}</span>
                                            </div>
                                            <div className="space-y-2">
                                                {workflowDependencies.map((workflow) => {
                                                    const workflowExpanded = expandedWorkflows.has(workflow.id);
                                                    const workflowTag = workflow.missing
                                                        ? <Tag color="orange">{copy.missing} {workflow.missing}</Tag>
                                                        : workflow.available
                                                            ? <Tag color="green">{copy.workflowReady}</Tag>
                                                            : <Tag color="gold">{copy.workflowRestart}</Tag>;
                                                    const problemText = workflow.problems.map((problem) => problem.message).filter(Boolean).join("；");
                                                    return (
                                                        <div key={workflow.id} className="rounded-lg border border-stone-200 dark:border-stone-800">
                                                            <div className="flex items-start gap-2 p-2">
                                                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleWorkflow(workflow.id)} aria-expanded={workflowExpanded}>
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className="text-xs font-medium">{workflow.label}</span>
                                                                        {workflow.missingSize ? <span className="text-[10px] text-stone-400 dark:text-stone-500">{formatBytes(workflow.missingSize)}</span> : null}
                                                                        {workflowTag}
                                                                    </div>
                                                                    <div className="truncate text-[10px] text-stone-400 dark:text-stone-500">{workflow.id}</div>
                                                                </button>
                                                                <button type="button" className="mt-0.5 rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300" onClick={() => toggleWorkflow(workflow.id)} aria-label={workflowExpanded ? copy.collapse : copy.expand}>
                                                                    <ChevronDown className={`size-4 transition-transform ${workflowExpanded ? "rotate-180" : ""}`} />
                                                                </button>
                                                            </div>
                                                            {workflowExpanded ? (
                                                                <div className="border-t border-stone-100 px-2 pb-2 pt-1 dark:border-stone-800/70">
                                                                    <div className="divide-y divide-stone-100 rounded-md bg-stone-50/60 dark:divide-stone-800/70 dark:bg-white/[.02]">
                                                                        {workflow.resources.map((item) => (
                                                                            <WorkflowResourceRow
                                                                                key={item.id}
                                                                                item={item}
                                                                                copy={copy}
                                                                                requires={(item.requires || []).map((id) => resourceById.get(id)).filter((entry): entry is ResourceItem => Boolean(entry))}
                                                                            />
                                                                        ))}
                                                                    </div>
                                                                    {!workflow.available && problemText ? (
                                                                        <div className="mt-1 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{problemText}</div>
                                                                    ) : null}
                                                                    {workflow.installIds.length ? (
                                                                        <div className="mt-2 flex justify-end">
                                                                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void startInstall({ ids: workflow.installIds })} disabled={Boolean(job && job.status === "running")}>
                                                                                {copy.installWorkflow}
                                                                            </Button>
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="mt-3 mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{copy.optionalSection}</span>
                                                <span className="text-stone-400 dark:text-stone-500">
                                                    {extraOptionalItems.length ? `${copy.optionalMissingLabel} ${extraOptionalMissing.length}${extraOptionalSize ? ` · ${formatBytes(extraOptionalSize)}` : ""}` : copy.optionalHint}
                                                </span>
                                            </div>
                                            {extraOptionalItems.length ? (
                                                <div className="space-y-1.5">
                                                    {extraOptionalItems.map((item) => (
                                                        <ResourceCard
                                                            key={item.id}
                                                            item={item}
                                                            copy={copy}
                                                            compact={compact}
                                                            optional
                                                            selected={selectedOptional.has(item.id)}
                                                            onToggle={(checked) => toggleOptional(item.id, checked)}
                                                        />
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="text-[11px] text-stone-400 dark:text-stone-500">{copy.optionalEmpty}</div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="mb-1.5 flex items-center justify-between text-[11px]">
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{copy.requiredSection}</span>
                                                <span className="text-stone-400 dark:text-stone-500">{pack.present}/{pack.total}{pack.missingSize ? ` · ${copy.size} ${formatBytes(pack.missingSize)}` : ""}</span>
                                            </div>
                                            <div className="space-y-1.5">
                                                {pack.requiredItems.length ? (
                                                    pack.requiredItems.map((item) => <ResourceCard key={item.id} item={item} copy={copy} compact={compact} />)
                                                ) : (
                                                    <div className="text-[11px] text-stone-400 dark:text-stone-500">{copy.noResources}</div>
                                                )}
                                            </div>
                                            <div className="mt-3 mb-1.5 flex items-center justify-between text-[11px]">
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{copy.optionalSection}</span>
                                                <span className="text-stone-400 dark:text-stone-500">
                                                    {pack.optionalTotal ? `${copy.optionalMissingLabel} ${pack.optionalMissing}${pack.optionalSize ? ` · ${formatBytes(pack.optionalSize)}` : ""}` : copy.optionalHint}
                                                </span>
                                            </div>
                                            {pack.optionalItems.length ? (
                                                <div className="space-y-1.5">
                                                    {pack.optionalItems.map((item) => (
                                                        <ResourceCard
                                                            key={item.id}
                                                            item={item}
                                                            copy={copy}
                                                            compact={compact}
                                                            optional
                                                            selected={selectedOptional.has(item.id)}
                                                            onToggle={(checked) => toggleOptional(item.id, checked)}
                                                        />
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="text-[11px] text-stone-400 dark:text-stone-500">{copy.optionalEmpty}</div>
                                            )}
                                            {!pack.planned && packInstallIds.length ? (
                                                <div className="mt-2 flex justify-end">
                                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void startInstall({ ids: packInstallIds })} disabled={Boolean(job && job.status === "running")}>
                                                        {copy.installPack}
                                                    </Button>
                                                </div>
                                            ) : null}
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {requiredMissingIds.length === 0 && status?.summary.resources ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300">
                    <CheckCircle2 className="size-4" />{copy.emptyMissing}
                </div>
            ) : null}
            {footer}
        </div>
    );
}
