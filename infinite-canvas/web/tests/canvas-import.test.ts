import { expect, test } from "bun:test";

import { importCanvasProjects } from "../src/lib/canvas/canvas-import";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { CanvasExportFile, CanvasProjectExportItem } from "../src/types/canvas-export";

function project(storageKey = "image:existing"): CanvasProject {
    return {
        id: "source-project",
        title: "Imported",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [
            {
                id: "image-node",
                type: "image",
                title: "Image",
                position: { x: 0, y: 0 },
                width: 100,
                height: 100,
                metadata: { storageKey, references: [storageKey], images: [{ id: "one", status: "success", content: "blob:old", storageKey, naturalWidth: 1, naturalHeight: 1, bytes: 3, mimeType: "image/png" }] },
            },
        ],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function exportItem(source: CanvasProject, path = "files/image.png"): CanvasProjectExportItem {
    const storageKey = source.nodes[0].metadata!.storageKey!;
    return { project: source, files: [{ storageKey, path, mimeType: "image/png", bytes: 3 }] };
}

function archive(items: CanvasProjectExportItem[], includeMedia = true) {
    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: "2026-01-01T00:00:00.000Z", projects: items };
    const zip = new Map<string, Blob>([["projects.json", new Blob([JSON.stringify(data)], { type: "application/json" })]]);
    if (includeMedia) items.forEach((item) => item.files.forEach((file) => zip.set(file.path, new Blob(["new"]))));
    return zip;
}

function dependencies() {
    const writes = new Map<string, Blob>();
    const deletedImages: string[] = [];
    const deletedMedia: string[] = [];
    const imported: Partial<CanvasProject>[] = [];
    const deletedProjects: string[][] = [];
    return {
        writes,
        deletedImages,
        deletedMedia,
        imported,
        deletedProjects,
        handlers: {
            importProject: (item: Partial<CanvasProject>) => {
                imported.push(item);
                return `imported-${imported.length}`;
            },
            deleteProjects: (ids: string[]) => deletedProjects.push(ids),
            setImageBlob: async (key: string, blob: Blob) => void writes.set(key, blob),
            setMediaBlob: async (key: string, blob: Blob) => void writes.set(key, blob),
            deleteStoredImages: async (keys: Iterable<string>) => void deletedImages.push(...keys),
            deleteStoredMedia: async (keys: Iterable<string>) => void deletedMedia.push(...keys),
        },
    };
}

test("rejects missing archived media before writing or importing", async () => {
    const deps = dependencies();
    await expect(importCanvasProjects(archive([exportItem(project())], false), deps.handlers)).rejects.toThrow("Missing canvas media");
    expect(deps.writes.size).toBe(0);
    expect(deps.imported.length).toBe(0);
});

test("rejects a project whose media manifest is incomplete", async () => {
    const deps = dependencies();
    const item = exportItem(project());
    const zip = archive([{ ...item, files: [] }]);
    await expect(importCanvasProjects(zip, deps.handlers)).rejects.toThrow("references missing media");
    expect(deps.writes.size).toBe(0);
    expect(deps.imported.length).toBe(0);
});

test("remaps every reference and never reuses keys across imported projects", async () => {
    const deps = dependencies();
    const first = project();
    const second = project();
    await importCanvasProjects(archive([exportItem(first, "first.png"), exportItem(second, "second.png")]), deps.handlers);
    const firstKey = deps.imported[0].nodes![0].metadata!.storageKey!;
    const secondKey = deps.imported[1].nodes![0].metadata!.storageKey!;
    expect(firstKey).not.toBe("image:existing");
    expect(secondKey).not.toBe(firstKey);
    expect(deps.imported[0].nodes![0].metadata!.images![0].storageKey).toBe(firstKey);
    expect(deps.imported[0].nodes![0].metadata!.references).toEqual([firstKey]);
    expect([...deps.writes.keys()].sort()).toEqual([firstKey, secondKey].sort());
    expect(first.nodes[0].metadata!.storageKey).toBe("image:existing");
});

test("rolls back newly written blobs when an import write fails", async () => {
    const deps = dependencies();
    deps.handlers.setImageBlob = async () => {
        throw new Error("quota");
    };
    await expect(importCanvasProjects(archive([exportItem(project())]), deps.handlers)).rejects.toThrow("quota");
    expect(deps.deletedImages.length).toBe(1);
    expect(deps.deletedImages[0]).not.toBe("image:existing");
    expect(deps.imported.length).toBe(0);
});
