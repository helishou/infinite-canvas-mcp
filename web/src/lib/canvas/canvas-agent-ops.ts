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
 * 对单个连通块做「分层正交」紧凑排布，返回【局部坐标】（原点 0,0）下各节点位置与块包围盒尺寸。
 *
 * 设计目标（用户诉求：整理后别拉得满天飞、**有关系的节点要挨在一起**）：
 * 1. 位置由结构直接算出，不再靠力导向迭代收敛 —— 曾实测 45 节点的块被全局斥力撑到
 *    11000 × 16800（节点面积只占 2.8%），相连节点中心距中位数 1344（约 4 倍节点高），
 *    本该水平的链在画布上斜穿几屏。
 * 2. 相连节点两轴都近：层号只决定先后的方向（源在左、汇在右），实际 x 贴着前驱右边界算
 *    （见下第 4 步），层内顺序决定 y。
 * 3. 链严格水平、输出与上游同行：用「行网格」—— 同一行是一条横带，行高取该行最高节点、
 *    行内垂直居中，所以 1:1 的输入输出中心严格对齐（dy = 0）。
 * 4. 绝不重叠：同一行内按层序推进必然右移（行游标），不同行由行高 + gap 天然分隔，构造性成立。
 */
function layoutComponentLocal(ctx: {
    sizeOf: (id: string) => { width: number; height: number };
    resized: Map<string, { width: number; height: number }>;
    gap: number;
    /** 节点原坐标 y：层内顺序的初始依据，尽量保留用户原本的上下布局意图。 */
    yOf: (id: string) => number;
}, comp: string[], compEdges: CanvasConnection[]): { positions: Map<string, FlowLayoutEntry>; width: number; height: number } {
    const { sizeOf, resized, gap, yOf } = ctx;
    const positions = new Map<string, FlowLayoutEntry>();
    const put = (id: string, x: number, y: number) => {
        const size = resized.get(id);
        positions.set(id, size ? { x, y, width: size.width, height: size.height } : { x, y });
    };
    const n = comp.length;
    const heightOf = (id: string) => sizeOf(id).height;
    const widthOf = (id: string) => sizeOf(id).width;

    // 单点：直接落位。
    if (n <= 1) {
        if (n === 1) put(comp[0], 0, 0);
        return { positions, width: n === 1 ? widthOf(comp[0]) : 0, height: n === 1 ? heightOf(comp[0]) : 0 };
    }

    // 1) 分层：最长路径分层，源在左、汇在右；有环时靠松弛迭代推进，保证收敛。
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

    // 列（层）：只保留有节点的层；环等场景会松弛出空层，空层必须丢掉，否则列宽算成空值污染整块坐标。
    const byLevel = new Map<number, string[]>();
    comp.forEach((id) => {
        const lv = level.get(id) ?? 0;
        const bucket = byLevel.get(lv);
        if (bucket) bucket.push(id);
        else byLevel.set(lv, [id]);
    });
    const layers = [...byLevel.keys()].sort((a, b) => a - b).map((lv) => byLevel.get(lv)!);

    // 邻居表：同一条边只记一次，避免重复计权把重心带偏。
    const preds = new Map<string, string[]>();
    const succs = new Map<string, string[]>();
    comp.forEach((id) => { preds.set(id, []); succs.set(id, []); });
    const seenEdge = new Set<string>();
    compEdges.forEach((conn) => {
        const key = `${conn.fromNodeId}->${conn.toNodeId}`;
        if (seenEdge.has(key)) return;
        seenEdge.add(key);
        preds.get(conn.toNodeId)?.push(conn.fromNodeId);
        succs.get(conn.fromNodeId)?.push(conn.toNodeId);
    });

    // 2) 层内顺序：先按原坐标上→下稳定排，再交替做「前向看前驱重心 / 后向看后继重心」排序。
    //    只做前向时扇出节点的顺序被上游牵死，分叉汇聚处的交叉压不下去；补上后向遍历才收敛。
    layers.forEach((ids) => ids.sort((a, b) => yOf(a) - yOf(b)));
    const orderIndex = new Map<string, number>();
    const reindex = (ids: string[]) => ids.forEach((id, i) => orderIndex.set(id, i));
    layers.forEach((ids) => reindex(ids));
    for (let pass = 0; pass < 4; pass++) {
        const forward = pass % 2 === 0;
        const targets = layers.map((_, i) => i);
        const scan = forward ? targets.slice(1) : targets.slice(0, -1).reverse();
        scan.forEach((lv) => {
            const refsOf = forward ? preds : succs;
            const home = new Map(layers[lv].map((id, i) => [id, i]));
            const bary = (id: string) => {
                const refs = refsOf.get(id)!.map((ref) => orderIndex.get(ref)).filter((v): v is number => v !== undefined);
                return refs.length ? refs.reduce((sum, v) => sum + v, 0) / refs.length : home.get(id)!;
            };
            layers[lv].sort((a, b) => bary(a) - bary(b));
            reindex(layers[lv]);
        });
    }

    // 3) 行 y：每行是一条横跨各层的水平带，相连节点尽量分到同一行 → 链自然水平、输出与上游同行。
    //    行高取该行最高节点，行内垂直居中，所以 1:1 的输入输出中心严格对齐（dy = 0）。
    const rowOf = new Map<string, number>();
    const rowHeight = new Map<number, number>();
    layers.forEach((ids) => {
        // 目标行 = 前驱行的重心；整层块再以该重心为中心摆放，避免父节点永远贴住第一个子节点。
        const wanted = ids.map((id, index) => {
            const refs = (preds.get(id) ?? []).map((parent) => rowOf.get(parent)).filter((row): row is number => row !== undefined);
            return refs.length ? refs.reduce((sum, row) => sum + row, 0) / refs.length : index;
        });
        const mean = wanted.reduce((sum, value) => sum + value, 0) / wanted.length;
        const start = mean - (ids.length - 1) / 2;
        ids.forEach((id, index) => {
            const row = Math.round(start + index);
            rowOf.set(id, row);
            rowHeight.set(row, Math.max(rowHeight.get(row) ?? 0, heightOf(id)));
        });
    });
    const rowTop = new Map<number, number>();
    let cursorY = 0;
    [...rowHeight.keys()].sort((a, b) => a - b).forEach((row) => {
        rowTop.set(row, cursorY);
        cursorY += rowHeight.get(row)! + gap;
    });

    // 4) 列 x：**不用统一列坐标**。曾按「层宽 = 层内最大宽」给整层一个 x，结果同层只要出现
    //    一个宽节点，整层其它窄链后面都留出同宽的死空白，有关系的两个节点被顶到 1400+ 之外
    //    （实测「宽窄链混排」相邻节点净空隙 1448，正常应为一个 gap）。
    //    改为「贴前驱」：x = max(所有前驱右边界 + gap, 本行游标)。于是
    //    - 有边相连的两个节点恰好相隔一个 gap，宽节点只推自己那一行，不牵连别的链；
    //    - 跨层引用（A 直接连 E）会自动跳空列贴上去，不再横跨整屏。
    //    不重叠由「本行游标 + 前驱约束」保证：同一行按层序推进必然右移，不同行 y 天然分隔。
    const nodeX = new Map<string, number>();
    const rowCursor = new Map<number, number>();
    layers.forEach((ids) => {
        ids.forEach((id) => {
            const row = rowOf.get(id)!;
            const afterPreds = (preds.get(id) ?? []).reduce((max, parent) => {
                const parentX = nodeX.get(parent);
                return parentX === undefined ? max : Math.max(max, parentX + widthOf(parent) + gap);
            }, -Infinity);
            const x = Math.max(Number.isFinite(afterPreds) ? afterPreds : 0, rowCursor.get(row) ?? 0);
            nodeX.set(id, x);
            rowCursor.set(row, x + widthOf(id) + gap);
        });
    });

    // 5) 反向收紧：正向只保证「不早于前驱」，于是「短链汇入长链」时短链末端被留在很左边，
    //    与汇合点拉开上千像素（实测 5 步链 + 2 步链汇合时，短链末端到汇合点净空隙 1452）。
    //    再从右往左松弛一次：能贴住后继左边（留一个 gap）就贴过去。
    //    只放行「从源点出发、沿途每个节点都只有一个后继」的链整体右移 —— 这类链的上游没有分支，
    //    右移不会拉长别的边。一旦链上挂过分支（源点扇出 / 中途分叉），整条不动：否则为了贴汇合点，
    //    反而会把「共享输入 → 各下游」的边推远，得不偿失（实测宽窄链混排场景会从 1 处长边变 2 处）。
    const onSingleChain = new Map<string, boolean>();
    layers.forEach((ids) => ids.forEach((id) => {
        const parents = preds.get(id) ?? [];
        onSingleChain.set(id, parents.length === 0
            || parents.every((parent) => (succs.get(parent) ?? []).length === 1 && onSingleChain.get(parent) === true));
    }));
    // rowRight：本行「已定位的最左节点」左边界再减 gap，即更左节点允许达到的最右位置。
    const rowRight = new Map<number, number>();
    for (let i = layers.length - 1; i >= 0; i--) {
        const ids = layers[i];
        for (let j = ids.length - 1; j >= 0; j--) {
            const id = ids[j];
            const row = rowOf.get(id)!;
            const current = nodeX.get(id)!;
            const caps: number[] = [];
            if (onSingleChain.get(id)) {
                (succs.get(id) ?? []).forEach((succ) => {
                    const succX = nodeX.get(succ);
                    if (succX !== undefined) caps.push(succX - widthOf(id) - gap);
                });
                const rowCap = rowRight.get(row);
                if (rowCap !== undefined) caps.push(rowCap - widthOf(id));
            }
            const next = caps.length ? Math.max(current, Math.min(...caps)) : current;
            nodeX.set(id, next);
            rowRight.set(row, next - gap);
        }
    }
    comp.forEach((id) => {
        const row = rowOf.get(id)!;
        const h = heightOf(id);
        put(id, nodeX.get(id)!, rowTop.get(row)! + (rowHeight.get(row)! - h) / 2);
    });

    // 归一到局部原点 (0,0)，并回传块包围盒尺寸（块间打包要用）。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    comp.forEach((id) => {
        const p = positions.get(id)!;
        const size = sizeOf(id);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + size.width);
        maxY = Math.max(maxY, p.y + size.height);
    });
    comp.forEach((id) => {
        const p = positions.get(id)!;
        const size = resized.get(id);
        positions.set(id, size ? { x: p.x - minX, y: p.y - minY, width: size.width, height: size.height } : { x: p.x - minX, y: p.y - minY });
    });
    return { positions, width: maxX - minX, height: maxY - minY };
}

/**
 * 按连接关系（fromNodeId → toNodeId 表示数据流方向）做拓扑分层排布：
 * 源点（只有出边，输入）在左，汇点（只有入边，输出）在右。
 * 连通块内部走「分层正交」：层号决定列 x，格行决定 y，相连节点尽量同行 → 链水平、块紧凑。
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
    // 尺寸缺失兜底：宽高非正（旧数据 / 外部写入 / NaN）的节点必须先补齐再排布，否则会被当成 0×0 参与计算 ——
    // 行高塌成 0、相邻节点只剩一个 gap，而画布按真实尺寸渲染时就会互相压住（实测重叠 300×52）。
    ids.forEach((id) => {
        const node = byId.get(id);
        if (!node || (node.width > 0 && node.height > 0)) return;
        const spec = getNodeSpec(isRegisteredNodeType(node.type) ? node.type : CanvasNodeType.Text);
        resized.set(id, { width: node.width > 0 ? node.width : spec.width, height: node.height > 0 ? node.height : spec.height });
    });
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

    // 连通分量聚类：把节点按连线拆成若干「连通块」。块内做分层正交排布（相连节点两个方向都靠近、链保持水平），
    // 块与块之间按原上下顺序做「货架式」打包 —— 小块填进大块旁边的空位、装不下才换行，
    // 避免无条件纵向堆叠在右侧留出整片空白；跨块连线随之被隔离，边交叉大幅下降。
    const components = computeConnectedComponents(flowIds, scopedEdges);
    // 块顺序：按块内最靠上的节点原坐标排，尽量保留用户原本的上下布局意图。
    components.sort((a, b) => componentTopKey(a, byId) - componentTopKey(b, byId));

    // 块间间距：明显大于块内行距，使无关节点一眼可辨（也不至于把画布拉得过空）。
    const CLUSTER_GAP = Math.round(gap * 2.5);
    // 先把每个块在局部坐标（原点 0,0）排好，拿到各自的包围盒。
    const blocks = components.map((comp) => {
        const compSet = new Set(comp);
        const compEdges = scopedEdges.filter((conn) => compSet.has(conn.fromNodeId) && compSet.has(conn.toNodeId));
        return layoutComponentLocal(
            { sizeOf, resized, gap, yOf: (id: string) => byId.get(id)?.position.y ?? 0 },
            comp,
            compEdges,
        );
    });
    // 块间「货架式」打包：按原上下顺序往右铺，一行铺不下再换行。
    // 小块能填进大块旁边的空位，避免无条件纵向堆叠在右侧留出整片空白
    // （实测「大块 + 若干孤立点」场景包围盒面积占比 37% → 67%）。
    // 货架宽度上限取「最宽块」与「总面积开方」的较大者：单块绝不被挤断行，整行也不会无限拉长。
    // 货架宽度上限取「最宽块」与「总面积开方」的较大者：
    // 单块绝不被挤断行（宽度 ≥ 最宽块），整行也不会无限拉长（≥ 面积开方）。
    // 试过按包围盒面积搜索更优宽度，但会选出「两块并排」这类极端扁长的形状
    // ——面积只小十几个百分点，画布却宽一倍，浏览体验更差，所以不采用。
    const shelfLimit = Math.max(
        Math.max(...blocks.map((block) => block.width)),
        Math.ceil(Math.sqrt(blocks.reduce((sum, block) => sum + block.width * block.height, 0))),
    );
    let shelfY = anchorY;
    let shelfX = anchorX;
    let shelfHeight = 0;
    blocks.forEach((block, index) => {
        if (index > 0 && shelfX + block.width > anchorX + shelfLimit) {
            shelfY += shelfHeight + CLUSTER_GAP;
            shelfX = anchorX;
            shelfHeight = 0;
        }
        block.positions.forEach((pos, id) => put(id, shelfX + pos.x, shelfY + pos.y));
        shelfX += block.width + CLUSTER_GAP;
        shelfHeight = Math.max(shelfHeight, block.height);
    });

    // 停放节点：统一放到排布结果的最右列，纵向堆叠（从 anchorY 起，互不重叠，且避让画布上其它节点）。
    const rightEdge = Math.max(...[...result.entries()].map(([id, pos]) => pos.x + sizeOf(id).width), anchorX) + gap;
    let parkY = anchorY;
    ids.filter((id) => parkSet.has(id)).forEach((id) => {
        const size = sizeOf(id);
        const pos = resolveFreePosition(nodes, { x: rightEdge, y: parkY }, size.width, size.height);
        put(id, pos.x, pos.y);
        parkY = pos.y + size.height + gap;
    });

    // 避让「选区外节点」：整理只重排选中的节点，锚点又是原选区左上角，所以当重排后的范围比原选区
    // 更大（变宽 / 变高）时，就会压到旁边的未选中节点上 —— 用户看到的就是「整理后节点重叠」。
    // 这里把整个结果平移（内部相对位置完全不动、不破坏「有关系的节点在一起」）到不压任何未选中节点为止；
    // 每轮只推「更便宜」的一轴（右移或下移），右侧与下方都保持一个 gap 的净距。
    const selectedSet = new Set(ids);
    const obstacles = nodes
        .filter((node) => !selectedSet.has(node.id))
        .map((node) => ({ x: node.position.x, y: node.position.y, ...sizeOf(node.id) }));
    if (obstacles.length) {
        const rects = [...result.entries()].map(([id, pos]) => ({ x: pos.x, y: pos.y, ...sizeOf(id) }));
        const hits = (dx: number, dy: number) =>
            rects.some((rect) =>
                obstacles.some(
                    (obstacle) =>
                        rect.x + dx < obstacle.x + obstacle.width + gap &&
                        rect.x + dx + rect.width + gap > obstacle.x &&
                        rect.y + dy < obstacle.y + obstacle.height + gap &&
                        rect.y + dy + rect.height + gap > obstacle.y,
                ),
            );
        if (hits(0, 0)) {
            let dx = 0, dy = 0;
            // 每轮至少跨过当前命中的最远障碍，所以必然收敛；上限只是防病态数据（每个障碍铺满一层，
            // 实测 300 个障碍排成网格时需要 20+ 轮才能整体让开，上限给足）。
            for (let pass = 0; pass < 64 && hits(dx, dy); pass++) {
                let stepX = 0, stepY = 0;
                rects.forEach((rect) =>
                    obstacles.forEach((obstacle) => {
                        if (
                            rect.x + dx < obstacle.x + obstacle.width + gap &&
                            rect.x + dx + rect.width + gap > obstacle.x &&
                            rect.y + dy < obstacle.y + obstacle.height + gap &&
                            rect.y + dy + rect.height + gap > obstacle.y
                        ) {
                            stepX = Math.max(stepX, obstacle.x + obstacle.width + gap - (rect.x + dx));
                            stepY = Math.max(stepY, obstacle.y + obstacle.height + gap - (rect.y + dy));
                        }
                    }),
                );
                if (stepY > 0 && (stepY <= stepX || stepX <= 0)) dy += stepY;
                else if (stepX > 0) dx += stepX;
                else break;
            }
            if (dx || dy) result.forEach((pos, id) => result.set(id, { ...pos, x: pos.x + dx, y: pos.y + dy }));
        }
    }

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
