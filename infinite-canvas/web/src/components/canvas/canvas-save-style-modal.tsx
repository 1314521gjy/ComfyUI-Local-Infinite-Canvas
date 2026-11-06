import { useEffect, useState, useSyncExternalStore } from "react";
import { App, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { styleRecipeModelLabel } from "@/lib/canvas/style-recipe";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { assetCoverUrl, useAssetStore } from "@/stores/use-asset-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useStyleRecipeStore, type StyleRecipeConfig, type StyleRecipeLora } from "@/stores/use-style-recipe-store";

export type StyleRecipeDraft = {
    thumbAssetId: string;
    loras: StyleRecipeLora[];
    config: StyleRecipeConfig;
    defaultName: string;
};

export function CanvasSaveStyleModal({ open, draft, onClose }: { open: boolean; draft: StyleRecipeDraft | null; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const [name, setName] = useState("");
    const assetId = draft?.thumbAssetId;
    const asset = useAssetStore((state) => state.assets.find((item) => item.id === assetId));
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = asset ? assetCoverUrl(asset) : "";

    useEffect(() => {
        if (!open || !draft) return;
        setName(draft.defaultName);
    }, [open, draft]);

    const canSave = Boolean(name.trim());

    const handleSave = () => {
        if (!draft || !canSave) return;
        useStyleRecipeStore.getState().addRecipe({
            name: name.trim(),
            thumbAssetId: draft.thumbAssetId,
            loras: draft.loras,
            config: draft.config,
        });
        message.success(t("canvas.styleRecipes.saved", { name: name.trim() }));
        onClose();
    };

    return (
        <Modal open={open} title={t("canvas.styleRecipes.dialogTitle")} onCancel={onClose} onOk={handleSave} okText={t("canvas.styleRecipes.save")} cancelText={t("common.cancel")} okButtonProps={{ disabled: !canSave }} width={580}>
            {draft ? (
                <div className="flex gap-4 pt-1">
                    <div className="size-32 shrink-0 overflow-hidden rounded-xl bg-stone-100 dark:bg-stone-800">
                        {cover ? <img src={cover} alt="" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center px-2 text-center text-xs opacity-50">{t("canvas.styleRecipes.thumbMissing")}</div>}
                    </div>
                    <div className="min-w-0 flex-1 space-y-3">
                        <div>
                            <div className="mb-1 text-xs opacity-60">{t("canvas.styleRecipes.name")}</div>
                            <Input value={name} maxLength={40} placeholder={t("canvas.styleRecipes.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
                        </div>
                        <div className="text-xs opacity-55">
                            {t("canvas.styleRecipes.summary", { model: styleRecipeModelLabel(config, draft.config.model, draft.config.modelLabel) })}
                            {draft.loras.length ? ` · ${t("canvas.styleRecipes.loraSummary", { count: draft.loras.length })}` : ""}
                        </div>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
