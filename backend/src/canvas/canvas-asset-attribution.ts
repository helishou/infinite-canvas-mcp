import type { Asset, BackendDatabase } from "../db.js";

// 资产的剧目归属只在写入时确定：画布还没绑定剧目（先做素材、之后才建剧目并把画布绑成分集）时
// 拿不到 dramaId，之后没有任何回填，资产页就会一直显示「未归属剧目」。
// 这里按画布与剧目的既有关系补齐，且只在证据唯一时归属；有冲突或没有信号一律保持未归属，交给用户判断。
const kinds = new Set(["text", "image", "video", "audio", "character", "scene"]);

type EpisodeCanvas = { canvasId: string; dramaId: string; blob: string };

function episodeCanvases(db: BackendDatabase): EpisodeCanvas[] {
    const rows = db.db.prepare(`SELECT e.canvas_id AS canvasId, e.drama_id AS dramaId, p.data_json AS blob
        FROM drama_episodes e JOIN canvas_projects p ON p.id = e.canvas_id
        WHERE e.canvas_id IS NOT NULL`).all() as Array<{ canvasId: string; dramaId: string; blob: string | null }>;
    return rows.map((row) => ({ canvasId: String(row.canvasId), dramaId: String(row.dramaId), blob: String(row.blob || "") }));
}

/**
 * 能唯一判定属于 `canvasId` 所属剧目 `dramaId` 的未归属资产。
 * 判定依据只有两条：① 资产是从该画布入库的（metadata.projectId）；② 资产的 media storageKey 只被该剧目的画布引用。
 * 被其它剧目的画布同时引用时视为真实冲突，不自动改写。
 */
export function attributableAssetsForCanvas(db: BackendDatabase, canvasId: string, dramaId: string): Asset[] {
    const canvases = episodeCanvases(db);
    const owner = canvases.find((canvas) => canvas.canvasId === canvasId);
    if (!owner || owner.dramaId !== dramaId) return [];
    const others = canvases.filter((canvas) => canvas.dramaId !== dramaId);
    return db.listAssetRecords().filter((asset) => {
        if (asset.dramaId || asset.metadata?.sharedAssetSource || !kinds.has(asset.kind)) return false;
        const storageKey = typeof asset.data?.storageKey === "string" ? asset.data.storageKey : "";
        if (storageKey && others.some((canvas) => canvas.blob.includes(storageKey))) return false;
        if (asset.metadata?.projectId === canvasId) return true;
        return Boolean(storageKey) && owner.blob.includes(storageKey);
    });
}

/** 补齐归属，返回本次改写的资产；空数组表示证据不足或已归属。 */
export function attributeCanvasAssetsToDrama(db: BackendDatabase, canvasId: string, dramaId: string): Asset[] {
    const assets = attributableAssetsForCanvas(db, canvasId, dramaId);
    if (!assets.length) return [];
    const updatedAt = new Date().toISOString();
    return assets.map((asset) => db.upsertAsset({ ...asset, dramaId, updatedAt }));
}
