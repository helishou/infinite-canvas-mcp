import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { compressStoredJsonText } from "../json-storage.js";
import { readMigrationJsonText } from "../storage-format-migration.js";
import { createDatabaseSnapshot } from "../database-snapshots.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { DB_FILE } from "../config.js";

type ValueKind = "text" | "blob";
type Target = { table: string; column: string; key: string; optional?: boolean };
type Candidate = Target & { id: string; storedHash: string; storedBytes: number; storageKind: ValueKind; rawHash: string; rawBytes: number; projectedBytes: number };
type StoredValue = string | Uint8Array;
type Row = { id: string; value: StoredValue; storageKind: ValueKind };
export type RepackColumnReport = { table: string; column: string; rows: number; nullRows: number; textRows: number; blobRows: number; candidates: number; unchangedRows: number; beforeBytes: number; projectedBytes: number };
export type JsonRepackPlan = { schemaVersion: number; columns: RepackColumnReport[]; totals: Omit<RepackColumnReport, "table" | "column">; candidates: Candidate[] };
export type JsonRepackProgress = { table: string; column: string; index: number; total: number; status: "before-write" | "updated" | "changed" };
export type JsonRepackApplyResult = { schemaVersion: number; backupVerified: true; updated: number; changedSincePlan: number; savedLogicalBytes: number; columns: RepackColumnReport[]; totals: JsonRepackPlan["totals"] };

const TARGETS: Target[] = [
    { table: "episode_production_operations", column: "receipt_json", key: "operation_id" },
    { table: "canvas_production_operations", column: "receipt_json", key: "operation_id", optional: true },
    { table: "production_preparations", column: "receipt_json", key: "operation_id" },
    { table: "tasks", column: "input_json", key: "id" },
    { table: "tasks", column: "params_json", key: "id" },
    { table: "canvas_operation_batches", column: "operations_json", key: "operation_id" },
    { table: "canvas_operation_batches", column: "results_json", key: "operation_id" },
    { table: "generation_logs", column: "params_json", key: "id" },
];
const PREVIEW_VERSIONS = new Set([DATABASE_SCHEMA_VERSION - 1, DATABASE_SCHEMA_VERSION]);
const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: Uint8Array | string) => crypto.createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)).digest("hex");
const rawSize = (value: string) => Buffer.byteLength(value, "utf8");
function storageBytes(value: StoredValue) { return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value); }
function isBlob(value: unknown): value is Uint8Array { return value instanceof Uint8Array; }
function storedValue(value: unknown, storageKind: unknown, table: string, column: string): { value: StoredValue; kind: ValueKind } {
    if (storageKind === "text" && typeof value === "string") return { value, kind: "text" };
    if (storageKind === "blob" && isBlob(value)) return { value, kind: "blob" };
    throw new Error(`JSON repack found an unsupported SQLite value in ${table}.${column}`);
}
function jsonText(value: StoredValue, table: string, column: string): string {
    let text: string;
    try { text = readMigrationJsonText(value); JSON.parse(text); }
    catch { throw new Error(`JSON repack found corrupt or unknown encoded JSON in ${table}.${column}`); }
    return text;
}
function schemaVersion(db: DatabaseSync): number {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!exists) throw new Error("JSON repack requires schema_migrations");
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    if (row.version == null || !Number.isInteger(Number(row.version))) throw new Error("JSON repack cannot determine database schema version");
    return Number(row.version);
}
function assertPreviewSchema(db: DatabaseSync) {
    const version = schemaVersion(db);
    if (!PREVIEW_VERSIONS.has(version)) throw new Error(`JSON repack preview supports schema ${[...PREVIEW_VERSIONS].sort().join(" or ")}; found ${version}`);
    return version;
}
function resolveTargets(db: DatabaseSync): Target[] {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const result: Target[] = [];
    for (const target of TARGETS) {
        if (!tables.has(target.table)) {
            if (target.optional) continue;
            throw new Error(`JSON repack database layout is missing required table ${target.table}`);
        }
        const info = db.prepare(`PRAGMA table_info(${quoteIdent(target.table)})`).all() as Array<{ name: string; pk: number }>;
        const primary = info.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name);
        if (primary.length !== 1 || primary[0] !== target.key) throw new Error(`JSON repack database primary key is unsupported in ${target.table}`);
        const columns = new Set(info.map(row => row.name));
        for (const column of [target.key, target.column]) if (!columns.has(column)) throw new Error(`JSON repack database layout is missing ${target.table}.${column}`);
        result.push(target);
    }
    return result;
}
function emptyColumn(target: Target): RepackColumnReport {
    return { table: target.table, column: target.column, rows: 0, nullRows: 0, textRows: 0, blobRows: 0, candidates: 0, unchangedRows: 0, beforeBytes: 0, projectedBytes: 0 };
}
function totals(columns: RepackColumnReport[]): JsonRepackPlan["totals"] {
    return columns.reduce((sum, item) => {
        for (const key of ["rows", "nullRows", "textRows", "blobRows", "candidates", "unchangedRows", "beforeBytes", "projectedBytes"] as const) sum[key] += item[key];
        return sum;
    }, { rows: 0, nullRows: 0, textRows: 0, blobRows: 0, candidates: 0, unchangedRows: 0, beforeBytes: 0, projectedBytes: 0 });
}
function queryRows(db: DatabaseSync, target: Target) {
    const table = quoteIdent(target.table), key = quoteIdent(target.key), column = quoteIdent(target.column);
    return db.prepare(`SELECT ${key} AS id, ${column} AS value, typeof(${column}) AS storage_kind FROM ${table} ORDER BY rowid`).iterate() as Iterable<{ id: string; value: unknown; storage_kind: string }>;
}
function buildPlan(db: DatabaseSync, version: number): JsonRepackPlan {
    const columns: RepackColumnReport[] = [], candidates: Candidate[] = [];
    for (const target of resolveTargets(db)) {
        const report = emptyColumn(target);
        for (const row of queryRows(db, target)) {
            report.rows++;
            if (row.value == null) { report.nullRows++; continue; }
            const stored = storedValue(row.value, row.storage_kind, target.table, target.column);
            if (stored.kind === "text") report.textRows++; else report.blobRows++;
            const raw = jsonText(stored.value, target.table, target.column);
            const compressed: Uint8Array = compressStoredJsonText(raw);
            const currentBytes = storageBytes(stored.value).byteLength;
            const nextBytes = Buffer.from(compressed).byteLength;
            report.beforeBytes += currentBytes;
            if (nextBytes < currentBytes) {
                report.candidates++;
                report.projectedBytes += nextBytes;
                candidates.push({ ...target, id: String(row.id), storedHash: hash(stored.value), storedBytes: currentBytes, storageKind: stored.kind, rawHash: hash(raw), rawBytes: rawSize(raw), projectedBytes: nextBytes });
            } else {
                report.unchangedRows++;
                report.projectedBytes += currentBytes;
            }
        }
        columns.push(report);
    }
    return { schemaVersion: version, columns, totals: totals(columns), candidates };
}

/** Read-only preview. Retains candidate keys and hashes only, never JSON payloads. */
export function inspectJsonRepack(db: DatabaseSync): JsonRepackPlan {
    return buildPlan(db, assertPreviewSchema(db));
}

function compareStoredRow(db: DatabaseSync, target: Target, id: string) {
    const table = quoteIdent(target.table), key = quoteIdent(target.key), column = quoteIdent(target.column);
    return db.prepare(`SELECT ${column} AS value, typeof(${column}) AS storage_kind FROM ${table} WHERE ${key}=?`).get(id) as { value: unknown; storage_kind: string } | undefined;
}
function validateCandidateBackup(source: DatabaseSync, backup: DatabaseSync, candidate: Candidate) {
    const original = compareStoredRow(source, candidate, candidate.id);
    const frozen = compareStoredRow(backup, candidate, candidate.id);
    if (!frozen || frozen.value == null) throw new Error(`JSON repack backup is missing a planned row in ${candidate.table}.${candidate.column}`);
    const backupValue = storedValue(frozen.value, frozen.storage_kind, candidate.table, candidate.column);
    const backupRaw = jsonText(backupValue.value, candidate.table, candidate.column);
    const backupBytes = storageBytes(backupValue.value);
    if (backupValue.kind !== candidate.storageKind || backupBytes.byteLength !== candidate.storedBytes || hash(backupBytes) !== candidate.storedHash || rawSize(backupRaw) !== candidate.rawBytes || hash(backupRaw) !== candidate.rawHash) {
        throw new Error(`JSON repack backup does not match the planned original row in ${candidate.table}.${candidate.column}`);
    }
    // If the live row still matches the plan, compare exact bytes as an additional check.
    if (original && original.value != null && original.storage_kind === candidate.storageKind) {
        const liveValue = storedValue(original.value, original.storage_kind, candidate.table, candidate.column);
        if (hash(liveValue.value) === candidate.storedHash && !storageBytes(liveValue.value).equals(backupBytes)) throw new Error(`JSON repack backup bytes do not match the live original in ${candidate.table}.${candidate.column}`);
    }
}
/** Apply losslessly after exact backup verification; each CAS update is its own short transaction. */
export function applyJsonRepack(db: DatabaseSync, backupPath: string, progress?: (value: JsonRepackProgress) => void): JsonRepackApplyResult {
    if (db.isTransaction) throw new Error("JSON repack apply requires an idle caller-owned database connection");
    const version = schemaVersion(db);
    if (version !== DATABASE_SCHEMA_VERSION) throw new Error(`JSON repack apply requires schema ${DATABASE_SCHEMA_VERSION}; found ${version}`);
    return applyPreparedJsonRepack(db, backupPath, buildPlan(db, version), progress);
}

function databaseIdentity(db: DatabaseSync): string {
    const digest = crypto.createHash("sha256");
    // Stable application identities distinguish this project/task collection from another
    // database while allowing the explicit schema51 -> schema52 encoding-only marker.
    const identityTables = new Map(resolveTargets(db).map(target => [target.table, target.key]));
    let hasProjectIdentity = false;
    for (const table of ["canvas_projects", "drama_projects", "drama_episodes"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const key = (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string; pk: number }>).find(row => row.pk === 1)?.name;
        if (key) {
            // Task/log IDs may grow during a long maintenance preview. Project
            // identities distinguish profiles without blocking independent new tasks.
            if (!hasProjectIdentity) { identityTables.clear(); hasProjectIdentity = true; }
            identityTables.set(table, key);
        }
    }
    for (const [table, key] of [...identityTables].sort(([a], [b]) => a.localeCompare(b))) {
        digest.update(JSON.stringify([table, key]));
        for (const row of db.prepare(`SELECT ${quoteIdent(key)} id FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(key)}`).iterate() as Iterable<{ id: unknown }>) digest.update(JSON.stringify(row.id) + "\n");
    }
    return digest.digest("hex");
}

/** Private: only plans built in this module may select maintenance targets. */
function applyPreparedJsonRepack(db: DatabaseSync, backupPath: string, plan: JsonRepackPlan, progress?: (value: JsonRepackProgress) => void): JsonRepackApplyResult {
    if (db.isTransaction) throw new Error("JSON repack apply requires an idle caller-owned database connection");
    const version = schemaVersion(db);
    if (version !== DATABASE_SCHEMA_VERSION) throw new Error(`JSON repack apply requires schema ${DATABASE_SCHEMA_VERSION}; found ${version}`);
    const allowed = new Set(resolveTargets(db).map(target => JSON.stringify([target.table, target.column, target.key])));
    if (plan.candidates.some(candidate => !allowed.has(JSON.stringify([candidate.table, candidate.column, candidate.key])))) throw new Error("JSON repack plan contains a non-allowlisted target");
    if (plan.schemaVersion !== version) throw new Error("JSON repack plan schema no longer matches source");
    const backupFile = path.resolve(backupPath);
    if (!fs.existsSync(backupFile) || !fs.statSync(backupFile).isFile()) throw new Error("JSON repack backup file does not exist");
    const liveFile = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")?.file || "");
    if (liveFile && path.resolve(liveFile).toLowerCase() === fs.realpathSync(backupFile).toLowerCase()) throw new Error("JSON repack backup must be a separate file");
    if (liveFile) {
        const sourceStat = fs.statSync(liveFile), backupStat = fs.statSync(backupFile);
        if (sourceStat.dev === backupStat.dev && sourceStat.ino === backupStat.ino) throw new Error("JSON repack backup must not share the source file");
    }
    const backup = new DatabaseSync(backupFile, { readOnly: true });
    let updated = 0, changedSincePlan = 0, savedLogicalBytes = 0;
    try {
        const backupVersion = schemaVersion(backup);
        if (!PREVIEW_VERSIONS.has(backupVersion)) throw new Error(`JSON repack backup schema ${backupVersion} is unsupported`);
        const integrity = backup.prepare("PRAGMA integrity_check").iterate() as Iterable<{ integrity_check: string }>;
        for (const row of integrity) if (row.integrity_check !== "ok") throw new Error("JSON repack backup failed integrity_check");
        if (!(backup.prepare("PRAGMA foreign_key_check").iterate() as Iterable<unknown>)[Symbol.iterator]().next().done) throw new Error("JSON repack backup failed foreign_key_check");
        resolveTargets(backup);
        if (databaseIdentity(db) !== databaseIdentity(backup)) throw new Error("JSON repack backup database identity does not match the source");
        for (const candidate of plan.candidates) validateCandidateBackup(db, backup, candidate);

        for (const [index, candidate] of plan.candidates.entries()) {
            const current = compareStoredRow(db, candidate, candidate.id);
            if (!current || current.value == null) { changedSincePlan++; progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "changed" }); continue; }
            const before = storedValue(current.value, current.storage_kind, candidate.table, candidate.column);
            const raw = jsonText(before.value, candidate.table, candidate.column);
            if (before.kind !== candidate.storageKind || storageBytes(before.value).byteLength !== candidate.storedBytes || hash(before.value) !== candidate.storedHash || hash(raw) !== candidate.rawHash) {
                changedSincePlan++;
                progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "changed" });
                continue;
            }
            const compressed = compressStoredJsonText(raw);
            if (readMigrationJsonText(compressed) !== raw) throw new Error(`JSON repack codec round-trip failed in ${candidate.table}.${candidate.column}`);
            progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "before-write" });
            db.exec("BEGIN IMMEDIATE");
            try {
                const table = quoteIdent(candidate.table), key = quoteIdent(candidate.key), column = quoteIdent(candidate.column);
                const reread = compareStoredRow(db, candidate, candidate.id);
                if (!reread || reread.value == null || reread.storage_kind !== candidate.storageKind || hash(storageBytes(storedValue(reread.value, reread.storage_kind, candidate.table, candidate.column).value)) !== candidate.storedHash) {
                    db.exec("ROLLBACK"); changedSincePlan++;
                    progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "changed" });
                    continue;
                }
                const result = db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=? AND ${column}=? AND typeof(${column})=?`)
                    .run(Buffer.from(compressed), candidate.id, typeof reread.value === "string" ? reread.value : Buffer.from(reread.value as Uint8Array), candidate.storageKind);
                if (Number(result.changes) !== 1) { db.exec("ROLLBACK"); changedSincePlan++; progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "changed" }); continue; }
                const readback = compareStoredRow(db, candidate, candidate.id);
                if (!readback || readback.value == null || readback.storage_kind !== "blob" || readMigrationJsonText(readback.value) !== raw || !storageBytes(readback.value as Uint8Array).equals(Buffer.from(compressed))) throw new Error(`JSON repack readback verification failed in ${candidate.table}.${candidate.column}`);
                db.exec("COMMIT"); updated++; savedLogicalBytes += storageBytes(before.value).byteLength - compressed.byteLength;
                progress?.({ table: candidate.table, column: candidate.column, index: index + 1, total: plan.candidates.length, status: "updated" });
            } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
        }
    } finally { backup.close(); }
    return { schemaVersion: version, backupVerified: true, updated, changedSincePlan, savedLogicalBytes, columns: plan.columns, totals: plan.totals };
}

function parseArgs(args: string[]) {
    let apply = false, vacuum = false, dbPath = DB_FILE, backupPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--apply") { if (apply) throw new Error("Repeated --apply"); apply = true; }
        else if (arg === "--vacuum") { if (vacuum) throw new Error("Repeated --vacuum"); vacuum = true; }
        else if (arg === "--db" || arg === "--backup") {
            const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
            if (arg === "--db") dbPath = path.resolve(value); else backupPath = path.resolve(value);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (backupPath && !apply) throw new Error("--backup requires --apply");
    if (vacuum && !apply) throw new Error("--vacuum requires --apply");
    return { apply, vacuum, dbPath: path.resolve(dbPath), backupPath };
}
function displayPlan(plan: JsonRepackPlan) {
    const { candidates: _candidates, ...summary } = plan;
    return summary;
}
export function runJsonRepackCli(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) throw new Error("Database file does not exist; refusing to create a new database");
    if (!options.apply) {
        const db = new DatabaseSync(options.dbPath, { readOnly: true });
        try { console.log(JSON.stringify({ dryRun: true, dbPath: options.dbPath, ...displayPlan(inspectJsonRepack(db)) }, null, 2)); }
        finally { db.close(); }
        return;
    }
    const db = new DatabaseSync(options.dbPath);
    try {
        // Maintenance-only wait; the application write policy is unchanged.
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
        const beforeFileBytes = fs.statSync(options.dbPath).size;
        if (schemaVersion(db) !== DATABASE_SCHEMA_VERSION) throw new Error(`JSON repack apply requires schema ${DATABASE_SCHEMA_VERSION}`);
        // Validate the complete source before creating a backup or changing any row.
        const preview = inspectJsonRepack(db);
        const backupPath = options.backupPath
            ? options.backupPath
            : createDatabaseSnapshot(db, options.dbPath, "json-repack");
        const result = applyPreparedJsonRepack(db, backupPath, preview, progress => {
            if (progress.status === "updated" && progress.index % 500 === 0) process.stderr.write(JSON.stringify(progress) + "\n");
        });
        if (preview.candidates.length) process.stderr.write("\n");
        if (options.vacuum) {
            db.exec("VACUUM");
            const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
            if (checkpoint.busy) throw new Error("JSON repack is committed, but file reclamation is pending an active reader; original data and backup are retained");
        }
        if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) throw new Error("JSON repack final database validation failed");
        const afterFileBytes = fs.statSync(options.dbPath).size;
        const { columns, totals: aggregate, ...summary } = result;
        console.log(JSON.stringify({ dryRun: false, dbPath: options.dbPath, backupPath, vacuumed: options.vacuum, beforeFileBytes, afterFileBytes, ...summary, columns, totals: aggregate }, null, 2));
    } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { runJsonRepackCli(); }
    catch (error) { console.error(error instanceof Error ? error.message : "JSON repack failed"); process.exitCode = 1; }
}
