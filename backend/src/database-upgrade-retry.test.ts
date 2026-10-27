import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { DATABASE_SCHEMA_VERSION } from "./database-upgrade.js";
import { historicalDatabase } from "./test-helpers/historical-database.js";

test("H3 migration retries after rollback without overwriting snapshots and keeps the family bounded", (t) => {
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
    const initial = historicalDatabase(t, file, 13);
    initial.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)")
        .run("p", JSON.stringify({ id: "p", title: "User content", nodes: [], connections: [] }), "2026-01-01");
    initial.close();
    // A previous release may have left its fixed-name snapshot behind.
    const oldBackup = `${file}.pre-h3-v14-reference-archive.sqlite`;
    fs.copyFileSync(file, oldBackup);
    // 遗留快照在现实中就是更旧的：显式回溯 mtime，让「保留最新若干份」的顺序确定。
    const legacyTime = new Date(Date.now() - 3_600_000);
    fs.utimesSync(oldBackup, legacyTime, legacyTime);
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
    const check = new DatabaseSync(file, { readOnly: true });
    try {
        assert.equal(check.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 13);
    } finally { check.close(); }

    migrated = new BackendDatabase(file);
    assert.equal(migrated.getCanvasProject("p")?.title, "User content");
    assert.equal(migrated.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
    // 保留策略：同一用途只留最新若干份，每份都是本次尝试独立生成的完整副本（从不覆写既有文件）。
    // 这次成功迁移链会连续产生新的 pre-h3 快照，于是更早的（含上一版本遗留的那份）被回收。
    const backups = fs.readdirSync(directory).filter((name) => name.startsWith("runtime.sqlite.pre-h3-"));
    assert.equal(backups.length, 2, "the pre-h3 family stays bounded");
    assert.equal(fs.existsSync(oldBackup), false, "the eldest snapshot is reclaimed, never overwritten");
    assert.equal(fs.existsSync(failedBackup), false, "older attempts are reclaimed once newer snapshots exist");
    for (const name of backups) {
        const backup = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try { assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); }
        finally { backup.close(); }
    }
});

for (const existingArchiveTable of [false, true]) test(`v41 scene archive migration preserves project data and is idempotent: existing=${existingArchiveTable}`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-archive-v41-"));
    const file = path.join(directory, "runtime.sqlite");
    let db: BackendDatabase | undefined;
    t.after(() => { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const seed = historicalDatabase(t, file, 40);
    seed.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)")
        .run("keep", JSON.stringify({ id: "keep", title: "Keep me", nodes: [], connections: [] }), "2026-01-01");
    // v41 also repairs releases where the earlier v37 archive table was absent.
    if (!existingArchiveTable) seed.exec("DROP TABLE production_scene_archives");
    seed.close();

    db = new BackendDatabase(file);
    assert.equal(db.getCanvasProject("keep")?.title, "Keep me");
    assert.equal(db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
    const columns = (db.db.prepare("PRAGMA table_info(production_scene_archives)").all() as Array<{ name: string }>).map(row => row.name);
    assert.ok(columns.includes("snapshot_json"));
    assert.ok(columns.includes("expires_at"));
    assert.ok(columns.includes("restored_at"));
    db.close();
    db = new BackendDatabase(file);
    assert.equal(db.getCanvasProject("keep")?.title, "Keep me");
    assert.equal(fs.readdirSync(directory).filter(name => name.includes(`.pre-schema-v40-to-v${DATABASE_SCHEMA_VERSION}-`)).length, 1);
});
