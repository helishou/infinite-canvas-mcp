import assert from "node:assert/strict";
import test from "node:test";
import { buildEpisodeGroups, chapterTitleOf, episodeLinesFromSource, estimateChapterScale, formatSeconds, groupSynopsis, sourceChapterCount, summarizeGroups, toChapterRows } from "./adapt.js";
import type { NovelChapter } from "@basketikun/canvas-agent/drama/novel-chapters";

const chapter = (index: number, chars: number): NovelChapter => ({
    index,
    title: `第 ${index} 章 标题`,
    body: "字".repeat(chars),
    startOffset: 0,
    bytes: chars * 3,
    explicit: true,
    continued: false,
});

test("镜头数与段数按 120 字/镜、5 秒/段估算", () => {
    assert.deepEqual(estimateChapterScale(0), { shots: 1, segments: 1, seconds: 3 });
    assert.deepEqual(estimateChapterScale(120), { shots: 1, segments: 1, seconds: 3 });
    assert.deepEqual(estimateChapterScale(3000), { shots: 25, segments: 15, seconds: 75 });
});

test("时长格式化：不足一分钟只显示秒", () => {
    assert.equal(formatSeconds(75), "1'15\"");
    assert.equal(formatSeconds(59), "59\"");
});

test("勾选两章、每两章一集时合成一集，集号连续", () => {
    const rows = toChapterRows([chapter(1, 1200), chapter(2, 1800)]);
    const groups = buildEpisodeGroups(rows, { perEpisode: 2, startNumber: 7 });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].episodeNumber, 7);
    assert.equal(groups[0].title, "第 1 章 标题 等 2 章");
    assert.equal(groups[0].chars, 3000);
    assert.equal(groups[0].existing, false);
});

test("取消勾选的章不参与编组，缺口处断开", () => {
    const rows = toChapterRows([chapter(1, 500), chapter(2, 500), chapter(3, 500)]);
    rows[1].selected = false;
    const groups = buildEpisodeGroups(rows, { perEpisode: 2, startNumber: 1 });
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.label), ["第 1 章", "第 3 章"]);
});

test("标题改过之后编组用新标题，已存在判断据此比对", () => {
    const rows = toChapterRows([chapter(1, 500), chapter(2, 500)]);
    rows[0].titleOverride = "山雨欲来";
    assert.equal(chapterTitleOf(rows[0]), "山雨欲来");
    const groups = buildEpisodeGroups(rows, { perEpisode: 1, startNumber: 1, existingTitles: ["山雨欲来"] });
    assert.equal(groups[0].title, "山雨欲来");
    assert.equal(groups[0].existing, true);
    assert.equal(groups[1].existing, false);
});

test("批次汇总合计集数、镜头、段数与时长", () => {
    const rows = toChapterRows([chapter(1, 1200), chapter(2, 2400)]);
    const summary = summarizeGroups(buildEpisodeGroups(rows, { perEpisode: 1, startNumber: 1 }));
    assert.equal(summary.episodes, 2);
    assert.equal(summary.chars, 3600);
    assert.equal(summary.shots, 10 + 20);
    assert.ok(summary.seconds > 0);
});

test("建集 synopsis 带章标记，并按上限截断", () => {
    const rows = toChapterRows([chapter(1, 50), chapter(2, 50)]);
    const groups = buildEpisodeGroups(rows, { perEpisode: 2, startNumber: 1 });
    const text = groupSynopsis(rows, groups[0]);
    assert.ok(text.includes("【章】第 1 章 标题"));
    assert.ok(text.includes("【章】第 2 章 标题"));
    const clipped = groupSynopsis(rows, groups[0], 20);
    assert.equal(clipped.length, 20);
});


test("原剧本按章节切成「第N集｜标题｜简介」行，不花模型", () => {
    const source = ["第一章 雪夜", "沈云推门而入，肩上落着雪。".repeat(20), "", "第二章 旧案", "陆沉把卷宗推过来。".repeat(20), "", "第三章 反转", "真相浮出。".repeat(20)].join("\n");
    const lines = episodeLinesFromSource(source);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("第1集｜"));
    assert.equal(lines[0].split("｜").length, 3, "三段式：集号｜标题｜简介");
    assert.ok(lines[0].includes("雪夜"));
    assert.ok(lines[2].startsWith("第3集｜"));
});

test("合并两章一集时行数减半，集号连续", () => {
    const source = ["第一章 一", "字".repeat(400), "第二章 二", "字".repeat(400), "第三章 三", "字".repeat(400), "第四章 四", "字".repeat(400)].join("\n");
    const lines = episodeLinesFromSource(source, { perEpisode: 2 });
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("第1集｜"));
    assert.ok(lines[1].startsWith("第2集｜"));
});

test("原剧本为空时切不出集，章数报 0", () => {
    assert.deepEqual(episodeLinesFromSource("   "), []);
    assert.equal(sourceChapterCount(""), 0);
    assert.ok(sourceChapterCount("第一章 一\n字".repeat(1)) >= 1);
});
