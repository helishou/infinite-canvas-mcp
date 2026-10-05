import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { ensureProductionCanvas, ensureSceneProductionCanvas, productionCanvasContext } from "./production-canvas.js";
import { syncSceneInstances } from "./scene-instances.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-canvas-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const source = {
        script_scenes: [
            { id: "SC01", scene_id: "LOC1", scene_name: "第一场", kind: "action", beat_ids: ["b1"], text: "A" },
            { id: "SC02", scene_id: "LOC2", scene_name: "第二场", kind: "action", beat_ids: ["b2"], text: "B" },
        ],
        shots: [{ id: "SH1", scene_id: "ENV_YARD", source_scene_id: "SC01" }],
    };
    syncSceneInstances(db, { kind: "episode", id: "ep" }, source);
    return { db, source };
}

test("a prepared scene canvas resolves as the scene role, not as an ordinary canvas", t => {
    const { db } = fixture(t);
    const prepared = ensureSceneProductionCanvas(db, "SC01");
    assert.equal(prepared.created, true);
    assert.equal(prepared.project.title, "Drama · 第一场");
    const context = productionCanvasContext(db, prepared.project.id);
    assert.equal(context.role, "scene");
    assert.equal(context.owner?.kind, "scene");
    assert.equal(context.sceneId, "SC01");
    assert.equal(context.dramaId, "drama");
    // The episode link is informational; the scene keeps its own canvas.
    assert.equal(context.episodeId, "ep");
    assert.equal(db.getDramaEpisodeByCanvasId(prepared.project.id), null);
});

test("preparing the same scene twice reuses the same canvas and never rebinds it", t => {
    const { db } = fixture(t);
    const first = ensureSceneProductionCanvas(db, "SC01");
    const second = ensureSceneProductionCanvas(db, "SC01");
    assert.equal(second.created, false);
    assert.equal(second.project.id, first.project.id);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM drama_scene_canvases").get()!.n, 1);
    // A second scene gets its own canvas, so the 1:1 binding holds in both directions.
    const other = ensureSceneProductionCanvas(db, "SC02");
    assert.notEqual(other.project.id, first.project.id);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM drama_scene_canvases").get()!.n, 2);
    assert.throws(() => db.db.prepare("INSERT INTO drama_scene_canvases (scene_id, canvas_id, created_at) VALUES ('SC02', ?, '2026-01-01')").run(first.project.id), /UNIQUE/);
});

test("a scene canvas cannot be taken over by an episode or a shared asset canvas", t => {
    const { db } = fixture(t);
    const scene = ensureSceneProductionCanvas(db, "SC01").project.id;
    // The pre-existing episode/shared triggers only know their own tables, so scene ownership
    // is defended by its own triggers in migration 29.
    assert.throws(() => db.upsertDramaEpisode({ id: "ep2", dramaId: "drama", episodeNumber: 2, title: "Ep2", synopsis: "", canvasId: scene }), /制作场次/);
    assert.throws(() => db.db.prepare("UPDATE drama_projects SET shared_asset_canvas_id=? WHERE folder_id='drama'").run(scene), /制作场次/);
    // A bound scene canvas is fixed: it cannot be pointed at another canvas either.
    const spare = db.createCanvasProject({ id: "spare", title: "Spare", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }).project.id;
    assert.throws(() => db.db.prepare("UPDATE drama_scene_canvases SET canvas_id=? WHERE scene_id='SC01'").run(spare), /场次画布已固定/);
    // And a canvas that already belongs to an episode cannot be handed to a scene.
    const episodeCanvas = ensureProductionCanvas(db, "episode", "ep").project.id;
    assert.throws(() => db.db.prepare("INSERT INTO drama_scene_canvases (scene_id, canvas_id, created_at) VALUES ('SC02', ?, '2026-01-01')").run(episodeCanvas), /分集或共享资产/);
});

test("an orphaned scene cannot prepare a canvas, and a missing one is reported", t => {
    const { db, source } = fixture(t);
    assert.throws(() => ensureSceneProductionCanvas(db, "nope"), /制作场次不存在/);
    const shortened = { ...source, script_scenes: source.script_scenes.slice(0, 1) };
    syncSceneInstances(db, { kind: "episode", id: "ep" }, shortened);
    assert.throws(() => ensureSceneProductionCanvas(db, "SC02"), /已从源稿移除/);
    // Restoring the occurrence makes the same instance usable again.
    syncSceneInstances(db, { kind: "episode", id: "ep" }, source);
    assert.equal(ensureSceneProductionCanvas(db, "SC02").created, true);
});

test("existing episode, shared-asset and standalone canvases keep their roles", t => {
    const { db } = fixture(t);
    const episodeCanvas = ensureSceneProductionCanvas(db, "SC01").project.id;
    assert.notEqual(productionCanvasContext(db, episodeCanvas).role, "episode");
    const plain = db.createCanvasProject({ id: "plain", title: "Plain", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }).project.id;
    db.db.prepare("INSERT INTO canvas_productions (project_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 0, '{}', NULL, 0, '2026-01-01')").run(plain);
    assert.equal(productionCanvasContext(db, plain).role, "standalone");
    assert.equal(productionCanvasContext(db, plain).owner?.kind, "canvas");
    db.createCanvasProject({ id: "empty", title: "Empty", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } });
    assert.equal(productionCanvasContext(db, "empty").role, "ordinary");
});

test("a version 29 database gains the missing scene production batch table in version 30", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-batch-migration-"));
    const file = path.join(directory, "db.sqlite");
    let open: BackendDatabase | null = null;
    t.after(() => { open?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    open = new BackendDatabase(file);
    open.db.exec("DROP TABLE scene_production_batches; DELETE FROM schema_migrations WHERE version=30");
    open.close();
    open = null;

    open = new BackendDatabase(file);
    const version = open.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    const columns = open.db.prepare("PRAGMA table_info(scene_production_batches)").all() as Array<{ name: string }>;
    assert.equal(version.version, 30);
    assert.ok(columns.some(column => column.name === "scene_id"));
    assert.ok(columns.some(column => column.name === "idempotency_key"));
    assert.ok(open.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='scene_production_batches_status'").get());
});
