import assert from "node:assert/strict";
import test from "node:test";
import { chapterExceedsSourceLimit, episodeTitleForGroup, groupChaptersIntoEpisodes, type ChapterEpisodeInput } from "./chapter-episodes.js";

const chapters: ChapterEpisodeInput[] = Array.from({ length: 6 }, (_, index) => ({ position: index, title: `第 ${index + 1} 章 标题`, chars: 3000 }));

test("默认一章一集，标签按章序", () => {
    const { groups } = groupChaptersIntoEpisodes(chapters);
    assert.equal(groups.length, 6);
    assert.equal(groups[0].label, "第 1 章");
    assert.equal(groups[5].label, "第 6 章");
    assert.equal(groups[0].chars, 3000);
});

test("每 3 章一集得到两组，标签是区间", () => {
    const { groups } = groupChaptersIntoEpisodes(chapters, 3);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.label), ["第 1–3 章", "第 4–6 章"]);
    assert.equal(groups[0].chars, 9000);
});

test("隔章勾选时在缺口处断开，不硬凑满 N 章", () => {
    const sparse = [chapters[0], chapters[1], chapters[3], chapters[4]];
    const { groups } = groupChaptersIntoEpisodes(sparse, 3);
    assert.deepEqual(groups.map(group => group.label), ["第 1–2 章", "第 4–5 章"]);
    assert.deepEqual(groups[0].chapterPositions, [0, 1]);
});

test("超过单集原文字数上限时只标 oversized，不抛错", () => {
    const heavy = Array.from({ length: 4 }, (_, index) => ({ position: index, title: `第 ${index + 1} 章`, chars: 15000 }));
    const result = groupChaptersIntoEpisodes(heavy, 4);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].oversized, true);
    assert.equal(result.oversized.length, 1);
    assert.ok(result.diagnostics.some(text => text.includes("超过单集上限")));
    const single = groupChaptersIntoEpisodes(heavy, 1);
    assert.equal(single.oversized.length, 0, "拆成一章一集后不再超限");
});

test("每集章数超上限被收紧到 12 并给提示", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ position: index, title: `第 ${index + 1} 章`, chars: 1000 }));
    const result = groupChaptersIntoEpisodes(many, 30);
    assert.equal(result.groups[0].chapterTitles.length, 12);
    assert.ok(result.diagnostics.some(text => text.includes("收紧为 12")));
});

test("集标题：单章用章名，多章用「首章名 等 N 章」", () => {
    const { groups } = groupChaptersIntoEpisodes(chapters, 3);
    assert.equal(episodeTitleForGroup(groups[0]), "第 1 章 标题 等 3 章");
    const single = groupChaptersIntoEpisodes(chapters, 1);
    assert.equal(episodeTitleForGroup(single.groups[2]), "第 3 章 标题");
});

test("位置重复报错，单章字数上限单独判定", () => {
    assert.throws(() => groupChaptersIntoEpisodes([{ position: 0, title: "a", chars: 1 }, { position: 0, title: "b", chars: 1 }]), /CHAPTER_EPISODE_DUPLICATE/);
    assert.equal(chapterExceedsSourceLimit(12000), false);
    assert.equal(chapterExceedsSourceLimit(12001), true);
});
