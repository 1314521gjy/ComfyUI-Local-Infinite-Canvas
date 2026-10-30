import type { CSSProperties } from "react";
import { useEffect } from "react";
import { GithubOutlined } from "@ant-design/icons";
import { App, Button, Modal, Progress, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "@/hooks/use-version-check";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { APP_VERSION, GITHUB_REPO_URL } from "@/constant/env";
import { formatBytes } from "@/lib/image-utils";

function formatSpeed(bytesPerSecond: number) {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    return value > 0 ? `${formatBytes(value)}/s` : "";
}

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, pageStale, checkLatestRelease, updateInfo, applyResult, applying, updateProgress, applyUpdate } =
        useVersionCheck();

    useEffect(() => {
        const handler = () => openReleaseModal();
        window.addEventListener("open-version-release", handler);
        return () => window.removeEventListener("open-version-release", handler);
    }, [openReleaseModal]);

    const confirmApply = (force = false) => {
        modal.confirm({
            title: t(force ? "version.forceApplyTitle" : "version.applyConfirmTitle"),
            content: t(force ? "version.forceApplyContent" : "version.applyConfirmContent"),
            okText: t(force ? "version.forceApply" : "version.apply"),
            okButtonProps: force ? { danger: true } : undefined,
            cancelText: t("common.cancel"),
            onOk: () => {
                void applyUpdate(force).catch(() => undefined);
            },
        });
    };

    const progress = updateProgress;
    const progressVisible = Boolean(applying || (progress && !["idle", "done"].includes(progress.phase)));
    const progressPhase = progress?.phase || (applying ? "checking" : "idle");
    const progressPercent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
    const progressLabel = t(`version.updatePhases.${progressPhase}`, { defaultValue: progress?.message || t("version.applying") });

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
                style={style}
                onClick={openReleaseModal}
                title={t("version.viewUpdates")}
            >
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title={t("version.title")} open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {t(checking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</div>
                    </div>
                </div>
                {pageStale ? (
                    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/60 dark:bg-blue-950/30">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                                {t("version.pageStale", { page: APP_VERSION, program: updateInfo?.currentVersion || latestVersion })}
                            </div>
                            <Button size="small" type="primary" onClick={() => window.location.reload()}>
                                {t("version.refreshPage")}
                            </Button>
                        </div>
                    </div>
                ) : null}
                {updateInfo?.updateAvailable ? (
                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">{t("version.updateAvailable", { version: updateInfo.latestVersion })}</div>
                            <div className="flex items-center gap-2">
                                {!updateInfo.canApply && updateInfo.downloadUrl ? (
                                    <a className="text-xs text-stone-600 underline underline-offset-2 dark:text-stone-300" href={updateInfo.downloadUrl} target="_blank" rel="noreferrer">
                                        {t("version.downloadBridge")}
                                    </a>
                                ) : null}
                                {updateInfo.canApply && updateInfo.repository ? (
                                    <a className="text-xs text-stone-600 underline underline-offset-2 dark:text-stone-300" href={updateInfo.repository} target="_blank" rel="noreferrer">
                                        {t("version.downloadFull")}
                                    </a>
                                ) : null}
                                {updateInfo.canApply ? (
                                    <Button size="small" type="primary" loading={applying} onClick={() => confirmApply(false)}>
                                        {t(applying ? "version.applying" : "version.apply")}
                                    </Button>
                                ) : null}
                                {updateInfo.forceAvailable ? (
                                    <Button size="small" danger loading={applying} onClick={() => confirmApply(true)}>
                                        {t("version.forceApply")}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        {updateInfo.notes ? <div className="mt-2 text-xs leading-5 text-stone-600 dark:text-stone-300">{updateInfo.notes}</div> : null}
                        {!updateInfo.canApply && updateInfo.applyReason ? <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{updateInfo.applyReason}</div> : null}
                        {updateInfo.dirtyFiles?.length ? (
                            <div className="mt-1 break-all text-[11px] leading-5 text-stone-400 dark:text-stone-500">
                                {t("version.dirtyFilesHint", {
                                    files: `${updateInfo.dirtyFiles.slice(0, 5).join("、")}${updateInfo.dirtyFiles.length > 5 ? " …" : ""}`,
                                })}
                            </div>
                        ) : null}
                        {updateInfo.warnings?.length ? <div className="mt-1 text-[11px] leading-5 text-stone-400 dark:text-stone-500">{updateInfo.warnings.join("；")}</div> : null}
                    </div>
                ) : null}
                {progressVisible ? (
                    <div className="mb-4 rounded-lg border border-stone-200 bg-stone-50/60 p-3 dark:border-stone-800 dark:bg-white/[.02]">
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-stone-600 dark:text-stone-300">
                            <span>{progressLabel}</span>
                            {progress?.speed ? <span className="shrink-0 text-stone-400 dark:text-stone-500">{formatSpeed(progress.speed)}</span> : null}
                        </div>
                        <Progress percent={progressPercent} size="small" showInfo={false} status={progressPhase === "error" ? "exception" : "active"} />
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                            <span>
                                {progress?.downloaded && progress?.total ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}` : progress?.message || ""}
                            </span>
                            <span>{progressPercent}%</span>
                        </div>
                        {progressPhase === "error" && progress?.message ? <div className="mt-1 text-[11px] leading-5 text-red-600 dark:text-red-400">{progress.message}</div> : null}
                    </div>
                ) : null}
                {applyResult?.ok ? (
                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-xs leading-5 text-stone-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-stone-200">
                        <div>{applyResult.message || t("version.applySuccess")}</div>
                        {applyResult.launcherChanged ? <div>{t("version.launcherChanged")}</div> : null}
                        {applyResult.installRequired ? <div>{t("version.installRequired")}</div> : null}
                    </div>
                ) : null}
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-3 text-xs dark:border-stone-800">
                    <span className="text-stone-400 dark:text-stone-500">{LOCAL_ONLY ? t("version.localMode") : null}</span>
                    <a className="inline-flex items-center gap-1.5 text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
                        <GithubOutlined />
                        {t("version.repository")}
                    </a>
                </div>
            </Modal>
        </>
    );
}
