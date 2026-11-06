import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { normalizeStyleRecipe, type StyleRecipe } from "@/lib/canvas/style-recipe";

export type { StyleRecipe, StyleRecipeConfig, StyleRecipeLora } from "@/lib/canvas/style-recipe";
export { normalizeStyleRecipeLoras } from "@/lib/canvas/style-recipe";

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
            const recipes = parsed.state.recipes.map(normalizeStyleRecipe).filter((recipe): recipe is StyleRecipe => Boolean(recipe));
            return { ...parsed, state: { ...parsed.state, recipes } };
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
