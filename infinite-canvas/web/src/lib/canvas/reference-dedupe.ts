export type ReferenceLike = {
    id?: string;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
};

// 保存参考的 id 是序号，连接参考的 id 是节点 id；跨来源只能按媒体身份合并。
export function dedupeReferenceImages<T extends ReferenceLike>(...groups: Array<readonly T[] | null | undefined>): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const group of groups) {
        for (const reference of group || []) {
            if (!reference) continue;
            const keys = [reference.storageKey, reference.url, reference.dataUrl].filter((key): key is string => Boolean(key));
            if (!keys.length && reference.id) keys.push(`id:${reference.id}`);
            if (keys.some((key) => seen.has(key))) continue;
            keys.forEach((key) => seen.add(key));
            result.push(reference);
        }
    }
    return result;
}
