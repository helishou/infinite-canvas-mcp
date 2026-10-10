import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase, type Asset } from "../db.js";
import { rawProject, sourceOf } from "./drama-asset-library.js";
import { ensureProductionCanvas } from "../drama/production-canvas.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { startServer } from "../server.js";
import { registerBackendMcpHttpRoutes } from "../mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fixture() {
    const db = new BackendDatabase(":memory:");
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: new Date().toISOString() });
    for (const id of ["a", "b"]) {
        db.createCanvasProject({ id, nodes: [{ id: "character", type: "character", title: "角色", position: { x: 70, y: 80 }, width: 240, height: 320, metadata: { characterName: "角色", characterDescription: "原始", characterImages: [{ url: "/media/a", storageKey: "a" }], characterPrimaryIndex: 0 } }], connections: [{ id: "edge", fromNodeId: "character", toNodeId: "target" }] });
        db.upsertDramaEpisode({ id: `episode-${id}`, dramaId: "drama", episodeNumber: id === "a" ? 1 : 2, title: id, synopsis: "", fullPlot: "", canvasId: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    const asset: Asset = { id: "asset", kind: "character", dramaId: "drama", title: "角色", coverUrl: "", tags: [], folderId: null, note: null, source: "Canvas", metadata: {}, data: { images: [{ url: "/media/a", storageKey: "a" }], description: "原始" }, createdAt: "now", updatedAt: "now" };
    return { db, asset };
}
test("promotion is atomic, idempotent and stores a single source with live references", () => {
    const { db, asset } = fixture();
    try {
        const command = { operationId: "promote", canvasSource: { projectId: "a", nodeId: "character" } };
        const saved = db.upsertAsset(asset, command);
        const source = sourceOf(saved)!;
        assert.ok(source);
        const revision = db.getCanvasProject("a")!.revision;
        db.upsertAsset(asset, command);
        assert.equal(db.getCanvasProject("a")!.revision, revision);
        assert.equal((db.getCanvasProject(source.sourceProjectId)!.nodes as any[]).length, 1);
        const ref = (db.getCanvasProject("a")!.nodes as any[])[0];
        assert.equal(ref.metadata.characterDescription, "原始");
        assert.deepEqual(ref.position, { x: 70, y: 80 });
        assert.equal((db.getCanvasProject("a")!.connections as any[])[0].id, "edge");
        assert.equal((rawProject(db, "a")!.nodes as any[])[0].metadata.characterDescription, undefined);
        assert.deepEqual(db.getAssetRecord(asset.id)!.data, {});
        db.applyCanvasProjectOperations("b", undefined, [{ type: "add_node", id: "reference", nodeType: "character", position: { x: 1, y: 1 }, metadata: { sharedAssetReference: source } }]);
        db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", metadata: { characterDescription: "本地" } }]);
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].metadata.characterDescription, "本地");
        assert.equal(db.getAsset(asset.id)!.data.description, "原始");
        db.upsertAsset(db.getAsset(asset.id)!, { operationId: "update", canvasSource: command.canvasSource });
        assert.equal(db.getAsset(asset.id)!.data.description, "本地");
        assert.equal((db.getCanvasProject("b")!.nodes as any[]).find(n => n.id === "reference").metadata.characterDescription, "本地");
        assert.equal((rawProject(db, "a")!.nodes as any[])[0].metadata.sharedAssetReference.edits, undefined);
        assert.throws(() => db.deleteAsset(asset.id), /仍被画布引用/);
        assert.throws(() => db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "delete_node", id: source.sourceNodeId }]), /仍被画布引用/);
    } finally { db.close(); }
});
test("independent source fields merge, same fields conflict and discard restores current source", () => {
    const { db, asset } = fixture();
    try {
        const saved = db.upsertAsset(asset, { canvasSource: { projectId: "a", nodeId: "character" } });
        const source = sourceOf(saved)!;
        db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", metadata: { characterDescription: "本地" } }]);
        db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "update_node", id: source.sourceNodeId, patch: { title: "新名" }, metadata: { characterDescription: "远端" } }]);
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].title, "新名");
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].metadata.characterDescription, "本地");
        assert.throws(() => db.upsertAsset(db.getAsset(asset.id)!, { canvasSource: { projectId: "a", nodeId: "character" } }), /相同字段已变化/);
        db.upsertAsset(db.getAsset(asset.id)!, { canvasSource: { projectId: "a", nodeId: "character" }, discardLocal: true });
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].metadata.characterDescription, "远端");
    } finally { db.close(); }
});

test("all six kinds share selected content, preserve source geometry and support final deletion", () => {
    for (const kind of ["text", "image", "video", "audio", "scene", "character"]) {
        const { db, asset } = fixture();
        try {
            const data: Record<string, unknown> = kind === "text" ? { content: "文本" } : kind === "scene" ? { name: "场景", description: "环境", image: { url: "/media/a", storageKey: "a" } } : kind === "character" ? asset.data : { dataUrl: "/media/a", url: "/media/a", storageKey: "a", width: 200, height: 100, bytes: 300, mimeType: `${kind}/test` };
            db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", patch: { type: kind } }]);
            const saved = db.upsertAsset({ ...asset, kind, data }, { canvasSource: { projectId: "a", nodeId: "character" } });
            const source = sourceOf(saved)!;
            const stored = (rawProject(db, "a")!.nodes as any[])[0];
            assert.equal(stored.metadata.content, undefined);
            assert.equal(stored.metadata.sharedAssetReference.assetId, asset.id);
            assert.equal(db.getCanvasProjectNodeSnapshot("a", ["character"])!.nodes instanceof Array, true);
            assert.equal((db.getCanvasProjectIndex("a")!.nodes as any[])[0].title, "角色");
            assert.throws(() => db.upsertAsset({ ...saved, dramaId: null }), /仍被画布引用/);
            db.applyCanvasProjectOperations("a", undefined, [{ type: "delete_node", id: "character" }]);
            assert.ok(db.getAsset(asset.id));
            assert.equal(db.deleteAsset(asset.id), 1);
            assert.equal(db.getAsset(asset.id), null);
            assert.equal((db.getCanvasProject(source.sourceProjectId)!.nodes as any[]).length, 0);
        } finally { db.close(); }
    }
});

test("smart generators keep parameters and task history; same-name assets remain independent", () => {
    const { db, asset } = fixture();
    try {
        db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", patch: { type: "config" }, metadata: { smart: true, generationMode: "image", prompt: "输入", loopOutputHistory: [{ taskId: "old", storageKey: "old" }] } }]);
        const before = (db.getCanvasProject("a")!.nodes as any[])[0];
        const saved = db.upsertAsset({ ...asset, kind: "image", data: { storageKey: "selected", dataUrl: "/media/selected" } }, { canvasSource: { projectId: "a", nodeId: "character" } });
        assert.deepEqual((db.getCanvasProject("a")!.nodes as any[])[0], before);
        assert.equal(db.getAsset(saved.id)!.data.storageKey, "selected");
        db.upsertAsset({ ...asset, id: "other" });
        assert.equal(db.listAssets({ dramaId: "drama" }).length, 2);
        assert.notEqual(sourceOf(db.getAsset("other"))!.sourceNodeId, sourceOf(saved)!.sourceNodeId);
    } finally { db.close(); }
});

test("invalid source rolls back first shared canvas creation and publishes no commits", () => {
    const { db, asset } = fixture();
    const commits: unknown[] = [];
    db.onCanvasCommit(commit => commits.push(commit));
    try {
        assert.throws(() => db.upsertAsset(asset, { canvasSource: { projectId: "a", nodeId: "missing" } }), /来源节点不存在/);
        assert.equal(db.listCanvasFolders().find(f => f.id === "drama")!.sharedAssetCanvasId, null);
        assert.equal(db.listCanvasProjects().length, 2);
        assert.equal(db.getAsset(asset.id), null);
        assert.equal(commits.length, 0);
    } finally { db.close(); }
});

test("source changes refresh character selections and ordinary H3 consumers without modifying snapshots", () => {
    const { db, asset } = fixture();
    try {
        const saved = db.upsertAsset(asset, { canvasSource: { projectId: "a", nodeId: "character" } });
        db.applyCanvasProjectOperations("a", undefined, [{ type: "add_node", id: "generator", nodeType: "config", metadata: { smart: true, characterReferences: { character: { imageKeys: ["a"] } } } }]);
        db.applyCanvasProjectOperations("a", undefined, [{ type: "add_node", id: "h3", nodeType: "minimax-h3:video", metadata: { segments: [{ id: "clip", taskMode: "ref2va", h3CharacterGroups: { char: { id: "char", characterName: "角色", characterNodeId: "character", characterAssetId: "asset", subjectId: "character", outfitEnabled: true, voiceEnabled: false, outfits: [{ id: "outfit", url: "/media/a", storageKey: "a", name: "形象", enabled: true }] } } }] } }]);
        const frozen = structuredClone(db.getCanvasProject("a"));
        const source = sourceOf(saved)!;
        db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "update_node", id: source.sourceNodeId, metadata: { characterImages: [{ url: "/media/new", storageKey: "new" }], characterPrimaryIndex: 0, content: "/media/new", storageKey: "new" } }]);
        const current = (db.getCanvasProject("a")!.nodes as any[]).find(n => n.id === "generator");
        assert.deepEqual(current.metadata.characterReferences.character.imageKeys, ["new"]);
        const clip = (db.getCanvasProject("a")!.nodes as any[]).find(n => n.id === "h3").metadata.segments[0];
        assert.equal(clip.h3CharacterGroups.char.outfits[0].storageKey, "new");
        assert.equal(clip.h3CharacterGroups.char.outfits[0].enabled, true);
        assert.equal((frozen!.nodes as any[])[0].metadata.storageKey, "a");
    } finally { db.close(); }
});

test("task results on a referenced media node stay local until explicitly updating the library", () => {
    const { db, asset } = fixture();
    try {
        db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", patch: { type: "image" }, metadata: { content: "/media/old", storageKey: "old" } }]);
        const saved = db.upsertAsset({ ...asset, kind: "image", data: { dataUrl: "/media/old", storageKey: "old" } }, { canvasSource: { projectId: "a", nodeId: "character" } });
        db.applyCanvasProjectOperations("a", undefined, [{ type: "update_node", id: "character", metadata: { content: "/media/generated", storageKey: "generated", generatedImageHistory: [{ taskId: "original-task", storageKey: "generated" }] } }], { runtimeWrite: true, source: { kind: "task", clientId: "task:original-task" } });
        assert.equal(db.getAsset(asset.id)!.data.storageKey, "old");
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].metadata.storageKey, "generated");
        assert.equal((rawProject(db, "a")!.nodes as any[])[0].metadata.storageKey, undefined);
        const input = { ...saved, data: { ...saved.data, storageKey: "generated", dataUrl: "" } };
        db.upsertAsset(input, { canvasSource: { projectId: "a", nodeId: "character" }, request: input });
        assert.equal(db.getAsset(asset.id)!.data.storageKey, "generated");
        assert.equal((db.getCanvasProject("a")!.nodes as any[])[0].metadata.generatedImageHistory[0].taskId, "original-task");
    } finally { db.close(); }
});

test("a formal smart source remains one node while library and live references resolve its selected archived result", () => {
    const { db, asset } = fixture();
    try {
        const shared = ensureProductionCanvas(db, "shared-assets", "drama");
        db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "formal-smart", nodeType: "config", title: "正式图片", metadata: { smart: true, generationMode: "image", images: [{ id: "old", status: "success", storageKey: "old", content: "/media/old", naturalWidth: 8, naturalHeight: 8 }] } }]);
        const source = { dramaId: "drama", assetId: "formal-image", sourceProjectId: shared.project.id, sourceNodeId: "formal-smart" };
        db.upsertAssetRecord({ ...asset, id: source.assetId, kind: "image", data: {}, metadata: { sharedAssetSource: source } });
        assert.equal(db.getAsset(source.assetId)!.data.storageKey, "old");
        db.applyCanvasProjectOperations("a", undefined, [{ type: "add_node", id: "formal-live-ref", nodeType: "image", metadata: { sharedAssetReference: source } }]);
        assert.equal((db.getCanvasProject("a")!.nodes as any[]).find(n => n.id === "formal-live-ref").metadata.storageKey, "old");
        db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "update_node", id: "formal-smart", metadata: { images: [{ id: "next", status: "success", storageKey: "next", content: "/media/next", naturalWidth: 16, naturalHeight: 8 }] } }], { runtimeWrite: true, source: { kind: "task", clientId: "task:formal" } });
        assert.equal((db.getCanvasProject("a")!.nodes as any[]).find(n => n.id === "formal-live-ref").metadata.storageKey, "next");
        const current = db.getAsset(source.assetId)!;
        db.upsertAsset({ ...current, note: "只修改目录备注" });
        assert.equal(db.getAsset(source.assetId)!.note, "只修改目录备注");
        assert.equal((db.getCanvasProject(shared.project.id)!.nodes as any[]).length, 1);
        assert.throws(() => db.upsertAsset({ ...current, data: { ...current.data, storageKey: "unowned" } }), /源画布/);
    } finally { db.close(); }
});

test("direct library edits merge only changed fields and reject real content conflicts", () => {
    const { db, asset } = fixture();
    try {
        const saved = db.upsertAsset(asset);
        const base = { title: saved.title, data: saved.data };
        const source = sourceOf(saved)!;
        db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "update_node", id: source.sourceNodeId, patch: { title: "远端名字" } }]);
        const next = db.upsertAsset({ ...saved, data: { ...saved.data, description: "改描述" } }, { assetBase: base });
        assert.equal(next.title, "远端名字");
        assert.equal(next.data.description, "改描述");
        assert.throws(() => db.upsertAsset({ ...saved, title: "本地名字" }, { assetBase: base }), /相同字段已变化/);
        assert.equal(db.listAssetsPage({ keyword: "改描述" }).total, 1);
    } finally { db.close(); }
});

test("v38 migration backs up, reuses known shared nodes and preserves local differences and unknown identities", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shared-library-migration-"));
    const file = path.join(directory, "runtime.sqlite");
    let db = new BackendDatabase(file);
    try {
        db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: "now" });
        const shared = ensureProductionCanvas(db, "shared-assets", "drama");
        db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "existing", nodeType: "text", title: "源稿", position: { x: 89, y: 99 }, metadata: { content: "共享文本" } }]);
        const record = { id: "legacy", kind: "text", dramaId: "drama", title: "源稿", data: { content: "共享文本" }, metadata: { projectId: shared.project.id, nodeId: "existing" }, tags: [], coverUrl: "", folderId: null, note: null, source: "Canvas", createdAt: "now", updatedAt: "now" } as Asset;
        db.upsertAssetRecord(record);
        db.createCanvasProject({ id: "episode-canvas", nodes: [{ id: "character", type: "character", title: "旧角色", metadata: { characterAssetId: "char", characterDescription: "本地差异", characterImages: [{ url: "/media/local" }] } }, { id: "unknown", type: "text", title: "源稿", metadata: { content: "不能按名称合并" } }], connections: [] });
        db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "分集", synopsis: "", fullPlot: "", canvasId: "episode-canvas", createdAt: "now", updatedAt: "now" });
        db.upsertAssetRecord({ ...record, id: "char", kind: "character", title: "角色", metadata: {}, data: { description: "共享描述", images: [{ url: "/media/shared" }] } });
        db.db.exec("DELETE FROM schema_migrations WHERE version>=38; DROP TABLE shared_library_receipts");
        db.close();
        db = new BackendDatabase(file);
        assert.ok(fs.readdirSync(directory).some(name => name.includes(`pre-schema-v37-to-v${DATABASE_SCHEMA_VERSION}-`)));
        assert.equal(sourceOf(db.getAsset("legacy"))!.sourceNodeId, "existing");
        assert.equal((db.getCanvasProject(shared.project.id)!.nodes as any[]).filter(n => n.type === "text").length, 1);
        const local = (db.getCanvasProject("episode-canvas")!.nodes as any[])[0];
        assert.equal(local.metadata.characterDescription, "本地差异");
        assert.ok(local.metadata.sharedAssetReference.edits);
        assert.equal((db.getCanvasProject("episode-canvas")!.nodes as any[])[1].metadata.sharedAssetReference, undefined);
        const snapshot = JSON.stringify(db.listCanvasProjects());
        db.close(); db = new BackendDatabase(file);
        assert.equal(JSON.stringify(db.listCanvasProjects()), snapshot);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP and MCP share identity, compact replay receipts, reference reads and deletion protection", async t => {
    const priorToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "shared-library-test";
    t.after(() => { if (priorToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = priorToken; });
    const { db, asset } = fixture();
    const config = { url: "http://127.0.0.1", token: "shared-library-test", port: 0, origins: [] as string[] };
    const { app, events } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    config.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const mcp = registerBackendMcpHttpRoutes(app, config);
    const client = new Client({ name: "shared-library-fixture", version: "1" });
    t.after(async () => { await client.close(); await mcp.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
    const http = (method: string, url: string, body?: unknown) => fetch(config.url + url, { method, headers: { Authorization: "Bearer shared-library-test", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const request = { ...asset, operationId: "http-add", canvasSource: { projectId: "a", nodeId: "character" } };
    const first = await http("POST", "/canvas/assets", request);
    assert.equal(first.status, 201);
    const promoted = await first.json() as any;
    assert.equal(promoted.replayed, false);
    const revision = db.getCanvasProject("a")!.revision;
    const replay = await (await http("POST", "/canvas/assets", request)).json() as any;
    assert.equal(replay.replayed, true);
    assert.equal(db.getCanvasProject("a")!.revision, revision);
    const refused = await http("DELETE", `/canvas/assets/${asset.id}`);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as any).code, "ASSET_IN_USE");
    const denied = await http("POST", "/canvas/projects/b/ops", { operationId: "forged-ref", operations: [{ type: "add_node", id: "forged", nodeType: "character", metadata: { sharedAssetReference: { ...promoted.source, sourceNodeId: "wrong" } } }] });
    assert.equal(denied.status, 400);
    const patch = { operationId: "http-update", data: { ...promoted.asset.data, description: "接口更新" }, assetBase: { title: promoted.asset.title, data: promoted.asset.data } };
    assert.equal((await http("PATCH", `/canvas/assets/${asset.id}`, patch)).status, 200);
    assert.equal((await (await http("PATCH", `/canvas/assets/${asset.id}`, patch)).json() as any).replayed, true);
    const snapshot = await (await http("GET", "/canvas/projects/a?view=nodes&nodeIds=%5B%22character%22%5D")).json() as any;
    assert.equal(snapshot.project.nodes[0].metadata.characterDescription, "接口更新");
    assert.ok(events.since().some(e => e.type === "canvas.updated" && e.entityId === "a"));
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer shared-library-test" } } }));
    const tools = await client.listTools();
    const schema: any = tools.tools.find(tool => tool.name === "assets_upsert_batch")!.inputSchema;
    assert.ok(schema.properties.items.items.properties.canvasSource);
    const args = { operationId: "mcp-library", items: [{ id: "mcp-text", kind: "text", dramaId: "drama", title: "MCP共享文本", data: { content: "大正文".repeat(5000) } }] };
    const result: any = await client.callTool({ name: "assets_upsert_batch", arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const receipt = JSON.parse(result.content[0].text);
    assert.deepEqual(receipt.assetIds, ["mcp-text"]);
    assert.ok(Buffer.byteLength(result.content[0].text) < 2000);
    assert.ok(sourceOf(db.getAsset("mcp-text")));
    const repeated: any = await client.callTool({ name: "assets_upsert_batch", arguments: args });
    assert.equal(JSON.parse(repeated.content[0].text).replayed, true);
    const source = sourceOf(db.getAsset("mcp-text"))!;
    assert.equal((db.getCanvasProject(source.sourceProjectId)!.nodes as any[]).filter(n => n.id === source.sourceNodeId).length, 1);
});
