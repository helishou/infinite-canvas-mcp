import { nanoid } from "nanoid";

import { GROUP_FRAME_PADDING, groupFrameOfMembers } from "@/lib/canvas/canvas-node-geometry";
import i18n from "@/i18n";
import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ViewportTransform } from "@/types/canvas";

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string; role?: string; order?: number }
    | { type: "create_group"; id?: string; memberIds: string[]; title?: string }
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
// 组是容器：整理后按「成员包围盒 + 内边距」重新生成（见 groupFrameOfMembers），组框始终覆盖住自己的成员。
// 顶边多留的一截来自 GROUP_FRAME_PADDING.top，避开组标题栏，否则成员会压在标题上。

export type FlowLayoutEntry = {
    x: number;
    y: number;
    /** 仅当本次整理改动了该节点尺寸（归一化）时才带上，调用方需要一并写回宽高。 */
    width?: number;
    height?: number;
};

type LayoutRect = { x: number; y: number; width: number; height: number };

/** 两个矩形之间没留出 gap 净距（即堵在一起）。 */
function rectsCollide(a: LayoutRect, b: LayoutRect, gap: number) {
    return (
        a.x < b.x + b.width + gap &&
        a.x + a.width + gap > b.x &&
        a.y < b.y + b.height + gap &&
        a.y + a.height + gap > b.y
    );
}

function groupCollides(rects: LayoutRect[], obstacles: LayoutRect[], dx: number, dy: number, gap: number) {
    return rects.some((rect) =>
        obstacles.some((obstacle) => rectsCollide({ ...rect, x: rect.x + dx, y: rect.y + dy }, obstacle, gap)),
    );
}

/** 一组矩形整体挪多样的包围盒。 */
function boundsOf(rects: LayoutRect[]) {
    if (!rects.length) return null;
    return {
        minX: Math.min(...rects.map((rect) => rect.x)),
        minY: Math.min(...rects.map((rect) => rect.y)),
        maxX: Math.max(...rects.map((rect) => rect.x + rect.width)),
        maxY: Math.max(...rects.map((rect) => rect.y + rect.height)),
    };
}

/**
 * 求把 rects 整体挪开 obstacles 的最小位移：四个方向各算一个「每轮至少跨过当前挡路的最远障碍」的解，
 * 取最短的那个。只做刚体平移，块内相对位置不受影响（「有关系的节点挨在一起」仍然成立）；
 * 之前只往右 / 往下推，右下方有邻居时会被推离原区域很远 —— 现在允许就近往上 / 往左让开。
 * 每轮至少跨过一个障碍，所以必然收敛；64 轮上限只是防病态数据（实测 300 个障碍排成网格要 20+ 轮）。
 */
function minimalAvoidanceShift(rects: LayoutRect[], obstacles: LayoutRect[], gap: number) {
    if (!groupCollides(rects, obstacles, 0, 0, gap)) return null;
    const candidates: Array<{ dx: number; dy: number; distance: number }> = [];
    ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const).forEach(([axisX, axisY]) => {
        const stepFor = (rect: LayoutRect, obstacle: LayoutRect) =>
            axisX > 0
                ? obstacle.x + obstacle.width + gap - rect.x
                : axisX < 0
                    ? rect.x + rect.width + gap - obstacle.x
                    : axisY > 0
                        ? obstacle.y + obstacle.height + gap - rect.y
                        : rect.y + rect.height + gap - obstacle.y;
        let dx = 0;
        let dy = 0;
        for (let pass = 0; pass < 64 && groupCollides(rects, obstacles, dx, dy, gap); pass++) {
            let step = 0;
            rects.forEach((rect) =>
                obstacles.forEach((obstacle) => {
                    const moved = { ...rect, x: rect.x + dx, y: rect.y + dy };
                    if (rectsCollide(moved, obstacle, gap)) step = Math.max(step, stepFor(moved, obstacle));
                }),
            );
            if (step <= 0) break;
            dx += axisX * step;
            dy += axisY * step;
        }
        if (groupCollides(rects, obstacles, dx, dy, gap)) return;
        candidates.push({ dx, dy, distance: dx * dx + dy * dy });
    });
    return candidates.length ? candidates.reduce((best, item) => (item.distance < best.distance ? item : best)) : null;
}

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
    /** 「整理选中」场景：打开后结果会中心对齐回这批节点整理【之前】所在的那块区域，避免整块漂到画布别处。 */
    centerInPlace?: boolean;
    gap?: number;
    /** 这些节点不参与分层排布，统一停到排布结果的最右列（纵向堆叠）。用于把大型节点（如 H3 导演台）排除在流程之外并靠右停放。 */
    parkAtRight?: string[];
    /** 开启后先做画面节点尺寸归一化（组内最大高度 ≤ 最小高度 × 2），仅「整理布局」入口使用。 */
    normalizeSizes?: boolean;
}): Map<string, FlowLayoutEntry> {
    const { nodes, connections, ids, scopeEdges = false, anchorX, anchorY } = opts;
    const gap = opts.gap ?? AUTO_LAYOUT_GAP;
    const parkSet = new Set(opts.parkAtRight ?? []);
    const result = new Map<string, FlowLayoutEntry>();
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // 组（Group）是容器，组框必须覆盖住组里的成员 —— 整理时不能把组和成员当两个互不相干的节点各排各的，
    // 否则组被当成一块普通矩形塞到别处、成员又被按流程排走，两边谁也不覆盖谁。
    // 规则：选中了组就带上它全部成员，选中了成员就带上它所属的组，嵌套组顺着这条关系一并展开。
    const childrenOf = new Map<string, string[]>();
    const parentOf = new Map<string, string>();
    nodes.forEach((node) => {
        const groupId = node.metadata?.groupId;
        if (!groupId || groupId === node.id || !byId.has(groupId)) return;
        parentOf.set(node.id, groupId);
        const siblings = childrenOf.get(groupId);
        if (siblings) siblings.push(node.id);
        else childrenOf.set(groupId, [node.id]);
    });
    const expanded = new Set(ids);
    [...ids].forEach(function expand(id) {
        const related = [...(childrenOf.get(id) ?? [])];
        const parent = parentOf.get(id);
        if (parent) related.push(parent);
        related.forEach((next) => {
            if (!byId.has(next) || expanded.has(next)) return;
            expanded.add(next);
            expand(next);
        });
    });
    const descendantsOf = new Map<string, string[]>();
    const descendants = (id: string): string[] => {
        const cached = descendantsOf.get(id);
        if (cached) return cached;
        descendantsOf.set(id, []);
        const list: string[] = [];
        (childrenOf.get(id) ?? []).forEach((child) => {
            if (!expanded.has(child)) return;
            list.push(child, ...descendants(child));
        });
        descendantsOf.set(id, list);
        return list;
    };
    const groupIds = [...expanded].filter((id) => byId.get(id)?.type === CanvasNodeType.Group);
    // 「承载成员」的组：排布时请它离场，等成员落位后按成员包围盒重新生成（空组没有成员可包，仍按普通节点排）。
    const wrapperGroups = new Set(groupIds.filter((id) => descendants(id).some((child) => byId.get(child)?.type !== CanvasNodeType.Group)));
    // 真正参与分层排布的节点：排除被停放（park）的节点，以及承载成员的组。
    const flowIds = [...expanded].filter((id) => !parkSet.has(id) && !wrapperGroups.has(id));

    // 尺寸先定型再排布：否则按旧尺寸算出的行高/列宽会和缩放后的真实尺寸打架，直接导致重叠。
    const resized = opts.normalizeSizes ? normalizeMediaSizes(byId, flowIds) : new Map<string, { width: number; height: number }>();
    // 尺寸缺失兜底：宽高非正（旧数据 / 外部写入 / NaN）的节点必须先补齐再排布，否则会被当成 0×0 参与计算 ——
    // 行高塌成 0、相邻节点只剩一个 gap，而画布按真实尺寸渲染时就会互相压住（实测重叠 300×52）。
    [...expanded].forEach((id) => {
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
        // 行宽要去掉「上一块后面已经加过的 tail gap」：否则每行的可用宽度凭空少一个 CLUSTER_GAP，
        // 选中一堆彼此无连接的节点时会排成细长一列（实测 6 个 300×200 的节点被拉成 300×1800），
        // 形状与原选区差得离谱，看着就像整理跑到别处去了。
        if (index > 0 && shelfX - anchorX - CLUSTER_GAP + block.width > shelfLimit) {
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

    // 组成员已经跟着整批排完，现在让每个承载成员的组重新包住自己的成员 ——
    // 组永远等于「成员包围盒 + 内边距」，所以整理完组框不可能再跑到成员外面去。
    // 子组先收敛（有的话），父组才会把自己 heir 的新矩形算进包围盒。
    const fitGroup = (groupId: string) => {
        const children = (childrenOf.get(groupId) ?? []).filter((child) => expanded.has(child));
        children.forEach((child) => {
            if (byId.get(child)?.type === CanvasNodeType.Group) fitGroup(child);
        });
        const memberRects = children
            .map((child) => {
                const pos = result.get(child);
                if (!pos) return null;
                return { x: pos.x, y: pos.y, ...sizeOf(child) };
            })
            .filter((rect): rect is LayoutRect => Boolean(rect));
        if (!memberRects.length) return;
        const frame = groupFrameOfMembers(memberRects)!;
        resized.set(groupId, { width: frame.width, height: frame.height });
        put(groupId, frame.x, frame.y);
    };
    groupIds.forEach((id) => {
        if (wrapperGroups.has(id)) fitGroup(id);
    });

    // 回落到原区域：整理后的形状通常和原选区不一样（拉长 / 变宽），而锚点固定是选区左上角，
    // 于是整块只会朝右下方生长 —— 用户看到的就是「整理完节点跑到别的地方去了」。
    // 这里把结果包围盒【中心对齐】到原区域：内部相对位置一动不动，但整块的重心还留在原来那块区域。
    // 原区域按【参与整理的节点】算而不是按 ids：组关系会把成员/外层组一并卷进来（见上文 expanded），
    // 只按 ids 算的话第二次整理时这块区域会缺掉上次被夹带进来的节点，连点两次就会漂移（幂等破裂）。
    const regionBox = opts.centerInPlace
        ? boundsOf(
              [...expanded].flatMap((id) => {
                  const node = byId.get(id);
                  return node ? [{ x: node.position.x, y: node.position.y, width: node.width, height: node.height }] : [];
              }),
          )
        : null;
    if (regionBox) {
        const resultBounds = boundsOf([...result.entries()].map(([id, pos]) => ({ x: pos.x, y: pos.y, ...sizeOf(id) })));
        if (resultBounds) {
            const dx = (regionBox.minX + regionBox.maxX) / 2 - (resultBounds.minX + resultBounds.maxX) / 2;
            const dy = (regionBox.minY + regionBox.maxY) / 2 - (resultBounds.minY + resultBounds.maxY) / 2;
            if (dx || dy) result.forEach((pos, id) => result.set(id, { ...pos, x: pos.x + dx, y: pos.y + dy }));
        }
    }

    // 避让「选区外节点」：整理只重排选中的节点，所以重排后的范围有可能压到旁边的未选中节点上 ——
    // 用户看到的就是「整理后节点重叠」。这里把整个结果刚体平移让开，四个方向各求一次位移并取最短的那个，
    // 既不破坏「有关系的节点在一起」，也不会为了单向避让把整块推到离原区域很远的地方。
    const obstacles = nodes
        .filter((node) => !expanded.has(node.id))
        .map((node) => ({ x: node.position.x, y: node.position.y, ...sizeOf(node.id) }));
    if (obstacles.length) {
        const rects = [...result.entries()].map(([id, pos]) => ({ x: pos.x, y: pos.y, ...sizeOf(id) }));
        const shift = minimalAvoidanceShift(rects, obstacles, gap);
        if (shift) result.forEach((pos, id) => result.set(id, { ...pos, x: pos.x + shift.dx, y: pos.y + shift.dy }));
    }

    return result;
}

// 组内整理的成员间距：比全局整理的 gap(48) 更紧，组内本来就是一组相关节点。
const GROUP_ARRANGE_GAP = 24;
// 缩小搜索的二分次数：2^-20 的分辨率远细于 1px，足够。
const GROUP_ARRANGE_SCALE_PASSES = 20;

/**
 * 组内整理：把组的成员按当前视觉顺序（先上后下、行内先左后右）铺进组框内。
 * 图片 / 视频先归一化到「相近尺寸」（等比缩放、宽高比不变，与整理布局共用同一套带宽），
 * 再按货架式换行排进组框内缩一圈的可排布区域；装不下就整体等比缩小，不溢出组框。
 * 文本 / 音频 / 分组等小节点保持原尺寸 —— 拉伸它们只会更难读，也不该被当成画面节点归一化。
 * 只返回成员的新位置与尺寸，组框本身不动（用户要的是「排列到组的范围里」）。
 */
export function arrangeGroupMembers(group: CanvasNodeData, nodes: CanvasNodeData[], gap = GROUP_ARRANGE_GAP) {
    const result = new Map<string, Required<FlowLayoutEntry>>();
    const members = nodes.filter((node) => node.metadata?.groupId === group.id && node.id !== group.id);
    if (!members.length) return result;

    // 先按「行」聚类再行内从左到右，得到与用户视觉一致的处理顺序；直接按 y 排序会让错行的节点互相插队。
    const centerY = (node: CanvasNodeData) => node.position.y + node.height / 2;
    const rows: CanvasNodeData[][] = [];
    [...members].sort((a, b) => centerY(a) - centerY(b) || a.position.x - b.position.x).forEach((node) => {
        const row = rows[rows.length - 1];
        const rowCenter = row ? row.reduce((sum, item) => sum + centerY(item), 0) / row.length : 0;
        const tolerance = Math.max(24, Math.min(node.height, row?.[0].height ?? node.height) / 2);
        if (row && Math.abs(centerY(node) - rowCenter) <= tolerance) row.push(node);
        else rows.push([node]);
    });
    const ordered = rows.flatMap((row) => row.sort((a, b) => a.position.x - b.position.x));

    const base = new Map(ordered.map((node) => [node.id, { width: Math.max(1, node.width), height: Math.max(1, node.height) }]));
    const media = ordered.filter((node) => LAYOUT_MEDIA_TYPES.has(node.type) && node.width > 0 && node.height > 0);
    if (media.length >= 2) {
        const heights = media.map((node) => node.height).sort((a, b) => a - b);
        const mid = heights.length % 2 === 1 ? heights[(heights.length - 1) / 2] : (heights[heights.length / 2 - 1] + heights[heights.length / 2]) / 2;
        if (mid > 0) {
            media.forEach((node) => {
                const target = Math.min(Math.max(node.height, mid * LAYOUT_SIZE_BAND_LOW), mid * LAYOUT_SIZE_BAND_HIGH);
                if (Math.abs(target - node.height) < LAYOUT_SIZE_EPSILON) return;
                base.set(node.id, { width: Math.max(1, Math.round(node.width * (target / node.height))), height: Math.round(target) });
            });
        }
    }

    // 可排布区域 = 组框内缩一圈（顶部那一圈给组标题栏）。
    const areaX = group.position.x + GROUP_FRAME_PADDING.left;
    const areaY = group.position.y + GROUP_FRAME_PADDING.top;
    const areaWidth = Math.max(gap, group.width - GROUP_FRAME_PADDING.left - GROUP_FRAME_PADDING.right);
    const areaHeight = Math.max(gap, group.height - GROUP_FRAME_PADDING.top - GROUP_FRAME_PADDING.bottom);

    const sizeAt = (node: CanvasNodeData, scale: number) => {
        const size = base.get(node.id)!;
        return LAYOUT_MEDIA_TYPES.has(node.type) ? { width: size.width * scale, height: size.height * scale } : size;
    };
    const plan = (scale: number) => {
        const lines: Array<{ nodes: CanvasNodeData[]; width: number; height: number }> = [];
        ordered.forEach((node) => {
            const size = sizeAt(node, scale);
            const line = lines[lines.length - 1];
            if (!line || line.width + gap + size.width > areaWidth) lines.push({ nodes: [node], width: size.width, height: size.height });
            else {
                line.nodes.push(node);
                line.width += gap + size.width;
                line.height = Math.max(line.height, size.height);
            }
        });
        return {
            lines,
            maxWidth: Math.max(...lines.map((line) => line.width)),
            totalHeight: lines.reduce((sum, line) => sum + line.height, 0) + gap * Math.max(0, lines.length - 1),
        };
    };

    let scale = 1;
    const fits = (candidate: number) => {
        const current = plan(candidate);
        return current.maxWidth <= areaWidth + 0.5 && current.totalHeight <= areaHeight + 0.5;
    };
    if (!fits(1)) {
        // 缩小不是线性的：尺寸一变，换行位置就变，按「当前规划的超标比例」一步缩到底会缩过头
        // （实测竖图 + 横图混排时 1000×700 的组里 3 个节点被缩到原尺寸的 1/3）。
        // 直接二分「能装下的最大比例」，让成员尽量大。
        let low = 0.05;
        let high = 1;
        for (let pass = 0; pass < GROUP_ARRANGE_SCALE_PASSES; pass++) {
            const mid = (low + high) / 2;
            if (fits(mid)) low = mid;
            else high = mid;
        }
        scale = low;
    }

    const { lines, totalHeight } = plan(scale);
    let cursorY = areaY + Math.max(0, (areaHeight - totalHeight) / 2);
    lines.forEach((line) => {
        let cursorX = areaX;
        line.nodes.forEach((node) => {
            const size = sizeAt(node, scale);
            result.set(node.id, { x: Math.round(cursorX), y: Math.round(cursorY), width: Math.round(size.width), height: Math.round(size.height) });
            cursorX += size.width + gap;
        });
        cursorY += line.height + gap;
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
        if (op.type === "create_group") {
            const memberIds = new Set(op.memberIds || []);
            // 组不套组：选中的组节点不作为成员，否则拖动/框选的嵌套语义在这套数据结构里没有定义。
            const members = nodes.filter((node) => memberIds.has(node.id) && node.type !== CanvasNodeType.Group);
            if (members.length) {
                const memberSet = new Set(members.map((node) => node.id));
                // 成员原先所属的组：成员搬走后可能变小甚至变空，要跟着收拾。
                const previousGroupIds = new Set(members.map((node) => node.metadata?.groupId).filter((id): id is string => Boolean(id)));
                const spec = getNodeSpec(CanvasNodeType.Group);
                const frame = groupFrameOfMembers(members.map((node) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height })))!;
                const groupId = op.id || nanoid();
                nodes = nodes.map((node) => (memberSet.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId } } : node));
                // 组插到数组【最前面】：节点层级由 DOM 顺序决定（同 z-index 下后者在上），
                // 追加到末尾的话新组会盖在自己的成员上，连成员的点击与拖动都被吞掉。
                nodes = [
                    { id: groupId, type: CanvasNodeType.Group, title: op.title || spec.title, position: { x: frame.x, y: frame.y }, width: frame.width, height: frame.height, metadata: { ...spec.metadata } },
                    ...nodes,
                ];
                // 旧组重新贴合剩余成员；成员被搬空就删掉 —— 组是容器，不该留下无人认领的空框。
                nodes = nodes
                    .map((node) => {
                        if (node.type !== CanvasNodeType.Group || !previousGroupIds.has(node.id)) return node;
                        const leftovers = groupFrameOfMembers(
                            nodes.filter((item) => item.metadata?.groupId === node.id).map((item) => ({ x: item.position.x, y: item.position.y, width: item.width, height: item.height })),
                        );
                        if (!leftovers) return null;
                        return { ...node, position: { x: leftovers.x, y: leftovers.y }, width: leftovers.width, height: leftovers.height };
                    })
                    .filter((node): node is CanvasNodeData => Boolean(node));
                connections = connections.filter((conn) => nodes.some((node) => node.id === conn.fromNodeId) && nodes.some((node) => node.id === conn.toNodeId));
                selectedNodeIds = [groupId];
            }
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
