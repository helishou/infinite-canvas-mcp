import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ViewportTransform } from "@/types/canvas";

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string; role?: string; order?: number }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; referenceNodeIds?: string[]; params?: Record<string, unknown>; idempotencyKey?: string; resultPolicy?: "replace-active" | "append" };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
};

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        if (!op?.type) return acc;
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

// 自动排布参数：未显式指定位置的节点按连接关系分层落到画布最右侧（输入在左、输出在右）。
const AUTO_LAYOUT_GAP = 48;
// 判定重叠的容差（像素）：同一轮里多个节点落在极近坐标时视为碰撞并依次右移铺开。
const OVERLAP_PAD = 8;

/** 判断 (x,y,w,h) 是否与已有节点矩形重叠。 */
function isRectFree(nodes: CanvasNodeData[], x: number, y: number, w: number, h: number) {
    return !nodes.some(
        (node) =>
            x < node.position.x + node.width + OVERLAP_PAD &&
            x + w + OVERLAP_PAD > node.position.x &&
            y < node.position.y + node.height + OVERLAP_PAD &&
            y + h + OVERLAP_PAD > node.position.y,
    );
}

/** 从期望坐标出发，向右侧逐个步进取到第一个不重叠的位置（碰撞时铺成一行）。 */
function resolveFreePosition(nodes: CanvasNodeData[], desired: { x: number; y: number }, w: number, h: number) {
    let x = desired.x;
    let y = desired.y;
    let guard = 0;
    while (!isRectFree(nodes, x, y, w, h) && guard < 256) {
        x += w + AUTO_LAYOUT_GAP;
        guard++;
    }
    return { x, y };
}

/**
 * 按连接关系（fromNodeId → toNodeId 表示数据流方向）做拓扑分层排布：
 * 源点（只有出边，输入）在左，汇点（只有入边，输出）在右，同一层纵向堆叠。
 * - ids：需要布局的节点 id 集合。
 * - scopeEdges=true 时只取两端都在 ids 内的边（用于「整理选中」子图）；
 *   否则取所有「目标在 ids 内且源已存在」的边（用于新建批次，使下游节点被推到右侧）。
 * 返回 id → 坐标 的映射，无内部连接时退回网格。
 */
export function computeFlowLayout(opts: {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    ids: string[];
    scopeEdges?: boolean;
    anchorX: number;
    anchorY: number;
    gap?: number;
    /** 这些节点不参与分层排布，统一停到排布结果的最右列（纵向堆叠）。用于把大型节点（如 H3 导演台）排除在流程之外并靠右停放。 */
    parkAtRight?: string[];
}): Map<string, { x: number; y: number }> {
    const { nodes, connections, ids, scopeEdges = false, anchorX, anchorY } = opts;
    const gap = opts.gap ?? AUTO_LAYOUT_GAP;
    const parkSet = new Set(opts.parkAtRight ?? []);
    // 真正参与分层排布的节点：排除被停放（park）的节点。
    const flowIds = ids.filter((id) => !parkSet.has(id));
    const result = new Map<string, { x: number; y: number }>();

    // 没有任何可排布的非停放节点：仅把停放节点纵向堆叠在 anchor 处。
    if (flowIds.length === 0) {
        let stackedY = anchorY;
        ids.filter((id) => parkSet.has(id)).forEach((id) => {
            const node = nodes.find((n) => n.id === id);
            const h = node?.height ?? 0;
            const pos = resolveFreePosition(nodes, { x: anchorX, y: stackedY }, node?.width ?? 0, h);
            result.set(id, pos);
            stackedY = pos.y + h + gap;
        });
        return result;
    }

    const idSet = new Set(flowIds);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = connections.filter((conn) => idSet.has(conn.toNodeId) && (scopeEdges ? idSet.has(conn.fromNodeId) : byId.has(conn.fromNodeId)));

    const indeg = new Map<string, number>();
    const outAdj = new Map<string, string[]>();
    flowIds.forEach((id) => {
        indeg.set(id, 0);
        outAdj.set(id, []);
    });
    edges.forEach((conn) => {
        outAdj.get(conn.fromNodeId)?.push(conn.toNodeId);
        indeg.set(conn.toNodeId, (indeg.get(conn.toNodeId) ?? 0) + 1);
    });

    // 最长路径分层：Kahn 拓扑 + 松弛兜底环。
    const level = new Map<string, number>();
    const queue: string[] = [];
    flowIds.forEach((id) => {
        if ((indeg.get(id) ?? 0) === 0) {
            level.set(id, 0);
            queue.push(id);
        }
    });
    while (queue.length) {
        const u = queue.shift()!;
        for (const v of outAdj.get(u) ?? []) {
            level.set(v, Math.max(level.get(v) ?? 0, (level.get(u) ?? 0) + 1));
            const d = (indeg.get(v) ?? 0) - 1;
            indeg.set(v, d);
            if (d === 0) queue.push(v);
        }
    }
    for (let pass = 0; pass < flowIds.length; pass++) {
        let changed = false;
        for (const conn of edges) {
            const lv = Math.max(level.get(conn.toNodeId) ?? 0, (level.get(conn.fromNodeId) ?? 0) + 1);
            if (lv !== level.get(conn.toNodeId)) {
                level.set(conn.toNodeId, lv);
                changed = true;
            }
        }
        if (!changed) break;
    }
    flowIds.forEach((id) => {
        if (!level.has(id)) level.set(id, 0);
    });

    const maxH = Math.max(...flowIds.map((id) => byId.get(id)?.height ?? 0));
    const rowStride = maxH + gap;
    const maxLayer = Math.max(...level.values());

    // 计算每列（层）的实际最大宽度：列间距只取决于该列内最宽节点，
    // 不再被选集中某个特别宽的节点（如 H3 导演台）把全局列间距撑大 → 解决「水平距离太远」。
    const colMaxW = new Map<number, number>();
    flowIds.forEach((id) => {
        const layer = level.get(id) ?? 0;
        colMaxW.set(layer, Math.max(colMaxW.get(layer) ?? 0, byId.get(id)?.width ?? 0));
    });

    // 逐列累加列左缘：第 0 列从 anchorX 起，之后每列 = 上一列左缘 + 上一列最宽 + gap。
    const colX = new Map<number, number>();
    let xCursor = anchorX;
    [...colMaxW.keys()].sort((a, b) => a - b).forEach((layer) => {
        colX.set(layer, xCursor);
        xCursor += (colMaxW.get(layer) ?? 0) + gap;
    });

    // 没有内部连接（全平铺）→ 退回网格，避免单列拉得太长。
    if (maxLayer === 0) {
        const cols = Math.max(1, Math.ceil(Math.sqrt(flowIds.length)));
        // 网格按列切分：每列宽度取该列节点实际最大宽，列间距贴合内容而非全局最宽。
        const colWidths = new Array(cols).fill(0);
        flowIds.forEach((id, index) => {
            const col = index % cols;
            colWidths[col] = Math.max(colWidths[col], byId.get(id)?.width ?? 0);
        });
        const gridColX = new Array(cols).fill(0);
        let gx = anchorX;
        for (let c = 0; c < cols; c++) {
            gridColX[c] = gx;
            gx += colWidths[c] + gap;
        }
        flowIds.forEach((id, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            result.set(id, { x: gridColX[col], y: anchorY + row * rowStride });
        });
    } else {
        // 分层：层 0（输入）在最左，层越大越靠右；同层纵向堆叠。
        const layerRows = new Map<number, number>();
        [...level.entries()].sort((a, b) => a[1] - b[1] || (byId.get(a[0])?.position.y ?? 0) - (byId.get(b[0])?.position.y ?? 0)).forEach(([id, layer]) => {
            const row = layerRows.get(layer) ?? 0;
            layerRows.set(layer, row + 1);
            result.set(id, { x: colX.get(layer) ?? anchorX, y: anchorY + row * rowStride });
        });
    }

    // 停放节点：统一放到排布结果的最右列，纵向堆叠（从 anchorY 起，互不重叠，且避让画布上其它节点）。
    const rightEdge = Math.max(...[...result.entries()].map(([id, pos]) => pos.x + (byId.get(id)?.width ?? 0)), anchorX) + gap;
    let parkY = anchorY;
    ids.filter((id) => parkSet.has(id)).forEach((id) => {
        const node = byId.get(id);
        const w = node?.width ?? 0;
        const h = node?.height ?? 0;
        const pos = resolveFreePosition(nodes, { x: rightEdge, y: parkY }, w, h);
        result.set(id, pos);
        parkY = pos.y + h + gap;
    });

    return result;
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[]) {
    let nodes = snapshot.nodes;
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;

    // 自动排布的网格起点：画布现有节点的右边界之外，避免压住既有内容。
    const anchorX = nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + AUTO_LAYOUT_GAP : 0;
    // 收集未显式指定坐标的节点，循环结束后按连接关系（输入在左、输出在右）统一分层排布。
    const autoIds: string[] = [];

    (Array.isArray(ops) ? ops : []).forEach((op, index) => {
        if (!op?.type) return;
        if (op.type === "add_node") {
            const nodeType = op.nodeType && isRegisteredNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const width = op.width || spec.width;
            const height = op.height || spec.height;
            const nodeId = op.id || `${nodeType}-${Date.now()}-${index}`;
            // 优先尊重显式坐标（含碰撞时向右铺开）；未给坐标先占位，循环后统一分层。
            let position: { x: number; y: number };
            if (op.position || op.x !== undefined || op.y !== undefined) {
                const desired = { x: op.position?.x ?? op.x ?? 0, y: op.position?.y ?? op.y ?? 0 };
                position = resolveFreePosition(nodes, desired, width, height);
            } else {
                position = { x: anchorX, y: 0 };
                autoIds.push(nodeId);
            }
            const node: CanvasNodeData = {
                id: nodeId,
                type: nodeType,
                title: op.title || spec.title,
                position,
                width,
                height,
                metadata: { ...spec.metadata, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
        }
        if (op.type === "update_node") {
            if (!op.id) return;
            nodes = nodes.map((node) => (node.id === op.id ? { ...node, ...op.patch, metadata: { ...node.metadata, ...op.patch?.metadata, ...op.metadata } } : node));
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
        }
        if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) return;
            const exists = connections.some((conn) =>
                conn.fromNodeId === op.fromNodeId &&
                conn.toNodeId === op.toNodeId &&
                (conn.role || undefined) === (op.role || undefined),
            );
            const hasNodes = nodes.some((node) => node.id === op.fromNodeId) && nodes.some((node) => node.id === op.toNodeId);
            if (!exists && hasNodes) connections = [...connections, { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId, ...(op.role ? { role: op.role } : {}), ...(op.order === undefined ? {} : { order: op.order }) }];
        }
        if (op.type === "set_viewport" && op.viewport) viewport = op.viewport;
        if (op.type === "select_nodes") selectedNodeIds = (op.ids || []).filter((id) => nodes.some((node) => node.id === id));
    });

    // 统一分层排布未指定坐标的节点：按连接关系把输入放左、输出放右。
    if (autoIds.length) {
        const positions = computeFlowLayout({ nodes, connections, ids: autoIds, anchorX, anchorY: 0 });
        nodes = nodes.map((node) => {
            const pos = positions.get(node.id);
            return pos ? { ...node, position: pos } : node;
        });
    }

    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
