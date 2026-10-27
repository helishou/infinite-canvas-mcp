import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE } from "../config.js";

// 共享素材库的资产记录（assets 表，带 metadata.sharedAssetSource）如果其源画布
// （sharedAssetSource.sourceProjectId）或源节点（sourceNodeId）已不存在，则记录悬空。
//
// 运行时时 Backend 的读取入口（listAssets / listAssetsPage）会自动清除「悬空且无存活画布引用」
// 的记录（drama-asset-library.ts 的 purgeOrphanedSharedAssets），本脚本是同样的不变量在
// 后端停止时的离线版本：
//   默认          — dry-run，打印计划；仍被引用的孤儿标记 missing（与 runtime 占位投影一致）。
//   --apply       — 执行标记/解除标记，留改动前快照。
//   --purge       — 额外删除「悬空且无任何 sharedAssetReference/sharedAssetOrigin 引用」的记录行。
// 脚本幂等：可反复运行、可接入定时任务。建议在后端停止时执行，避免与应用写请求交错。
const apply = process.argv.includes("--apply");
const purge = process.argv.includes("--purge");

interface PlanRow {
    id: string;
    kind: string;
    title: string;
    sourceProjectId: string;
    sourceNodeId: string;
    action: "mark_missing" | "clear_missing" | "purge";
    reason?: "source_project_missing" | "source_node_missing";
}

function projectNodes(db: DatabaseSync, projectId: string): Array<{ id: string }> | null {
    const row = db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId) as { data_json?: string } | undefined;
    if (!row?.data_json) return null;
    try {
        const project = JSON.parse(row.data_json) as { nodes?: Array<{ id?: string }> };
        return (project.nodes || []).filter((n): n is { id: string } => Boolean(n && n.id));
    } catch {
        return null;
    }
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });
let candidates: Array<{ id: string; kind: string; title: string; metadata_json: string }>;
try {
    candidates = db.prepare(
        `SELECT id, kind, title, metadata_json FROM assets
         WHERE json_extract(metadata_json, '$.sharedAssetSource.sourceProjectId') IS NOT NULL`,
    ).all() as Array<{ id: string; kind: string; title: string; metadata_json: string }>;
} finally {
    db.close();
}

const plan: PlanRow[] = [];
const stats = { total: candidates.length, markMissing: 0, clearMissing: 0, purge: 0, valid: 0, invalidMeta: 0 };
const reader = new DatabaseSync(DB_FILE, { readOnly: true });
try {
    for (const row of candidates) {
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(row.metadata_json || "{}"); } catch { stats.invalidMeta++; continue; }
        const source = meta.sharedAssetSource as { dramaId?: string; assetId?: string; sourceProjectId?: string; sourceNodeId?: string } | undefined;
        if (!source?.sourceProjectId || !source?.sourceNodeId) { stats.invalidMeta++; continue; }
        const nodes = projectNodes(reader, source.sourceProjectId);
        const projectExists = nodes !== null;
        const nodeExists = projectExists && nodes!.some((n) => n.id === source.sourceNodeId);
        const dangling = !projectExists || !nodeExists;
        const alreadyMissing = meta.sharedAssetMissing === true;
        // 与 runtime 的 assetConsumers 同一口径：sharedAssetReference（assetId+dramaId）或 sharedAssetOrigin（源画布+节点）。
        const consumers = dangling ? Number((reader.prepare(
            `SELECT COUNT(*) AS c FROM canvas_projects p, json_each(p.data_json,'$.nodes') n
             WHERE (json_extract(n.value,'$.metadata.sharedAssetReference.assetId')=? AND json_extract(n.value,'$.metadata.sharedAssetReference.dramaId')=?)
                OR (json_extract(n.value,'$.metadata.sharedAssetOrigin.sourceProjectId')=? AND json_extract(n.value,'$.metadata.sharedAssetOrigin.sourceNodeId')=?)`,
        ).get(source.assetId || "", source.dramaId || "", source.sourceProjectId, source.sourceNodeId) as { c: number }).c) : 0;

        if (dangling && purge && !consumers) {
            plan.push({ id: row.id, kind: row.kind, title: row.title, sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId, action: "purge", reason: projectExists ? "source_node_missing" : "source_project_missing" });
            stats.purge++;
        } else if (dangling && !alreadyMissing) {
            plan.push({ id: row.id, kind: row.kind, title: row.title, sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId, action: "mark_missing", reason: projectExists ? "source_node_missing" : "source_project_missing" });
            stats.markMissing++;
        } else if (!dangling && alreadyMissing) {
            plan.push({ id: row.id, kind: row.kind, title: row.title, sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId, action: "clear_missing" });
            stats.clearMissing++;
        } else {
            stats.valid++;
        }
    }
} finally {
    reader.close();
}

const summary = { ...stats, planned: plan.length };

if (!plan.length || !apply) {
    console.log(JSON.stringify({ ok: true, applied: false, summary, plan }, null, 2));
    process.exit(0);
}

// ---- --apply ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const receiptFile = path.join(path.dirname(DB_FILE), `dangling-shared-assets-${stamp}.json`);
const before = new DatabaseSync(DB_FILE, { readOnly: true });
const snapshot = plan.map((p) => {
    const row = before.prepare("SELECT id, kind, title, metadata_json FROM assets WHERE id = ?").get(p.id) as { id: string; kind: string; title: string; metadata_json: string };
    return { ...p, beforeMetadata: JSON.parse(row.metadata_json || "{}") };
});
before.close();
fs.writeFileSync(receiptFile, JSON.stringify({ dbFile: DB_FILE, summary, snapshot }, null, 2));

const writer = new DatabaseSync(DB_FILE);
let changed = 0;
try {
    writer.exec("BEGIN IMMEDIATE");
    try {
        const update = writer.prepare("UPDATE assets SET metadata_json = ?, updated_at = ? WHERE id = ?");
        for (const p of plan) {
            if (p.action === "purge") { changed += Number(writer.prepare("DELETE FROM assets WHERE id = ?").run(p.id).changes); continue; }
            const row = writer.prepare("SELECT metadata_json FROM assets WHERE id = ?").get(p.id) as { metadata_json: string };
            const meta = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
            if (p.action === "mark_missing") {
                meta.sharedAssetMissing = true;
                meta.sharedAssetMissingReason = p.reason;
            } else {
                meta.sharedAssetMissing = false;
                delete meta.sharedAssetMissingReason;
            }
            changed += Number(update.run(JSON.stringify(meta), new Date().toISOString(), p.id).changes);
        }
        writer.exec("COMMIT");
    } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
    }
} finally {
    writer.close();
}

console.log(JSON.stringify({ ok: true, applied: true, changed, receiptFile, summary }));
