import { findContainingGroupId, findGroupDropTarget, keepNodesInLockedGroups, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    orderedGroupColumnCount,
    orderedGroupDisplaySlots,
    orderedGroupMemberPosition,
    orderedGroupMemberSize,
    orderedGroupSlots,
} from "@/lib/canvas/ordered-group";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

/** Build the ordinary node/group membership update; callers persist the returned array in their existing transaction. */
export function buildCanvasNodeDragCommit(
    nodes: CanvasNodeData[],
    movedIds: Set<string>,
    initialPositions: ReadonlyMap<string, Position>,
    previewPositions: ReadonlyMap<string, Position>,
    offset: Position,
): CanvasNodeData[] {
    const moved = nodes.map((node) => {
        const initial = initialPositions.get(node.id);
        const position = initial ? previewPositions.get(node.id) || { x: initial.x + offset.x, y: initial.y + offset.y } : null;
        return position ? { ...node, position } : node;
    });
    const movingGroup = moved.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group);
    const targetGroup = movingGroup ? null : findGroupDropTarget(movedIds, moved);
    // Group dragging only moves its recorded frame and members; never infer membership again from geometry.
    const grouped = movingGroup
        ? moved.map((node) => {
              if (node.type !== CanvasNodeType.Group || !node.metadata?.orderedGroup) return node;
              // Legacy/MCP snapshots may omit ordered slots; the first drag materializes current membership.
              return { ...node, metadata: { ...node.metadata, groupSlots: orderedGroupSlots(node, nodes) } };
          })
        : targetGroup
          ? snapNodesIntoGroup(movedIds, moved, targetGroup)
          : moved.map((node) => {
                if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                const groupId = findContainingGroupId(node, moved);
                if (node.metadata?.groupId === groupId) return node;
                return { ...node, metadata: { ...node.metadata, groupId } };
            });

    const movedOutOfOrderedGroups = new Map<string, Set<string>>();
    nodes.forEach((node) => {
        if (!movedIds.has(node.id) || !node.metadata?.groupId) return;
        const group = nodes.find((item) => item.id === node.metadata?.groupId);
        if (group?.type === CanvasNodeType.Group && group.metadata?.orderedGroup && grouped.find((item) => item.id === node.id)?.metadata?.groupId !== group.id) {
            const ids = movedOutOfOrderedGroups.get(group.id) || new Set<string>();
            ids.add(node.id);
            movedOutOfOrderedGroups.set(group.id, ids);
        }
    });
    const constrained = keepNodesInLockedGroups(movedIds, nodes, grouped);
    const orderedReflows = new Map([...movedOutOfOrderedGroups].flatMap(([groupId, movedOut]) => {
        const group = nodes.find((item) => item.id === groupId);
        if (!group) return [];
        const slots = orderedGroupSlots(group, nodes).filter((id) => typeof id === "string" && !movedOut.has(id));
        return [[groupId, { group, slots, displayCount: orderedGroupDisplaySlots(slots, orderedGroupColumnCount(group)).length }] as const];
    }));

    return constrained.map((node) => {
        const ownReflow = orderedReflows.get(node.id);
        if (ownReflow) return { ...node, metadata: { ...node.metadata, groupSlots: ownReflow.slots } };
        const memberReflow = node.metadata?.groupId ? orderedReflows.get(node.metadata.groupId) : undefined;
        if (!memberReflow) return node;
        const slotIndex = memberReflow.slots.indexOf(node.id);
        if (slotIndex < 0) return node;
        const size = orderedGroupMemberSize(memberReflow.group, slotIndex, node, memberReflow.displayCount);
        return { ...node, position: orderedGroupMemberPosition(memberReflow.group, slotIndex, node, memberReflow.displayCount), width: size.width, height: size.height };
    });
}
