import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { DATABASE_SCHEMA_VERSION } from "./database-upgrade.js";

test("H3 migration retries after rollback without overwriting old or failed-attempt backups", (t) => {
    const base = path.resolve(process.env.INFINITE_CANVAS_DATA_DIR || os.tmpdir());
    fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, "h3-upgrade-retry-"));
    let migrated: BackendDatabase | undefined;
    t.after(() => {
        migrated?.close();
        if (!path.resolve(directory).startsWith(base + path.sep)) throw new Error("Invalid test cleanup directory");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, "runtime.sqlite");
    const initial = new BackendDatabase(file);
    initial.createCanvasProject({ id: "p", title: "User content", nodes: [], connections: [] });
    initial.db.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
    initial.close();
    // A previous release may have left its fixed-name snapshot behind.
    const oldBackup = `${file}.pre-h3-v14-reference-archive.sqlite`;
    fs.copyFileSync(file, oldBackup);
    const oldBytes = fs.readFileSync(oldBackup);
    const exec = DatabaseSync.prototype.exec;
    const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (sql.includes("CREATE TABLE IF NOT EXISTS h3_reference_legacy_archive")) throw new Error("transient migration failure");
        return exec.call(this, sql);
    });
    assert.throws(() => new BackendDatabase(file), /transient migration failure/);
    fault.mock.restore();
    const failedBackups = fs.readdirSync(directory).filter((name) => name.startsWith("runtime.sqlite.pre-h3-v14-reference-archive-"));
    assert.equal(failedBackups.length, 1);
    const failedBackup = path.join(directory, failedBackups[0]);
    const failedBytes = fs.readFileSync(failedBackup);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
        assert.equal(check.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 13);
    } finally { check.close(); }

    migrated = new BackendDatabase(file);
    assert.equal(migrated.getCanvasProject("p")?.title, "User content");
    assert.equal(migrated.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
    assert.deepEqual(fs.readFileSync(oldBackup), oldBytes);
    assert.deepEqual(fs.readFileSync(failedBackup), failedBytes);
    const backups = fs.readdirSync(directory).filter((name) => name.startsWith("runtime.sqlite.pre-h3-v14-reference-archive-"));
    assert.equal(backups.length, 2);
    for (const name of backups) {
        const backup = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try { assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); }
        finally { backup.close(); }
    }
});
