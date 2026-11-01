import { nanoid } from "nanoid";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";

type CanvasImportDependencies = {
    importProject: (project: Partial<CanvasProject>) => string;
    deleteProjects: (ids: string[]) => void;
    setImageBlob: (storageKey: string, blob: Blob) => Promise<unknown>;
    setMediaBlob: (storageKey: string, blob: Blob) => Promise<unknown>;
    deleteStoredImages: (keys: Iterable<string>) => Promise<unknown>;
    deleteStoredMedia: (keys: Iterable<string>) => Promise<unknown>;
};

type PreparedImport = {
    project: CanvasProject;
    files: Array<CanvasExportAsset & { blob: Blob }>;
};

export async function importCanvasProjects(zip: Map<string, Blob>, dependencies: CanvasImportDependencies) {
    const projectFile = zip.get("projects.json");
    if (!projectFile) throw new Error("Missing projects.json");
    const data = parseCanvasExport(await projectFile.text());

    // Validate the complete archive before writing any blobs or projects.
    const prepared = data.projects.map((item) => prepareProject(item.project, item.files, zip));
    const importedIds: string[] = [];
    const imageKeys: string[] = [];
    const mediaKeys: string[] = [];
    try {
        for (const item of prepared) {
            for (const file of item.files) {
                const keys = file.storageKey.startsWith("image:") ? imageKeys : mediaKeys;
                keys.push(file.storageKey);
                await (file.storageKey.startsWith("image:") ? dependencies.setImageBlob : dependencies.setMediaBlob)(file.storageKey, file.blob);
            }
        }
        for (const item of prepared) importedIds.push(dependencies.importProject(item.project));
        return importedIds;
    } catch (error) {
        if (importedIds.length) {
            try {
                dependencies.deleteProjects(importedIds);
            } catch {
                // Preserve the original import error and still roll back newly written blobs.
            }
        }
        await Promise.all([dependencies.deleteStoredImages(imageKeys).catch(() => undefined), dependencies.deleteStoredMedia(mediaKeys).catch(() => undefined)]);
        throw error;
    }
}

function parseCanvasExport(text: string): CanvasExportFile {
    const data = JSON.parse(text) as Partial<CanvasExportFile> | null;
    if (!data || data.app !== "infinite-canvas" || !Array.isArray(data.projects)) throw new Error("Invalid canvas export");
    for (const item of data.projects) {
        if (!item || typeof item !== "object" || !item.project || typeof item.project !== "object" || !Array.isArray(item.files)) throw new Error("Invalid canvas project");
    }
    return data as CanvasExportFile;
}

function prepareProject(project: CanvasProject, files: CanvasExportAsset[], zip: Map<string, Blob>): PreparedImport {
    const referencedKeys = collectStorageKeys(project);
    const keys = new Map<string, string>();
    const preparedFiles = files.map((file) => {
        if (!file || typeof file.storageKey !== "string" || !file.storageKey.includes(":") || typeof file.path !== "string") throw new Error("Invalid canvas media");
        if (keys.has(file.storageKey)) throw new Error("Duplicate canvas media");
        const archived = zip.get(file.path);
        if (!archived) throw new Error(`Missing canvas media: ${file.path}`);
        const prefix = file.storageKey.slice(0, file.storageKey.indexOf(":") + 1);
        const storageKey = `${prefix}${nanoid()}`;
        keys.set(file.storageKey, storageKey);
        const blob = (archived.type ? archived : archived.slice(0, archived.size, file.mimeType)) as Blob;
        return { ...file, storageKey, blob };
    });
    if (referencedKeys.some((key) => !keys.has(key))) throw new Error("Canvas project references missing media");
    return { project: remapStorageKeys(project, keys), files: preparedFiles };
}

function remapStorageKeys<T>(value: T, keys: Map<string, string>): T {
    if (typeof value === "string") return (keys.get(value) || value) as T;
    if (Array.isArray(value)) return value.map((item) => remapStorageKeys(item, keys)) as T;
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "storageKey" && typeof child === "string" ? keys.get(child) || child : remapStorageKeys(child, keys)])) as T;
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => collectStorageKeys(item, keys));
    return [...keys];
}
