import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClipLockPlan, type ClipLockInput } from "./clip-lock-plan.js";

const runtime = (id: string, extra: Record<string, unknown> = {}) => ({ nodeId: `node-${id}`, segmentId: `seg-${id}`, ...extra });
const input = (id: string, extra: Record<string, unknown> = {}, withRuntime = true): ClipLockInput => ({
    source: { id, ...extra },
    ...(withRuntime ? { runtime: runtime(id) } : {}),
});

test("全部锁定：每段一个源稿补丁 + 一次画布固定，跳过已锁定", () => {
    const plan = buildClipLockPlan([input("a"), input("b"), input("c", { locked: true })], true, () => 0.5);
    assert.deepEqual(plan.ids, ["a", "b"]);
    assert.equal(plan.patches.length, 2);
    assert.equal(plan.canvasEdits.length, 2);
    assert.ok(plan.patches.every(item => item.entity === "segment" && item.patch.locked === true && item.patch.preLockNoiseSeedMode === "random"));
    assert.ok(plan.canvasEdits.every(item => item.patch.noiseSeedMode === "fixed"));
    assert.ok(plan.rollbackCanvasEdits.every(item => item.patch.noiseSeedMode === "random"));
});

test("全部解锁：清空 preLockNoiseSeedMode，画布恢复到锁定前模式，回滚方向相反", () => {
    const plan = buildClipLockPlan([
        { ...input("a", { locked: true, preLockNoiseSeedMode: "fixed" }), runtime: runtime("a", { noiseSeedMode: "fixed" }) },
        { ...input("b", { locked: true, preLockNoiseSeedMode: "random" }), runtime: runtime("b", { noiseSeedMode: "fixed" }) },
        { ...input("c", { locked: true }), runtime: runtime("c", { noiseSeedMode: "fixed" }) },
    ], false, () => 0.5);
    assert.deepEqual(plan.ids, ["a", "b", "c"]);
    assert.deepEqual(plan.patches.map(item => item.patch), [
        { locked: false, preLockNoiseSeedMode: null },
        { locked: false, preLockNoiseSeedMode: null },
        { locked: false, preLockNoiseSeedMode: null },
    ]);
    assert.deepEqual(plan.canvasEdits.map(item => item.patch.noiseSeedMode), ["fixed", "random", "fixed"]);
    assert.ok(plan.rollbackCanvasEdits.every(item => item.patch.noiseSeedMode === "fixed"));
});

test("已有 seed 直接复用，缺失时按注入随机数生成合法正整数", () => {
    const plan = buildClipLockPlan([
        { ...input("a"), runtime: runtime("a", { seed: 42, noiseSeed: 7 }) },
        { ...input("b"), runtime: runtime("b", { noiseSeed: 12345 }) },
        { ...input("c"), runtime: runtime("c") },
    ], true, () => 0);
    assert.deepEqual(plan.canvasEdits.map(item => item.patch.seed), [42, 12345, 1]);
    assert.ok(plan.canvasEdits.every(item => Number.isInteger(item.patch.seed) && Number(item.patch.seed) >= 1));
});

test("没有画布节点时只写源稿；空输入与非法 id 不产出 ops", () => {
    const plan = buildClipLockPlan([input("a", {}, false)], true);
    assert.equal(plan.patches.length, 1);
    assert.equal(plan.canvasEdits.length, 0);
    assert.equal(plan.rollbackCanvasEdits.length, 0);
    assert.deepEqual(buildClipLockPlan([], true), { ids: [], patches: [], canvasEdits: [], rollbackCanvasEdits: [] });
    assert.deepEqual(buildClipLockPlan([{ source: { id: "  " } }], true).ids, []);
});

test("混合状态批量只改变与目标态不一致的 Clip", () => {
    const plan = buildClipLockPlan([
        input("a", { locked: true }), input("b"), input("c", { locked: true }), input("d"),
    ], true);
    assert.deepEqual(plan.ids, ["b", "d"]);
    const unlock = buildClipLockPlan([
        input("a", { locked: true }), input("b"), input("c", { locked: true }), input("d"),
    ], false);
    assert.deepEqual(unlock.ids, ["a", "c"]);
});
