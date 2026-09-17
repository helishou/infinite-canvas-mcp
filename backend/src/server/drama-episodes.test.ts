import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("drama episode REST：剧目、分集、画布三层关系可读写", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-episodes-http-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] });
    const server = app.listen(0);
    context.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (method: string, requestPath: string, body?: unknown) => {
        const response = await fetch(`${base}${requestPath}${requestPath.includes("?") ? "&" : "?"}token=test-token`, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    const drama = await request("POST", "/canvas/folders", { id: "drama-1", name: "剧目一", createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(drama.status, 201);
    const canvas1 = await request("POST", "/canvas/projects", { id: "canvas-1", title: "第一集画布", folderId: "drama-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], connections: [] });
    assert.equal(canvas1.status, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(canvas1.body.project, "folderId"), false);
    const canvas2 = await request("POST", "/canvas/projects", { id: "canvas-2", title: "第二集画布", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], connections: [] });
    assert.equal(canvas2.status, 201);

    const created = await request("POST", "/drama/projects/drama-1/episodes", { episodeNumber: 1, title: "第一集", synopsis: "退婚夜", fullPlot: "沈昭宁退婚后潜入书房，找到密令。", canvasId: "canvas-1" });
    assert.equal(created.status, 201);
    const episode = created.body.episode as Record<string, unknown>;
    assert.equal(episode.dramaId, "drama-1");
    assert.equal(episode.canvasId, "canvas-1");
    assert.equal(episode.fullPlot, "沈昭宁退婚后潜入书房，找到密令。");
    const canvasDrama = await request("GET", "/canvas/projects/canvas-1/drama");
    assert.equal(canvasDrama.status, 200);
    assert.equal((canvasDrama.body.episode as Record<string, unknown>).dramaId, "drama-1");
    assert.equal((canvasDrama.body.drama as Record<string, unknown>).name, "剧目一");

    const listed = await request("GET", "/drama/projects/drama-1/episodes");
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body.episodes as Array<Record<string, unknown>>).map((item) => item.episodeNumber), [1]);

    const read = await request("GET", `/drama/episodes/${episode.id}`);
    assert.equal(read.status, 200);
    assert.equal((read.body.canvas as Record<string, unknown>).id, "canvas-1");

    const updated = await request("PATCH", `/drama/episodes/${episode.id}`, { synopsis: "退婚夜与实名求见", fullPlot: "沈昭宁与谢临渊在南茶楼达成合作。", canvasId: "canvas-2" });
    assert.equal(updated.status, 200);
    assert.equal((updated.body.episode as Record<string, unknown>).canvasId, "canvas-2");
    assert.equal((updated.body.episode as Record<string, unknown>).fullPlot, "沈昭宁与谢临渊在南茶楼达成合作。");
    assert.equal(db.getDramaEpisodeByCanvasId("canvas-1"), null);

    const deleted = await request("DELETE", `/drama/episodes/${episode.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 1);
    assert.equal((await request("GET", "/canvas/projects/canvas-2")).status, 200, "删分集不应删画布");
    assert.equal((await request("GET", `/drama/episodes/${episode.id}`)).status, 404);

    // 确认测试库没有留下错误的旧直属列
    const columns = db.db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "folder_id"), false);
});

test("drama asset REST：可上传、列出、下载并删除任意剧目文件", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-drama-assets-http-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite"));
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] });
    const server = app.listen(0);
    context.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const url = (value: string) => `${base}${value}${value.includes("?") ? "&" : "?"}token=test-token`;

    const dramaResponse = await fetch(url("/canvas/folders"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "drama-assets-1", name: "资产测试剧目", createdAt: "2026-01-01T00:00:00.000Z" }),
    });
    assert.equal(dramaResponse.status, 201);

    const cube = Buffer.from("TITLE TEST\nLUT_3D_SIZE 2\n0 0 0\n1 1 1\n", "utf8");
    const upload = await fetch(url("/drama/projects/drama-assets-1/assets"), {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-asset-name": encodeURIComponent("雾白纸感.cube") },
        body: cube,
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json() as { asset: { id: string; data: { storageKey: string; fileName: string; bytes: number } } };
    assert.equal(uploadBody.asset.data.fileName, "雾白纸感.cube");
    assert.equal(uploadBody.asset.data.bytes, cube.length);

    const listed = await fetch(url("/drama/projects/drama-assets-1/assets"));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { assets: Array<{ id: string }> };
    assert.deepEqual(listedBody.assets.map((item) => item.id), [uploadBody.asset.id]);

    const downloaded = await fetch(url(`/media/${encodeURIComponent(uploadBody.asset.data.storageKey)}`));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), cube);

    const deleted = await fetch(url(`/drama/projects/drama-assets-1/assets/${encodeURIComponent(uploadBody.asset.id)}`), { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(url(`/media/${encodeURIComponent(uploadBody.asset.data.storageKey)}`))).status, 404);
    const after = await fetch(url("/drama/projects/drama-assets-1/assets"));
    assert.deepEqual(((await after.json()) as { assets: unknown[] }).assets, []);
});
