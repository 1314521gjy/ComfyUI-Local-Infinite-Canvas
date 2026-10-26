import { Button, Modal } from "antd";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ResourceCenterPanel } from "@/components/layout/resource-center-panel";
import { fetchResourceStatus, type ResourceStatus } from "@/services/api/resources";

const SKIP_KEY = "resource-setup-skipped";

export function ResourceSetupGate() {
    const { i18n } = useTranslation();
    const zh = i18n.language.startsWith("zh");
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<ResourceStatus | null>(null);
    const [checked, setChecked] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const run = async () => {
            try {
                const next = await fetchResourceStatus();
                if (cancelled) return;
                setStatus(next);
                if ((next.summary.recommendedMissing || 0) > 0 && next.recommendationAvailable && window.localStorage.getItem(SKIP_KEY) !== "1") setOpen(true);
            } catch {
                // Gateway/ComfyUI 未就绪时不打扰用户，资源中心仍可手动打开。
            } finally {
                if (!cancelled) setChecked(true);
            }
        };
        void run();
        return () => {
            cancelled = true;
        };
    }, []);

    if (!checked || !status || status.summary.missing <= 0) return null;

    const skip = () => {
        window.localStorage.setItem(SKIP_KEY, "1");
        setOpen(false);
    };

    return (
        <Modal
            title={
                <div className="flex items-center gap-2">
                    <Download className="size-5" />
                    <div>
                        <div className="text-base font-semibold">{zh ? "准备资源" : "Prepare resources"}</div>
                        <div className="mt-0.5 text-xs font-normal text-stone-500 dark:text-stone-400">
                            {zh ? "你的 ComfyUI 已连接；已按当前显卡和内存标出推荐版本，只下载缺少的模型/组件，已有同名文件会直接复用。" : "ComfyUI is connected. The recommended version is marked for this GPU; only missing files are downloaded."}
                        </div>
                    </div>
                </div>
            }
            open={open}
            width={860}
            centered
            closable={false}
            footer={null}
            onCancel={skip}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
        >
            <ResourceCenterPanel
                compact
                footer={
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
                        <span className="text-[11px] text-stone-400 dark:text-stone-500">
                            {zh ? "跳过后可在 设置 → 资源中心 随时补装。" : "You can install later from Settings → Resources."}
                        </span>
                        <Button icon={<X className="size-4" />} onClick={skip}>
                            {zh ? "跳过，先进入画布" : "Skip for now"}
                        </Button>
                    </div>
                }
            />
        </Modal>
    );
}
