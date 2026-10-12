export function keyframeBindingState(assetId: string | undefined, nodeId: string | undefined, storageKey: string | undefined, availableNodeIds: readonly string[]) {
    const registered = Boolean(assetId);
    const selectedNodeId = nodeId && availableNodeIds.includes(nodeId) ? nodeId : undefined;
    return {
        registered,
        hasMedia: Boolean(storageKey),
        selectedNodeId,
        unavailableNode: Boolean(nodeId && !selectedNodeId),
    };
}
