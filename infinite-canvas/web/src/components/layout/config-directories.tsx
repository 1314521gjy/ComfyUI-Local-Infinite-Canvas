import { App, Button, Input, Radio } from "antd";
import { ChevronDown, FolderOpen, FolderSearch, Radar } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

type DirectorySettings = {
    mode: "auto" | "manual";
    comfyDir: string;
    modelDirs: string[];
    loraDirs: string[];
    customNodesDirs: string[];
    updatedAt?: string;
};

type DirectoryScan = {
    comfy: { dir: string; root: string; mainPy: string; workflowsDir: string; modelsDir: string; customNodesDir: string } | null;
    modelDirs: Array<{ dir: string; count: number; byKind: Record<string, number>; totalBytes: number; samples: string[]; truncated: boolean }>;
    loraDirs: Array<{ dir: string; count: number; totalBytes: number; samples: string[]; truncated: boolean }>;
    customNodesDirs: Array<{ dir: string; count: number; samples: string[] }>;
    totals: { models: number; loras: number; plugins: number };
};

type DirectoryInfo = {
    settings: DirectorySettings;
    comfyRoot: string;
    auto: { comfyDir: string; root: string; workflowsDir: string; modelDirs: string[]; loraDirs: string[]; customNodesDirs: string[] };
    setup?: { phase: string; counts?: { available: number; total: number; unavailable: number }; comfyReachable?: boolean };
    loadReport?: { restartRequired: boolean; missing: Array<{ kind: string; dir: string }> };
};

const emptySettings: DirectorySettings = { mode: "auto", comfyDir: "", modelDirs: [], loraDirs: [], customNodesDirs: [] };

const copyByLocale = {
    zh: {
        title: "ComfyUI 目录与资源扫描",
        description: "自动识别失败时，可以手动指定 ComfyUI、模型、LoRA 和插件目录；保存后会写入 ComfyUI 的 extra_model_paths.yaml（先备份），重启 ComfyUI 生效。",
        auto: "自动识别",
        manual: "手动指定",
        autoRoot: "已识别 ComfyUI",
        autoWorkflows: "工作流目录",
        autoScanning: "自动扫描中…",
        autoReady: "自动扫描完成",
        notSet: "未填写目录",
        autoFailed: "自动扫描失败：未识别到 ComfyUI 或工作流。请切换到「手动指定」选择目录。",
        autoMissing: "尚未识别到 ComfyUI；切换手动指定并填写目录。",
        comfyDir: "ComfyUI 目录",
        comfyDirHint: "例如 D:\\ComfyUI_windows_portable\\ComfyUI",
        modelDirs: "模型目录",
        modelDirsHint: "每行一个；下面的子目录（checkpoints / vae / text_encoders / diffusion_models / upscale_models 等）会被多层扫描",
        loraDirs: "LoRA 目录",
        loraDirsHint: "每行一个；会映射到 ComfyUI 的 loras 路径",
        customNodesDirs: "插件目录",
        customNodesDirsHint: "每行一个；指向包含各插件子目录的 custom_nodes 根目录",
        browse: "浏览…",
        pickTitle: "选择文件夹",
        scan: "检测目录",
        save: "保存并扫描",
        scanning: "正在扫描…",
        saving: "正在保存…",
        summary: "扫描结果",
        models: "模型",
        loras: "LoRA",
        plugins: "插件",
        nothing: "未发现文件",
        truncated: "目录层级过深或文件过多，结果已截断",
        restart: "目录已保存。请重启 ComfyUI 使新目录生效，资源卡与工作流可用性会在重启后刷新。",
        noRestart: "目录已在 ComfyUI 当前清单中，无需重启；已重新扫描。",
        restartHint: "这些目录还不在 ComfyUI 当前清单里，需要重启 ComfyUI 后才会生效。",
        restartComfy: "重启 ComfyUI 生效",
        restartTitle: "重启 ComfyUI？",
        restartContent: "会中断当前正在跑的任务，让新目录和 extra_model_paths.yaml 生效。",
        restartOk: "重启",
        restartCancel: "取消",
        restartDone: "ComfyUI 已重启，正在重新扫描目录与资源",
        restartFailed: "重启 ComfyUI 失败",
        backup: "原 extra_model_paths.yaml 已备份到",
        launcherFail: "未能通知启动器；已尝试写入 launcher/config.json，请重启启动器。",
        autoSwitched: "已切回自动识别，手动目录已从 ComfyUI 配置中移除。",
        error: "读取目录设置失败",
    },
    en: {
        title: "ComfyUI folders & resource scan",
        description: "If auto-detection fails, point the canvas at your ComfyUI, model, LoRA and custom-node folders. Saving writes a managed block into ComfyUI's extra_model_paths.yaml (the original is backed up); restart ComfyUI to apply.",
        auto: "Auto detect",
        manual: "Manual",
        autoRoot: "Detected ComfyUI",
        autoWorkflows: "Workflow folder",
        autoScanning: "Scanning automatically…",
        autoReady: "Automatic scan complete",
        notSet: "No folder set",
        autoFailed: "Automatic scan failed: no ComfyUI or workflows found. Switch to Manual and pick the folders.",
        autoMissing: "ComfyUI not detected yet. Switch to Manual and fill in the folders.",
        comfyDir: "ComfyUI folder",
        comfyDirHint: "e.g. D:\\ComfyUI_windows_portable\\ComfyUI",
        modelDirs: "Model folders",
        modelDirsHint: "One per line; subfolders such as checkpoints / vae / text_encoders / diffusion_models / upscale_models are scanned recursively",
        loraDirs: "LoRA folders",
        loraDirsHint: "One per line; mapped to ComfyUI's loras path",
        customNodesDirs: "Custom node folders",
        customNodesDirsHint: "One per line; point at the custom_nodes root that contains plugin subfolders",
        browse: "Browse…",
        pickTitle: "Choose a folder",
        scan: "Scan folders",
        save: "Save & scan",
        scanning: "Scanning…",
        saving: "Saving…",
        summary: "Scan result",
        models: "models",
        loras: "LoRAs",
        plugins: "plugins",
        nothing: "No files found",
        truncated: "Folder depth or file count limit reached; results are partial",
        restart: "Saved. Restart ComfyUI to apply the new folders; resource cards and workflow availability refresh after restart.",
        noRestart: "Folders are already in the current ComfyUI list; no restart needed. Rescanned.",
        restartHint: "These folders are not in the current ComfyUI list yet; restart ComfyUI to apply them.",
        restartComfy: "Restart ComfyUI",
        restartTitle: "Restart ComfyUI?",
        restartContent: "Running tasks will be interrupted so the new folders and extra_model_paths.yaml take effect.",
        restartOk: "Restart",
        restartCancel: "Cancel",
        restartDone: "ComfyUI restarted; rescanning folders and resources",
        restartFailed: "Failed to restart ComfyUI",
        backup: "Original extra_model_paths.yaml backed up to",
        launcherFail: "Could not notify the launcher; launcher/config.json was updated. Please restart the launcher.",
        autoSwitched: "Switched back to auto-detect; manual folders were removed from ComfyUI config.",
        error: "Failed to load folder settings",
    },
};

export function ConfigDirectories() {
    const { message, modal } = App.useApp();
    const { i18n } = useTranslation();
    const copy = i18n.language.startsWith("zh") ? copyByLocale.zh : copyByLocale.en;
    const [info, setInfo] = useState<DirectoryInfo | null>(null);
    const [mode, setMode] = useState<"auto" | "manual">("auto");
    const [comfyDir, setComfyDir] = useState("");
    const [modelDirs, setModelDirs] = useState("");
    const [loraDirs, setLoraDirs] = useState("");
    const [customNodesDirs, setCustomNodesDirs] = useState("");
    const [scan, setScan] = useState<DirectoryScan | null>(null);
    const [scanning, setScanning] = useState(false);
    const [saving, setSaving] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [restartRequired, setRestartRequired] = useState(false);
    const [picking, setPicking] = useState<"" | "comfy" | "model" | "lora" | "nodes">("");
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    const [error, setError] = useState("");

    const applySettings = (settings: DirectorySettings) => {
        setMode(settings.mode);
        setComfyDir(settings.comfyDir || "");
        setModelDirs((settings.modelDirs || []).join("\n"));
        setLoraDirs((settings.loraDirs || []).join("\n"));
        setCustomNodesDirs((settings.customNodesDirs || []).join("\n"));
    };

    useEffect(() => {
        let alive = true;
        fetch(`${gatewayRoot}/api/setup/directories`)
            .then((response) => response.json())
            .then((data: DirectoryInfo & { ok?: boolean; error?: { message?: string } }) => {
                if (!alive) return;
                if (data.error) throw new Error(data.error.message || copy.error);
                setInfo(data);
                applySettings(data.settings || emptySettings);
                setRestartRequired(data.settings?.mode === "manual" && Boolean(data.loadReport?.restartRequired));
            })
            .catch((loadError) => {
                if (alive) setError(loadError instanceof Error ? loadError.message : copy.error);
            });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (mode !== "auto" || info?.setup?.phase !== "scanning") return;
        const timer = window.setTimeout(async () => {
            try {
                const response = await fetch(`${gatewayRoot}/api/setup/directories`);
                const data = (await response.json()) as DirectoryInfo;
                setInfo((current) => (current ? { ...current, setup: data.setup, auto: data.auto } : data));
            } catch {
                /* 下一轮再试 */
            }
        }, 2000);
        return () => window.clearTimeout(timer);
    }, [info?.setup?.phase, mode]);

    const requestBody = () =>
        mode === "manual"
            ? { mode, comfyDir, modelDirs, loraDirs, customNodesDirs }
            : { mode: "auto", comfyDir: "", modelDirs: "", loraDirs: "", customNodesDirs: "" };

    const readError = async (response: Response) => {
        const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } | string };
        if (typeof data.error === "string") return data.error;
        return data.error?.message || `HTTP ${response.status}`;
    };

    const runScan = async () => {
        setScanning(true);
        setError("");
        setNote("");
        try {
            const response = await fetch(`${gatewayRoot}/api/setup/directories/scan`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...requestBody(), mode: "manual" }),
            });
            if (!response.ok) throw new Error(await readError(response));
            const data = (await response.json()) as { scan: DirectoryScan };
            setScan(data.scan);
        } catch (scanError) {
            setError(scanError instanceof Error ? scanError.message : String(scanError));
        } finally {
            setScanning(false);
        }
    };

    const save = async () => {
        setSaving(true);
        setError("");
        setNote("");
        try {
            const response = await fetch(`${gatewayRoot}/api/setup/directories`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requestBody()),
            });
            if (!response.ok) throw new Error(await readError(response));
            const data = (await response.json()) as {
                settings: DirectorySettings;
                scan: DirectoryScan;
                write?: { ok?: boolean; changed?: boolean; backup?: string; error?: string };
                launcherUpdated?: boolean;
                restartRequired?: boolean;
                note?: string;
            };
            applySettings(data.settings);
            setScan(data.scan);
            setRestartRequired(Boolean(data.restartRequired));
            setInfo((current) => (current ? { ...current, settings: data.settings } : current));
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
            window.dispatchEvent(new Event("local-gateway-refresh-resources"));
            if (mode === "auto") {
                message.success(copy.autoSwitched);
            } else {
                const restartNote = data.restartRequired ? copy.restart : copy.noRestart;
                message.success(data.note || restartNote);
                setNote(
                    [
                        restartNote,
                        data.write?.backup ? `${copy.backup} ${data.write.backup}` : "",
                        data.launcherUpdated === false ? copy.launcherFail : "",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                );
            }
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setSaving(false);
        }
    };

    const restartComfy = () => {
        modal.confirm({
            title: copy.restartTitle,
            content: copy.restartContent,
            okText: copy.restartOk,
            cancelText: copy.restartCancel,
            okButtonProps: { danger: true },
            onOk: async () => {
                setRestarting(true);
                try {
                    const response = await fetch(`${gatewayRoot}/api/system/restart-comfy`, { method: "POST" });
                    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
                    if (!response.ok || data.ok === false) throw new Error(data.error || copy.restartFailed);
                    message.success(copy.restartDone);
                    window.dispatchEvent(new Event("local-gateway-refresh-models"));
                    window.dispatchEvent(new Event("local-gateway-refresh-resources"));
                    window.setTimeout(() => {
                        void fetch(`${gatewayRoot}/api/setup/directories`)
                            .then((next) => next.json())
                            .then((next: DirectoryInfo) => setInfo((current) => (current ? { ...current, setup: next.setup, auto: next.auto } : next)))
                            .catch(() => undefined);
                    }, 3000);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : copy.restartFailed);
                    throw error;
                } finally {
                    setRestarting(false);
                }
            },
        });
    };

    const pick = async (field: "comfy" | "model" | "lora" | "nodes", initial: string, append: boolean) => {
        if (picking) return;
        setPicking(field);
        setError("");
        try {
            const response = await fetch(`${gatewayRoot}/api/setup/pick-directory`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: copy.pickTitle, initial }),
            });
            if (!response.ok) throw new Error(await readError(response));
            const data = (await response.json()) as { canceled?: boolean; path?: string };
            const selected = data.path;
            if (data.canceled || !selected) return;
            if (!append) {
                setComfyDir(selected);
                return;
            }
            const setter = field === "model" ? setModelDirs : field === "lora" ? setLoraDirs : setCustomNodesDirs;
            setter((current) => {
                const lines = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
                if (!lines.includes(selected)) lines.push(selected);
                return lines.join("\n");
            });
        } catch (pickError) {
            setError(pickError instanceof Error ? pickError.message : String(pickError));
        } finally {
            setPicking("");
        }
    };

    const browseButton = (field: "comfy" | "model" | "lora" | "nodes", initial: string, append: boolean) => (
        <Button size="small" type="text" className="!h-6 !px-1" icon={<FolderOpen className="size-3.5" />} loading={picking === field} disabled={Boolean(picking) && picking !== field} onClick={() => void pick(field, initial, append)}>
            {copy.browse}
        </Button>
    );

    const switchMode = (next: "auto" | "manual") => {
        setMode(next);
        setOpen(true);
        setError("");
        setRestartRequired(false);
        if (next === "auto") {
            setScan(null);
            void fetch(`${gatewayRoot}/api/setup/directories`)
                .then((response) => response.json())
                .then((data: DirectoryInfo) => setInfo((current) => (current ? { ...current, setup: data.setup, auto: data.auto } : data)))
                .catch(() => undefined);
            return;
        }
        if (!info) return;
        if (!comfyDir) setComfyDir(info.auto.comfyDir || info.auto.root || "");
        if (!modelDirs) setModelDirs((info.auto.modelDirs || []).join("\n"));
        if (!loraDirs) setLoraDirs((info.auto.loraDirs || []).join("\n"));
        if (!customNodesDirs) setCustomNodesDirs((info.auto.customNodesDirs || []).join("\n"));
    };

    const summary =
        mode === "auto"
            ? [
                  copy.auto,
                  info?.auto?.root || copy.notSet,
                  info?.setup?.phase === "ready"
                      ? `${info.setup?.counts?.available ?? 0}/${info.setup?.counts?.total ?? 0}`
                      : info?.setup?.phase === "scanning"
                        ? copy.autoScanning
                        : "",
              ]
                  .filter(Boolean)
                  .join(" · ")
            : [
                  copy.manual,
                  comfyDir || copy.notSet,
                  scan ? `${scan.totals.models} ${copy.models} / ${scan.totals.loras} ${copy.loras} / ${scan.totals.plugins} ${copy.plugins}` : "",
              ]
                  .filter(Boolean)
                  .join(" · ");

    return (
        <section className="mb-5 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <FolderSearch className="size-4" />
                        {copy.title}
                        <ChevronDown className={`size-4 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
                    </div>
                    <div className="mt-1 text-xs leading-5 text-stone-500">{open ? copy.description : summary}</div>
                </button>
                <Radio.Group value={mode} onChange={(event) => switchMode(event.target.value)} optionType="button" buttonStyle="solid" size="small">
                    <Radio.Button value="auto">{copy.auto}</Radio.Button>
                    <Radio.Button value="manual">{copy.manual}</Radio.Button>
                </Radio.Group>
            </div>

            {open ? (
                <div className="mt-3">
            {mode === "auto" ? (
                <div className="mt-3 rounded-md bg-stone-100 px-3 py-2 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                    {!info || info.setup?.phase === "scanning" ? (
                        <div>{copy.autoScanning}</div>
                    ) : info.auto?.root && (info.setup?.phase === "ready" || !info.setup) ? (
                        <>
                            <div className="font-medium text-stone-700 dark:text-stone-200">
                                {copy.autoReady} · {info.setup?.counts?.available ?? 0}/{info.setup?.counts?.total ?? 0}
                            </div>
                            <div>
                                {copy.autoRoot}: <code>{info.auto.root}</code>
                            </div>
                            <div>
                                {copy.autoWorkflows}: <code>{info.auto.workflowsDir || "—"}</code>
                            </div>
                        </>
                    ) : (
                        <div>
                            <div className="text-amber-700 dark:text-amber-300">{copy.autoFailed}</div>
                            <Button className="mt-2" size="small" onClick={() => switchMode("manual")}>
                                {copy.manual}
                            </Button>
                        </div>
                    )}
                </div>
            ) : (
                <div className="mt-3 space-y-3">
                    <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{copy.comfyDir}</span>
                            {browseButton("comfy", comfyDir, false)}
                        </div>
                        <Input value={comfyDir} onChange={(event) => setComfyDir(event.target.value)} placeholder="D:\\ComfyUI_windows_portable\\ComfyUI" />
                        <div className="mt-1 text-[11px] text-stone-500">{copy.comfyDirHint}</div>
                    </div>
                    <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{copy.modelDirs}</span>
                            {browseButton("model", modelDirs.split(/\r?\n/)[0]?.trim() || "", true)}
                        </div>
                        <Input.TextArea value={modelDirs} onChange={(event) => setModelDirs(event.target.value)} rows={2} placeholder="D:\\models" />
                        <div className="mt-1 text-[11px] text-stone-500">{copy.modelDirsHint}</div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                        <div>
                            <div className="mb-1 flex items-center justify-between gap-2">
                                <span className="text-xs font-medium">{copy.loraDirs}</span>
                                {browseButton("lora", loraDirs.split(/\r?\n/)[0]?.trim() || "", true)}
                            </div>
                            <Input.TextArea value={loraDirs} onChange={(event) => setLoraDirs(event.target.value)} rows={2} placeholder="D:\\models\\loras" />
                            <div className="mt-1 text-[11px] text-stone-500">{copy.loraDirsHint}</div>
                        </div>
                        <div>
                            <div className="mb-1 flex items-center justify-between gap-2">
                                <span className="text-xs font-medium">{copy.customNodesDirs}</span>
                                {browseButton("nodes", customNodesDirs.split(/\r?\n/)[0]?.trim() || "", true)}
                            </div>
                            <Input.TextArea value={customNodesDirs} onChange={(event) => setCustomNodesDirs(event.target.value)} rows={2} placeholder="D:\\ComfyUI\\custom_nodes" />
                            <div className="mt-1 text-[11px] text-stone-500">{copy.customNodesDirsHint}</div>
                        </div>
                    </div>
                </div>
            )}

            {mode === "manual" ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="small" icon={<Radar className="size-3.5" />} loading={scanning} disabled={saving} onClick={() => void runScan()}>
                        {scanning ? copy.scanning : copy.scan}
                    </Button>
                    <Button size="small" type="primary" loading={saving} disabled={scanning} onClick={() => void save()}>
                        {saving ? copy.saving : copy.save}
                    </Button>
                    {restartRequired ? (
                        <Button size="small" danger loading={restarting} onClick={restartComfy}>
                            {copy.restartComfy}
                        </Button>
                    ) : null}
                    {error ? <span className="text-xs text-red-500">{error}</span> : null}
                </div>
            ) : null}

            {mode === "manual" && restartRequired && !note ? <div className="mt-2 text-xs leading-5 text-amber-600 dark:text-amber-400">{copy.restartHint}</div> : null}

            {mode === "manual" && scan ? (
                <div className="mt-3 rounded-md border border-stone-200 px-3 py-2 text-xs leading-6 dark:border-stone-800">
                    <div className="mb-1 font-medium">{copy.summary}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-stone-600 dark:text-stone-300">
                        <span>
                            {copy.models}: <strong>{scan.totals.models}</strong>
                        </span>
                        <span>
                            {copy.loras}: <strong>{scan.totals.loras}</strong>
                        </span>
                        <span>
                            {copy.plugins}: <strong>{scan.totals.plugins}</strong>
                        </span>
                    </div>
                    {scan.comfy ? (
                        <div className="mt-1 text-stone-500">
                            ComfyUI: <code>{scan.comfy.root}</code> · {copy.autoWorkflows}: <code>{scan.comfy.workflowsDir || "—"}</code>
                        </div>
                    ) : null}
                    {scan.modelDirs.map((item) => (
                        <div key={`model-${item.dir}`} className="mt-1 text-stone-500">
                            <code>{item.dir}</code>：{item.count ? `${item.count} 个（${Object.entries(item.byKind).map(([kind, count]) => `${kind} ${count}`).join("，")}）` : copy.nothing}
                            {item.samples.length ? <div className="truncate opacity-70">{item.samples.slice(0, 6).join("、")}</div> : null}
                            {item.truncated ? <div className="text-amber-600 dark:text-amber-400">{copy.truncated}</div> : null}
                        </div>
                    ))}
                    {scan.loraDirs.map((item) => (
                        <div key={`lora-${item.dir}`} className="mt-1 text-stone-500">
                            <code>{item.dir}</code>：{item.count ? `${item.count} ${copy.loras}` : copy.nothing}
                            {item.samples.length ? <div className="truncate opacity-70">{item.samples.slice(0, 6).join("、")}</div> : null}
                        </div>
                    ))}
                    {scan.customNodesDirs.map((item) => (
                        <div key={`nodes-${item.dir}`} className="mt-1 text-stone-500">
                            <code>{item.dir}</code>：{item.count ? `${item.count} ${copy.plugins}` : copy.nothing}
                            {item.samples.length ? <div className="truncate opacity-70">{item.samples.slice(0, 8).join("、")}</div> : null}
                        </div>
                    ))}
                </div>
            ) : null}

            {mode === "manual" && note ? <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-amber-600 dark:text-amber-400">{note}</div> : null}
                </div>
            ) : null}
        </section>
    );
}
