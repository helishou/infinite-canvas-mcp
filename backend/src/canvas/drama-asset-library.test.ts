import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase, type Asset } from "../db.js";
import { rawProject, sourceOf } from "./drama-asset-library.js";
import { ensureProductionCanvas } from "../drama/production-canvas.js";

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
        const frozen = structuredClone(db.getCanvasProject("a"));
        const source = sourceOf(saved)!;
        db.applyCanvasProjectOperations(source.sourceProjectId, undefined, [{ type: "update_node", id: source.sourceNodeId, metadata: { characterImages: [{ url: "/media/new", storageKey: "new" }], characterPrimaryIndex: 0, content: "/media/new", storageKey: "new" } }]);
        const current = (db.getCanvasProject("a")!.nodes as any[]).find(n => n.id === "generator");
        assert.deepEqual(current.metadata.characterReferences.character.imageKeys, ["new"]);
        assert.equal((frozen!.nodes as any[])[0].metadata.storageKey, "a");
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
        db.db.exec("DELETE FROM schema_migrations WHERE version=38; DROP TABLE shared_library_receipts");
        db.close();
        db = new BackendDatabase(file);
        assert.ok(fs.readdirSync(directory).some(name => name.includes("pre-schema-v37-to-v38")));
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
