import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { bindCanvasSpatialItems, buildCanvasSpatialIndex, type CanvasSpatialIndex } from "./canvas-spatial-index";
import { recordCanvasIndexBuild } from "./canvas-index-metrics";

export type CanvasGraphIndex = {
    nodeById: Map<string, CanvasNodeData>;
    incomingByNodeId: Map<string, CanvasNodeData[]>;
    outgoingByNodeId: Map<string, CanvasNodeData[]>;
    connectionsByNodeId: Map<string, CanvasConnection[]>;
    groupChildrenById: Map<string, CanvasNodeData[]>;
    nodeSpatialIndex: CanvasSpatialIndex<CanvasNodeData>;
    connectionSpatialIndex: CanvasSpatialIndex<CanvasConnection>;
};

export function connectionOrder(connection: CanvasConnection) {
    return typeof connection.order === "number" && Number.isFinite(connection.order) ? connection.order : Number.MAX_SAFE_INTEGER;
}

function connectionBounds(connection: CanvasConnection, nodeById: Map<string, CanvasNodeData>) {
    const from = nodeById.get(connection.fromNodeId), to = nodeById.get(connection.toNodeId);
    if (!from || !to) return null;
    const startX = from.position.x + from.width, startY = from.position.y + from.height / 2;
    const endX = to.position.x, endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * .5, 50);
    return { left: Math.min(startX, endX - curvature), top: Math.min(startY, endY), right: Math.max(startX + curvature, endX), bottom: Math.max(startY, endY) };
}

function append(map: Map<string, string[]>, key: string, value: string) {
    const items = map.get(key);
    if (items) items.push(value); else map.set(key, [value]);
}

function resolveIds<T>(ids: Map<string, string[]>, items: Map<string, T>, previous?: Map<string, T[]>) {
    const next = new Map<string, T[]>();
    for (const [id, values] of ids) {
        const resolved = values.map((key) => items.get(key)!);
        const cached = previous?.get(id);
        next.set(id, cached && cached.length === resolved.length && cached.every((item, i) => item === resolved[i]) ? cached : resolved);
    }
    return next;
}

/** One selector per mounted canvas. Never mutate a previously published index. */
export function createCanvasGraphIndexSelector() {
    let previousNodes: CanvasNodeData[] | undefined;
    let previousConnections: CanvasConnection[] | undefined;
    let previous: CanvasGraphIndex | undefined;
    let incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>(), links = new Map<string, string[]>(), groups = new Map<string, string[]>();
    let nodeGeometry: CanvasSpatialIndex<{ id: string }>;
    let connectionGeometry: CanvasSpatialIndex<{ id: string }>;
    return (nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGraphIndex => {
        if (previous && nodes === previousNodes && connections === previousConnections) return previous;
        const idsChanged = !previousNodes || nodes.length !== previousNodes.length || nodes.some((node, i) => node.id !== previousNodes![i].id);
        const geometryChanged = idsChanged || nodes.some((node, i) => {
            const old = previousNodes![i];
            return node.position.x !== old.position.x || node.position.y !== old.position.y || node.width !== old.width || node.height !== old.height;
        });
        const groupsChanged = idsChanged || nodes.some((node, i) => node.metadata?.groupId !== previousNodes![i].metadata?.groupId);
        const endpointsChanged = !previousConnections || connections.length !== previousConnections.length || connections.some((link, i) => {
            const old = previousConnections![i];
            return link.id !== old.id || link.fromNodeId !== old.fromNodeId || link.toNodeId !== old.toNodeId;
        });
        const topologyChanged = idsChanged || endpointsChanged || connections.some((link, i) => connectionOrder(link) !== connectionOrder(previousConnections![i]));
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const connectionById = new Map(connections.map((link) => [link.id, link]));
        if (topologyChanged) {
            recordCanvasIndexBuild("topology");
            incoming = new Map(); outgoing = new Map(); links = new Map();
            const ordered = new Map<string, Array<{ link: CanvasConnection; order: number }>>();
            connections.forEach((link, order) => {
                if (!nodeById.has(link.fromNodeId) || !nodeById.has(link.toNodeId)) return;
                append(links, link.fromNodeId, link.id); append(links, link.toNodeId, link.id);
                append(outgoing, link.fromNodeId, link.toNodeId);
                const list = ordered.get(link.toNodeId) || [];
                list.push({ link, order }); ordered.set(link.toNodeId, list);
            });
            for (const [id, list] of ordered) incoming.set(id, list.sort((a, b) => connectionOrder(a.link) - connectionOrder(b.link) || a.order - b.order).map(({ link }) => link.fromNodeId));
        }
        if (groupsChanged) {
            recordCanvasIndexBuild("groups");
            groups = new Map();
            for (const node of nodes) if (node.metadata?.groupId) append(groups, node.metadata.groupId, node.id);
        }
        if (geometryChanged) {
            recordCanvasIndexBuild("nodes");
            nodeGeometry = buildCanvasSpatialIndex(nodes.map(({ id }) => ({ id })), ({ id }) => {
                const node = nodeById.get(id)!;
                return { left: node.position.x, top: node.position.y, right: node.position.x + node.width, bottom: node.position.y + node.height };
            });
        }
        if (geometryChanged || endpointsChanged) {
            recordCanvasIndexBuild("connections");
            connectionGeometry = buildCanvasSpatialIndex(connections.map(({ id }) => ({ id })), ({ id }) => connectionBounds(connectionById.get(id)!, nodeById));
        }
        const next = {
            nodeById,
            incomingByNodeId: resolveIds(incoming, nodeById, previous?.incomingByNodeId),
            outgoingByNodeId: resolveIds(outgoing, nodeById, previous?.outgoingByNodeId),
            connectionsByNodeId: resolveIds(links, connectionById, previous?.connectionsByNodeId),
            groupChildrenById: resolveIds(groups, nodeById, previous?.groupChildrenById),
            nodeSpatialIndex: bindCanvasSpatialItems(nodeGeometry, nodeById),
            connectionSpatialIndex: bindCanvasSpatialItems(connectionGeometry, connectionById),
        };
        previousNodes = nodes; previousConnections = connections; previous = next;
        return next;
    };
}

export function buildCanvasGraphIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return createCanvasGraphIndexSelector()(nodes, connections);
}
