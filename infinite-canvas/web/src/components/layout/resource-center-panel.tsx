import { App, Button, Checkbox, Progress, Select, Tag, Tooltip } from "antd";
import { AlertTriangle, Bot, ChevronDown, Download, HardDriveDownload, RefreshCw, Server, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    cancelResourceJob,
    fetchResourceJob,
    fetchResourceStatus,
    formatBytes,
    installResources,
    pickResourceReplacement,
    refreshResourceStatus,
    setResourceReplacement,
    setPackMainModel,
    setWorkflowVisibility,
    type ResourceItem,
    type ResourceJob,
    type ResourcePack,
    type ResourceStatus,
} from "@/services/api/resources";
import { isGatewayDown } from "@/services/api/gateway-status";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";

const copyByLocale = {
    zh: {
        title: "添加工作流",
        subtitle: "只下载缺失的资源；已有同名模型会直接复用，不会重复下载。",
        refresh: "重新扫描",
        installSelected: "安装选中",
        installPack: "安装此包",
        runtimeRiskTitle: "安装运行库会修改 ComfyUI 环境",
        runtimeRiskBody: "以下运行库会写入 ComfyUI 的 Python 环境：",
        runtimeRiskScope: "只会安装或替换这些运行库；不会改动 torch、CUDA 或 ComfyUI 本体。已有且可用的版本会自动跳过，不会覆盖。",
        runtimeRiskSage: "SageAttention 是 H3 必需项；已安装可用版本时会跳过，不覆盖。",
        runtimeNoMatchTitle: "没有匹配的预编译运行库",
        runtimeNoMatchBody: "当前 ComfyUI 环境不在预编译包覆盖范围内，画布不会自动安装，也不会猜版本。请按下面命令手动安装；其他资源继续下载。",
        runtimeBroken: "检测到已安装但无法导入；画布不会自动覆盖，请手动修复或交给 AI Agent。",
        runtimeRestartWarning: "自动安装完成后会重启 ComfyUI；正在运行的任务会中断，网关自己的下载不受影响。",
        runtimeAutoInstall: "画布自动安装",
        runtimeManualInstall: "自己手动安装",
        runtimeManualTitle: "手动安装命令",
        runtimeManualNote: "这些运行库未安装；装好后重启 ComfyUI。其他资源会继续下载。",
        runtimeManualClose: "知道了",
        runtimeRuntime: "本机环境",
        pipOutdated: "已安装版本较旧（{version}），可能无法运行；请手动升级，画布不会自动覆盖。",
        cancel: "终止安装",
        dismiss: "收起进度",
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
        workflowHint: "按工作流安装；资源齐备且已启用后才会出现在模型选择",
        installWorkflow: "安装此工作流",
        modelAliasPick: "选择本机文件",
        modelAliasHint: "不同量化/底模可能改变效果，请确认后再选",
        modelMatchTitle: "模型匹配",
        modelMatchHint: "只自动认路径/同名文件；量化或底模不同请手动确认",
        otherWorkflows: "其他工作流模型",
        otherWorkflowsHint: "ComfyUI 自动导入、且不在资源包里的工作流；一般不用管",
        modelAliasPickInstalled: "选择已安装模型",
        similarMatch: "相似匹配",
        similarTo: "匹配到",
        replaceModel: "自选替换",
        pickHint: "请在弹出的文件选择框中选择模型文件（默认已打开 ComfyUI 对应模型目录）",
        picking: "已打开文件选择窗口",
        replaceAgain: "更换",
        restoreDefault: "恢复默认",
        replaced: "已使用所选模型",
        replacedBy: "已替换为",
        workflowReady: "可用",
        workflowRestart: "待重启",
        workflowNode: "缺节点",
        workflowMismatch: "模型名未匹配",
        workflowRuntime: "缺运行库",
        workflowOffline: "未连接",
        workflowUnscanned: "未扫描",
        workflowMutedHint: "该工作流已从模型选择中屏蔽；勾选「启用」后才会参与模型选择。",
        workflowUnscannedHint: "该工作流尚未参与扫描；点「重新扫描」后查看结果。",
        sizeMismatchTag: "大小不一致",
        workflowEnabled: "启用",
        workflowDisabled: "已屏蔽",
        canvasEntry: "画布入口",
        visibilityHint: "勾选后才会出现在模型选择；不删除已下载资源",
        plugin: "插件",
        bakeRequires: "本地烘焙，依赖",
        optionalHint: "LoRA、低显存底模等，按需安装",
        optionalEmpty: "此包没有选下内容",
        optionalMissingLabel: "选下缺",
        hardwareDetected: "已识别",
        noHardware: "未识别到显卡，已显示全部版本，未做推荐。",
        noCompatible: "当前显卡暂无可推荐的版本，可展开查看全部。",
        incompatible: "显存紧张",
        blocked: "待前置资源",
        planned: "后续包",
        ready: "已齐全",
        size: "下载体积",
        sources: "下载源",
        autoMatch: "按本机 Python 自动匹配",
        pipManual: "当前 {version} 没有匹配的预编译运行库，请手动安装：{command}",
        localBake: "本地烘焙",
        noResources: "此包没有需要下载的资源。",
        downloadProgress: "安装进度",
        copying: "安装中",
        installing: "安装运行库",
        extracting: "解压中",
        done: "安装完成",
        failed: "部分资源安装失败",
        compileFailed: "本机编译失败",
        copyHint: "复制给 AI Agent",
        hintCopied: "已复制，直接发给你的 AI Agent",
        guideTitle: "添加工作流引导",
        guideBody: "先看扫描结果，缺什么勾选后安装。下载/安装成功不需要 Agent；只有下载失败、VDN 缺 Stage-B 或 TRT 编译失败时，才看页面底部的「下载/编译失败？」。",
        guideAgent: "交给本机 Agent",
        guideAgentCopy: "复制给本机 Agent",
        guideCopyFallback: "复制失败，请手动全选复制下面指令发给本机 Agent。",
        helpTitle: "扫描不到 / 识别不了 / 缺资源？",
        helpScan: "扫描不到 ComfyUI：展开上方「ComfyUI 目录与资源扫描」→「手动指定」→ 选择包含 main.py 的 ComfyUI 根目录（里面应有 models、custom_nodes）；保存并扫描。ComfyUI 需要先启动。",
        helpModel: "模型识别不了：在对应资源卡右侧点「自选替换」，选择本机实际模型文件。同名但大小不一致不是同一版本，建议重新下载或用「自选替换」。",
        helpMissing: "缺少资源：看「缺少 N / 下载体积」，勾选缺失包后点「安装选中」；可选内容在包内展开勾选。安装后出现「待重启」就重启 ComfyUI。",
        sizeMismatchHint: "处理：点右侧「自选替换」选本机文件，或重新下载资源包版本。",
        guideFailureTitle: "下载 / 编译失败？",
        guideFailureBody: "先完成上面的下载/安装。只有下载失败、VDN 缺 Stage-B 或 TRT 编译失败时，才复制修复指令给本机 Agent；成功下载不需要。",
        notReachable: "ComfyUI 未连接：模型文件仍按已识别的目录扫描；工作流可用性和自定义节点需 ComfyUI 在线后才能确认。",
        indexError: "资源索引读取失败：",
        indexWarning: "资源索引提示：",
        autoMatchRuntime: "按本机环境自动匹配",
        pipRestart: "安装后重启 ComfyUI 生效",
        selectHint: "选择需要安装的功能包；已具备的资源会自动跳过。",
        target: "目标",
        matchedBySize: "按文件体积匹配",
        license: "许可",
        note: "说明",
        emptyMissing: "所有必下资源都已具备。",
        scanFirst: "正在读取资源状态…",
        expand: "展开",
        collapse: "收起",
        mainModel: "主模型",
        mainModelDefault: "资源包默认",
        mainModelPack: "本包模型",
        mainModelLocal: "本地模型",
        mainModelOther: "其他本地模型",
        mainModelMissing: "未安装",
        mainModelSelected: "已用自选",
        mainModelActive: "工作流已激活",
    },
    en: {
        title: "Add workflows",
        subtitle: "Only missing files are downloaded. Existing models with the same name are reused.",
        refresh: "Rescan",
        installSelected: "Install selected",
        installPack: "Install pack",
        runtimeRiskTitle: "Installing runtimes changes the ComfyUI environment",
        runtimeRiskBody: "These runtimes will be installed into ComfyUI's Python environment:",
        runtimeRiskScope: "Only these runtimes are installed or replaced; torch, CUDA and ComfyUI itself are not changed. An existing usable version is skipped and never overwritten.",
        runtimeRiskSage: "SageAttention is required by H3; an existing usable version is skipped and not overwritten.",
        runtimeNoMatchTitle: "No matching prebuilt runtime",
        runtimeNoMatchBody: "This ComfyUI environment is outside the prebuilt wheel matrix. The app will not install automatically or guess a version. Install manually with the command below; other downloads continue.",
        runtimeBroken: "Installed but not importable. The app will not overwrite it automatically. Repair it manually or hand it to your AI agent.",
        runtimeRestartWarning: "Automatic installation restarts ComfyUI afterwards; running tasks are interrupted. Gateway downloads are not affected.",
        runtimeAutoInstall: "Install automatically",
        runtimeManualInstall: "I'll install manually",
        runtimeManualTitle: "Manual install commands",
        runtimeManualNote: "These runtimes were not installed; restart ComfyUI after installing them. Other downloads continue.",
        runtimeManualClose: "Got it",
        runtimeRuntime: "Detected",
        pipOutdated: "Installed version {version} is old and may not work. Upgrade manually; the app will not overwrite it.",
        cancel: "Stop install",
        dismiss: "Dismiss",
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
        workflowHint: "Install by workflow; only complete and enabled workflows appear in the model picker",
        installWorkflow: "Install workflow",
        modelAliasPick: "Pick a local file",
        modelAliasHint: "Different quantization/base models can change results; confirm before choosing",
        modelMatchTitle: "Model matching",
        modelMatchHint: "Only path/same-name matches are automatic; confirm quantized or different base models",
        otherWorkflows: "Other workflow models",
        otherWorkflowsHint: "Workflows auto-imported from ComfyUI that are not part of a resource pack; usually safe to ignore",
        modelAliasPickInstalled: "Choose installed model",
        similarMatch: "Similar match",
        similarTo: "Matched",
        replaceModel: "Choose replacement",
        pickHint: "Pick a model file in the dialog (it opens at the matching ComfyUI model folder)",
        picking: "File dialog opened",
        replaceAgain: "Change",
        restoreDefault: "Restore default",
        replaced: "Replaced with the selected model",
        replacedBy: "Replaced with",
        workflowReady: "Ready",
        workflowRestart: "Restart needed",
        workflowNode: "Missing nodes",
        workflowMismatch: "Model name not matched",
        workflowRuntime: "Missing runtime",
        workflowOffline: "Offline",
        workflowUnscanned: "Not scanned",
        workflowMutedHint: "This workflow is hidden from the model picker; enable it to participate.",
        workflowUnscannedHint: "This workflow was not included in the scan; click Rescan to check it.",
        sizeMismatchTag: "Size mismatch",
        workflowEnabled: "Enabled",
        workflowDisabled: "Hidden",
        canvasEntry: "Canvas entry",
        visibilityHint: "Only checked workflows appear in the model picker; downloaded resources are kept",
        plugin: "Plugin",
        bakeRequires: "Local bake requires",
        optionalHint: "LoRAs, low-VRAM checkpoints, and other extras",
        optionalEmpty: "No optional items in this pack",
        optionalMissingLabel: "Optional missing",
        hardwareDetected: "Detected",
        noHardware: "No GPU detected; showing all versions without recommendations.",
        noCompatible: "No recommended version for this GPU; expand to see all.",
        incompatible: "Low VRAM",
        blocked: "Waiting",
        planned: "Planned",
        ready: "Ready",
        size: "Download size",
        sources: "Sources",
        autoMatch: "Auto-matched to local Python",
        pipManual: "No prebuilt runtime matches {version}. Install manually: {command}",
        localBake: "Local bake",
        noResources: "This pack has no downloadable resources.",
        downloadProgress: "Install progress",
        copying: "Installing",
        installing: "Installing runtime",
        extracting: "Extracting",
        done: "Install complete",
        failed: "Some resources failed",
        compileFailed: "Local compile failed",
        copyHint: "Copy for your AI agent",
        hintCopied: "Copied — paste it to your AI agent",
        guideTitle: "Adding workflows",
        guideBody: "Check the scan results, select what is missing and install. A successful download does not need the agent. Only if download, VDN Stage-B or TensorRT compile fails, look at Download / compile failed? at the bottom.",
        guideAgent: "Hand to local agent",
        guideAgentCopy: "Copy for local agent",
        guideCopyFallback: "Copy failed. Select and copy the instructions below for your local agent.",
        helpTitle: "ComfyUI not found / model not recognized / missing resources?",
        helpScan: "ComfyUI not found: open the folder scan above, choose Manual, select the ComfyUI root containing main.py (it should contain models and custom_nodes), then save and scan. ComfyUI must be running.",
        helpModel: "Model not recognized: click Choose replacement on the resource card and pick the local model file. Same name with a different size is not the same build; re-download it or use Choose replacement.",
        helpMissing: "Missing resources: check Missing / download size, select the missing pack and click Install selected; optional items are inside the pack. Restart ComfyUI if Restart needed appears.",
        sizeMismatchHint: "Fix: use Choose replacement on the right, or re-download the resource-pack version.",
        guideFailureTitle: "Download / compile failed?",
        guideFailureBody: "Complete the download/install above first. Only if download, VDN Stage-B or TensorRT compile fails, copy the repair instructions to your local agent; a successful download does not need this.",
        notReachable: "ComfyUI is offline: model files are still scanned from detected folders; workflow availability and custom nodes need ComfyUI online.",
        indexError: "Failed to load the resource index: ",
        indexWarning: "Resource index notice: ",
        autoMatchRuntime: "Auto-matched to this machine",
        pipRestart: "Restart ComfyUI after installing",
        selectHint: "Select the packs to install; existing resources are skipped.",
        target: "Target",
        matchedBySize: "Matched by file size",
        license: "License",
        note: "Note",
        emptyMissing: "All required resources are ready.",
        scanFirst: "Loading resources…",
        expand: "Expand",
        collapse: "Collapse",
        mainModel: "Main model",
        mainModelDefault: "Pack default",
        mainModelPack: "Pack models",
        mainModelLocal: "Local models",
        mainModelOther: "Other local models",
        mainModelMissing: "Not installed",
        mainModelSelected: "Custom",
        mainModelActive: "Workflow active",
    },
};

type Copy = typeof copyByLocale.zh;

function runtimeLabel(item: ResourceItem) {
    const runtime = item.pipRuntime;
    if (!runtime) return item.pythonVersion ? `Python ${item.pythonVersion}` : "?";
    return [runtime.python ? `Python ${runtime.python}` : "", runtime.torch ? `Torch ${runtime.torch}` : "", runtime.cuda ? `CUDA ${runtime.cuda}` : ""]
        .filter(Boolean)
        .join(" / ") || "?";
}

function sourceSummary(item: ResourceItem, copy: Copy) {
    if (item.type === "pip") {
        if (item.pipRuntime?.torch || item.pipRuntime?.cuda) return `${copy.autoMatchRuntime} (${runtimeLabel(item)})`;
        const versions = item.wheelVersions || [];
        return versions.length ? `${copy.autoMatch} (${versions[0]}–${versions[versions.length - 1]})` : copy.autoMatch;
    }
    return `${copy.sources} ${item.sources.length}`;
}

function PipMissingHint({ item, copy }: { item: ResourceItem; copy: Copy }) {
    if (item.type !== "pip" || !item.pipWheelMissing || item.status === "present") return null;
    const command = `"${item.pythonRuntime || "python"}" -m pip install ${item.pipName || "llama-cpp-python"}`;
    return (
        <div className="mt-0.5 break-all text-[10px] leading-4 text-amber-600 dark:text-amber-400">
            {copy.pipManual.replace("{version}", runtimeLabel(item)).replace("{command}", command)}
        </div>
    );
}

function statusTag(item: ResourceItem, copy: Copy) {
    if (item.overridden) return <Tag color="blue">{copy.mainModelSelected}</Tag>;
    if (item.status === "present") return <Tag color="green">{copy.present}</Tag>;
    if (item.status === "blocked") return <Tag color="gold">{copy.blocked}</Tag>;
    return <Tag color="orange">{copy.missing}</Tag>;
}

function packState(pack: ResourcePack, copy: Copy) {
    if (pack.planned) return <Tag>{copy.planned}</Tag>;
    if (!pack.missing) return <Tag color="green">{copy.ready}</Tag>;
    return <Tag color="orange">{copy.missing} {pack.missing}</Tag>;
}

function formatSpeed(bytesPerSecond: number) {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    return value > 0 ? `${formatBytes(value)}/s` : "";
}

const REPLACEABLE_MODEL_DIRS = new Set(["diffusion_models", "text_encoders", "vae", "loras", "checkpoints", "upscale_models", "vdn", "LLM"]);

function isReplaceableResource(item: ResourceItem) {
    if (item.type !== "model" && item.type !== "bake") return false;
    const dir = String(item.target || "").replace(/\\/g, "/").split("/")[0];
    return REPLACEABLE_MODEL_DIRS.has(dir);
}

function ResourceCard({
    item,
    copy,
    compact = false,
    optional = false,
    selected = false,
    onToggle,
    onReplace,
    onRestore,
    replacing = false,
}: {
    item: ResourceItem;
    copy: Copy;
    compact?: boolean;
    optional?: boolean;
    selected?: boolean;
    onToggle?: (checked: boolean) => void;
    onReplace?: (item: ResourceItem) => void;
    onRestore?: (item: ResourceItem) => void;
    replacing?: boolean;
}) {
    const canReplace = Boolean(onReplace) && isReplaceableResource(item);
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
                        {item.matchedBy === "similar" ? <Tag color="gold" className="m-0">{copy.similarMatch}</Tag> : null}
                        {statusTag(item, copy)}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-stone-400 dark:text-stone-500">{item.target}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-stone-400 dark:text-stone-500">
                        <span>{sourceSummary(item, copy)}</span>
                        <span>{formatBytes(item.size)}</span>
                        {!compact && item.license ? <span>{copy.license}: {item.license}</span> : null}
                    </div>
                    {item.matchedBy === "size" && item.matchedFile ? <div className="mt-0.5 text-[10px] leading-4 text-stone-400 dark:text-stone-500">{copy.matchedBySize}: {item.matchedFile}</div> : null}
                    {item.matchedBy === "similar" && item.matchedFile ? (
                        <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">
                            {copy.similarTo}: {item.matchedFile}
                            {item.similarScore ? ` · ${Math.round(item.similarScore * 100)}%` : ""}
                        </div>
                    ) : null}
                    {item.sizeMismatch ? (
                        <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">
                            {item.sizeMismatch}
                            <div className="mt-0.5 text-stone-500 dark:text-stone-400">{copy.sizeMismatchHint}</div>
                        </div>
                    ) : null}
                    {item.overridden && item.overriddenBy ? <div className="mt-0.5 text-[10px] leading-4 text-blue-600 dark:text-blue-300">{copy.replacedBy}: {item.overriddenBy}</div> : null}
                    <PipMissingHint item={item} copy={copy} />
                    {item.type === "pip" && item.restartAfterInstall && item.status === "present" ? <div className="mt-0.5 text-[10px] leading-4 text-stone-500 dark:text-stone-400">{copy.pipRestart}</div> : null}
                    {item.type === "pip" && item.pipOutdated && item.status === "present" ? <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{copy.pipOutdated.replace("{version}", item.pipVersion || "?")}</div> : null}
                    {item.type === "pip" && item.pipBroken ? <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{copy.runtimeBroken}</div> : null}
                    {!compact && item.note ? <div className="mt-0.5 text-[10px] leading-4 text-stone-400 dark:text-stone-500">{copy.note}: {item.note}</div> : null}
                    {canReplace ? (
                        <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
                            {item.overridden ? <Button size="small" type="text" disabled={replacing} onClick={() => onRestore?.(item)}>{copy.restoreDefault}</Button> : null}
                            <Button size="small" type="text" loading={replacing} title={copy.modelAliasHint} onClick={() => onReplace?.(item)}>
                                {item.overridden ? copy.replaceAgain : copy.replaceModel}
                            </Button>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function WorkflowResourceRow({
    item,
    copy,
    requires = [],
    onReplace,
    onRestore,
    replacing = false,
}: {
    item: ResourceItem;
    copy: Copy;
    requires?: ResourceItem[];
    onReplace?: (item: ResourceItem) => void;
    onRestore?: (item: ResourceItem) => void;
    replacing?: boolean;
}) {
    const canReplace = Boolean(onReplace) && isReplaceableResource(item);
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
                    <span>{sourceSummary(item, copy)}</span>
                    <span>{formatBytes(item.size)}</span>
                </div>
                {item.matchedBy === "size" && item.matchedFile ? <div className="mt-0.5 text-[10px] text-stone-400 dark:text-stone-500">{copy.matchedBySize}: {item.matchedFile}</div> : null}
                {item.sizeMismatch ? (
                    <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        {item.sizeMismatch}
                        <div className="mt-0.5 text-stone-500 dark:text-stone-400">{copy.sizeMismatchHint}</div>
                    </div>
                ) : null}
                {item.overridden && item.overriddenBy ? <div className="mt-0.5 text-[10px] text-blue-600 dark:text-blue-300">{copy.replacedBy}: {item.overriddenBy}</div> : null}
                <PipMissingHint item={item} copy={copy} />
                {item.type === "pip" && item.restartAfterInstall && item.status === "present" ? <div className="mt-0.5 text-[10px] leading-4 text-stone-500 dark:text-stone-400">{copy.pipRestart}</div> : null}
                {item.type === "pip" && item.pipOutdated && item.status === "present" ? <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{copy.pipOutdated.replace("{version}", item.pipVersion || "?")}</div> : null}
                {item.type === "pip" && item.pipBroken ? <div className="mt-0.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{copy.runtimeBroken}</div> : null}
                {item.type === "bake" && requires.length ? (
                    <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">{copy.bakeRequires}: {requires.map((entry) => entry.label).join(" + ")}</div>
                ) : null}
            </div>
            {canReplace ? (
                <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                    {item.overridden ? <Button size="small" type="text" disabled={replacing} onClick={() => onRestore?.(item)}>{copy.restoreDefault}</Button> : null}
                    <Button size="small" type="text" loading={replacing} title={copy.modelAliasHint} onClick={() => onReplace?.(item)}>
                        {item.overridden ? copy.replaceAgain : copy.replaceModel}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

export function ResourceCenterPanel({ compact = false, footer }: { compact?: boolean; footer?: React.ReactNode }) {
    const { message, modal } = App.useApp();
    // 网关断线由统一横幅提示，这里不再逐条弹错。
    const showError = (error: unknown) => {
        if (isGatewayDown()) return;
        message.error(error instanceof Error ? error.message : String(error));
    };
    const { i18n } = useTranslation();
    const copy = i18n.language.startsWith("zh") ? copyByLocale.zh : copyByLocale.en;
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
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
    const [mainModelSaving, setMainModelSaving] = useState("");
    const [replacementSaving, setReplacementSaving] = useState("");
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

    const dismissJob = useCallback(() => {
        setJob(null);
        setSpeeds({});
        speedSamples.current.clear();
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
        const refresh = () => {
            void fetchResourceStatus().then(applyStatus).catch(() => undefined);
        };
        window.addEventListener("local-gateway-refresh-resources", refresh);
        return () => window.removeEventListener("local-gateway-refresh-resources", refresh);
    }, [applyStatus]);

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
                    // 取消后不再保留常驻进度条；完成/失败保留面板，用户可手动收起。
                    if (next.status === "canceled") setJob(null);
                    else if (next.status === "done") message.success(copy.done);
                    else message.error(next.message || copy.failed);
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

    const confirmRuntimeInstall = (items: ResourceItem[]) =>
        new Promise<"auto" | "manual">((resolve) => {
            modal.confirm({
                title: copy.runtimeRiskTitle,
                width: 560,
                content: (
                    <div className="space-y-3 text-sm">
                        <div>{copy.runtimeRiskBody}</div>
                        <div className="space-y-2">
                            {items.map((item) => (
                                <div key={item.id} className="rounded-md border border-stone-200 p-2 dark:border-stone-800">
                                    <div className="font-medium">{item.label}</div>
                                    <div className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">{copy.runtimeRuntime}: {runtimeLabel(item)}</div>
                                    {item.id === "sage_h3" ? <div className="mt-1 text-[11px] leading-4 text-amber-600 dark:text-amber-400">{copy.runtimeRiskSage}</div> : null}
                                </div>
                            ))}
                        </div>
                        <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.runtimeRiskScope}</div>
                        <div className="text-xs leading-5 text-amber-600 dark:text-amber-400">{copy.runtimeRestartWarning}</div>
                    </div>
                ),
                okText: copy.runtimeAutoInstall,
                cancelText: copy.runtimeManualInstall,
                onOk: () => resolve("auto"),
                onCancel: () => resolve("manual"),
            });
        });

    const manualCommandFor = (item: ResourceItem) => `"${item.pythonRuntime || "python"}" -m pip install --no-deps ${item.pipName || item.label}`;

    const agentPromptFor = (item: ResourceItem) =>
        [
            `请在我的 ComfyUI 环境里安装/修复「${item.label}」（${item.pipName || item.label}）。`,
            "只处理这个运行库，不要升级或替换 torch、CUDA、ComfyUI 本体或其他包。",
            `环境：${runtimeLabel(item)}；ComfyUI Python：${item.pythonRuntime || "?"}`,
            `手动命令：${manualCommandFor(item)}`,
            item.pipBroken ? `当前已安装但无法导入，版本：${item.pipVersion || "?"}` : "没有匹配的预编译包。",
            "安装后验证 import sageattention 和 get_cuda_arch_versions，再重启 ComfyUI；失败请把完整报错贴给我。",
        ].join("\n");

    const agentPromptForResource = (detail = "") =>
        [
            "请在这台 Windows 机器上帮我处理无界工作台的 ComfyUI 资源安装 / 编译问题。",
            `ComfyUI 目录：${status?.comfyRoot || "未知"}；资源索引：${status?.indexVersion || "未知"}`,
            "如果是 H3 VDN：检查 models/vdn/stage-dmd-step-250 下的 linear_branch/model.safetensors、adapters/default/adapter_model.safetensors、adapters/default/adapter_config.json、adapters/turbo、model_spec.json、metadata.json 是否齐全；缺什么补什么，保留内部目录结构，完成后重启 ComfyUI。",
            "如果是 H3 TensorRT VAE engine：确认本机 tensorrt 与 CUDA/驱动匹配，再运行 comfyui-gateway/scripts/build-h3-trt-vae.py（使用资源提示里的完整命令）；失败请把完整报错贴给我。",
            "不要升级或替换 torch、CUDA、ComfyUI 本体；不要动其他模型；完成后列出改动文件、命令和验证结果。",
            detail ? `当前错误/提示：\n${detail}` : "",
        ].filter(Boolean).join("\n");

    const handoffToAgent = async (detail = "") => {
        const prompt = agentPromptForResource(detail);
        if (LOCAL_ONLY) {
            try {
                await navigator.clipboard.writeText(prompt);
                message.success(copy.hintCopied);
            } catch {
                modal.info({
                    title: copy.guideAgentCopy,
                    width: 640,
                    content: (
                        <div className="space-y-2 text-sm">
                            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.guideCopyFallback}</div>
                            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-100 p-2 text-[11px] leading-4 text-stone-700 dark:bg-stone-900 dark:text-stone-200">{prompt}</pre>
                        </div>
                    ),
                    okText: copy.runtimeManualClose,
                });
            }
            return;
        }
        setConfigDialogOpen(false);
        window.dispatchEvent(new Event("canvas-onboarding-close"));
        useAgentStore.getState().setAgentState({ prompt, activeTab: "chat" });
        useAgentStore.getState().openPanel();
    };

    const startInstall = async (input: { ids?: string[]; packs?: string[] }) => {
        if (!input.ids?.length && !input.packs?.length) {
            message.info(copy.emptyMissing);
            return;
        }
        let nextInput = input;
        const pipItems = (input.ids || [])
            .map((id) => status?.resources.find((item) => item.id === id))
            .filter((item): item is ResourceItem => Boolean(item && item.type === "pip" && item.status !== "present"));
        const autoItems = pipItems.filter((item) => !item.pipWheelMissing);
        const noMatchItems = pipItems.filter((item) => item.pipWheelMissing || item.pipBroken);
        const skippedIds = new Set<string>();
        if (noMatchItems.length) {
            for (const item of noMatchItems) skippedIds.add(item.id);
            modal.info({
                title: copy.runtimeNoMatchTitle,
                width: 560,
                content: (
                    <div className="space-y-2 text-sm">
                        <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.runtimeNoMatchBody}</div>
                        {noMatchItems.map((item) => (
                            <div key={item.id} className="rounded-md border border-stone-200 p-2 dark:border-stone-800">
                                <div className="font-medium">{item.label}</div>
                                <div className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">{copy.runtimeRuntime}: {runtimeLabel(item)}</div>
                                {item.pipBroken ? <div className="mt-1 text-[11px] leading-4 text-amber-600 dark:text-amber-400">{copy.runtimeBroken}</div> : null}
                                <code className="mt-1 block break-all text-xs text-stone-600 dark:text-stone-300">{manualCommandFor(item)}</code>
                                <div className="mt-1 flex justify-end">
                                    <Button size="small" onClick={() => void copyHintText(agentPromptFor(item))}>{copy.copyHint}</Button>
                                </div>
                            </div>
                        ))}
                        <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.runtimeManualNote}</div>
                    </div>
                ),
                okText: copy.runtimeManualClose,
            });
        }
        if (autoItems.length) {
            const choice = await confirmRuntimeInstall(autoItems);
            if (choice === "manual") {
                for (const item of autoItems) skippedIds.add(item.id);
                modal.info({
                    title: copy.runtimeManualTitle,
                    width: 560,
                    content: (
                        <div className="space-y-2 text-sm">
                            {autoItems.map((item) => (
                                <div key={item.id} className="rounded-md border border-stone-200 p-2 dark:border-stone-800">
                                    <div className="font-medium">{item.label}</div>
                                    <code className="mt-1 block break-all text-xs text-stone-600 dark:text-stone-300">{manualCommandFor(item)}</code>
                                </div>
                            ))}
                            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{copy.runtimeManualNote}</div>
                        </div>
                    ),
                    okText: copy.runtimeManualClose,
                });
            }
        }
        if (skippedIds.size) {
            const restIds = (input.ids || []).filter((id) => !skippedIds.has(id));
            if (!restIds.length) return;
            nextInput = { ids: restIds };
        }
        try {
            const next = await installResources(nextInput);
            watchJob(next);
        } catch (installError) {
            showError(installError);
        }
    };

    const stopInstall = async () => {
        if (!job || job.status !== "running" || stopping) return;
        setStopping(true);
        try {
            const next = await cancelResourceJob(job.id);
            if (next.status === "canceled") setJob(null);
            else setJob(next);
        } catch (stopError) {
            showError(stopError);
        } finally {
            setStopping(false);
        }
    };

    const copyHintText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            message.success(copy.hintCopied);
        } catch (copyError) {
            message.error(copyError instanceof Error ? copyError.message : String(copyError));
        }
    };

    const recommendationAvailable = Boolean(status?.recommendationAvailable);
    const hardwareName = status?.hardware?.gpuName || "";
    const recommendedPresent = status?.summary.present || 0;
    const recommendedTotal = status?.summary.resources || 0;
    const recommendedMissing = status?.summary.missing || 0;
    const recommendedMissingSize = status?.summary.missingSize || 0;
    const visiblePacks = status?.packs || [];

    const installIds = useMemo(() => {
        if (!status) return [];
        const required = status.packs
            .filter((pack) => selectedPacks.has(pack.id) && !pack.planned)
            .flatMap((pack) => pack.requiredItems.filter((item) => item.status !== "present").map((item) => item.id));
        const optional = status.resources.filter((item) => selectedOptional.has(item.id) && item.status !== "present").map((item) => item.id);
        return [...new Set([...required, ...optional])];
    }, [selectedOptional, selectedPacks, status]);

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

    const toggleWorkflowEnabled = async (id: string, enabled: boolean) => {
        try {
            await setWorkflowVisibility(id, enabled);
            setStatus((current) => current ? {
                ...current,
                packs: current.packs.map((pack) => ({
                    ...pack,
                    workflowDependencies: pack.workflowDependencies?.map((workflow) => (workflow.id === id ? { ...workflow, enabled } : workflow)),
                })),
            } : current);
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
        } catch (toggleError) {
            showError(toggleError);
        }
    };

    const replaceResource = async (item: ResourceItem) => {
        if (replacementSaving) return;
        setReplacementSaving(item.id);
        message.info(copy.picking);
        try {
            const file = await pickResourceReplacement(item.id);
            if (!file) return;
            setStatus(await setResourceReplacement(item.id, file));
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
            message.success(copy.replaced);
        } catch (error) {
            showError(error);
        } finally {
            setReplacementSaving("");
        }
    };

    const restoreResource = async (item: ResourceItem) => {
        setReplacementSaving(item.id);
        try {
            setStatus(await setResourceReplacement(item.id, ""));
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
        } catch (error) {
            showError(error);
        } finally {
            setReplacementSaving("");
        }
    };

    const switchMainModel = async (packId: string, file: string) => {
        if (mainModelSaving) return;
        setMainModelSaving(packId);
        try {
            const next = await setPackMainModel(packId, file);
            setStatus(next);
            window.dispatchEvent(new Event("local-gateway-refresh-models"));
        } catch (changeError) {
            showError(changeError);
        } finally {
            setMainModelSaving("");
        }
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
            <div data-onboarding="resource-center" className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-900/60 dark:bg-sky-950/20">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <Bot className="size-4 text-sky-600 dark:text-sky-300" />
                    {copy.guideTitle}
                </div>
                <div className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-300">{copy.guideBody}</div>
            </div>
            <details data-onboarding="resource-help" className="rounded-xl border border-stone-200 bg-white/60 p-3 text-xs dark:border-stone-800 dark:bg-white/[.02]">
                <summary className="cursor-pointer font-medium text-stone-700 dark:text-stone-200">{copy.helpTitle}</summary>
                <div className="mt-2 space-y-1.5 leading-5 text-stone-600 dark:text-stone-300">
                    <p>{copy.helpScan}</p>
                    <p>{copy.helpModel}</p>
                    <p>{copy.helpMissing}</p>
                </div>
            </details>
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
                        <Button size="small" data-onboarding="resource-refresh" icon={<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />} loading={refreshing} onClick={() => void load(true)}>
                            {copy.refresh}
                        </Button>
                        <Button size="small" type="primary" data-onboarding="resource-install" icon={<Download className="size-3.5" />} disabled={!installIds.length || Boolean(job && ["running"].includes(job.status))} onClick={() => void startInstall({ ids: installIds })}>
                            {copy.installSelected}
                        </Button>
                    </div>
                </div>
                {status && !status.comfyReachable ? <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="size-3.5" />{copy.notReachable}</div> : null}
                {status?.indexError ? <div className="mt-2 break-all text-[11px] text-amber-600 dark:text-amber-400"><span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-3.5 shrink-0" />{copy.indexError}</span>{status.indexError}</div> : null}
                {!status?.indexError && status?.indexWarning ? <div className="mt-2 break-all text-[11px] text-stone-500 dark:text-stone-400"><span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-3.5 shrink-0" />{copy.indexWarning}</span>{status.indexWarning}</div> : null}
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
                            ) : (
                                <Button size="small" type="text" aria-label={copy.dismiss} title={copy.dismiss} onClick={dismissJob}>
                                    <X className="size-3.5" />
                                </Button>
                            )}
                        </div>
                    </div>
                    <Progress percent={job.progress} size="small" status={job.status === "error" ? "exception" : job.status === "done" ? "success" : "active"} />
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto text-[11px]">
                        {job.items.map((item) => (
                            <div key={item.id} className="space-y-0.5">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="min-w-0 truncate text-stone-600 dark:text-stone-300">{item.label}</span>
                                    <span className={item.status === "error" ? "shrink-0 text-red-500" : "shrink-0 text-stone-400 dark:text-stone-500"}>
                                        {item.status === "downloading"
                                            ? `${formatBytes(item.bytes)} / ${formatBytes(item.size)}${speeds[item.id] ? ` · ${formatSpeed(speeds[item.id])}` : ""}`
                                            : item.status === "copying" ? copy.copying : item.status === "installing" ? copy.installing : item.status === "extracting" ? copy.extracting : item.status === "baking" ? copy.localBake : item.status}
                                    </span>
                                </div>
                                {item.status === "error" && item.error ? (
                                    <div className="line-clamp-2 break-words pl-1 text-[10px] text-red-500" title={item.error}>{item.error}</div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                    {job.items.some((item) => item.hint) ? (
                        <div className="mt-2 space-y-2">
                            {job.items.filter((item) => item.hint).map((item) => (
                                <div
                                    key={`${item.id}-hint`}
                                    className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                                >
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <span className="flex min-w-0 items-center gap-1 font-medium">
                                            <AlertTriangle className="size-3.5 shrink-0" />
                                            <span className="truncate">{copy.compileFailed} · {item.label}</span>
                                        </span>
                                        <div className="flex shrink-0 gap-1">
                                            <Button size="small" onClick={() => void handoffToAgent(item.hint || "")}>{LOCAL_ONLY ? copy.guideAgentCopy : copy.guideAgent}</Button>
                                            <Button size="small" onClick={() => void copyHintText(item.hint || "")}>{copy.copyHint}</Button>
                                        </div>
                                    </div>
                                    <div className="whitespace-pre-wrap break-all text-[10px] leading-4">{item.hint}</div>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="space-y-4 rounded-2xl bg-stone-100/60 p-2.5 dark:bg-white/[0.03]">
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
                    const expandable = pack.total > 0 || pack.optionalTotal > 0 || workflowDependencies.length > 0;
                    const optionalLabel = pack.optionalLabel?.trim() || copy.optionalSection;
                    const mainModel = pack.mainModel;
                    const mainModelOptions = mainModel
                        ? [
                              { value: "", label: `${copy.mainModelDefault} · ${mainModel.defaultLabel}` },
                              ...(mainModel.options.some((option) => option.source === "pack")
                                  ? [{
                                        label: copy.mainModelPack,
                                        options: mainModel.options
                                            .filter((option) => option.source === "pack")
                                            .map((option) => ({
                                                value: option.file,
                                                label: option.installed ? option.label : `${option.label} · ${copy.mainModelMissing}`,
                                                disabled: !option.installed && option.file !== mainModel.selected,
                                            })),
                                    }]
                                  : []),
                              ...(mainModel.options.some((option) => option.source === "local" && option.matches !== false)
                                  ? [{
                                        label: copy.mainModelLocal,
                                        options: mainModel.options
                                            .filter((option) => option.source === "local" && option.matches !== false)
                                            .map((option) => ({
                                                value: option.file,
                                                label: option.installed ? option.label : `${option.label} · ${copy.mainModelMissing}`,
                                                disabled: !option.installed && option.file !== mainModel.selected,
                                            })),
                                    }]
                                  : []),
                              ...(mainModel.options.some((option) => option.source === "local" && option.matches === false)
                                  ? [{
                                        label: copy.mainModelOther,
                                        options: mainModel.options
                                            .filter((option) => option.source === "local" && option.matches === false)
                                            .map((option) => ({
                                                value: option.file,
                                                label: option.installed ? option.label : `${option.label} · ${copy.mainModelMissing}`,
                                                disabled: !option.installed && option.file !== mainModel.selected,
                                            })),
                                    }]
                                  : []),
                          ]
                        : [];
                    const headerBody = (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{pack.label}</span>
                                {pack.recommended ? <Tag color="blue">{copy.recommended}</Tag> : null}
                                {pack.offload ? <Tag color="gold">{copy.offload}</Tag> : null}
                                {pack.optional && !pack.recommended ? <Tag>{copy.optional}</Tag> : null}
                                {pack.eligible === false ? <Tag color="red">{copy.incompatible}</Tag> : null}
                                {packState(pack, copy)}
                                {workflowDependencies.length ? <Tag>{copy.workflowSection} {workflowDependencies.length}</Tag> : null}
                                {extraOptionalItems.length ? <Tag>{optionalLabel} {extraOptionalItems.length}</Tag> : null}
                                {pack.missingSize ? <span className="text-[11px] text-stone-500 dark:text-stone-400">{copy.size} {formatBytes(pack.missingSize)}</span> : null}
                            </div>
                        </>
                    );
                    return (
                        <div
                            key={pack.id}
                            className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_28px_-20px_rgba(15,23,42,0.45)] transition-colors hover:border-stone-300 dark:border-stone-700/80 dark:bg-stone-900/70 dark:shadow-[0_1px_3px_rgba(0,0,0,0.55)] dark:hover:border-stone-600"
                            title={pack.description}
                        >
                            <div className="flex items-start gap-2 p-3">
                                {expandable ? (
                                    !pack.planned && pack.total > 0 ? (
                                        <Checkbox checked={selectedPacks.has(pack.id)} disabled={!pack.missing} onChange={(event) => togglePack(pack.id, event.target.checked)} />
                                    ) : (
                                        <span className="mt-0.5 grid size-4 place-items-center text-stone-300 dark:text-stone-600">·</span>
                                    )
                                ) : null}
                                {expandable ? (
                                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleExpanded(pack.id)} aria-expanded={expanded}>
                                        {headerBody}
                                    </button>
                                ) : (
                                    <div className="min-w-0 flex-1">{headerBody}</div>
                                )}
                                {expandable ? (
                                    <button type="button" className="mt-0.5 rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300" onClick={() => toggleExpanded(pack.id)} aria-label={expanded ? copy.collapse : copy.expand}>
                                        <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                                    </button>
                                ) : null}
                            </div>
                            {expandable && expanded ? (
                                <div className="border-t border-stone-100 px-3 pb-3 pt-2 dark:border-stone-800/70">
                                    {workflowDependencies.length ? (
                                        <>
                                            <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{copy.workflowSection}</span>
                                                <span className="text-stone-400 dark:text-stone-500">{copy.workflowHint}</span>
                                            </div>
                                            <div className="space-y-2">
                                                {workflowDependencies.map((workflow, index) => {
                                                    const workflowExpanded = expandedWorkflows.has(workflow.id);
                                                    const problemTypes = new Set((workflow.problems || []).map((problem) => problem.type));
                                                    const problemText = workflow.problems.map((problem) => problem.message).filter(Boolean).join("；");
                                                    const nodeMissing = problemTypes.has("node");
                                                    const restartOnly = problemTypes.size > 0 && [...problemTypes].every((type) => type === "restart");
                                                    const runtimeMissing = problemTypes.has("runtime");
                                                    const offline = problemTypes.has("offline");
                                                    const workflowMuted = workflow.enabled === false;
                                                    const workflowTag = workflow.missing
                                                        ? <Tag color="orange">{copy.missing} {workflow.missing}</Tag>
                                                        : workflow.available
                                                            ? <Tag color="green">{copy.workflowReady}</Tag>
                                                            : offline
                                                                ? <Tag color="red">{copy.workflowOffline}</Tag>
                                                                : workflowMuted
                                                                    ? <Tag title={copy.workflowMutedHint}>{copy.workflowDisabled}</Tag>
                                                                    : nodeMissing
                                                                        ? <Tag color="red" title={problemText}>{copy.workflowNode}</Tag>
                                                                        : restartOnly
                                                                            ? <Tag color="gold" title={problemText}>{copy.workflowRestart}</Tag>
                                                                            : runtimeMissing
                                                                                ? <Tag color="red" title={problemText}>{copy.workflowRuntime}</Tag>
                                                                                : workflow.problems?.length
                                                                                    ? <Tag color="gold" title={problemText}>{copy.workflowMismatch}</Tag>
                                                                                    : <Tag title={copy.workflowUnscannedHint}>{copy.workflowUnscanned}</Tag>;
                                                    return (
                                                        <div
                                                            key={workflow.id}
                                                            className={`rounded-lg border transition-colors ${
                                                                workflow.enabled === false
                                                                    ? "border-stone-200 bg-stone-50/40 dark:border-stone-800 dark:bg-white/[.01]"
                                                                    : "workflow-active border-emerald-300/70 bg-emerald-50/30 dark:border-emerald-800/60 dark:bg-emerald-950/15"
                                                            }`}
                                                            style={{ animationDelay: `${index * 0.28}s` }}
                                                        >
                                                            <div className="flex items-start gap-2 p-2">
                                                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleWorkflow(workflow.id)} aria-expanded={workflowExpanded}>
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className={`text-xs font-medium ${workflow.enabled === false ? "text-stone-400 dark:text-stone-500" : "text-stone-800 dark:text-stone-100"}`}>{workflow.label}</span>
                                                                        {workflow.recommended ? <Tag color="blue" className="m-0">{copy.recommended}</Tag> : null}
                                                                        {workflow.missingSize ? <span className="text-[10px] text-stone-400 dark:text-stone-500">{formatBytes(workflow.missingSize)}</span> : null}
                                                                        {workflowTag}
                                                                    </div>
                                                                    <div className={`truncate text-[10px] ${workflow.enabled === false ? "text-stone-400 dark:text-stone-500" : "text-emerald-700/70 dark:text-emerald-300/60"}`}>{workflow.id}</div>
                                                                    {!workflow.available && problemText ? (
                                                                        <div className="mt-0.5 truncate text-[10px] leading-4 text-amber-600 dark:text-amber-400" title={problemText}>{problemText}</div>
                                                                    ) : null}
                                                                    {Object.values(workflow.variantLabels || {}).length ? (
                                                                        <div className="mt-0.5 truncate text-[10px] text-stone-400 dark:text-stone-500">{Object.values(workflow.variantLabels || {}).join(" · ")}</div>
                                                                    ) : null}
                                                                </button>
                                                                {workflow.modelVisible === false ? (
                                                                    <Tag className="m-0 mt-1 shrink-0">{copy.canvasEntry}</Tag>
                                                                ) : (
                                                                    <Tooltip title={copy.visibilityHint}>
                                                                        <span
                                                                            className="mt-1 flex shrink-0 cursor-pointer select-none items-center gap-1.5"
                                                                            onClick={(event) => {
                                                                                event.stopPropagation();
                                                                                void toggleWorkflowEnabled(workflow.id, workflow.enabled === false);
                                                                            }}
                                                                        >
                                                                            <Checkbox
                                                                                checked={workflow.enabled !== false}
                                                                                onClick={(event) => event.stopPropagation()}
                                                                                onChange={(event) => void toggleWorkflowEnabled(workflow.id, event.target.checked)}
                                                                            />
                                                                            <span className={`min-w-8 text-[10px] ${workflow.enabled === false ? "text-stone-400 dark:text-stone-500" : "text-emerald-600 dark:text-emerald-400"}`}>
                                                                                {workflow.enabled === false ? copy.workflowDisabled : copy.workflowEnabled}
                                                                            </span>
                                                                        </span>
                                                                    </Tooltip>
                                                                )}
                                                                <button type="button" className="mt-1 rounded-lg p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300" onClick={() => toggleWorkflow(workflow.id)} aria-label={workflowExpanded ? copy.collapse : copy.expand}>
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
                                                                                onReplace={(resource) => void replaceResource(resource)}
                                                                                onRestore={(resource) => void restoreResource(resource)}
                                                                                replacing={replacementSaving === item.id}
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
                                            {extraOptionalItems.length ? (
                                                <>
                                                    <div className="mt-3 mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                                                        <span className="font-medium text-stone-600 dark:text-stone-300">{optionalLabel}</span>
                                                        <span className="text-stone-400 dark:text-stone-500">
                                                            {`${copy.optionalMissingLabel} ${extraOptionalMissing.length}${extraOptionalSize ? ` · ${formatBytes(extraOptionalSize)}` : ""}`}
                                                        </span>
                                                    </div>
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
                                                                onReplace={(resource) => void replaceResource(resource)}
                                                                onRestore={(resource) => void restoreResource(resource)}
                                                                replacing={replacementSaving === item.id}
                                                            />
                                                        ))}
                                                    </div>
                                                </>
                                            ) : null}
                                        </>
                                    ) : (
                                        <>
                                            {pack.requiredItems.length ? (
                                                <>
                                                    <div className="mb-1.5 flex items-center justify-between text-[11px]">
                                                        <span className="font-medium text-stone-600 dark:text-stone-300">{copy.requiredSection}</span>
                                                        <span className="text-stone-400 dark:text-stone-500">{pack.present}/{pack.total}{pack.missingSize ? ` · ${copy.size} ${formatBytes(pack.missingSize)}` : ""}</span>
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        {pack.requiredItems.map((item) => (
                                                            <ResourceCard
                                                                key={item.id}
                                                                item={item}
                                                                copy={copy}
                                                                compact={compact}
                                                                onReplace={(resource) => void replaceResource(resource)}
                                                                onRestore={(resource) => void restoreResource(resource)}
                                                                replacing={replacementSaving === item.id}
                                                            />
                                                        ))}
                                                    </div>
                                                </>
                                            ) : null}
                                            <div className={`${pack.requiredItems.length ? "mt-3" : ""} mb-1.5 flex items-center justify-between text-[11px]`}>
                                                <span className="font-medium text-stone-600 dark:text-stone-300">{optionalLabel}</span>
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
                                                            onReplace={(resource) => void replaceResource(resource)}
                                                            onRestore={(resource) => void restoreResource(resource)}
                                                            replacing={replacementSaving === item.id}
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

            <div data-onboarding="resource-problem" className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
                        <AlertTriangle className="size-4 shrink-0" />
                        {copy.guideFailureTitle}
                    </div>
                    <Button size="small" data-onboarding="resource-agent-help" icon={<Bot className="size-3.5" />} onClick={() => void handoffToAgent()}>
                        {LOCAL_ONLY ? copy.guideAgentCopy : copy.guideAgent}
                    </Button>
                </div>
                <div className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-300">{copy.guideFailureBody}</div>
            </div>

            {footer}
        </div>
    );
}
