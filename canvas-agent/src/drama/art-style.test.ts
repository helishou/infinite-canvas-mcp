import assert from "node:assert/strict";
import test from "node:test";
import { artStyleLine, normalizeArtStyle, withArtStyle } from "./art-style";

test("没有画风时提示词一字不动", () => {
    assert.equal(withArtStyle("角色三视图", ""), "角色三视图");
    assert.equal(withArtStyle("角色三视图", "   "), "角色三视图");
    assert.equal(artStyleLine(""), "");
});

test("有画风就追加一句全片统一约束", () => {
    const out = withArtStyle("角色设定三视图｜沈砚", "国风水墨");
    assert.match(out, /角色设定三视图｜沈砚\n全片统一画风：国风水墨/);
    assert.match(out, /勿混搭/);
});

test("重复拼接是幂等的（重跑不会叠两遍）", () => {
    const once = withArtStyle("场景主图", "赛博朋克");
    const twice = withArtStyle(once, "赛博朋克");
    assert.equal(twice, once);
    assert.equal(once.split("全片统一画风").length - 1, 1);
});

test("换画风会换成新的一句，不是同时留两句", () => {
    const first = withArtStyle("道具设定图", "国风水墨");
    const second = withArtStyle(first.replace("全片统一画风：国风水墨", ""), "写实电影");
    assert.match(second, /写实电影/);
    assert.doesNotMatch(second, /国风水墨/);
});

test("英文剧目用英文约束句", () => {
    assert.match(artStyleLine("anime cel", "en-US"), /Art style \(whole series/);
});

test("空提示词只留约束句", () => {
    assert.equal(withArtStyle("", "国风水墨"), artStyleLine("国风水墨"));
});

test("取值两端空格会被裁掉", () => {
    assert.equal(normalizeArtStyle("  写实电影 "), "写实电影");
});
