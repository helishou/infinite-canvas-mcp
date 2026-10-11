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
