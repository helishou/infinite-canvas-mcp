import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE } from "../config.js";

// 历史数据里存在 drama_id 指向已不存在剧目的资产（写入发生在外键与 upsertAssetRecord 的归属校验生效之前，
// 例如剧目被删时连接未开 foreign_keys）。这类记录在资产页既不算任何剧目、又带着一个死引用，
// 只能落进「未归属剧目」。这里把它们归位为未归属，不删除任何资产、媒体或生成历史。
//
// 默认只打印将要修改的行（dry-run）；确认后加 --apply 才写入，并在同目录留一份改动前快照。
// 建议在 Backend 停止时执行，避免与应用写请求交错。
const apply = process.argv.includes("--apply");

const db = new DatabaseSync(DB_FILE, { readOnly: true });
let rows: Array<{ id: string; kind: string; title: string; drama_id: string }>;
try {
    rows = db.prepare(`SELECT a.id, a.kind, a.title, a.drama_id FROM assets a
        LEFT JOIN drama_projects d ON d.folder_id = a.drama_id
        WHERE a.drama_id IS NOT NULL AND d.folder_id IS NULL
        ORDER BY a.drama_id, a.id`).all() as Array<{ id: string; kind: string; title: string; drama_id: string }>;
} finally {
    db.close();
}

const byDrama = new Map<string, number>();
for (const row of rows) byDrama.set(row.drama_id, (byDrama.get(row.drama_id) ?? 0) + 1);
const summary = { total: rows.length, dramas: [...byDrama].map(([dramaId, count]) => ({ dramaId, count })) };

if (!rows.length || !apply) {
    console.log(JSON.stringify({ ok: true, applied: false, summary, rows }, null, 2));
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const receiptFile = path.join(path.dirname(DB_FILE), `dangling-asset-drama-${stamp}.json`);
fs.writeFileSync(receiptFile, JSON.stringify({ dbFile: DB_FILE, summary, rows }, null, 2));

const writer = new DatabaseSync(DB_FILE);
let changed = 0;
try {
    writer.exec("BEGIN IMMEDIATE");
    try {
        const update = writer.prepare("UPDATE assets SET drama_id = NULL WHERE id = ? AND drama_id = ?");
        for (const row of rows) changed += Number(update.run(row.id, row.drama_id).changes);
        writer.exec("COMMIT");
    } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
    }
} finally {
    writer.close();
}

console.log(JSON.stringify({ ok: true, applied: true, changed, receiptFile, summary }));
