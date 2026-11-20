import assert from "node:assert/strict";
import test from "node:test";
import { buildEpisodeGroupingPrompt, extractJsonObject, missingChapters, parseEpisodeGrouping, type GroupingChapter } from "./episode-grouping.js";

const chapters: GroupingChapter[] = [
    { index: 1, title: "楔子", text: "甲出场，立下约定。" },
    { index: 2, title: "夜袭", text: "乙夜袭营地，约定被打破。" },
    { index: 3, title: "追凶", text: "甲追查真凶。" },
    { index: 4, title: "真相", text: "真相大白，故事结束。" },
];

test("提示词带章节序号、目标 JSON 形状与拆并规则", () => {
    const prompt = buildEpisodeGroupingPrompt({ name: "测试剧", chapters, startNumber: 7 });
    assert.match(prompt, /\[1\] 楔子/);
    assert.match(prompt, /\[4\] 真相/);
    assert.match(prompt, /"episodes"/);
    assert.match(prompt, /"chapters"/);
    assert.match(prompt, /下一集编号：7/);
    assert.match(prompt, /拆成两集/);
    assert.match(prompt, /每一章至少被一集覆盖/);
});

test("解析补齐漏章并保证全覆盖：过滤越界序号、丢弃空梗概集、单集内去重", () => {
    const raw = JSON.stringify({ episodes: [
        { title: "合并集", chapters: [1, "2", 2, 99], synopsis: "甲与乙在营地立约又反目。" },
        { title: "无章集", chapters: [], synopsis: "不应该出现" },
        { title: "空梗概", chapters: [3], synopsis: "  " },
    ] });
    const groups = parseEpisodeGrouping(raw, chapters);
    assert.deepEqual(groups.map((g) => g.chapters), [[1, 2], [3], [4]]);
    assert.equal(groups[0].title, "合并集");
    assert.equal(groups[1].title, "追凶"); // 模型漏章：用原章名兜底
    assert.equal(groups[2].synopsis, "真相大白，故事结束。");
    assert.deepEqual(missingChapters(groups, chapters.map((c) => c.index)), []);
});

test("一章拆两集被保留（跨集重复章不算冲突）", () => {
    const raw = JSON.stringify({ episodes: [
        { title: "前半", chapters: [2], synopsis: "夜袭之前。" },
        { title: "后半", chapters: [2], synopsis: "夜袭之后。" },
        { title: "其余", chapters: [1, 3, 4], synopsis: "余下剧情。" },
    ] });
    const groups = parseEpisodeGrouping(raw, chapters);
    assert.deepEqual(groups.map((g) => g.chapters), [[2], [2], [1, 3, 4]]);
    assert.deepEqual(missingChapters(groups, chapters.map((c) => c.index)), []);
});

test("容忍 Markdown 围栏与前后文字，标题缺失时用梗概前 10 字", () => {
    const raw = '好的，这是分集：\n```json\n{"episodes":[{"chapters":[1,2,3,4],"synopsis":"从立约到真相的完整故事，贯穿四章。"}]}\n```\n以上。';
    const groups = parseEpisodeGrouping(raw, chapters);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, "从立约到真相的完整故");
    assert.equal(extractJsonObject(raw).startsWith("{"), true);
});

test("模型返回空 episodes 时全部按原章兜底，不会编造分组", () => {
    const groups = parseEpisodeGrouping('{"episodes":[]}', chapters);
    assert.equal(groups.length, chapters.length);
    assert.deepEqual(groups.map((g) => g.chapters), [[1], [2], [3], [4]]);
});

test("非法 JSON 抛错，不返回任何分组", () => {
    assert.throws(() => parseEpisodeGrouping("模型暂时不可用", chapters), /分集规划失败|合法 JSON/);
    assert.deepEqual(missingChapters([], [1, 2]), [1, 2]);
});
