import type { ProductionPresentation, ProductionTarget } from "@/services/backend-api";

export function productionTarget(owner: ProductionPresentation["owner"]): ProductionTarget {
    return owner.kind === "canvas" ? { projectId: owner.id } : owner.id;
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

    const base = presentation.owner.kind === "canvas"
        ? `/director/${encodeURIComponent(presentation.owner.id)}`
        : `/drama/episodes/${encodeURIComponent(presentation.owner.id)}/production`;
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
