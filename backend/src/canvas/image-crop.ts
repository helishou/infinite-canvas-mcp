/**
 * 画布图片比例裁切：只抽取源图中的像素，不拉伸、不覆盖原媒体。
 * 输出 PNG，便于后续静态锚引用和尺寸审计。
 */
import sharp from "sharp";

export type CropAnchor = "center" | "top" | "bottom" | "left" | "right";

export type CropParams = {
    aspectWidth: number;
    aspectHeight: number;
    anchor?: CropAnchor;
    cropRect?: { left: number; top: number; width: number; height: number };
};

export type CropResult = {
    data: Buffer;
    sourceWidth: number;
    sourceHeight: number;
    left: number;
    top: number;
    width: number;
    height: number;
};

export function parseAspectRatio(value: string | undefined, fallback = { width: 9, height: 16 }) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(String(value || ""));
    const width = Number(match?.[1] || fallback.width);
    const height = Number(match?.[2] || fallback.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`无效画幅比例：${value || ""}`);
    }
    return { width, height };
}

function alignedOffset(remaining: number, anchor: CropAnchor, axis: "x" | "y") {
    if (axis === "x") {
        if (anchor === "left") return 0;
        if (anchor === "right") return remaining;
    } else {
        if (anchor === "top") return 0;
        if (anchor === "bottom") return remaining;
    }
    return Math.floor(remaining / 2);
}

/** 按整数比例取得最大无损比例裁切框，并输出实际像素尺寸。 */
export async function cropImageBuffer(source: Buffer, params: CropParams): Promise<CropResult> {
    const meta = await sharp(source).metadata();
    const sourceWidth = Number(meta.width || 0);
    const sourceHeight = Number(meta.height || 0);
    if (!sourceWidth || !sourceHeight) throw new Error("无法读取源图尺寸，裁切失败");

    let left: number;
    let top: number;
    let width: number;
    let height: number;
    if (params.cropRect) {
        left = Math.floor(params.cropRect.left);
        top = Math.floor(params.cropRect.top);
        width = Math.floor(params.cropRect.width);
        height = Math.floor(params.cropRect.height);
        if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > sourceWidth || top + height > sourceHeight) {
            throw new Error("cropRect 超出源图边界");
        }
        if (width * params.aspectHeight !== height * params.aspectWidth) {
            throw new Error(`cropRect 不是严格 ${params.aspectWidth}:${params.aspectHeight}`);
        }
    } else {
        const unit = Math.floor(Math.min(sourceWidth / params.aspectWidth, sourceHeight / params.aspectHeight));
        if (unit < 1) throw new Error("源图尺寸不足以裁切出目标比例");
        width = params.aspectWidth * unit;
        height = params.aspectHeight * unit;
        const anchor = params.anchor || "center";
        left = alignedOffset(sourceWidth - width, anchor, "x");
        top = alignedOffset(sourceHeight - height, anchor, "y");
    }

    const data = await sharp(source).extract({ left, top, width, height }).png().toBuffer();
    return { data, sourceWidth, sourceHeight, left, top, width, height };
}
