import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("角色资产只在打开画布时同步，节点编辑不回写资产，主图各自保留", async () => {
    const db = new BackendDatabase(":memory:");
    const images = [
        { url: "/media/image%3Aone", storageKey: "image:one", width: 100, height: 200 },
        { url: "/media/image%3Atwo", storageKey: "image:two", width: 200, height: 100 },
    ];
    const node = (id: string, assetId: string, primaryIndex = 0) => ({ id, type: "character", title: "旧名字", metadata: { characterAssetId: assetId, characterDescription: "旧描述", characterImages: images, characterPrimaryIndex: primaryIndex, content: images[primaryIndex].url, storageKey: images[primaryIndex].storageKey } });
    db.createCanvasProject({ id: "first", nodes: [node("a", "character-1"), node("source", "", 1)], connections: [] });
    db.createCanvasProject({ id: "second", nodes: [node("b", "character-1", 1)], connections: [] });
    const { app, events } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: ["*"] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (method: string, path: string, body?: unknown) => fetch(url + path, { method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const asset = {
        id: "character-1", kind: "character", title: "新名字", coverUrl: "", tags: [], folderId: null,
        data: { name: "新名字", description: "新描述", englishName: "New", images, primaryIndex: 1 },
        metadata: { source: "canvas", nodeId: "source" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const nodes = (id: string) => db.getCanvasProject(id)!.nodes as Array<{ id: string; title: string; metadata: Record<string, unknown> }>;
    const sync = async (id: string) => {
        const response = await request("POST", `/canvas/projects/${id}/sync-character-assets`);
        assert.equal(response.status, 200);
        return response.json() as Promise<{ updated: number; revision: number }>;
    };
    try {
        const firstRevision = db.getCanvasProject("first")!.revision;
        const secondRevision = db.getCanvasProject("second")!.revision;
        assert.equal((await request("POST", "/canvas/assets", asset)).status, 201);
        assert.equal(db.getCanvasProject("first")!.revision, firstRevision);
        assert.equal(db.getCanvasProject("second")!.revision, secondRevision);
        assert.equal(events.since().filter((event) => event.type === "canvas.updated").length, 0);

        assert.equal((await sync("first")).updated, 2);
        assert.equal(nodes("first")[0].title, "新名字");
        assert.equal(nodes("first")[0].metadata.characterDescription, "新描述");
        assert.equal(nodes("first")[0].metadata.characterPrimaryIndex, 0);
        assert.equal(nodes("first")[0].metadata.storageKey, "image:one");
        assert.equal(nodes("first")[1].metadata.characterAssetId, asset.id);
        assert.equal(nodes("first")[1].metadata.characterPrimaryIndex, 1);
        assert.equal(nodes("second")[0].metadata.characterDescription, "旧描述");
        const syncedRevision = db.getCanvasProject("first")!.revision;
        assert.equal((await sync("first")).updated, 0);
        assert.equal(db.getCanvasProject("first")!.revision, syncedRevision);
        assert.equal((await sync("second")).updated, 1);
        assert.equal(nodes("second")[0].metadata.characterPrimaryIndex, 1);

        assert.equal((await request("PATCH", `/canvas/assets/${asset.id}`, { data: { ...asset.data, description: "再次修改", primaryIndex: 0 } })).status, 200);
        assert.equal(db.getCanvasProject("first")!.revision, syncedRevision);
        assert.equal(nodes("first")[0].metadata.characterDescription, "新描述");
        assert.equal((await sync("first")).updated, 2);
        assert.equal(nodes("first")[0].metadata.characterDescription, "再次修改");
        assert.equal(nodes("first")[0].metadata.characterPrimaryIndex, 0);
        assert.equal(nodes("first")[1].metadata.characterPrimaryIndex, 1);

        db.applyCanvasProjectOperations("first", undefined, [{ type: "update_node", id: "a", metadata: { characterDescription: "节点本地修改" } }]);
        const stored = (await (await request("GET", "/canvas/assets?kind=character")).json() as { assets: Array<{ data: { description: string } }> }).assets[0];
        assert.equal(stored.data.description, "再次修改");
        assert.equal((await sync("first")).updated, 1);
        assert.equal(nodes("first")[0].metadata.characterDescription, "再次修改");

        assert.equal((await request("PATCH", `/canvas/assets/${asset.id}`, { data: { ...asset.data, description: "再次修改", images: [...images].reverse() } })).status, 200);
        await sync("first");
        await sync("second");
        assert.equal(nodes("first")[0].metadata.characterPrimaryIndex, 1);
        assert.equal(nodes("first")[0].metadata.storageKey, "image:one");
        assert.equal(nodes("second")[0].metadata.characterPrimaryIndex, 0);
        assert.equal(nodes("second")[0].metadata.storageKey, "image:two");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});
