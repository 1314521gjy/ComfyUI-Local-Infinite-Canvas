import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";
import { guessCapability, type ChannelModel, type LocalGatewaySyncStatus, type ModelCapability } from "@/stores/use-config-store";

export type GatewaySyncTrigger = "initial" | "sse" | "focus" | "visibility" | "poll" | "manual";

export type GatewaySetupSnapshot = {
    phase: string;
    instanceId?: string;
    scanId?: string;
    revision?: number;
    scanning: boolean;
    stale: boolean;
    comfyReachable?: boolean;
    counts?: { available?: number; total?: number; unavailable?: number };
};

export type GatewayModelsSnapshot = {
    models: ChannelModel[];
    revision?: number;
    setup?: GatewaySetupSnapshot;
    updatedAt?: string;
    reason?: string;
};

export type ModelApplyDecision = { action: "replace" | "clear" } | { action: "retain"; reason: "scanning" | "degraded" | "unconfirmed" | "poll" };

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : undefined;
}

function asVariantLabels(value: unknown): Record<string, string> | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, label]) => [key, String(label)]));
}

function syncableCapability(name: string): ModelCapability | undefined {
    const capability = guessCapability(name);
    return capability === "image" || capability === "video" ? capability : undefined;
}

/** 旧后端没有 revision/setup 时也必须能解析；缺失字段一律视为未知，不猜测。 */
export function parseGatewayModelsPayload(payload: unknown): GatewayModelsSnapshot {
    const root = asRecord(payload) || {};
    const setupRaw = asRecord(root.setup);
    const phase = asText(setupRaw?.phase) || "";
    const scanning = setupRaw?.scanning === true || phase === "scanning";
    const stale = setupRaw?.stale === true || phase === "degraded";
    const revision = asNumber(root.revision) ?? asNumber(setupRaw?.revision);
    const models: ChannelModel[] = [];

    for (const item of Array.isArray(root.data) ? root.data : []) {
        const entry = asRecord(item);
        if (!entry) continue;
        const name = String(entry.id ?? "").trim();
        const meta = asRecord(entry.metadata) || {};
        const capability = meta.type === "image" || meta.type === "video" ? meta.type : syncableCapability(name);
        if (!name || !capability) continue;
        models.push({
            name,
            capability,
            label: asText(meta.label),
            workflowId: asText(meta.workflowId),
            baseModel: asText(meta.baseModel),
            baseModelLabel: asText(meta.baseModelLabel),
            imageInputs: asNumber(meta.imageInputs),
            variantModes: asStringArray(meta.variantModes),
            variantLabels: asVariantLabels(meta.variantLabels),
        });
    }

    const countsRaw = asRecord(setupRaw?.counts);
    const setup: GatewaySetupSnapshot | undefined = setupRaw
        ? {
              phase: phase || (scanning ? "scanning" : stale ? "degraded" : "unknown"),
              instanceId: asText(setupRaw.instanceId),
              scanId: typeof setupRaw.scanId === "number" && Number.isFinite(setupRaw.scanId) ? String(setupRaw.scanId) : asText(setupRaw.scanId),
              revision,
              scanning,
              stale,
              comfyReachable: typeof setupRaw.comfyReachable === "boolean" ? setupRaw.comfyReachable : undefined,
              counts: countsRaw
                  ? { available: asNumber(countsRaw.available), total: asNumber(countsRaw.total), unavailable: asNumber(countsRaw.unavailable) }
                  : undefined,
          }
        : undefined;

    return { models, revision, setup, updatedAt: asText(root.updatedAt), reason: asText(root.reason) };
}

/**
 * 空列表不能直接清空界面：
 * - 扫描中保留；
 * - degraded/stale/ComfyUI 离线保留；
 * - 旧后端无法确认状态时保留；
 * - 轮询只兜底，永远不清空；
 * 只有 phase=ready、非 scanning、非 stale 的空快照才允许清除。
 */
export function decideModelApply(snapshot: GatewayModelsSnapshot, trigger: GatewaySyncTrigger): ModelApplyDecision {
    if (snapshot.models.length) return { action: "replace" };
    if (trigger === "poll") return { action: "retain", reason: "poll" };
    const setup = snapshot.setup;
    if (!setup) return { action: "retain", reason: "unconfirmed" };
    if (setup.scanning) return { action: "retain", reason: "scanning" };
    if (setup.stale || setup.phase === "degraded" || setup.comfyReachable === false) return { action: "retain", reason: "degraded" };
    if (setup.phase === "ready") return { action: "clear" };
    return { action: "retain", reason: "unconfirmed" };
}

/** 服务端 revision 回退视为旧快照；实例变化说明网关重启，接受新序列。 */
export function isStaleServerRevision(
    applied: { revision?: number; setupRevision?: number; scanId?: string; instanceId?: string },
    incoming: { revision?: number; setupRevision?: number; scanId?: string; instanceId?: string },
) {
    const identityChanged = applied.instanceId && incoming.instanceId
        ? applied.instanceId !== incoming.instanceId
        : Boolean(incoming.scanId && applied.scanId && incoming.scanId !== applied.scanId);
    if (identityChanged) return false;
    if (incoming.revision === undefined || applied.revision === undefined) return false;
    if (incoming.revision < applied.revision) return true;
    // 同一事件 revision 内扫描仍可能提交新代际；环境 revision 回退同样不能覆盖。
    if (incoming.revision === applied.revision && incoming.setupRevision !== undefined && applied.setupRevision !== undefined && incoming.setupRevision < applied.setupRevision) return true;
    return false;
}

function statusFromSnapshot(snapshot: GatewayModelsSnapshot, trigger: GatewaySyncTrigger, reason: string | undefined): LocalGatewaySyncStatus {
    const setup = snapshot.setup;
    const scanning = Boolean(setup?.scanning);
    const stale = Boolean(setup && (setup.stale || setup.phase === "degraded"));
    const offline = setup?.comfyReachable === false;
    const phase = scanning ? "scanning" : offline || stale ? "degraded" : setup?.phase === "ready" ? "ready" : setup ? "degraded" : "idle";
    return {
        phase,
        scanning,
        stale,
        revision: snapshot.revision,
        instanceId: setup?.instanceId,
        scanId: setup?.scanId,
        updatedAt: snapshot.updatedAt || new Date().toISOString(),
        reason: snapshot.reason || reason || trigger,
        comfyReachable: setup?.comfyReachable,
        count: snapshot.models.length,
        legacy: !setup,
        error: undefined,
    };
}

function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message || error.name;
    return String(error || "unknown error");
}

export type GatewayModelSync = {
    request: (trigger: GatewaySyncTrigger, reason?: string) => Promise<void>;
    whenIdle: () => Promise<void>;
    status: () => LocalGatewaySyncStatus;
    stop: () => void;
};

export type GatewayModelSyncOptions = {
    fetchModels: (signal: AbortSignal) => Promise<unknown>;
    apply: (snapshot: GatewayModelsSnapshot, decision: ModelApplyDecision, trigger: GatewaySyncTrigger) => void;
    onStatus?: (status: LocalGatewaySyncStatus) => void;
    onError?: (error: unknown, trigger: GatewaySyncTrigger) => void;
    onDiscard?: (reason: "superseded" | "stale-revision" | "stopped") => void;
    timeoutMs?: number;
    now?: () => string;
};

/**
 * 单一同步入口 + latest-wins：
 * - SSE / focus / visibility / 轮询 / 自定义事件都调用 request；
 * - 同步中再有事件时排队（合并为一次补拉），不会丢；
 * - 新事件会 Abort 旧请求并用 generation 令牌丢弃旧响应；
 * - 服务端 revision 回退的响应不覆盖新列表；
 * - 失败保留现有列表，只更新 stale/offline 状态。
 */
export function createGatewayModelSync(options: GatewayModelSyncOptions): GatewayModelSync {
    let stopped = false;
    let queued: { trigger: GatewaySyncTrigger; reason?: string } | null = null;
    let loop: Promise<void> | null = null;
    let controller: AbortController | null = null;
    let token = 0;
    let appliedRevision: number | undefined;
    let appliedSetupRevision: number | undefined;
    let appliedScanId: string | undefined;
    let appliedInstanceId: string | undefined;
    let status: LocalGatewaySyncStatus = { phase: "idle", scanning: false, stale: false };
    const now = options.now || (() => new Date().toISOString());

    const emit = (patch: Partial<LocalGatewaySyncStatus>) => {
        status = { ...status, ...patch };
        options.onStatus?.({ ...status });
    };

    const runOnce = async (trigger: GatewaySyncTrigger, reason?: string) => {
        const current = ++token;
        const active = new AbortController();
        controller = active;
        const timer = options.timeoutMs ? setTimeout(() => active.abort(), options.timeoutMs) : undefined;
        if (status.phase === "idle") emit({ phase: "syncing", error: undefined });
        try {
            const payload = await options.fetchModels(active.signal);
            if (stopped || current !== token) {
                options.onDiscard?.("superseded");
                return;
            }
            const snapshot = parseGatewayModelsPayload(payload);
            if (
                isStaleServerRevision(
                    { revision: appliedRevision, setupRevision: appliedSetupRevision, scanId: appliedScanId, instanceId: appliedInstanceId },
                    { revision: snapshot.revision, setupRevision: snapshot.setup?.revision, scanId: snapshot.setup?.scanId, instanceId: snapshot.setup?.instanceId },
                )
            ) {
                options.onDiscard?.("stale-revision");
                return;
            }
            const decision = decideModelApply(snapshot, trigger);
            options.apply(snapshot, decision, trigger);
            if (snapshot.revision !== undefined) appliedRevision = snapshot.revision;
            if (snapshot.setup?.revision !== undefined) appliedSetupRevision = snapshot.setup.revision;
            if (snapshot.setup?.scanId) appliedScanId = snapshot.setup.scanId;
            if (snapshot.setup?.instanceId) appliedInstanceId = snapshot.setup.instanceId;
            emit(statusFromSnapshot(snapshot, trigger, reason));
        } catch (error) {
            if (stopped) return;
            if (current !== token) {
                options.onDiscard?.("superseded");
                return;
            }
            // 超时/断网/HTTP 失败：保留旧列表，只标记 stale 与错误。
            emit({ phase: "offline", stale: true, error: errorMessage(error), updatedAt: now(), reason: reason || status.reason });
            options.onError?.(error, trigger);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (controller === active) controller = null;
        }
    };

    const drain = () => {
        if (loop) return loop;
        loop = (async () => {
            while (!stopped && queued) {
                const next = queued;
                queued = null;
                await runOnce(next.trigger, next.reason);
            }
            loop = null;
        })();
        return loop;
    };

    const request = (trigger: GatewaySyncTrigger, reason?: string) => {
        if (stopped) return Promise.resolve();
        queued = { trigger, reason };
        if (controller) {
            // 让旧请求立刻结束，且即使底层忽略 Abort 也会因 generation 不匹配被丢弃。
            token += 1;
            controller.abort();
        }
        return drain();
    };

    return {
        request,
        whenIdle: () => loop || Promise.resolve(),
        status: () => ({ ...status }),
        stop: () => {
            stopped = true;
            token += 1;
            queued = null;
            controller?.abort();
        },
    };
}

export type ModelPickerEmptyKind = "scanning" | "offline" | "unsynced" | "no-models";

/** 空列表的具体原因：扫描中 / ComfyUI 离线 / 渠道未同步 / 没有可用模型。 */
export function resolveModelPickerEmptyKind(input: { optionCount: number; local: boolean; status: LocalGatewaySyncStatus }): ModelPickerEmptyKind | null {
    if (input.optionCount > 0 || !input.local) return null;
    const status = input.status;
    if (status.scanning || status.phase === "scanning") return "scanning";
    if (status.comfyReachable === false || status.phase === "offline") return "offline";
    if (status.revision === undefined && (status.phase === "idle" || status.phase === "syncing")) return "unsynced";
    return "no-models";
}

export type ModelPickerEmptyAction = "rescan" | "reason" | "diagnostics";

/** 空态动作必须显式触发；“查看原因”只在调用方提供回调时出现。 */
export function modelPickerEmptyActions(input: { local: boolean; hasMissingConfigHandler: boolean }): ModelPickerEmptyAction[] {
    if (!input.local) return [];
    return ["rescan", ...(input.hasMissingConfigHandler ? (["reason"] as ModelPickerEmptyAction[]) : []), "diagnostics"];
}

/** 打开下拉只做展开/互斥，空列表绝不自动弹配置。 */
export function pickerOpenPlan(nextOpen: boolean) {
    return { open: nextOpen, broadcast: nextOpen, requestConfig: false as const };
}

const SENSITIVE_KEY_PATTERNS = [
    /apikey/i,
    /^token$/i,
    /access.?token/i,
    /refresh.?token/i,
    /authorization/i,
    /password/i,
    /passwd/i,
    /secret/i,
    /^cookie$/i,
    /^setcookie$/i,
    /^prompt$/i,
    /^prompts$/i,
    /^systemprompt$/i,
    /^messages$/i,
    /^content$/i,
    /^contents$/i,
    /^dataurl$/i,
    /^base64$/i,
    /^b64json$/i,
    /^body$/i,
];

function isSensitiveKey(key: string) {
    const normalized = key.replace(/[-_\s]/g, "");
    return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(key));
}

function sanitizeString(value: string) {
    const masked = value
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
        .replace(/([A-Za-z]:\\Users\\)[^\\]+/gi, "$1<user>")
        .replace(/(\/home\/)[^/]+/gi, "$1<user>");
    return masked.length > 300 ? `${masked.slice(0, 300)}…` : masked;
}

/** 诊断 JSON 脱敏：去掉密钥/令牌/提示词/媒体，截断长文本，保留定位所需的路径与状态。 */
export function sanitizeDiagnostics(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return sanitizeString(value);
    if (typeof value !== "object") return String(value);
    if (depth >= 8) return "[truncated]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        const items = value.slice(0, 100).map((item) => sanitizeDiagnostics(item, depth + 1, seen));
        return value.length > 100 ? [...items, "[truncated]"] : items;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeDiagnostics(item, depth + 1, seen);
    }
    return result;
}

export type SetupDiagnosticsResult = { text: string; report: Record<string, unknown> };

/** 拉取网关诊断并按白名单脱敏后序列化；失败由调用方给一句短提示。 */
export async function fetchSetupDiagnostics(input: {
    workflowId?: string;
    sync?: LocalGatewaySyncStatus;
    root?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
} = {}): Promise<SetupDiagnosticsResult> {
    const root = (input.root ?? LOCAL_GATEWAY_ORIGIN).replace(/\/+$/, "");
    if (!root) throw new Error("diagnostics unavailable");
    const query = input.workflowId ? `?workflowId=${encodeURIComponent(input.workflowId)}` : "";
    const response = await (input.fetchImpl || fetch)(`${root}/api/setup/diagnostics${query}`, { cache: "no-store", signal: input.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const report = { workflowId: input.workflowId || null, client: { sync: input.sync || null }, gateway: payload ?? null };
    const sanitized = sanitizeDiagnostics(report) as Record<string, unknown>;
    return { report: sanitized, text: JSON.stringify(sanitized, null, 2) };
}

/** 显式“重新扫描”：优先刷新资源，失败再走 setup.scan。 */
export async function requestGatewayRescan(input: { root?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<{ source: "resources" | "setup" }> {
    const root = (input.root ?? LOCAL_GATEWAY_ORIGIN).replace(/\/+$/, "");
    if (!root) throw new Error("gateway unavailable");
    const fetchImpl = input.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30000);
    const post = (path: string) =>
        fetchImpl(`${root}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            cache: "no-store",
            signal: controller.signal,
        });
    try {
        let response: Response | null = null;
        try {
            response = await post("/api/resources/refresh");
        } catch {
            response = null;
        }
        if (response?.ok) return { source: "resources" };
        const fallback = await post("/api/setup/scan");
        if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
        return { source: "setup" };
    } finally {
        clearTimeout(timer);
    }
}
