import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import { MODEL_IMAGE_MAX_BYTES, MODEL_IMAGE_MAX_EDGE, dataUrlBytes, normalizeImageDataUrl } from "./image-input.js";

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

async function solidPng(width: number, height: number): Promise<string> {
    return dataUrl("image/png", await sharp({ create: { width, height, channels: 3, background: { r: 190, g: 120, b: 60 } } }).png().toBuffer());
}

test("已满足限制的 jpeg/png/webp 原样返回，不做无谓重编码", async () => {
    const png = await solidPng(40, 30);
    assert.equal(await normalizeImageDataUrl(png), png, "小图必须逐字节透传");
    const webp = dataUrl("image/webp", await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer());
    assert.equal(await normalizeImageDataUrl(webp), webp);
});

test("非图片 data URL 与非法字节按原值放行，不阻断发图", async () => {
    const text = "data:text/plain;base64,aGVsbG8=";
    assert.equal(await normalizeImageDataUrl(text), text);
    const broken = "data:image/png;base64,AAAA";
    assert.equal(await normalizeImageDataUrl(broken), broken);
});

test("超长边图片缩到限制内并转为 JPEG", async () => {
    const source = await solidPng(2400, 1200);
    const output = await normalizeImageDataUrl(source);
    assert.ok(output.startsWith("data:image/jpeg;base64,"), "重编码后统一为 JPEG");
    const meta = await sharp(Buffer.from(output.split(",")[1], "base64")).metadata();
    assert.equal(meta.width, MODEL_IMAGE_MAX_EDGE);
    assert.equal(meta.height, 800);
});

test("EXIF orientation 会被转正", async () => {
    const oriented = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
    const source = dataUrl("image/jpeg", oriented);
    assert.equal((await sharp(oriented).metadata()).orientation, 6, "测试输入确实带 EXIF 方向");
    const output = await normalizeImageDataUrl(source);
    const meta = await sharp(Buffer.from(output.split(",")[1], "base64")).metadata();
    assert.equal(meta.orientation, undefined, "输出不再带未应用的方向标记");
    assert.equal(meta.width, 20);
    assert.equal(meta.height, 40);
});

test("超过体积上限的图片压到 900KB 以内", async () => {
    const noise = crypto.randomBytes(1400 * 1400 * 3);
    const source = dataUrl("image/jpeg", await sharp(noise, { raw: { width: 1400, height: 1400, channels: 3 } }).jpeg({ quality: 100 }).toBuffer());
    assert.ok(dataUrlBytes(source) > MODEL_IMAGE_MAX_BYTES, "测试输入确实超过上限");
    const output = await normalizeImageDataUrl(source);
    assert.ok(dataUrlBytes(output) <= MODEL_IMAGE_MAX_BYTES, `压缩结果 ${dataUrlBytes(output)} 字节`);
    const meta = await sharp(Buffer.from(output.split(",")[1], "base64")).metadata();
    assert.ok(Math.max(Number(meta.width), Number(meta.height)) <= MODEL_IMAGE_MAX_EDGE);
});

test("dataUrlBytes 按 base64 实际字节计算", () => {
    assert.equal(dataUrlBytes("data:image/png;base64,AA=="), 1);
    assert.equal(dataUrlBytes("data:image/png;base64,AAAA"), 3);
    assert.equal(dataUrlBytes("plain"), 5, "非 data URL 退回字符串长度，用于历史预算估算");
});
