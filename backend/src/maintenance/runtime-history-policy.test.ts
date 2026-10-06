import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { evaluateRetention, type HistoryPolicyConfig } from "./runtime-history-policy.js";

const OLD = "2020-01-01T00:00:00.000Z";
const RECENT = "2025-01-01T00:00:00.000Z";
const NOW = "2025-06-01T00:00:00.000Z";

function makeDb(t: TestContext): BackendDatabase {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-policy-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return db;
}

function makeTask(db: BackendDatabase, id: string, status: string, at = OLD, params: Record<string, unknown> = {}) {
    db.db.prepare(
        "INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at) VALUES (?, ?, ?, 0, '{}', ?, ?, ?)"
    ).run(id, "h3", status, JSON.stringify(params), at, at);
}

function makeLog(db: BackendDatabase, id: string, projectId: string, status: string, at = OLD, extra: Partial<Record<string, string | null>> = {}) {
    db.db.prepare(
        "INSERT INTO generation_logs (id, project_id, node_id, segment_id, status, platform, started_at, finished_at, created_at, updated_at, runtime_task_id, params_json) VALUES (?, ?, ?, ?, ?, 'comfyui', ?, ?, ?, ?, ?, ?)"
    ).run(id, projectId, extra.nodeId ?? null, null, status, at, extra.finishedAt ?? null, at, at, extra.runtimeTaskId ?? null, JSON.stringify(extra.params ?? {}));
}

function makeProject(db: BackendDatabase, id: string, nodes: Array<Record<string, unknown>>) {
    db.db.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)")
        .run(id, JSON.stringify({ id, revision: 1, nodes, connections: [] }), NOW);
}

const baseConfig: HistoryPolicyConfig = { now: NOW, taskSucceededDays: 30, taskFailedDays: 90, taskCancelledDays: 30, logSuccessDays: 60, logFailedDays: 180, logCancelledDays: 60 };

function isProtected(report: ReturnType<typeof evaluateRetention>, kind: "task" | "log", id: string): boolean {
    const list = kind === "task" ? report.taskCandidates : report.logCandidates;
    return list.find(e => e.id === id)?.protected ?? true;
}

test("无引用终态任务族 + 超期日志 → 候选；非终态整族保留", (t: TestContext) => {
    const db = makeDb(t);
    // 任务族 A：父+子都终态超期，无引用 → 全候选
    makeTask(db, "t-parent", "succeeded", OLD, {});
    makeTask(db, "t-child", "succeeded", OLD, { parentTaskId: "t-parent" });
    makeLog(db, "l-child", "p1", "success", OLD, { runtimeTaskId: "t-child" });
    // 任务 B：running → 整族保留
    makeTask(db, "t-b", "running", RECENT);
    makeTask(db, "t-b-child", "succeeded", OLD, { parentTaskId: "t-b" });

    const report = evaluateRetention(db.db, baseConfig);
    assert.ok(!isProtected(report, "task", "t-parent"), "无引用超期父任务应为候选");
    assert.ok(!isProtected(report, "task", "t-child"), "无引用超期子任务应为候选");
    assert.ok(!isProtected(report, "log", "l-child"), "无引用超期日志应为候选");
    assert.ok(isProtected(report, "task", "t-b"), "running 任务必须保留");
    assert.ok(isProtected(report, "task", "t-b-child"), "running 父任务的终态子任务必须整族保留");
    assert.equal(report.summary.candidateTasks, 2);
    assert.equal(report.summary.candidateLogs, 1);
});

test("production_task_bindings 任意状态都是保护根", (t: TestContext) => {
    const db = makeDb(t);
    makeTask(db, "t-bound", "succeeded", OLD);
    db.db.prepare("INSERT INTO production_task_bindings (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status) VALUES (?, 'episode', 'ep1', 1, 'h', 'shot', 's1', 'p1', 'n1', '[]', 'submitted')")
        .run("t-bound");
    makeLog(db, "l-bound", "p1", "success", OLD, { runtimeTaskId: "t-bound" });

    const report = evaluateRetention(db.db, baseConfig);
    assert.ok(isProtected(report, "task", "t-bound"), "submitted binding 也是保护根");
    assert.ok(isProtected(report, "log", "l-bound"), "绑定任务的日志整族保留");
    assert.equal(report.summary.candidateTasks, 0);
});

test("canvas 节点 metadata.runtimeTaskId 保留任务；generation_logs.node_id 保留日志", (t: TestContext) => {
    const db = makeDb(t);
    makeTask(db, "t-node", "succeeded", OLD);
    makeProject(db, "p1", [{ id: "n1", type: "video", metadata: { runtimeTaskId: "t-node" } }]);
    // 日志通过 node_id 关联现存节点（无 generationLogId 字段）
    makeLog(db, "l-node", "p1", "success", OLD, { nodeId: "n1" });

    const report = evaluateRetention(db.db, baseConfig);
    assert.ok(isProtected(report, "task", "t-node"), "节点引用的任务必须保留");
    assert.ok(isProtected(report, "log", "l-node"), "现存节点的日志必须保留");
});

test("正式制作 receipt_json 中的任务/日志 ID 保留", (t: TestContext) => {
    const db = makeDb(t);
    makeTask(db, "t-prod", "succeeded", OLD);
    makeLog(db, "l-prod", "p1", "success", OLD);
    db.db.prepare("INSERT INTO canvas_folders (id, name, created_at) VALUES ('f1', 'f', ?)").run(NOW);
    db.db.prepare("INSERT INTO drama_projects (folder_id, updated_at) VALUES ('f1', ?)").run(NOW);
    db.db.prepare("INSERT INTO drama_episodes (id, drama_id, episode_number, created_at, updated_at) VALUES ('ep1', 'f1', 1, ?, ?)").run(NOW, NOW);
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, updated_at) VALUES ('ep1', 1, '{}', ?)").run(NOW);
    db.db.prepare("INSERT INTO episode_production_operations (operation_id, episode_id, request_hash, receipt_json, created_at) VALUES ('op1', 'ep1', 'h', ?, ?)")
        .run(JSON.stringify({ task: "t-prod", log: "l-prod", artifacts: [] }), NOW);

    const report = evaluateRetention(db.db, baseConfig);
    assert.ok(isProtected(report, "task", "t-prod"), "receipt_json 引用的任务必须保留");
    assert.ok(isProtected(report, "log", "l-prod"), "receipt_json 引用的日志必须保留");
});

test("多级父子 + 循环关联：保护正确传播且遍历终止", (t: TestContext) => {
    const db = makeDb(t);
    // 三级链：a → b → c，c 被 binding 保护 → 全链保留
    makeTask(db, "t-a", "succeeded", OLD, { parentTaskId: "t-b" });
    makeTask(db, "t-b", "succeeded", OLD, { parentTaskId: "t-c" });
    makeTask(db, "t-c", "succeeded", OLD, {});
    db.db.prepare("INSERT INTO production_task_bindings (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status) VALUES ('t-c', 'episode', 'ep1', 1, 'h', 'shot', 's1', 'p1', 'n1', '[]', 'bound')").run();
    // 循环：x ↔ y，都无引用 → 全候选（循环不溢出）
    makeTask(db, "t-x", "succeeded", OLD, { parentTaskId: "t-y" });
    makeTask(db, "t-y", "succeeded", OLD, { parentTaskId: "t-x" });

    const report = evaluateRetention(db.db, baseConfig);
    for (const id of ["t-a", "t-b", "t-c"]) assert.ok(isProtected(report, "task", id), `${id} 应整链保留`);
    assert.ok(!isProtected(report, "task", "t-x"), "无引用循环成员应为候选");
    assert.ok(!isProtected(report, "task", "t-y"), "无引用循环成员应为候选");
    assert.equal(report.summary.candidateTasks, 2);
});

test("未知状态、无效时间 → 保留并报告异常", (t: TestContext) => {
    const db = makeDb(t);
    makeTask(db, "t-unknown", "weird-state", OLD);
    db.db.prepare("UPDATE tasks SET updated_at = 'not-a-date' WHERE id = 't-unknown'").run();
    makeTask(db, "t-dangling", "succeeded", OLD, { parentTaskId: "t-nope" });

    const report = evaluateRetention(db.db, baseConfig);
    assert.ok(isProtected(report, "task", "t-unknown"), "未知状态必须保留");
    assert.ok(report.anomalies.some(a => a.type === "integrity-anomaly" && a.taskId === "t-dangling"), "悬空父任务应报告异常");
});

test("500 条数量政策：第 501 条起仅终态无保护才候选；受保护记录允许超限", (t: TestContext) => {
    const db = makeDb(t);
    // 501 条日志，l-1 最旧（500 天前），l-501 最新（NOW）
    // 用 1000 天 TTL 隔离数量政策（所有日志都 TTL 保护，只有 rank>500 的数量候选才可能删）
    for (let i = 1; i <= 501; i++) {
        const at = new Date(Date.parse(NOW) - (501 - i) * 86_400_000).toISOString();
        makeLog(db, `l-${i}`, "p1", "success", at);
    }
    // 最旧的 l-1（rank 501）被现存节点引用 → 保护，不能强删
    db.db.prepare("UPDATE generation_logs SET node_id = 'n1' WHERE id = 'l-1'").run();
    makeProject(db, "p1", [{ id: "n1", type: "video", metadata: {} }]);

    const report = evaluateRetention(db.db, { ...baseConfig, logSuccessDays: 1000, logCountLimit: 500 });
    const l1 = report.logCandidates.find(e => e.id === "l-1")!;
    assert.ok(l1.protected, "第 501 条受保护日志不能强删");
    assert.ok(l1.reasons.includes("referenced-by-canvas-node"));
    // l-2（rank 500）不在数量候选范围（rank ≤ 500），TTL 保护
    const l2 = report.logCandidates.find(e => e.id === "l-2")!;
    assert.ok(l2.protected, "rank ≤ 500 的日志不受数量政策影响");
    // 所有日志都 TTL 保护（1000 天），l-1 被节点保护，无候选
    assert.equal(report.summary.candidateLogs, 0, "所有日志都应保留");
});

test("未提供 TTL 参数的状态不获准清理（无隐式默认删除）", (t: TestContext) => {
    const db = makeDb(t);
    makeTask(db, "t-failed-old", "failed", "2015-01-01T00:00:00.000Z");
    makeTask(db, "t-succeeded-old", "succeeded", "2015-01-01T00:00:00.000Z");

    const report = evaluateRetention(db.db, { now: NOW, taskSucceededDays: 30 });
    assert.ok(isProtected(report, "task", "t-failed-old"), "未提供 taskFailedDays → 不删");
    assert.ok(!isProtected(report, "task", "t-succeeded-old"), "提供 taskSucceededDays → 超期可删");
});

test("schema 低于策略要求时拒绝", (t: TestContext) => {
    const db = makeDb(t);
    db.db.prepare("DELETE FROM schema_migrations WHERE version > 30").run();
    assert.throws(() => evaluateRetention(db.db, baseConfig), /低于策略最低要求/);
});
