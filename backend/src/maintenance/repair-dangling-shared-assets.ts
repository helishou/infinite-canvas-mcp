import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE } from "../config.js";

// 共享素材库的资产记录（assets 表，带 metadata.sharedAssetSource）如果其源画布
// （sharedAssetSource.sourceProjectId）或源节点（sourceNodeId）已不存在，则记录悬空：
// 业务数据仍保留，但已不能作为有效素材使用。
//
// 这里把它们持久标记为 sharedAssetMissing，与 drama-asset-library.ts 里
// missingSharedSourceAsset 的产出保持一致，web 资产库会据此显示「源已失效」警告并
// 将它们排除为有效素材。记录本身不删除（删除保护）。
//
// 脚本幂等：悬空 → 标记；曾标记但源已恢复 → 解除标记。可反复运行、可接入定时任务。
// 默认只打印将要修改的行（dry-run）；确认后加 --apply 才写入，并在同目录留一份改动前快照。
// 建议在 Backend 停止时执行，避免与应用写请求交错。
const apply = process.argv.includes("--apply");

interface PlanRow {
    id: string;
    kind: string;
    title: string;
    sourceProjectId: string;
    sourceNodeId: string;
    action: "mark_missing" | "clear_missing";
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
const stats = { total: candidates.length, markMissing: 0, clearMissing: 0, valid: 0, invalidMeta: 0 };

for (const row of candidates) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata_json || "{}"); } catch { stats.invalidMeta++; continue; }
    const source = meta.sharedAssetSource as { sourceProjectId?: string; sourceNodeId?: string } | undefined;
    if (!source?.sourceProjectId || !source?.sourceNodeId) { stats.invalidMeta++; continue; }
    const nodes = projectNodes(new DatabaseSync(DB_FILE, { readOnly: true }), source.sourceProjectId);
    const projectExists = nodes !== null;
    const nodeExists = projectExists && nodes!.some((n) => n.id === source.sourceNodeId);
    const dangling = !projectExists || !nodeExists;
    const alreadyMissing = meta.sharedAssetMissing === true;

    if (dangling && !alreadyMissing) {
        plan.push({ id: row.id, kind: row.kind, title: row.title, sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId, action: "mark_missing", reason: projectExists ? "source_node_missing" : "source_project_missing" });
        stats.markMissing++;
    } else if (!dangling && alreadyMissing) {
        plan.push({ id: row.id, kind: row.kind, title: row.title, sourceProjectId: source.sourceProjectId, sourceNodeId: source.sourceNodeId, action: "clear_missing" });
        stats.clearMissing++;
    } else {
        stats.valid++;
    }
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
