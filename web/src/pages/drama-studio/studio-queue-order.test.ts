import assert from "node:assert/strict";
import test from "node:test";
import { orderStudioQueue, studioQueueRank } from "./studio-queue-order.js";

type Row = { id: string; status: string; error?: string; createdAt?: string; startedAt?: string; finishedAt?: string };

test("队列按状态分桶：运行中、排队、失败、完成历史", () => {
    const rows: Row[] = [
        { id: "done", status: "succeeded", finishedAt: "2026-01-01T00:00:00.000Z" },
        { id: "failed", status: "failed", error: "生成失败", finishedAt: "2026-01-01T00:00:00.000Z" },
        { id: "queued", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "running", status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
    ];
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["running", "queued", "failed", "done"]);
});

test("同一状态内按真实时间排，不再按流水线/日志的数据源拼接顺序", () => {
    // 复现截图里的乱序：日志源是 created_at DESC（新→旧），流水线源是 created_at ASC。
    // 旧实现按到达顺序拼在一起，11:26 的作业反而排在 19:28 的后面。
    const rows: Row[] = [
        { id: "log-new", status: "running", startedAt: "2026-01-01T19:28:00.000Z" },
        { id: "pipeline-old", status: "running", startedAt: "2026-01-01T11:26:00.000Z" },
        { id: "log-mid", status: "running", startedAt: "2026-01-01T12:19:00.000Z" },
    ];
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["pipeline-old", "log-mid", "log-new"]);
});

test("排队桶按加入时间升序，和后端 claim 的 created_at ASC 一致", () => {
    const rows: Row[] = [
        { id: "later", status: "queued", createdAt: "2026-01-01T10:05:00.000Z" },
        { id: "earlier", status: "queued", createdAt: "2026-01-01T10:01:00.000Z" },
    ];
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["earlier", "later"]);
});

test("终态桶按最近时间优先，没有时间的行排到桶尾", () => {
    const rows: Row[] = [
        { id: "old", status: "succeeded", finishedAt: "2026-01-01T01:00:00.000Z" },
        { id: "unknown", status: "succeeded" },
        { id: "new", status: "succeeded", finishedAt: "2026-01-01T05:00:00.000Z" },
    ];
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["new", "old", "unknown"]);
});

test("失败桶同时接纳失败状态和带 error 的行，时间倒序", () => {
    const rows: Row[] = [
        { id: "error-row", status: "succeeded", error: "后处理失败", finishedAt: "2026-01-01T06:00:00.000Z" },
        { id: "old-failed", status: "failed", finishedAt: "2026-01-01T02:00:00.000Z" },
    ];
    assert.equal(studioQueueRank(rows[0]), 2);
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["error-row", "old-failed"]);
});

test("时间相同保持数据源原顺序，排序结果稳定", () => {
    const rows: Row[] = [
        { id: "a", status: "running", startedAt: "2026-01-01T09:00:00.000Z" },
        { id: "b", status: "running", startedAt: "2026-01-01T09:00:00.000Z" },
        { id: "c", status: "running", startedAt: "2026-01-01T09:00:00.000Z" },
    ];
    assert.deepEqual(orderStudioQueue(rows).map((row) => row.id), ["a", "b", "c"]);
});
