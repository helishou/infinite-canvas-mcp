import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { storedJsonText } from "../json-storage.js";
import { compressSnapshotJson, inspectSnapshotCompression } from "./compress-snapshot-json.js";

function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(${DATABASE_SCHEMA_VERSION});
        CREATE TABLE tasks(id TEXT PRIMARY KEY,input_json TEXT);
        CREATE TABLE canvas_operation_batches(operation_id TEXT PRIMARY KEY,operations_json TEXT,results_json TEXT);`);
    const original = '{ "prompt" : "' + "原始内容😀".repeat(2000) + '", "n": 1.0 }';
    db.prepare("INSERT INTO tasks VALUES('task',?)").run(original);
    db.prepare("INSERT INTO canvas_operation_batches VALUES('op',?,?)").run(original, '[ 1, 2, 3 ]');
    return { db, original };
}

test("conversion preserves exact JSON bytes, identities and rows; rerunning is idempotent", () => {
    const current = fixture(), backup = fixture();
    try {
        const plans = inspectSnapshotCompression(current.db);
        assert.equal(plans.reduce((sum, p) => sum + p.keys.length, 0), 2);
        const results = compressSnapshotJson(current.db, backup.db);
        assert.equal(results.reduce((sum, r) => sum + r.converted, 0), 2);
        assert.ok(results.reduce((sum, r) => sum + r.savedBytes, 0) > 1000);
        const input = current.db.prepare("SELECT input_json FROM tasks WHERE id='task'").get()!.input_json;
        assert.ok(input instanceof Uint8Array);
        assert.equal(storedJsonText(input), current.original);
        assert.equal(storedJsonText(current.db.prepare("SELECT operations_json FROM canvas_operation_batches WHERE operation_id='op'").get()!.operations_json), current.original);
        assert.equal(backup.db.prepare("SELECT input_json FROM tasks WHERE id='task'").get()!.input_json, current.original);
        assert.equal(compressSnapshotJson(current.db, backup.db).reduce((sum, r) => sum + r.converted, 0), 0);
    } finally { current.db.close(); backup.db.close(); }
});

test("a stale backup or damaged JSON rejects before any writes", () => {
    const current = fixture(), backup = fixture();
    try {
        backup.db.exec("DELETE FROM canvas_operation_batches");
        assert.throws(() => compressSnapshotJson(current.db, backup.db), /Backup does not contain/);
        assert.equal(current.db.prepare("SELECT typeof(input_json) AS type FROM tasks").get()!.type, "text");
        current.db.exec("UPDATE canvas_operation_batches SET operations_json='corrupt'");
        assert.throws(() => compressSnapshotJson(current.db, backup.db));
        assert.equal(current.db.prepare("SELECT typeof(input_json) AS type FROM tasks").get()!.type, "text");
    } finally { current.db.close(); backup.db.close(); }
});

test("write failure rolls the current batch back", t => {
    const current = fixture(), backup = fixture();
    try {
        for (const db of [current.db, backup.db]) db.prepare("INSERT INTO tasks VALUES('task2',?)").run(current.original);
        current.db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON tasks WHEN OLD.id='task2' BEGIN SELECT RAISE(ABORT,'test failure'); END");
        assert.throws(() => compressSnapshotJson(current.db, backup.db), /test failure/);
        assert.equal(current.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE typeof(input_json)='text'").get()!.n, 2);
    } finally { current.db.close(); backup.db.close(); }
});
