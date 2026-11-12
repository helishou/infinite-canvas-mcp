import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

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

/** 图片与智能图片节点共用的短边下限；手动缩放和换图自动适配必须一致。 */
export const IMAGE_NODE_MIN_SIDE = 120;

/** 尺寸比较容差：默认尺寸与适配结果都可能是小数，不能用严格相等判断。 */
const SIZE_EPSILON = 0.5;

/**
 * 换图后自动贴合图片比例的节点：智能生成节点，以及未开启自由缩放的图片节点。
 * 自动适配 effect 和手动缩放标记共用这一个判定，避免两处规则漂移。
 */
export function isAspectLockedImageNode(node: { type: string; metadata?: Pick<CanvasNodeMetadata, "smart" | "generationMode" | "freeResize"> }) {
    if (node.type === CanvasNodeType.Image) return !node.metadata?.freeResize;
    return node.type === CanvasNodeType.Config && node.metadata?.smart === true && (node.metadata?.generationMode || "image") === "image";
}

/** 保持面积、按目标比例换形，短边不低于 minSide。 */
function reshapeKeepingArea(area: number, ratio: number, minSide: number) {
    let width = Math.sqrt(area * ratio);
    let height = Math.sqrt(area / ratio);
    const shortSide = Math.min(width, height);
    if (shortSide < minSide) {
        const grow = minSide / shortSide;
        width *= grow;
        height *= grow;
    }
    return { width, height };
}

export type ImageNodeFitInput = {
    /** 节点当前尺寸 */
    width: number;
    height: number;
    /** 新图的自然尺寸 */
    mediaWidth: number;
    mediaHeight: number;
    /** 该节点类型的默认尺寸，来自 NODE_DEFAULT_SIZE */
    defaultWidth: number;
    defaultHeight: number;
    /** 用户手动拖拽过尺寸，只沿用当前面积 */
    userSized?: boolean;
};

/**
 * 换图后的节点尺寸。
 * 内接缩放只缩不放：9:16 图把节点压成 304×540 后，换 16:9 图会一路缩到 304×171。
 * 因此除下面第一种情况外，都按面积不变换形，让同一节点换任何画幅后体量稳定：
 * - 节点仍占着默认尺寸：内接适配，新节点不越过占位、不压住邻居；
 * - 用户手动缩放过：按当前面积换形，不再被默认包围盒抬升；
 * - 其余（含被旧算法越换越小的节点）：面积取 max(当前面积, 该图在默认包围盒内的标准内接面积)，
 *   旧数据在下次加载时就回到标准体量。
 * 输入非法时返回 null，由调用方保留节点现有尺寸。
 */
export function fitImageNodeSize(input: ImageNodeFitInput) {
    const width = positiveOr(input.width, 0);
    const height = positiveOr(input.height, 0);
    const mediaWidth = positiveOr(input.mediaWidth, 0);
    const mediaHeight = positiveOr(input.mediaHeight, 0);
    if (width <= 0 || height <= 0 || mediaWidth <= 0 || mediaHeight <= 0) return null;
    const defaultWidth = positiveOr(input.defaultWidth, 0);
    const defaultHeight = positiveOr(input.defaultHeight, 0);
    const inset = defaultWidth > 0 && defaultHeight > 0 ? fitNodeSize(mediaWidth, mediaHeight, defaultWidth, defaultHeight) : null;
    const atDefaultSize = Boolean(inset) && Math.abs(width - defaultWidth) <= SIZE_EPSILON && Math.abs(height - defaultHeight) <= SIZE_EPSILON;
    if (inset && atDefaultSize && !input.userSized) return inset;
    const area = input.userSized || !inset ? width * height : Math.max(width * height, inset.width * inset.height);
    return reshapeKeepingArea(area, mediaWidth / mediaHeight, IMAGE_NODE_MIN_SIDE);
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
