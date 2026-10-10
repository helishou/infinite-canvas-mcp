export type ProductionCanvasNode = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };
export type ProductionCanvasSnapshot = { id: string; revision?: number; summary?: unknown; nodes: ProductionCanvasNode[] };
const EMPTY_NODES: ProductionCanvasNode[] = [];

/** Prefer the existing live projection, without letting an older cache or summary replace a fresh read. */
export function productionCanvasNodes(canvasId: string, live?: ProductionCanvasSnapshot, read?: ProductionCanvasSnapshot) {
    const snapshot = read?.id === canvasId && !read.summary ? read : undefined;
    if (live?.id === canvasId && !live.summary && (!snapshot || Number(live.revision || 0) >= Number(snapshot.revision || 0))) return live.nodes;
    return snapshot?.nodes || EMPTY_NODES;
}
