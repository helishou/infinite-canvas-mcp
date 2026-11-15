import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNovelChapters, chapterEpisodeTitle, isChapterHeading, splitNovelChapters } from "./novel-chapters.js";

test("显式章标题按作者结构切分，标题从正文剥离", () => {
    const text = [
        "第一章 山雨欲来",
        "夜雨敲在青石板上。",
        "陈九把刀横在膝上。",
        "",
        "第二章 破庙",
        "破庙里点着一盏灯。",
    ].join("\n");
    const chapters = splitNovelChapters(text);
    assert.equal(chapters.length, 2);
    assert.deepEqual(chapters.map(chapter => chapter.title), ["第一章 山雨欲来", "第二章 破庙"]);
    assert.equal(chapters[0].body, "夜雨敲在青石板上。\n陈九把刀横在膝上。");
    assert.equal(chapters[0].explicit, true);
    assert.equal(chapters[1].body, "破庙里点着一盏灯。");
});

test("首个标题之前的正文落成开篇章", () => {
    const chapters = splitNovelChapters("序前的一段引子。\n\n第一章 起\n正文。");
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].title, "（开篇）");
    assert.equal(chapters[0].body, "序前的一段引子。");
    assert.equal(chapters[1].title, "第一章 起");
});

test("完全没有标题时按段落边界兜底切分，碎段向前合并", () => {
    const paragraph = `${"字".repeat(180)}\n\n`;
    const chapters = splitNovelChapters(paragraph.repeat(6), { maxChars: 400, minChars: 150 });
    assert.ok(chapters.length >= 2, "长文本必须被切成多段");
    assert.ok(chapters.every(chapter => chapter.explicit === false));
    for (const chapter of chapters) assert.ok(chapter.body.length <= 400, `兜底切分超长：${chapter.body.length}`);
    assert.deepEqual(chapters.map(chapter => chapter.index), chapters.map((_, index) => index + 1));
});

test("正文里提到「第一章」的句子不会被当成标题", () => {
    const prose = `他翻到第一章就困了，${"很长的句子".repeat(12)}。`;
    assert.equal(isChapterHeading(prose), false);
    const chapters = splitNovelChapters(`第一章 真标题\n${prose}`);
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].title, "第一章 真标题");
});

test("空白文本返回空数组，字节数按 UTF-8 计", () => {
    assert.deepEqual(splitNovelChapters("   \n\n "), []);
    const [chapter] = splitNovelChapters("第一章 测\n中文");
    assert.equal(chapter.body, "中文");
    assert.equal(chapter.bytes, 6, "两个中文字应为 6 字节");
});

test("短标题不截断，超长标题截断成集名", () => {
    const [chapter] = splitNovelChapters("第一章 短\n正文");
    assert.equal(chapterEpisodeTitle(chapter), "第一章 短");
    const longTitle = `第一章 ${"很长".repeat(9)}`;
    const [longChapter] = splitNovelChapters(`${longTitle}\n正文`);
    assert.equal(longChapter.title, longTitle);
    assert.ok(chapterEpisodeTitle(longChapter, 20).endsWith("…"));
});

test("删掉盗版站噪声行，并统计删除数量", () => {
    const text = ["第一章 陨落", "他站在广场上。", "求月票！", "www.example.com", "第二章 退婚", "她来了。"].join("\n");
    const result = analyzeNovelChapters(text);
    assert.equal(result.chapters.length, 2);
    assert.equal(result.removedNoiseLines, 2);
    assert.ok(result.issues.some(issue => issue.kind === "noise"));
    assert.ok(!result.chapters[0].body.includes("月票"));
    assert.ok(!result.chapters[0].body.includes("example.com"));
});

test("超长显式章按段落二次切分，标注续号且不丢正文", () => {
    const paragraph = `${"字".repeat(900)}\n\n`;
    const body = paragraph.repeat(12);
    const result = analyzeNovelChapters(`第一章 长夜\n${body}`, { maxChars: 1000, maxChapterChars: 3000 });
    assert.ok(result.chapters.length >= 2);
    assert.equal(result.chapters[0].title, "第一章 长夜");
    assert.ok(result.chapters[1].title.includes("（续 2）"));
    assert.ok(result.issues.some(issue => issue.kind === "oversized_split"));
    const totalChars = result.chapters.reduce((sum, chapter) => sum + chapter.body.replace(/\s/g, "").length, 0);
    assert.equal(totalChars, body.replace(/\s/g, "").length, "切分不得丢字");
});

test("重复章标题给出提示但两章都保留", () => {
    const result = analyzeNovelChapters("第一章 开端\n甲。\n第一章 开端\n乙。");
    assert.equal(result.chapters.length, 2);
    assert.ok(result.issues.some(issue => issue.kind === "duplicate"));
});

test("显式短章默认不合并，开启 mergeShortChapters 后并入下一章", () => {
    const text = ["序章", "穿越了。", "第一章 零悟性", "测试石碑毫无反应。".repeat(20)].join("\n");
    const keep = analyzeNovelChapters(text);
    assert.equal(keep.chapters.length, 2);
    assert.equal(keep.chapters[0].title, "序章");
    assert.ok(keep.issues.some(issue => issue.kind === "short"));

    const merged = analyzeNovelChapters(text, { mergeShortChapters: true });
    assert.equal(merged.chapters.length, 1);
    assert.equal(merged.chapters[0].title, "序章 · 第一章 零悟性");
    assert.ok(merged.chapters[0].body.startsWith("穿越了。"));
});
