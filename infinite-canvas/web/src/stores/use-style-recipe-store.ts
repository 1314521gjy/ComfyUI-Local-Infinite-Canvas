import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";

export type StyleRecipeLora = { name: string; strength: number };

export function normalizeStyleRecipeLoras(value: unknown): StyleRecipeLora[] {
    if (!Array.isArray(value)) return [];
    const result: StyleRecipeLora[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim() : "";
        const strength = Number((item as { strength?: unknown }).strength);
        if (!name || !Number.isFinite(strength)) continue;
        result.push({ name, strength });
    }
    return result;
}

export type StyleRecipeConfig = {
    model?: string;
    modelLabel?: string;
};

export type StyleRecipe = {
    id: string;
    name: string;
    thumbAssetId: string;
    createdAt: string;
    loras: StyleRecipeLora[];
    config: StyleRecipeConfig;
};

type StyleRecipeStore = {
    hydrated: boolean;
    recipes: StyleRecipe[];
    addRecipe: (recipe: Omit<StyleRecipe, "id" | "createdAt">) => string;
    renameRecipe: (id: string, name: string) => void;
    removeRecipe: (id: string) => void;
};

const STYLE_RECIPE_STORE_KEY = "infinite-canvas:style_recipe_store";

const recipeStorage: PersistStorage<StyleRecipeStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        try {
            const parsed = JSON.parse(value) as StorageValue<StyleRecipeStore>;
            if (!Array.isArray(parsed.state?.recipes)) return null;
            return parsed;
        } catch {
            return null;
        }
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useStyleRecipeStore = create<StyleRecipeStore>()(
    persist(
        (set) => ({
            hydrated: false,
            recipes: [],
            addRecipe: (recipe) => {
                const id = nanoid();
                const createdAt = new Date().toISOString();
                set((state) => ({ recipes: [{ ...recipe, id, createdAt }, ...state.recipes] }));
                return id;
            },
            renameRecipe: (id, name) => {
                const next = name.trim();
                if (!next) return;
                set((state) => ({ recipes: state.recipes.map((recipe) => (recipe.id === id ? { ...recipe, name: next } : recipe)) }));
            },
            removeRecipe: (id) => set((state) => ({ recipes: state.recipes.filter((recipe) => recipe.id !== id) })),
        }),
        {
            name: STYLE_RECIPE_STORE_KEY,
            storage: recipeStorage,
            partialize: (state) => ({ recipes: state.recipes }) as StorageValue<StyleRecipeStore>["state"],
            onRehydrateStorage: () => () => {
                useStyleRecipeStore.setState({ hydrated: true });
            },
        },
    ),
);
