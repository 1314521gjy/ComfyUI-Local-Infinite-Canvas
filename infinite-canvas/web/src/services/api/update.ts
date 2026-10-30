import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { gatewayFetch } from "@/services/api/gateway-status";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

export type UpdateCheckResult = {
    ok: boolean;
    checkedAt?: string;
    currentVersion?: string;
    latestVersion?: string;
    updateAvailable?: boolean;
    canApply?: boolean;
    applyReason?: string;
    installType?: "git" | "archive";
    source?: string;
    dirty?: boolean;
    dirtyFiles?: string[];
    ignoredDirtyFiles?: string[];
    gitError?: string;
    forceAvailable?: boolean;
    patchAvailable?: boolean;
    notes?: string;
    publishedAt?: string;
    repository?: string;
    downloadUrl?: string;
    remote?: { name: string; branch: string; fetched: boolean };
    warnings?: string[];
    error?: string;
};

export type UpdateProgress = {
    phase: string;
    percent: number;
    downloaded: number;
    total: number;
    speed: number;
    message: string;
    updatedAt?: number;
};

export type ApplyUpdateResult = {
    ok: boolean;
    dryRun?: boolean;
    forced?: boolean;
    currentVersion?: string;
    latestVersion?: string;
    beforeHead?: string;
    afterHead?: string;
    changedFiles?: string[];
    deletedFiles?: string[];
    launcherChanged?: boolean;
    installRequired?: boolean;
    restartRequired?: boolean;
    restarting?: boolean;
    summary?: string;
    message?: string;
    commands?: string[];
};

async function readJson(response: Response) {
    return (await response.json().catch(() => ({}))) as Record<string, any>;
}

function errorMessage(data: Record<string, any>, fallback: string) {
    return String(data?.error?.message || data?.message || fallback);
}

export async function requestUpdateCheck(fetchRemote = false): Promise<UpdateCheckResult> {
    const response = await gatewayFetch(`${gatewayRoot}/api/update/check?fetch=${fetchRemote ? 1 : 0}`, {
        headers: { Accept: "application/json" },
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(data, `检查更新失败（HTTP ${response.status}）`));
    return data as UpdateCheckResult;
}

export async function requestUpdateProgress(): Promise<UpdateProgress> {
    const response = await gatewayFetch(`${gatewayRoot}/api/update/progress`, {
        headers: { Accept: "application/json" },
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(data, `读取更新进度失败（HTTP ${response.status}）`));
    return data.progress as UpdateProgress;
}

export async function requestApplyUpdate(dryRun = false, force = false): Promise<ApplyUpdateResult> {
    const response = await gatewayFetch(`${gatewayRoot}/api/update/apply`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, force }),
    });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `更新失败（HTTP ${response.status}）`));
    return data as ApplyUpdateResult;
}
