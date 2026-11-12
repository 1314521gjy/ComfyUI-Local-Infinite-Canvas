import { useMemo, useState, useSyncExternalStore } from "react";
import { App, Button, Empty, Input, Modal, Popconfirm } from "antd";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { collectNodeLoras } from "@/components/canvas/canvas-node-generation";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { styleRecipeBaseModelGroup, styleRecipeKind, styleRecipeModelLabel } from "@/lib/canvas/style-recipe";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { assetCoverUrl, useAssetStore } from "@/stores/use-asset-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { normalizeStyleRecipeLoras, useStyleRecipeStore, type StyleRecipe, type StyleRecipeLora } from "@/stores/use-style-recipe-store";

const ACTION_BUTTON = "grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-stone-900 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80";
const ACTION_BUTTON_DANGER = "grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-red-500 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80 dark:hover:text-red-400";

export function CanvasStyleRecipesTab({ theme, onApply }: { theme: CanvasTheme; onApply: (recipe: StyleRecipe) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const recipes = useStyleRecipeStore((state) => state.recipes);
    const config = useEffectiveConfig();
    const assets = useAssetStore((state) => state.assets);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
    const projects = useCanvasStore((state) => state.projects);
    const [renaming, setRenaming] = useState<StyleRecipe | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [viewingId, setViewingId] = useState<string | null>(null);
    const viewing = viewingId ? recipes.find((recipe) => recipe.id === viewingId) || null : null;
    const viewingAsset = viewing ? assetById.get(viewing.thumbAssetId) : undefined;
    const viewingCover = viewingAsset ? assetCoverUrl(viewingAsset) : "";
    const grouped = useMemo(() => {
        const groups: Array<{ kind: "image" | "video"; label: string; models: Array<{ label: string; recipes: StyleRecipe[] }> }> = [];
        for (const kind of ["image", "video"] as const) {
            const kindRecipes = recipes.filter((recipe) => styleRecipeKind(recipe) === kind);
            if (!kindRecipes.length) continue;
            const order: string[] = [];
            const byModel = new Map<string, StyleRecipe[]>();
            for (const recipe of kindRecipes) {
                const label = styleRecipeBaseModelGroup(config, recipe.config.model, recipe.config.modelLabel);
                if (!byModel.has(label)) {
                    byModel.set(label, []);
                    order.push(label);
                }
                byModel.get(label)!.push(recipe);
            }
            groups.push({ kind, label: t(kind === "video" ? "canvas.styleRecipes.groupVideo" : "canvas.styleRecipes.groupImage"), models: order.map((label) => ({ label, recipes: byModel.get(label)! })) });
        }
        return groups;
    }, [recipes, config, t]);

    const renderRecipeCover = (recipe: StyleRecipe, className: string) => {
        const asset = assetById.get(recipe.thumbAssetId);
        if (asset?.kind === "video" && asset.data.url) return <video src={`${asset.data.url}#t=0.1`} muted playsInline preload="metadata" className={className} />;
        const cover = asset ? assetCoverUrl(asset) : "";
        return cover ? <img src={cover} alt="" className={className} /> : <span className="flex size-full items-center justify-center px-2 text-center text-xs opacity-40">{t("canvas.styleRecipes.thumbMissing")}</span>;
    };

    const lorasByRecipeId = useMemo(() => {
        const sourceNodeIds = new Set<string>();
        for (const recipe of recipes) {
            if (recipe.loras.length) continue;
            const asset = assetById.get(recipe.thumbAssetId);
            const nodeId = typeof asset?.metadata?.nodeId === "string" ? asset.metadata.nodeId : "";
            if (nodeId) sourceNodeIds.add(nodeId);
        }
        const recovered = new Map<string, StyleRecipeLora[]>();
        if (sourceNodeIds.size) {
            for (const project of projects) {
                for (const node of project.nodes || []) {
                    if (!sourceNodeIds.has(node.id)) continue;
                    const loras = normalizeStyleRecipeLoras(collectNodeLoras(node.id, project.nodes, project.connections || []));
                    if (loras.length) recovered.set(node.id, loras);
                }
            }
        }
        const map = new Map<string, StyleRecipeLora[]>();
        for (const recipe of recipes) {
            if (recipe.loras.length) {
                map.set(recipe.id, recipe.loras);
                continue;
            }
            const asset = assetById.get(recipe.thumbAssetId);
            const nodeId = typeof asset?.metadata?.nodeId === "string" ? asset.metadata.nodeId : "";
            map.set(recipe.id, nodeId ? recovered.get(nodeId) || [] : []);
        }
        return map;
    }, [recipes, assetById, projects]);
    const viewingLoras = viewing ? lorasByRecipeId.get(viewing.id) || [] : [];

    const openRename = (recipe: StyleRecipe) => {
        setRenaming(recipe);
        setRenameDraft(recipe.name);
    };

    const commitRename = () => {
        if (!renaming) return;
        if (!renameDraft.trim()) return;
        useStyleRecipeStore.getState().renameRecipe(renaming.id, renameDraft);
        setRenaming(null);
    };

    const removeRecipe = (recipe: StyleRecipe) => {
        useStyleRecipeStore.getState().removeRecipe(recipe.id);
        if (viewingId === recipe.id) setViewingId(null);
        message.success(t("canvas.styleRecipes.removed", { name: recipe.name }));
    };

    const modelLabel = viewing ? styleRecipeModelLabel(config, viewing.config.model, viewing.config.modelLabel) : "-";

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between px-4 pb-2 text-xs opacity-50">
                <span>{t("canvas.styleRecipes.tab")}</span>
                <span>{recipes.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
                {recipes.length ? (
                    <div className="space-y-4">
                        {grouped.map((group) => {
                            return (
                                <div key={group.kind}>
                                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-60">{group.label} · {group.models.reduce((count, model) => count + model.recipes.length, 0)}</div>
                                    {group.models.map((modelGroup) => {
                                        return (
                                            <div key={`${group.kind}:${modelGroup.label}`} className="mb-3">
                                                <div className="px-1 pb-1 text-[10px] opacity-45">{modelGroup.label}</div>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {modelGroup.recipes.map((recipe) => {
                            const loras = lorasByRecipeId.get(recipe.id) || [];
                            const meta = [styleRecipeModelLabel(config, recipe.config.model, recipe.config.modelLabel), loras.length ? t("canvas.styleRecipes.loraSummary", { count: loras.length }) : ""].filter(Boolean).join(" · ");
                            return (
                                <div key={recipe.id} className="group relative overflow-hidden rounded-xl border" style={{ borderColor: theme.toolbar.border }}>
                                    <button type="button" className="block w-full text-left" onClick={() => setViewingId(recipe.id)} aria-label={t("canvas.styleRecipes.viewRecipe")}>
                                        <div className="aspect-square w-full" style={{ background: theme.node.fill }}>
                                            {renderRecipeCover(recipe, "size-full object-cover")}
                                        </div>
                                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-8">
                                            <div className="truncate text-xs font-medium text-white">{recipe.name}</div>
                                            <div className="truncate text-[10px] text-white/70">{meta || "-"}</div>
                                        </div>
                                    </button>
                                    <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                        <button type="button" className={ACTION_BUTTON} title={t("canvas.styleRecipes.apply")} aria-label={t("canvas.styleRecipes.apply")} onClick={() => onApply({ ...recipe, loras })}>
                                            <Plus className="size-4" />
                                        </button>
                                        <button type="button" className={ACTION_BUTTON} title={t("canvas.styleRecipes.viewRecipe")} aria-label={t("canvas.styleRecipes.viewRecipe")} onClick={() => setViewingId(recipe.id)}>
                                            <BookOpen className="size-4" />
                                        </button>
                                        <Popconfirm
                                            title={t("canvas.styleRecipes.removeTitle", { name: recipe.name })}
                                            description={t("canvas.styleRecipes.removeDescription")}
                                            okText={t("common.delete")}
                                            cancelText={t("common.cancel")}
                                            onConfirm={() => removeRecipe(recipe)}
                                        >
                                            <button type="button" className={ACTION_BUTTON_DANGER} title={t("common.delete")} aria-label={t("common.delete")}>
                                                <Trash2 className="size-4" />
                                            </button>
                                        </Popconfirm>
                                    </div>
                                </div>
                            );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 pb-16 text-center">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs opacity-55">{t("canvas.styleRecipes.empty")}</span>} />
                        <div className="text-xs opacity-45">{t("canvas.styleRecipes.emptyHint")}</div>
                    </div>
                )}
            </div>
            <Modal
                open={Boolean(viewing)}
                title={viewing?.name}
                onCancel={() => setViewingId(null)}
                width={920}
                footer={
                    viewing ? (
                        <div className="flex items-center justify-between">
                            <Button type="text" icon={<Pencil className="size-3.5" />} onClick={() => openRename(viewing)}>
                                {t("canvas.styleRecipes.rename")}
                            </Button>
                            <Button onClick={() => setViewingId(null)}>{t("common.close")}</Button>
                        </div>
                    ) : null
                }
            >
                {viewing ? (
                    <div className="space-y-3 pt-1">
                        <div className="flex min-h-48 max-h-[56vh] items-center justify-center overflow-hidden rounded-xl" style={{ background: theme.node.fill }}>
                            {viewingAsset?.kind === "video" && viewingAsset.data.url ? <video src={`${viewingAsset.data.url}#t=0.1`} controls playsInline preload="metadata" className="max-h-[56vh] w-full" /> : viewingCover ? <img src={viewingCover} alt="" className="max-h-[56vh] w-full object-contain" /> : <span className="text-xs opacity-40">{t("canvas.styleRecipes.thumbMissing")}</span>}
                        </div>
                        <div className="text-sm">
                            <div className="text-xs opacity-45">{t("canvas.styleRecipes.detailModel")}</div>
                            <div className="truncate" title={modelLabel}>{modelLabel}</div>
                        </div>
                        <div>
                            <div className="text-xs opacity-45">{t("canvas.styleRecipes.detailLoras")}</div>
                            {viewingLoras.length ? (
                                <div className="mt-1 space-y-1">
                                    {viewingLoras.map((lora, index) => {
                                        const strength = Number(lora.strength);
                                        return (
                                            <div key={`${lora.name}-${index}`} className="flex items-baseline justify-between gap-4 text-sm">
                                                <span className="min-w-0 truncate" title={lora.name}>{lora.name}</span>
                                                <span className="shrink-0 tabular-nums opacity-60">{Number.isFinite(strength) ? strength.toFixed(2) : "-"}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="mt-1 text-sm opacity-45">{t("canvas.styleRecipes.detailNoLoras")}</div>
                            )}
                        </div>
                    </div>
                ) : null}
            </Modal>
            <Modal open={Boolean(renaming)} title={t("canvas.styleRecipes.renameTitle")} onCancel={() => setRenaming(null)} onOk={commitRename} okText={t("common.save")} cancelText={t("common.cancel")} okButtonProps={{ disabled: !renameDraft.trim() }}>
                <Input value={renameDraft} maxLength={40} placeholder={t("canvas.styleRecipes.renamePlaceholder")} onChange={(event) => setRenameDraft(event.target.value)} onPressEnter={commitRename} />
            </Modal>
        </div>
    );
}
