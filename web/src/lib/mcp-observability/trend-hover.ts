/**
 * 折线图悬停命中：SVG 用 viewBox 缩放，屏幕像素必须按实际缩放系数换算回 viewBox 坐标，
 * 否则容器变宽/变窄时命中点会整体偏移（同一症状：悬停位置和折线对不上）。
 */

export type TrendHoverChart = { width: number; height: number; padLeft: number; padRight: number };

/** 屏幕坐标 → viewBox 坐标；SVG 未布局（宽高为 0）时按 1:1 处理。 */
export function clientToViewBox(rect: { left: number; top: number; width: number; height: number }, chart: TrendHoverChart, clientX: number, clientY: number) {
    const scaleX = rect.width > 0 ? chart.width / rect.width : 1;
    const scaleY = rect.height > 0 ? chart.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/** 命中最近的数据点索引；超出绘图区或没有数据时返回 -1。 */
export function trendHoverIndex(x: number, count: number, chart: TrendHoverChart, tolerancePx = 0) {
    if (count <= 0 || !Number.isFinite(x)) return -1;
    const inner = chart.width - chart.padLeft - chart.padRight;
    const start = chart.padLeft;
    const end = chart.padLeft + inner;
    // 先做范围判定：Math.round 会把绘图区外很近的坐标折回 0 或 count-1，-0 也会被当成有效命中。
    if (x < start - tolerancePx || x > end + tolerancePx) return -1;
    if (count === 1) return 0;
    const step = inner / (count - 1);
    const raw = Math.min(count - 1, Math.max(0, Math.round((x - start) / step)));
    const pointX = start + raw * step;
    return Math.abs(pointX - x) <= Math.max(tolerancePx, step / 2) ? raw : -1;
}
