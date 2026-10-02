import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { collaborationError } from "./collaboration.js";
import { stripCanvasLocalViewState } from "./operation-authority.js";
import { applyCanvasProjectOperations } from "./project-ops.js";

/** Caller owns the migration transaction. Missing legacy hashes are reserved, never guessed. */
export function migrateCanvasReceipts(db: DatabaseSync) {
    const orphan = db.prepare("SELECT r.operation_id FROM canvas_command_receipts r LEFT JOIN canvas_operation_batches b ON b.operation_id = r.operation_id WHERE b.operation_id IS NULL LIMIT 1").get();
    if (orphan) throw new Error("Cannot migrate an unowned canvas receipt; original data preserved");
    db.exec(`CREATE TABLE canvas_command_receipts_next (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        committed_revision INTEGER NOT NULL
    );
    INSERT INTO canvas_command_receipts_next
        SELECT b.operation_id, b.project_id, COALESCE(r.request_hash, ''), b.revision
        FROM canvas_operation_batches b LEFT JOIN canvas_command_receipts r ON r.operation_id = b.operation_id;
    DROP TABLE canvas_command_receipts;
    ALTER TABLE canvas_command_receipts_next RENAME TO canvas_command_receipts;
    CREATE INDEX canvas_command_receipts_project ON canvas_command_receipts(project_id);`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Canvas receipt migration failed foreign-key validation");
}

export function reconstructCanvasHistory(db: DatabaseSync, id: string, revision: number) {
    const checkpoint = db.prepare("SELECT revision, data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(id) as { revision: number; data_json: string } | undefined;
    if (!checkpoint || checkpoint.revision > revision) throw collaborationError("RECEIPT_UNAVAILABLE", "旧请求没有可恢复的历史快照");
    const project = stripCanvasLocalViewState(JSON.parse(checkpoint.data_json) as Record<string, unknown>);
    const rows = db.prepare("SELECT base_revision, revision, operations_json, created_at FROM canvas_operation_batches WHERE project_id = ? AND revision > ? AND revision <= ? ORDER BY revision").all(id, checkpoint.revision, revision) as Array<{ base_revision: number; revision: number; operations_json: string; created_at: string }>;
    if (rows.length !== revision - checkpoint.revision || rows.some((row, index) => row.base_revision !== checkpoint.revision + index || row.revision !== checkpoint.revision + index + 1)) {
        throw collaborationError("RECEIPT_UNAVAILABLE", "操作历史不连续，不能还原旧请求回执");
    }
    for (const row of rows) {
        applyCanvasProjectOperations(project, JSON.parse(row.operations_json), { committedReplay: true });
        project.revision = row.revision;
        project.updatedAt = row.created_at;
    }
    return stripCanvasLocalViewState(project);
}

export type CanvasHistoryPrunePlan = {
    projectId: string;
    currentRevision: number;
    checkpointRevision: number;
    throughRevision: number;
    batchCount: number;
    blockedReason?: string;
};

/** Read-only, including on older databases: never migrate as a side effect of a preview. */
export function previewCanvasHistoryPrune(db: DatabaseSync, cutoff: string): CanvasHistoryPrunePlan[] {
    if (!Number.isFinite(Date.parse(cutoff))) throw new Error("Invalid history cutoff");
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
    if (version !== DATABASE_SCHEMA_VERSION) throw new Error(`History maintenance requires schema ${DATABASE_SCHEMA_VERSION}; upgrade with the matching Backend first`);
    const projects = db.prepare("SELECT id, data_json FROM canvas_projects ORDER BY id").all() as Array<{ id: string; data_json: string }>;
    return projects.map(({ id, data_json }) => {
        const plan: CanvasHistoryPrunePlan = { projectId: id, currentRevision: 0, checkpointRevision: 0, throughRevision: 0, batchCount: 0 };
        try {
            const current = stripCanvasLocalViewState(JSON.parse(data_json) as Record<string, unknown>);
            plan.currentRevision = Number(current.revision || 0);
            const checkpoint = db.prepare("SELECT revision FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(id);
            if (!checkpoint) throw new Error("Missing history checkpoint");
            plan.checkpointRevision = plan.throughRevision = Number(checkpoint.revision);
            const rows = db.prepare("SELECT b.revision, b.created_at, r.operation_id AS receiptId FROM canvas_operation_batches b LEFT JOIN canvas_command_receipts r ON r.operation_id = b.operation_id AND r.project_id = b.project_id AND r.committed_revision = b.revision WHERE b.project_id = ? ORDER BY b.revision").all(id) as Array<{ revision: number; created_at: string; receiptId: string | null }>;
            if (rows.some((row) => row.revision <= plan.checkpointRevision || !row.receiptId || !Number.isFinite(Date.parse(row.created_at)))) throw new Error("Invalid batch boundary, date or missing receipt");
            // Validate the entire retained chain, not only the rows being deleted.
            if (!isDeepStrictEqual(reconstructCanvasHistory(db, id, plan.currentRevision), current)) throw new Error("History replay does not match the current project");
            if (rows.some((row) => row.revision > plan.currentRevision)) throw new Error("History contains a future revision");
            for (const row of rows) {
                if (Date.parse(row.created_at) >= Date.parse(cutoff)) break;
                plan.throughRevision = row.revision;
                plan.batchCount++;
            }
        } catch (error) {
            plan.blockedReason = error instanceof Error ? error.message : String(error);
            plan.batchCount = 0;
        }
        return plan;
    });
}

export function applyCanvasHistoryPrune(db: DatabaseSync, file: string, cutoff: string) {
    const preview = previewCanvasHistoryPrune(db, cutoff);
    if (preview.some((plan) => plan.blockedReason)) throw new Error("History validation failed; no batches were deleted");
    if (!preview.some((plan) => plan.batchCount)) return { plans: preview, removed: 0, backupFile: null };
    const backupFile = `${file}.before-batch-prune-${crypto.randomUUID()}.sqlite`;
    db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    fs.chmodSync(backupFile, 0o600);
    const copy = new DatabaseSync(backupFile, { readOnly: true });
    try {
        if (copy.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || copy.prepare("PRAGMA foreign_key_check").all().length) throw new Error("History backup failed validation");
    } finally { copy.close(); }
    db.exec("BEGIN IMMEDIATE");
    try {
        const plans = previewCanvasHistoryPrune(db, cutoff);
        if (!isDeepStrictEqual(plans, preview)) throw new Error("History changed during backup; rerun maintenance against the new state");
        let removed = 0;
        for (const plan of plans) {
            if (!plan.batchCount) continue;
            const project = reconstructCanvasHistory(db, plan.projectId, plan.throughRevision);
            db.prepare("UPDATE canvas_collaboration_checkpoints SET revision = ?, data_json = ? WHERE project_id = ?").run(plan.throughRevision, JSON.stringify(project), plan.projectId);
            removed += Number(db.prepare("DELETE FROM canvas_operation_batches WHERE project_id = ? AND revision <= ?").run(plan.projectId, plan.throughRevision).changes);
        }
        if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("History pruning failed foreign-key validation");
        db.exec("COMMIT");
        return { plans, removed, backupFile };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
}
