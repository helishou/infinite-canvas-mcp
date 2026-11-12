import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { compressStoredJsonText, storedJsonText } from "./json-storage.js";

type Target = { table: string; column: string; key: string; receipt?: boolean };

// Keep this list explicit: only these schema 52 JSON columns are in scope.
const TARGETS: readonly Target[] = [
    { table: "episode_production_operations", column: "receipt_json", key: "operation_id", receipt: true },
    { table: "canvas_production_operations", column: "receipt_json", key: "operation_id", receipt: true },
    { table: "production_preparations", column: "receipt_json", key: "operation_id", receipt: true },
    { table: "tasks", column: "input_json", key: "id" },
    { table: "tasks", column: "params_json", key: "id" },
    { table: "canvas_operation_batches", column: "operations_json", key: "operation_id" },
    { table: "canvas_operation_batches", column: "results_json", key: "operation_id" },
    { table: "generation_logs", column: "params_json", key: "id" },
];

const ENVELOPE = Buffer.from("ICBR1", "ascii");
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
type Stored = string | Uint8Array;

function decode(value: Stored): { text: string; kind: "text" | "gzip" | "brotli" } {
    if (typeof value === "string") return { text: value, kind: "text" };
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    try {
        if (bytes.subarray(0, ENVELOPE.length).equals(ENVELOPE)) {
            return { text: storedJsonText(bytes), kind: "brotli" };
        }
        if (bytes.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)) {
            return { text: utf8.decode(gunzipSync(bytes)), kind: "gzip" };
        }
    } catch {
        throw new Error("Storage format migration found corrupt encoded JSON");
    }
    throw new Error("Storage format migration found an unknown BLOB format");
}

/** Offline/maintenance-only decoder. Normal JSON storage readers must not depend on legacy gzip. */
export function readMigrationJsonText(value: unknown): string {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("Storage format migration found an unsupported SQLite value");
    const { text } = decode(value);
    try { JSON.parse(text); } catch { throw new Error("Storage format migration found invalid JSON"); }
    return text;
}

function encode(text: string, receipt: boolean): Stored {
    const raw = Buffer.from(text, "utf8");
    if (!receipt && raw.byteLength < 1024) return text;
    const compressed = compressStoredJsonText(text);
    if (receipt || compressed.byteLength < raw.byteLength) return compressed;
    return text;
}

/** Convert allowlisted schema 52 JSON columns to the current TEXT/ICBR1 representation.
 * The caller owns the transaction and must roll it back if this function throws.
 */
export function migrateStorageFormat(db: DatabaseSync): { updated: number; beforeBytes: number; afterBytes: number } {
    if (!db.isTransaction) throw new Error("Storage format migration requires a caller-owned transaction");
    let updated = 0, beforeBytes = 0, afterBytes = 0;
    for (const target of TARGETS) {
        const table = quote(target.table), column = quote(target.column), key = quote(target.key);
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(target.table);
        if (!exists) throw new Error(`Storage format migration is missing ${target.table}`);
        const rows = db.prepare(`SELECT ${key} AS id, ${column} AS value, typeof(${column}) AS kind FROM ${table} WHERE ${column} IS NOT NULL ORDER BY rowid`).iterate() as Iterable<{ id: string; value: unknown; kind: string }>;
        const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`);
        const readback = db.prepare(`SELECT ${column} AS value, typeof(${column}) AS kind FROM ${table} WHERE ${key}=?`);
        for (const row of rows) {
            if ((row.kind === "text" && typeof row.value !== "string") || (row.kind === "blob" && !(row.value instanceof Uint8Array))) {
                throw new Error("Storage format migration found an unsupported SQLite value");
            }
            if (row.kind !== "text" && row.kind !== "blob") throw new Error("Storage format migration found an unsupported SQLite storage class");
            const original = row.value as Stored;
            const { text, kind } = decode(original);
            try { JSON.parse(text); } catch { throw new Error("Storage format migration found invalid JSON"); }
            if (kind === "brotli") continue;
            const next = encode(text, Boolean(target.receipt));
            if (typeof next === "string" && next === original) continue;
            const oldBytes = typeof original === "string" ? Buffer.byteLength(original, "utf8") : original.byteLength;
            const newBytes = typeof next === "string" ? Buffer.byteLength(next, "utf8") : next.byteLength;
            const changed = update.run(next, row.id);
            if (Number(changed.changes) !== 1) throw new Error("Storage format migration could not update a row");
            const check = readback.get(row.id) as { value: Stored; kind: string } | undefined;
            if (!check || check.kind !== (typeof next === "string" ? "text" : "blob")) throw new Error("Storage format migration readback failed");
            const decoded = decode(check.value);
            if (decoded.text !== text) throw new Error("Storage format migration readback mismatch");
            beforeBytes += oldBytes;
            afterBytes += newBytes;
            updated++;
        }
    }
    return { updated, beforeBytes, afterBytes };
}
