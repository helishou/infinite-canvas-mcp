/**
 * 本地图像计算：像素差异、主色统计与归一化区域裁剪。
 * 只读取 Backend 媒体库已登记的图片字节，不调用视觉模型、不建任务、不绑定画布；
 * 输出图由调用方存入 MediaStore，不在这里维护第二份内容池。
 */
import sharp from "sharp";

/** 归一化区域：四个分量都在 0-1，相对整图宽高。 */
export type NormalizedRegion = { left: number; top: number; width: number; height: number };

/** 像素区域：基于方向校正后的图片像素坐标。 */
export type PixelRect = { left: number; top: number; width: number; height: number };

export type PixelDiffOptions = {
  threshold?: number;
  grid?: number;
  region?: NormalizedRegion;
  includeHeatmap?: boolean;
};

export type ColorOptions = { colorCount?: number; region?: NormalizedRegion };

/** 差异计算的像素上限；超过时按最长边收敛，差异率仍按真实比例统计。 */
const MAX_DIFF_PIXELS = 24_000_000;
const MAX_DIFF_EDGE = 2048;
/** 主色统计的采样上限；只影响统计成本，不影响返回比例的含义。 */
const COLOR_SAMPLE_EDGE = 192;
/** 距离小于该值的主色合并，避免相邻色带拆成多条。 */
const COLOR_MERGE_DISTANCE = 24;

type Rgb = { r: number; g: number; b: number };

function invalid(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 校验并返回 MCP/HTTP 传入的归一化区域；缺省表示整图。 */
export function normalizeRegionInput(value: unknown): NormalizedRegion | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw invalid("region 必须是 {left,top,width,height} 对象", "IMAGE_REGION_INVALID");
  const record = value as Record<string, unknown>;
  const left = finiteNumber(record.left);
  const top = finiteNumber(record.top);
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (left === null || top === null || width === null || height === null)
    throw invalid("region 的 left/top/width/height 必须是数字", "IMAGE_REGION_INVALID");
  if (left < 0 || top < 0 || left > 1 || top > 1 || width <= 0 || height <= 0 || width > 1 || height > 1)
    throw invalid("region 使用 0-1 相对坐标：left/top 在 0-1，width/height 大于 0 且不超过 1", "IMAGE_REGION_INVALID");
  return { left, top, width, height };
}

/** 把归一化区域换算成像素框，超出边界的部分按图片尺寸钳制。 */
export function resolvePixelRect(
  sourceWidth: number,
  sourceHeight: number,
  region?: NormalizedRegion,
): PixelRect {
  if (!sourceWidth || !sourceHeight)
    throw invalid("无法读取图片尺寸；文件可能不是可解码的图片", "UNSUPPORTED_MEDIA");
  const left = Math.min(
    Math.max(0, Math.round((region?.left ?? 0) * sourceWidth)),
    sourceWidth - 1,
  );
  const top = Math.min(
    Math.max(0, Math.round((region?.top ?? 0) * sourceHeight)),
    sourceHeight - 1,
  );
  const width = Math.min(
    Math.max(1, Math.round((region?.width ?? 1) * sourceWidth)),
    sourceWidth - left,
  );
  const height = Math.min(
    Math.max(1, Math.round((region?.height ?? 1) * sourceHeight)),
    sourceHeight - top,
  );
  return { left, top, width, height };
}

/** 读取方向校正后的真实尺寸：带 EXIF 旋转的图片宽高需要交换。 */
async function orientedSize(source: Buffer) {
  const meta = await sharp(source, { failOn: "none" }).metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (!width || !height)
    throw invalid("无法读取图片尺寸；文件可能不是可解码的图片", "UNSUPPORTED_MEDIA");
  const swap = Number(meta.orientation || 1) >= 5;
  return { width: swap ? height : width, height: swap ? width : height };
}

type DecodeOptions = { rect?: PixelRect; size?: { width: number; height: number } };

async function decodeRgb(source: Buffer, options: DecodeOptions = {}) {
  let pipeline = sharp(source, { failOn: "none" }).rotate();
  if (options.rect) pipeline = pipeline.extract(options.rect);
  if (options.size)
    pipeline = pipeline.resize(options.size.width, options.size.height, { fit: "fill" });
  const { data, info } = await pipeline
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels < 3)
    throw invalid(`不支持的像素通道数：${info.channels}`, "UNSUPPORTED_MEDIA");
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export type PixelDiffResult = {
  op: "pixel_diff";
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  compareWidth: number;
  compareHeight: number;
  region: PixelRect;
  aligned: boolean;
  downscaled: boolean;
  threshold: number;
  totalPixels: number;
  differingPixels: number;
  diffRate: number;
  meanDiff: number;
  maxDiff: number;
  grid: {
    cols: number;
    rows: number;
    worst: {
      col: number;
      row: number;
      x: number;
      y: number;
      width: number;
      height: number;
      diffRate: number;
      meanDiff: number;
    };
  };
  /** 仅 includeHeatmap=true 时返回；PNG 字节由调用方存入 MediaStore。 */
  heatmap?: { data: Buffer; width: number; height: number };
};

/** 逐像素比较两张图；不同尺寸时把对照图贴合到主图分析区域，便于首尾帧和接缝检查。 */
export async function pixelDiff(
  baseSource: Buffer,
  compareSource: Buffer,
  options: PixelDiffOptions = {},
): Promise<PixelDiffResult> {
  const threshold = clampInt(options.threshold, 8, 0, 255);
  const grid = clampInt(options.grid, 8, 1, 32);
  const baseSize = await orientedSize(baseSource);
  const compareSize = await orientedSize(compareSource);
  const region = resolvePixelRect(baseSize.width, baseSize.height, options.region);
  const scale = Math.min(
    1,
    MAX_DIFF_EDGE / Math.max(region.width, region.height),
    Math.sqrt(MAX_DIFF_PIXELS / (region.width * region.height)),
  );
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));

  const base = await decodeRgb(baseSource, { rect: region, size: { width, height } });
  const compare = await decodeRgb(compareSource, { size: { width, height } });
  const totalPixels = width * height;
  const cellCounts = new Float64Array(grid * grid);
  const cellSums = new Float64Array(grid * grid);
  const cellDiff = new Uint32Array(grid * grid);
  const heat = options.includeHeatmap ? Buffer.alloc(totalPixels) : null;

  let sum = 0;
  let maxDiff = 0;
  let differingPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(grid - 1, Math.floor((y * grid) / height));
    for (let x = 0; x < width; x += 1) {
      const baseIndex = (y * width + x) * base.channels;
      const compareIndex = (y * width + x) * compare.channels;
      const diff =
        (Math.abs(base.data[baseIndex] - compare.data[compareIndex]) +
          Math.abs(base.data[baseIndex + 1] - compare.data[compareIndex + 1]) +
          Math.abs(base.data[baseIndex + 2] - compare.data[compareIndex + 2])) /
        3;
      const cell = row * grid + Math.min(grid - 1, Math.floor((x * grid) / width));
      cellCounts[cell] += 1;
      cellSums[cell] += diff;
      if (diff > threshold) {
        differingPixels += 1;
        cellDiff[cell] += 1;
      }
      if (diff > maxDiff) maxDiff = diff;
      sum += diff;
      if (heat) heat[y * width + x] = Math.min(255, Math.round(diff * 4));
    }
  }

  let worstCell = 0;
  let worstMean = -1;
  for (let cell = 0; cell < cellCounts.length; cell += 1) {
    const mean = cellCounts[cell] ? cellSums[cell] / cellCounts[cell] : 0;
    if (mean > worstMean) {
      worstMean = mean;
      worstCell = cell;
    }
  }
  const col = worstCell % grid;
  const row = Math.floor(worstCell / grid);

  const result: PixelDiffResult = {
    op: "pixel_diff",
    width,
    height,
    sourceWidth: baseSize.width,
    sourceHeight: baseSize.height,
    compareWidth: compareSize.width,
    compareHeight: compareSize.height,
    region,
    aligned: compareSize.width !== baseSize.width || compareSize.height !== baseSize.height,
    downscaled: scale < 1,
    threshold,
    totalPixels,
    differingPixels,
    diffRate: totalPixels ? differingPixels / totalPixels : 0,
    meanDiff: totalPixels ? sum / totalPixels : 0,
    maxDiff,
    grid: {
      cols: grid,
      rows: grid,
      worst: {
        col,
        row,
        x: col / grid,
        y: row / grid,
        width: 1 / grid,
        height: 1 / grid,
        diffRate: cellCounts[worstCell] ? cellDiff[worstCell] / cellCounts[worstCell] : 0,
        meanDiff: Math.max(0, worstMean),
      },
    },
  };
  if (heat) {
    result.heatmap = {
      data: await sharp(heat, { raw: { width, height, channels: 1 } })
        .toColourspace("b-w")
        .png({ compressionLevel: 9 })
        .toBuffer(),
      width,
      height,
    };
  }
  return result;
}

export type DominantColorsResult = {
  op: "colors";
  sourceWidth: number;
  sourceHeight: number;
  region: PixelRect;
  sampledPixels: number;
  transparentPixels: number;
  coverage: number;
  colors: Array<{ hex: string; rgb: Rgb; ratio: number }>;
};

/** 统计主色与占比：4 位分桶后按距离合并，避免噪声把色带拆碎。 */
export async function dominantColors(
  source: Buffer,
  options: ColorOptions = {},
): Promise<DominantColorsResult> {
  const limit = clampInt(options.colorCount, 8, 1, 24);
  const size = await orientedSize(source);
  const region = resolvePixelRect(size.width, size.height, options.region);
  const scale = Math.min(1, COLOR_SAMPLE_EDGE / Math.max(region.width, region.height));
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));

  const { data, info } = await sharp(source, { failOn: "none" })
    .rotate()
    .extract(region)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  if (channels < 3)
    throw invalid(`不支持的像素通道数：${channels}`, "UNSUPPORTED_MEDIA");

  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let transparentPixels = 0;
  const total = width * height;
  for (let index = 0; index < total; index += 1) {
    const offset = index * channels;
    if (channels >= 4 && data[offset + 3] < 16) {
      transparentPixels += 1;
      continue;
    }
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  const sampledPixels = total - transparentPixels;
  const ordered = [...buckets.values()].sort((a, b) => b.count - a.count);
  const merged: Array<{ count: number; r: number; g: number; b: number }> = [];
  for (const bucket of ordered) {
    const average = {
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
    };
    const near = merged.find(
      (item) =>
        Math.abs(item.r - average.r) + Math.abs(item.g - average.g) + Math.abs(item.b - average.b) <=
        COLOR_MERGE_DISTANCE * 3,
    );
    if (near) {
      const count = near.count + bucket.count;
      near.r = (near.r * near.count + average.r * bucket.count) / count;
      near.g = (near.g * near.count + average.g * bucket.count) / count;
      near.b = (near.b * near.count + average.b * bucket.count) / count;
      near.count = count;
    } else if (merged.length < limit) {
      merged.push({ ...average, count: bucket.count });
    }
  }

  const covered = merged.reduce((sum, item) => sum + item.count, 0);
  return {
    op: "colors",
    sourceWidth: size.width,
    sourceHeight: size.height,
    region,
    sampledPixels,
    transparentPixels,
    coverage: sampledPixels ? covered / sampledPixels : 0,
    colors: merged.map((item) => {
      const rgb = {
        r: Math.round(item.r),
        g: Math.round(item.g),
        b: Math.round(item.b),
      };
      return {
        hex: `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`,
        rgb,
        ratio: sampledPixels ? item.count / sampledPixels : 0,
      };
    }),
  };
}

function hex(value: number) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

export type CropResult = {
  op: "crop";
  data: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  region: PixelRect;
};

/** 按归一化区域裁剪并输出 PNG，像素坐标基于 EXIF 转正后的图片。 */
export async function cropImage(
  source: Buffer,
  region: NormalizedRegion,
): Promise<CropResult> {
  const size = await orientedSize(source);
  const rect = resolvePixelRect(size.width, size.height, region);
  const data = await sharp(source, { failOn: "none" })
    .rotate()
    .extract(rect)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { op: "crop", data, sourceWidth: size.width, sourceHeight: size.height, region: rect };
}
