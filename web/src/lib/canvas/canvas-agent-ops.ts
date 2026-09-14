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
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; referenceNodeIds?: string[]; params?: Record<string, unknown>; idempotencyKey?: string; resultPolicy?: "replace-active" | "append" };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport?: ViewportTransform;
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

// 连通分量：把 ids 按无向连线聚成若干块；块内节点彼此相连、块间不相连。
function computeConnectedComponents(ids: string[], edges: CanvasConnection[]): string[][] {
    const adj = new Map<string, string[]>();
    ids.forEach((id) => adj.set(id, []));
    edges.forEach((conn) => {
        if (adj.has(conn.fromNodeId)) adj.get(conn.fromNodeId)!.push(conn.toNodeId);
        if (adj.has(conn.toNodeId)) adj.get(conn.toNodeId)!.push(conn.fromNodeId);
    });
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const start of ids) {
        if (visited.has(start)) continue;
        const comp: string[] = [];
        const stack = [start];
        visited.add(start);
        while (stack.length) {
            const u = stack.pop()!;
            comp.push(u);
            for (const v of adj.get(u) ?? []) if (!visited.has(v)) { visited.add(v); stack.push(v); }
        }
        components.push(comp);
    }
    return components;
}

// 块内最小（最靠上、其次最靠左）原坐标，作为块在整图中的排序键，尽量保留用户原本的上下布局。
function componentTopKey(ids: string[], byId: Map<string, CanvasNodeData>): number {
    let best = Infinity;
    ids.forEach((id) => {
        const p = byId.get(id)?.position;
        if (!p) return;
        const key = p.y * 1e7 + p.x;
        if (key < best) best = key;
    });
    return best;
}

/**
 * 对单个连通块做力导向紧凑排布，返回【局部坐标】（原点 0,0）下各节点位置与块高度。
 *
 * 设计目标（用户诉求）：
 * 1. 相连节点在水平与垂直方向都彼此靠近 —— 线性弹簧把相连节点拉到目标距 L≈(gap+平均高)，
 *    再用「网格对齐偏置」把每条边压向较短轴，使边趋于水平/垂直、形成正交紧凑排布。
 * 2. 节点绝不重叠 —— 力导向收尾后跑「最小穿透轴硬分离」，迭代到零重叠（构造性保证）。
 * 3. 仍保留可读性：拓扑层仅作种子（源在左、汇在右），并对每条边施加「流向偏置」维持数据流方向。
 */
function layoutComponentLocal(ctx: {
    sizeOf: (id: string) => { width: number; height: number };
    resized: Map<string, { width: number; height: number }>;
    gap: number;
}, comp: string[], compEdges: CanvasConnection[]): { positions: Map<string, FlowLayoutEntry>; height: number } {
    const { sizeOf, resized, gap } = ctx;
    const positions = new Map<string, FlowLayoutEntry>();
    const put = (id: string, x: number, y: number) => {
        const size = resized.get(id);
        positions.set(id, size ? { x, y, width: size.width, height: size.height } : { x, y });
    };
    const n = comp.length;
    const size2 = (id: string) => { const s = sizeOf(id); return { w: s.width, h: s.height }; };
    const heightOf = (id: string) => size2(id).h;
    const widthOf = (id: string) => size2(id).w;

    // 单点：直接落位。
    if (n <= 1) {
        if (n === 1) put(comp[0], 0, 0);
        return { positions, height: n === 1 ? heightOf(comp[0]) : 0 };
    }

    const avgH = comp.reduce((s, id) => s + heightOf(id), 0) / n;
    const avgW = comp.reduce((s, id) => s + widthOf(id), 0) / n;
    // 相连节点的目标中心距：≈一个节点高 + 间距 → 相连即「近」，且天然不重叠。
    const L = gap + Math.max(avgH, avgW * 0.6);
    const k = L; // FR 理想距离

    // 拓扑层（最长路径）仅用于稳定种子：源在左、汇在右；同层内按序铺开避免初始重叠。
    const indeg = new Map<string, number>();
    const outAdj = new Map<string, string[]>();
    comp.forEach((id) => { indeg.set(id, 0); outAdj.set(id, []); });
    compEdges.forEach((conn) => {
        outAdj.get(conn.fromNodeId)?.push(conn.toNodeId);
        indeg.set(conn.toNodeId, (indeg.get(conn.toNodeId) ?? 0) + 1);
    });
    const level = new Map<string, number>();
    const queue: string[] = [];
    comp.forEach((id) => { if ((indeg.get(id) ?? 0) === 0) { level.set(id, 0); queue.push(id); } });
    while (queue.length) {
        const u = queue.shift()!;
        for (const v of outAdj.get(u) ?? []) {
            level.set(v, Math.max(level.get(v) ?? 0, (level.get(u) ?? 0) + 1));
            const d = (indeg.get(v) ?? 0) - 1;
            indeg.set(v, d);
            if (d === 0) queue.push(v);
        }
    }
    for (let pass = 0; pass < n; pass++) {
        let changed = false;
        for (const conn of compEdges) {
            const lv = Math.max(level.get(conn.toNodeId) ?? 0, (level.get(conn.fromNodeId) ?? 0) + 1);
            if (lv !== level.get(conn.toNodeId)) { level.set(conn.toNodeId, lv); changed = true; }
        }
        if (!changed) break;
    }
    comp.forEach((id) => { if (!level.has(id)) level.set(id, 0); });

    // 种子：x 按层（源左汇右），同层内按序纵向铺开 → 初始已大致不重叠。
    const byLevel = new Map<number, string[]>();
    comp.forEach((id) => {
        const lv = level.get(id) ?? 0;
        if (!byLevel.has(lv)) byLevel.set(lv, []);
        byLevel.get(lv)!.push(id);
    });
    const maxLevel = Math.max(...level.values());
    const pos = new Map<string, { x: number; y: number }>();
    byLevel.forEach((ids, lv) => {
        ids.forEach((id, i) => pos.set(id, { x: maxLevel === 0 ? 0 : lv * (avgW + gap), y: i * (avgH + gap) }));
    });

    // 力导向（稳定模型）：斥力 k²/d + 线性弹簧 1.5·(d−k)（Hooke，d>k 吸、d<k 推，平衡不塌缩）
    // + 强「同 y 偏置」把相连节点垂直压到同一水平线（链必然水平）+ 流向偏置（源左汇右）。
    let temp = k * 0.6;
    const initialTemp = temp;
    const ITER = 600;
    for (let it = 0; it < ITER; it++) {
        const disp = new Map<string, { x: number; y: number }>();
        comp.forEach((id) => disp.set(id, { x: 0, y: 0 }));
        // 全局斥力：所有节点对互斥，防塌缩/重叠。
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = comp[i], b = comp[j];
                const pa = pos.get(a)!, pb = pos.get(b)!;
                let dx = pa.x - pb.x, dy = pa.y - pb.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 1e-6) { dx = 0.01; dy = 0; d2 = 1e-4; }
                const d = Math.sqrt(d2);
                const f = (k * k) / d;
                const fx = (f * dx) / d, fy = (f * dy) / d;
                const da = disp.get(a)!, db = disp.get(b)!;
                da.x += fx; da.y += fy; db.x -= fx; db.y -= fy;
            }
        }
        // 边：线性弹簧 + 同 y 偏置 + 流向偏置。
        for (const conn of compEdges) {
            const u = conn.fromNodeId, v = conn.toNodeId;
            const pu = pos.get(u)!, pv = pos.get(v)!;
            const dx = pu.x - pv.x, dy = pu.y - pv.y;
            const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
            const f = 1.5 * (d - k); // 线性弹簧：稳定平衡，不会把链端吸塌
            const fx = (f * dx) / d, fy = (f * dy) / d;
            const du = disp.get(u)!, dv = disp.get(v)!;
            du.x -= fx; du.y -= fy; dv.x += fx; dv.y += fy;
            // 网格对齐偏置：把每条边压向它的较短轴（|dy|<=|dx| → 对齐 y，否则对齐 x），
            // 使相连节点在「水平或垂直」其一上严格对齐、另一方向贴近 → 形成正交紧凑排布（如菱形 2×2）。
            if (Math.abs(dy) <= Math.abs(dx)) {
                du.y += dy * 0.5; dv.y -= dy * 0.5;
            } else {
                du.x += dx * 0.5; dv.x -= dx * 0.5;
            }
            // 流向偏置：源在左、汇在右，维持数据流可读性。
            if (pu.x > pv.x) { du.x -= 0.8; dv.x += 0.8; }
        }
        comp.forEach((id) => {
            const p = pos.get(id)!, dvec = disp.get(id)!;
            const len = Math.sqrt(dvec.x * dvec.x + dvec.y * dvec.y) + 0.01;
            const lim = Math.min(len, temp);
            p.x += (dvec.x / len) * lim;
            p.y += (dvec.y / len) * lim;
        });
        temp = Math.max(initialTemp * Math.pow(0.98, it + 1), 0.2);
    }

    // 最终硬分离：反复把重叠的成对边沿最小穿透轴推开（含 gap 间隙），直到零重叠。构造性保证。
    for (let pass = 0; pass < 3000; pass++) {
        let any = false;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = comp[i], b = comp[j];
                const pa = pos.get(a)!, pb = pos.get(b)!;
                const sa = size2(a), sb = size2(b);
                const ox = sa.w / 2 + sb.w / 2 + gap - Math.abs(pa.x - pb.x);
                const oy = sa.h / 2 + sb.h / 2 + gap - Math.abs(pa.y - pb.y);
                if (ox > 0 && oy > 0) {
                    any = true;
                    if (ox <= oy) {
                        const sgn = pa.x >= pb.x ? 1 : -1;
                        pa.x += (sgn * ox) / 2; pb.x -= (sgn * ox) / 2;
                    } else {
                        const sgn = pa.y >= pb.y ? 1 : -1;
                        pa.y += (sgn * oy) / 2; pb.y -= (sgn * oy) / 2;
                    }
                }
            }
        }
        if (!any) break;
    }

    // 归一到局部原点 (0,0)。
    let minX = Infinity, minY = Infinity, maxY = -Infinity;
    comp.forEach((id) => {
        const p = pos.get(id)!, s = size2(id);
        minX = Math.min(minX, p.x - s.w / 2);
        minY = Math.min(minY, p.y - s.h / 2);
        maxY = Math.max(maxY, p.y + s.h / 2);
    });
    comp.forEach((id) => {
        const p = pos.get(id)!, s = size2(id);
        put(id, p.x - s.w / 2 - minX, p.y - s.h / 2 - minY);
    });
    return { positions, height: maxY - minY };
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
    const scopedEdges = connections.filter((conn) => idSet.has(conn.toNodeId) && (scopeEdges ? idSet.has(conn.fromNodeId) : byId.has(conn.fromNodeId)));

    // 连通分量聚类：把节点按连线拆成若干「连通块」。块内力导向紧凑排布（相连节点在两个方向都靠近、链保持水平），
    // 块与块之间用更大间距纵向堆开，让不相关的节点明显拉开距离、一眼可分；跨块连线随之被隔离，边交叉大幅下降。
    const components = computeConnectedComponents(flowIds, scopedEdges);
    // 块顺序：按块内最靠上的节点原坐标排，尽量保留用户原本的上下布局意图。
    components.sort((a, b) => componentTopKey(a, byId) - componentTopKey(b, byId));

    // 块间间距：明显大于块内行距，使无关节点一眼可辨（也不至于把画布拉得过空）。
    const CLUSTER_GAP = Math.round(gap * 2.5);
    let cursorY = anchorY;
    for (const comp of components) {
        const compSet = new Set(comp);
        const compEdges = scopedEdges.filter((conn) => compSet.has(conn.fromNodeId) && compSet.has(conn.toNodeId));
        // 块内布局在局部坐标（原点 0,0）完成，再整体平移到当前块的堆叠位置。
        const { positions, height } = layoutComponentLocal({ sizeOf, resized, gap }, comp, compEdges);
        positions.forEach((pos, id) => put(id, anchorX + pos.x, cursorY + pos.y));
        cursorY += height + CLUSTER_GAP;
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

    return { ...snapshot, nodes, connections, selectedNodeIds };
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
