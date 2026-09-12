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
// 尺寸归一化只作用于承载画面的节点；文本/配置/分组/音频等小节点不参与，避免被拉伸成巨块。
const LAYOUT_MEDIA_TYPES = new Set<string>([CanvasNodeType.Image, CanvasNodeType.Video]);
// 归一化目标带：以选中画面节点高度的【中位数】为锚，收进 [中位数 × 0.7, 中位数 × 1.4]。
// 上沿 / 下沿 = 2，所以缩放后组内必然满足「最大图高度 ≤ 最小图高度 × 2」；
// 用中位数而非极值做锚，是为了不被个别极端节点（超小缩略图 / 超大拼图）带偏整批尺寸。
const LAYOUT_SIZE_BAND_LOW = 0.7;
const LAYOUT_SIZE_BAND_HIGH = 1.4;
// 尺寸差小于该值就认为无需改动，避免无意义的宽高写回（与浮点误差无关，纯粹省一次 patch）。
const LAYOUT_SIZE_EPSILON = 0.5;

export type FlowLayoutEntry = {
    x: number;
    y: number;
    /** 仅当本次整理改动了该节点尺寸（归一化）时才带上，调用方需要一并写回宽高。 */
    width?: number;
    height?: number;
};

/**
 * 画面节点尺寸归一化（等比缩放，保持宽高比；只处理尺寸，不碰位置）。
 * 返回被改动节点的目标尺寸表；已合规或候选不足 2 个时返回空表。
 */
function normalizeMediaSizes(byId: Map<string, CanvasNodeData>, ids: string[]) {
    const changed = new Map<string, { width: number; height: number }>();
    const media: CanvasNodeData[] = [];
    ids.forEach((id) => {
        const node = byId.get(id);
        if (!node || !LAYOUT_MEDIA_TYPES.has(node.type)) return;
        if (!(node.width > 0) || !(node.height > 0)) return;
        media.push(node);
    });
    if (media.length < 2) return changed;
    const heights = media.map((node) => node.height).sort((a, b) => a - b);
    const mid = heights.length % 2 === 1
        ? heights[(heights.length - 1) / 2]
        : (heights[heights.length / 2 - 1] + heights[heights.length / 2]) / 2;
    if (!(mid > 0)) return changed;
    const low = mid * LAYOUT_SIZE_BAND_LOW;
    const high = mid * LAYOUT_SIZE_BAND_HIGH;
    media.forEach((node) => {
        const target = Math.min(Math.max(node.height, low), high);
        if (Math.abs(target - node.height) < LAYOUT_SIZE_EPSILON) return;
        const scale = target / node.height;
        changed.set(node.id, { width: Math.round(node.width * scale), height: Math.round(target) });
    });
    return changed;
}

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
    /** 开启后先做画面节点尺寸归一化（组内最大高度 ≤ 最小高度 × 2），仅「整理布局」入口使用。 */
    normalizeSizes?: boolean;
}): Map<string, FlowLayoutEntry> {
    const { nodes, connections, ids, scopeEdges = false, anchorX, anchorY } = opts;
    const gap = opts.gap ?? AUTO_LAYOUT_GAP;
    const parkSet = new Set(opts.parkAtRight ?? []);
    // 真正参与分层排布的节点：排除被停放（park）的节点。
    const flowIds = ids.filter((id) => !parkSet.has(id));
    const result = new Map<string, FlowLayoutEntry>();
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // 尺寸先定型再排布：否则按旧尺寸算出的行高/列宽会和缩放后的真实尺寸打架，直接导致重叠。
    const resized = opts.normalizeSizes ? normalizeMediaSizes(byId, flowIds) : new Map<string, { width: number; height: number }>();
    const sizeOf = (id: string) => resized.get(id) ?? { width: byId.get(id)?.width ?? 0, height: byId.get(id)?.height ?? 0 };
    const put = (id: string, x: number, y: number) => {
        const size = resized.get(id);
        result.set(id, size ? { x, y, width: size.width, height: size.height } : { x, y });
    };
    // 节点原坐标：作为「没有上游可对齐」时的纵向期望值，保留用户手动摆放的相对次序。
    const originalY = (id: string) => byId.get(id)?.position.y ?? anchorY;

    // 没有任何可排布的非停放节点：仅把停放节点纵向堆叠在 anchor 处。
    if (flowIds.length === 0) {
        let stackedY = anchorY;
        ids.filter((id) => parkSet.has(id)).forEach((id) => {
            const size = sizeOf(id);
            const pos = resolveFreePosition(nodes, { x: anchorX, y: stackedY }, size.width, size.height);
            put(id, pos.x, pos.y);
            stackedY = pos.y + size.height + gap;
        });
        return result;
    }

    const idSet = new Set(flowIds);
    const edges = connections.filter((conn) => idSet.has(conn.toNodeId) && (scopeEdges ? idSet.has(conn.fromNodeId) : byId.has(conn.fromNodeId)));

    const indeg = new Map<string, number>();
    const outAdj = new Map<string, string[]>();
    // 入边只相邻集内的上游：纵向对齐要用它们的实际坐标，集外节点不参与本次排布、坐标不可参考。
    const inAdj = new Map<string, string[]>();
    flowIds.forEach((id) => {
        indeg.set(id, 0);
        outAdj.set(id, []);
        inAdj.set(id, []);
    });
    edges.forEach((conn) => {
        outAdj.get(conn.fromNodeId)?.push(conn.toNodeId);
        indeg.set(conn.toNodeId, (indeg.get(conn.toNodeId) ?? 0) + 1);
        if (idSet.has(conn.fromNodeId)) inAdj.get(conn.toNodeId)?.push(conn.fromNodeId);
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

    const maxLayer = Math.max(...level.values());

    // 计算每列（层）的实际最大宽度：列间距只取决于该列内最宽节点，
    // 不再被选集中某个特别宽的节点（如 H3 导演台）把全局列间距撑大 → 解决「水平距离太远」。
    const colMaxW = new Map<number, number>();
    flowIds.forEach((id) => {
        const layer = level.get(id) ?? 0;
        colMaxW.set(layer, Math.max(colMaxW.get(layer) ?? 0, sizeOf(id).width));
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
            colWidths[col] = Math.max(colWidths[col], sizeOf(id).width);
        });
        const gridColX = new Array(cols).fill(0);
        let gx = anchorX;
        for (let c = 0; c < cols; c++) {
            gridColX[c] = gx;
            gx += colWidths[c] + gap;
        }
        // 行高按该行最高节点算，同行节点顶边对齐（不再用全局行距，缩小后的节点也能贴紧）。
        const rowCount = Math.ceil(flowIds.length / cols);
        const rowHeights = new Array(rowCount).fill(0);
        flowIds.forEach((id, index) => {
            const row = Math.floor(index / cols);
            rowHeights[row] = Math.max(rowHeights[row], sizeOf(id).height);
        });
        const rowY = new Array(rowCount).fill(0);
        let ry = anchorY;
        for (let r = 0; r < rowCount; r++) {
            rowY[r] = ry;
            ry += rowHeights[r] + gap;
        }
        flowIds.forEach((id, index) => {
            put(id, gridColX[index % cols], rowY[Math.floor(index / cols)]);
        });
    } else {
        // 分层：层 0（输入）在最左，层越大越靠右。
        // 纵向不按「层内序号顺排」——那样输入在下方时输出会被拉到顶部，同一条链被拆成两行。
        // 改为跨层共享的「行带（row）」：同一行在所有层共用同一条水平带，带内节点垂直居中。
        // 于是链上相邻节点必然落在同一行 → 输入输出精确同水平线；且行高按该行最高节点算，
        // 不会出现「输入行距 < 输出行距」时逐行累积下漂的问题。
        const rowOf = new Map<string, number>();
        const rowLayers = new Map<number, Set<number>>();
        const rowCountRef = { value: 0 };
        // 取行：优先最近的、本层尚未占用的行（同层共用一行会重叠）；全被本层占了就新开一行。
        const takeRow = (preferred: number, layer: number) => {
            let chosen = -1;
            for (let row = rowCountRef.value - 1; row >= 0; row--) {
                if (rowLayers.get(row)?.has(layer)) continue;
                if (chosen < 0 || Math.abs(row - preferred) < Math.abs(chosen - preferred)) chosen = row;
            }
            if (chosen < 0) chosen = rowCountRef.value++;
            const used = rowLayers.get(chosen) ?? new Set<number>();
            used.add(layer);
            rowLayers.set(chosen, used);
            return chosen;
        };
        // 没有可对齐上游时的行估算：按节点原坐标映射成名义行号，保留用户手动摆放的上下次序。
        const nominalStep = Math.max(1, Math.max(...flowIds.map((id) => sizeOf(id).height)) + gap);
        const nominalRow = (id: string) => Math.max(0, (originalY(id) + sizeOf(id).height / 2 - anchorY) / nominalStep - 0.5);

        const buckets = new Map<number, string[]>();
        flowIds.forEach((id) => {
            const layer = level.get(id) ?? 0;
            const bucket = buckets.get(layer) ?? [];
            bucket.push(id);
            buckets.set(layer, bucket);
        });
        [...buckets.keys()].sort((a, b) => a - b).forEach((layer) => {
            const bucket = buckets.get(layer)!;
            const preferred = new Map<string, number>();
            bucket.forEach((id) => {
                const preds = inAdj.get(id) ?? [];
                if (!preds.length) {
                    preferred.set(id, nominalRow(id));
                    return;
                }
                preferred.set(id, preds.reduce((sum, predId) => sum + (rowOf.get(predId) ?? nominalRow(predId)), 0) / preds.length);
            });
            bucket
                .sort((a, b) => (preferred.get(a) ?? 0) - (preferred.get(b) ?? 0) || originalY(a) - originalY(b))
                .forEach((id) => rowOf.set(id, takeRow(preferred.get(id) ?? 0, layer)));
        });

        // 行高 = 该行最高节点；行顶逐行累加，带内垂直居中。
        const rowHeights: number[] = [];
        flowIds.forEach((id) => {
            const row = rowOf.get(id) ?? 0;
            rowHeights[row] = Math.max(rowHeights[row] ?? 0, sizeOf(id).height);
        });
        const rowTop: number[] = [];
        let rowCursor = anchorY;
        for (let row = 0; row < rowCountRef.value; row++) {
            rowTop[row] = rowCursor;
            rowCursor += (rowHeights[row] ?? 0) + gap;
        }
        flowIds.forEach((id) => {
            const row = rowOf.get(id) ?? 0;
            const size = sizeOf(id);
            const band = rowHeights[row] ?? size.height;
            put(id, colX.get(level.get(id) ?? 0) ?? anchorX, (rowTop[row] ?? anchorY) + (band - size.height) / 2);
        });
    }

    // 停放节点：统一放到排布结果的最右列，纵向堆叠（从 anchorY 起，互不重叠，且避让画布上其它节点）。
    const rightEdge = Math.max(...[...result.entries()].map(([id, pos]) => pos.x + sizeOf(id).width), anchorX) + gap;
    let parkY = anchorY;
    ids.filter((id) => parkSet.has(id)).forEach((id) => {
        const size = sizeOf(id);
        const pos = resolveFreePosition(nodes, { x: rightEdge, y: parkY }, size.width, size.height);
        put(id, pos.x, pos.y);
        parkY = pos.y + size.height + gap;
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
            if (!pos) return node;
            return { ...node, position: { x: pos.x, y: pos.y }, ...(pos.width && pos.height ? { width: pos.width, height: pos.height } : {}) };
        });
    }

    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
