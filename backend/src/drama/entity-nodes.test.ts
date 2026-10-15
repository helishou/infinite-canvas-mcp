import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { EpisodeProductionService } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { directorHash } from "./director.js";
import { directorProductionSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import { startServer } from "../server.js";
import { registerBackendMcpHttpRoutes } from "../mcp.js";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fixture(t: test.TestContext, bound = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-nodes-")), db = new BackendDatabase(path.join(dir, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: new Date().toISOString() });
    if (bound) db.createCanvasProject({ id: "canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "第一集", synopsis: "", canvasId: bound ? "canvas" : null });
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [{ id: "C1", name: "同名", appearance: { description: "机械人", identity: "保留身份" } }, { id: "C2", name: "同名", description: "另一个角色" }], scene_registry: [{ id: "S1", name: "船舱", description: "铁壁" }], shots: [], segments: [], utterances: [], asset_plan: [{ id: "P1", kind: "prop", asset_name: "扳手", description: "生锈" }, { id: "STYLE", kind: "style", asset_name: "风格" }], asset_cards: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
    const director = directorProductionSchema.parse({ schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: directorHash(source), assets: {}, shotInputs: {}, modules: {}, artifacts: [], boundaries: [], unresolved: [], workflow: {}, executionAuthorized: false });
    const service = new EpisodeProductionService(db, new BackendEventBus(), dir, false, () => {});
    const saved = service.edit("ep", { operationId: "init", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    return { db, service, saved, runner: new EpisodeProductionRunner(service, createStores(db), {} as any) };
}
const entity = (db: BackendDatabase, id: string) => (db.getCanvasProject("canvas")!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === id);

test("source creates one typed node per registry identity, excludes style, and preparation replays without duplication", t => {
    const f = fixture(t);
    assert.deepEqual((f.db.getCanvasProject("canvas")!.nodes as any[]).filter(node => node.metadata?.productionEntity).map(node => node.type).sort(), ["character", "character", "prop", "scene"]);
    assert.notEqual(entity(f.db, "C1").id, entity(f.db, "C2").id);
    assert.throws(() => f.runner.prepareTargets("ep", f.saved.revision, ["entity:character:missing"], "invalid-entity"), /制作实体不存在/);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("invalid-entity"), undefined);
    const result = f.runner.prepareTargets("ep", f.saved.revision, ["entity:character:C1"], "prepare-entities");
    const replay = f.runner.prepareTargets("ep", f.saved.revision, ["entity:character:C1"], "prepare-entities");
    assert.equal(replay.replayed, true); assert.equal(result.revision, replay.revision);
    assert.equal((f.db.getCanvasProject("canvas")!.nodes as any[]).filter(node => node.metadata?.productionEntity).length, 4);
});

test("node edits and workbench edits share the draft, retain structured fields, geometry and adjacent entities", t => {
    const f = fixture(t), node = entity(f.db, "C1"), before = f.service.get("ep");
    const ops = [{ type: "update_node", id: node.id, patch: { title: "铆钉", position: { x: 123, y: 456 } }, metadata: { characterName: "铆钉", characterDescription: "蓝色机械人" } }];
    const commit = f.db.applyCanvasProjectOperations("canvas", Number(f.db.getCanvasProject("canvas")!.revision), ops, { operationId: "edit-node" });
    const source = f.service.get("ep").draft.director!.source as any;
    assert.equal(source.character_registry[0].name, "铆钉");
    assert.deepEqual(source.character_registry[0].appearance, { description: "蓝色机械人", identity: "保留身份" });
    assert.equal(before.draft.director!.sourceHash === f.service.get("ep").draft.director!.sourceHash, false);
    const replay = f.db.applyCanvasProjectOperations("canvas", commit.revision - 1, ops, { operationId: "edit-node" });
    assert.equal(replay.duplicated, true);
    const current = f.service.get("ep");
    f.service.edit("ep", { operationId: "edit-workbench", expectedRevision: current.revision, ops: [{ type: "patch_director_source", entity: "character", id: "C1", patch: { name: "新名字" } }] });
    assert.equal(entity(f.db, "C1").metadata.characterName, "新名字");
    assert.equal(entity(f.db, "C1").metadata.characterDescription, "蓝色机械人");
    assert.deepEqual(entity(f.db, "C1").position, { x: 123, y: 456 });
    assert.equal(entity(f.db, "C2").metadata.characterName, "同名");
    assert.throws(() => f.db.applyCanvasProjectOperations("canvas", Number(f.db.getCanvasProject("canvas")!.revision), [{ type: "update_node", id: node.id, metadata: { productionEntity: { ...node.metadata.productionEntity, entityId: "C2" } } }], { operationId: "forge" }), /Backend/);
});

test("prop image resolves into the same generation reference path as scene images", () => {
    const result = resolveCanvasImageReferenceNode({ id: "prop", type: "prop", metadata: { propImage: { storageKey: "archived-prop", name: "扳手" } } });
    assert.equal(result[0].storageKey, "archived-prop"); assert.equal(result[0].name, "扳手");
});

test("a Subject identity picture projects onto its prop node and follows later source image updates", t => {
    const f = fixture(t), current = f.service.get("ep");
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "prop-picture", nodeType: "config", title: "扳手身份图", metadata: {
        generationMode: "image", status: "success", storageKey: "prop-image-v1", content: "/media/prop-image-v1.png", mimeType: "image/png", naturalWidth: 640, naturalHeight: 640,
    } }], { runtimeWrite: true });
    f.service.edit("ep", { operationId: "register-prop-picture-subject", expectedRevision: current.revision, ops: [{ type: "upsert_director_subject", subject: {
        id: "SUBJECT_P1", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "asset", id: "P1" },
        pictureBindings: [{ id: "P1-identity", assetId: "P1", sourceNode: { projectId: "canvas", nodeId: "prop-picture" }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["扳手身份"], exclude: [], applicableState: {}, defaultFor: ["identity"] }],
    } }] });
    assert.equal(entity(f.db, "P1").metadata.propImage.storageKey, "prop-image-v1");
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "prop-picture", metadata: { storageKey: "prop-image-v2", content: "/media/prop-image-v2.png" } }], { runtimeWrite: true, source: { kind: "task", clientId: "task:prop-picture" } });
    assert.equal(entity(f.db, "P1").metadata.propImage.storageKey, "prop-image-v2");
    assert.equal(entity(f.db, "P1").metadata.propImage.url, "/media/prop-image-v2.png");
});

test("renaming a typed node title writes its entity name and replays the original unmodified command", t => {
    const f = fixture(t), node = entity(f.db, "P1"), revision = Number(f.db.getCanvasProject("canvas")!.revision);
    const ops = [{ type: "update_node", id: node.id, patch: { title: "新扳手" } }];
    const first = f.db.applyCanvasProjectOperations("canvas", revision, ops, { operationId: "rename-prop" });
    assert.equal((f.service.get("ep").draft.director!.source.asset_plan as any[])[0].asset_name, "新扳手");
    assert.equal(entity(f.db, "P1").metadata.propName, "新扳手");
    assert.equal(Object.hasOwn(ops[0], "metadata"), false);
    assert.equal(f.db.applyCanvasProjectOperations("canvas", revision, ops, { operationId: "rename-prop" }).revision, first.revision);
});

test("saving entities on an unbound episode creates and binds its canvas in the source transaction", t => {
    const f = fixture(t, false), canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    assert.ok(canvasId);
    assert.equal((f.db.getCanvasProject(canvasId)!.nodes as any[]).filter(node => node.metadata?.productionEntity).length, 4);
});

test("workbench edits on a promoted entity persist as reference intent until explicit library update", t => {
    const f = fixture(t), node = entity(f.db, "C1");
    const asset = f.db.upsertAsset({ id: "shared-C1", kind: "character", dramaId: "drama", title: node.title, coverUrl: "", tags: [], folderId: null, note: null, source: "Canvas", metadata: {}, data: { images: [], description: node.metadata.characterDescription }, createdAt: "now", updatedAt: "now" }, { operationId: "promote-entity", canvasSource: { projectId: "canvas", nodeId: node.id } });
    const current = f.service.get("ep");
    f.service.edit("ep", { operationId: "workbench-reference-edit", expectedRevision: current.revision, ops: [{ type: "patch_director_source", entity: "character", id: "C1", patch: { name: "本集名称" } }] });
    const reference = entity(f.db, "C1");
    assert.equal(reference.metadata.characterName, "本集名称");
    assert.equal(reference.metadata.sharedAssetReference.edits["metadata.characterName"].value, "本集名称");
    assert.equal(f.db.getAsset(asset.id)!.title, "同名");
    f.db.upsertAsset(f.db.getAsset(asset.id)!, { operationId: "update-entity-library", canvasSource: { projectId: "canvas", nodeId: node.id } });
    assert.equal(f.db.getAsset(asset.id)!.title, "本集名称");
    assert.equal(entity(f.db, "C1").metadata.sharedAssetReference.edits, undefined);
    assert.equal((f.db.getCanvasProject(asset.metadata!.sharedAssetSource.sourceProjectId)!.nodes as any[]).length, 1);
    f.db.upsertAsset({ ...f.db.getAsset(asset.id)!, title: "公共名称" }, { operationId: "direct-library-entity-edit" });
    assert.equal(entity(f.db, "C1").metadata.characterName, "公共名称");
    assert.equal((f.service.get("ep").draft.director!.source.character_registry as any[])[0].name, "公共名称");

});

test("HTTP MCP prepares entity nodes, reads exact identity, edits and promotes the same node, and rejects deleting an in-use source", async t => {
    const f = fixture(t), token = "entity-mcp-test", previousToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = token;
    t.after(() => { if (previousToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = previousToken; });
    const config = { url: "http://127.0.0.1", token, port: 0, origins: [] as string[] };
    const { app, events } = startServer(f.db, config);
    registerDramaProductionRoutes(app, f.service, f.runner, undefined, events);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    config.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const mcp = registerBackendMcpHttpRoutes(app, config), client = new Client({ name: "entity-mcp-fixture", version: "1" });
    t.after(async () => { await client.close(); await mcp.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const listed = await client.listTools();
    assert.match(listed.tools.find(tool => tool.name === "production_prepare_targets")!.description!, /entity:/);
    assert.ok(listed.tools.some(tool => tool.name === "canvas_apply_commands"));
    let calls = 0, bytes = 0; const started = performance.now();
    const call = async (name: string, args: Record<string, any>, error = false) => {
        const result: any = await client.callTool({ name, arguments: args }); calls++; bytes += Buffer.byteLength(JSON.stringify(result));
        if (error) { assert.equal(result.isError, true); return result; }
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse(result.content[0].text);
    };
    const preparedInput = { kind: "episode", id: "ep", operationId: "mcp-entity-prepare", expectedRevision: f.saved.revision, targets: ["entity:character:C1", "entity:scene:S1", "entity:prop:P1"] };
    const prepared = await call("production_prepare_targets", preparedInput);
    const repeated = await call("production_prepare_targets", preparedInput);
    assert.equal(repeated.production.replayed, true); assert.equal(prepared.production.revision, repeated.production.revision);
    assert.equal(Object.hasOwn(prepared.production, "draft"), false);
    const registered = await call("production_edit", { kind: "episode", id: "ep", operationId: "mcp-entity-subject", expectedRevision: prepared.production.revision, ops: [{ type: "upsert_director_subject", subject: { id: "SUBJECT_C1", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "C1" }, pictureBindings: [] } }] });
    const read = await call("production_get_workbench", { kind: "episode", id: "ep", targetId: "SUBJECT_C1", view: "subject_workbench" });
    const node = entity(f.db, "C1");
    assert.deepEqual(read.production.workbench.entityNodeSource, { projectId: "canvas", nodeId: node.id, kind: "character", entityId: "C1" });
    await call("production_edit", { kind: "episode", id: "ep", operationId: "mcp-entity-name", expectedRevision: registered.production.revision, ops: [{ type: "patch_director_source", entity: "character", id: "C1", patch: { name: "MCP角色" } }] });
    assert.equal(entity(f.db, "C1").metadata.characterName, "MCP角色");
    const image = { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7sAAAAASUVORK5CYII=", width: 1, height: 1, bytes: 68, mimeType: "image/png", name: "测试角色图" };
    await call("canvas_apply_commands", { projectId: "canvas", operationId: "mcp-entity-photo", baseRevision: Number(f.db.getCanvasProject("canvas")!.revision), operations: [{ type: "update_node", id: node.id, metadata: { characterImages: [image], characterPrimaryIndex: 0 } }] });
    await call("assets_upsert_batch", { operationId: "mcp-entity-promote", items: [{ id: "mcp-shared-C1", kind: "character", dramaId: "drama", title: "MCP角色", data: { name: "MCP角色", images: [image], description: node.metadata.characterDescription }, canvasSource: { projectId: "canvas", nodeId: node.id } }] });
    const asset = f.db.getAsset("mcp-shared-C1")!, source = asset.metadata!.sharedAssetSource;
    assert.ok(source); assert.ok(entity(f.db, "C1").metadata.sharedAssetReference);
    await call("canvas_apply_commands", { projectId: "canvas", operationId: "mcp-entity-local-edit", baseRevision: Number(f.db.getCanvasProject("canvas")!.revision), operations: [{ type: "update_node", id: node.id, metadata: { characterDescription: "MCP本地修改" } }] });
    assert.equal(f.db.getAsset(asset.id)!.data.description, "机械人");
    await call("assets_upsert_batch", { operationId: "mcp-entity-update", items: [{ id: asset.id, kind: "character", dramaId: "drama", title: "MCP角色", data: { name: "MCP角色", images: [image], description: "MCP本地修改" }, canvasSource: { projectId: "canvas", nodeId: node.id } }] });
    assert.equal(f.db.getAsset(asset.id)!.data.description, "MCP本地修改");
    await call("canvas_apply_commands", { projectId: source.sourceProjectId, operationId: "mcp-entity-delete-in-use", baseRevision: Number(f.db.getCanvasProject(source.sourceProjectId)!.revision), operations: [{ type: "delete_node", id: source.sourceNodeId }] }, true);
    assert.ok(f.db.getAsset(asset.id));
    await call("canvas_apply_commands", { projectId: "canvas", operationId: "mcp-entity-remove-reference", baseRevision: Number(f.db.getCanvasProject("canvas")!.revision), operations: [{ type: "delete_node", id: node.id }] });
    assert.ok(f.db.getAsset(asset.id));
    await call("canvas_apply_commands", { projectId: source.sourceProjectId, operationId: "mcp-entity-remove-unused-source", baseRevision: Number(f.db.getCanvasProject(source.sourceProjectId)!.revision), operations: [{ type: "delete_node", id: source.sourceNodeId }] });
    assert.equal(f.db.getAsset(asset.id), null);
    assert.equal((f.db.getCanvasProject(source.sourceProjectId)!.nodes as any[]).some(n => n.id === source.sourceNodeId), false);
    console.log(JSON.stringify({ scenario: "entity MCP round trip", calls, responseBytes: bytes, elapsedMs: Math.round(performance.now() - started), mediaSubmitted: false }));
});
