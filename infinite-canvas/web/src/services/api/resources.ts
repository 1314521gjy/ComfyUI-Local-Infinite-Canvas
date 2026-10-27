import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

export type ResourceSource = {
    url: string;
    label?: string;
};

export type ResourceItem = {
    id: string;
    type: string;
    label: string;
    target: string;
    size: number;
    sha256?: string;
    license?: string;
    note?: string;
    sources: ResourceSource[];
    requires: string[];
    builder?: Record<string, unknown> | null;
    status: "present" | "missing" | "blocked";
    present: boolean;
    registered: boolean;
    exists: boolean;
    actualSize: number;
    installed?: { version?: string; installedAt?: string } | null;
    missingRequires: string[];
    overridden?: boolean;
    overriddenBy?: string;
};

export type PackMainModelOption = {
    file: string;
    label: string;
    installed: boolean;
    source: "pack" | "local";
    matches?: boolean;
    resourceId?: string;
};

export type PackMainModel = {
    workflowIds: string[];
    files: string[];
    defaultFile: string;
    defaultLabel: string;
    selected: string;
    selectedLabel: string;
    selectedInstalled: boolean;
    available: boolean;
    options: PackMainModelOption[];
};

export type ResourceVariant = {
    id: string;
    label: string;
    tier: string;
    workflows: string[];
    requiredIds: string[];
    eligible: boolean;
    recommended: boolean;
    preferred: boolean;
    offload: boolean;
    resident: boolean;
};

export type WorkflowDependency = {
    id: string;
    label: string;
    available: boolean;
    enabled?: boolean;
    modelVisible?: boolean;
    variantLabels?: Record<string, string>;
    recommended?: boolean;
    problems: Array<{ type?: string; message?: string }>;
    resources: ResourceItem[];
    missing: number;
    missingSize: number;
    installIds: string[];
};

export type ResourcePack = {
    id: string;
    label: string;
    description: string;
    family?: string;
    tier?: string;
    optional?: boolean;
    optionalLabel?: string;
    eligible?: boolean;
    recommended?: boolean;
    recommendedVariant?: string;
    variants?: ResourceVariant[];
    offload?: boolean;
    resident?: boolean;
    planned: boolean;
    workflows: string[];
    resourceIds: string[];
    requiredIds: string[];
    optionalIds: string[];
    resources: ResourceItem[];
    requiredItems: ResourceItem[];
    optionalItems: ResourceItem[];
    mainModel?: PackMainModel | null;
    workflowDependencies?: WorkflowDependency[];
    total: number;
    present: number;
    missing: number;
    missingSize: number;
    optionalTotal: number;
    optionalPresent: number;
    optionalMissing: number;
    optionalSize: number;
};

export type ResourceStatus = {
    ok: boolean;
    loadedAt?: string;
    indexSource?: string;
    indexError?: string;
    indexVersion?: string;
    channel?: string;
    comfyRoot?: string;
    comfyPython?: string;
    comfyReachable?: boolean;
    hardware?: { gpuName?: string; vramTotalMb?: number; ramTotalBytes?: number; ramFreeBytes?: number; detectedAt?: string; source?: string } | null;
    recommendationAvailable?: boolean;
    packs: ResourcePack[];
    resources: ResourceItem[];
    summary: {
        packs: number;
        resources: number;
        present: number;
        missing: number;
        missingSize: number;
        recommendedPacks?: number;
        recommendedResources?: number;
        recommendedPresent?: number;
        recommendedMissing?: number;
        recommendedMissingSize?: number;
    };
    lock?: { installed?: Record<string, unknown>; updatedAt?: string };
};

export type ResourceJobItem = {
    id: string;
    label: string;
    type: string;
    status: string;
    bytes: number;
    size: number;
    source?: string | null;
    error?: string;
    hint?: string;
    skipped?: boolean;
};

export type ResourceJob = {
    id: string;
    status: string;
    message: string;
    createdAt: string;
    updatedAt: string;
    items: ResourceJobItem[];
    completed: number;
    total: number;
    progress: number;
    error?: string;
};

async function readJson(response: Response) {
    return (await response.json().catch(() => ({}))) as Record<string, any>;
}

function errorMessage(data: Record<string, any>, fallback: string) {
    return String(data?.error?.message || data?.message || fallback);
}

export async function fetchResourceStatus(): Promise<ResourceStatus> {
    const response = await fetch(`${gatewayRoot}/api/resources/status`, { headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `读取资源状态失败（HTTP ${response.status}）`));
    return data as ResourceStatus;
}

export async function refreshResourceStatus(): Promise<ResourceStatus> {
    const response = await fetch(`${gatewayRoot}/api/resources/refresh`, { method: "POST", headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `刷新资源失败（HTTP ${response.status}）`));
    return data as ResourceStatus;
}

export async function setPackMainModel(packId: string, file: string): Promise<ResourceStatus> {
    const response = await fetch(`${gatewayRoot}/api/resources/packs/${encodeURIComponent(packId)}/main-model`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
    });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `切换主模型失败（HTTP ${response.status}）`));
    return data.status as ResourceStatus;
}

export async function installResources(input: { ids?: string[]; packs?: string[] }): Promise<ResourceJob> {
    const response = await fetch(`${gatewayRoot}/api/resources/install`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `启动安装失败（HTTP ${response.status}）`));
    return data.job as ResourceJob;
}

export async function fetchResourceJob(id: string): Promise<ResourceJob> {
    const response = await fetch(`${gatewayRoot}/api/resources/jobs/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `读取安装进度失败（HTTP ${response.status}）`));
    return data.job as ResourceJob;
}

export async function setWorkflowVisibility(id: string, enabled: boolean): Promise<void> {
    const response = await fetch(`${gatewayRoot}/api/workflows/${encodeURIComponent(id)}/visibility`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `切换工作流状态失败（HTTP ${response.status}）`));
}

export async function cancelResourceJob(id: string): Promise<ResourceJob> {
    const response = await fetch(`${gatewayRoot}/api/resources/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `取消安装失败（HTTP ${response.status}）`));
    return data.job as ResourceJob;
}

export function formatBytes(bytes: number) {
    const value = Number(bytes) || 0;
    if (value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let size = value;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}
