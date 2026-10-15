import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "../drama/production.js";

type Args = { apply: boolean; kind?: "episode" | "canvas"; id?: string; expectedRevision?: number; operationId?: string; sourceFile?: string };
function parseArgs(values: string[]): Args {
    const result: Args = { apply: false };
    for (let i = 0; i < values.length; i++) {
        const arg = values[i];
        if (arg === "--apply") { if (result.apply) throw new Error("重复参数 --apply"); result.apply = true; }
        else if (arg === "--inspect") { if (result.apply) throw new Error("--inspect 与 --apply 不能同时使用"); }
        else if (["--kind", "--id", "--expected-revision", "--operation-id", "--source-file"].includes(arg)) {
            const value = values[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
            if (arg === "--kind") { if (value !== "episode" && value !== "canvas") throw new Error("--kind 只能是 episode 或 canvas"); result.kind = value; }
            if (arg === "--id") result.id = value;
            if (arg === "--expected-revision") { const revision = Number(value); if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("--expected-revision 必须是非负整数"); result.expectedRevision = revision; }
            if (arg === "--operation-id") result.operationId = value;
            if (arg === "--source-file") result.sourceFile = path.resolve(value);
        } else throw new Error(`未知参数: ${arg}`);
    }
    if (result.apply && (!result.kind || !result.id || result.expectedRevision === undefined || !result.operationId)) throw new Error("--apply 需要 --kind、--id、--expected-revision 和 --operation-id");
    if (result.sourceFile && !result.apply) throw new Error("--source-file 只允许与 --apply 一起使用");
    return result;
}

function backupDatabase(file: string): string {
    const target = `${file}.director-source-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    const db = new DatabaseSync(file);
    try { db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); }
    finally { db.close(); }
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error("SQLite 一致性备份未生成，拒绝维护写入");
    return target;
}

function inspectReadOnly(file: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const schemaVersion = Number((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as any)?.version || 0);
        const owners: Array<{ kind: string; id: string; revision: number; format: string; draftFields: string[]; publishedFields: string[]; canvasId?: string | null; segmentAssociations?: Array<{ targetId: string; status: string; matches: Array<{ nodeId: string; segmentId: string }> }> }> = [];
        const canvasRows = db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
        const canvases = new Map(canvasRows.map(row => [row.id, JSON.parse(row.data_json)]));
        for (const [kind, table, key] of [["episode", "episode_productions", "episode_id"], ["canvas", "canvas_productions", "project_id"]]) {
            const rows = (kind === "episode"
                ? db.prepare(`SELECT p.${key} AS id, p.revision, p.draft_json, p.published_json, e.canvas_id AS canvas_id FROM ${table} p LEFT JOIN drama_episodes e ON e.id=p.episode_id`).all()
                : db.prepare(`SELECT ${key} AS id, revision, draft_json, published_json, ${key} AS canvas_id FROM ${table}`).all()) as Array<any>;
            for (const row of rows) {
                const draft = JSON.parse(row.draft_json || "{}");
                if (!draft.director) continue;
                const v2 = draft.director.source?.version === 2 && draft.director.source?.prompt_assembly?.version === 2 && draft.director.source?.ledger?.contract_version === 2;
                const fields = ["scenes", "shots", "clipGroups"].filter(field => Object.hasOwn(draft, field));
                const published = row.published_json ? JSON.parse(row.published_json) : null;
                const publishedFields = published ? ["scenes", "shots", "clipGroups"].filter(field => Object.hasOwn(published, field)) : [];
                const ownerId = String(row.id), canvasId = row.canvas_id ? String(row.canvas_id) : null;
                const nodes = (canvasId && canvases.get(canvasId)?.nodes || []) as Array<Record<string, any>>;
                const segmentAssociations = v2 ? (Array.isArray(draft.director.source.segments) ? draft.director.source.segments : []).map((segment: any) => {
                    const matches = nodes.flatMap(node => {
                        const metadata = node.metadata || {};
                        if (String(metadata.productionOwnerKind || "") !== kind || String(metadata.productionOwnerId || "") !== ownerId) return [];
                        return (Array.isArray(metadata.segments) ? metadata.segments : []).filter((item: any) => String(item.productionClipProjection?.targetId || "") === String(segment.id || ""))
                            .map((item: any) => ({ nodeId: String(node.id || ""), segmentId: String(item.id || "") }));
                    });
                    return { targetId: String(segment.id || ""), status: matches.length === 1 ? "resolved" : matches.length ? "ambiguous" : "missing", matches };
                }) : undefined;
                owners.push({ kind, id: ownerId, revision: Number(row.revision), format: v2 ? fields.length ? "v2_projection_cleanup_candidate" : "v2_single_source" : "legacy_director_requires_prepared_v2_source", draftFields: fields, publishedFields, canvasId, ...(segmentAssociations ? { segmentAssociations } : {}) });
            }
        }
        return { ok: true, dryRun: true, dbPath: file, schemaVersion, owners };
    } finally { db.close(); }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在，拒绝创建空库: ${DB_FILE}`);
    if (!args.apply) { console.log(JSON.stringify(inspectReadOnly(DB_FILE), null, 2)); return; }
    const backup = backupDatabase(DB_FILE);
    const db = new BackendDatabase(DB_FILE);
    try {
        const service = new EpisodeProductionService(db, undefined, undefined, args.kind === "canvas");
        let result: unknown;
        if (args.sourceFile) {
            const source = JSON.parse(fs.readFileSync(args.sourceFile, "utf8")) as Record<string, unknown>;
            result = service.migrateSubjectPromptV2(args.id!, args.expectedRevision!, args.operationId!, source);
        } else result = service.applySingleSourceStorage(args.id!, args.expectedRevision!, args.operationId!);
        console.log(JSON.stringify({ ok: true, dryRun: false, backup, result }, null, 2));
    } finally { db.close(); }
}

try { main(); }
catch (error) { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)); process.exitCode = 1; }
