import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createDatabaseSnapshot, pruneDatabaseSnapshots } from "./database-snapshots.js";

export const DATABASE_SCHEMA_VERSION = 53;
export const MINIMUM_DATABASE_SCHEMA_VERSION = 52;

/** 迁移快照用途族名：`runtime.sqlite.pre-schema-*`。 */
export const MIGRATION_SNAPSHOT_FAMILY = "pre-schema";

/** Inspect without writes; snapshot every existing older database before migration. */
export function prepareDatabaseUpgrade(file: string): string | undefined {
    if (file === ":memory:" || !fs.existsSync(file) || fs.statSync(file).size === 0) return;
    const source = new DatabaseSync(file, { readOnly: true });
    try {
        const hasVersions = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
        const row = hasVersions ? source.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: unknown } : undefined;
        const version = row?.version ?? 0;
        if (typeof version !== "number" || !Number.isInteger(version) || version < MINIMUM_DATABASE_SCHEMA_VERSION || version > DATABASE_SCHEMA_VERSION) {
            throw new Error(`Unsupported database schema version ${String(version)} (supported: ${MINIMUM_DATABASE_SCHEMA_VERSION}–${DATABASE_SCHEMA_VERSION}; older databases must first be upgraded with the previous Backend). Refusing to modify existing data; use the matching application version.`);
        }
        if (version === DATABASE_SCHEMA_VERSION) return;
        const backup = createDatabaseSnapshot(source, file, `${MIGRATION_SNAPSHOT_FAMILY}-v${version}-to-v${DATABASE_SCHEMA_VERSION}`);
        const copy = new DatabaseSync(backup, { readOnly: true });
        try {
            const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
            if (check.integrity_check !== "ok") throw new Error("Pre-migration database backup failed integrity validation; migration was not started.");
        } finally { copy.close(); }
        // 校验通过后再回收旧快照：迁移可重试，但同一用途的完整副本不会无上限堆积。
        pruneDatabaseSnapshots(file, MIGRATION_SNAPSHOT_FAMILY);
        return backup;
    } finally { source.close(); }
}
