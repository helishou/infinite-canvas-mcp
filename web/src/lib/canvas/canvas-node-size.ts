// 媒体自然尺寸可能缺失（导入的图、老数据、只带 storageKey 的槽位），
// Math.max(1, undefined) 会产出 NaN，NaN 一旦参与坐标算式就把 position.y 写成 null，
// 副本节点会精确重叠在同一点上、看上去像"点了没反应"。非法值统一退回包围盒上限。
function positiveOr(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = positiveOr(width, maxWidth);
    const h = positiveOr(height, maxHeight);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
