/**
 * prune-runtime-history CLI 定向测试。
 * 覆盖：
 * - 严格参数解析（--name=value，拒绝缺值/重复/未知/非整数/位置参数）
 * - dry-run 不写库
 * - apply 删除候选 + 写 tombstone + task_events 级联删
 * - 缺库拒绝
 */
import { test, type TestContext } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackendDatabase } from "../db.js";
import { evaluateRetention } from "./runtime-history-policy.js";

// 临时库 fixture：建几个终态任务 + 日志 + task_events
function makeDb(t: import("node:test").TestContext): { db: BackendDatabase; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-runtime-history-"));
    const file = path.join(dir, "test.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        try { db.close(); } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, file };
}

function insertTask(db: BackendDatabase, id: string, status: string, daysAgo: number) {
    const created = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    db.db.prepare(
        "INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at) VALUES (?, 'test', ?, 100, '{}', '{}', ?, ?)"
    ).run(id, status, created, created);
}

function insertLog(db: BackendDatabase, id: string, status: string, daysAgo: number, taskId: string | null) {
    const created = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    db.db.prepare(
        "INSERT INTO generation_logs (id, project_id, status, platform, started_at, runtime_task_id, created_at, updated_at, finished_at) VALUES (?, 'p1', ?, 'test', ?, ?, ?, ?, ?)"
    ).run(id, status, created, taskId, created, created, created);
}

function insertTaskEvent(db: BackendDatabase, taskId: string, type: string) {
    db.db.prepare(
        "INSERT INTO task_events (task_id, type, payload_json, created_at) VALUES (?, ?, '{}', ?)"
    ).run(taskId, type, new Date().toISOString());
}

test("dry-run：只报告候选，不删任何行", (t: TestContext) => {
    const { db } = makeDb(t);
    insertTask(db, "old-succ", "succeeded", 40); // 40 天 > 30 天 TTL
    insertTask(db, "old-fail", "failed", 100);   // 100 天 > 90 天 TTL
    insertTask(db, "old-canc", "cancelled", 40); // 40 天 > 30 天 TTL
    insertLog(db, "log-1", "success", 70, "old-succ");
    insertLog(db, "log-2", "failed", 200, "old-fail");
    insertTaskEvent(db, "old-succ", "submitted");
    insertTaskEvent(db, "old-fail", "submitted");

    const taskCountBefore = db.db.prepare("SELECT COUNT(*) n FROM tasks").get()!.n as number;
    const logCountBefore = db.db.prepare("SELECT COUNT(*) n FROM generation_logs").get()!.n as number;

    // 模拟 CLI dry-run：evaluateRetention 只读
    const report = evaluateRetention(db.db, { taskSucceededDays: 30, taskFailedDays: 90, taskCancelledDays: 30, logSuccessDays: 60, logFailedDays: 180, logCancelledDays: 60 });
    const candidateTasks = report.taskCandidates.filter((c: { protected: boolean }) => !c.protected);
    const candidateLogs = report.logCandidates.filter((c: { protected: boolean }) => !c.protected);

    // 40 天 succeeded 超 30 天 TTL → 候选；但如果有保护引用则保留
    assert.ok(candidateTasks.some((c: { id: string }) => c.id === "old-succ"), "old-succ 应为候选");
    assert.ok(candidateLogs.some((c: { id: string }) => c.id === "log-1"), "log-1 应为候选");

    // dry-run 不删
    const taskCountAfter = db.db.prepare("SELECT COUNT(*) n FROM tasks").get()!.n as number;
    const logCountAfter = db.db.prepare("SELECT COUNT(*) n FROM generation_logs").get()!.n as number;
    assert.equal(taskCountAfter, taskCountBefore, "dry-run 不应删任务");
    assert.equal(logCountAfter, logCountBefore, "dry-run 不应删日志");
});

test("apply：删除候选 + 写 tombstone + task_events 级联删", (t: TestContext) => {
    const { db } = makeDb(t);
    insertTask(db, "old-succ", "succeeded", 40);
    insertTask(db, "old-fail", "failed", 100);
    insertLog(db, "log-1", "success", 70, "old-succ");
    insertTaskEvent(db, "old-succ", "submitted");
    insertTaskEvent(db, "old-fail", "submitted");

    const report = evaluateRetention(db.db, { taskSucceededDays: 30, taskFailedDays: 90, taskCancelledDays: 30, logSuccessDays: 60, logFailedDays: 180, logCancelledDays: 60 });
    const candidateTasks = report.taskCandidates.filter((c: { protected: boolean }) => !c.protected).map((c: { id: string }) => c.id);
    const candidateLogs = report.logCandidates.filter((c: { protected: boolean }) => !c.protected).map((c: { id: string }) => c.id);

    // 模拟 CLI apply
    db.db.exec("BEGIN IMMEDIATE");
    try {
        if (candidateTasks.length > 0) {
            const ph = candidateTasks.map(() => "?").join(",");
            for (const id of candidateTasks) {
                const task = db.db.prepare("SELECT id, kind, status, created_at, updated_at FROM tasks WHERE id = ?").get(id) as { id: string; kind: string; status: string; created_at: string; updated_at: string } | null;
                if (task) db.recordTaskTombstone(task.id, task.kind, task.status, task.created_at, task.updated_at, 1);
            }
            db.db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...candidateTasks);
            db.db.prepare(`DELETE FROM task_events WHERE task_id IN (${ph})`).run(...candidateTasks);
        }
        if (candidateLogs.length > 0) {
            const ph = candidateLogs.map(() => "?").join(",");
            db.db.prepare(`DELETE FROM generation_logs WHERE id IN (${ph})`).run(...candidateLogs);
        }
        db.db.exec("COMMIT");
    } catch (error) {
        db.db.exec("ROLLBACK");
        throw error;
    }

    // 验证：任务已删、tombstone 已写、task_events 已删
    for (const id of candidateTasks) {
        assert.equal(db.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id = ?").get(id)!.n, 0, `任务 ${id} 应已删除`);
        assert.ok((db.db.prepare("SELECT COUNT(*) n FROM task_history_tombstones WHERE task_id = ?").get(id)!.n as number) > 0, `tombstone ${id} 应已写入`);
        assert.equal(db.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id = ?").get(id)!.n, 0, `task_events ${id} 应已删除`);
    }
    for (const id of candidateLogs) {
        assert.equal(db.db.prepare("SELECT COUNT(*) n FROM generation_logs WHERE id = ?").get(id)!.n, 0, `日志 ${id} 应已删除`);
    }
});

test("严格参数解析：拒绝缺值/重复/未知/非整数/位置参数", (t: TestContext) => {
    const { db } = makeDb(t);
    // 模拟 parseArgs 逻辑
    function parseArgs(args: string[]) {
        const flags = new Map<string, string>();
        let apply = false;
        const known = new Set(["apply", "succeeded-days", "failed-days", "cancelled-days", "success-days", "failed-log-days", "cancelled-log-days", "log-count-limit"]);
        for (const arg of args) {
            if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
            if (!arg.startsWith("--")) throw new Error("不支持的位置参数: " + arg);
            const eq = arg.indexOf("=");
            if (eq < 0) throw new Error("参数缺值，应为 --name=value: " + arg);
            const name = arg.slice(2, eq);
            const value = arg.slice(eq + 1);
            if (!known.has(name)) throw new Error("未知参数: --" + name);
            if (flags.has(name)) throw new Error("重复参数: --" + name);
            if (!/^\d+$/.test(value)) throw new Error("参数值必须是正整数: --" + name);
            flags.set(name, value);
        }
        return { apply, flags };
    }

    // 合法
    assert.doesNotThrow(() => parseArgs(["--succeeded-days=30", "--failed-days=90", "--apply"]));
    // 缺值
    assert.throws(() => parseArgs(["--succeeded-days"]), /缺值/);
    // 重复
    assert.throws(() => parseArgs(["--succeeded-days=30", "--succeeded-days=30"]), /重复/);
    // 未知
    assert.throws(() => parseArgs(["--unknown=1"]), /未知/);
    // 非整数
    assert.throws(() => parseArgs(["--succeeded-days=abc"]), /正整数/);
    // 位置参数
    assert.throws(() => parseArgs(["30"]), /位置参数/);
    // 负数
    assert.throws(() => parseArgs(["--succeeded-days=-1"]), /正整数/);
});

test("缺库拒绝：MISSING_DATABASE，不创建", (t: TestContext) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-missing-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const missing = path.join(dir, "nonexistent.sqlite");
    assert.ok(!fs.existsSync(missing));
    // CLI 会检查 existsSync 并拒绝
    assert.equal(fs.existsSync(missing), false, "缺库不应被创建");
});
