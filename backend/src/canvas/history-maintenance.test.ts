import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { applyCanvasHistoryPrune, migrateCanvasReceipts, previewCanvasHistoryPrune } from "./history-maintenance.js";

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

function legacyDatabase() {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE canvas_projects (id TEXT PRIMARY KEY);
        CREATE TABLE canvas_operation_batches (operation_id TEXT PRIMARY KEY, project_id TEXT REFERENCES canvas_projects(id) ON DELETE CASCADE, revision INTEGER);
        CREATE TABLE canvas_command_receipts (operation_id TEXT PRIMARY KEY REFERENCES canvas_operation_batches(operation_id) ON DELETE CASCADE, request_hash TEXT NOT NULL);
        INSERT INTO canvas_projects VALUES ('p');
        INSERT INTO canvas_operation_batches VALUES ('known', 'p', 1), ('legacy', 'p', 2);
        INSERT INTO canvas_command_receipts VALUES ('known', 'hash');`);
    return db;
}
test("receipt migration reserves legacy IDs and preserves hashes independently of batches", () => {
    const db = legacyDatabase();
    try {
        db.exec("BEGIN"); migrateCanvasReceipts(db); db.exec("COMMIT");
        db.exec("DELETE FROM canvas_operation_batches");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 2);
        assert.equal(db.prepare("SELECT request_hash FROM canvas_command_receipts WHERE operation_id='known'").get()?.request_hash, "hash");
        assert.equal(db.prepare("SELECT request_hash FROM canvas_command_receipts WHERE operation_id='legacy'").get()?.request_hash, "");
        db.exec("DELETE FROM canvas_projects");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 0);
    } finally { db.close(); }
});
test("unowned legacy receipts abort migration and leave the old schema intact", () => {
    const db = legacyDatabase();
    try {
        db.exec("PRAGMA foreign_keys=OFF; INSERT INTO canvas_command_receipts VALUES ('orphan', 'hash'); BEGIN");
        assert.throws(() => migrateCanvasReceipts(db), /unowned/);
        db.exec("ROLLBACK");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 2);
        assert.equal(db.prepare("PRAGMA table_info(canvas_command_receipts)").all().length, 2);
    } finally { db.close(); }
});

test("receipt migration preserves unrelated pre-existing foreign-key violations", () => {
    const db = legacyDatabase();
    try {
        db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY);
            CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id));
            PRAGMA foreign_keys=OFF;
            INSERT INTO task_events VALUES (1, 'missing-task');
            PRAGMA foreign_keys=ON;`);
        const before = db.prepare("PRAGMA foreign_key_check").all();
        assert.equal(before.length, 1);
        db.exec("BEGIN"); migrateCanvasReceipts(db); db.exec("COMMIT");
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), before);
        assert.equal(db.prepare("SELECT task_id FROM task_events WHERE id=1").get()?.task_id, "missing-task");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 2);
    } finally { db.close(); }
});

test("receipt migration rejects newly introduced foreign-key violations without losing the old schema", () => {
    const db = legacyDatabase();
    try {
        db.exec("PRAGMA foreign_keys=OFF; INSERT INTO canvas_operation_batches VALUES ('bad-project', 'missing-project', 3); BEGIN");
        const before = db.prepare("PRAGMA foreign_key_check").all();
        assert.equal(before.length, 1);
        assert.throws(() => migrateCanvasReceipts(db), /introduced a foreign-key violation/);
        db.exec("ROLLBACK");
        db.exec("PRAGMA foreign_keys=ON");
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), before);
        assert.equal(db.prepare("PRAGMA table_info(canvas_command_receipts)").all().length, 2);
    } finally { db.close(); }
});

test("opening a v15 database backs it up and preserves original request receipts through the latest migration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-receipt-upgrade-"));
    const file = path.join(directory, "runtime.sqlite");
    let db: BackendDatabase | undefined;
    try {
        db = new BackendDatabase(file);
        db.createCanvasProject({ id: "p", title: "seed", nodes: [], connections: [], updatedAt: "2026-01-01T00:00:00.000Z" });
        const operations = [{ type: "update_project", patch: { title: "kept" } }];
        const original = db.applyCanvasProjectOperations("p", undefined, operations, { operationId: "preserved" });
        db.db.exec(`BEGIN;
            CREATE TABLE legacy_receipts (operation_id TEXT PRIMARY KEY REFERENCES canvas_operation_batches(operation_id) ON DELETE CASCADE, request_hash TEXT NOT NULL);
            INSERT INTO legacy_receipts SELECT operation_id, request_hash FROM canvas_command_receipts;
            DROP TABLE canvas_command_receipts;
            ALTER TABLE legacy_receipts RENAME TO canvas_command_receipts;
            DROP TABLE canvas_production_runs;
            DROP TABLE canvas_production_versions;
            DROP TABLE canvas_production_operations;
            DROP TABLE canvas_productions;
            DROP TRIGGER IF EXISTS episode_canvas_role_insert;
            DROP TRIGGER IF EXISTS episode_canvas_role_update;
            DELETE FROM schema_migrations WHERE version >= 16;
            COMMIT;`);
        db.close(); db = undefined;
        db = new BackendDatabase(file);
        assert.equal(db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
        assert.deepEqual(db.applyCanvasProjectOperations("p", undefined, operations, { operationId: "preserved" }).project, original.project);
        const backups = fs.readdirSync(directory).filter((name) => name.includes(`pre-schema-v15-to-v${DATABASE_SCHEMA_VERSION}`));
        assert.equal(backups.length, 1);
        const backup = new DatabaseSync(path.join(directory, backups[0]), { readOnly: true });
        try {
            assert.equal(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 15);
            assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM canvas_command_receipts").get()?.n, 1);
        } finally { backup.close(); }
    } finally {
        db?.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
