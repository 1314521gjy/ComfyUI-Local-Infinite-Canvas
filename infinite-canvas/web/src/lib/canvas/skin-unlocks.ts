import type { CardSkinId } from "@/lib/canvas-theme";

type SkinPasswordRecord = {
    salt: string;
    iterations: number;
    hash: string;
};

// Passwords are not stored; only a PBKDF2-SHA256 verifier is kept here.
const lockedSkinPasswords: Partial<Record<CardSkinId, SkinPasswordRecord>> = {
    fish: {
        salt: "cd2abb4f6ee36b8d0dd1a5801b48a678",
        iterations: 210000,
        hash: "ed9c341bc3ace760dbf2b0da99de913ed8961ee610683885ea4ea15867bd9952",
    },
};

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function timingSafeEqualHex(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
        diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return diff === 0;
}

export function isCardSkinLocked(skinId: CardSkinId): boolean {
    return Boolean(lockedSkinPasswords[skinId]);
}

export async function verifySkinPassword(skinId: CardSkinId, password: string): Promise<boolean> {
    const record = lockedSkinPasswords[skinId];
    if (!record) return true;
    const normalized = password.trim().toUpperCase();
    if (!normalized) return false;
    if (!globalThis.crypto?.subtle) {
        throw new Error("crypto-unavailable");
    }
    const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(normalized), "PBKDF2", false, ["deriveBits"]);
    const bits = await globalThis.crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: hexToBytes(record.salt), iterations: record.iterations, hash: "SHA-256" },
        key,
        256,
    );
    return timingSafeEqualHex(bytesToHex(bits), record.hash);
}
