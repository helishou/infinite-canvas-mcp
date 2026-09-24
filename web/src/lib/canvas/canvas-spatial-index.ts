export type CanvasSpatialBounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

type SpatialEntry<T> = {
    item: T;
    bounds: CanvasSpatialBounds;
    order: number;
};

export type CanvasSpatialIndex<T extends { id: string }> = {
    cellSize: number;
    entriesById: Map<string, SpatialEntry<T>>;
    buckets: Map<string, string[]>;
    overflowIds: Set<string>;
};

const DEFAULT_CELL_SIZE = 1024;
const MAX_BUCKET_CELLS_PER_ITEM = 4096;

function cellKey(x: number, y: number) {
    return `${x}:${y}`;
}

function cellRange(bounds: CanvasSpatialBounds, cellSize: number) {
    return {
        left: Math.floor(bounds.left / cellSize),
        top: Math.floor(bounds.top / cellSize),
        right: Math.floor(bounds.right / cellSize),
        bottom: Math.floor(bounds.bottom / cellSize),
    };
}

function intersects(a: CanvasSpatialBounds, b: CanvasSpatialBounds) {
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

export function buildCanvasSpatialIndex<T extends { id: string }>(items: T[], getBounds: (item: T) => CanvasSpatialBounds | null, cellSize = DEFAULT_CELL_SIZE): CanvasSpatialIndex<T> {
    const entriesById = new Map<string, SpatialEntry<T>>();
    const buckets = new Map<string, string[]>();
    const overflowIds = new Set<string>();
    const safeCellSize = cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;

    items.forEach((item, order) => {
        const bounds = getBounds(item);
        if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) || bounds.right < bounds.left || bounds.bottom < bounds.top) return;
        const entry = { item, bounds, order };
        entriesById.set(item.id, entry);
        const range = cellRange(bounds, safeCellSize);
        const cellCount = (range.right - range.left + 1) * (range.bottom - range.top + 1);
        if (cellCount > MAX_BUCKET_CELLS_PER_ITEM) {
            overflowIds.add(item.id);
            return;
        }
        for (let y = range.top; y <= range.bottom; y += 1) {
            for (let x = range.left; x <= range.right; x += 1) {
                const key = cellKey(x, y);
                const bucket = buckets.get(key);
                if (bucket) bucket.push(item.id);
                else buckets.set(key, [item.id]);
            }
        }
    });

    return { cellSize: safeCellSize, entriesById, buckets, overflowIds };
}

export function queryCanvasSpatialIndex<T extends { id: string }>(index: CanvasSpatialIndex<T>, bounds: CanvasSpatialBounds) {
    if (!index.entriesById.size) return [];
    const range = cellRange(bounds, index.cellSize);
    const cellCount = (range.right - range.left + 1) * (range.bottom - range.top + 1);
    // 缩到很小时查询范围可能跨过成千上万个空格。此时遍历每个条目更少，
    // 也保留 entriesById 的插入顺序，避免低倍率反而因空间索引循环变慢。
    if (cellCount >= index.entriesById.size) {
        return Array.from(index.entriesById.values())
            .filter((entry) => intersects(entry.bounds, bounds))
            .sort((a, b) => a.order - b.order)
            .map((entry) => entry.item);
    }
    const candidateIds = new Set<string>();
    index.overflowIds.forEach((id) => candidateIds.add(id));
    for (let y = range.top; y <= range.bottom; y += 1) {
        for (let x = range.left; x <= range.right; x += 1) {
            index.buckets.get(cellKey(x, y))?.forEach((id) => candidateIds.add(id));
        }
    }

    return Array.from(candidateIds)
        .map((id) => index.entriesById.get(id))
        .filter((entry): entry is SpatialEntry<T> => Boolean(entry && intersects(entry.bounds, bounds)))
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.item);
}
