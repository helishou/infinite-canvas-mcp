import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { CAMERA_LIBRARY_MEDIA_PATH, readCameraLibrary, registerCameraLibraryRoutes, resolveCameraLibraryRoot } from "./camera-library.js";

const index = readCameraLibrary();
const skip = index.available ? false : "acheng-director 镜头库未安装";
let server: Server | undefined;
let base = "";

before(async () => {
    if (skip) return;
    const app = express();
    registerCameraLibraryRoutes(app);
    await new Promise<void>(resolve => {
        server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server!.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
});

test("镜头库索引来自 acheng-director skill 且 132 段视频全部可用", { skip }, () => {
    assert.ok(resolveCameraLibraryRoot(), "应能定位 skill 根目录");
    assert.equal(index.count, 132);
    assert.equal(index.categories.length, 8);
    assert.equal(index.categories.reduce((sum, category) => sum + category.count, 0), 132);
    const first = index.moves[0];
    assert.equal(first.id, "001");
    assert.equal(first.nameZh, "推");
    assert.equal(first.nameEn, "Dolly In");
    assert.equal(first.category, "basic");
    assert.equal(first.file, "01_dolly_in.mp4");
    assert.equal(first.url, `${CAMERA_LIBRARY_MEDIA_PATH}/01_dolly_in.mp4`);
    assert.equal(first.duration, 4);
    assert.equal(first.available, true);
    assert.equal(index.moves.at(-1)?.id, "132");
    assert.equal(index.moves.filter(move => !move.available).length, 0);
    assert.equal(new Set(index.moves.map(move => move.id)).size, 132);
});

test("GET /camera-library/moves 返回完整清单", { skip }, async () => {
    const response = await fetch(`${base}/camera-library/moves`);
    assert.equal(response.status, 200);
    const payload = await response.json() as typeof index;
    assert.equal(payload.ok, true);
    assert.equal(payload.available, true);
    assert.equal(payload.count, 132);
    assert.equal(payload.moves.length, 132);
    assert.equal(payload.mediaBase, CAMERA_LIBRARY_MEDIA_PATH);
});

test("镜头视频支持完整响应与 Range 分段", { skip }, async () => {
    const first = index.moves[0];
    const full = await fetch(`${base}${first.url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(first.size));
    const fullBody = Buffer.from(await full.arrayBuffer());
    assert.equal(fullBody.length, first.size);
    assert.equal(fullBody.subarray(4, 8).toString("ascii"), "ftyp", "应为 mp4 容器");

    const partial = await fetch(`${base}${first.url}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-99/${first.size}`);
    assert.equal(partial.headers.get("content-length"), "100");
    const chunk = Buffer.from(await partial.arrayBuffer());
    assert.equal(chunk.length, 100);
    assert.deepEqual(chunk, fullBody.subarray(0, 100));
});

test("非法 Range 与未登记文件名被拒绝", { skip }, async () => {
    const badRange = await fetch(`${base}${index.moves[0].url}`, { headers: { Range: "bytes=99999999-" } });
    assert.equal(badRange.status, 416);
    assert.equal(badRange.headers.get("content-range"), `bytes */${index.moves[0].size}`);

    const unknown = await fetch(`${base}${CAMERA_LIBRARY_MEDIA_PATH}/999_not_registered.mp4`);
    assert.equal(unknown.status, 404);

    const traversal = await fetch(`${base}${CAMERA_LIBRARY_MEDIA_PATH}/..%2F..%2Fmanifest.json`);
    assert.ok([400, 404].includes(traversal.status));
});
