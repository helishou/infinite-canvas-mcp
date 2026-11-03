/**
 * canvas_image_ops 的业务入口：校验媒体库图片、执行本地计算并组织返回体。
 * 路由只负责 HTTP 状态与错误映射，测试可直接注入 MediaStore 的最小实现。
 */
import type { MediaFile } from "../db.js";
import type { MediaCategory, MediaStats } from "../stores/types.js";
import { cropImage, dominantColors, normalizeRegionInput, pixelDiff } from "./image-ops.js";

export type ImageOpsMedia = {
  meta(storageKey: string): MediaFile | null;
  read(storageKey: string): Promise<Buffer>;
  store(
    data: Buffer,
    options: { name?: string; mimeType?: string; category?: MediaCategory } & MediaStats,
  ): MediaFile;
  url(media: MediaFile): string;
};

export type ImageOpsInput = {
  op?: string;
  storageKey?: string;
  compareKey?: string;
  region?: unknown;
  colorCount?: number;
  threshold?: number;
  grid?: number;
  includeHeatmap?: boolean;
};

const OPS = ["pixel_diff", "colors", "crop"];

function codedError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function findImage(media: ImageOpsMedia, key: string, field: string) {
  const file = key ? media.meta(key) : null;
  if (!file) throw codedError(`${field} 不存在或已清理`, "MEDIA_NOT_FOUND");
  if (!file.mimeType.startsWith("image/"))
    throw codedError(`${field} 不是图片：${file.mimeType}`, "UNSUPPORTED_MEDIA");
  return file;
}

/** 执行一次本地图像计算；返回值就是 MCP/HTTP 的成功响应体。 */
export async function runImageOps(media: ImageOpsMedia, body: ImageOpsInput) {
  const op = String(body.op || "");
  if (!OPS.includes(op))
    throw codedError("op 必须是 pixel_diff、colors 或 crop", "IMAGE_OP_INVALID");

  const storageKey = String(body.storageKey || "").trim();
  const base = findImage(media, storageKey, "storageKey");
  const region = normalizeRegionInput(body.region);
  const source = await media.read(storageKey);

  if (op === "colors") {
    const result = await dominantColors(source, {
      region,
      colorCount: body.colorCount,
    });
    return { ok: true as const, ...result };
  }

  if (op === "crop") {
    if (!region)
      throw codedError("crop 需要 region 指定裁剪区域", "IMAGE_REGION_REQUIRED");
    const result = await cropImage(source, region);
    const stored = media.store(result.data, {
      name: `crop-${base.storageKey.replace(/[^a-z0-9]+/gi, "-")}.png`,
      mimeType: "image/png",
      category: "library",
      width: result.region.width,
      height: result.region.height,
    });
    return {
      ok: true as const,
      op: "crop" as const,
      storageKey: stored.storageKey,
      url: media.url(stored),
      mimeType: stored.mimeType,
      bytes: stored.bytes,
      width: stored.width,
      height: stored.height,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      region: result.region,
    };
  }

  const compareKey = String(body.compareKey || "").trim();
  if (!compareKey)
    throw codedError("pixel_diff 需要 compareKey 指定对照图", "IMAGE_COMPARE_REQUIRED");
  findImage(media, compareKey, "compareKey");
  const compareSource = await media.read(compareKey);
  const result = await pixelDiff(source, compareSource, {
    region,
    threshold: body.threshold,
    grid: body.grid,
    includeHeatmap: body.includeHeatmap === true,
  });
  let heatmap: { storageKey: string; url: string; width: number; height: number } | undefined;
  if (result.heatmap) {
    const stored = media.store(result.heatmap.data, {
      name: "pixel-diff-heatmap.png",
      mimeType: "image/png",
      category: "library",
      width: result.heatmap.width,
      height: result.heatmap.height,
    });
    heatmap = {
      storageKey: stored.storageKey,
      url: media.url(stored),
      width: result.heatmap.width,
      height: result.heatmap.height,
    };
  }
  const summary: Record<string, unknown> = { ...result };
  delete summary.heatmap;
  return { ok: true as const, ...summary, ...(heatmap ? { heatmap } : {}) };
}
