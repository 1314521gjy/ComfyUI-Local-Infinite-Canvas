import { useEffect, useState } from "react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { requestUpdateCheck, type UpdateCheckResult } from "@/services/api/update";

export function UpdateAvailableBanner() {
    const { t } = useTranslation();
    const [info, setInfo] = useState<UpdateCheckResult | null>(null);

    useEffect(() => {
        let alive = true;
        const check = async () => {
            try {
                const result = await requestUpdateCheck(true);
                if (alive) setInfo(result);
            } catch {
                // 网关尚未就绪时静默；恢复后下一轮再检查。
            }
        };
        void check();
        const timer = window.setInterval(check, 10 * 60 * 1000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    if (!info?.updateAvailable) return null;

    return (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[2900] -translate-x-1/2 px-3">
            <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-amber-300 bg-amber-50/95 px-4 py-2 text-sm text-amber-950 shadow-lg backdrop-blur dark:border-amber-900/70 dark:bg-amber-950/90 dark:text-amber-100">
                <span className="size-2 shrink-0 rounded-full bg-amber-500" />
                <span className="whitespace-nowrap">{t("version.updateAvailable", { version: info.latestVersion })}</span>
                <Button size="small" type="primary" onClick={() => window.dispatchEvent(new Event("open-version-release"))}>
                    {t("version.viewUpdates")}
                </Button>
            </div>
        </div>
    );
}
