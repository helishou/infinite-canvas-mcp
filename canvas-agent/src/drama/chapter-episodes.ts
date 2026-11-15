/**
 * 章节 → 分集编组（纯函数，不建集、不调模型）。
 *
 * 对齐影策短剧的同名能力（`web/src/lib/drama/chapter-selection.ts` 的 groupChapterEpisodes、
 * `backend/internal/app/drama_service.go` 的 groupDramaChapterEpisodes），规则与上限保持一致，
 * 便于评估「同一套小说、两边各拆几集」时口径可比：
 *
 * - 默认「一章一集」，用户可改成「每 N 章一集」，N 上限 12（影策 dramaMaxChaptersPerEpisode）；
 * - 只合并**位置相邻**的章：中间有没勾选的章就在那里断开，不硬凑满 N 章；
 * - 合并后单集原文上限 40000 字（影策 dramaEpisodeSourceRunes），超了只做标记，由界面决定是否阻断；
 * - 集标题：单章用章名；多章用「首章名 等 N 章」（影策同名规则）。
 *
 * 与影策的差别只有一个：我们是「一次建集调用里把 N 章的 demand 拼成一份」，不引入章节-集关联表。
 */

export type ChapterEpisodeInput = {
    /** 章节在全书中的位置，0 起算；用于判断是否相邻。 */
    position: number;
    title: string;
    /** 正文字符数（不含首尾空白）。 */
    chars: number;
};

export type ChapterEpisodeGroup = {
    /** 1 起算的集序（相对本批）。 */
    index: number;
    /** 「第 5 章」或「第 5–8 章」。 */
    label: string;
    chapterPositions: number[];
    chapterTitles: string[];
    chars: number;
    /** 合计字数超过单集上限；调用方可以据此阻断或提示减章。 */
    oversized: boolean;
};

export type ChapterEpisodeGrouping = {
    groups: ChapterEpisodeGroup[];
    /** 超限的分组，便于界面直接高亮。 */
    oversized: ChapterEpisodeGroup[];
    /** 非致命提示：不规范输入被修正时写这里。 */
    diagnostics: string[];
};

export const MAX_CHAPTERS_PER_EPISODE = 12;
export const EPISODE_SOURCE_CHARS = 40_000;
export const CHAPTER_SOURCE_CHARS = 12_000;

/** 把章节按「每 N 章一集」编组；默认一章一集。 */
export function groupChaptersIntoEpisodes(
    chapters: readonly ChapterEpisodeInput[],
    perEpisode = 1,
    options: { maxChars?: number; maxChapters?: number } = {},
): ChapterEpisodeGrouping {
    const maxChars = Math.max(1, Math.floor(options.maxChars ?? EPISODE_SOURCE_CHARS));
    const maxChapters = Math.max(1, Math.floor(options.maxChapters ?? MAX_CHAPTERS_PER_EPISODE));
    const diagnostics: string[] = [];
    const requested = Math.floor(perEpisode) || 1;
    const size = Math.min(maxChapters, Math.max(1, requested));
    if (requested !== size) diagnostics.push(`每集章数 ${requested} 已按上限收紧为 ${size}`);

    const sorted = [...chapters].filter(chapter => Number.isInteger(chapter.position) && chapter.position >= 0).sort((left, right) => left.position - right.position);
    const seen = new Set<number>();
    for (const chapter of sorted) {
        if (seen.has(chapter.position)) throw new Error(`CHAPTER_EPISODE_DUPLICATE: 章节位置重复：${chapter.position}`);
        seen.add(chapter.position);
    }

    const groups: ChapterEpisodeGroup[] = [];
    for (let start = 0; start < sorted.length;) {
        let end = start + 1;
        while (end < sorted.length && end - start < size && sorted[end].position === sorted[end - 1].position + 1) end += 1;
        const slice = sorted.slice(start, end);
        start = end;
        const first = slice[0].position + 1;
        const last = slice[slice.length - 1].position + 1;
        const chars = slice.reduce((sum, chapter) => sum + Math.max(0, Math.floor(chapter.chars)), 0);
        groups.push({
            index: groups.length + 1,
            label: slice.length > 1 ? `第 ${first}–${last} 章` : `第 ${first} 章`,
            chapterPositions: slice.map(chapter => chapter.position),
            chapterTitles: slice.map(chapter => chapter.title),
            chars,
            oversized: chars > maxChars,
        });
    }
    const oversized = groups.filter(group => group.oversized);
    for (const group of oversized) diagnostics.push(`${group.label} 合计 ${group.chars} 字，超过单集上限 ${maxChars} 字，请减少每集章数`);
    return { groups, oversized, diagnostics };
}

/** 集标题：单章用章名；多章「首章名 等 N 章」，与影策一致。超长截断。 */
export function episodeTitleForGroup(group: ChapterEpisodeGroup, maxLength = 40) {
    const first = group.chapterTitles[0] || group.label;
    const title = group.chapterTitles.length > 1 ? `${first} 等 ${group.chapterTitles.length} 章` : first;
    const value = title.trim();
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** 单章是否超过单集原文上限（影策 12,000 字/章，超了要按段落再切）。 */
export function chapterExceedsSourceLimit(chars: number, limit = CHAPTER_SOURCE_CHARS) {
    return chars > limit;
}
