import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { cropImageBuffer, parseAspectRatio } from "./image-crop.js";

test("严格 9:16 裁切取最大整数比例区域，不拉伸", async () => {
    const source = await sharp({
        create: { width: 1024, height: 1536, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).png().toBuffer();
    const ratio = parseAspectRatio("9:16");
    const result = await cropImageBuffer(source, { aspectWidth: ratio.width, aspectHeight: ratio.height, anchor: "center" });
    assert.deepEqual(
        { left: result.left, top: result.top, width: result.width, height: result.height },
        { left: 80, top: 0, width: 864, height: 1536 },
    );
    const meta = await sharp(result.data).metadata();
    assert.equal(meta.width, 864);
    assert.equal(meta.height, 1536);
});

test("非整除源图也裁成严格整数 9:16", async () => {
    const source = await sharp({
        create: { width: 941, height: 1672, channels: 3, background: { r: 80, g: 20, b: 40 } },
    }).png().toBuffer();
    const ratio = parseAspectRatio("9:16");
    const result = await cropImageBuffer(source, { aspectWidth: ratio.width, aspectHeight: ratio.height, anchor: "center" });
    assert.deepEqual(
        { left: result.left, top: result.top, width: result.width, height: result.height },
        { left: 2, top: 4, width: 936, height: 1664 },
    );
    assert.equal(result.width * 16, result.height * 9);
});

test("精确 cropRect 必须匹配目标比例", async () => {
    const source = await sharp({
        create: { width: 100, height: 100, channels: 3, background: "white" },
    }).png().toBuffer();
    const ratio = parseAspectRatio("9:16");
    await assert.rejects(
        cropImageBuffer(source, {
            aspectWidth: ratio.width,
            aspectHeight: ratio.height,
            cropRect: { left: 0, top: 0, width: 50, height: 50 },
        }),
        /不是严格 9:16/,
    );
});
