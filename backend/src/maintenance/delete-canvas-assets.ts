import fs from "node:fs";
import path from "node:path";

import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";
import { attributableAssetsForCanvas } from "../canvas/canvas-asset-attribution.js";

// 破坏性操作：删除指定剧目下「可判定归属、但一直未归属」的画布资产记录。
// 默认 dry-run，只列出对象与影响；--apply 才删除，并把整行（含 data_json / metadata_json）写入同目录快照。
// 媒体文件不删（记录删掉后它们会成为孤儿媒体），因此记录本身可从快照恢复。
// 用法: tsx src/maintenance/delete-canvas-assets.ts --drama=<dramaId> [--apply]
const dramaId = (process.argv.find((arg) => arg.startsWith("--drama=")) || "").slice("--drama=".length);
const apply = process.argv.includes("--apply");
if (!dramaId) {
    console.error("用法: --drama=<dramaId> [--apply]");
    process.exit(2);
}

const db = new BackendDatabase(DB_FILE);
try {
    const episodes = db.db.prepare("SELECT canvas_id AS canvasId FROM drama_episodes WHERE drama_id = ? AND canvas_id IS NOT NULL")
        .all(dramaId) as Array<{ canvasId: string }>;
    const plan = new Map<string, { id: string; kind: string; title: string; storageKey: string; folderId: string | null; canvasId: string }>();
    for (const episode of episodes) {
        for (const asset of attributableAssetsForCanvas(db, episode.canvasId, dramaId)) {
            if (!plan.has(asset.id)) plan.set(asset.id, {
                id: asset.id, kind: asset.kind, title: asset.title,
                storageKey: typeof asset.data?.storageKey === "string" ? asset.data.storageKey : "",
                folderId: asset.folderId ?? null, canvasId: episode.canvasId,
            });
        }
    }

    // 影响面：哪些画布节点把资产 id 直接绑在身上（删掉会变成悬空绑定），哪些画布按 storageKey 引用。
    const impacts: Array<{ id: string; title: string; boundNodeIds: string[]; referencedByCanvases: string[] }> = [];
    const canvases = db.listCanvasProjects().map((project) => ({ id: project.id, nodes: (project.nodes || []) as Array<Record<string, any>> }));
    for (const item of plan.values()) {
        const boundNodeIds: string[] = [];
        const referencedByCanvases: string[] = [];
        for (const canvas of canvases) {
            let referenced = false;
            for (const node of canvas.nodes) {
                const metadata = node.metadata || {};
                if (Object.values(metadata).some((value) => value === item.id)) boundNodeIds.push(`${canvas.id}:${node.id}`);
                if (item.storageKey && JSON.stringify(metadata).includes(item.storageKey)) referenced = true;
            }
            if (referenced) referencedByCanvases.push(canvas.id);
        }
        impacts.push({ id: item.id, title: item.title, boundNodeIds, referencedByCanvases });
    }

    const rows = [...plan.values()].map((item) => ({ ...item, ...impacts.find((impact) => impact.id === item.id)! }));
    const summary = {
        dramaId,
        drama: (db.listCanvasFolders() as Array<{ id: string; name: string }>).find((folder) => folder.id === dramaId)?.name || dramaId,
        episodes: episodes.map((episode) => episode.canvasId),
        total: rows.length,
        boundToCanvasNodes: rows.filter((row) => row.boundNodeIds.length).length,
        referencedByStorageKey: rows.filter((row) => row.referencedByCanvases.length).length,
        byKind: rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.kind]: (counts[row.kind] || 0) + 1 }), {}),
    };

    if (!rows.length || !apply) {
        console.log(JSON.stringify({ ok: true, applied: false, summary, rows }, null, 2));
        process.exit(0);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const receiptFile = path.join(path.dirname(DB_FILE), `deleted-canvas-assets-${dramaId}-${stamp}.json`);
    fs.writeFileSync(receiptFile, JSON.stringify({ dbFile: DB_FILE, summary, records: [...plan.keys()].map((id) => db.getAssetRecord(id)) }, null, 2));

    let deleted = 0;
    for (const id of plan.keys()) if (db.deleteAsset(id)) deleted += 1;
    console.log(JSON.stringify({ ok: true, applied: true, deleted, receiptFile, summary }));
} finally {
    db.close();
}
