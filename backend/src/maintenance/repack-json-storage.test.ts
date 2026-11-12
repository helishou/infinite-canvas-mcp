import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compressStoredJsonText, storedJsonText } from "../json-storage.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { applyJsonRepack, inspectJsonRepack, runJsonRepackCli } from "./repack-json-storage.js";

function fixture(t: test.TestContext, version = DATABASE_SCHEMA_VERSION, includeCanvasOps = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-repack-"));
    const dbPath = path.join(dir, "test.sqlite");
    const db = new DatabaseSync(dbPath);
    t.after(() => { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES(${version},'now');
        CREATE TABLE episode_production_operations(operation_id TEXT PRIMARY KEY,receipt_json);
        CREATE TABLE production_preparations(operation_id TEXT PRIMARY KEY,receipt_json);
        CREATE TABLE tasks(id TEXT PRIMARY KEY,input_json,params_json);
        CREATE TABLE canvas_operation_batches(operation_id TEXT PRIMARY KEY,operations_json,results_json);
        CREATE TABLE generation_logs(id TEXT PRIMARY KEY,params_json);`);
    if (includeCanvasOps) db.exec("CREATE TABLE canvas_production_operations(operation_id TEXT PRIMARY KEY,receipt_json)");
    return { db, dbPath, dir };
}
function longRaw(label: string) { return `{ "label" : "${label}", "padding" : "${"x".repeat(6000)}", "decimal" : 1.00 }`; }
function seed(db: DatabaseSync) {
    const plain = longRaw("plain-preserve-verbatim");
    const gzip = longRaw("legacy-gzip");
    const brotli = longRaw("brotli-already");
    db.prepare("INSERT INTO episode_production_operations VALUES(?,?)").run("ep", plain);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='canvas_production_operations'").get()) db.prepare("INSERT INTO canvas_production_operations VALUES(?,?)").run("canvas-op", gzipSync(Buffer.from(gzip)));
    db.prepare("INSERT INTO production_preparations VALUES(?,?)").run("empty", null);
    db.prepare("INSERT INTO production_preparations VALUES(?,?)").run("small", "{\"ok\":true}");
    db.prepare("INSERT INTO tasks VALUES(?,?,?)").run("task", compressStoredJsonText(brotli), plain);
    db.prepare("INSERT INTO canvas_operation_batches VALUES(?,?,?)").run("batch", gzipSync(Buffer.from(gzip)), plain);
    db.prepare("INSERT INTO generation_logs VALUES(?,?)").run("log", "{\"ok\":true}");
    return { plain, gzip, brotli };
}
function snapshot(db: DatabaseSync, backupPath: string) { db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`); }
function value(db: DatabaseSync, table: string, keyColumn: string, key: string, column: string) {
    return db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn}=?`).get(key)?.value as string | Uint8Array | null;
}

test("previous and current schema previews are read-only and report allowlisted columns without payloads", t => {
    const { db } = fixture(t, DATABASE_SCHEMA_VERSION - 1, false);
    const original = seed(db);
    const plan = inspectJsonRepack(db);
    assert.equal(plan.schemaVersion, DATABASE_SCHEMA_VERSION - 1);
    assert.ok(plan.totals.candidates > 0);
    assert.ok(plan.columns.some(col => col.table === "production_preparations" && col.nullRows === 1));
    assert.ok(plan.columns.every(col => ["receipt_json", "input_json", "params_json", "operations_json", "results_json"].includes(col.column)));
    assert.equal(JSON.stringify(plan).includes(original.plain), false);
    assert.equal(db.isTransaction, false);
    assert.throws(() => applyJsonRepack(db, "unused"), /requires schema/);
});

test("apply verifies exact backup, preserves decoded UTF-8 verbatim, and is idempotent", t => {
    const { db, dir } = fixture(t);
    const expected = seed(db);
    const backupPath = path.join(dir, "verified.sqlite"); snapshot(db, backupPath);
    const backupBefore = fs.readFileSync(backupPath);
    const plan = inspectJsonRepack(db);
    const applied = applyJsonRepack(db, backupPath);
    assert.equal(applied.backupVerified, true);
    assert.equal(applied.updated, plan.totals.candidates);
    assert.equal(applied.changedSincePlan, 0);
    assert.equal(storedJsonText(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json")!), expected.plain);
    assert.equal(storedJsonText(value(db, "canvas_production_operations", "operation_id", "canvas-op", "receipt_json")!), expected.gzip);
    assert.equal(storedJsonText(value(db, "tasks", "id", "task", "input_json")!), expected.brotli);
    assert.equal(storedJsonText(value(db, "tasks", "id", "task", "params_json")!), expected.plain);
    assert.equal(storedJsonText(value(db, "canvas_operation_batches", "operation_id", "batch", "operations_json")!), expected.gzip);
    assert.equal(storedJsonText(value(db, "canvas_operation_batches", "operation_id", "batch", "results_json")!), expected.plain);
    assert.equal(value(db, "production_preparations", "operation_id", "empty", "receipt_json"), null);
    assert.equal(inspectJsonRepack(db).totals.candidates, 0);
    assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
});

test("backup mismatch aborts before the first update", t => {
    const { db, dir } = fixture(t);
    seed(db);
    const backupPath = path.join(dir, "stale.sqlite"); snapshot(db, backupPath);
    db.prepare("UPDATE episode_production_operations SET receipt_json=? WHERE operation_id='ep'").run(longRaw("changed-after-backup"));
    const before = value(db, "episode_production_operations", "operation_id", "ep", "receipt_json");
    assert.throws(() => applyJsonRepack(db, backupPath), /backup does not match/);
    assert.equal(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json"), before);
    assert.equal(db.isTransaction, false);
});

test("late corrupt allowlisted row aborts preview before any write", t => {
    const { db, dir } = fixture(t);
    seed(db);
    db.prepare("INSERT INTO generation_logs VALUES(?,?)").run("bad-late", new Uint8Array([0, 1, 2, 3]));
    const before = value(db, "episode_production_operations", "operation_id", "ep", "receipt_json");
    const backupPath = path.join(dir, "backup.sqlite"); snapshot(db, backupPath);
    assert.throws(() => applyJsonRepack(db, backupPath), /corrupt or unknown encoded JSON/);
    assert.equal(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json"), before);
    assert.equal(db.isTransaction, false);
});

test("per-row CAS skips rows changed after preview without overwriting them", t => {
    const { db, dir } = fixture(t);
    seed(db);
    const backupPath = path.join(dir, "backup.sqlite"); snapshot(db, backupPath);
    let changed = false;
    const result = applyJsonRepack(db, backupPath, progress => {
        if (!changed && progress.status === "before-write" && progress.table === "episode_production_operations") {
            db.prepare("UPDATE episode_production_operations SET receipt_json=? WHERE operation_id='ep'").run("{\"concurrent\":true}");
            changed = true;
        }
    });
    assert.equal(changed, true);
    assert.equal(result.changedSincePlan, 1);
    assert.equal(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json"), "{\"concurrent\":true}");
    assert.equal(db.isTransaction, false);
});

test("a failed row update rolls back its transaction", t => {
    const { db, dir } = fixture(t);
    seed(db);
    const backupPath = path.join(dir, "backup.sqlite"); snapshot(db, backupPath);
    const before = value(db, "episode_production_operations", "operation_id", "ep", "receipt_json");
    db.exec("CREATE TRIGGER reject_repack BEFORE UPDATE OF receipt_json ON episode_production_operations BEGIN SELECT RAISE(ABORT,'blocked'); END");
    assert.throws(() => applyJsonRepack(db, backupPath), /blocked/);
    assert.equal(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json"), before);
    assert.equal(db.isTransaction, false);
});


test("unsupported primary-key layout is refused before repacking", t => {
    const { db } = fixture(t);
    db.exec("DROP TABLE episode_production_operations; CREATE TABLE episode_production_operations(owner_id TEXT, operation_id TEXT, receipt_json, PRIMARY KEY(owner_id,operation_id))");
    assert.throws(() => inspectJsonRepack(db), /primary key is unsupported/);
});

test("CLI compaction shrinks the actual file while preserving all stored JSON", t => {
    const { db, dbPath, dir } = fixture(t);
    const raw = JSON.stringify({ padding: "retain every character ".repeat(150_000), flags: [false, 0, null] });
    db.prepare("INSERT INTO episode_production_operations VALUES('large',?)").run(raw);
    const backupPath = path.join(dir, "verified.sqlite"); snapshot(db, backupPath);
    const before = fs.statSync(dbPath).size;
    const output: string[] = [];
    t.mock.method(console, "log", (value: unknown) => output.push(String(value)));
    runJsonRepackCli(["--db", dbPath, "--apply", "--backup", backupPath, "--vacuum"]);
    const result = JSON.parse(output.at(-1)!);
    assert.equal(result.updated, 1);
    assert.equal(result.vacuumed, true);
    assert.ok(result.afterFileBytes < before / 2);
    assert.equal(storedJsonText(value(db, "episode_production_operations", "operation_id", "large", "receipt_json")!), raw);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM episode_production_operations").get()!.n, 1);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
});


test("a backup from another canvas collection is rejected even when candidate bytes match", t => {
    const { db, dir } = fixture(t); seed(db);
    db.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY); INSERT INTO canvas_projects VALUES('source-project')");
    const backupPath = path.join(dir, "wrong-profile.sqlite"); snapshot(db, backupPath);
    const other = new DatabaseSync(backupPath);
    other.exec("UPDATE canvas_projects SET id='another-profile'"); other.close();
    const before = value(db, "episode_production_operations", "operation_id", "ep", "receipt_json");
    assert.throws(() => applyJsonRepack(db, backupPath), /database identity does not match/);
    assert.equal(value(db, "episode_production_operations", "operation_id", "ep", "receipt_json"), before);
});

test("an extraneous external plan cannot write outside the allowlist", t => {
    const { db, dir } = fixture(t); seed(db);
    db.exec("CREATE TABLE private_settings(id TEXT PRIMARY KEY,value TEXT); INSERT INTO private_settings VALUES('setting','{\"keep\":true}')");
    const backupPath = path.join(dir, "verified.sqlite"); snapshot(db, backupPath);
    const forged = { schemaVersion: DATABASE_SCHEMA_VERSION, candidates: [{ table: "private_settings", column: "value", key: "id", id: "setting" }] };
    (applyJsonRepack as (...args: any[]) => unknown)(db, backupPath, undefined, forged);
    assert.equal(db.prepare("SELECT typeof(value) kind,value FROM private_settings").get()!.kind, "text");
    assert.equal(db.prepare("SELECT value FROM private_settings").get()!.value, '{"keep":true}');
});
