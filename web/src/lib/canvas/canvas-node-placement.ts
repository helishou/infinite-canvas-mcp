/**
 * 新节点自动落位。
 *
 * 从期望坐标（通常是鼠标落点或视口中心）向外做环形网格搜索，返回第一个不与已有节点
 * 重叠的左上角坐标。环形搜索解决的是「连续新建全部叠在同一个点」和「显式坐标被占用时
 * 只会一直往右推」：期望位置空闲时原地落位；被占用时就近找空位，优先留在可见视口内。
 *
 * 纯函数、无 React/Store 依赖，UI 新建节点与 Agent `add_node` 共用同一套规则。
 */

export type PlacementRect = { x: number; y: number; width: number; height: number };

export type PlacementObstacle = PlacementRect & { id?: string };

export type FindFreeNodePositionOptions = {
    /** 期望落点（左上角）。 */
    desired: { x: number; y: number };
    /** 待放置节点尺寸。 */
    size: { width: number; height: number };
    /** 需要避让的矩形；带 id 的项可用 excludeIds 排除。 */
    obstacles: readonly PlacementObstacle[];
    /** 优先落位区域（一般是当前可见视口）；区内找不到空位才允许落到区外。 */
    bounds?: PlacementRect;
    /** 期望位置被占用时向外搜索的最大环数。 */
    maxRing?: number;
    /** 与已有节点之间要求的最小净距。 */
    gap?: number;
    /** 不参与避让的节点 id（例如正在移动的节点自身）。 */
    excludeIds?: Iterable<string>;
};

/** 与画布自动排布一致的新节点净距。 */
export const NODE_PLACEMENT_GAP = 48;
/** 32 环 × 约 300px 步距 ≈ 一万像素，足够跳出任何正常密度的画布。 */
const MAX_RING = 32;

/** 把期望位置收进可视区，避免在视口边缘新建时节点的一半落在屏幕外。 */
function clampToBounds(desired: { x: number; y: number }, size: { width: number; height: number }, bounds?: PlacementRect) {
    if (!bounds) return desired;
    return {
        x: Math.min(Math.max(desired.x, bounds.x), bounds.x + Math.max(0, bounds.width - size.width)),
        y: Math.min(Math.max(desired.y, bounds.y), bounds.y + Math.max(0, bounds.height - size.height)),
    };
}

function isInside(rect: PlacementRect, bounds: PlacementRect) {
    return (
        rect.x >= bounds.x &&
        rect.y >= bounds.y &&
        rect.x + rect.width <= bounds.x + bounds.width &&
        rect.y + rect.height <= bounds.y + bounds.height
    );
}

/**
 * 同一环内的候选顺序：先是到期望点的距离，再按「右 → 下 → 左 → 上 → 斜向」偏好。
 * 这样连续新建会先向右、再向下铺开，而不是随机跳到某个更远的空位。
 */
function directionRank(dx: number, dy: number) {
    if (dx > 0 && dy === 0) return 0;
    if (dx === 0 && dy > 0) return 1;
    if (dx < 0 && dy === 0) return 2;
    if (dx === 0 && dy < 0) return 3;
    return 4;
}

/** 逐环生成候选格（只取环的周长，避免重复扫描已检查过的内圈）。 */
function ringCells(ring: number) {
    if (ring === 0) return [{ dx: 0, dy: 0 }];
    const cells: Array<{ dx: number; dy: number }> = [];
    for (let dx = -ring; dx <= ring; dx++) cells.push({ dx, dy: -ring }, { dx, dy: ring });
    for (let dy = -ring + 1; dy <= ring - 1; dy++) cells.push({ dx: -ring, dy }, { dx: ring, dy });
    return cells;
}

/** 把画布节点转成落位障碍，避免各调用点重复写 position.x/width 的映射。 */
export function placementObstacles(
    nodes: ReadonlyArray<{ id: string; position: { x: number; y: number }; width: number; height: number }>,
): PlacementObstacle[] {
    return nodes.map((node) => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        width: node.width,
        height: node.height,
    }));
}

export function findFreeNodePosition(options: FindFreeNodePositionOptions): { x: number; y: number } {
    const size = { width: Math.max(1, options.size.width), height: Math.max(1, options.size.height) };
    const gap = Math.max(0, options.gap ?? NODE_PLACEMENT_GAP);
    const excluded = new Set(options.excludeIds ?? []);
    const obstacles = options.obstacles.filter((obstacle) => !(obstacle.id && excluded.has(obstacle.id)));
    const bounds = options.bounds && options.bounds.width > 0 && options.bounds.height > 0 ? options.bounds : undefined;
    const start = clampToBounds(options.desired, size, bounds);
    const stepX = size.width + gap;
    const stepY = size.height + gap;
    const maxRing = Math.max(0, Math.floor(options.maxRing ?? MAX_RING));

    const collides = (x: number, y: number) =>
        obstacles.some(
            (obstacle) =>
                x < obstacle.x + obstacle.width + gap &&
                x + size.width + gap > obstacle.x &&
                y < obstacle.y + obstacle.height + gap &&
                y + size.height + gap > obstacle.y,
        );

    const search = (requireInsideBounds: boolean) => {
        for (let ring = 0; ring <= maxRing; ring++) {
            const cells = ringCells(ring)
                .map((cell) => ({ ...cell, x: start.x + cell.dx * stepX, y: start.y + cell.dy * stepY }))
                .sort((a, b) => {
                    const distanceA = (a.dx * stepX) ** 2 + (a.dy * stepY) ** 2;
                    const distanceB = (b.dx * stepX) ** 2 + (b.dy * stepY) ** 2;
                    return (
                        distanceA - distanceB ||
                        directionRank(a.dx, a.dy) - directionRank(b.dx, b.dy) ||
                        a.dy - b.dy ||
                        a.dx - b.dx
                    );
                });
            for (const cell of cells) {
                const rect = { x: cell.x, y: cell.y, width: size.width, height: size.height };
                if (requireInsideBounds && bounds && !isInside(rect, bounds)) continue;
                if (!collides(rect.x, rect.y)) return { x: rect.x, y: rect.y };
            }
        }
        return null;
    };

    // 先保证新节点完整落在可见视口内；视口实在挤不下才允许落到外面。
    const insideBounds = bounds ? search(true) : null;
    if (insideBounds) return insideBounds;
    const anywhere = search(false);
    if (anywhere) return anywhere;

    // 极端密度下的兜底：所有环都被占满时，统一停到既有内容右侧，至少保证不与任何节点重叠。
    const fallbackX = Math.max(start.x, ...obstacles.map((obstacle) => obstacle.x + obstacle.width + gap));
    return { x: fallbackX, y: start.y };
}
