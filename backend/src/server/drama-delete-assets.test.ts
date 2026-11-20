import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

/** 删除剧目时资产默认留在库里的「未归属」，只有显式 deleteAssets 才连资产一起清掉。 */
test("删除剧目：默认保留剧目资产，deleteAssets=true 才一并删除", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-drama-assets-"));
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
    const drama = (id: string, name: string) => request("POST", "/canvas/folders", { id, name, isDrama: true, createdAt: "2026-01-01T00:00:00.000Z" });
    const textAsset = (id: string, dramaId: string) => request("POST", "/canvas/assets", {
        id, kind: "text", title: id, coverUrl: "", tags: [], source: "test", note: "", dramaId,
        data: { content: "资产正文" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal((await drama("drama-keep", "保留剧")).status, 201);
    assert.equal((await textAsset("asset-keep", "drama-keep")).status, 201);
    const kept = await request("DELETE", "/drama/projects/drama-keep");
    assert.equal(kept.status, 200);
    assert.equal(kept.body.deletedAssets, 0);
    const survivingAsset = await request("GET", "/canvas/assets/asset-keep");
    assert.equal(survivingAsset.status, 200, "默认不动资产库条目");
    assert.equal((survivingAsset.body.asset as Record<string, unknown>).dramaId ?? null, null, "失去剧目的资产回落未归属");

    assert.equal((await drama("drama-purge", "清空剧")).status, 201);
    assert.equal((await textAsset("asset-purge", "drama-purge")).status, 201);
    assert.equal((await textAsset("asset-other", "drama-keep")).status, 201);
    const purged = await request("DELETE", "/drama/projects/drama-purge", { deleteAssets: true });
    assert.equal(purged.status, 200);
    assert.equal(purged.body.deletedAssets, 1);
    assert.equal((await request("GET", "/canvas/assets/asset-purge")).status, 404, "勾选后资产条目随剧目删除");
    assert.equal((await request("GET", "/canvas/assets/asset-other")).status, 200, "别的剧目的资产不受影响");
});
