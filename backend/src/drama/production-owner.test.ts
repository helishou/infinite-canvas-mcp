import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { directorHash } from "./director.js";
import { directorModules, directorProductionSchema, emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { getSceneInstance, syncSceneInstances } from "./scene-instances.js";
import { ensureSceneProductionCanvas } from "./production-canvas.js";

const EMPTY_PRODUCTION = JSON.stringify(emptyEpisodeProduction());

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "production-owner-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    syncSceneInstances(db, { kind: "episode", id: "ep" }, {
        script_scenes: [{ id: "SC01", scene_id: "LOC1", scene_name: "第一场", kind: "action", beat_ids: ["b1"], text: "A" }],
        shots: [{ id: "SH1", scene_id: "ENV_YARD", source_scene_id: "SC01" }],
    });
    const episode = new EpisodeProductionService(db, undefined, directory, false, () => {});
    const canvas = new EpisodeProductionService(db, undefined, directory, true, () => {});
    const scene = episode.withSceneScope();
    return { db, episode, canvas, scene };
}

/** A fresh draft has no director, which is exactly what the production record layer stores and reads back. */
function seed(t: test.TestContext) {
    const f = fixture(t);
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES ('ep', 1, ?, NULL, 0, '2026-01-01')").run(EMPTY_PRODUCTION);
    return f;
}

test("each owner reads and writes only its own production table", t => {
    const f = seed(t);
    // The scene owner must not see the episode row, and must not be able to write through it.
    assert.equal(f.scene.get("SC01").draft.director, undefined);
    assert.equal(f.scene.get("SC01").revision, 0);
    assert.equal(f.episode.get("ep").revision, 1);
    // Writing through the scene owner lands in scene_productions only.
    f.db.db.prepare("INSERT INTO scene_productions (scene_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 7, ?, NULL, 0, ?)").run("SC01", EMPTY_PRODUCTION, "2026-01-01");
    assert.equal(f.scene.get("SC01").revision, 7);
    // The episode record is untouched by a scene write.
    assert.equal(f.episode.get("ep").revision, 1);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM scene_productions").get()!.n, 1);
    assert.equal(f.db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id='ep'").get()!.revision, 1);
});

test("continuity upgrade preview sees in-flight native media tasks for its exact owner", t => {
    const f = fixture(t);
    const now = new Date().toISOString();
    f.db.db.prepare(`INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at)
        VALUES (?, 'canvas-h3-run', 'awaiting_confirmation', 0, '{}', '{}', ?, ?)`).run("native-active", now, now);
    f.db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'ep', 1, ?, 'segment', 'SEG01', 'canvas', 'h3-node', ?, 'submitted')`).run("native-active", "a".repeat(64), JSON.stringify([{ targetId: "SEG01", segmentId: "clip-1" }]));
    f.db.db.prepare(`INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at)
        VALUES (?, 'canvas-h3-run', 'running', 0, '{}', '{}', ?, ?)`).run("other-owner-active", now, now);
    f.db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'elsewhere', 1, ?, 'segment', 'SEG99', 'other', 'h3-node', ?, 'submitted')`).run("other-owner-active", "b".repeat(64), JSON.stringify([{ targetId: "SEG99", segmentId: "clip-99" }]));
    assert.deepEqual(f.episode.continuityUpgradeActiveRuns("ep"), [{ runId: "native-active", status: "awaiting_confirmation", targets: [{ targetId: "SEG01", segmentId: "clip-1" }] }]);
});

test("editing an episode director synchronizes scene instances and seeds isolated scene source drafts", t => {
    const f = fixture(t);
    const source = {
        fps_num: 24, fps_den: 1,
        script_scenes: [
            { id: "SC_A", scene_id: "LOC1", scene_name: "First", kind: "action", beat_ids: ["b1"], text: "Only scene A" },
            { id: "SC_B", scene_id: "LOC2", scene_name: "Second", kind: "action", beat_ids: ["b2"], text: "Only scene B" },
        ],
        shots: [
            { id: "SH_A", scene_id: "LOC1", source_scene_id: "SC_A" },
            { id: "SH_B", scene_id: "LOC2", source_scene_id: "SC_B" },
        ],
        asset_plan: [], segments: [{ id: "SEG_A", shot_ids: ["SH_A"] }, { id: "SEG_MIX", shot_ids: ["SH_A", "SH_B"] }],
    };
    const director = directorProductionSchema.parse({
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "1" },
        source, sourceHash: directorHash(source),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    });
    const edited = f.episode.edit("ep", { operationId: "sync-scenes-from-production", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    assert.equal(edited.revision, 1);
    assert.equal(getSceneInstance(f.db, "SC_A")?.episodeId, "ep");
    assert.equal(getSceneInstance(f.db, "SC_A")?.status, "active");
    assert.equal(getSceneInstance(f.db, "SC01")?.status, "orphaned");

    const sceneDraft = f.scene.get("SC_A").draft.director!;
    const sceneSource = sceneDraft.source as Record<string, any>;
    assert.deepEqual(sceneSource.script_scenes.map((item: any) => item.id), ["SC_A"]);
    assert.deepEqual(sceneSource.shots.map((item: any) => item.id), ["SH_A"]);
    assert.deepEqual(sceneSource.segments.map((item: any) => item.id), ["SEG_A"]);
    assert.deepEqual(sceneDraft.assets, {});
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM scene_productions").get()!.n, 0, "reading a scene seeds its source without persisting or generating media");

    const sceneEdit = f.scene.edit("SC_A", { operationId: "edit-only-scene-a", expectedRevision: 0, ops: [{ type: "set_director_brief", brief: "Scene A only" }] });
    assert.equal(sceneEdit.revision, 1);
    assert.equal(f.scene.get("SC_B").revision, 0);
    assert.equal(f.episode.get("ep").revision, 1, "scene edits do not write back to the episode owner");
});

test("the canvas owner keeps its own project-keyed table", t => {
    const f = fixture(t);
    f.db.upsertDramaEpisode({ id: "plain", dramaId: "drama", episodeNumber: 2, title: "Plain Episode", synopsis: "" });
    f.db.createCanvasProject({ id: "plain", title: "Plain", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } });
    f.db.db.prepare("INSERT INTO canvas_productions (project_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 5, ?, NULL, 2, ?)").run("plain", EMPTY_PRODUCTION, "2026-01-01");
    assert.equal(f.canvas.get("plain").revision, 5);
    assert.equal(f.canvas.get("plain").publishedVersion, 2);
    assert.equal(f.episode.get("plain").revision, 0);
});

test("an unmapped table name is refused instead of silently querying the wrong table", t => {
    const f = fixture(t);
    const prepare = (f.scene as unknown as { prepare: (sql: string) => unknown }).prepare.bind(f.scene);
    // A production-worded table that is not any owner's formal table is refused before SQLite sees it.
    assert.throws(() => prepare("SELECT * FROM episode_widgets"), /制作存储映射不包含表 episode_widgets/);
    assert.throws(() => prepare("SELECT 1 FROM scene_drafts"), /制作存储映射不包含表 scene_drafts/);
    // Another owner's table name is rewritten to this owner's table and key, not refused.
    assert.doesNotThrow(() => prepare("SELECT 1 FROM episode_productions WHERE episode_id=?"));
    // A mapped table with the episode key must still resolve its key column.
    assert.doesNotThrow(() => prepare("SELECT 1 FROM episode_productions WHERE episode_id=?"));
    // The known shapes all resolve.
    for (const table of ["episode_productions", "episode_production_operations", "episode_production_versions", "episode_production_runs", "episode_production_batches"]) {
        assert.doesNotThrow(() => prepare(`SELECT 1 FROM ${table} WHERE episode_id=?`));
    }
});

test("a scene canvas resolves to an independent editable and publishable scene production", t => {
    const f = fixture(t);
    const canvasId = ensureSceneProductionCanvas(f.db, "SC01").project.id;
    const initial = f.scene.get("SC01");
    assert.equal(initial.revision, 0);
    const edited = f.scene.edit("SC01", { operationId: "scene-brief", expectedRevision: 0, ops: [{ type: "set_director_brief", brief: "Only this scene" }] });
    assert.equal(edited.revision, 1);
    assert.equal(edited.draft.director?.source.brief, "Only this scene");
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM scene_productions WHERE scene_id='SC01'").get()!.n, 1);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM episode_productions WHERE episode_id='ep'").get()!.n, 0);
    const plan = f.db.getProductionLayoutPlan(canvasId);
    assert.equal(plan?.owner.kind, "scene");

    const published = f.scene.publish("SC01", { operationId: "scene-publish", expectedRevision: 1, stage: "director" });
    assert.equal(published.publishedVersion, 1);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM scene_production_versions WHERE scene_id='SC01'").get()!.n, 1);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM episode_production_versions WHERE episode_id='ep'").get()!.n, 0);
    assert.equal(f.scene.workflowReadiness("SC01").presentation?.owner.kind, "scene");
    assert.throws(() => f.scene.startBatch("SC01", {}), /SCENE_GENERATION_NOT_READY/);
    assert.ok(canvasId.startsWith("production-scene-"));
});
