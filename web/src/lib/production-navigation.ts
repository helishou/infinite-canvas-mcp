import type { ProductionPresentation, ProductionTarget } from "@/services/backend-api";

export function productionTarget(owner: ProductionPresentation["owner"]): ProductionTarget {
    if (owner.kind === "canvas") return { projectId: owner.id };
    if (owner.kind === "scene") return { sceneId: owner.id };
    return owner.id;
}

export function productionPresentationPath(presentation: ProductionPresentation, mountedCanvas?: { id: string; path: string }) {
    const canvasId = presentation.canvasId || (presentation.owner.kind === "canvas" ? presentation.owner.id : "");
    // An already mounted canvas receives a focus event; routing through /canvas
    // would tear down its production workbench before the entry redirect returns.
    if (canvasId && mountedCanvas?.id === canvasId) return mountedCanvas.path;
    const isCanvasProduction = Boolean(canvasId);
    if (isCanvasProduction) {
        const query = new URLSearchParams();
        query.set("edit", "1");
        if (presentation.nodeId) query.set("nodeId", presentation.nodeId);
        if (presentation.segmentId) query.set("segmentId", presentation.segmentId);
        query.set("workId", presentation.workId);
        query.set("productionKind", presentation.owner.kind);
        query.set("productionId", presentation.owner.id);
        query.set("workspace", presentation.workspace);
        if (presentation.targetKind && presentation.targetId) query.set("target", `${presentation.targetKind}:${presentation.targetId}`);
        if (presentation.runId) query.set("runId", presentation.runId);
        return `/canvas/${encodeURIComponent(canvasId)}?${query.toString()}`;
    }

    // 制作归属只有画布与分集（Backend ownerKind 仅 canvas | episode）；场景没有独立页面。
    const base = presentation.owner.kind === "canvas"
        ? `/director/${encodeURIComponent(presentation.owner.id)}`
        : presentation.owner.kind === "episode"
            ? `/drama/episodes/${encodeURIComponent(presentation.owner.id)}/production`
            : "/production";
    const query = new URLSearchParams();
    if (presentation.owner.kind === "episode") query.set("from", "dramas");
    query.set("workspace", presentation.workspace);
    if (presentation.targetKind && presentation.targetId) query.set("target", `${presentation.targetKind}:${presentation.targetId}`);
    query.set("workId", presentation.workId);
    if (presentation.runId) query.set("runId", presentation.runId);
    return `${base}?${query.toString()}`;
}

export function productionLocationKey(path: string, search: string) {
    return `${path}${search}`;
}

// 应用内进入制作页的跳转标记：目标页因后端不可达读不到分集时凭它退回点击前所在页，停留在原地；
// 直接打开 URL / F5 没有标记（模块加载即清理），保留原有错误展示。
const PRODUCTION_ENTRY_MARK_KEY = "infinite-canvas.production-entry-mark";
const PRODUCTION_ENTRY_MARK_TTL_MS = 10_000;
try { sessionStorage.removeItem(PRODUCTION_ENTRY_MARK_KEY); } catch { /* 存储不可用时只是回退兜底失效 */ }
export function markProductionEntry() {
    try { sessionStorage.setItem(PRODUCTION_ENTRY_MARK_KEY, String(Date.now())); } catch { /* 同上 */ }
}
export function consumeProductionEntryMark(): boolean {
    try {
        const stamp = Number(sessionStorage.getItem(PRODUCTION_ENTRY_MARK_KEY) || "0");
        if (!stamp || Date.now() - stamp > PRODUCTION_ENTRY_MARK_TTL_MS) return false;
        sessionStorage.removeItem(PRODUCTION_ENTRY_MARK_KEY);
        return true;
    } catch { return false; }
}
