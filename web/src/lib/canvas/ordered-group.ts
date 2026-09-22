import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type OrderedGroupSlot = string | null;
export type OrderedGroupLayout = {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type OrderedGroupDropArea = OrderedGroupLayout;
export type OrderedGroupResizeBounds = { width: number; height: number; position: { x: number; y: number } };

export function orderedGroupDraggedCenter(initialPosition: { x: number; y: number }, delta: { x: number; y: number }, node: Pick<CanvasNodeData, "width" | "height">) {
    return {
        x: initialPosition.x + delta.x + node.width / 2,
        y: initialPosition.y + delta.y + node.height / 2,
    };
}

const PADDING = { left: 24, right: 24, top: 52, bottom: 24 };
const GAP = 14;
const COLUMNS = 4;

export function orderedGroupColumnCount(group: CanvasNodeData) {
    const configured = Math.round(Number(group.metadata?.orderedGroupColumns));
    return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 12) : COLUMNS;
}

export function orderedGroupSlots(group: CanvasNodeData, nodes: CanvasNodeData[]): string[] {
    const memberIds = nodes.filter((node) => node.metadata?.groupId === group.id && node.id !== group.id).map((node) => node.id);
    const raw = group.metadata?.groupSlots;
    if (!Array.isArray(raw)) return memberIds;
    const known = new Set(memberIds);
    const slots = raw.filter((value): value is string => typeof value === "string" && known.has(value));
    const placed = new Set(slots);
    memberIds.forEach((id) => {
        if (placed.has(id)) return;
        slots.push(id);
        placed.add(id);
    });
    return slots;
}

export function orderedGroupDisplaySlots(slots: OrderedGroupSlot[], columns = COLUMNS): OrderedGroupSlot[] {
    const occupied = slots.filter((value): value is string => typeof value === "string");
    const safeColumns = Math.max(1, Math.round(columns));
    const emptyCount = occupied.length % safeColumns === 0 ? safeColumns : safeColumns - (occupied.length % safeColumns);
    return [...occupied, ...Array.from({ length: emptyCount }, () => null)];
}

export function orderedGroupLayout(group: CanvasNodeData, slotCount: number): OrderedGroupLayout[] {
    const columns = orderedGroupColumnCount(group);
    const rows = Math.ceil(Math.max(slotCount, 1) / columns);
    const width = Math.max(80, (group.width - PADDING.left - PADDING.right - GAP * (columns - 1)) / columns);
    const height = Math.max(80, (group.height - PADDING.top - PADDING.bottom - GAP * (rows - 1)) / rows);
    return Array.from({ length: slotCount }, (_, index) => ({
        index,
        x: PADDING.left + (index % columns) * (width + GAP),
        y: PADDING.top + Math.floor(index / columns) * (height + GAP),
        width,
        height,
    }));
}

export function orderedGroupDropTarget(group: CanvasNodeData, slotCount: number, point: { x: number; y: number }, slotAreas?: OrderedGroupDropArea[]) {
    const layouts = orderedGroupLayout(group, slotCount);
    const columns = orderedGroupColumnCount(group);
    const localX = point.x - group.position.x;
    const localY = point.y - group.position.y;
    const inside =
        slotAreas?.find((area) => point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height) ??
        (!slotAreas ? layouts.find((cell) => localX >= cell.x && localX <= cell.x + cell.width && localY >= cell.y && localY <= cell.y + cell.height) : undefined);
    if (inside) return { kind: "slot" as const, index: inside.index };
    if (localX < PADDING.left || localX > group.width - PADDING.right || localY < PADDING.top || localY > group.height - PADDING.bottom) return null;
    const first = layouts[0];
    if (first && slotCount % columns !== 0) {
        const endCell = {
            x: PADDING.left + (slotCount % columns) * (first.width + GAP),
            y: PADDING.top + Math.floor(slotCount / columns) * (first.height + GAP),
            width: first.width,
            height: first.height,
        };
        if (localX >= endCell.x && localX <= endCell.x + endCell.width && localY >= endCell.y && localY <= endCell.y + endCell.height) return { kind: "gap" as const, index: slotCount };
    }
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    layouts.forEach((cell) => {
        const centerX = cell.x + cell.width / 2;
        const centerY = cell.y + cell.height / 2;
        const next = (localX - centerX) ** 2 + (localY - centerY) ** 2;
        if (next < distance) {
            distance = next;
            nearest = cell.index;
        }
    });
    const target = layouts[nearest];
    if (!target) return { kind: "gap" as const, index: 0 };
    const centerX = target.x + target.width / 2;
    const centerY = target.y + target.height / 2;
    const sameRow = localY >= target.y && localY <= target.y + target.height;
    const before = sameRow ? localX < centerX : localY < centerY;
    return { kind: "gap" as const, index: before ? nearest : nearest + 1 };
}

export function orderedGroupMemberPosition(group: CanvasNodeData, slotIndex: number, node: CanvasNodeData, slotCount: number) {
    const cell = orderedGroupLayout(group, slotCount)[slotIndex];
    if (!cell) return node.position;
    return {
        x: group.position.x + cell.x + (cell.width - node.width) / 2,
        y: group.position.y + cell.y + (cell.height - node.height) / 2,
    };
}

export function orderedGroupMemberSize(_group: CanvasNodeData, _slotIndex: number, node: CanvasNodeData, _slotCount: number) {
    return { width: node.width, height: node.height };
}

export function orderedGroupResizeLayout(group: CanvasNodeData, bounds: OrderedGroupResizeBounds, nodes: CanvasNodeData[]) {
    const resizedGroup = { ...group, ...bounds };
    const slots = orderedGroupSlots(resizedGroup, nodes);
    const displaySlots = orderedGroupDisplaySlots(slots, orderedGroupColumnCount(group));
    const result = new Map<string, OrderedGroupResizeBounds>();
    slots.forEach((nodeId, slotIndex) => {
        if (!nodeId) return;
        const node = nodes.find((item) => item.id === nodeId);
        if (!node) return;
        const cell = orderedGroupLayout(resizedGroup, displaySlots.length)[slotIndex];
        if (!cell) return;
        result.set(nodeId, {
            position: {
                x: resizedGroup.position.x + cell.x + (cell.width - node.width) / 2,
                y: resizedGroup.position.y + cell.y + (cell.height - node.height) / 2,
            },
            width: node.width,
            height: node.height,
        });
    });
    return result;
}

export function arrangeOrderedGroupMembers(group: CanvasNodeData, nodes: CanvasNodeData[]) {
    const slots = orderedGroupSlots(group, nodes).filter((id): id is string => typeof id === "string");
    const members = slots.map((id) => nodes.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node));
    if (!members.length) return { columns: orderedGroupColumnCount(group), position: group.position, width: group.width, height: group.height, members: new Map<string, { x: number; y: number }>() };

    const cellWidth = Math.max(80, Math.max(...members.map((node) => node.width)) + 8);
    const cellHeight = Math.max(80, Math.max(...members.map((node) => node.height)) + 8);
    const targetAspect = Math.max(group.width, 1) / Math.max(group.height, 1);
    const currentColumns = orderedGroupColumnCount(group);
    const currentArea = Math.max(group.width * group.height, 1);
    let best = { columns: 1, score: Number.POSITIVE_INFINITY, width: 0, height: 0 };
    for (let columns = 1; columns <= Math.min(members.length, 12); columns += 1) {
        const displayCount = orderedGroupDisplaySlots(slots, columns).length;
        const rows = Math.ceil(displayCount / columns);
        const width = PADDING.left + PADDING.right + columns * cellWidth + Math.max(0, columns - 1) * GAP;
        const height = PADDING.top + PADDING.bottom + rows * cellHeight + Math.max(0, rows - 1) * GAP;
        const aspectDifference = Math.abs(Math.log((width / height) / targetAspect));
        const columnChange = Math.abs(columns - currentColumns) / Math.max(currentColumns, 1);
        const emptySlots = displayCount - members.length;
        const areaChange = Math.abs(Math.log((width * height) / currentArea));
        const score = aspectDifference * 4 + columnChange * 0.4 + emptySlots * 0.15 + areaChange * 0.2;
        if (score < best.score) best = { columns, score, width, height };
    }

    const center = { x: group.position.x + group.width / 2, y: group.position.y + group.height / 2 };
    const position = { x: center.x - best.width / 2, y: center.y - best.height / 2 };
    const arrangedGroup = { ...group, position, width: best.width, height: best.height, metadata: { ...group.metadata, orderedGroupColumns: best.columns } };
    const layouts = orderedGroupLayout(arrangedGroup, orderedGroupDisplaySlots(slots, best.columns).length);
    const positions = new Map<string, { x: number; y: number }>();
    members.forEach((node, index) => {
        const cell = layouts[index];
        if (!cell) return;
        positions.set(node.id, {
            x: position.x + cell.x + (cell.width - node.width) / 2,
            y: position.y + cell.y + (cell.height - node.height) / 2,
        });
    });
    return { columns: best.columns, position, width: best.width, height: best.height, members: positions };
}

export function insertOrderedGroupSlot(slots: OrderedGroupSlot[], nodeId: string, index: number) {
    const next = slots.filter((value): value is string => typeof value === "string" && value !== nodeId);
    const target = Math.max(0, Math.min(index, next.length));
    next.splice(target, 0, nodeId);
    return next;
}

export function replaceOrderedGroupSlot(slots: string[], nodeId: string, index: number) {
    const next = slots.filter((value) => value !== nodeId);
    const target = Math.max(0, Math.min(index, next.length - 1));
    const displacedId = next[target];
    if (displacedId !== undefined) next[target] = nodeId;
    return { slots: next, displacedId };
}

export function inheritOrderedGroupOutputs(connections: CanvasConnection[], sourceNodeId: string, targetNodeId: string) {
    const seen = new Set<string>();
    return connections.flatMap((connection) => {
        const next = connection.fromNodeId === sourceNodeId ? { ...connection, fromNodeId: targetNodeId } : connection;
        if (next.fromNodeId === next.toNodeId) return [];
        const key = `${next.fromNodeId}\u0000${next.toNodeId}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [next];
    });
}

type OrderedGroupOutputResource = { kind: "image" | "video" | "audio" | "text"; url?: string; storageKey?: string; mimeType?: string };

export function transferOrderedGroupH3References(node: CanvasNodeData, sourceNodeId: string, targetNode: CanvasNodeData, resources: OrderedGroupOutputResource[]) {
    const metadata = node.metadata as (Record<string, unknown> & { segments?: Array<Record<string, unknown>> }) | undefined;
    if (!Array.isArray(metadata?.segments)) return node;
    let changed = false;
    const transfer = (value: unknown, sourceKey: "sourceNodeId" | "nodeId") => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const ref = value as Record<string, unknown>;
        if (ref[sourceKey] !== sourceNodeId) return value;
        const kind = String(ref.mediaType || ref.type || "image") as OrderedGroupOutputResource["kind"];
        const resource = resources.find((item) => item.kind === kind) || resources[0];
        changed = true;
        return {
            ...ref,
            [sourceKey]: targetNode.id,
            label: sourceKey === "sourceNodeId" ? targetNode.title : ref.label,
            name: sourceKey === "nodeId" ? targetNode.title : ref.name,
            ...(resource ? { url: resource.url || "", storageKey: resource.storageKey, mimeType: resource.mimeType } : {}),
        };
    };
    const segments = metadata.segments.map((segment) => {
        const next = { ...segment };
        if (Array.isArray(segment.referenceBindings)) next.referenceBindings = segment.referenceBindings.map((ref) => transfer(ref, "sourceNodeId"));
        if (Array.isArray(segment.refItems)) next.refItems = segment.refItems.map((ref) => transfer(ref, "nodeId"));
        if (segment.refs && typeof segment.refs === "object" && !Array.isArray(segment.refs)) {
            next.refs = Object.fromEntries(Object.entries(segment.refs as Record<string, unknown>).map(([key, refs]) => [key, Array.isArray(refs) ? refs.map((ref) => transfer(ref, "nodeId")) : refs]));
        }
        return next;
    });
    return changed ? { ...node, metadata: { ...node.metadata, segments } as CanvasNodeData["metadata"] } : node;
}

export function swapOrderedGroupSlot(slots: string[], sourceIndex: number, targetIndex: number) {
    const next = [...slots];
    const source = next[sourceIndex];
    const target = next[targetIndex];
    if (source === undefined || target === undefined) return next;
    next[sourceIndex] = target;
    next[targetIndex] = source;
    return next;
}
