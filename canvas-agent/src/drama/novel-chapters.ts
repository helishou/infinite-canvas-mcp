/**
 * 小说正文 → 章节切分（纯规则，不调模型、不碰网络）。
 *
 * 方案 A「最小可用」的第一跳：把整本小说切成可逐章投喂的单元，每一章之后会各自
 * 生成一份「需求正文」并独立成一集。这里只做四件事——清掉盗版站噪声行、识别作者写的
 * 章标题、在没有标题时按段落边界兜底切分、给每个单元算稳定字节数；不猜剧情、不改写正文。
 *
 * 约定：
 * - 正文按原文照抄（只做换行归一、首尾裁剪、噪声行删除），标题行从正文里剥离，保留在 title。
 * - 有显式标题就尊重作者结构：短章只与相邻短章合并，超长章按段落二次切并标注续号。
 * - 没有显式标题才按 maxChars 兜底切，切出来的碎段向前合并，避免产出几十个 30 字的「章」。
 */

export type NovelChapter = {
    /** 1 起算的章序，等于数组下标 + 1。 */
    index: number;
    title: string;
    /** 去掉标题行后的正文。 */
    body: string;
    /** body 在清洗后文本中的起始偏移，便于回查。 */
    startOffset: number;
    /** body 的 UTF-8 字节数；与制作稿分块、单次提示词的体积判断同一口径。 */
    bytes: number;
    /** 是否来自作者显式标题；false 表示按长度兜底切出来的。 */
    explicit: boolean;
    /** 是否由超长章二次切分而来。 */
    continued: boolean;
};

export type NovelChapterIssue = {
    kind: "noise" | "no_heading" | "short" | "duplicate" | "oversized_split";
    message: string;
    chapterIndex?: number;
};

export type NovelChapterSplit = {
    chapters: NovelChapter[];
    /** 被当作噪声删掉的行数。 */
    removedNoiseLines: number;
    issues: NovelChapterIssue[];
};

export type NovelChapterOptions = {
    /** 软上限（字符数）；超出按段落边界切。 */
    maxChars?: number;
    /** 兜底切分时，小于该字符数的尾巴并入前一段；显式短章也按这个阈值判断。 */
    minChars?: number;
    /** 显式短章是否并入下一章（序章/楔子常见场景）。默认关闭：作者的章结构不主动合并。 */
    mergeShortChapters?: boolean;
    /** 单章原文上限：超过就按段落二次切（对齐影策 EPISODE_SOURCE_CHARS 12000）。 */
    maxChapterChars?: number;
};

const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_MIN_CHARS = 200;
/** 单章原文上限，与影策短剧的单集读取上限一致：超过就不该整章丢给一次提示词。 */
export const MAX_CHAPTER_CHARS = 12_000;
/** 标题行长度上限：超过这长度的一律当正文，避免把「第一章他走了」这种句子误判成标题。 */
const MAX_HEADING_CHARS = 60;

const CHAPTER_HEADING = new RegExp(
    "^(?:#{1,6}\\s*)?(?:" +
    "第\\s*[0-9零〇一二三四五六七八九十百千两]+\\s*[章节回卷部篇]" +
    "|chapter\\s+[0-9]+" +
    "|(?:序章|楔子|引子|前言|尾声|后记|番外)" +
    ")(?:[\\s:：、.·\\-—]+\\S.*)?$",
    "i",
);

/** 盗版站/作者求票的整行噪声：只按整行判断，宁可漏删也不误删正文。 */
const NOISE_LINE_PATTERNS = [
    /求(?:月票|推荐票?|收藏|订阅|打赏|鲜花)/,
    /(?:本章未完|未完待续|请记住本站|本站域名|一秒记住|手机阅读|最新章节请到)/,
    /^(?:www\.|https?:\/\/|m\.)/i,
    /^[\s\-=_*·.。]*$/,
];

/** 只有整行都在描述章标题时才认；正文里出现的「第一章」不会命中。 */
export function isChapterHeading(line: string) {
    const value = line.trim();
    return Boolean(value) && value.length <= MAX_HEADING_CHARS && CHAPTER_HEADING.test(value);
}

function isNoiseLine(line: string) {
    const value = line.trim();
    if (!value) return false;
    return NOISE_LINE_PATTERNS.some(pattern => pattern.test(value));
}

function normalizeNewlines(text: string) {
    return text.replace(/\r\n?/g, "\n");
}

/** 用 TextEncoder 而不是 Buffer：同一份代码要在 Node 与浏览器里都能跑。 */
function bodyBytes(body: string) {
    return new TextEncoder().encode(body).length;
}

function tidy(body: string) {
    return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** 从 from 开始找最近的空行边界；找不到或越界时硬切。 */
function sliceAtParagraph(text: string, from: number, maxChars: number) {
    const hardEnd = Math.min(from + maxChars, text.length);
    if (hardEnd >= text.length) return text.length;
    const floor = from + Math.max(1, Math.floor(maxChars * 0.6));
    const boundary = text.slice(floor, hardEnd).lastIndexOf("\n\n");
    return boundary >= 0 ? floor + boundary + 2 : hardEnd;
}

type Heading = { offset: number; end: number; title: string };

function collectHeadings(lines: Array<{ text: string; offset: number }>, text: string): Heading[] {
    const headings: Heading[] = [];
    for (const line of lines) {
        if (!isChapterHeading(line.text)) continue;
        headings.push({ offset: line.offset, end: Math.min(text.length, line.offset + line.text.length), title: line.text.trim() });
    }
    return headings;
}

function pushChapter(chapters: NovelChapter[], input: { title: string; body: string; startOffset: number; explicit: boolean; continued?: boolean }) {
    const body = tidy(input.body);
    if (!body) return;
    chapters.push({
        index: chapters.length + 1,
        title: input.title,
        body,
        startOffset: input.startOffset,
        bytes: bodyBytes(body),
        explicit: input.explicit,
        continued: Boolean(input.continued),
    });
}

/** 清洗噪声行，并记录删掉多少行；返回的文本用于后续切分，偏移也相对它计算。 */
function stripNoiseLines(text: string) {
    let removed = 0;
    const kept = text.split("\n").filter(line => {
        if (!isNoiseLine(line)) return true;
        removed += 1;
        return false;
    });
    return { text: kept.join("\n"), removed };
}

/**
 * 拆分整本小说并汇总问题清单。空文本返回空结果；纯空白同样视为空。
 */
export function analyzeNovelChapters(text: string, options: NovelChapterOptions = {}): NovelChapterSplit {
    const normalized = normalizeNewlines(String(text ?? ""));
    if (!normalized.trim()) return { chapters: [], removedNoiseLines: 0, issues: [] };
    const maxChars = Math.max(200, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
    const minChars = Math.max(0, Math.floor(options.minChars ?? DEFAULT_MIN_CHARS));
    const maxChapterChars = Math.max(maxChars, Math.floor(options.maxChapterChars ?? MAX_CHAPTER_CHARS));
    const cleaned = stripNoiseLines(normalized);
    const source = cleaned.text;
    const issues: NovelChapterIssue[] = [];
    if (cleaned.removed) issues.push({ kind: "noise", message: `删除 ${cleaned.removed} 行平台噪声` });

    const lines: Array<{ text: string; offset: number }> = [];
    let cursor = 0;
    for (const raw of source.split("\n")) {
        lines.push({ text: raw, offset: cursor });
        cursor += raw.length + 1;
    }

    const headings = collectHeadings(lines, source);
    const chapters: NovelChapter[] = [];

    if (!headings.length) {
        issues.push({ kind: "no_heading", message: "没有识别到章节标题，已按段落长度兜底切分" });
        let from = 0;
        while (from < source.length) {
            const to = sliceAtParagraph(source, from, maxChars);
            pushChapter(chapters, { title: `第 ${chapters.length + 1} 段`, body: source.slice(from, to), startOffset: from, explicit: false });
            from = to;
        }
        return { chapters: mergeFallbackChapters(chapters, minChars), removedNoiseLines: cleaned.removed, issues };
    }

    const first = headings[0];
    if (first.offset > 0) pushChapter(chapters, { title: "（开篇）", body: source.slice(0, first.offset), startOffset: 0, explicit: false });

    let oversized = 0;
    headings.forEach((heading, position) => {
        const next = headings[position + 1];
        const body = source.slice(heading.end, next ? next.offset : source.length);
        if (body.trim().length > maxChapterChars) {
            oversized += 1;
            splitOversizedChapter(chapters, heading.title, body, heading.end, maxChars);
            return;
        }
        pushChapter(chapters, { title: heading.title, body, startOffset: heading.end, explicit: true });
    });
    if (oversized) issues.push({ kind: "oversized_split", message: `${oversized} 个超长章已按段落二次切分` });

    warnDuplicateTitles(chapters, issues);
    const finalChapters = options.mergeShortChapters ? mergeShortChapters(chapters, minChars, issues) : reindex(chapters);
    if (!options.mergeShortChapters) for (const chapter of finalChapters) {
        if (chapter.explicit && chapter.body.length < minChars) issues.push({ kind: "short", chapterIndex: chapter.index, message: `「${chapter.title}」只有 ${chapter.body.length} 字，若为序章/楔子可用 mergeShortChapters 并入下一章` });
    }
    return { chapters: finalChapters, removedNoiseLines: cleaned.removed, issues };
}

/** `splitNovelChapters` 只关心章节列表；需要问题清单时用 analyzeNovelChapters。 */
export function splitNovelChapters(text: string, options: NovelChapterOptions = {}): NovelChapter[] {
    return analyzeNovelChapters(text, options).chapters;
}

/** 超长章按段落边界切成 `原标题（续 N）`；不丢任何正文。 */
function splitOversizedChapter(chapters: NovelChapter[], title: string, body: string, startOffset: number, maxChars: number) {
    let from = 0;
    let part = 1;
    while (from < body.length) {
        const end = sliceAtParagraph(body, from, maxChars);
        const slice = body.slice(from, end);
        pushChapter(chapters, {
            title: part === 1 ? title : `${title}（续 ${part}）`,
            body: slice,
            startOffset: startOffset + from,
            explicit: true,
            continued: part > 1,
        });
        from = end;
        part += 1;
    }
}

function warnDuplicateTitles(chapters: NovelChapter[], issues: NovelChapterIssue[]) {
    const seen = new Map<string, number>();
    for (const chapter of chapters) {
        const previous = seen.get(chapter.title);
        if (previous === undefined) {
            seen.set(chapter.title, chapter.index);
            continue;
        }
        issues.push({ kind: "duplicate", chapterIndex: chapter.index, message: `第 ${chapter.index} 章与第 ${previous} 章同名：${chapter.title}` });
    }
}

/** 只合并兜底切出来的碎段：带作者标题的章即使很短也保持独立。 */
function mergeFallbackChapters(chapters: NovelChapter[], minChars: number) {
    if (!minChars || chapters.length < 2) return reindex(chapters);
    const merged: NovelChapter[] = [];
    for (const chapter of chapters) {
        const previous = merged[merged.length - 1];
        if (previous && !previous.explicit && !chapter.explicit && chapter.body.length < minChars) {
            const body = `${previous.body}\n\n${chapter.body}`;
            merged[merged.length - 1] = { ...previous, body, bytes: bodyBytes(body) };
            continue;
        }
        merged.push(chapter);
    }
    return reindex(merged);
}

/** 显式短章（序章/楔子这类一两句话的）并入下一章，标题用「A · B」保留两个名字。 */
function mergeShortChapters(chapters: NovelChapter[], minChars: number, issues: NovelChapterIssue[]) {
    if (!minChars || chapters.length < 2) return reindex(chapters);
    const merged: NovelChapter[] = [];
    for (let index = 0; index < chapters.length; index += 1) {
        const chapter = chapters[index];
        const next = chapters[index + 1];
        if (chapter.body.length < minChars && next && !chapter.continued) {
            const body = `${chapter.body}\n\n${next.body}`;
            issues.push({ kind: "short", chapterIndex: chapter.index, message: `「${chapter.title}」过短，已并入「${next.title}」` });
            merged.push({ ...next, title: `${chapter.title} · ${next.title}`, body, bytes: bodyBytes(body), startOffset: chapter.startOffset });
            index += 1;
            continue;
        }
        merged.push(chapter);
    }
    return reindex(merged);
}

function reindex(chapters: NovelChapter[]) {
    return chapters.map((chapter, position) => ({ ...chapter, index: position + 1 }));
}

/** 章节标题是否像「第 3 集」这种可直接拿去做分集标题的形态。 */
export function chapterEpisodeTitle(chapter: NovelChapter, maxLength = 40) {
    const value = chapter.title.trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}…`;
}

/** 一次投喂的预算检查：超预算的章建议先二次切分，避免单次提示词被截断。 */
export function chapterFitsBudget(chapter: NovelChapter, budgetChars = MAX_CHAPTER_CHARS) {
    return chapter.body.length <= budgetChars;
}
