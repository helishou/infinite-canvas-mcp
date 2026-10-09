import type { ProductionPresentation, ProductionTarget } from "@/services/backend-api";

export function productionTarget(owner: ProductionPresentation["owner"]): ProductionTarget {
    if (owner.kind === "canvas") return { projectId: owner.id };
    if (owner.kind === "scene") return { sceneId: owner.id };
    return owner.id;
}

export function productionPresentationPath(presentation: ProductionPresentation) {
    const canvasId = presentation.canvasId || (presentation.owner.kind === "canvas" ? presentation.owner.id : "");
    const isCanvasProduction = Boolean(canvasId);
    if (isCanvasProduction) {
        const query = new URLSearchParams();
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
