import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isGatewayDown, subscribeGatewayStatus } from "@/services/api/gateway-status";

export function GatewayReconnectBanner() {
    const { t } = useTranslation();
    const [down, setDown] = useState(isGatewayDown);

    useEffect(() => subscribeGatewayStatus(setDown), []);

    if (!down) return null;

    return (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[3000] -translate-x-1/2">
            <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber-200 bg-white/95 px-4 py-2 text-sm text-stone-700 shadow-lg backdrop-blur dark:border-amber-900/70 dark:bg-stone-900/95 dark:text-stone-200">
                <span className="size-3.5 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700 dark:border-stone-600 dark:border-t-stone-200" />
                <span>{t("gateway.reconnecting")}</span>
            </div>
        </div>
    );
}
