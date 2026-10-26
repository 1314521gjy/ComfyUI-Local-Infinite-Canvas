import { App, Button, Form, Input, Modal, Progress, Radio, Select, Switch, Tabs } from "antd";
import type { TFunction } from "i18next";
import { Cloud, Download, Lock, Pencil, Plus, RefreshCw, Trash2, Upload, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { imageAspectOptions } from "@/components/image-settings-panel";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigLocalProxy } from "@/components/layout/config-local-proxy";
import { ConfigPromptSources } from "@/components/layout/config-prompt-sources";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import type { AppLocale } from "@/i18n";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { progressRingSkins } from "@/lib/canvas/progress-ring-skins";
import { cardSkinIds, getCanvasTheme, type CardSkinId } from "@/lib/canvas-theme";
import { isCardSkinLocked, verifySkinPassword } from "@/lib/canvas/skin-unlocks";
import { persistSkinUnlock } from "@/services/api/skin-unlocks";
import { useThemeStore } from "@/stores/use-theme-store";
import { createModelChannel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ApiCallFormat, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

type WebdavDomainProgress = {
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function AppConfigPanel({ showDoneButton = false, initialTab = "channels" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const [passwordSkinId, setPasswordSkinId] = useState<CardSkinId | null>(null);
    const [skinPassword, setSkinPassword] = useState("");
    const [skinPasswordError, setSkinPasswordError] = useState("");
    const [verifyingSkinPassword, setVerifyingSkinPassword] = useState(false);
    const config = useConfigStore((state) => state.config);
    const appTheme = useThemeStore((state) => state.theme);
    const cardSkin = useThemeStore((state) => state.cardSkin) || "warm";
    const unlockedCardSkins = useThemeStore((state) => state.unlockedCardSkins);
    const setCardSkin = useThemeStore((state) => state.setCardSkin);
    const unlockCardSkin = useThemeStore((state) => state.unlockCardSkin);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const webdavReady = Boolean(webdav.url.trim());
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    const locale = i18n.resolvedLanguage as AppLocale;
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));
    useEffect(() => setActiveTab(initialTab), [initialTab]);

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const selectCardSkin = (skinId: CardSkinId) => {
        if (isCardSkinLocked(skinId) && !unlockedCardSkins.includes(skinId)) {
            setPasswordSkinId(skinId);
            setSkinPassword("");
            setSkinPasswordError("");
            return;
        }
        setCardSkin(skinId);
    };

    const closeSkinPasswordModal = () => {
        if (verifyingSkinPassword) return;
        setPasswordSkinId(null);
        setSkinPassword("");
        setSkinPasswordError("");
    };

    const unlockSelectedSkin = async () => {
        if (!passwordSkinId || verifyingSkinPassword) return;
        setVerifyingSkinPassword(true);
        setSkinPasswordError("");
        try {
            const valid = await verifySkinPassword(passwordSkinId, skinPassword);
            if (!valid) {
                setSkinPasswordError(t("config.preferences.cardSkinPasswordWrong"));
                return;
            }
            unlockCardSkin(passwordSkinId);
            void persistSkinUnlock(passwordSkinId).catch(() => undefined);
            message.success(t("config.preferences.cardSkinUnlocked", { name: t(`config.preferences.cardSkins.${passwordSkinId}.label`) }));
            setPasswordSkinId(null);
            setSkinPassword("");
        } catch {
            setSkinPasswordError(t("config.preferences.cardSkinPasswordUnavailable"));
        } finally {
            setVerifyingSkinPassword(false);
        }
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            message.success(t("config.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.importFailed"));
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = () => {
        const channel = createModelChannel({ name: t("config.channels.numberedName", { count: config.channels.length + 1 }) });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success(t("config.webdav.available"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.testFailed"));
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus(t("config.webdav.preparing"));
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(t("config.webdav.completed", { projects: result.projects, assets: result.assets, records: result.imageLogs + result.videoLogs, files: result.uploadedFiles, bytes: formatBytes(result.uploadedBytes) }));
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : t("config.webdav.failed"));
            message.error(error instanceof Error ? error.message : t("config.webdav.failed"));
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <>
            {!LOCAL_ONLY ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                    <div className="text-xs text-stone-500">{t("config.fileSecurity")}</div>
                    <div className="flex gap-2">
                        <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                            {t("config.import")}
                        </Button>
                        <Button icon={<Download className="size-4" />} onClick={exportAppConfig}>
                            {t("config.export")}
                        </Button>
                        <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                    </div>
                </div>
            ) : (
                <div className="border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800">配置只保存在本机浏览器。</div>
            )}
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "channels",
                        label: t("config.tabs.channels"),
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-xs text-stone-500">{LOCAL_ONLY ? "只使用本地 ComfyUI 网关。模型由网关工作流注册表提供。" : t("config.channels.description")}</div>
                                    {!LOCAL_ONLY ? (
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                            {t("config.channels.add")}
                                        </Button>
                                    ) : null}
                                </div>
                                <div className="space-y-2">
                                    {config.channels.map((channel) => (
                                        <div key={channel.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</div>
                                                <div className="mt-1 truncate text-xs text-stone-500">
                                                    {LOCAL_ONLY ? "本地网关" : apiFormatLabel(channel.apiFormat)} · {t("config.channels.modelCount", { count: channel.models.length })} · {channel.baseUrl || t("config.channels.missingUrl")}
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    {t("common.edit")}
                                                </Button>
                                                {!LOCAL_ONLY ? <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} /> : null}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "local-proxy",
                        label: t("config.tabs.localProxy"),
                        children: <ConfigLocalProxy />,
                    },
                    {
                        key: "preferences",
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups
                                        .filter((group) => !LOCAL_ONLY || group.capability === "image" || group.capability === "video")
                                        .map((group) => (
                                            <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                                <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                            </Form.Item>
                                        ))}
                                </div>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.imageResolution")} className="mb-4">
                                        <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", computeMediaSize(scale, inferMediaRatio(config.size)))} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.imageAspectRatio")} className="mb-4">
                                        <Select value={inferMediaRatio(config.size)} options={imageAspectOptions} onChange={(ratio) => updateConfig("size", computeMediaSize(inferMediaScale(config.size), ratio))} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.videoResolution")} className="mb-4">
                                        <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                                    </Form.Item>
                                    {!LOCAL_ONLY ? (
                                        <>
                                            <Form.Item label={t("config.preferences.audioVoice")} className="mb-4">
                                                <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                            </Form.Item>
                                            <Form.Item label={t("config.preferences.audioFormat")} className="mb-4">
                                                <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                            </Form.Item>
                                            <Form.Item label={t("config.preferences.audioSpeed")} className="mb-4">
                                                <Input
                                                    type="number"
                                                    min={0.25}
                                                    max={4}
                                                    step={0.05}
                                                    value={config.audioSpeed}
                                                    onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                                    onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                                />
                                            </Form.Item>
                                        </>
                                    ) : null}
                                </div>
                                <Form.Item label={t("config.preferences.cardSkin")} extra={t("config.preferences.cardSkinDescription")} className="mb-4">
                                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {cardSkinIds.map((id) => {
                                            const locked = isCardSkinLocked(id) && !unlockedCardSkins.includes(id);
                                            const selected = cardSkin === id && !locked;
                                            const palette = getCanvasTheme(appTheme, id).node;
                                            return (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    title={locked ? t("config.preferences.cardSkinLockedHint") : undefined}
                                                    onClick={() => selectCardSkin(id)}
                                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                                >
                                                    <span className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-md border" style={{ background: palette.fill, borderColor: palette.stroke }}>
                                                        {id === "fish" ? (
                                                            <img src="/skins/blue-whale-girl.png" alt="" draggable={false} className="size-10 object-contain" />
                                                        ) : (
                                                            <span className="space-y-1">
                                                                <span className="block h-1 w-8 rounded-full" style={{ background: palette.text, opacity: 0.85 }} />
                                                                <span className="block h-1 w-5 rounded-full" style={{ background: palette.muted, opacity: 0.65 }} />
                                                            </span>
                                                        )}
                                                        {locked ? (
                                                            <span className="absolute inset-0 grid place-items-center bg-stone-950/45 text-white">
                                                                <Lock className="size-4" />
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="flex items-center gap-1.5 text-sm font-medium">
                                                            <span className="truncate">{t(`config.preferences.cardSkins.${id}.label`)}</span>
                                                            {locked ? <span className="shrink-0 rounded-full border border-current px-1.5 py-0.5 text-[9px] font-medium opacity-70">{t("config.preferences.cardSkinLocked")}</span> : null}
                                                        </span>
                                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{locked ? t("config.preferences.cardSkinLockedHint") : t(`config.preferences.cardSkins.${id}.description`)}</span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </Form.Item>
                                <Form.Item label={t("config.preferences.progressRingSkin")} extra={t("config.preferences.progressRingSkinDescription")} className="mb-4">
                                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {progressRingSkins.map((skin) => {
                                            const selected = (config.progressRingSkin || "cyan") === skin.id;
                                            const palette = appTheme === "dark" ? skin.dark : skin.light;
                                            return (
                                                <button
                                                    key={skin.id}
                                                    type="button"
                                                    onClick={() => updateConfig("progressRingSkin", skin.id)}
                                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                                >
                                                    <span className="relative grid h-7 w-14 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: appTheme === "dark" ? "#1c1917" : "#f5f5f4" }}>
                                                        {skin.mode === "tide" ? (
                                                            <span
                                                                className="absolute inset-x-0 bottom-0 h-[62%]"
                                                                style={{ background: `linear-gradient(to top, ${palette.glow}66, ${palette.core}2e)`, borderTop: `1px solid ${palette.glow}`, boxShadow: `0 -3px 8px ${palette.glow}66` }}
                                                            />
                                                        ) : (
                                                            <span
                                                                className="absolute inset-x-1.5 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
                                                                style={{ background: `linear-gradient(90deg, ${palette.gradient[0]}, ${palette.gradient[2]})`, boxShadow: `0 0 8px ${palette.glow}` }}
                                                            />
                                                        )}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-medium">{t(`config.preferences.progressRingSkins.${skin.id}.label`)}</span>
                                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{t(`config.preferences.progressRingSkins.${skin.id}.description`)}</span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </Form.Item>
                                <Form.Item label={t("config.preferences.regenerateBehavior")} className="mb-4">
                                    <Radio.Group value={config.nodeRegenerateBehavior} onChange={(event) => updateConfig("nodeRegenerateBehavior", event.target.value)} className="flex flex-col gap-2">
                                        <Radio value="overwrite">
                                            <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorOverwrite")}</span>
                                            <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorOverwriteDescription")}</span>
                                        </Radio>
                                        <Radio value="new-node">
                                            <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorNewNode")}</span>
                                            <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorNewNodeDescription")}</span>
                                        </Radio>
                                    </Radio.Group>
                                </Form.Item>
                                <Form.Item className="mb-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                                        <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                                    </div>
                                </Form.Item>
                                {!LOCAL_ONLY ? (
                                    <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                                        <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                    </Form.Item>
                                ) : null}
                                <Form.Item label={t("config.preferences.systemPrompt")} className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "prompt-sources",
                        label: t("config.tabs.promptSources"),
                        children: <ConfigPromptSources />,
                    },
                    {
                        key: "webdav",
                        label: "WebDAV",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                {t("config.webdav.title")}
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">{t("config.webdav.description")}</div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? t("config.webdav.lastSynced", { time: formatWebdavTime(webdav.lastSyncedAt, locale) }) : t("config.webdav.neverSynced")}</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label={t("config.webdav.url")} className="mb-4">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.directory")} extra={t("config.webdav.directoryDescription", { manifest: WEBDAV_MANIFEST_FILE_NAME })} className="mb-4">
                                            <Input value={webdav.directory} placeholder="infinite-canvas" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.username")} className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.password")} className="mb-0">
                                            <Input.Password value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            {t("config.webdav.test")}
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {t(syncingWebdav ? "config.webdav.syncing" : "config.webdav.syncNow")}
                                        </Button>
                                        {webdavSyncStatus ? <span className="text-xs text-stone-500">{syncStageLabel(webdavSyncStatus, t)}</span> : null}
                                    </div>
                                    {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} t={t} /> : null}
                                </section>
                            </Form>
                        ),
                    },
                    {
                        key: "local-storage",
                        label: t("config.tabs.localStorage"),
                        children: <ConfigLocalStorage active={activeTab === "local-storage"} />,
                    },
                ].filter((tab) => !LOCAL_ONLY || !["local-proxy", "prompt-sources", "webdav"].includes(tab.key))}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
            <Modal
                open={Boolean(passwordSkinId)}
                centered
                width={420}
                maskClosable={false}
                title={passwordSkinId ? t("config.preferences.cardSkinUnlockTitle", { name: t(`config.preferences.cardSkins.${passwordSkinId}.label`) }) : ""}
                okText={t("config.preferences.cardSkinUnlockAction")}
                cancelText={t("common.cancel")}
                confirmLoading={verifyingSkinPassword}
                okButtonProps={{ disabled: !skinPassword.trim() || verifyingSkinPassword }}
                cancelButtonProps={{ disabled: verifyingSkinPassword }}
                onOk={() => void unlockSelectedSkin()}
                onCancel={closeSkinPasswordModal}
            >
                <p className="mb-3 text-sm text-stone-500">{t("config.preferences.cardSkinUnlockHint")}</p>
                <Input.Password
                    autoFocus
                    value={skinPassword}
                    status={skinPasswordError ? "error" : undefined}
                    placeholder={t("config.preferences.cardSkinPasswordPlaceholder")}
                    onChange={(event) => {
                        setSkinPassword(event.target.value);
                        if (skinPasswordError) setSkinPasswordError("");
                    }}
                    onPressEnter={() => {
                        if (skinPassword.trim() && !verifyingSkinPassword) void unlockSelectedSkin();
                    }}
                />
                {skinPasswordError ? <p className="mt-2 text-xs text-red-500">{skinPasswordError}</p> : null}
            </Modal>
        </>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return "Gemini";
    return "OpenAI";
}

function formatWebdavTime(value: string, locale: AppLocale) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress, t }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress>; t: TFunction }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{t(`config.webdav.domains.${domainTranslationKey(key)}`)}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {syncStageLabel(item.stage, t)}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function domainTranslationKey(domain: AppSyncDomainKey) {
    if (domain === "image-workbench") return "imageWorkbench";
    if (domain === "video-workbench") return "videoWorkbench";
    return domain;
}

function syncStageLabel(stage: string, t: TFunction) {
    if (stage === "等待本地数据加载") return t("config.webdav.stages.localWaiting");
    if (stage === "同步完成") return t("config.webdav.stages.syncComplete");
    if (stage === "等待同步") return t("config.webdav.stages.waiting");
    if (stage === "读取远端清单") return t("config.webdav.stages.remoteManifest");
    if (stage === "读取本地数据") return t("config.webdav.stages.localData");
    if (stage === "下载缺失媒体") return t("config.webdav.stages.downloadMedia");
    if (stage === "写入本地合并结果") return t("config.webdav.stages.writeMerge");
    if (stage === "上传新增媒体") return t("config.webdav.stages.uploadMedia");
    if (stage === "媒体已齐全") return t("config.webdav.stages.mediaReady");
    if (stage === "媒体无需上传") return t("config.webdav.stages.mediaSkipped");
    if (stage === "检查缺失媒体") return t("config.webdav.stages.checkMissingMedia");
    if (stage === "下载媒体") return t("config.webdav.stages.downloadMediaFile");
    if (stage === "检查本地媒体") return t("config.webdav.stages.checkLocalMedia");
    if (stage.startsWith("上传媒体 ")) return t("config.webdav.stages.uploadMediaFile", { size: stage.slice(5) });
    if (stage === "完成") return t("config.webdav.stages.complete");
    if (stage.startsWith("上传清单 ")) return t("config.webdav.stages.uploadManifest", { size: stage.slice(5) });
    return stage;
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
