import crypto from "node:crypto";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";

export type ProductionCanvasContext = {
    role: "ordinary" | "episode" | "shared-assets" | "standalone";
    canvasId: string; dramaId?: string; episodeId?: string;
    owner?: { kind: "episode" | "canvas"; id: string };
    sharedAssetCanvasId?: string | null;
};

export function productionCanvasContext(db: BackendDatabase, canvasId: string): ProductionCanvasContext {
    if (!db.getCanvasProject(canvasId)) throw new Error("画布不存在");
    const episode = db.getDramaEpisodeByCanvasId(canvasId);
    const drama = db.db.prepare("SELECT folder_id, shared_asset_canvas_id FROM drama_projects WHERE folder_id=? OR shared_asset_canvas_id=?")
        .get(episode?.dramaId || "", canvasId) as { folder_id: string; shared_asset_canvas_id: string | null } | undefined;
    if (episode) return { role: "episode", canvasId, episodeId: episode.id, dramaId: episode.dramaId, sharedAssetCanvasId: drama?.shared_asset_canvas_id, owner: { kind: "episode", id: episode.id } };
    if (drama) return { role: "shared-assets", canvasId, dramaId: drama.folder_id, sharedAssetCanvasId: canvasId, owner: { kind: "canvas", id: canvasId } };
    const standalone = db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(canvasId);
    return { role: standalone ? "standalone" : "ordinary", canvasId, ...(standalone ? { owner: { kind: "canvas" as const, id: canvasId } } : {}) };
}

/** A stable seed makes preparation recoverable without overwriting any project. */
export function ensureProductionCanvas(db: BackendDatabase, kind: "episode" | "shared-assets", id: string, events?: BackendEventBus, withinTransaction = false) {
    const episode = kind === "episode" ? db.getDramaEpisode(id) : undefined;
    if (kind === "episode" && !episode) throw new Error("分集不存在");
    const dramaId = episode?.dramaId || id;
    const drama = db.listCanvasFolders().find(item => item.id === dramaId && item.isDrama);
    if (!drama) throw new Error("剧目不存在");
    const bound = kind === "episode" ? episode?.canvasId : drama.sharedAssetCanvasId;
    if (bound) {
        const project = db.getCanvasProject(bound);
        if (!project) throw new Error("固定绑定的画布不存在，请恢复原画布");
        return { project, context: productionCanvasContext(db, bound), created: false };
    }
    const canvasId = `production-${kind}-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
    let project = db.getCanvasProject(canvasId);
    if (project && JSON.stringify(project.productionBindingSeed) !== JSON.stringify({ kind, id })) throw new Error("画布准备身份冲突，拒绝覆盖");
    const created = !project;
    if (!project) project = db.createCanvasProject({ id: canvasId, title: kind === "episode" ? `${drama.name} · ${episode!.title || `第 ${episode!.episodeNumber} 集`}` : `${drama.name} · 共享资产`,
        productionBindingSeed: { kind, id }, nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, withinTransaction).project;
    if (kind === "episode") db.updateDramaEpisode(id, { canvasId });
    else db.db.prepare("UPDATE drama_projects SET shared_asset_canvas_id=?, updated_at=? WHERE folder_id=? AND shared_asset_canvas_id IS NULL")
        .run(canvasId, new Date().toISOString(), dramaId);
    events?.publishCanvasFolder({ entityId: dramaId, payload: { productionCanvasPrepared: canvasId } });
    return { project, context: productionCanvasContext(db, canvasId), created };
}
