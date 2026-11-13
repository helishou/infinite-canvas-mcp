import assert from "node:assert/strict";
import test from "node:test";

import { readinessCounts, stageStates } from "./production-progress";

test("阶段游标缺失时返回空：界面显示未初始化，不假装从第一步开始", () => {
    assert.deepEqual(stageStates(null), []);
    assert.deepEqual(stageStates(undefined), []);
    assert.deepEqual(stageStates({}), []);
    assert.deepEqual(stageStates({ current: "" }), []);
});

test("当前阶段高亮，已完成打勾，其余待办", () => {
    const states = stageStates({ current: "shots", done: ["script", "assets", "spatial"] });
    assert.deepEqual(states.map(item => item.key), ["script", "assets", "spatial", "shots", "keyframes", "clips"]);
    assert.deepEqual(states.map(item => item.state), ["done", "done", "done", "current", "pending", "pending"]);
});

test("done 里重复登记当前阶段时仍按当前阶段显示", () => {
    const states = stageStates({ current: "keyframes", done: ["script", "assets", "shots", "keyframes"] });
    assert.equal(states.find(item => item.key === "keyframes")?.state, "current");
    assert.equal(states.filter(item => item.state === "current").length, 1);
});

test("越序停在最后阶段时前面未做的仍是待办", () => {
    const states = stageStates({ current: "clips", done: ["script", "clips"], note: "跳过资产：复用旧图" });
    assert.deepEqual(states.map(item => item.state), ["done", "pending", "pending", "pending", "pending", "current"]);
});

test("就绪计数把 ready/complete 算可用，needs_review 与 blocked 分开", () => {
    const counts = readinessCounts([
        { status: "ready" }, { status: "complete" }, { status: "needs_review" }, { status: "blocked" }, { status: "draft" },
    ]);
    assert.deepEqual(counts, { ready: 2, blocked: 2, review: 1, total: 5 });
});

test("没有目标时不虚报计数", () => {
    assert.deepEqual(readinessCounts(null), { ready: 0, blocked: 0, review: 0, total: 0 });
    assert.deepEqual(readinessCounts([]), { ready: 0, blocked: 0, review: 0, total: 0 });
});
