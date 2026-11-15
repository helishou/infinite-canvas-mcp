/** 制作态浮动卡片的定位：优先放在节点外侧，任何时候都不主动压在节点自己身上。 */

export type PlacementRect = { left: number; top: number; width: number; height: number };
export type PlacementSize = { width: number; height: number };

export type PlacementInput = {
    /** 节点在屏幕坐标里的包围盒 */
    node: PlacementRect;
    /** 卡片自身尺寸 */
    card: PlacementSize;
    /** 画布可视区尺寸 */
    canvas: PlacementSize;
    /** 卡片与节点的间距 */
    gap?: number;
    /** 与画布边缘的安全距离 */
    margin?: number;
};

const clamp = (value: number, min: number, max: number) => max < min ? min : Math.min(Math.max(value, min), max);

function fits(left: number, top: number, card: PlacementSize, canvas: PlacementSize, margin: number) {
    return left >= margin
        && top >= margin
        && left + card.width <= canvas.width - margin
        && top + card.height <= canvas.height - margin;
}

/**
 * 依「右侧 → 左侧 → 上方 → 下方」找第一个完全放得下的位置。
 * 四边都放不下时（极小画布或超大节点）取露出最多的一侧，最后统一夹回画布内。
 * 旧实现只做「上方 + 夹到 72px」，节点靠上时卡片会直接盖在节点内容上——这里不再允许。
 */
export function placeProductionCard({ node, card, canvas, gap = 12, margin = 16 }: PlacementInput) {
    const centeredLeft = node.left + node.width / 2 - card.width / 2;
    const centeredTop = node.top + node.height / 2 - card.height / 2;
    const candidates = [
        { left: node.left + node.width + gap, top: node.top },
        { left: node.left - card.width - gap, top: node.top },
        { left: centeredLeft, top: node.top - card.height - gap },
        { left: centeredLeft, top: node.top + node.height + gap },
    ];
    for (const candidate of candidates) {
        if (fits(candidate.left, candidate.top, card, canvas, margin)) {
            return { left: Math.round(candidate.left), top: Math.round(candidate.top) };
        }
    }
    const visible = (candidate: { left: number; top: number }) => {
        const width = Math.min(candidate.left + card.width, canvas.width - margin) - Math.max(candidate.left, margin);
        const height = Math.min(candidate.top + card.height, canvas.height - margin) - Math.max(candidate.top, margin);
        return Math.max(0, width) * Math.max(0, height);
    };
    const best = candidates.reduce((winner, candidate) => visible(candidate) > visible(winner) ? candidate : winner, candidates[0]);
    return {
        left: Math.round(clamp(best.left, margin, canvas.width - margin - card.width)),
        top: Math.round(clamp(best.top, margin, canvas.height - margin - card.height)),
    };
}

/** 卡片与节点包围盒是否相交（调试与测试用，组件不再据此做事）。 */
export function overlapsNode(left: number, top: number, card: PlacementSize, node: PlacementRect, slack = 0) {
    return left < node.left + node.width - slack
        && left + card.width > node.left + slack
        && top < node.top + node.height - slack
        && top + card.height > node.top + slack;
}
