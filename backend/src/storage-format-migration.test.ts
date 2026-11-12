import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { compressStoredJsonText, storedJsonText } from "./json-storage.js";
import { migrateStorageFormat, readMigrationJsonText } from "./storage-format-migration.js";

const SCHEMA = `
CREATE TABLE episode_production_operations(operation_id TEXT PRIMARY KEY,receipt_json);
CREATE TABLE canvas_production_operations(operation_id TEXT PRIMARY KEY,receipt_json);
CREATE TABLE production_preparations(operation_id TEXT PRIMARY KEY,receipt_json);
CREATE TABLE tasks(id TEXT PRIMARY KEY,input_json,params_json);
CREATE TABLE canvas_operation_batches(operation_id TEXT PRIMARY KEY,operations_json,results_json);
CREATE TABLE generation_logs(id TEXT PRIMARY KEY,params_json);`;
function fixture(t: test.TestContext) {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    t.after(() => { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); });
    return db;
}
function set(db: DatabaseSync, table: string, key: string, col: string, value: unknown) {
	db.prepare(`INSERT INTO "${table}"("${key}","${col}") VALUES(?,?) ON CONFLICT("${key}") DO UPDATE SET "${col}"=excluded."${col}"`).run("row", value);
}
function get(db: DatabaseSync, table: string, key: string, col: string) {
    return db.prepare(`SELECT "${col}" AS value,typeof("${col}") AS kind FROM "${table}" WHERE "${key}"='row'`).get() as { value: string | Uint8Array; kind: string };
}
const longJson = (word = "x") => `{ "padding" : "${word.repeat(5000)}", "n" : 1.00 }`;

test("schema 52 conversion normalizes gzip, keeps small text and Brotli, and forces receipt Brotli", t => {
    const db = fixture(t), raw = longJson();
    set(db, "episode_production_operations", "operation_id", "receipt_json", raw);
    set(db, "canvas_production_operations", "operation_id", "receipt_json", "{\"ok\":true}");
    set(db, "production_preparations", "operation_id", "receipt_json", "{\"ok\":true}");
    set(db, "tasks", "id", "input_json", gzipSync(Buffer.from(raw)));
    set(db, "tasks", "id", "params_json", compressStoredJsonText(raw));
    set(db, "canvas_operation_batches", "operation_id", "operations_json", gzipSync(Buffer.from("{\"small\":true}")));
    set(db, "canvas_operation_batches", "operation_id", "results_json", "{\"small\":true}");
    set(db, "generation_logs", "id", "params_json", raw);
    const beforeBrotli = Buffer.from(get(db, "tasks", "id", "params_json").value as Uint8Array);
    db.exec("BEGIN");
    const result = migrateStorageFormat(db);
    assert.ok(result.updated >= 6);
    assert.ok(result.beforeBytes > 0 && result.afterBytes > 0);
    assert.equal(get(db, "canvas_operation_batches", "operation_id", "operations_json").kind, "text");
    for (const [table, key, col, expected] of [
        ["episode_production_operations", "operation_id", "receipt_json", raw],
        ["canvas_production_operations", "operation_id", "receipt_json", "{\"ok\":true}"],
        ["production_preparations", "operation_id", "receipt_json", "{\"ok\":true}"],
        ["tasks", "id", "input_json", raw], ["tasks", "id", "params_json", raw],
        ["canvas_operation_batches", "operation_id", "operations_json", "{\"small\":true}"],
        ["canvas_operation_batches", "operation_id", "results_json", "{\"small\":true}"],
        ["generation_logs", "id", "params_json", raw],
    ] as const) assert.equal(storedJsonText(get(db, table, key, col).value), expected);
    for (const [table, key, col] of [["episode_production_operations", "operation_id", "receipt_json"], ["canvas_production_operations", "operation_id", "receipt_json"], ["production_preparations", "operation_id", "receipt_json"]] as const) {
        assert.equal(get(db, table, key, col).kind, "blob");
        assert.equal(Buffer.from(get(db, table, key, col).value as Uint8Array).subarray(0, 5).toString(), "ICBR1");
    }
    assert.deepEqual(Buffer.from(get(db, "tasks", "id", "params_json").value as Uint8Array), beforeBrotli);
    db.exec("COMMIT");
});

test("invalid gzip, invalid UTF-8 and unknown blobs reject without exposing payload", t => {
    for (const bad of [Buffer.from([0x1f, 0x8b, 1, 2]), gzipSync(Buffer.from([0xff, 0xfe])), Buffer.from("private-secret-payload")]) {
        const db = fixture(t);
        set(db, "episode_production_operations", "operation_id", "receipt_json", longJson());
        set(db, "tasks", "id", "input_json", bad);
        db.exec("BEGIN");
        assert.throws(() => migrateStorageFormat(db), error => {
            assert.ok(error instanceof Error);
            assert.equal(error.message.includes("private-secret-payload"), false);
            return true;
        });
        db.exec("ROLLBACK");
    }
});

test("offline migration reader strictly validates JSON and supports all legacy formats", () => {
    const source = longJson();
    assert.equal(readMigrationJsonText(source), source);
    assert.equal(readMigrationJsonText(gzipSync(Buffer.from(source))), source);
    assert.equal(readMigrationJsonText(compressStoredJsonText(source)), source);
    assert.throws(() => readMigrationJsonText("not-json"), /invalid JSON/);
});

test("caller rollback restores earlier rows after injected write failure", t => {
    const db = fixture(t), raw = longJson();
    set(db, "episode_production_operations", "operation_id", "receipt_json", raw);
    set(db, "tasks", "id", "input_json", gzipSync(Buffer.from(raw)));
    db.exec("CREATE TRIGGER reject_migration BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'injected'); END; BEGIN");
    assert.throws(() => migrateStorageFormat(db), /injected/);
    assert.equal(db.isTransaction, true);
    db.exec("ROLLBACK");
    assert.equal(get(db, "episode_production_operations", "operation_id", "receipt_json").value, raw);
    assert.equal(get(db, "tasks", "id", "input_json").kind, "blob");
});

test("repeat run leaves current values byte-identical", t => {
    const db = fixture(t);
    set(db, "episode_production_operations", "operation_id", "receipt_json", "{\"small\":true}");
    db.exec("BEGIN"); migrateStorageFormat(db); db.exec("COMMIT");
    const original = Buffer.from(get(db, "episode_production_operations", "operation_id", "receipt_json").value as Uint8Array);
    db.exec("BEGIN"); const repeated = migrateStorageFormat(db); db.exec("COMMIT");
    assert.equal(repeated.updated, 0);
    assert.deepEqual(Buffer.from(get(db, "episode_production_operations", "operation_id", "receipt_json").value as Uint8Array), original);
});
