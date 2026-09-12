/**
 * 画布图片切分（split）能力：把一张图片按 rows×columns 等分切成多块，
 * 每块落盘为独立媒体，并生成对应的画布图片节点（与前端「分割」工具语义一致）。
 *
 * 前端实现参考：web/src/lib/canvas/canvas-image-data.ts 的 splitDataUrl()
 *   - 无自定义切割线时按 count 等分：floor(index * size / count)
 *   - 有切割线时用线的比例位置切
 * 这里保持同样的切分口径，避免 MCP 与 UI 切出不一样的结果。
 */
import sharp from "sharp";

export type SplitParams = {
    rows: number;
    columns: number;
    /** 水平切割线（0-1 比例，可选；不传则按 rows 等分） */
    horizontalLines?: number[];
    /** 垂直切割线（0-1 比例，可选；不传则按 columns 等分） */
    verticalLines?: number[];
    /**
     * 内缩像素：只作用于「相邻格之间的内边」。
     * 宫格图的分隔线正好压在切割线上，不内缩会把白线一起切进每块边缘。
     */
    inset?: number;
};

export type SplitPiece = {
    row: number;
    column: number;
    /** 该块在源图中的像素区域 */
    left: number;
    top: number;
    width: number;
    height: number;
    /** 切好的 PNG 二进制 */
    data: Buffer;
};

/** 与前端 buildSplitCuts 一致：按比例线切，或按 count 等分。 */
function buildCuts(lines: number[] | undefined, size: number, count: number): number[] {
    if (!lines?.length) {
        return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
    }
    const inner = lines
        .map((line) => Math.round(line * size))
        .filter((line) => line > 0 && line < size)
        .sort((a, b) => a - b);
    return [0, ...inner, size];
}

/**
 * 把一张图片切成 rows×columns 块。使用 sharp 抽取每个区域并统一编码为 PNG。
 * 返回的各块带像素坐标，便于调用方定位子节点。
 */
export async function splitImageBuffer(source: Buffer, params: SplitParams): Promise<{ pieces: SplitPiece[]; width: number; height: number }> {
    const rows = Math.max(1, Math.min(12, Math.floor(params.rows || 1)));
    const columns = Math.max(1, Math.min(12, Math.floor(params.columns || 1)));

    const meta = await sharp(source).metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (!width || !height) throw new Error("无法读取源图尺寸，切分失败");

    const xCuts = buildCuts(params.verticalLines, width, columns);
    const yCuts = buildCuts(params.horizontalLines, height, rows);
    const inset = Math.max(0, Math.floor(Number(params.inset || 0)));

    const pieces: SplitPiece[] = [];
    for (let row = 0; row < yCuts.length - 1; row += 1) {
        for (let column = 0; column < xCuts.length - 1; column += 1) {
            // 内缩只吃「内边」：相邻两块共享的那条切割线（白线）被两侧各让出 inset 像素。
            // 画面外边框不内缩，避免裁掉最外圈的构图。
            const trimTop = row > 0 ? inset : 0;
            const trimBottom = row < yCuts.length - 2 ? inset : 0;
            const trimLeft = column > 0 ? inset : 0;
            const trimRight = column < xCuts.length - 2 ? inset : 0;
            const left = xCuts[column] + trimLeft;
            const top = yCuts[row] + trimTop;
            const w = xCuts[column + 1] - xCuts[column] - trimLeft - trimRight;
            const h = yCuts[row + 1] - yCuts[row] - trimTop - trimBottom;
            if (w <= 0 || h <= 0) continue;
            const data = await sharp(source)
                .extract({ left, top, width: w, height: h })
                .png()
                .toBuffer();
            pieces.push({ row, column, left, top, width: w, height: h, data });
        }
    }
    return { pieces, width, height };
}
