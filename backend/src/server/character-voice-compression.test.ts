import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";
import { createStores } from "../stores/index.js";
import { CHARACTER_VOICE_COMPRESSION_THRESHOLD_BYTES, prepareCharacterVoiceUpload } from "./character-voice-compression.js";

test("角色声线不超过 0.5 MB 时保持原格式，也不调用编码器", async () => {
  const body = Buffer.alloc(CHARACTER_VOICE_COMPRESSION_THRESHOLD_BYTES);
  const result = await prepareCharacterVoiceUpload(body, "voice.wav", "audio/wav", async () => { throw new Error("不应编码"); });
  assert.equal(result.body, body);
  assert.equal(result.name, "voice.wav");
  assert.equal(result.compressed, false);
});

test("角色声线超过 0.5 MB 时压成较小 MP3，普通类型不能冒充声线", async () => {
  const body = Buffer.alloc(CHARACTER_VOICE_COMPRESSION_THRESHOLD_BYTES + 1);
  const encoded = Buffer.from("encoded audio");
  const result = await prepareCharacterVoiceUpload(body, "voice.wav", "audio/wav", async () => encoded);
  assert.equal(result.body, encoded);
  assert.equal(result.name, "voice-24k-64kbps.mp3");
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.originalBytes, body.length);
  assert.equal(result.compressed, true);
  await assert.rejects(() => prepareCharacterVoiceUpload(body, "image.png", "image/png", async () => encoded), /音频文件/);
});

test("角色声线专用上传会压缩并保留原件，普通媒体上传保持原样", async (t) => {
  if (spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { windowsHide: true }).status !== 0) {
    t.skip("ffmpeg 不可用");
    return;
  }
  const db = new BackendDatabase(":memory:");
  const stores = createStores(db);
  const written: Array<{ bytes: number; mimeType: string }> = [];
  const media = {
    ...stores.media,
    store(data: Buffer, options: { mimeType: string; durationMs?: number | null }) {
      written.push({ bytes: data.length, mimeType: options.mimeType });
      return { storageKey: `audio:test-${written.length}`, filePath: "test", mimeType: options.mimeType, bytes: data.length, width: null, height: null, durationMs: options.durationMs ?? null, createdAt: new Date().toISOString() };
    },
    url(record: { storageKey: string }) { return `/media/${encodeURIComponent(record.storageKey)}`; },
  } as typeof stores.media;
  const app = startServer(db, { url: "http://127.0.0.1", token: "test-secret", port: 0, origins: [] }, { stores: { ...stores, media } }).app;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const wav = Buffer.alloc(44 + 270_000 * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  const headers = { authorization: "Bearer test-secret", "content-type": "audio/wav", "x-media-name": "voice.wav" };
  const voiceResponse = await fetch(`${base}/media/character-voice`, { method: "POST", headers, body: new Uint8Array(wav) });
  assert.equal(voiceResponse.status, 201);
  const voice = await voiceResponse.json() as { media: { bytes: number; mimeType: string; compression: { originalBytes: number; originalStorageKey: string } } };
  assert.equal(voice.media.mimeType, "audio/mpeg");
  assert.ok(voice.media.bytes < wav.length);
  assert.equal(voice.media.compression.originalBytes, wav.length);
  assert.equal(written.length, 2);
  assert.deepEqual(written.map((item) => item.mimeType), ["audio/wav", "audio/mpeg"]);

  const unauthorized = await fetch(`${base}/media/character-voice`, { method: "POST", headers: { "content-type": "audio/wav", "x-media-name": "voice.wav" }, body: new Uint8Array(wav) });
  assert.equal(unauthorized.status, 401);
  assert.equal(written.length, 2);

  const smallWav = Buffer.from(wav.subarray(0, 44 + 24_000 * 2));
  smallWav.writeUInt32LE(smallWav.length - 8, 4);
  smallWav.writeUInt32LE(smallWav.length - 44, 40);
  const smallResponse = await fetch(`${base}/media/character-voice`, { method: "POST", headers, body: new Uint8Array(smallWav) });
  assert.equal(smallResponse.status, 201);
  const small = await smallResponse.json() as { media: { bytes: number; mimeType: string; compression?: unknown } };
  assert.equal(small.media.bytes, smallWav.length);
  assert.equal(small.media.mimeType, "audio/wav");
  assert.equal(small.media.compression, undefined);

  const ordinaryResponse = await fetch(`${base}/media/upload-binary`, { method: "POST", headers, body: new Uint8Array(wav) });
  assert.equal(ordinaryResponse.status, 201);
  const ordinary = await ordinaryResponse.json() as { media: { bytes: number; mimeType: string } };
  assert.equal(ordinary.media.bytes, wav.length);
  assert.equal(ordinary.media.mimeType, "audio/wav");
  assert.equal(written.length, 4);
});
