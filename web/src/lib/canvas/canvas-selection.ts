export type CanvasSelectionRect = { left: number; top: number; right: number; bottom: number };
export type CanvasSelectionOverlayBounds = { left: number; top: number; width: number; height: number };

export function canvasSelectionWorldBounds(startX: number, startY: number, currentX: number, currentY: number): CanvasSelectionRect {
    return {
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        right: Math.max(startX, currentX),
        bottom: Math.max(startY, currentY),
    };
}

export function canvasSelectionOverlayBounds(startX: number, startY: number, currentX: number, currentY: number): CanvasSelectionOverlayBounds {
    return {
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY),
    };
}

export function collectCanvasSelectionIds(
    candidateIds: Iterable<string>,
    initialSelectedNodeIds: Iterable<string>,
    additive: boolean,
    excludeNodeIds: Iterable<string> = [],
) {
    const selectedIds = new Set<string>(additive ? initialSelectedNodeIds : []);
    const excludedIds = new Set(excludeNodeIds);
    for (const id of candidateIds) {
        if (!excludedIds.has(id)) selectedIds.add(id);
    }
    return selectedIds;
}
