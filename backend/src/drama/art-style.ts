import type { BackendDatabase } from "../db.js";
import { normalizeArtStyle } from "@basketikun/canvas-agent/drama/art-style";

/**
 * 画风解析：真值只有一处 —— `drama_projects.production_plan_json` 的 `topic.artStyle`
 * （选题页 / 新建向导写进去的同一个字段）。
 *
 * 画布 → 剧目只走 `BackendDatabase.getDramaIdByCanvasId`（分集画布 + 共享资产画布两条链路），
 * 不要去读 `canvas_projects` 上的 folderId —— 那张表没有这一列，早期实现按它查会永远拿到空串，
 * 表现就是「画风选了，出图提示词里却什么都没有」。
 */

export type ArtProfile = { artStyle: string; language: string };

const EMPTY: ArtProfile = { artStyle: "", language: "" };

function profileOfFolder(folder: Record<string, unknown> | undefined): ArtProfile {
    const topic = (folder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined;
    return { artStyle: normalizeArtStyle(topic?.artStyle), language: String(topic?.language || "") };
}

export function resolveProjectArtProfile(db: BackendDatabase, projectId?: string): ArtProfile {
    if (!projectId) return EMPTY;
    try {
        const dramaId = db.getDramaIdByCanvasId(projectId);
        if (!dramaId) return EMPTY;
        return profileOfFolder(db.listCanvasFolders(dramaId)[0] as Record<string, unknown> | undefined);
    } catch {
        return EMPTY;
    }
}

export function resolveProjectArtStyle(db: BackendDatabase, projectId?: string): string {
    return resolveProjectArtProfile(db, projectId).artStyle;
}

/** 资产卡片的提示词也要带同一句约束，否则页面看到的口径和真正出图的口径不是一回事。 */
export function resolveDramaArtStyleByDb(db: BackendDatabase, dramaId?: string): ArtProfile {
    if (!dramaId) return EMPTY;
    try {
        return profileOfFolder(db.listCanvasFolders(dramaId)[0] as Record<string, unknown> | undefined);
    } catch {
        return EMPTY;
    }
}
