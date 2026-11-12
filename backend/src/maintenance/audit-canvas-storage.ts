import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../config.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { readStoredProjectRows } from "../stores/canvas-project-storage.js";

export type CanvasStorageAudit = {
    schemaVersion: number;
    layout: "legacy" | "split";
    projects: number;
    nodeRows: number;
    connectionRows: number;
    dbstat: { available: boolean; error?: string; byObject?: Array<{ name: string; type: string; bytes: number; pages: number }> };
    pages: { pageSize: number; pageCount: number; freelistCount: number; allocatedBytes: number; freeBytes: number };
    fileBytes: number | null;
    walBytes: number | null;
    logicalBytes: { projectHeaders: number; nodes: number; connections: number; history: number };
    issues: Array<{ projectId: string; code: string; detail: string }>;
};

export function auditCanvasStorage(db: DatabaseSync, databaseFile?: string): CanvasStorageAudit {
    db.exec("PRAGMA query_only=ON");
    const versionRow = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: unknown } | undefined;
    const schemaVersion = Number(versionRow?.version ?? 0);
    if (![50, 51, 52, DATABASE_SCHEMA_VERSION].includes(schemaVersion)) throw new Error(`Unsupported canvas storage schema ${schemaVersion}; expected 50, 51, 52 or ${DATABASE_SCHEMA_VERSION}`);
    const columns = new Set((db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>).map(row => row.name));
    const nodeColumns = new Set((db.prepare("PRAGMA table_info(canvas_nodes)").all() as Array<{ name: string }>).map(row => row.name));
    const connectionColumns = new Set((db.prepare("PRAGMA table_info(canvas_connections)").all() as Array<{ name: string }>).map(row => row.name));
    const split = columns.has("nodes_present") && columns.has("connection_count") && nodeColumns.has("node_json") && connectionColumns.has("connection_json");
    if ((schemaVersion === 50 && split) || (schemaVersion >= 51 && !split)) throw new Error(`Schema ${schemaVersion} does not match canvas storage layout`);
    const ids = db.prepare("SELECT id FROM canvas_projects ORDER BY id").all() as Array<{ id: string }>;
    let dbstat: CanvasStorageAudit["dbstat"];
    try { db.prepare("SELECT name FROM dbstat LIMIT 1").all(); dbstat = { available: true }; }
    catch (error) { dbstat = { available: false, error: error instanceof Error ? error.message : String(error) }; }
    const pageSize = Number((db.prepare("PRAGMA page_size").get() as any).page_size);
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as any).page_count);
    const freelistCount = Number((db.prepare("PRAGMA freelist_count").get() as any).freelist_count);
    const logicalBytes = { projectHeaders: 0, nodes: 0, connections: 0, history: 0 };
    const report: CanvasStorageAudit = { schemaVersion, layout: split ? "split" : "legacy", projects: ids.length, nodeRows: 0, connectionRows: 0, dbstat,
        pages: { pageSize, pageCount, freelistCount, allocatedBytes: pageSize * pageCount, freeBytes: pageSize * freelistCount }, fileBytes: null, walBytes: null, logicalBytes, issues: [] };
    if (split) for (const row of db.prepare("SELECT COALESCE(SUM(length(CAST(data_json AS BLOB))),0) AS n FROM canvas_projects").all() as Array<{ n: number }>) logicalBytes.projectHeaders += Number(row.n || 0);
    if (split) {
        logicalBytes.nodes = Number((db.prepare("SELECT COALESCE(SUM(length(CAST(node_json AS BLOB))),0) AS n FROM canvas_nodes").get() as any).n);
        logicalBytes.connections = Number((db.prepare("SELECT COALESCE(SUM(length(CAST(connection_json AS BLOB))),0) AS n FROM canvas_connections").get() as any).n);
    }
    for (const table of ["canvas_operation_batches", "canvas_command_receipts", "canvas_collaboration_checkpoints"]) {
        if ((db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
            const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name).filter(n => /json$/.test(n));
            for (const col of cols) logicalBytes.history += Number((db.prepare(`SELECT COALESCE(SUM(length(CAST("${col}" AS BLOB))),0) AS n FROM "${table}"`).get() as any).n || 0);
        }
    }
    if (dbstat.available) {
        const kinds = new Map((db.prepare("SELECT name, type FROM sqlite_master").all() as Array<{ name: string; type: string }>).map(row => [row.name, row.type]));
        report.dbstat.byObject = (db.prepare("SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC").all() as Array<{ name: string; bytes: number; pages: number }>).map(row => ({ ...row, type: kinds.get(row.name) ?? "internal" }));
    }
    if (databaseFile) {
        try { report.fileBytes = fs.statSync(databaseFile).size; } catch {}
        try { report.walBytes = fs.statSync(databaseFile + "-wal").size; } catch {}
    }
    for (const { id } of ids) {
        try {
            let project: { nodeIds: unknown[]; nodeCount: number; connectionCount: number; nodeRows: Array<{ ordinal: number }>; connectionRows: Array<{ ordinal: number }> };
            if (split) {
                const stored = readStoredProjectRows(db, id);
                if (!stored) continue;
                project = { nodeIds: stored.nodeRows.map(row => row.nodeId), nodeCount: stored.nodeCount, connectionCount: stored.connectionCount, nodeRows: stored.nodeRows, connectionRows: stored.connectionRows };
            } else {
                // Offline-only parser for schema 50. The online store intentionally has no legacy-layout fallback.
                const row = db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(id) as { data_json: string } | undefined;
                if (!row) continue;
                const value: unknown = JSON.parse(row.data_json);
                if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).id !== id) throw new Error("legacy project header is invalid");
                const legacy = value as Record<string, unknown>;
                const nodes = legacy.nodes === undefined ? [] : legacy.nodes;
                const connections = legacy.connections === undefined ? [] : legacy.connections;
                if (!Array.isArray(nodes) || !Array.isArray(connections)) throw new Error("legacy project rows are invalid");
                const header = { ...legacy }; delete header.nodes; delete header.connections;
                const nodeRows = nodes.map((node, ordinal) => ({ ordinal, nodeId: node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>).id : undefined }));
                const connectionRows = connections.map((_, ordinal) => ({ ordinal }));
                logicalBytes.projectHeaders += Buffer.byteLength(JSON.stringify(header));
                logicalBytes.nodes += nodes.reduce((sum, node) => sum + Buffer.byteLength(JSON.stringify(node)), 0);
                logicalBytes.connections += connections.reduce((sum, connection) => sum + Buffer.byteLength(JSON.stringify(connection)), 0);
                project = { nodeIds: nodeRows.map(row => row.nodeId), nodeCount: nodes.length, connectionCount: connections.length, nodeRows, connectionRows };
            }
            report.nodeRows += project.nodeRows.length;
            report.connectionRows += project.connectionRows.length;
            if (project.nodeCount !== project.nodeRows.length) report.issues.push({ projectId: id, code: "NODE_COUNT_MISMATCH", detail: `${project.nodeCount} != ${project.nodeRows.length}` });
            if (project.connectionCount !== project.connectionRows.length) report.issues.push({ projectId: id, code: "CONNECTION_COUNT_MISMATCH", detail: `${project.connectionCount} != ${project.connectionRows.length}` });
            if (new Set(project.nodeIds).size !== project.nodeRows.length) report.issues.push({ projectId: id, code: "DUPLICATE_NODE_ID", detail: "node IDs are not unique" });
            if (project.nodeRows.some((row, ordinal) => row.ordinal !== ordinal)) report.issues.push({ projectId: id, code: "NODE_ORDINAL_GAP", detail: "node ordinals are not contiguous" });
            if (project.connectionRows.some((row, ordinal) => row.ordinal !== ordinal)) report.issues.push({ projectId: id, code: "CONNECTION_ORDINAL_GAP", detail: "connection ordinals are not contiguous" });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const safe = /Unexpected end|Expected property name|Expected property|Bad control character|Unterminated string/i.test(message) ? "project JSON is invalid" : "project rows could not be read";
            report.issues.push({ projectId: id, code: "PROJECT_READ_FAILED", detail: safe });
        }
    }
    return report;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
    if (!fs.existsSync(DB_FILE)) throw new Error(`Database does not exist: ${DB_FILE}`);
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try { console.log(JSON.stringify(auditCanvasStorage(db, DB_FILE), null, 2)); } finally { db.close(); }
}
