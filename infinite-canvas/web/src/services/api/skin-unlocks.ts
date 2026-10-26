import axios from "axios";

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { cardSkinIds, type CardSkinId } from "@/lib/canvas-theme";
import { localGatewayRoot } from "@/services/api/image";

const gatewayRoot = localGatewayRoot(LOCAL_GATEWAY_BASE_URL);

function isCardSkinId(value: string): value is CardSkinId {
    return cardSkinIds.includes(value as CardSkinId);
}

export async function fetchSkinUnlocks(): Promise<CardSkinId[]> {
    if (!gatewayRoot) return [];
    const response = await axios.get<{ unlocked?: unknown }>(`${gatewayRoot}/api/skin-unlocks`, { timeout: 5000 });
    const unlocked = Array.isArray(response.data?.unlocked) ? response.data.unlocked : [];
    return unlocked.filter((item): item is CardSkinId => typeof item === "string" && isCardSkinId(item));
}

export async function persistSkinUnlock(skinId: CardSkinId): Promise<void> {
    if (!gatewayRoot) return;
    await axios.post(`${gatewayRoot}/api/skin-unlocks`, { skinId }, { timeout: 5000 });
}
