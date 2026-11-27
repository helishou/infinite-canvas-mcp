import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "./db.js";

function fixture(t: TestContext, logStatus: "running" | "queued" | "success" = "running") {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const task = db.createTask("canvas-image", { projectId: "p", nodeId: "n" }, { model: "m" });
    const log = db.createGenerationLog({
        projectId: "p", nodeId: "n", status: logStatus, platform: "canvas-image", model: "m",
        runtimeTaskId: task.id, startedAt: new Date(Date.now() - 5000).toISOString(), durationMs: 0,
        references: [], inputCounts: {}, outputs: [], params: {},
    });
    return { db, task, log };
}

test("任务失败时关联的运行中日志同步为 failed，带真实错误和耗时", (t) => {
    const { db, task, log } = fixture(t);
    db.updateTask(task.id, { status: "failed", error: "执行引擎不可用：fetch failed" });
    const updated = db.getGenerationLog(log.id)!;
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "执行引擎不可用：fetch failed");
    assert.ok(updated.finishedAt);
    assert.ok(updated.durationMs >= 5000);
});

test("排队中的日志也随任务取消收敛为 cancelled", (t) => {
    const { db, task, log } = fixture(t, "queued");
    db.updateTask(task.id, { status: "cancelled" });
    assert.equal(db.getGenerationLog(log.id)!.status, "cancelled");
});

test("任务成功时日志同步为 success 并带输出", (t) => {
    const { db, task, log } = fixture(t);
    const media = [{ storageKey: "image:done", url: "/media/image%3Adone" }];
    db.updateTask(task.id, { status: "succeeded", result: { media }, outputs: media });
    const updated = db.getGenerationLog(log.id)!;
    assert.equal(updated.status, "success");
    assert.deepEqual(updated.outputs, media);
});

test("已终结日志不被任务终态覆盖，其他任务的日志不受影响", (t) => {
    const { db, task, log } = fixture(t, "success");
    const other = db.createTask("canvas-image", { projectId: "p", nodeId: "n2" }, { model: "m" });
    const otherLog = db.createGenerationLog({
        projectId: "p", nodeId: "n2", status: "running", platform: "canvas-image", model: "m",
        runtimeTaskId: other.id, startedAt: new Date().toISOString(), durationMs: 0,
        references: [], inputCounts: {}, outputs: [], params: {},
    });
    db.updateTask(task.id, { status: "failed", error: "late" });
    assert.equal(db.getGenerationLog(log.id)!.status, "success");
    assert.equal(db.getGenerationLog(otherLog.id)!.status, "running");
});
