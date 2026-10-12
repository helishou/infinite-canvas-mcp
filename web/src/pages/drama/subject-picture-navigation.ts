import { imageChoiceKey } from "./smart-image-node-options";

type NodeSource = { projectId?: string; nodeId?: string };

/** Keep navigation scoped to its actual canvas/node, never its title or asset ID. */
export function subjectPictureNavigation(bindings: Array<{ sourceNode?: NodeSource }>, entitySource?: NodeSource, currentCanvas?: { id: string; nodeIds: string[] }) {
    const entityKey = imageChoiceKey(entitySource);
    const seen = new Set<string>();
    const pictures = bindings.map(binding => {
        const key = imageChoiceKey(binding.sourceNode);
        if (!key || seen.has(key)) return undefined;
        if (currentCanvas && binding.sourceNode?.projectId === currentCanvas.id && !currentCanvas.nodeIds.includes(binding.sourceNode!.nodeId!)) return undefined;
        seen.add(key);
        return { sourceNode: binding.sourceNode!, isEntity: key === entityKey };
    });
    return { pictures, entitySource: entityKey && !seen.has(entityKey) ? entitySource : undefined };
}

type EntityTarget = { ownerKind: string; ownerId: string; kind: string; entityId: string };
export function matchesProductionEntityTarget(binding: EntityTarget | undefined, target: EntityTarget) {
    return Boolean(binding && binding.ownerKind === target.ownerKind && binding.ownerId === target.ownerId && binding.kind === target.kind && binding.entityId === target.entityId);
}
