import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  cropImage,
  dominantColors,
  normalizeRegionInput,
  pixelDiff,
} from "./image-ops.js";

async function rawImage(
  width: number,
  height: number,
  channels: 3 | 4,
  fill: (x: number, y: number) => number[],
) {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const [r, g, b, a] = fill(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      if (channels === 4) data[offset + 3] = a ?? 255;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

test("pixel_diff 相同图片差异率为 0", async () => {
  const image = await rawImage(64, 48, 3, () => [120, 130, 140]);
  const result = await pixelDiff(image, image);
  assert.equal(result.diffRate, 0);
  assert.equal(result.meanDiff, 0);
  assert.equal(result.maxDiff, 0);
  assert.equal(result.aligned, false);
  assert.equal(result.downscaled, false);
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
});

test("pixel_diff 黑白对比差异率为 1，网格最差区域命中改动象限", async () => {
  const base = await rawImage(100, 100, 3, () => [255, 255, 255]);
  const compare = await rawImage(100, 100, 3, (x, y) =>
    x < 50 && y < 50 ? [0, 0, 0] : [255, 255, 255],
  );
  const result = await pixelDiff(base, compare, { grid: 2 });
  assert.equal(result.diffRate, 0.25);
  assert.equal(result.maxDiff, 255);
  assert.equal(result.grid.worst.col, 0);
  assert.equal(result.grid.worst.row, 0);
  assert.equal(result.grid.worst.x, 0);
  assert.equal(result.grid.worst.y, 0);
  assert.equal(result.grid.worst.diffRate, 1);
  assert.equal(result.grid.worst.width, 0.5);
});

test("pixel_diff 只统计区域像素，并标记对照图贴合", async () => {
  const base = await rawImage(100, 100, 3, () => [255, 255, 255]);
  const compare = await rawImage(50, 50, 3, () => [0, 0, 0]);
  const result = await pixelDiff(base, compare, {
    region: { left: 0, top: 0, width: 0.5, height: 0.5 },
  });
  assert.equal(result.region.left, 0);
  assert.equal(result.region.width, 50);
  assert.equal(result.region.height, 50);
  assert.equal(result.width, 50);
  assert.equal(result.height, 50);
  assert.equal(result.diffRate, 1);
  assert.equal(result.aligned, true);
});

test("pixel_diff 热力图是等尺寸 PNG", async () => {
  const base = await rawImage(40, 30, 3, () => [255, 255, 255]);
  const compare = await rawImage(40, 30, 3, () => [0, 0, 0]);
  const result = await pixelDiff(base, compare, { includeHeatmap: true });
  assert.ok(result.heatmap);
  const meta = await sharp(result.heatmap!.data).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 40);
  assert.equal(meta.height, 30);
  assert.equal(meta.channels, 1);
});

test("colors 纯色主色占比为 1", async () => {
  const image = await rawImage(64, 64, 3, () => [255, 0, 0]);
  const result = await dominantColors(image, { colorCount: 4 });
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].hex, "#ff0000");
  assert.deepEqual(result.colors[0].rgb, { r: 255, g: 0, b: 0 });
  assert.equal(result.colors[0].ratio, 1);
  assert.equal(result.coverage, 1);
  assert.equal(result.transparentPixels, 0);
});

test("colors 跳过透明像素并限制返回数量", async () => {
  const image = await rawImage(64, 64, 4, (x) =>
    x < 32 ? [255, 0, 0, 0] : [0, 0, 255, 255],
  );
  const result = await dominantColors(image, { colorCount: 1 });
  assert.equal(result.transparentPixels, 64 * 32);
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].hex, "#0000ff");
  assert.equal(result.colors[0].ratio, 1);
});

test("crop 越界区域按图片尺寸钳制并输出 PNG", async () => {
  const image = await rawImage(100, 80, 3, () => [10, 20, 30]);
  const result = await cropImage(image, {
    left: 0.9,
    top: 0.9,
    width: 0.5,
    height: 0.5,
  });
  assert.deepEqual(result.region, { left: 90, top: 72, width: 10, height: 8 });
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 10);
  assert.equal(meta.height, 8);
});

test("normalizeRegionInput 拒绝越界坐标并保留整数比例", () => {
  assert.deepEqual(normalizeRegionInput({ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }), {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.4,
  });
  assert.equal(normalizeRegionInput(undefined), undefined);
  assert.throws(
    () => normalizeRegionInput({ left: -0.1, top: 0, width: 1, height: 1 }),
    /region/,
  );
  assert.throws(
    () => normalizeRegionInput({ left: 0, top: 0, width: 0, height: 1 }),
    /region/,
  );
});
