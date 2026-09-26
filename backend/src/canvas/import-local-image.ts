/**
 * 从本地磁盘导入图片为画布媒体。
 *
 * 背景：assets_add 用 dataURL 入库时，图片只进 assets 表的 cover_url/data_json，
 * 不进 media_files，也没有 storageKey —— 素材库能看，但生成管线只认 storageKey，
 * 所以这种图当不了生成参考。本模块负责把本地文件真正落成媒体。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 允许导入的图片 MIME → 扩展名。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
};

/** 单个文件大小上限，与 Backend 媒体上传保持一致的保守值（32 MiB）。 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** 批量导入的默认上限，避免一次把 MCP 输出撑爆。 */
export const MAX_IMPORT_COUNT = 64;

export type ImportSource = {
  /** 本地绝对路径。 */
  filePath: string;
  /** 画布节点标题；不传则用文件名。 */
  title?: string;
};

export type PreparedImage = {
  filePath: string;
  name: string;
  mimeType: string;
  data: Buffer;
  bytes: number;
};

/** 从扩展名推 MIME；不认识就抛错，不猜。 */
export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `不支持的图片格式：${ext || "(无扩展名)"}；支持 ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}`,
    );
  }
  return mime;
}

/** 探测 PNG / JPEG / WebP / GIF 的像素尺寸，不引额外依赖。 */
export function probeImageSize(data: Buffer): { width: number; height: number } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const size = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
    // 截断或非标准 JPEG：探测不出来不是致命错误，媒体照样能落库。
  }
  if (data.length >= 30 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    const format = data.subarray(12, 16).toString("ascii");
    if (format === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (format === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === "VP8X") {
      const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
      const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
      return { width, height };
    }
  }
  if (data.length >= 10 && data.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  // 探测不出来不是致命错误：媒体照样能落库，画布按节点尺寸渲染。
  return { width: 0, height: 0 };
}

/** 校验并读取一个本地图片文件。 */
export async function readImportableImage(source: ImportSource): Promise<PreparedImage> {
  const filePath = path.resolve(source.filePath);
  const mimeType = mimeTypeForPath(filePath);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new Error(`找不到文件：${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
  if (stat.size === 0) throw new Error(`文件为空：${filePath}`);
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `文件超过上限：${filePath}（${(stat.size / 1024 / 1024).toFixed(1)} MiB > ${MAX_IMPORT_BYTES / 1024 / 1024} MiB）`,
    );
  }
  const data = await fs.readFile(filePath);
  return {
    filePath,
    name: path.basename(filePath),
    mimeType,
    data,
    bytes: data.length,
  };
}

/** 规范化批量输入：接受字符串路径或 {filePath,title} 对象，去重并保序。 */
export function normalizeImportSources(input: unknown): ImportSource[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("items 至少传一个本地图片路径");
  }
  if (input.length > MAX_IMPORT_COUNT) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_COUNT} 张，收到 ${input.length}`);
  }
  const seen = new Set<string>();
  const out: ImportSource[] = [];
  for (const [index, entry] of input.entries()) {
    const source: ImportSource =
      typeof entry === "string"
        ? { filePath: entry }
        : { filePath: String((entry as Record<string, unknown>)?.filePath || ""), title: String((entry as Record<string, unknown>)?.title || "") || undefined };
    if (!source.filePath) throw new Error(`items[${index}] 缺少 filePath`);
    const key = path.resolve(source.filePath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}
