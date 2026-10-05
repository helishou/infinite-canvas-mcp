import crypto from "node:crypto";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";

export type ProductionCanvasContext = {
    role: "ordinary" | "episode" | "scene" | "shared-assets" | "standalone";
    canvasId: string; dramaId?: string; episodeId?: string; sceneId?: string;
    owner?: { kind: "episode" | "scene" | "canvas"; id: string };
    sharedAssetCanvasId?: string | null;
};

export function productionCanvasContext(db: BackendDatabase, canvasId: string): ProductionCanvasContext {
    if (!db.getCanvasProject(canvasId)) throw new Error("画布不存在");
    const episode = db.getDramaEpisodeByCanvasId(canvasId);
    const drama = db.db.prepare("SELECT folder_id, shared_asset_canvas_id FROM drama_projects WHERE folder_id=? OR shared_asset_canvas_id=?")
        .get(episode?.dramaId || "", canvasId) as { folder_id: string; shared_asset_canvas_id: string | null } | undefined;
    if (episode) return { role: "episode", canvasId, episodeId: episode.id, dramaId: episode.dramaId, sharedAssetCanvasId: drama?.shared_asset_canvas_id, owner: { kind: "episode", id: episode.id } };
    // A scene canvas is bound by its own table; it never borrows the episode's fixed canvas.
    const scene = db.db.prepare(`SELECT s.id AS scene_id, s.drama_id AS drama_id, s.episode_id AS episode_id
        FROM drama_scene_canvases c JOIN drama_scene_instances s ON s.id = c.scene_id WHERE c.canvas_id = ?`).get(canvasId) as { scene_id: string; drama_id: string; episode_id: string | null } | undefined;
    if (scene) {
        const owner = db.db.prepare("SELECT shared_asset_canvas_id FROM drama_projects WHERE folder_id=?").get(scene.drama_id) as { shared_asset_canvas_id: string | null } | undefined;
        return { role: "scene", canvasId, sceneId: scene.scene_id, episodeId: scene.episode_id || undefined, dramaId: scene.drama_id,
            sharedAssetCanvasId: owner?.shared_asset_canvas_id ?? null, owner: { kind: "scene", id: scene.scene_id } };
    }
    if (drama) return { role: "shared-assets", canvasId, dramaId: drama.folder_id, sharedAssetCanvasId: canvasId, owner: { kind: "canvas", id: canvasId } };
    const standalone = db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(canvasId);
    return { role: standalone ? "standalone" : "ordinary", canvasId, ...(standalone ? { owner: { kind: "canvas" as const, id: canvasId } } : {}) };
}

/** Preparing a scene canvas never rebinds an existing one and never submits media. */
export function ensureSceneProductionCanvas(db: BackendDatabase, sceneId: string, events?: BackendEventBus) {
    const scene = db.db.prepare("SELECT id, drama_id, episode_id, title, scene_order, status FROM drama_scene_instances WHERE id=?").get(sceneId) as
        { id: string; drama_id: string; episode_id: string | null; title: string; scene_order: number; status: string } | undefined;
    if (!scene) throw new Error("制作场次不存在");
    if (scene.status !== "active") throw new Error("制作场次已从源稿移除，请恢复该场次后再准备画布");
    const drama = db.listCanvasFolders().find(item => item.id === scene.drama_id && item.isDrama);
    if (!drama) throw new Error("剧目不存在");
    const bound = db.db.prepare("SELECT canvas_id FROM drama_scene_canvases WHERE scene_id=?").get(sceneId) as { canvas_id: string } | undefined;
    if (bound) {
        const project = db.getCanvasProject(bound.canvas_id);
        if (!project) throw new Error("场次固定绑定的画布不存在，请恢复原画布");
        return { project, context: productionCanvasContext(db, bound.canvas_id), created: false };
    }
    const canvasId = `production-scene-${crypto.createHash("sha256").update(sceneId).digest("hex").slice(0, 24)}`;
    let project = db.getCanvasProject(canvasId);
    if (project && JSON.stringify(project.productionBindingSeed) !== JSON.stringify({ kind: "scene", id: sceneId })) throw new Error("画布准备身份冲突，拒绝覆盖");
    const created = !project;
    const label = scene.title || `场次 ${scene.scene_order + 1}`;
    if (!project) project = db.createCanvasProject({ id: canvasId, title: `${drama.name} · ${label}`,
        productionBindingSeed: { kind: "scene", id: sceneId }, nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }).project;
    db.db.prepare("INSERT OR IGNORE INTO drama_scene_canvases (scene_id, canvas_id, created_at) VALUES (?, ?, ?)").run(sceneId, canvasId, new Date().toISOString());
    events?.publishCanvasFolder({ entityId: scene.drama_id, payload: { productionCanvasPrepared: canvasId } });
    return { project, context: productionCanvasContext(db, canvasId), created };
}

/** A stable seed makes preparation recoverable without overwriting any project. */
export function ensureProductionCanvas(db: BackendDatabase, kind: "episode" | "shared-assets", id: string, events?: BackendEventBus) {
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
        productionBindingSeed: { kind, id }, nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }).project;
    if (kind === "episode") db.updateDramaEpisode(id, { canvasId });
    else db.db.prepare("UPDATE drama_projects SET shared_asset_canvas_id=?, updated_at=? WHERE folder_id=? AND shared_asset_canvas_id IS NULL")
        .run(canvasId, new Date().toISOString(), dramaId);
    events?.publishCanvasFolder({ entityId: dramaId, payload: { productionCanvasPrepared: canvasId } });
    return { project, context: productionCanvasContext(db, canvasId), created };
}
