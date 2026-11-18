import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Clapperboard, Play, Plus, Search, Trash2, Upload } from "lucide-react";
import { Input, Modal, Popconfirm, Switch, message } from "antd";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { DRAMA_STYLE_GROUPS, findDramaStyle } from "@/lib/short-drama/styles";
import { DEFAULT_CHAPTER_PATTERN, buildEpisodesFromChapters, episodeSynopsis, splitNovelChapters, type DramaChapter, type DramaImportedEpisode } from "@/lib/short-drama/import";
import { LOCAL_GATEWAY_CHANNEL_ID, LOCAL_GATEWAY_MODELS } from "@/constant/app-mode";
import type { CanvasDramaCardData, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

const WORKFLOW_OPTIONS = LOCAL_GATEWAY_MODELS.map((model) => ({
    value: `${LOCAL_GATEWAY_CHANNEL_ID}::${model.name}`,
    label: model.label || model.name,
    capability: model.capability,
}));
const IMAGE_WORKFLOWS = WORKFLOW_OPTIONS.filter((option) => option.capability === "image");
const VIDEO_WORKFLOWS = WORKFLOW_OPTIONS.filter((option) => option.capability === "video");
const VIDEO_WORKFLOWS_BY_MODE = {
    frames: VIDEO_WORKFLOWS.filter((option) => option.value.includes("video-h3-ref2va")),
    reference: VIDEO_WORKFLOWS.filter((option) => option.value.includes("video-h3-ref2va")),
} as const;

const WORKFLOW_PREFIX = `${LOCAL_GATEWAY_CHANNEL_ID}::`;

function videoWorkflowId(value?: string) {
    return value?.startsWith(WORKFLOW_PREFIX) ? value.slice(WORKFLOW_PREFIX.length) : "";
}

function workflowForVideoMode(value: string | undefined, _mode: "frames" | "reference") {
    const novdn = videoWorkflowId(value).endsWith("-novdn");
    return `${WORKFLOW_PREFIX}${novdn ? "video-h3-ref2va-novdn" : "video-h3-ref2va"}`;
}

const ACCENT = "#8b5cf6";
const ASPECTS = [
    { value: "16:9", label: "16:9 横屏（默认）" },
    { value: "9:16", label: "9:16 竖屏" },
    { value: "4:3", label: "4:3 横屏" },
    { value: "3:4", label: "3:4 竖屏" },
    { value: "1:1", label: "1:1 方形" },
];
const VIDEO_RESOLUTIONS = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
] as const;
const RESOURCE_TABS = [
    { value: "characters", label: "角色", empty: "暂无本剧角色库记录，可在制作页面「加入本剧库」" },
    { value: "scenes", label: "场景", empty: "暂无本剧场景库记录，可在制作页面「加入本剧库」" },
    { value: "props", label: "道具", empty: "暂无本剧道具库记录，可在制作页面「加入本剧库」" },
] as const;

export function ShortDramaCard({
    node,
    onChange,
    onStartCreation,
    onGenerateStoryboard,
    onPauseCreation,
    onFocusAsset,
    onAddStage,
    onSetSceneRefMode,
}: {
    node: CanvasNodeData;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
    onStartCreation?: (episodeId: string) => Promise<void> | void;
    onGenerateStoryboard?: (episodeId: string, options?: { fromScratch?: boolean }) => Promise<void> | void;
    onPauseCreation?: () => void;
    onFocusAsset?: (nodeId: string) => void;
    onAddStage?: (characterName: string, stageName: string, description: string) => Promise<void> | void;
    onSetSceneRefMode?: (name: string, mode: "auto" | "off") => void;
}) {
    const theme = useCanvasTheme();
    const data = node.metadata?.dramaCard;
    const [styleOpen, setStyleOpen] = useState(false);
    const [styleQuery, setStyleQuery] = useState("");
    const [resourceQuery, setResourceQuery] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const [startingEpisodeId, setStartingEpisodeId] = useState<string | null>(null);
    const [storyboardEpisodeId, setStoryboardEpisodeId] = useState<string | null>(null);
    const [resourcePage, setResourcePage] = useState(1);
    const [stageTarget, setStageTarget] = useState<string | null>(null);
    const [stageName, setStageName] = useState("");
    const [stageDescription, setStageDescription] = useState("");
    const [stageSaving, setStageSaving] = useState(false);
    const [importStep, setImportStep] = useState<"config" | "preview">("config");
    const [fileName, setFileName] = useState("");
    const [rawText, setRawText] = useState("");
    const [chapterPattern, setChapterPattern] = useState(DEFAULT_CHAPTER_PATTERN);
    const [chaptersPerEpisode, setChaptersPerEpisode] = useState(1);
    const [previewChapters, setPreviewChapters] = useState<DramaChapter[]>([]);
    const [previewEpisodes, setPreviewEpisodes] = useState<DramaImportedEpisode[]>([]);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const filteredGroups = useMemo(() => {
        const query = styleQuery.trim().toLowerCase();
        return DRAMA_STYLE_GROUPS.map((group) => ({
            label: group.label,
            options: query ? group.options.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(query)) : group.options,
        })).filter((group) => group.options.length > 0);
    }, [styleQuery]);
    const videoMode: "reference" = "reference";
    const videoWorkflowOptions = VIDEO_WORKFLOWS_BY_MODE.reference;

    useEffect(() => {
        if (!data) return;
        if (data.videoWorkflow && videoWorkflowOptions.some((option) => option.value === data.videoWorkflow)) return;
        const next = workflowForVideoMode(data.videoWorkflow, videoMode);
        if (next === data.videoWorkflow) return;
        onChange({ dramaCard: { ...data, videoWorkflow: next } });
    }, [data?.videoWorkflow, data?.videoMode]);

    useEffect(() => {
        if (!data || data.imageWorkflow) return;
        onChange({ dramaCard: { ...data, imageWorkflow: `${WORKFLOW_PREFIX}image-qwen21` } });
    }, [data?.imageWorkflow]);

    const patchDrama = (patch: Partial<CanvasDramaCardData>) => {
        if (!data) return;
        onChange({ dramaCard: { ...data, ...patch } });
    };

    if (!data) return null;
    const runPending = (episodeId: string) => Boolean(data.runs?.[episodeId]?.items.some((item) => !item.done));
    const hasRun = (episodeId: string) => Boolean(data.runs?.[episodeId]);
    const runDone = (episodeId: string) => data.runs?.[episodeId]?.items.filter((item) => item.done).length || 0;
    const runTotal = (episodeId: string) => data.runs?.[episodeId]?.items.length || 0;
    const activeTab = RESOURCE_TABS.find((tab) => tab.value === data.activeTab) || RESOURCE_TABS[0];
    const selectedStyle = findDramaStyle(data.style);
    const library = data.assets || { characters: [], scenes: [], props: [] };
    const records = library[data.activeTab] || [];
    const resourceKeyword = resourceQuery.trim().toLowerCase();
    const filteredRecords = resourceKeyword ? records.filter((record) => `${record.name} ${record.description}`.toLowerCase().includes(resourceKeyword)) : records;
    const pageSize = 20;
    const pageCount = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
    const currentPage = Math.min(resourcePage, pageCount);
    const pageRecords = filteredRecords.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const stateLabel = { pending: "待生成", loading: "生成中", done: "已生成", error: "失败" } as const;

    const openStage = (name: string, description: string) => {
        setStageTarget(name);
        setStageName(`造型 ${(records.find((record) => record.name === name)?.stages?.length || 0) + 1}`);
        setStageDescription(description);
    };
    const submitStage = async () => {
        if (!stageTarget || !onAddStage || stageSaving) return;
        if (!stageName.trim()) {
            message.warning("请输入造型名称");
            return;
        }
        setStageSaving(true);
        try {
            await onAddStage(stageTarget, stageName.trim(), stageDescription.trim());
            setStageTarget(null);
            setStageName("");
            setStageDescription("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加造型失败");
        } finally {
            setStageSaving(false);
        }
    };

    const fieldStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text } as const;
    const sectionStyle = { background: theme.node.panel, borderColor: theme.node.stroke } as const;

    const addEpisode = () => {
        patchDrama({
            episodes: [...data.episodes, { id: `ep-${Date.now()}`, title: `第 ${data.episodes.length + 1} 集`, synopsis: "", shots: 0, draft: true }],
        });
    };

    const removeEpisode = (id: string) => {
        patchDrama({ episodes: data.episodes.filter((episode) => episode.id !== id) });
        message.success("已删除该集");
    };

    const startCreation = async (episodeId: string) => {
        if (!onStartCreation || startingEpisodeId) return;
        setStartingEpisodeId(episodeId);
        try {
            await onStartCreation(episodeId);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建失败");
        } finally {
            setStartingEpisodeId(null);
        }
    };

    const openImport = () => {
        setImportStep("config");
        setFileName("");
        setRawText("");
        setChapterPattern(DEFAULT_CHAPTER_PATTERN);
        setChaptersPerEpisode(1);
        setPreviewChapters([]);
        setPreviewEpisodes([]);
        setImportOpen(true);
    };

    const onImportFile = (file?: File) => {
        if (!file) return;
        setFileName(file.name);
        setPreviewChapters([]);
        setPreviewEpisodes([]);
        const reader = new FileReader();
        reader.onload = (event) => setRawText(String(event.target?.result || ""));
        reader.onerror = () => message.error("读取文件失败");
        reader.readAsText(file, "utf-8");
    };

    const confirmImportConfig = () => {
        if (!rawText.trim()) {
            message.warning("请先选择 TXT 文件");
            return;
        }
        try {
            const chapters = splitNovelChapters(rawText, chapterPattern);
            const episodes = buildEpisodesFromChapters(chapters, chaptersPerEpisode, data.episodes.length + 1);
            if (!episodes.length) {
                message.warning("未生成可导入的集数");
                return;
            }
            setPreviewChapters(chapters);
            setPreviewEpisodes(episodes);
            setImportStep("preview");
            message.success(`已识别 ${chapters.length} 章，可导入 ${episodes.length} 集`);
        } catch (error) {
            setPreviewChapters([]);
            setPreviewEpisodes([]);
            message.error(error instanceof Error ? error.message : "章节预览失败");
        }
    };

    const confirmImportEpisodes = () => {
        if (!previewEpisodes.length) {
            message.warning("请先完成预览");
            return;
        }
        const episodes = [
            ...data.episodes,
            ...previewEpisodes.map((episode) => ({
                id: `ep-${Date.now()}-${episode.episodeNumber}`,
                title: episode.title,
                synopsis: episodeSynopsis(episode.script),
                shots: 0,
                draft: true,
                script: episode.script,
            })),
        ];
        patchDrama({ episodes });
        setImportOpen(false);
        message.success(`已导入 ${previewEpisodes.length} 集`);
    };

    return (
        <div
            className="thin-scrollbar h-full w-full overflow-y-auto p-4"
            style={{ background: theme.node.fill }}
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {data.progress ? (
                <div className="mb-3 rounded-xl border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                    <div className="flex items-center justify-between text-[12px]">
                        <span>正在生成 · {data.progress.stage}</span>
                        <span className="flex items-center gap-2">
                            <span style={{ color: theme.node.muted }}>{data.progress.total ? `${data.progress.current}/${data.progress.total}` : "准备中"}</span>
                            {onPauseCreation ? (
                                <button
                                    type="button"
                                    className="rounded-md border px-2 py-0.5 text-[11px] transition hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                    disabled={Boolean(data.paused)}
                                    onClick={() => onPauseCreation()}
                                >
                                    {data.paused ? "暂停中…" : "暂停"}
                                </button>
                            ) : null}
                        </span>
                    </div>
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                        <div
                            className="h-full rounded-full transition-all"
                            style={{
                                width: `${data.progress.total ? Math.min(100, Math.max(6, (data.progress.current / data.progress.total) * 100)) : 18}%`,
                                background: ACCENT,
                            }}
                        />
                    </div>
                </div>
            ) : data.paused ? (
                <div className="mb-3 rounded-xl border px-3 py-2 text-[12px]" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                    已暂停 · 点「继续生成」从断点继续，或点「重跑」从头来
                </div>
            ) : null}
            <div className="flex flex-col gap-3">
                <section className="rounded-xl border p-4" style={sectionStyle}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-[14px] font-semibold">剧集信息</div>
                        <button
                            type="button"
                            className="flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10"
                            style={fieldStyle}
                            onClick={() => {
                                setStyleQuery("");
                                setStyleOpen(true);
                            }}
                        >
                            <span className="size-4 shrink-0 rounded-[4px]" style={{ backgroundImage: selectedStyle ? `url(${selectedStyle.thumb})` : "none", backgroundColor: ACCENT, backgroundSize: "cover", backgroundPosition: "center" }} />
                            <span className="max-w-[120px] truncate">{selectedStyle?.label || "选择画风"}</span>
                            <ChevronDown className="size-3.5 opacity-55" />
                        </button>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                        <span className="w-[72px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>标题</span>
                        <input
                            value={data.title}
                            onChange={(event) => patchDrama({ title: event.target.value })}
                            placeholder="输入剧集标题"
                            className="h-8 w-full max-w-[420px] rounded-lg border px-2.5 text-[12px] outline-none"
                            style={fieldStyle}
                        />
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                        <span className="w-[72px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>画面比例</span>
                        <select
                            value={data.aspect}
                            onChange={(event) => patchDrama({ aspect: event.target.value })}
                            className="h-8 w-full max-w-[240px] rounded-lg border px-2 text-[12px] outline-none"
                            style={fieldStyle}
                        >
                            {ASPECTS.map((item) => (
                                <option key={item.value} value={item.value}>{item.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                        <span className="w-[72px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>生图工作流</span>
                        <select
                            value={data.imageWorkflow || ""}
                            onChange={(event) => patchDrama({ imageWorkflow: event.target.value })}
                            className="h-8 w-full max-w-[420px] rounded-lg border px-2 text-[12px] outline-none"
                            style={fieldStyle}
                        >
                            <option value="">选择生图工作流</option>
                            {IMAGE_WORKFLOWS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                        <span className="w-[72px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>生视频工作流</span>
                        <select
                            value={data.videoWorkflow || ""}
                            onChange={(event) => patchDrama({ videoWorkflow: event.target.value })}
                            className="h-8 w-full max-w-[420px] rounded-lg border px-2 text-[12px] outline-none"
                            style={fieldStyle}
                        >
                            <option value="">选择生视频工作流</option>
                            {videoWorkflowOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                        <span className="w-[72px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>分辨率</span>
                        <div className="flex shrink-0 items-center gap-1.5">
                            {VIDEO_RESOLUTIONS.map((item) => {
                                const active = (data.vquality || "720") === item.value;
                                return (
                                    <button
                                        key={item.value}
                                        type="button"
                                        className="h-7 rounded-lg border px-2.5 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10"
                                        style={{ borderColor: active ? ACCENT : theme.node.stroke, color: active ? ACCENT : theme.node.text, background: active ? `${ACCENT}1a` : "transparent" }}
                                        onClick={() => patchDrama({ vquality: item.value })}
                                    >
                                        {item.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>

                <section className="rounded-xl border p-4" style={sectionStyle}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-baseline gap-2">
                            <span className="text-[14px] font-semibold">分集列表</span>
                            <span className="text-[11px]" style={{ color: theme.node.muted }}>共 {data.episodes.length} 集</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" onClick={openImport}>
                                <Upload className="size-3.5 opacity-65" />
                                批量导入剧集
                            </button>
                            <button
                                type="button"
                                className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10"
                                style={{ borderColor: ACCENT, color: ACCENT }}
                                onClick={addEpisode}
                            >
                                <Plus className="size-3.5" />
                                新增一集
                            </button>
                        </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-3">
                        {data.episodes.map((episode, index) => (
                            <div key={episode.id} className="group relative rounded-xl border p-3 transition hover:shadow-sm" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                <Popconfirm title="删除这一集？" okText="删除" cancelText="取消" onConfirm={() => removeEpisode(episode.id)}>
                                    <button type="button" className="absolute right-2 top-2 grid size-6 place-items-center rounded-md opacity-35 transition hover:bg-black/5 hover:opacity-80 dark:hover:bg-white/10" aria-label="删除本集">
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </Popconfirm>
                                <div className="text-[11px]" style={{ color: theme.node.muted }}>第 {index + 1} 集</div>
                                <div className="mt-1 truncate text-[13px] font-medium">{episode.title}</div>
                                <div className="mt-1 line-clamp-2 h-8 text-[11px] leading-4" style={{ color: theme.node.muted }}>{episode.synopsis || "暂无简介"}</div>
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="text-[11px]" style={{ color: ACCENT }}>{episode.shots} 分镜</span>
                                    {episode.draft ? (
                                        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: theme.node.fill, color: theme.node.muted }}>草稿</span>
                                    ) : null}
                                </div>
                                <div className="mt-2 flex items-center gap-3 border-t pt-2" style={{ borderColor: theme.node.stroke }}>
                                    <button type="button" className="flex items-center gap-1 text-[11px] opacity-75 transition hover:opacity-100 disabled:opacity-40" disabled={Boolean(startingEpisodeId) || Boolean(data.progress)} onClick={() => void startCreation(episode.id)}>
                                        <Play className="size-3" />
                                        {startingEpisodeId === episode.id ? "创建中…" : "开始创作"}
                                    </button>
                                    <button
                                        type="button"
                                        className="flex items-center gap-1 text-[11px] opacity-75 transition hover:opacity-100 disabled:opacity-40"
                                        title={!episode.script?.trim() ? "这一集还没有剧本，先导入 TXT 或粘贴剧本" : undefined}
                                        disabled={Boolean(storyboardEpisodeId) || Boolean(data.progress) || !onGenerateStoryboard || !episode.script?.trim()}
                                        onClick={async () => {
                                            if (!onGenerateStoryboard) return;
                                            setStoryboardEpisodeId(episode.id);
                                            try {
                                                await onGenerateStoryboard(episode.id);
                                            } catch (error) {
                                                message.error(error instanceof Error ? error.message : "分镜生成失败");
                                            } finally {
                                                setStoryboardEpisodeId(null);
                                            }
                                        }}
                                    >
                                        <Clapperboard className="size-3" />
                                        {storyboardEpisodeId === episode.id
                                            ? "分镜生成中…"
                                            : runPending(episode.id)
                                              ? `继续生成 (${runDone(episode.id)}/${runTotal(episode.id)})`
                                              : `生成分镜${data.storyboards?.[episode.id]?.length ? ` (${data.storyboards[episode.id].length})` : ""}`}
                                    </button>
                                    {hasRun(episode.id) && onGenerateStoryboard ? (
                                        <button
                                            type="button"
                                            className="flex items-center gap-1 text-[11px] opacity-60 transition hover:opacity-100 disabled:opacity-40"
                                            title="清空续跑记录，重新建卡生成"
                                            disabled={Boolean(storyboardEpisodeId) || Boolean(data.progress) || !episode.script?.trim()}
                                            onClick={async () => {
                                                setStoryboardEpisodeId(episode.id);
                                                try {
                                                    await onGenerateStoryboard(episode.id, { fromScratch: true });
                                                } catch (error) {
                                                    message.error(error instanceof Error ? error.message : "分镜生成失败");
                                                } finally {
                                                    setStoryboardEpisodeId(null);
                                                }
                                            }}
                                        >
                                            重跑
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                        {!data.episodes.length ? (
                            <div className="col-span-3 grid h-24 place-items-center rounded-xl border border-dashed text-[12px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                还没有分集，点右上角「新增一集」
                            </div>
                        ) : null}
                    </div>
                </section>

                <section className="rounded-xl border p-4" style={sectionStyle}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-4">
                            <span className="text-[13px] font-semibold">资源库</span>
                            <div className="flex items-center gap-3">
                                {RESOURCE_TABS.map((tab) => (
                                    <button
                                        key={tab.value}
                                        type="button"
                                        className="relative pb-1 text-[12px] transition"
                                        style={{ color: data.activeTab === tab.value ? theme.node.text : theme.node.muted, fontWeight: data.activeTab === tab.value ? 600 : 400 }}
                                        onClick={() => patchDrama({ activeTab: tab.value })}
                                    >
                                        {tab.label}
                                        {data.activeTab === tab.value ? <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full" style={{ background: ACCENT }} /> : null}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button type="button" className="h-7 rounded-lg px-2 text-[11px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => message.info("制作资源待接入")}>
                            制作资源
                        </button>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                        <div className="relative w-[220px]">
                            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 opacity-45" />
                            <Input
                                value={resourceQuery}
                                onChange={(event) => setResourceQuery(event.target.value)}
                                placeholder={`搜索${activeTab.label}`}
                                size="small"
                                className="pl-7"
                                style={fieldStyle}
                            />
                        </div>
                        <button type="button" className="h-7 rounded-lg border px-2 text-[11px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.node.stroke }} onClick={() => message.info("从素材库导入待接入")}>
                            从素材库导入
                        </button>
                    </div>

                    <div className="mt-2">
                        {pageRecords.map((record) => (
                            <div key={record.id} className="flex items-center gap-2 border-b py-1.5 last:border-b-0" style={{ borderColor: theme.node.stroke }}>
                                <div className="h-8 w-14 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                                    {record.imageUrl ? (
                                        <img src={record.imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                                    ) : (
                                        <div className="grid h-full place-items-center text-[10px]" style={{ color: theme.node.muted }}>{record.state === "loading" ? "生成中" : "无图"}</div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate text-[12px]">{record.name}</span>
                                        <span className="shrink-0 text-[10px]" style={{ color: record.state === "error" ? "#f87171" : theme.node.muted }}>{stateLabel[record.state]}</span>
                                        {record.kind === "scene" && record.state === "done" ? (
                                            <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: theme.node.fill, color: record.usedReference ? ACCENT : theme.node.muted }}>
                                                {record.usedReference ? "参考" : "文生"}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="truncate text-[10px]" style={{ color: theme.node.muted }}>
                                        {record.kind === "scene" && record.locationKey ? `${record.locationKey}${record.variant ? ` · ${record.variant}` : ""}` : record.description || "—"}
                                    </div>
                                </div>
                                {record.kind === "scene" && record.baseNodeId && onSetSceneRefMode ? (
                                    <label className="flex shrink-0 items-center gap-1 text-[10px]" style={{ color: theme.node.muted }} title="同基址后续变体是否以首图为参考">
                                        <Switch size="small" checked={record.refMode !== "off"} onChange={(checked) => onSetSceneRefMode(record.name, checked ? "auto" : "off")} />
                                        参考首图
                                    </label>
                                ) : null}
                                {record.nodeId && onFocusAsset ? (
                                    <button type="button" className="h-6 shrink-0 rounded-md px-1.5 text-[10px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => onFocusAsset(record.nodeId!)}>
                                        定位
                                    </button>
                                ) : null}
                                {record.kind === "character" && onAddStage ? (
                                    <button type="button" className="h-6 shrink-0 rounded-md px-1.5 text-[10px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: ACCENT }} onClick={() => openStage(record.name, record.description)}>
                                        ＋造型
                                    </button>
                                ) : null}
                            </div>
                        ))}
                        {!pageRecords.length ? (
                            <div className="grid h-16 place-items-center text-[12px]" style={{ color: theme.node.muted }}>
                                {activeTab.empty}
                            </div>
                        ) : null}
                    </div>

                    <div className="flex items-center justify-end gap-3 border-t pt-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <span>共 {filteredRecords.length} 条</span>
                        <select className="h-6 rounded-md border px-1 text-[11px] outline-none" style={fieldStyle} defaultValue="20">
                            <option value="20">20条/页</option>
                        </select>
                        <div className="flex items-center gap-1">
                            <button type="button" className="grid size-6 place-items-center rounded-md disabled:opacity-35" disabled={currentPage <= 1} onClick={() => setResourcePage(currentPage - 1)}>‹</button>
                            <span className="grid size-6 place-items-center rounded-md" style={{ background: theme.node.fill }}>{currentPage}</span>
                            <button type="button" className="grid size-6 place-items-center rounded-md disabled:opacity-35" disabled={currentPage >= pageCount} onClick={() => setResourcePage(currentPage + 1)}>›</button>
                        </div>
                    </div>
                </section>
            </div>

            <Modal
                open={Boolean(stageTarget)}
                onCancel={() => setStageTarget(null)}
                footer={null}
                width={520}
                title={`添加造型${stageTarget ? ` · ${stageTarget}` : ""}`}
                destroyOnHidden
                styles={{ container: { background: theme.node.panel, color: theme.node.text }, header: { background: theme.node.panel } }}
            >
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                        <span className="w-[64px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>造型名称</span>
                        <input value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder="如：大婚造型 / 战损造型" className="h-8 w-full rounded-lg border px-2.5 text-[12px] outline-none" style={fieldStyle} />
                    </div>
                    <div className="flex items-start gap-3">
                        <span className="mt-2 w-[64px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>造型描述</span>
                        <textarea
                            value={stageDescription}
                            onChange={(event) => setStageDescription(event.target.value)}
                            rows={4}
                            placeholder="这套造型的服装、发型、妆容变化"
                            className="thin-scrollbar w-full resize-none rounded-lg border px-2.5 py-2 text-[12px] outline-none"
                            style={fieldStyle}
                        />
                    </div>
                    <div className="flex items-center justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <button type="button" className="h-8 rounded-lg px-3 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => setStageTarget(null)}>取消</button>
                        <button type="button" className="h-8 rounded-lg border px-3 text-[12px] disabled:opacity-50" style={{ borderColor: ACCENT, color: ACCENT }} disabled={stageSaving} onClick={() => void submitStage()}>
                            {stageSaving ? "生成中…" : "保存并生成"}
                        </button>
                    </div>
                </div>
            </Modal>

            <Modal
                open={importOpen}
                onCancel={() => setImportOpen(false)}
                footer={null}
                width={880}
                title="批量导入剧集"
                destroyOnHidden
                styles={{ container: { background: theme.node.panel, color: theme.node.text }, header: { background: theme.node.panel } }}
            >
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-4 text-[12px]">
                        <button type="button" style={{ color: importStep === "config" ? ACCENT : theme.node.muted, fontWeight: importStep === "config" ? 600 : 400 }} onClick={() => setImportStep("config")}>
                            1. 导入设置
                        </button>
                        <button type="button" disabled={!previewEpisodes.length} style={{ color: importStep === "preview" ? ACCENT : theme.node.muted, fontWeight: importStep === "preview" ? 600 : 400, opacity: previewEpisodes.length ? 1 : 0.45 }} onClick={() => setImportStep("preview")}>
                            2. 预览确认
                        </button>
                    </div>

                    {importStep === "config" ? (
                        <>
                            <input ref={fileInputRef} type="file" accept=".txt,text/plain" className="hidden" onChange={(event) => onImportFile(event.target.files?.[0])} />
                            <div className="flex items-center gap-2">
                                <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.node.stroke }} onClick={() => fileInputRef.current?.click()}>
                                    <Upload className="size-3.5 opacity-65" />
                                    选择 TXT 文件
                                </button>
                                <span className="text-[12px]" style={{ color: theme.node.muted }}>{fileName || "未选择文件"}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="w-[84px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>章节正则</span>
                                <Input value={chapterPattern} onChange={(event) => setChapterPattern(event.target.value)} size="small" style={fieldStyle} />
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="w-[84px] shrink-0 text-right text-[12px]" style={{ color: theme.node.muted }}>每集章节数</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    value={chaptersPerEpisode}
                                    onChange={(event) => setChaptersPerEpisode(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
                                    className="h-7 w-[110px] rounded-lg border px-2 text-[12px] outline-none"
                                    style={fieldStyle}
                                />
                            </div>
                            <div className="text-[11px] leading-5" style={{ color: theme.node.muted }}>
                                <div>将提前准备好的小说原文或剧本内容的 TXT 文件导入。</div>
                                <div>请正确填写匹配章节标题的正则，例如 ^\s*(第\d+章[^\n]*)、^\s*(第\d+集[^\n]*)。</div>
                                <div>点击「确认导入配置」后先解析章节并切换到预览页。</div>
                            </div>
                            <div className="flex items-center justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                                <button type="button" className="h-8 rounded-lg px-3 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => setImportOpen(false)}>取消</button>
                                <button type="button" className="h-8 rounded-lg border px-3 text-[12px]" style={{ borderColor: ACCENT, color: ACCENT }} onClick={confirmImportConfig}>确认导入配置</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="flex items-center justify-end text-[12px]" style={{ color: ACCENT }}>
                                共识别 {previewChapters.length} 章，预计导入 {previewEpisodes.length} 集
                            </div>
                            <div className="thin-scrollbar max-h-[360px] overflow-auto rounded-lg border" style={{ borderColor: theme.node.stroke }}>
                                <div className="sticky top-0 grid grid-cols-[64px_220px_240px_1fr] gap-2 border-b px-2 py-1.5 text-[11px] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.muted }}>
                                    <span>集数</span>
                                    <span>集标题</span>
                                    <span>包含章节</span>
                                    <span>内容预览</span>
                                </div>
                                {previewEpisodes.map((episode) => (
                                    <div key={episode.episodeNumber} className="grid grid-cols-[64px_220px_240px_1fr] items-start gap-2 border-b px-2 py-1.5 text-[11px] last:border-b-0" style={{ borderColor: theme.node.stroke }}>
                                        <span>{episode.episodeNumber}</span>
                                        <span className="truncate">{episode.title}</span>
                                        <span className="truncate" style={{ color: theme.node.muted }}>{(episode.chapterTitles || []).join("、") || "未识别章节标题"}</span>
                                        <span className="truncate" style={{ color: theme.node.muted }}>{episode.script || "暂无内容"}</span>
                                    </div>
                                ))}
                                {!previewEpisodes.length ? <div className="grid h-24 place-items-center text-[12px]" style={{ color: theme.node.muted }}>请先在上一步确认导入配置</div> : null}
                            </div>
                            <div className="flex items-center justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                                <button type="button" className="h-8 rounded-lg px-3 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => setImportOpen(false)}>取消</button>
                                <button type="button" className="h-8 rounded-lg px-3 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => setImportStep("config")}>上一步</button>
                                <button type="button" className="h-8 rounded-lg border px-3 text-[12px]" style={{ borderColor: ACCENT, color: ACCENT }} onClick={confirmImportEpisodes}>确认导入集数</button>
                            </div>
                        </>
                    )}
                </div>
            </Modal>

            <Modal
                open={styleOpen}
                onCancel={() => setStyleOpen(false)}
                footer={null}
                width={900}
                title="选择生成风格"
                destroyOnHidden
                styles={{ container: { background: theme.node.panel, color: theme.node.text }, header: { background: theme.node.panel } }}
            >
                <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <Input
                            value={styleQuery}
                            onChange={(event) => setStyleQuery(event.target.value)}
                            placeholder="搜索风格名称..."
                            prefix={<Search className="size-3.5 opacity-45" />}
                            allowClear
                            style={{ maxWidth: 280, ...fieldStyle }}
                        />
                        <div className="text-[12px]" style={{ color: theme.node.muted }}>
                            已选：<span style={{ color: ACCENT }}>{selectedStyle?.label || "未选择"}</span>
                        </div>
                    </div>
                    <div className="thin-scrollbar max-h-[62vh] overflow-y-auto pr-1">
                        {filteredGroups.map((group) => (
                            <div key={group.label} className="mb-4">
                                <div className="mb-2 text-[12px] font-medium" style={{ color: theme.node.muted }}>{group.label}</div>
                                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
                                    {group.options.map((option) => {
                                        const active = option.value === data.style;
                                        return (
                                            <button
                                                key={option.value}
                                                type="button"
                                                className="overflow-hidden rounded-lg border text-left transition"
                                                style={{ borderColor: active ? ACCENT : theme.node.stroke, boxShadow: active ? `0 0 0 1px ${ACCENT}` : undefined }}
                                                onClick={() => {
                                                    patchDrama({ style: option.value });
                                                    setStyleOpen(false);
                                                }}
                                            >
                                                <img src={option.thumb} alt={option.label} className="aspect-[3/2] w-full object-cover" draggable={false} />
                                                <div className="truncate px-2 py-1.5 text-center text-[11px]" style={{ color: active ? ACCENT : theme.node.text }}>{option.label}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                        {!filteredGroups.length ? <div className="grid h-24 place-items-center text-[12px]" style={{ color: theme.node.muted }}>没有匹配的风格</div> : null}
                    </div>
                    <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <button type="button" className="h-8 rounded-lg px-2 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => patchDrama({ style: "" })}>
                            清除选择
                        </button>
                        <button type="button" className="h-8 rounded-lg border px-3 text-[12px]" style={{ borderColor: theme.node.stroke }} onClick={() => setStyleOpen(false)}>
                            完成
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
