import type { ViewportTransform } from "@/types/canvas";

/**
 * 视口裁剪的「补重算阈值」与「已渲染外扩范围」都按**屏幕像素**定义。
 *
 * 拖动/缩放期间视口不逐帧走 React state，而是命令式写进 DOM（见 project.tsx 的 applyViewportLive），
 * 只在「视口已经移出当前已渲染范围」时补一次裁剪重算。
 *
 * 这两个值原本写成世界单位（520 / 700）。但拖动的 x/y 本身就是屏幕像素，除以 k 换算成世界单位后
 * 阈值被放大 1/k 倍：k=0.05（缩小看全图）时只平移 26 屏幕像素就重算一次，而每次重算都要把可见的
 * 近 200 个节点的 element 树重建一遍（CPU 采样占该场景平移 JS 的 86%），直接把平移压到 54fps。
 * 改成屏幕像素后重算频率与缩放无关，缩小看全图时不再反复重算。
 *
 * 数值按「屏幕像素」配平：前瞻 400px 与原设计在常用倍率下的手感一致
 * （原 700 世界单位在 k=0.55 时折合 385px），补重算阈值 300px 保证重算总赶在前瞻耗尽前发生。
 *
 * 不变式：VIEWPORT_RENDER_SCREEN_PADDING 必须大于 VIEWPORT_CULL_SCREEN_MARGIN，
 * 差值就是「提前量」，否则补渲染会晚于空白出现。
 */
export const VIEWPORT_CULL_SCREEN_MARGIN = 300;
/** 缩放比例变化超过这个幅度也要重算（缩小会让更多节点进入视野）。 */
export const VIEWPORT_CULL_ZOOM_RATIO = 0.35;
/** 裁剪时在视口外多渲染的屏幕像素距离，必须大于 VIEWPORT_CULL_SCREEN_MARGIN。 */
export const VIEWPORT_RENDER_SCREEN_PADDING = 400;

/** 裁剪用的世界单位外扩距离 = 屏幕像素 / 缩放比例。 */
export function viewportRenderPadding(scale: number) {
    if (!(scale > 0)) return VIEWPORT_RENDER_SCREEN_PADDING;
    return VIEWPORT_RENDER_SCREEN_PADDING / scale;
}

export function needsViewportCull(last: ViewportTransform, next: ViewportTransform) {
    if (!(next.k > 0) || !(last.k > 0)) return true;
    // x / y 本身就是屏幕像素，直接比较屏幕位移即可，与缩放无关。
    const movedX = Math.abs(next.x - last.x);
    const movedY = Math.abs(next.y - last.y);
    const zoomed = Math.abs(next.k - last.k) / last.k;
    return movedX >= VIEWPORT_CULL_SCREEN_MARGIN || movedY >= VIEWPORT_CULL_SCREEN_MARGIN || zoomed >= VIEWPORT_CULL_ZOOM_RATIO;
}
