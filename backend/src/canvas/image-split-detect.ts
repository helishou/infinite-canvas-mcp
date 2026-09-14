/**
 * 切分图片自动识别「格间分隔线宽度」。
 *
 * 思路（纯 CV，无 vision model）：
 *   1. 取源图 RGBA 原始像素（sharp.raw()）。
 *   2. 对每条用户标注的切分线，沿其垂直方向（横线竖扫 / 竖线横扫）
 *      在图像中点抽一条 1D 扫描线，截取 cut ± searchRadius 一段窗口。
 *   3. 用窗口两端 context 像素的中位色作"画面背景色"，算每个像素
 *      到 context 的色距；色距 > 阈值视为"分隔带像素"。
 *   4. 找最长连续分隔带长度 → 这条线对应的格间白线宽度。
 *   5. 多条切分线取中位数；任意一条找不到分隔带 → 0 + confidence 折损。
 *
 * 返回的 `lineInset` 是个整数 px：
 *   - 跟前端预览里的 `lineWidth`（视觉宽度）同义，给对话框用。
 *   - 跟后端 `splitImageBuffer` 的 `inset` 同义，给实际切分内缩用。
 * 无分隔带的连续图像会返回 { lineInset: 0, confidence: 0 }，由前端决定是否回退。
 */
import sharp from "sharp";

export type DetectLineInsetParams = {
    rows: number;
    columns: number;
    horizontalLines?: number[];
    verticalLines?: number[];
};

export type DetectLineInsetResult = {
    /** 识别出的格间分隔线宽度（整数 px）。连续图返回 0。 */
    lineInset: number;
    /** 0-1，成功识别出分隔带的切分线数 / 总切分线数。 */
    confidence: number;
    /** 每条切分线单独测得的宽度（未识别的不会进 samples）。 */
    samples: { horizontal: number[]; vertical: number[] };
    width: number;
    height: number;
};

const COLOR_DISTANCE_THRESHOLD = 30;
const CONTEXT_EDGE_PIXELS = 10;
const MIN_SEARCH_RADIUS = 20;
const SEARCH_RADIUS_RATIO = 0.1;

export async function detectLineInset(source: Buffer, params: DetectLineInsetParams): Promise<DetectLineInsetResult> {
    const meta = await sharp(source).metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (!width || !height) throw new Error("无法读取源图尺寸");

    const { data: pixels, info } = await sharp(source)
        .raw()
        .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const searchRadius = Math.max(MIN_SEARCH_RADIUS, Math.round(Math.min(width, height) * SEARCH_RADIUS_RATIO));

    // 扫描线不能取图像中点：N×M 宫格的中点可能正好落在分隔带上，
    // 导致整条扫描线都是分隔带颜色、context 失去对比。改取 1/4 / 3/4 两个
    // 位置（通常在 cell 内），各自跑一次检测，命中后取中位数。
    // 若两条都没命中，置信度按 0 处理。
    const verticalSampleCoords = uniqueSampleCoords(width, [
        Math.floor(width / 4),
        Math.floor((width * 3) / 4),
    ]);
    const horizontalSampleCoords = uniqueSampleCoords(height, [
        Math.floor(height / 4),
        Math.floor((height * 3) / 4),
    ]);

    const horizontalSamples: number[] = [];
    const verticalSamples: number[] = [];

    for (const lineF of params.horizontalLines || []) {
        const linePx = Math.round(Number(lineF) * height);
        const measured = measureDividerWidthMulti(
            pixels, width, height, channels, "vertical", verticalSampleCoords, linePx, searchRadius,
        );
        if (measured > 0) horizontalSamples.push(measured);
    }

    for (const lineF of params.verticalLines || []) {
        const linePx = Math.round(Number(lineF) * width);
        const measured = measureDividerWidthMulti(
            pixels, width, height, channels, "horizontal", horizontalSampleCoords, linePx, searchRadius,
        );
        if (measured > 0) verticalSamples.push(measured);
    }

    const totalCuts = (params.horizontalLines?.length || 0) + (params.verticalLines?.length || 0);
    const allSamples = [...horizontalSamples, ...verticalSamples];
    if (!allSamples.length) {
        return {
            lineInset: 0,
            confidence: 0,
            samples: { horizontal: horizontalSamples, vertical: verticalSamples },
            width,
            height,
        };
    }

    const sorted = [...allSamples].sort((a, b) => a - b);
    const lineInset = sorted[Math.floor(sorted.length / 2)];
    const confidence = totalCuts > 0 ? allSamples.length / totalCuts : 0;
    return {
        lineInset,
        confidence,
        samples: { horizontal: horizontalSamples, vertical: verticalSamples },
        width,
        height,
    };
}

function uniqueSampleCoords(limit: number, coords: number[]): number[] {
    const set = new Set<number>();
    for (const coord of coords) {
        const clamped = Math.max(0, Math.min(limit - 1, Math.round(coord)));
        if (clamped >= 0 && clamped < limit) set.add(clamped);
    }
    return [...set];
}

function measureDividerWidthMulti(
    pixels: Buffer,
    width: number,
    height: number,
    channels: number,
    scanlineDir: "vertical" | "horizontal",
    fixedCoords: number[],
    cutPos: number,
    searchRadius: number,
): number {
    const measurements: number[] = [];
    for (const fixedCoord of fixedCoords) {
        const width1 = measureDividerWidth(pixels, width, height, channels, scanlineDir, fixedCoord, cutPos, searchRadius);
        if (width1 > 0) measurements.push(width1);
    }
    if (!measurements.length) return 0;
    measurements.sort((a, b) => a - b);
    return measurements[Math.floor(measurements.length / 2)];
}

function measureDividerWidth(
    pixels: Buffer,
    width: number,
    height: number,
    channels: number,
    scanlineDir: "vertical" | "horizontal",
    fixedCoord: number,
    cutPos: number,
    searchRadius: number,
): number {
    const scanlineLength = scanlineDir === "vertical" ? height : width;
    const start = Math.max(0, Math.round(cutPos) - searchRadius);
    const end = Math.min(scanlineLength, Math.round(cutPos) + searchRadius);
    if (end <= start) return 0;

    const samples: Array<{ r: number; g: number; b: number }> = [];
    for (let i = start; i < end; i += 1) {
        const offset = scanlineDir === "vertical"
            ? (i * width + fixedCoord) * channels
            : (fixedCoord * width + i) * channels;
        samples.push({ r: pixels[offset] ?? 0, g: pixels[offset + 1] ?? 0, b: pixels[offset + 2] ?? 0 });
    }
    if (!samples.length) return 0;

    const contextSize = Math.min(CONTEXT_EDGE_PIXELS, Math.floor(samples.length / 4));
    const contextColors = contextSize > 0 ? [
        ...samples.slice(0, contextSize),
        ...samples.slice(-contextSize),
    ] : samples;
    const contextR = medianOf(contextColors.map((c) => c.r));
    const contextG = medianOf(contextColors.map((c) => c.g));
    const contextB = medianOf(contextColors.map((c) => c.b));

    let maxRun = 0;
    let currentRun = 0;
    for (const sample of samples) {
        const dr = sample.r - contextR;
        const dg = sample.g - contextG;
        const db = sample.b - contextB;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist > COLOR_DISTANCE_THRESHOLD) {
            currentRun += 1;
            if (currentRun > maxRun) maxRun = currentRun;
        } else {
            currentRun = 0;
        }
    }
    return maxRun;
}

function medianOf(arr: number[]): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
