import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DB_FILE } from "../config.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { createDatabaseSnapshot } from "../database-snapshots.js";
import { storedJsonText, type StoredJson } from "../json-storage.js";

const targets = [
    { table: "tasks", key: "id", columns: ["input_json"] },
    { table: "canvas_operation_batches", key: "operation_id", columns: ["operations_json", "results_json"] },
] as const;

function compressedText(value: StoredJson): Buffer | null {
    if (typeof value !== "string") { JSON.parse(storedJsonText(value)); return null; }
    JSON.parse(value);
    const compressed = gzipSync(Buffer.from(value, "utf8"));
    // Preserve the original JSON bytes, including whitespace and numeric spelling:
    // canvas maintenance fingerprints must not change with the storage encoding.
    return compressed.length < Buffer.byteLength(value, "utf8") ? compressed : null;
}

export function inspectSnapshotCompression(db: DatabaseSync, backup?: DatabaseSync) {
    if (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version !== DATABASE_SCHEMA_VERSION) {
        throw new Error(`Snapshot compression requires schema ${DATABASE_SCHEMA_VERSION}`);
    }
    return targets.flatMap(target => target.columns.map(column => {
        const keys: string[] = [];
        let bytes = 0, projectedBytes = 0, rows = 0, alreadyCompressed = 0;
        const backupRead = backup?.prepare(`SELECT ${column} AS value FROM ${target.table} WHERE ${target.key}=?`);
        for (const row of db.prepare(`SELECT ${target.key} AS id, ${column} AS value FROM ${target.table} ORDER BY ${target.key}`).iterate() as Iterable<{ id: string; value: StoredJson }>) {
            rows++;
            const size = typeof row.value === "string" ? Buffer.byteLength(row.value, "utf8") : row.value.byteLength;
            bytes += size;
            const compressed = compressedText(row.value);
            projectedBytes += compressed?.length ?? size;
            if (row.value instanceof Uint8Array) alreadyCompressed++;
            if (!compressed) continue;
            if (backupRead && backupRead.get(row.id)?.value !== row.value) {
                throw new Error(`Backup does not contain the original ${target.table}.${column} record ${row.id}; no conversion started`);
            }
            keys.push(row.id);
        }
        return { table: target.table, key: target.key, column, rows, alreadyCompressed, bytes, projectedBytes, keys };
    }));
}

/** Only storage bytes change. Compare-and-swap preserves concurrent business edits. */
export function compressSnapshotJson(db: DatabaseSync, backup: DatabaseSync, progress?: (value: unknown) => void) {
    const plans = inspectSnapshotCompression(db, backup);
    const results = [];
    for (const plan of plans) {
        const read = db.prepare(`SELECT ${plan.column} AS value FROM ${plan.table} WHERE ${plan.key}=?`);
        const backupRead = backup.prepare(`SELECT ${plan.column} AS value FROM ${plan.table} WHERE ${plan.key}=?`);
        const update = db.prepare(`UPDATE ${plan.table} SET ${plan.column}=? WHERE ${plan.key}=? AND ${plan.column}=?`);
        let converted = 0, changedSincePlan = 0, savedBytes = 0;
        for (let offset = 0; offset < plan.keys.length; offset += 50) {
            db.exec("BEGIN IMMEDIATE");
            try {
                for (const id of plan.keys.slice(offset, offset + 50)) {
                    const value = read.get(id)?.value;
                    if (typeof value !== "string" || backupRead.get(id)?.value !== value) { changedSincePlan++; continue; }
                    const compressed = compressedText(value);
                    if (!compressed) { changedSincePlan++; continue; }
                    assert.equal(storedJsonText(compressed), value);
                    assert.equal(Number(update.run(compressed, id, value).changes), 1);
                    assert.equal(storedJsonText(read.get(id)?.value), value);
                    converted++;
                    savedBytes += Buffer.byteLength(value, "utf8") - compressed.length;
                }
                db.exec("COMMIT");
            } catch (error) { db.exec("ROLLBACK"); throw error; }
            if (offset % 500 === 0) progress?.({ table: plan.table, column: plan.column, converted, planned: plan.keys.length });
        }
        results.push({ table: plan.table, column: plan.column, converted, changedSincePlan, savedBytes });
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    let apply = false, vacuum = false, backupFile: string | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--apply" && !apply) apply = true;
        else if (args[i] === "--vacuum" && !vacuum) vacuum = true;
        else if (args[i] === "--backup" && !backupFile && args[i + 1] && !args[i + 1].startsWith("--")) backupFile = path.resolve(args[++i]);
        else throw new Error(`Unknown argument: ${args[i]}`);
    }
    if ((backupFile || vacuum) && !apply) throw new Error("--backup/--vacuum requires --apply");
    if (!fs.existsSync(DB_FILE)) throw new Error("Database does not exist");
    if (backupFile === path.resolve(DB_FILE)) throw new Error("Backup must be a separate file");
    const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
    try {
        db.exec("PRAGMA busy_timeout=5000"); // This maintenance invocation only.
        const beforeFileBytes = fs.statSync(DB_FILE).size;
        if (!apply) {
            const plans = inspectSnapshotCompression(db);
            console.log(JSON.stringify({ dryRun: true, plans: plans.map(({ keys, ...plan }) => ({ ...plan, toConvert: keys.length })) }, null, 2));
            return;
        }
        if (!backupFile) backupFile = createDatabaseSnapshot(db, DB_FILE, "pre-snapshot-compression");
        console.log(JSON.stringify({ stage: "verify-backup", backupFile }));
        const backup = new DatabaseSync(backupFile, { readOnly: true });
        let results;
        try {
            assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
            results = compressSnapshotJson(db, backup, value => console.log(JSON.stringify(value)));
        } finally { backup.close(); }
        assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        if (vacuum) {
            console.log(JSON.stringify({ stage: "vacuum" }));
            db.exec("VACUUM");
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        }
        console.log(JSON.stringify({ ok: true, backupFile, results, savedLogicalBytes: results.reduce((sum, item) => sum + item.savedBytes, 0), vacuum, beforeFileBytes, afterFileBytes: fs.statSync(DB_FILE).size }, null, 2));
    } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
