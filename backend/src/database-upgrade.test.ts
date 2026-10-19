import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DATABASE_SCHEMA_VERSION, prepareDatabaseUpgrade } from "./database-upgrade.js";
import { BackendDatabase } from "./db.js";

function fixture(t: TestContext, version: number) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-upgrade-"));
    t.after(() => {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid test cleanup directory");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, "runtime.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE canvases (id TEXT PRIMARY KEY, content TEXT);");
    db.prepare("INSERT INTO schema_migrations VALUES (?)").run(version);
    db.prepare("INSERT INTO canvases VALUES ('p', 'user content')").run();
    db.close();
    return { file, directory };
}

test("newer schema is refused without modifying existing data or making a backup", (t) => {
    const { file, directory } = fixture(t, DATABASE_SCHEMA_VERSION + 1);
    const original = fs.readFileSync(file);
    assert.throws(() => prepareDatabaseUpgrade(file), /Refusing to modify existing data/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readdirSync(directory), ["runtime.sqlite"]);
});

test("older schema receives a verified snapshot including committed WAL data", (t) => {
    const { file } = fixture(t, DATABASE_SCHEMA_VERSION - 1);
    const writer = new DatabaseSync(file);
    try {
        writer.exec("PRAGMA journal_mode=WAL;");
        writer.prepare("INSERT INTO canvases VALUES ('wal', 'latest edit')").run();
        const backup = prepareDatabaseUpgrade(file);
        assert.ok(backup);
        const copy = new DatabaseSync(backup, { readOnly: true });
        try {
            assert.equal(copy.prepare("SELECT content FROM canvases WHERE id='wal'").get()?.content, "latest edit");
            assert.equal(copy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION - 1);
        } finally { copy.close(); }
        const secondBackup = prepareDatabaseUpgrade(file);
        assert.notEqual(secondBackup, backup, "previous snapshots must never be overwritten");
    } finally { writer.close(); }
});

test("current schema and a fresh database do not create migration snapshots", (t) => {
    const { file, directory } = fixture(t, DATABASE_SCHEMA_VERSION);
    assert.equal(prepareDatabaseUpgrade(file), undefined);
    assert.equal(prepareDatabaseUpgrade(path.join(directory, "new.sqlite")), undefined);
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.equal(prepareDatabaseUpgrade(":memory:"), undefined);
});

test("supported schema version matches the latest migration applied by BackendDatabase", () => {
    const db = new BackendDatabase(":memory:");
    try {
        const row = db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
        assert.equal(row.version, DATABASE_SCHEMA_VERSION, "update DATABASE_SCHEMA_VERSION whenever a migration is added, and add a migration when it is raised");
    } finally {
        db.close();
    }
});

test("snapshot failure prevents migration and preserves source content", (t) => {
    const { file } = fixture(t, DATABASE_SCHEMA_VERSION - 1);
    const original = fs.readFileSync(file);
    const oldExec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (sql.startsWith("VACUUM INTO")) throw new Error("snapshot destination unavailable");
        return oldExec.call(this, sql);
    });
    assert.throws(() => prepareDatabaseUpgrade(file), /snapshot destination unavailable/);
    assert.deepEqual(fs.readFileSync(file), original);
});

test("repeated upgrade attempts keep a bounded number of verified snapshots", (t) => {
    const { file, directory } = fixture(t, DATABASE_SCHEMA_VERSION - 1);
    // 假的 mtime 全部取过去时间且单调递增：保留策略按 mtime 排序，这样顺序是确定的。
    const base = Date.now() - 60_000;
    const created: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        const backup = prepareDatabaseUpgrade(file);
        assert.ok(backup, "an older schema must always get its own snapshot");
        fs.utimesSync(backup, new Date(base + attempt * 1_000), new Date(base + attempt * 1_000));
        created.push(path.basename(backup));
    }
    const snapshots = fs.readdirSync(directory).filter((name) => name.startsWith("runtime.sqlite.pre-schema-")).sort();
    assert.equal(snapshots.length, 2, "retention caps snapshots per purpose");
    assert.deepEqual(snapshots, created.slice(-2).sort());
    for (const name of snapshots) {
        const copy = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try { assert.equal(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); } finally { copy.close(); }
    }
});
