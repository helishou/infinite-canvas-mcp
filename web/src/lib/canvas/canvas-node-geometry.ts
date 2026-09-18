import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle, type Position } from "@/types/canvas";

export function nodeBounds(nodes: CanvasNodeData[]) {
    return nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

type GroupDropCandidates = {
    hasMovedGroup: boolean;
    movingNodes: readonly CanvasNodeData[];
    groups: readonly CanvasNodeData[];
};

export function findGroupDropTarget(movedIds: Set<string>, nodes: CanvasNodeData[], previewPositions?: ReadonlyMap<string, Position>, candidates?: GroupDropCandidates) {
    if (candidates?.hasMovedGroup || (!candidates && nodes.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group))) return null;
    const movingNodes = candidates?.movingNodes || nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return null;
    const groups = candidates?.groups || nodes;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const group = groups[index];
        if (!candidates && (group.type !== CanvasNodeType.Group || movedIds.has(group.id) || group.metadata?.groupLocked)) continue;
        if (movingNodes.some((node) => containsCenter(group, node, previewPositions))) return group;
    }
    return null;
}

export function snapNodesIntoGroup(movedIds: Set<string>, nodes: CanvasNodeData[], group: CanvasNodeData) {
    const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!movingNodes.length) return nodes;
    const pad = 24;
    const bounds = nodeBounds(movingNodes);
    const left = group.position.x + pad;
    const top = group.position.y + pad;
    const right = group.position.x + group.width - pad;
    const bottom = group.position.y + group.height - pad;
    const dx = bounds.right - bounds.left > right - left ? left - bounds.left : bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
    const dy = bounds.bottom - bounds.top > bottom - top ? top - bounds.top : bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;
    return nodes.map((node) => {
        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, metadata: { ...node.metadata, groupId: group.id } };
    });
}

export function findContainingGroupId(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const group = nodes[index];
        if (group.type === CanvasNodeType.Group && group.id !== node.id && containsCenter(group, node)) return group.id;
    }
    return undefined;
}

function containsCenter(group: CanvasNodeData, node: CanvasNodeData, previewPositions?: ReadonlyMap<string, Position>) {
    const position = previewPositions?.get(node.id) || node.position;
    const centerX = position.x + node.width / 2;
    const centerY = position.y + node.height / 2;
    return centerX >= group.position.x && centerX <= group.position.x + group.width && centerY >= group.position.y && centerY <= group.position.y + group.height;
}

/** 在锚点周围按近到远寻找不与现有节点相交的位置，供生成结果节点落点使用。 */
export function findOpenNodePosition(nodes: CanvasNodeData[], anchor: CanvasNodeData, size: { width: number; height: number }, gap = 96, ignoreIds = new Set<string>()) {
    const centerX = anchor.position.x + anchor.width / 2;
    const centerY = anchor.position.y + anchor.height / 2;
    const stepX = anchor.width / 2 + size.width / 2 + gap;
    const stepY = anchor.height / 2 + size.height / 2 + gap;
    const intersects = (position: { x: number; y: number }) => nodes.some((node) => {
        if (ignoreIds.has(node.id)) return false;
        return position.x < node.position.x + node.width + gap / 3
            && position.x + size.width + gap / 3 > node.position.x
            && position.y < node.position.y + node.height + gap / 3
            && position.y + size.height + gap / 3 > node.position.y;
    });
    for (let ring = 1; ring <= 12; ring += 1) {
        const checked = new Set<string>();
        const check = (x: number, y: number) => {
            const key = `${x}:${y}`;
            if (checked.has(key)) return null;
            checked.add(key);
            const position = { x: centerX + x * stepX - size.width / 2, y: centerY + y * stepY - size.height / 2 };
            return intersects(position) ? null : position;
        };
        // 保持生成流从源节点向右展开；右侧被占用后才依次尝试左、下、上和对角区域。
        const preferred: Array<[number, number]> = [[ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [ring, -ring], [-ring, ring], [-ring, -ring]];
        for (const [x, y] of preferred) {
            const position = check(x, y);
            if (position) return position;
        }
        for (let y = -ring; y <= ring; y += 1) {
            for (let x = -ring; x <= ring; x += 1) {
                if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
                const position = check(x, y);
                if (position) return position;
            }
        }
    }
    return { x: anchor.position.x + anchor.width + gap, y: centerY - size.height / 2 };
}

/**
 * 在锚点右侧固定方向展开：结果节点始终落在锚点右边界 + gap 起，沿垂直方向向下、再向上
 * 逐行寻找不相交位置。绝不跳到锚点左侧，专用于图片生成输出节点落点（用户要求固定右侧）。
 */
export function findRightSidePosition(nodes: CanvasNodeData[], anchor: CanvasNodeData, size: { width: number; height: number }, gap = 96, ignoreIds = new Set<string>()) {
    const startX = anchor.position.x + anchor.width + gap;
    const centerY = anchor.position.y + anchor.height / 2;
    const intersects = (position: { x: number; y: number }) =>
        nodes.some((node) => {
            if (ignoreIds.has(node.id)) return false;
            return position.x < node.position.x + node.width + gap / 3
                && position.x + size.width + gap / 3 > node.position.x
                && position.y < node.position.y + node.height + gap / 3
                && position.y + size.height + gap / 3 > node.position.y;
        });
    const rows: number[] = [centerY - size.height / 2];
    for (let r = 1; r <= 60; r += 1) {
        rows.push(centerY + r * (size.height + gap) - size.height / 2);
        rows.push(centerY - r * (size.height + gap) - size.height / 2);
    }
    for (const y of rows) {
        const position = { x: startX, y };
        if (!intersects(position)) return position;
    }
    return { x: startX, y: centerY - size.height / 2 };
}

export function keepNodesInLockedGroups(movedIds: Set<string>, originalNodes: CanvasNodeData[], nextNodes: CanvasNodeData[]) {
    const lockedParents = new Map<string, string>();
    originalNodes.forEach((node) => {
        const groupId = node.metadata?.groupId;
        const group = groupId ? originalNodes.find((candidate) => candidate.id === groupId) : undefined;
        if (groupId && group?.type === CanvasNodeType.Group && group.metadata?.groupLocked) lockedParents.set(node.id, groupId);
    });
    return nextNodes.map((node) => {
        const groupId = lockedParents.get(node.id);
        if (!movedIds.has(node.id) || !groupId) return node;
        const group = nextNodes.find((candidate) => candidate.id === groupId);
        if (!group) return node;
        const pad = 24;
        const left = group.position.x + pad;
        const top = group.position.y + pad;
        const right = Math.max(left, group.position.x + group.width - pad - node.width);
        const bottom = Math.max(top, group.position.y + group.height - pad - node.height);
        return { ...node, position: { x: Math.max(left, Math.min(right, node.position.x)), y: Math.max(top, Math.min(bottom, node.position.y)) }, metadata: { ...node.metadata, groupId } };
    });
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target", nodeById?: ReadonlyMap<string, CanvasNodeData>) {
    const first = nodeById?.get(firstNodeId) || nodes.find((node) => node.id === firstNodeId);
    const second = nodeById?.get(secondNodeId) || nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (second.type === CanvasNodeType.Group) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) {
        // 智能生成节点本身既是配置也是可复用的结果/参考节点，允许智能节点之间串接；
        // 历史普通配置节点仍保持禁止互连，避免把旧的 prompt/config 流误接成配置链。
        const bothSmart = first.metadata?.smart === true && second.metadata?.smart === true;
        if (!bothSmart) return null;
        return firstHandleType === "target" ? { fromNodeId: second.id, toNodeId: first.id } : { fromNodeId: first.id, toNodeId: second.id };
    }
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}
