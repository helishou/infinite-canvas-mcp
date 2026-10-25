import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { directorHash } from "./director.js";
import { emptyEpisodeProduction, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { getProductionContract, preflightDirector, preflightProductionRequest } from "@basketikun/canvas-agent/skills/acheng";

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "production-preflight-"));
    const db = new BackendDatabase(join(dir, "test.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", fullPlot: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, undefined, false, () => {});
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, service };
}

function snapshot(db: BackendDatabase) {
    const tables = ["episode_productions", "episode_production_operations", "episode_production_versions", "episode_production_batches", "runtime_tasks", "canvas_projects"];
    return tables.filter(name => db.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name)).map(name => [name, db.db.prepare(`SELECT * FROM ${name}`).all()]);
}

test("edit diagnostics and successful preflight leave every production table unchanged", async t => {
    const { db, service } = fixture(t);
    const before = snapshot(db);
    const valid = { operationId: "edit", expectedRevision: 0, ops: [{ type: "upsert_scene", scene: { id: "scene", heading: "Room", location: "Room", timeOfDay: "Day", blocks: [] } }] };
    assert.equal((await service.preflight("episode", { action: "edit", request: valid })).valid, true);
    const invalid = await service.preflight("episode", { action: "edit", request: { ...valid, ops: [{ type: "set_director_brief", brief: {} }] } });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.diagnostics[0].path, "request.ops.0.brief");
    assert.deepEqual(snapshot(db), before);
    await service.edit("episode", valid);
    const rePreflight = await service.preflight("episode", { action: "edit", request: valid });
    assert.ok(!rePreflight.diagnostics.some(d => d.code === "REVISION_CONFLICT"), "乐观锁放行：过期 revision 不再产生冲突诊断");
    assert.equal((await service.edit("episode", valid)).replayed, true);
});

test("missing entity patches are preflighted without mutation, while unavailable publication/generation are diagnosed", async t => {
    const { db, service } = fixture(t);
    const source = { version: 2, prompt_assembly: { version: 2 }, brief: "Plan a character", fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [], scene_registry: [], shots: [], segments: [], utterances: [], asset_plan: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    await service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const before = snapshot(db);
    const patch = await service.preflight("episode", { action: "edit", request: { operationId: "patch", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "asset", id: "missing", patch: { description: "Appearance" } }] } });
    const offline = await preflightProductionRequest({ action: "edit", request: { operationId: "patch", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "asset", id: "missing", patch: { description: "Appearance" } }] } }, service.get("episode"));
    assert.deepEqual(offline.diagnostics.filter(item => item.code === "INVALID_OPERATION"), patch.diagnostics);
    assert.ok(!patch.diagnostics.some(item => item.code === "INVALID_OPERATION"));
    assert.equal(patch.valid, true);
    assert.deepEqual(snapshot(db), before);
    const applied = await service.edit("episode", { operationId: "patch", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "asset", id: "missing", patch: { description: "Appearance" } }] });
    assert.ok((applied.draft.director!.source.asset_plan as any[]).some(item => item.id === "missing"));
    const afterPatch = snapshot(db);
    const run = await service.preflight("episode", { action: "generate", request: { runId: "run", idempotencyKey: "key", expectedRevision: applied.revision, version: 1, targets: ["asset:missing"] } });
    assert.equal(run.valid, false);
    assert.equal(run.generationReady, false);
    assert.deepEqual(snapshot(db), afterPatch);
});

test("stage-specific checks do not prohibit unfinished planning drafts", async t => {
    const { db, service } = fixture(t);
    const before = snapshot(db);
    const request = { operationId: "publish", expectedRevision: 0, stage: "director" };
    assert.equal((await service.preflight("episode", { action: "publish", request })).valid, false);
    assert.deepEqual(service.get("episode").draft, emptyEpisodeProduction());
    assert.deepEqual(snapshot(db), before);
});

test("target edits save a next source revision while the original run remains occupied and isolated", async t => {
    const { db, service } = fixture(t);
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }],
        script_scenes: [{ id: "scene", scene_id: "room", beat_ids: ["b1", "b2"] }],
        shots: [{ id: "s1", source_scene_id: "scene", scene_id: "room", story_beat_ids: ["b1"], story_order: 0, duration_frames: 120, visual: "first" },
            { id: "s2", source_scene_id: "scene", scene_id: "room", story_beat_ids: ["b2"], story_order: 1, duration_frames: 120, visual: "second" }],
        segments: [{ id: "seg1", shot_ids: ["s1"], mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], mode: "T2VA" }], utterances: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    await service.edit("episode", { operationId: "seed-occupied", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    db.db.prepare("INSERT INTO episode_production_batches (run_id,episode_id,idempotency_key,request_hash,version,source_revision,status,targets_json,plan_json,engine_json,settings_json,submitted_json,pause_requested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("original-run", "episode", "original-key", "hash", 1, 1, "running", '["segment:seg1"]', '{}', '{}', '{}', JSON.stringify([{ kind: "h3", id: "seg1", taskId: "exact-task" }]), 0, "now", "now");
    const original = service.get("episode");
    const request = { operationId: "edit-during-run", expectedRevision: original.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg1", patch: { styleTemplateId: "soft-light" } }] };
    const checked = await service.preflight("episode", { action: "edit", request });
    assert.equal(checked.valid, true);
    assert.equal(service.targetOccupancy("episode", ["seg1"])[0].runId, "original-run");
    const saved = await service.edit("episode", request);
    assert.equal(saved.revision, original.revision + 1);
    assert.equal((saved.draft.director!.source.segments as any[]).find(segment => segment.id === "seg1").styleTemplateId, "soft-light");
    assert.equal(service.getBatch("episode", "original-run")?.status, "running");
    assert.deepEqual(service.getBatch("episode", "original-run")?.targets, ["segment:seg1"]);
    assert.equal(service.targetOccupancy("episode", ["seg1"])[0].runId, "original-run");
    const unrelated = await service.edit("episode", { operationId: "other-clip", expectedRevision: saved.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg2", patch: { styleTemplateId: "soft-light" } }] });
    assert.equal(unrelated.revision, saved.revision + 1);
    assert.equal((await service.edit("episode", { operationId: "other-clip", expectedRevision: saved.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg2", patch: { styleTemplateId: "soft-light" } }] })).replayed, true);
});

test("offline warnings do not make Backend preflight reject an unfinished v2 source", async t => {
    const contract = getProductionContract();
    assert.ok((contract as any).engine?.runtimeId, "the no-argument guide identifies the active engine");
    const { db } = fixture(t);
    const service = new EpisodeProductionService(db);
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], scene_registry: [{ id: "ROOM", name: "Room" }],
        shots: [{ id: "SHOT1", source_scene_id: "scene", scene_id: "ROOM", story_beat_ids: [], story_order: 0, timeline_id: "main", duration_frames: 120, visual: "An authored room shot." }],
        segments: [{ id: "SEG001", timeline_id: "main", shot_ids: ["SHOT1"], mode: "Ref2VA", mode_lock: true, mode_selection_reason: "Use the actual reference." }],
        asset_cards: [{ id: "asset", recipe: "invented" }], style_lock: { preserve_scope: "palette", exclude_scope: ["x"] },
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", label: "Main" }], initial: [], events: [], requirements: [], coverage: [] } };
    const director: DirectorProduction = { schemaVersion: 1, engine: contract.engine, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    const offline = await preflightDirector(director);
    const online = await service.preflight("episode", { action: "edit", request: { operationId: "check", expectedRevision: 0, ops: [{ type: "set_director_production", director }] } });
    assert.equal(offline.valid, true, JSON.stringify(offline.diagnostics));
    assert.equal(online.valid, true, JSON.stringify(online.diagnostics));
    assert.ok(offline.diagnostics.some(item => item.code === "INVALID_SUBJECT_SOURCE" && item.severity === "warning"), JSON.stringify(offline.diagnostics));
    assert.equal(offline.generationReady, false);
    assert.equal(service.get("episode").revision, 0);
});
