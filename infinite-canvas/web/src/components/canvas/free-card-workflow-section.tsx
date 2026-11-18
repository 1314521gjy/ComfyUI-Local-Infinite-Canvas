import { ArrowLeftRight, Archive, ExternalLink, RefreshCw, Settings2 } from "lucide-react";
import { Button, Dropdown } from "antd";
import type { ReactNode } from "react";

import { SettingTitle } from "@/components/image-settings-panel";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { FreeWorkflowSource } from "@/services/api/free-workflow";
import type { CanvasFreeCardInfo } from "@/types/canvas";

export type FreeCardWorkflowSectionProps = {
    info: CanvasFreeCardInfo | null;
    sources: FreeWorkflowSource[];
    sourcesLoading: boolean;
    sourcesError: string;
    importing: boolean;
    archiving: boolean;
    sourceMissing: boolean;
    sourceChanged: boolean;
    warnings: string[];
    onSelectSource: (relative: string) => void;
    onRefreshSources: () => void;
    onArchive: () => void;
    onOpenComfyUI: () => void;
    onEdit?: () => void;
    pageSelector?: ReactNode;
};

export function FreeCardWorkflowSection({
    info,
    sources,
    sourcesLoading,
    sourcesError,
    importing,
    archiving,
    sourceMissing,
    sourceChanged,
    warnings,
    onSelectSource,
    onRefreshSources,
    onArchive,
    onOpenComfyUI,
    onEdit,
    pageSelector,
}: FreeCardWorkflowSectionProps) {
    const theme = useCanvasTheme();
    const switchItems = sources.map((source) => ({
        key: source.relative,
        label: `${source.name}${source.folder ? ` · ${source.folder}` : ""}${source.format === "ui" ? " · UI" : source.format === "api" ? " · API" : " · 不可用"}`,
        disabled: source.format === "invalid" || importing,
    }));
    if (info?.sourceRel && !switchItems.some((item) => item.key === info.sourceRel)) {
        switchItems.unshift({ key: info.sourceRel, label: info.sourceRel, disabled: false });
    }
    const pillClass = "!h-9 !w-full !rounded-full !px-3 !text-sm";
    const pillStyle = { background: "transparent", borderColor: theme.node.stroke, color: theme.node.text };
    return (
        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: theme.node.stroke }}>
            <div className="flex items-center justify-between gap-2">
                <SettingTitle color={theme.node.muted}>工作流</SettingTitle>
                <div className="flex items-center gap-1">
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            selectable: true,
                            selectedKeys: info?.sourceRel ? [info.sourceRel] : [],
                            items: switchItems,
                            onClick: ({ key }) => onSelectSource(key),
                        }}
                    >
                        <Button size="small" type="text" icon={<ArrowLeftRight className="size-3.5" />} className="!h-7 !w-7 !rounded-full !p-0" style={{ color: theme.node.muted }} disabled={!switchItems.length || importing} title="切换工作流" />
                    </Dropdown>
                    <Button size="small" type="text" icon={<RefreshCw className={`size-3.5 ${sourcesLoading ? "animate-spin" : ""}`} />} className="!h-7 !w-7 !rounded-full !p-0" style={{ color: theme.node.muted }} onClick={onRefreshSources} disabled={sourcesLoading} title="刷新工作流列表" />
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {onEdit ? (
                    <Button size="small" className={pillClass} style={pillStyle} icon={<Settings2 className="size-3.5" />} onClick={onEdit}>
                        编辑
                    </Button>
                ) : null}
                <Button size="small" className={pillClass} style={pillStyle} icon={<Archive className="size-3.5" />} loading={archiving} disabled={!info || sourceMissing || (info.archived && !info.snapshot)} onClick={onArchive}>
                    归档
                </Button>
                <Button size="small" className={`${pillClass} ${onEdit ? "col-span-2" : ""}`} style={pillStyle} icon={<ExternalLink className="size-3.5" />} disabled={!info || sourceMissing} onClick={onOpenComfyUI}>
                    在 ComfyUI 打开
                </Button>
            </div>
            {pageSelector ? <div>{pageSelector}</div> : null}
            {sourceMissing ? <div className="text-[11px] leading-4 text-red-500">{`源工作流不可用：${info?.sourceRel || "文件已删除或无法读取"}`}</div> : null}
            {info?.healthWarnings?.length ? (
                <div className="space-y-0.5 text-[11px] leading-4 text-red-500">
                    {info.healthWarnings.map((warning, index) => <div key={`${warning}-${index}`}>· {warning}</div>)}
                </div>
            ) : null}
            {sourceChanged ? <div className="text-[11px] leading-4 text-amber-500">源文件已更新，将自动同步</div> : null}
            {info?.archived ? <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>{info.snapshot ? "快照：不随源同步" : "已归档"}</div> : null}
            {warnings.length ? (
                <div className="space-y-0.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                    {warnings.map((warning, index) => (
                        <div key={`${warning}-${index}`}>· {warning}</div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
