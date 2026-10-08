import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const DATABASE_SCHEMA_VERSION = 35;

/** Inspect without writes; snapshot every existing older database before migration. */
export function prepareDatabaseUpgrade(file: string): string | undefined {
    if (file === ":memory:" || !fs.existsSync(file) || fs.statSync(file).size === 0) return;
    const source = new DatabaseSync(file, { readOnly: true });
    try {
        const hasVersions = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
        const row = hasVersions ? source.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: unknown } : undefined;
        const version = row?.version ?? 0;
        if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > DATABASE_SCHEMA_VERSION) {
            throw new Error(`Unsupported database schema version ${String(version)} (supported: ${DATABASE_SCHEMA_VERSION}). Refusing to modify existing data; use the matching application version.`);
        }
        if (version === DATABASE_SCHEMA_VERSION) return;
        const backup = `${file}.pre-schema-v${version}-to-v${DATABASE_SCHEMA_VERSION}-${crypto.randomUUID()}.sqlite`;
        source.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        fs.chmodSync(backup, 0o600);
        const copy = new DatabaseSync(backup, { readOnly: true });
        try {
            const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
            if (check.integrity_check !== "ok") throw new Error("Pre-migration database backup failed integrity validation; migration was not started.");
        } finally { copy.close(); }
        return backup;
    } finally { source.close(); }
}
