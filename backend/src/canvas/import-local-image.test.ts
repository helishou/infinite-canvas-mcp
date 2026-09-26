import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COUNT,
  mimeTypeForPath,
  normalizeImportSources,
  probeImageSize,
  readImportableImage,
} from "./import-local-image.js";

/** 造一张真实的最小 PNG（1x1 红点，IHDR 尺寸可参数化）。 */
function makePng(width: number, height: number): Buffer {
  const chunks: Buffer[] = [];
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type RGB
  const ihdr = Buffer.concat([Buffer.from("IHDR", "ascii"), ihdrData]);
  const crc = (buf: Buffer): Buffer => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return Buffer.from([(~c) >>> 24 & 0xff, (~c) >>> 16 & 0xff, (~c) >>> 8 & 0xff, ~c & 0xff]);
  };
  const idat = Buffer.concat([Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])]);
  chunks.push(signature);
  chunks.push(Buffer.concat([Buffer.alloc(4), ihdr, crc(ihdr)]));
  chunks.push(Buffer.concat([Buffer.alloc(4), Buffer.from("IDAT", "ascii"), idat, crc(idat)]));
  chunks.push(Buffer.concat([Buffer.alloc(4), Buffer.from("IEND", "ascii"), crc(Buffer.from("IEND", "ascii"))]));
  return Buffer.concat(chunks);
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "canvas-import-"));
}

test("mimeTypeForPath 按扩展名返回，不猜", () => {
  assert.equal(mimeTypeForPath("a/b/shot.PNG"), "image/png");
  assert.equal(mimeTypeForPath("a/b/shot.jpeg"), "image/jpeg");
  assert.equal(mimeTypeForPath("a/b/shot.webp"), "image/webp");
  assert.throws(() => mimeTypeForPath("a/b/clip.mp4"), /不支持的图片格式/);
  assert.throws(() => mimeTypeForPath("a/b/noext"), /不支持的图片格式/);
});

test("probeImageSize 读 PNG 真实 IHDR 尺寸", () => {
  assert.deepEqual(probeImageSize(makePng(1216, 672)), { width: 1216, height: 672 });
  assert.deepEqual(probeImageSize(makePng(4, 4)), { width: 4, height: 4 });
});

test("probeImageSize 对非 PNG 不崩，退回 0x0", () => {
  assert.deepEqual(probeImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { width: 0, height: 0 });
  assert.deepEqual(probeImageSize(Buffer.alloc(4)), { width: 0, height: 0 });
});

test("readImportableImage 读回字节与尺寸", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "shot_01.png");
  await fs.writeFile(file, makePng(1216, 672));
  const prepared = await readImportableImage({ filePath: file });
  assert.equal(prepared.mimeType, "image/png");
  assert.equal(prepared.name, "shot_01.png");
  assert.ok(prepared.bytes > 0);
  assert.deepEqual(probeImageSize(prepared.data), { width: 1216, height: 672 });
  await fs.rm(dir, { recursive: true, force: true });
});

test("readImportableImage 拒绝不存在 / 空 / 非图片", async () => {
  const dir = await tmpDir();
  await assert.rejects(readImportableImage({ filePath: path.join(dir, "nope.png") }), /找不到文件/);
  const empty = path.join(dir, "empty.png");
  await fs.writeFile(empty, Buffer.alloc(0));
  await assert.rejects(readImportableImage({ filePath: empty }), /文件为空/);
  const clip = path.join(dir, "a.mp4");
  await fs.writeFile(clip, Buffer.alloc(16));
  await assert.rejects(readImportableImage({ filePath: clip }), /不支持的图片格式/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("readImportableImage 拒绝超过上限", async () => {
  const dir = await tmpDir();
  const big = path.join(dir, "big.png");
  await fs.writeFile(big, Buffer.alloc(MAX_IMPORT_BYTES + 1));
  await assert.rejects(readImportableImage({ filePath: big }), /文件超过上限/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("normalizeImportSources 接受字符串与对象，去重保序", () => {
  const out = normalizeImportSources([
    "C:/a/1.png",
    { filePath: "C:/a/2.png", title: "镜02" },
    "C:/a/1.png",
    "C:\\a\\1.png",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].filePath, "C:/a/1.png");
  assert.equal(out[1].title, "镜02");
});

test("normalizeImportSources 拒绝空与超量与缺字段", () => {
  assert.throws(() => normalizeImportSources([]), /至少传一个/);
  assert.throws(() => normalizeImportSources("x"), /至少传一个/);
  assert.throws(() => normalizeImportSources([{ title: "无路径" }]), /缺少 filePath/);
  const many = Array.from({ length: MAX_IMPORT_COUNT + 1 }, (_, i) => `C:/a/${i}.png`);
  assert.throws(() => normalizeImportSources(many), /一次最多导入/);
});
