import {
    insertOrderedGroupSlot,
    moveOrderedGroupSlot,
    orderedGroupColumnCount,
    orderedGroupDisplaySlots,
    orderedGroupDropTarget,
    orderedGroupMemberPosition,
    orderedGroupMemberSize,
    orderedGroupSlots,
    replaceOrderedGroupSlot,
    swapOrderedGroupSlot,
} from "@/lib/canvas/ordered-group";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasOrderedGroupDrop = NonNullable<ReturnType<typeof orderedGroupDropTarget>>;

export type CanvasOrderedGroupDragCommit = {
    nodes: CanvasNodeData[];
    inheritedOutputSourceId?: string;
};

/** Purely calculate an ordered-group drop; callers own node and connection persistence. */
export function buildOrderedGroupDragCommit(
    previous: CanvasNodeData[],
    dragged: CanvasNodeData,
    targetGroupId: string,
    drop: CanvasOrderedGroupDrop,
): CanvasOrderedGroupDragCommit {
    const sourceGroup = previous.find((item) => item.type === CanvasNodeType.Group && item.metadata?.orderedGroup && orderedGroupSlots(item, previous).includes(dragged.id));
    const target = previous.find((item) => item.id === targetGroupId);
    if (!target) return { nodes: previous };
    const sourceSlots = sourceGroup ? orderedGroupSlots(sourceGroup, previous) : null;
    const targetSlots = orderedGroupSlots(target, previous);
    const sourceIndex = sourceSlots?.indexOf(dragged.id) ?? -1;
    const targetIndex = Math.max(0, Math.min(drop.index, targetSlots.length));
    let nextTargetSlots = [...targetSlots];
    let nextSourceSlots = sourceSlots ? [...sourceSlots] : null;
    let displacedId: string | undefined;
    let inheritedOutputSourceId: string | undefined;

    if (sourceGroup?.id === target.id && sourceIndex >= 0) {
        if (drop.kind === "slot" && nextTargetSlots[targetIndex] && nextTargetSlots[targetIndex] !== dragged.id) {
            nextTargetSlots = swapOrderedGroupSlot(nextTargetSlots, sourceIndex, targetIndex);
        } else {
            nextTargetSlots = moveOrderedGroupSlot(nextTargetSlots, sourceIndex, targetIndex);
        }
    } else if (drop.kind === "slot" && targetIndex < nextTargetSlots.length) {
        const replacement = replaceOrderedGroupSlot(nextTargetSlots, dragged.id, targetIndex);
        nextTargetSlots = replacement.slots;
        displacedId = replacement.displacedId;
        inheritedOutputSourceId = displacedId;
        if (nextSourceSlots && sourceIndex >= 0 && displacedId) nextSourceSlots[sourceIndex] = displacedId;
    } else {
        if (nextSourceSlots && sourceIndex >= 0) nextSourceSlots = nextSourceSlots.filter((id) => id !== dragged.id);
        nextTargetSlots = insertOrderedGroupSlot(nextTargetSlots, dragged.id, targetIndex);
    }

    const targetSlotIndex = nextTargetSlots.indexOf(dragged.id);
    const sourceSlotMap = new Map((nextSourceSlots || []).map((id, index) => [id, index]));
    const targetSlotMap = new Map(nextTargetSlots.map((id, index) => [id, index]));
    const targetDisplayCount = orderedGroupDisplaySlots(nextTargetSlots, orderedGroupColumnCount(target)).length;
    const sourceDisplayCount = orderedGroupDisplaySlots(nextSourceSlots || [], sourceGroup ? orderedGroupColumnCount(sourceGroup) : 4).length;
    const nodes = previous.map((item) => {
        if (item.id === target.id) return { ...item, metadata: { ...item.metadata, orderedGroup: true, groupSlots: nextTargetSlots } };
        if (sourceGroup && item.id === sourceGroup.id && sourceGroup.id !== target.id) return { ...item, metadata: { ...item.metadata, groupSlots: nextSourceSlots || [] } };
        if (item.id === dragged.id) {
            const size = orderedGroupMemberSize(target, targetSlotIndex, item, targetDisplayCount);
            return { ...item, metadata: { ...item.metadata, groupId: target.id }, position: orderedGroupMemberPosition(target, targetSlotIndex, item, targetDisplayCount), width: size.width, height: size.height };
        }
        if (item.id === displacedId && !sourceGroup) {
            const { groupId: _groupId, ...metadata } = item.metadata || {};
            return { ...item, metadata, position: dragged.position };
        }
        const targetSlot = targetSlotMap.get(item.id);
        if (targetSlot !== undefined) {
            const size = orderedGroupMemberSize(target, targetSlot, item, targetDisplayCount);
            return { ...item, metadata: { ...item.metadata, groupId: target.id }, position: orderedGroupMemberPosition(target, targetSlot, item, targetDisplayCount), width: size.width, height: size.height };
        }
        const sourceSlot = sourceSlotMap.get(item.id);
        if (sourceGroup && sourceGroup.id !== target.id && sourceSlot !== undefined) {
            const size = orderedGroupMemberSize(sourceGroup, sourceSlot, item, sourceDisplayCount);
            return { ...item, metadata: { ...item.metadata, groupId: sourceGroup.id }, position: orderedGroupMemberPosition(sourceGroup, sourceSlot, item, sourceDisplayCount), width: size.width, height: size.height };
        }
        return item;
    });
    return { nodes, inheritedOutputSourceId };
}
