import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { BackendDatabase } from "../db.js";

/** Run the real migration chain only through a committed historical version. */
export function historicalDatabase(t: TestContext, file: string, version: 13 | 16 | 20 | 21 | 24 | 39 | 40): DatabaseSync {
    assert.equal(fs.existsSync(file), false, "historical fixtures must start in a new temporary database");
    const stopped = new Error(`Historical fixture reached v${version}`);
    const exec = DatabaseSync.prototype.exec;
    let inTransaction = false;
    const stop = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        const hasVersions = this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        if (!inTransaction && hasVersions && this.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version === version) {
            throw stopped;
        }
        const result = exec.call(this, sql);
        if (/^BEGIN\b/i.test(sql.trim())) inTransaction = true;
        if (/^(COMMIT|ROLLBACK)\b/i.test(sql.trim())) inTransaction = false;
        return result;
    });
    try {
        assert.throws(() => new BackendDatabase(file), error => error === stopped);
    } finally {
        stop.mock.restore();
    }
    // Reopening proves that the selected migration committed before the stop.
    // The next migration has not executed even its BEGIN (or pre-migration backup).
    const db = new DatabaseSync(file);
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, version);
    for (const [introduced, table] of [[14, "h3_reference_legacy_archive"], [15, "episode_productions"], [17, "canvas_productions"],
        [21, "mcp_command_receipts"], [22, "episode_production_batches"], [26, "production_layout_plans"], [37, "production_scene_archives"]] as const) {
        assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)), version >= introduced, table);
    }
    const columns = db.prepare("PRAGMA table_info(drama_projects)").all() as Array<{ name: string }>;
    assert.equal(columns.some(column => column.name === "production_plan_json"), version >= 25);
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    return db;
}
