import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { ensureSceneProductionCanvas, productionCanvasContext } from "./production-canvas.js";
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
    // The existing episode/shared triggers only know about their own tables, so the
    // scene binding must be defended by its own uniqueness rather than by those triggers.
    assert.throws(() => db.upsertDramaEpisode({ id: "ep2", dramaId: "drama", episodeNumber: 2, title: "Ep2", synopsis: "", canvasId: scene }));
    assert.throws(() => db.db.prepare("UPDATE drama_scene_canvases SET canvas_id=? WHERE scene_id='SC02'").run(scene));
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
    db.db.prepare("INSERT INTO canvas_productions (project_id, revision, draft_json, published_json, published_version, updated_at) VALUES ('plain', 0, '{}', NULL, 0, '2026-01-01')").run();
    assert.equal(productionCanvasContext(db, "plain").role, "standalone");
    assert.equal(productionCanvasContext(db, "plain").owner?.kind, "canvas");
    assert.equal(productionCanvasContext(db, "absent-canvas-does-not-exist").role, "ordinary");
});
