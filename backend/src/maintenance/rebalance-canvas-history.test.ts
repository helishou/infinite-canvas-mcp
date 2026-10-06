import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { DatabaseSync } from "node:sqlite";
import { reconstructCanvasHistory } from "../canvas/history-maintenance.js";
import { applyCanvasProjectOperations } from "../canvas/project-ops.js";
import {
    buildRebalancePlan,
    applyRebalancePlan,
    computeRebalanceFingerprint,
    diagnoseBlockedProject,
    REBALANCE_ELIGIBLE_CODES,
} from "./rebalance-canvas-history.js";

type Fixture = { db: BackendDatabase; raw: DatabaseSync; file: string };

function makeDb(t: TestContext): Fixture {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-rebal-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { db, raw: db.db, file };
}

/** 建一个带健康历史的画布项目：checkpoint rev 0 + 1 个 batch (rev 1)。
 *  用真实 applyCanvasProjectOperations 计算 current 状态，保证回放必然匹配。 */
function makeHealthyProject(raw: DatabaseSync, projectId: string, nodes: Array<Record<string, unknown>>) {
    const base = { id: projectId, revision: 0, nodes: [], connections: [] };
    raw.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)")
        .run(projectId, JSON.stringify(base), "2025-01-01T00:00:00.000Z");
    raw.prepare("INSERT INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, 0, ?)")
        .run(projectId, JSON.stringify(base));
    // 真实 add_node 操作：从空画布重放得到 current
    const replay = JSON.parse(JSON.stringify(base));
    const operations = nodes.map((node, i) => ({
        type: "add_node",
        id: node.id,
        nodeType: node.type,
        title: node.title ?? "",
        position: node.position ?? { x: i * 40, y: 0 },
        width: 320,
        height: 240,
        metadata: node.metadata ?? {},
    }));
    applyCanvasProjectOperations(replay, operations as never, { committedReplay: true });
    replay.revision = 1;
    replay.updatedAt = "2025-01-02T00:00:00.000Z";
    raw.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(JSON.stringify(replay), projectId);
    raw.prepare(
        "INSERT INTO canvas_operation_batches (operation_id, project_id, base_revision, revision, source_json, operations_json, results_json, created_at) VALUES (?, ?, 0, 1, '{}', ?, '{}', ?)"
    ).run(`op-${projectId}-1`, projectId, JSON.stringify(operations), "2025-01-02T00:00:00.000Z");
    raw.prepare("INSERT INTO canvas_command_receipts (operation_id, project_id, request_hash, committed_revision) VALUES (?, ?, ?, 1)")
        .run(`op-${projectId}-1`, projectId, "hash-1");
}

/** 同 revision 篡改 data_json（加 ghost 节点）→ 回放不匹配。 */
function corruptProject(raw: DatabaseSync, projectId: string, ghostId = "ghost-node") {
    const row = raw.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId) as { data_json: string };
    const data = JSON.parse(row.data_json);
    data.nodes.push({ id: ghostId, type: "video", metadata: {} });
    raw.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(JSON.stringify(data), projectId);
}

test("健康项目：diagnose 未 blocked，buildRebalancePlan 拒绝", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    const diag = diagnoseBlockedProject(raw, "p1");
    assert.ok(!diag.blockedReason, "健康项目不应 blocked");
    assert.throws(() => buildRebalancePlan(raw, "p1"), /不需要 re-baseline/);
});

test("回放不匹配：诊断码 HISTORY_REPLAY_MISMATCH，准入", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    corruptProject(raw, "p1");
    const diag = diagnoseBlockedProject(raw, "p1");
    assert.equal(diag.reasonCode, "HISTORY_REPLAY_MISMATCH");
    assert.ok(diag.eligible, "回放不匹配应准入 re-baseline");
    assert.ok(REBALANCE_ELIGIBLE_CODES.has(diag.reasonCode));
});

test("缺 checkpoint：诊断码 MISSING_CHECKPOINT，准入", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    raw.prepare("DELETE FROM canvas_collaboration_checkpoints WHERE project_id = 'p1'").run();
    const diag = diagnoseBlockedProject(raw, "p1");
    assert.equal(diag.reasonCode, "MISSING_CHECKPOINT");
    assert.ok(diag.eligible);
});

test("未来 revision batch：buildRebalancePlan 拒绝", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    raw.prepare(
        "INSERT INTO canvas_operation_batches (operation_id, project_id, base_revision, revision, source_json, operations_json, results_json, created_at) VALUES ('op-future', 'p1', 1, 99, '{}', '[]', '{}', ?)"
    ).run("2025-01-03T00:00:00.000Z");
    raw.prepare("INSERT INTO canvas_command_receipts (operation_id, project_id, request_hash, committed_revision) VALUES ('op-future', 'p1', 'hash-f', 99)").run();
    assert.throws(() => buildRebalancePlan(raw, "p1"), /未来 revision|batch boundary|re-baseline/);
});

test("缺命令身份凭据：buildRebalancePlan 拒绝", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    corruptProject(raw, "p1");
    raw.prepare("DELETE FROM canvas_command_receipts WHERE operation_id = 'op-p1-1'").run();
    assert.throws(() => buildRebalancePlan(raw, "p1"), /命令身份|request_hash/);
});

test("完整内容指纹：同 revision 内容变化 → 指纹不同", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    const fp1 = computeRebalanceFingerprint(raw, "p1");
    corruptProject(raw, "p1");
    const fp2 = computeRebalanceFingerprint(raw, "p1");
    assert.notEqual(fp1.fingerprint, fp2.fingerprint, "同 revision 内容变化必须改变指纹");
    assert.equal(fp1.fingerprint.length, 64);
});

test("apply：回放不匹配项目 re-baseline 成功；旧 revision 不可恢复；命令身份保留", (t: TestContext) => {
    const { raw, file } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    corruptProject(raw, "p1");
    const plan = buildRebalancePlan(raw, "p1");
    assert.equal(plan.reasonCode, "HISTORY_REPLAY_MISMATCH");
    assert.ok(plan.lossNotes.some(n => n.includes("RECEIPT_UNAVAILABLE")));

    const result = applyRebalancePlan(raw, file, plan);
    assert.equal(result.batchesDeleted, 1);
    assert.equal(result.checkpointRevision, 1);
    assert.ok(fs.existsSync(result.backupFile));

    const project = raw.prepare("SELECT data_json FROM canvas_projects WHERE id = 'p1'").get() as { data_json: string };
    const data = JSON.parse(project.data_json);
    assert.equal(data.revision, 1);

    assert.throws(() => reconstructCanvasHistory(raw, "p1", 0), /RECEIPT_UNAVAILABLE|没有可恢复/);

    const receipt = raw.prepare("SELECT operation_id, request_hash, committed_revision FROM canvas_command_receipts WHERE project_id = 'p1'").get();
    assert.ok(receipt, "canvas_command_receipts 必须保留");
    assert.equal(receipt.request_hash, "hash-1");

    assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("备份后状态变化：apply 拒绝并回滚", (t: TestContext) => {
    const { raw, file } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    corruptProject(raw, "p1");
    const plan = buildRebalancePlan(raw, "p1");

    corruptProject(raw, "p1", "late-ghost");

    assert.throws(() => applyRebalancePlan(raw, file, plan), /指纹不一致/);

    const batches = raw.prepare("SELECT COUNT(*) AS n FROM canvas_operation_batches WHERE project_id = 'p1'").get() as { n: number };
    assert.equal(batches.n, 1, "拒绝后 batches 必须保留");
});

test("计划含 lossNotes，调用方必须显式确认历史损失", (t: TestContext) => {
    const { raw } = makeDb(t);
    makeHealthyProject(raw, "p1", [{ id: "n1", type: "video", metadata: {} }]);
    corruptProject(raw, "p1");
    const plan = buildRebalancePlan(raw, "p1");
    assert.ok(plan.lossNotes.length >= 1, "计划必须列出损失范围");
    assert.ok(plan.lossNotes.some(n => n.includes("命令身份凭据保留")));
});
