import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";

function makeDb(t: TestContext): { db: BackendDatabase; file: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-tomb-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { db, file };
}

test("v32 迁移：tombstone 表 + 防复用触发器 + 两个索引，幂等", (t: TestContext) => {
    const { db, file } = makeDb(t);
    assert.equal(db.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v, DATABASE_SCHEMA_VERSION);
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_history_tombstones'").get(), "tombstone 表未创建");
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='task_history_tombstone_guard'").get(), "防复用触发器未创建");
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_status_updated'").get());
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='generation_logs_status_updated'").get());
    // 幂等：重开不报错
    const again = new BackendDatabase(file);
    assert.ok(again.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_history_tombstones'").get());
    again.close();
});

test("recordTaskTombstone 幂等；getTaskTombstone 返回凭据", (t: TestContext) => {
    const { db } = makeDb(t);
    db.recordTaskTombstone("t1", "comfyui:minimax-h3", "succeeded", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", 1);
    db.recordTaskTombstone("t1", "comfyui:minimax-h3", "succeeded", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", 1); // 幂等
    const row = db.getTaskTombstone("t1");
    assert.ok(row);
    assert.equal(row!.taskId, "t1");
    assert.equal(row!.terminalStatus, "succeeded");
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM task_history_tombstones").get()!.n, 1, "重复记录不应产生第二行");
    assert.equal(db.getTaskTombstone("nope"), null);
});

test("createTask 拒绝复用已清理 ID：抛 TASK_HISTORY_PRUNED，retryable=false，零副作用", (t: TestContext) => {
    const { db } = makeDb(t);
    db.recordTaskTombstone("pruned-id", "comfyui:minimax-h3", "succeeded", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", 1);
    assert.throws(
        () => db.createTask("pruned-id", "comfyui:minimax-h3", { prompt: "x" }, {}),
        (error: unknown) => {
            const e = error as { code?: string; retryable?: boolean; message?: string };
            assert.equal(e.code, "TASK_HISTORY_PRUNED");
            assert.equal(e.retryable, false);
            assert.match(e.message ?? "", /TASK_HISTORY_PRUNED/);
            return true;
        },
    );
    // 零副作用：没有新任务行、没有占位节点
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='pruned-id'").get()!.n, 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM task_history_tombstones WHERE task_id='pruned-id'").get()!.n, 1);
});

test("createTask 触发器防线：绕过应用检查直接 INSERT 已清理 ID 也被拒绝", (t: TestContext) => {
    const { db } = makeDb(t);
    db.recordTaskTombstone("guard-id", "comfyui:minimax-h3", "failed", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", 1);
    assert.throws(
        () => db.db.prepare(
            "INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at) VALUES (?, 'k', 'queued', 0, '{}', '{}', ?, ?)"
        ).run("guard-id", "2025-01-03T00:00:00.000Z", "2025-01-03T00:00:00.000Z"),
        /tombstone|already pruned/i,
    );
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='guard-id'").get()!.n, 0);
});

test("未清理的 ID 正常创建；已存在活动任务正常复用（不影响原路径）", (t: TestContext) => {
    const { db } = makeDb(t);
    const fresh = db.createTask("fresh-id", "comfyui:minimax-h3", { prompt: "x" }, {});
    assert.equal(fresh.id, "fresh-id");
    // 再次用同 ID → 复用（活动任务），不抛 tombstone
    const again = db.createTask("fresh-id", "comfyui:minimax-h3", { prompt: "x" }, {});
    assert.equal(again.id, "fresh-id");
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='fresh-id'").get()!.n, 1);
});
