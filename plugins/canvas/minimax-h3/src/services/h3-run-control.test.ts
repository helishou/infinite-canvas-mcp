import assert from "node:assert/strict";
import test from "node:test";

import { cancelActiveH3Task, resetAndRunH3Task } from "./h3-run-control";

test("旧 Clip 仍显示 loading 但父任务 failed 时直接重新生成", async () => {
    let cancelled = 0;
    let restarted = 0;
    await resetAndRunH3Task("parent", async () => ({ status: "failed" }), async () => { cancelled += 1; }, async () => { restarted += 1; });
    assert.equal(cancelled, 0);
    assert.equal(restarted, 1);
});

test("活动父任务先取消再重新生成", async () => {
    const calls: string[] = [];
    await resetAndRunH3Task("parent", async () => { calls.push("read"); return { status: "running" }; }, async () => { calls.push("cancel"); }, async () => { calls.push("restart"); });
    assert.deepEqual(calls, ["read", "cancel", "restart"]);
});

test("查询后任务转为 failed 导致取消被拒时仍可重新生成", async () => {
    let reads = 0;
    let restarted = 0;
    await resetAndRunH3Task("parent", async () => ({ status: ++reads === 1 ? "running" : "failed" }), async () => { throw new Error("任务状态 failed 不可取消"); }, async () => { restarted += 1; });
    assert.equal(reads, 2);
    assert.equal(restarted, 1);
});

test("取消失败且任务仍运行时不能提交第二个任务", async () => {
    let restarted = 0;
    await assert.rejects(resetAndRunH3Task("parent", async () => ({ status: "running" }), async () => { throw new Error("取消失败"); }, async () => { restarted += 1; }), /取消失败/);
    assert.equal(restarted, 0);
});

test("待确认任务不能通过重置绕过确认", async () => {
    await assert.rejects(cancelActiveH3Task("parent", async () => ({ status: "awaiting_confirmation" }), async () => {}), /待确认/);
});
