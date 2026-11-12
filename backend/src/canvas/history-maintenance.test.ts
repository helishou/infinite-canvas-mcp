import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { applyCanvasHistoryPrune, previewCanvasHistoryPrune } from "./history-maintenance.js";

const cutoff = "2026-09-01T00:00:00.000Z";
function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-history-"));
    const file = path.join(directory, "test.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    db.createCanvasProject({ id: "p", title: "initial", revision: 0, nodes: [], connections: [], updatedAt: "2026-01-01T00:00:00.000Z" });
    const commands = [1, 2, 3].map((i) => [{ type: "update_project", patch: { title: `edit ${i}` } }]);
    const receipts = commands.map((ops, i) => db.applyCanvasProjectOperations("p", undefined, ops, { operationId: `op${i + 1}` }));
    // Only old revisions change date; the latest project timestamp still matches replay.
    db.db.prepare("UPDATE canvas_operation_batches SET created_at = ? WHERE revision <= 2").run("2026-01-02T00:00:00.000Z");
    return { db, file, commands, receipts };
}

test("preview is read-only; pruning advances checkpoint and preserves retained receipts and archived idempotency", (t) => {
    const { db, file, commands, receipts } = fixture(t);
    const before = db.getCanvasProject("p");
    assert.equal(previewCanvasHistoryPrune(db.db, cutoff)[0].batchCount, 2);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM canvas_operation_batches").get()?.n, 3);
    const result = applyCanvasHistoryPrune(db.db, file, cutoff);
    assert.equal(result.removed, 2);
    assert.ok(result.backupFile && fs.existsSync(result.backupFile));
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.deepEqual(db.applyCanvasProjectOperations("p", undefined, commands[2], { operationId: "op3" }).project, receipts[2].project);
    assert.deepEqual(db.getCanvasOperationReceipt("p", "op1"), { committed: true, revision: 1, snapshotAvailable: false });
    let broadcasts = 0;
    db.onCanvasCommit(() => broadcasts++);
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, commands[0], { operationId: "op1" }), (error: any) => error.code === "RECEIPT_UNAVAILABLE" && error.committed === true && error.revision === 1);
    assert.throws(() => db.applyCanvasProjectOperations("p", undefined, commands[2], { operationId: "op1" }), (error: any) => error.code === "OPERATION_ID_REUSED");
    assert.equal(broadcasts, 0);
    assert.deepEqual(db.getCanvasProject("p"), before);
    assert.equal(db.readCanvasChanges("p", 0).reset, true);
    assert.equal(db.readCanvasChanges("p", 2).reset, false);
    assert.equal(applyCanvasHistoryPrune(db.db, file, cutoff).removed, 0);
    db.deleteCanvasProject("p");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 0);
});

test("no expired history, all expired history, and non-monotonic dates use a contiguous prefix", (t) => {
    const { db, file } = fixture(t);
    assert.equal(applyCanvasHistoryPrune(db.db, file, "2000-01-01T00:00:00.000Z").backupFile, null);
    db.db.prepare("UPDATE canvas_operation_batches SET created_at = ? WHERE revision = 1").run("2026-10-01T00:00:00.000Z");
    assert.equal(previewCanvasHistoryPrune(db.db, cutoff)[0].batchCount, 0);
    assert.equal(applyCanvasHistoryPrune(db.db, file, "2100-01-01T00:00:00.000Z").removed, 3);
    assert.equal(previewCanvasHistoryPrune(db.db, cutoff)[0].blockedReason, undefined);
});

test("history gaps and replay errors reject pruning without altering the remaining rows", (t) => {
    const { db, file } = fixture(t);
    db.db.prepare("DELETE FROM canvas_operation_batches WHERE revision = 1").run();
    assert.match(previewCanvasHistoryPrune(db.db, cutoff)[0].blockedReason!, /历史不连续/);
    assert.throws(() => applyCanvasHistoryPrune(db.db, file, cutoff), /validation failed/);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM canvas_operation_batches").get()?.n, 2);
});

test("invalid replay operations are reported in preview and never move the checkpoint", (t) => {
    const { db, file } = fixture(t);
    db.db.prepare("UPDATE canvas_operation_batches SET operations_json = ? WHERE revision = 1").run('[{"type":"update_node","id":"missing","patch":{"title":"invalid"}}]');
    assert.ok(previewCanvasHistoryPrune(db.db, cutoff)[0].blockedReason);
    assert.throws(() => applyCanvasHistoryPrune(db.db, file, cutoff), /validation failed/);
    assert.equal(db.db.prepare("SELECT revision FROM canvas_collaboration_checkpoints").get()?.revision, 0);
});

test("transaction optimization preserves fresh authoritative reads after a reentrant notification", (t) => {
    const { db } = fixture(t);
    const before = Number(db.getCanvasProject("p")!.revision);
    let nested = false;
    db.onCanvasCommit(() => {
        if (nested) return;
        nested = true;
        db.applyCanvasProjectOperations("p", undefined, [{ type: "update_project", patch: { title: "listener edit" } }]);
    });
    const result = db.applyCanvasProjectOperations("p", undefined, [{ type: "update_project", patch: { title: "outer edit" } }]);
    assert.equal(result.revision, before + 1);
    assert.equal(result.project.revision, before + 2);
    assert.equal(result.project.title, "listener edit");
});

test("backup failure and a failure after checkpoint advancement roll back without deleting receipts", (t) => {
    const { db, file } = fixture(t);
    assert.throws(() => applyCanvasHistoryPrune(db.db, path.join(file, "missing"), cutoff));
    assert.equal(db.db.prepare("SELECT revision FROM canvas_collaboration_checkpoints").get()?.revision, 0);
    db.db.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON canvas_operation_batches BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END;");
    assert.throws(() => applyCanvasHistoryPrune(db.db, file, cutoff), /injected deletion failure/);
    assert.equal(db.db.prepare("SELECT revision FROM canvas_collaboration_checkpoints").get()?.revision, 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 3);
});
