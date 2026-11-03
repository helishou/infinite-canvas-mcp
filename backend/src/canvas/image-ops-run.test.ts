import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import type { MediaFile } from "../db.js";
import type { MediaStats } from "../stores/types.js";
import { runImageOps, type ImageOpsMedia } from "./image-ops-run.js";

async function rawImage(width: number, height: number, rgb: number[]) {
  const data = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = rgb[0];
    data[index * 3 + 1] = rgb[1];
    data[index * 3 + 2] = rgb[2];
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

type Entry = { file: MediaFile; data: Buffer };

function mediaStub(entries: Record<string, Entry>) {
  const stored: Array<{ file: MediaFile; data: Buffer }> = [];
  let counter = 0;
  const media: ImageOpsMedia & { stored: typeof stored } = {
    stored,
    meta: (key) => entries[key]?.file || null,
    read: async (key) => {
      const entry = entries[key];
      if (!entry) throw new Error("missing bytes");
      return entry.data;
    },
    store: (data: Buffer, options: { name?: string; mimeType?: string; category?: string } & MediaStats) => {
      counter += 1;
      const file: MediaFile = {
        storageKey: `stored-${counter}`,
        filePath: `stored-${counter}.png`,
        mimeType: options.mimeType || "image/png",
        bytes: data.length,
        width: options.width ?? null,
        height: options.height ?? null,
        durationMs: options.durationMs ?? null,
        createdAt: new Date(0).toISOString(),
      };
      stored.push({ file, data });
      return file;
    },
    url: (file) => `/media/${file.storageKey}`,
  };
  return media;
}

function entry(key: string, mimeType: string, data: Buffer): Entry {
  return {
    file: {
      storageKey: key,
      filePath: `${key}.bin`,
      mimeType,
      bytes: data.length,
      width: null,
      height: null,
      durationMs: null,
      createdAt: new Date(0).toISOString(),
    },
    data,
  };
}

test("runImageOps 拒绝未知 storageKey", async () => {
  const media = mediaStub({});
  await assert.rejects(runImageOps(media, { op: "colors", storageKey: "missing" }), {
    code: "MEDIA_NOT_FOUND",
  });
});

test("runImageOps 拒绝非图片媒体", async () => {
  const media = mediaStub({ video: entry("video", "video/mp4", Buffer.from("x")) });
  await assert.rejects(runImageOps(media, { op: "colors", storageKey: "video" }), {
    code: "UNSUPPORTED_MEDIA",
  });
});

test("runImageOps 拒绝未知 op 与 pixel_diff 缺少对照图", async () => {
  const image = await rawImage(8, 8, [255, 0, 0]);
  const media = mediaStub({ base: entry("base", "image/png", image) });
  await assert.rejects(runImageOps(media, { op: "blur", storageKey: "base" }), {
    code: "IMAGE_OP_INVALID",
  });
  await assert.rejects(runImageOps(media, { op: "pixel_diff", storageKey: "base" }), {
    code: "IMAGE_COMPARE_REQUIRED",
  });
});

test("runImageOps colors 返回主色且不写入媒体", async () => {
  const image = await rawImage(16, 16, [0, 0, 255]);
  const media = mediaStub({ base: entry("base", "image/png", image) });
  const result = await runImageOps(media, { op: "colors", storageKey: "base", colorCount: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.op, "colors");
  assert.equal(media.stored.length, 0);
  const colors = (result as { colors: Array<{ hex: string }> }).colors;
  assert.equal(colors.length, 1);
  assert.equal(colors[0].hex, "#0000ff");
});

test("runImageOps crop 要求 region，成功时写入媒体并返回 storageKey", async () => {
  const image = await rawImage(20, 10, [10, 20, 30]);
  const media = mediaStub({ base: entry("base", "image/png", image) });
  await assert.rejects(runImageOps(media, { op: "crop", storageKey: "base" }), {
    code: "IMAGE_REGION_REQUIRED",
  });
  const result = await runImageOps(media, {
    op: "crop",
    storageKey: "base",
    region: { left: 0, top: 0, width: 0.5, height: 0.5 },
  });
  assert.equal(result.ok, true);
  assert.equal(media.stored.length, 1);
  assert.equal(
    (result as { storageKey: string }).storageKey,
    media.stored[0].file.storageKey,
  );
  assert.equal((result as { url: string }).url, "/media/stored-1");
  assert.equal((result as { width: number }).width, 10);
  assert.equal((result as { height: number }).height, 5);
  assert.deepEqual((result as { region: unknown }).region, {
    left: 0,
    top: 0,
    width: 10,
    height: 5,
  });
  const meta = await sharp(media.stored[0].data).metadata();
  assert.equal(meta.format, "png");
});

test("runImageOps pixel_diff 可选热力图写入媒体，返回体不含字节", async () => {
  const base = await rawImage(12, 6, [255, 255, 255]);
  const compare = await rawImage(12, 6, [0, 0, 0]);
  const media = mediaStub({
    base: entry("base", "image/png", base),
    compare: entry("compare", "image/png", compare),
  });
  const result = await runImageOps(media, {
    op: "pixel_diff",
    storageKey: "base",
    compareKey: "compare",
    includeHeatmap: true,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { diffRate: number }).diffRate, 1);
  assert.equal(media.stored.length, 1);
  const heatmap = (result as { heatmap: { storageKey: string; width: number } }).heatmap;
  assert.equal(heatmap.storageKey, "stored-1");
  assert.equal(heatmap.width, 12);
  assert.equal("data" in (result as Record<string, unknown>), false);
  assert.equal("heatmap" in result && "data" in (heatmap as Record<string, unknown>), false);
});
