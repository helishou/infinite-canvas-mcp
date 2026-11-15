/**
 * 小说改编面板的纯逻辑：章节选择、集规模估算、建集准备。
 *
 * 只做可单测的换算与整形，不碰 React、不发请求。面板负责把这里的结果画出来，
 * 提交时再用同一份结果去建集，保证「界面显示几集就建几集」。
 */

import { groupChaptersIntoEpisodes, episodeTitleForGroup, EPISODE_SOURCE_CHARS, type ChapterEpisodeGroup } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { analyzeNovelChapters, type NovelChapter, type NovelChapterIssue } from "@basketikun/canvas-agent/drama/novel-chapters";

/** 一个镜头大约承载的正文字数，与 fallbackChapterDemand 的 beatChars 一致。 */
export const BEAT_CHARS = 120;
/** 与改编面板、canvas-agent 默认一致的拆章上限。 */
export const NOVEL_MAX_CHARS = 3000;
/** 与 canvas-agent 默认一致的最短章长度。 */
export const NOVEL_MIN_CHARS = 200;
/** 默认单镜秒数，用于估算时长。 */
export const BEAT_SECONDS = 3;
/** 单段 Clip 目标时长，与 chapter-storyboard 的默认一致。 */
export const CLIP_SECONDS = 5;

export type AdaptChapterRow = NovelChapter & {
    /** 用户是否勾选进入改编。 */
    selected: boolean;
    /** 用户改过的标题；空表示沿用原章名。 */
    titleOverride: string;
};

export type EpisodeScale = { shots: number; segments: number; seconds: number };

export type EpisodeGroupRow = ChapterEpisodeGroup & {
    /** 建集时用的标题。 */
    title: string;
    /** 该集在本次提交里的编号。 */
    episodeNumber: number;
    scale: EpisodeScale;
    /** 与已有分集同名，默认跳过。 */
    existing: boolean;
};

export function toChapterRows(chapters: readonly NovelChapter[]): AdaptChapterRow[] {
    return chapters.map(chapter => ({ ...chapter, selected: true, titleOverride: "" }));
}

export function chapterTitleOf(row: AdaptChapterRow) {
    return row.titleOverride.trim() || row.title;
}

export function chapterCharsOf(row: AdaptChapterRow) {
    return row.body.length;
}

/** 一个字大约几个镜头：至少 1 个。 */
export function estimateChapterScale(chars: number, clipSeconds = CLIP_SECONDS): EpisodeScale {
    const shots = Math.max(1, Math.ceil(Math.max(0, chars) / BEAT_CHARS));
    const seconds = shots * BEAT_SECONDS;
    const segments = Math.max(1, Math.ceil(seconds / Math.max(0.5, clipSeconds)));
    return { shots, segments, seconds };
}

export function formatSeconds(seconds: number) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes ? `${minutes}'${String(rest).padStart(2, "0")}"` : `${rest}"`;
}

/**
 * 把勾选的章节按「每 N 章一集」编组，补上标题、集号、估算与「已存在」标记。
 * 集号从 startNumber 连续递增；existing 以已有分集标题做保守比对（同名即视为已存在）。
 */
export function buildEpisodeGroups(
    rows: readonly AdaptChapterRow[],
    options: { perEpisode: number; startNumber: number; existingTitles?: readonly string[]; clipSeconds?: number },
): EpisodeGroupRow[] {
    const selected = rows.filter(row => row.selected);
    const positions = new Map(rows.map((row, index) => [row, index]));
    const grouping = groupChaptersIntoEpisodes(
        selected.map(row => ({ position: positions.get(row) ?? 0, title: chapterTitleOf(row), chars: chapterCharsOf(row) })),
        options.perEpisode,
    );
    const existing = new Set((options.existingTitles || []).map(title => title.trim()));
    return grouping.groups.map((group, index) => {
        // 多章合并时用「首章名 等 N 章」，单章直接用章名；与影策的分集标题规则一致。
        const title = episodeTitleForGroup(group);
        const chars = group.chars;
        return {
            ...group,
            index: index + 1,
            title,
            episodeNumber: options.startNumber + index,
            scale: estimateChapterScale(chars, options.clipSeconds ?? CLIP_SECONDS),
            existing: existing.has(title),
        };
    });
}

/** 一次提交的总体量，用于底部批次条。 */
export function summarizeGroups(groups: readonly EpisodeGroupRow[]) {
    return groups.reduce((total, group) => ({
        episodes: total.episodes + 1,
        shots: total.shots + group.scale.shots,
        segments: total.segments + group.scale.segments,
        seconds: total.seconds + group.scale.seconds,
        chars: total.chars + group.chars,
    }), { episodes: 0, shots: 0, segments: 0, seconds: 0, chars: 0 });
}

/** 建集时的 synopsis：先放该组原文，S3 生成草案时再替换成带【镜头】标记的需求正文。 */
export function groupSynopsis(rows: readonly AdaptChapterRow[], group: ChapterEpisodeGroup, limit = EPISODE_SOURCE_CHARS) {
    const byPosition = new Map(rows.map((row, index) => [index, row]));
    const text = group.chapterPositions
        .map(position => byPosition.get(position))
        .filter((row): row is AdaptChapterRow => Boolean(row))
        .map(row => `【章】${chapterTitleOf(row)}\n${row.body}`)
        .join("\n\n");
    return text.length > limit ? text.slice(0, limit) : text;
}

export function issueLabel(issue: NovelChapterIssue) {
    return issue.message;
}

/**
 * 原剧本 → 「第N集｜标题｜简介」行：与改编面板同一套章节切分与编组规则，纯本地，不花模型。
 * 大纲向导的「分集目录」一步在有原剧本时用它，避免让模型凭空编集数。
 */
export function episodeLinesFromSource(source: string, options: { perEpisode?: number; startNumber?: number; maxChars?: number; mergeShort?: boolean } = {}) {
    const split = analyzeNovelChapters(source, { maxChars: options.maxChars ?? NOVEL_MAX_CHARS, minChars: NOVEL_MIN_CHARS, mergeShortChapters: options.mergeShort ?? false });
    const rows = toChapterRows(split.chapters);
    const groups = buildEpisodeGroups(rows, { perEpisode: options.perEpisode ?? 1, startNumber: options.startNumber ?? 1 });
    return groups.map((group) => {
        const brief = groupSynopsis(rows, group, 300)
            .replace(/【章】[^\n]*\n?/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
        return `第${group.episodeNumber}集｜${group.title}｜${brief}`;
    });
}

/** 原剧本能被识别成几章；没有原剧本或认不出章节返回 0。 */
export function sourceChapterCount(source: string, maxChars = NOVEL_MAX_CHARS) {
    if (!String(source || "").trim()) return 0;
    return analyzeNovelChapters(source, { maxChars, minChars: NOVEL_MIN_CHARS }).chapters.length;
}
