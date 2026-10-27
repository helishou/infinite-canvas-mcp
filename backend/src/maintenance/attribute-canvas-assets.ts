import fs from "node:fs";
import path from "node:path";

import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";
import { attributableAssetsForCanvas, attributeCanvasAssetsToDrama } from "../canvas/canvas-asset-attribution.js";

// 存量数据修复：画布先入库素材、之后才建剧目并把画布绑成分集时，那些资产的 drama_id 一直是空，
// 资产页就显示「未归属剧目」。判定规则与运行期补齐共用（见 canvas/canvas-asset-attribution.ts），
// 只在证据唯一时归属：被别的剧目画布引用、没有引用信号、已有归属或共享来源的资产一律不动。
//
// 默认 dry-run，只打印将要改写的资产；确认后加 --apply 才写入，并在同目录留改动前快照。
// 建议在 Backend 停止时执行，避免与应用写请求交错。
const apply = process.argv.includes("--apply");

const db = new BackendDatabase(DB_FILE);
try {
    const episodes = db.db.prepare(`SELECT canvas_id AS canvasId, drama_id AS dramaId FROM drama_episodes
        WHERE canvas_id IS NOT NULL ORDER BY drama_id, episode_number`).all() as Array<{ canvasId: string; dramaId: string }>;
    const names = new Map((db.listCanvasFolders() as Array<{ id: string; name: string }>).map(folder => [folder.id, folder.name]));
    // 先算出完整计划再写入：同一资产被同剧目的多个分集画布引用时只归属一次。
    const plan = new Map<string, { dramaId: string; canvasId: string; kind: string; title: string }>();
    for (const episode of episodes) {
        for (const asset of attributableAssetsForCanvas(db, episode.canvasId, episode.dramaId)) {
            if (!plan.has(asset.id)) plan.set(asset.id, { dramaId: episode.dramaId, canvasId: episode.canvasId, kind: asset.kind, title: asset.title });
        }
    }
    const byDrama = new Map<string, number>();
    for (const item of plan.values()) byDrama.set(item.dramaId, (byDrama.get(item.dramaId) ?? 0) + 1);
    const summary = {
        episodes: episodes.length,
        total: plan.size,
        dramas: [...byDrama].map(([dramaId, count]) => ({ dramaId, drama: names.get(dramaId) || dramaId, count })),
    };
    const rows = [...plan].map(([id, item]) => ({ id, ...item, drama: names.get(item.dramaId) || item.dramaId }));

    if (!plan.size || !apply) {
        console.log(JSON.stringify({ ok: true, applied: false, summary, rows }, null, 2));
        process.exit(0);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const receiptFile = path.join(path.dirname(DB_FILE), `canvas-asset-attribution-${stamp}.json`);
    fs.writeFileSync(receiptFile, JSON.stringify({ dbFile: DB_FILE, summary, rows }, null, 2));

    // 归属走正式写入路径（与「归属剧目」按钮同一语义：把资产提升进该剧目的共享资产库），
    // 因此逐次调用，不再包外层事务——写入函数自己管理事务与回执。
    const attributed = new Set<string>();
    for (const episode of episodes) {
        for (const asset of attributeCanvasAssetsToDrama(db, episode.canvasId, episode.dramaId)) attributed.add(asset.id);
    }
    console.log(JSON.stringify({ ok: true, applied: true, changed: attributed.size, receiptFile, summary }));
} finally {
    db.close();
}
