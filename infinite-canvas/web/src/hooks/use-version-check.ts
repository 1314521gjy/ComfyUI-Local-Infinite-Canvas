import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { requestApplyUpdate, requestUpdateCheck, type ApplyUpdateResult, type UpdateCheckResult } from "@/services/api/update";
import { isGatewayDown } from "@/services/api/gateway-status";
import type { ReleaseInfo } from "@/lib/release";

const SKIPPED_UPDATE_KEY = "qoder-skipped-update-version";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function readSkippedUpdate(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(SKIPPED_UPDATE_KEY);
    } catch {
        return null;
    }
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
    const [skippedVersion, setSkippedVersion] = useState<string | null>(readSkippedUpdate);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
    const [applyResult, setApplyResult] = useState<ApplyUpdateResult | null>(null);
    const [applying, setApplying] = useState(false);

    const checkLatest = useCallback(
        async (fetchRemote: boolean, showMessage = false) => {
            setChecking(true);
            try {
                const result = await requestUpdateCheck(fetchRemote);
                setUpdateInfo(result);
                if (result.latestVersion) setLatestVersion(result.latestVersion);
                if (showMessage) {
                    if (result.updateAvailable) message.success(t("version.updateAvailable", { version: result.latestVersion }));
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
            if (result?.updateAvailable && result.latestVersion !== skippedVersion) setOpen(true);
        })();
    }, [checkLatest, skippedVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatest(true);
    }, [checkLatest]);

    const clearSkippedUpdate = useCallback(() => {
        try {
            window.localStorage.removeItem(SKIPPED_UPDATE_KEY);
        } catch {
            // localStorage can be unavailable in private mode; skipping still works for this session.
        }
        setSkippedVersion(null);
    }, []);

    const skipUpdate = useCallback(() => {
        const version = updateInfo?.latestVersion || latestVersion;
        if (!version) return;
        try {
            window.localStorage.setItem(SKIPPED_UPDATE_KEY, version);
        } catch {
            // Keep the in-memory skip when persistence is unavailable.
        }
        setSkippedVersion(version);
        setOpen(false);
        message.success(t("version.skipSuccess", { version }));
    }, [latestVersion, message, t, updateInfo?.latestVersion]);

    const checkLatestRelease = useCallback((showMessage = false) => {
        clearSkippedUpdate();
        return checkLatest(true, showMessage);
    }, [checkLatest, clearSkippedUpdate]);

    const applyUpdate = useCallback(async () => {
        setApplying(true);
        try {
            const result = await requestApplyUpdate(false);
            clearSkippedUpdate();
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
            setApplying(false);
        }
    }, [checkLatest, clearSkippedUpdate, message, t]);

    const updateAvailable = Boolean(updateInfo?.updateAvailable) || isNewerVersion(latestVersion, currentVersion);
    const hasNewVersion = updateAvailable && latestVersion !== skippedVersion;

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        skippedVersion,
        skipUpdate,
        checkLatestRelease,
        updateInfo,
        applyResult,
        applying,
        applyUpdate,
    };
}
