import assert from "node:assert/strict";
import test from "node:test";

import { applyTurnaroundLayout, isTurnaroundAsset, turnaroundAspectIssue, turnaroundLayoutIssues } from "./turnaround-layout";

test("只写四视图不算合格：四格、网格三分、空手都要写出来", () => {
    assert.equal(isTurnaroundAsset("资产·蟒妻人形·四视图"), true);
    assert.equal(isTurnaroundAsset("character turnaround sheet"), true);
    assert.equal(isTurnaroundAsset("街市与县衙场景图"), false);

    const issues = turnaroundLayoutIssues("蟒妻四视图");
    assert.deepEqual(issues, ["正面脸及肩部", "右侧脸及肩部", "无头正面全身", "完整背面全身", "2×2 网格", "顶行占 1/3 高度", "空手不带武器"]);
});

test("按技能模块写全四格＋2×2 三分＋空手就合格", () => {
    const zh = "四视图，2×2 网格等宽双列，顶行占三分之一高度：正面脸及肩部、右侧脸及肩部；底行占三分之二：无头正面全身、完整背面全身；双手空手自然下垂";
    assert.deepEqual(turnaroundLayoutIssues(zh), []);
    const en = "turnaround sheet, two by two grid, top row one third: front face, right profile; bottom row: headless frontal costume, back full-body; hands empty";
    assert.deepEqual(turnaroundLayoutIssues(en), []);
});

test("四视图必须横版，竖版与方图都要报出来", () => {
    assert.equal(turnaroundAspectIssue(1824, 1024), undefined);
    assert.equal(turnaroundAspectIssue(1536, 1024), undefined);
    assert.match(String(turnaroundAspectIssue(1024, 1536)), /横版/);
    assert.match(String(turnaroundAspectIssue(1024, 1024)), /横版/);
    assert.equal(turnaroundAspectIssue(undefined, undefined), undefined);
});

test("补排版段是幂等的：已经合格就不再追加", () => {
    const fixed = applyTurnaroundLayout("蟒妻四视图，只有正面脸和背面全身");
    assert.deepEqual(turnaroundLayoutIssues(fixed), []);
    assert.equal(applyTurnaroundLayout(fixed), fixed);
});
