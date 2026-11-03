import sharp from "sharp";

/**
 * 模型视觉输入的统一归一化边界。
 *
 * 同一份字节会经过 Agent 历史展开、用户附件上传、Backend 文本执行器等多条路径，
 * 都在这里统一处理：EXIF 转正、转 sRGB、限制最长边与体积，避免各入口各写一套。
 */
export const MODEL_IMAGE_MAX_EDGE = 1600;
export const MODEL_IMAGE_MAX_BYTES = 900 * 1024;
export const MODEL_IMAGE_QUALITIES = [80, 74, 68, 62] as const;

const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/;
const PASSTHROUGH_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** data URL 的实际字节数；非 data URL 只按字符串长度估算，用于历史预算。 */
export function dataUrlBytes(dataUrl: string): number {
    const match = DATA_URL.exec(dataUrl);
    if (!match) return dataUrl.length;
    const base64 = match[2].trim();
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 归一化图片 data URL。已经满足限制的 jpeg/png/webp 原样返回，避免无谓重编码。
 * 解码失败（损坏、格式不支持、sharp 不可用）时返回原值：宁可让模型收到原图，也不阻断发图。
 */
export async function normalizeImageDataUrl(dataUrl: string): Promise<string> {
    const match = DATA_URL.exec(dataUrl);
    if (!match || !match[1].toLowerCase().startsWith("image/")) return dataUrl;
    const input = Buffer.from(match[2], "base64");
    if (!input.length) return dataUrl;
    try {
        const meta = await sharp(input).metadata();
        const longestEdge = Math.max(Number(meta.width || 0), Number(meta.height || 0));
        const orientation = Number(meta.orientation || 1);
        if (PASSTHROUGH_MIME.has(match[1].toLowerCase()) && input.length <= MODEL_IMAGE_MAX_BYTES && longestEdge <= MODEL_IMAGE_MAX_EDGE && orientation === 1) return dataUrl;

        // rotate() 按 EXIF 自动转正；flatten 把透明区域铺白，避免转 JPEG 后出现黑底。
        const pipeline = sharp(input).rotate().toColourspace("srgb").flatten({ background: "#ffffff" });
        let smallest: Buffer | undefined;
        // 质量阶梯压不到目标体积时，再把最长边降到 1024 重试一轮；仍是最大压缩结果兜底。
        for (const edge of [MODEL_IMAGE_MAX_EDGE, 1024]) {
            for (const quality of MODEL_IMAGE_QUALITIES) {
                const output = await pipeline.clone()
                    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
                    .jpeg({ quality, chromaSubsampling: "4:2:0" })
                    .toBuffer();
                if (output.length <= MODEL_IMAGE_MAX_BYTES) return `data:image/jpeg;base64,${output.toString("base64")}`;
                if (!smallest || output.length < smallest.length) smallest = output;
            }
        }
        return smallest ? `data:image/jpeg;base64,${smallest.toString("base64")}` : dataUrl;
    } catch {
        return dataUrl;
    }
}
