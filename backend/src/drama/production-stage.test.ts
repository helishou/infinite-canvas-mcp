import assert from "node:assert/strict";
import test from "node:test";

import { productionStageGaps } from "./production.js";

const stage = (current: string, done: string[] = [], note?: string) => ({ current, done, ...(note ? { note } : {}) });

test("阶段游标缺失时放行：老项目不因未初始化被拦", () => {
    assert.deepEqual(productionStageGaps(undefined, "segment"), { blockers: [], warnings: [] });
    assert.deepEqual(productionStageGaps({}, "segment"), { blockers: [], warnings: [] });
    assert.deepEqual(productionStageGaps({ current: "" }, "segment"), { blockers: [], warnings: [] });
});

test("Clip 目标缺前置阶段时硬拦，并指明当前阶段与缺失项", () => {
    const gaps = productionStageGaps(stage("shots", ["script", "assets"]), "segment");
    assert.equal(gaps.blockers.length, 1);
    assert.equal(gaps.warnings.length, 0);
    assert.match(gaps.blockers[0], /当前在 ④镜头设计/);
    assert.match(gaps.blockers[0], /⑤分镜关键帧/);
});

test("资产图与关键帧只提示不拦，避免把可跳步骤变成关卡", () => {
    const asset = productionStageGaps(stage("assets", []), "asset");
    assert.deepEqual(asset.blockers, []);
    assert.equal(asset.warnings.length, 1);
    const keyframe = productionStageGaps(stage("assets", ["script"]), "keyframe");
    assert.deepEqual(keyframe.blockers, []);
    assert.equal(keyframe.warnings.length, 1);
});

test("前置齐了不再拦：按序推进后 Clip 可生成", () => {
    assert.deepEqual(productionStageGaps(stage("clips", ["script", "assets", "spatial", "shots", "keyframes"]), "segment"), { blockers: [], warnings: [] });
});

test("当前阶段本身不计入缺失项：正在做的阶段不要求先完成", () => {
    // 当前就在 shots：前置 script/assets 已 done，缺 keyframes 仍属越序，需拦。
    // 但当前阶段若正是被要求的前置项，则不重复要求它自己。
    const gaps = productionStageGaps(stage("keyframes", ["script", "assets", "shots"]), "keyframe");
    assert.deepEqual(gaps.warnings, []);
    assert.deepEqual(gaps.blockers, []);
});
