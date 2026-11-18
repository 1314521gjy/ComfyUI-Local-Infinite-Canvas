export type DramaChapter = {
    title: string;
    content: string;
};

export type DramaImportedEpisode = {
    episodeNumber: number;
    title: string;
    script: string;
    chapterTitles: string[];
};

export const DEFAULT_CHAPTER_PATTERN = "^\\s*(第[0-9０-９零一二三四五六七八九十百千万]+[章回节][^\\n\\r]*)";

export function splitNovelChapters(text: string, pattern: string): DramaChapter[] {
    const source = String(pattern || "").trim();
    if (!source) throw new Error("请输入章节正则");
    let regex: RegExp;
    try {
        regex = new RegExp(source, "gm");
    } catch {
        throw new Error("章节正则格式不正确");
    }
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];
    const matches = [...normalized.matchAll(regex)];
    if (!matches.length) throw new Error("未匹配到任何章节，请调整章节正则");
    return matches
        .map((match, index) => {
            const title = String(match[1] || match[0] || "").trim();
            const titleStart = match.index ?? 0;
            const contentStart = titleStart + String(match[0] || "").length;
            const nextTitleStart = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
            const content = normalized.slice(contentStart, nextTitleStart).trim();
            return { title: title || `第${index + 1}章`, content };
        })
        .filter((chapter) => chapter.title || chapter.content);
}

export function buildEpisodesFromChapters(chapters: DramaChapter[], chaptersPerEpisode: number, startNumber = 1): DramaImportedEpisode[] {
    const size = Math.max(1, Number(chaptersPerEpisode) || 1);
    const groups: { chapterTitles: string[]; script: string }[] = [];
    chapters.forEach((chapter, index) => {
        const groupIndex = Math.floor(index / size);
        if (!groups[groupIndex]) groups[groupIndex] = { chapterTitles: [], script: "" };
        groups[groupIndex].chapterTitles.push(chapter.title);
        groups[groupIndex].script = [groups[groupIndex].script, `${chapter.title}\n${chapter.content}`].filter(Boolean).join("\n\n");
    });
    return groups.map((group, index) => ({
        episodeNumber: startNumber + index,
        title: group.chapterTitles.length === 1 ? group.chapterTitles[0] : `${group.chapterTitles[0]} - ${group.chapterTitles[group.chapterTitles.length - 1]}`,
        script: group.script,
        chapterTitles: group.chapterTitles,
    }));
}

export function episodeSynopsis(script: string, limit = 60): string {
    const line = String(script || "")
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item && item.length > 2 && !item.startsWith("第"));
    const text = (line || String(script || "").trim()).replace(/\s+/g, "");
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
