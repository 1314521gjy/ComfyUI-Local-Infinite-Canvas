import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { requestApplyUpdate, requestUpdateCheck, requestUpdateProgress, type ApplyUpdateResult, type UpdateCheckResult, type UpdateProgress } from "@/services/api/update";
import { isGatewayDown } from "@/services/api/gateway-status";
import type { ReleaseInfo } from "@/lib/release";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const currentVersion = APP_VERSION;
    const releases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
    const [applyResult, setApplyResult] = useState<ApplyUpdateResult | null>(null);
    const [applying, setApplying] = useState(false);
    const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);

    const checkLatest = useCallback(
        async (fetchRemote: boolean, showMessage = false) => {
            setChecking(true);
            try {
                const result = await requestUpdateCheck(fetchRemote);
                setUpdateInfo(result);
                if (result.latestVersion) setLatestVersion(result.latestVersion);
                if (showMessage) {
                    if (result.updateAvailable) message.success(t("version.updateAvailable", { version: result.latestVersion }));
                    else if (isNewerVersion(result.currentVersion || "", currentVersion)) message.warning(t("version.pageStaleShort"));
                    else message.success(t("version.upToDate"));
                }
                return result;
            } catch (error) {
                if (showMessage && !isGatewayDown()) message.error(error instanceof Error ? error.message : t("version.updateFailed"));
                return null;
            } finally {
                setChecking(false);
            }
        },
        [message, t],
    );

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (window.sessionStorage.getItem("qoder-update-checked") === "1") return;
        window.sessionStorage.setItem("qoder-update-checked", "1");
        void (async () => {
            const result = await checkLatest(true);
            if (result?.updateAvailable) setOpen(true);
        })();
    }, [checkLatest]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatest(true);
    }, [checkLatest]);

    const checkLatestRelease = useCallback((showMessage = false) => checkLatest(true, showMessage), [checkLatest]);

    const applyUpdate = useCallback(async (force = false) => {
        setApplying(true);
        setUpdateProgress(null);
        let timer = 0;
        const poll = async () => {
            try {
                setUpdateProgress(await requestUpdateProgress());
            } catch {
                // 进度接口短暂失败不阻断更新本身。
            }
        };
        void poll();
        timer = window.setInterval(() => {
            void poll();
        }, 400);
        try {
            const result = await requestApplyUpdate(false, force);
            setApplyResult(result);
            message.success(result.message || t("version.applySuccess"));
            if (result.restarting) {
                window.setTimeout(() => window.location.reload(), 6000);
            }
            await checkLatest(true);
            return result;
        } catch (error) {
            if (!isGatewayDown()) message.error(error instanceof Error ? error.message : t("version.applyFailed"));
            throw error;
        } finally {
            if (timer) window.clearInterval(timer);
            await poll();
            setApplying(false);
        }
    }, [checkLatest, message, t]);

    const pageStale = Boolean(updateInfo?.currentVersion && isNewerVersion(updateInfo.currentVersion, currentVersion));
    const hasNewVersion = Boolean(updateInfo?.updateAvailable) || pageStale || isNewerVersion(latestVersion, currentVersion);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        pageStale,
        checkLatestRelease,
        updateInfo,
        applyResult,
        applying,
        updateProgress,
        applyUpdate,
    };
}
