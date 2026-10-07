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

test("edit diagnostics and successful preflight leave every production table unchanged", t => {
    const { db, service } = fixture(t);
    const before = snapshot(db);
    const valid = { operationId: "edit", expectedRevision: 0, ops: [{ type: "upsert_scene", scene: { id: "scene", heading: "Room", location: "Room", timeOfDay: "Day", blocks: [] } }] };
    assert.equal(service.preflight("episode", { action: "edit", request: valid }).valid, true);
    const invalid = service.preflight("episode", { action: "edit", request: { ...valid, ops: [{ type: "set_director_brief", brief: {} }] } });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.diagnostics[0].path, "request.ops.0.brief");
    assert.deepEqual(snapshot(db), before);
    service.edit("episode", valid);
    assert.equal(service.preflight("episode", { action: "edit", request: valid }).diagnostics[0].code, "REVISION_CONFLICT");
    assert.equal(service.edit("episode", valid).replayed, true);
});

test("missing patch targets and unavailable publication/generation are diagnosed without mutation", t => {
    const { db, service } = fixture(t);
    const source = { brief: "Plan a character", shots: [], segments: [], asset_plan: [] };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const before = snapshot(db);
    const patch = service.preflight("episode", { action: "edit", request: { operationId: "patch", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "asset", id: "missing", patch: { description: "Appearance" } }] } });
    const offline = preflightProductionRequest({ action: "edit", request: { operationId: "patch", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "asset", id: "missing", patch: { description: "Appearance" } }] } }, service.get("episode"));
    assert.deepEqual(offline.diagnostics.filter(item => item.code === "INVALID_OPERATION"), patch.diagnostics);
    assert.equal(patch.valid, false);
    assert.equal(patch.diagnostics[0].targetId, "missing");
    assert.match(patch.diagnostics[0].message, /不存在/);
    const run = service.preflight("episode", { action: "generate", request: { runId: "run", idempotencyKey: "key", expectedRevision: 1, version: 1, targets: ["asset:missing"] } });
    assert.equal(run.valid, false);
    assert.equal(run.generationReady, false);
    assert.deepEqual(snapshot(db), before);
});

test("stage-specific checks do not prohibit unfinished planning drafts", t => {
    const { db, service } = fixture(t);
    const before = snapshot(db);
    const request = { operationId: "publish", expectedRevision: 0, stage: "director" };
    assert.equal(service.preflight("episode", { action: "publish", request }).valid, false);
    assert.deepEqual(service.get("episode").draft, emptyEpisodeProduction());
    assert.deepEqual(snapshot(db), before);
});

test("target edits report the original occupying run and tasks before changing source, while unrelated Clips remain editable", t => {
    const { db, service } = fixture(t);
    const source = { shots: [{ id: "s1" }, { id: "s2" }], segments: [{ id: "seg1", shot_ids: ["s1"], mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], mode: "T2VA" }] };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    service.edit("episode", { operationId: "seed-occupied", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    db.db.prepare("INSERT INTO episode_production_batches (run_id,episode_id,idempotency_key,request_hash,version,source_revision,status,targets_json,plan_json,engine_json,settings_json,submitted_json,pause_requested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("original-run", "episode", "original-key", "hash", 1, 1, "running", '["segment:seg1"]', '{}', '{}', '{}', JSON.stringify([{ kind: "h3", id: "seg1", taskId: "exact-task" }]), 0, "now", "now");
    const original = service.get("episode");
    const request = { operationId: "blocked-edit", expectedRevision: original.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg1", patch: { styleTemplateId: "soft-light" } }] };
    const checked = service.preflight("episode", { action: "edit", request });
    assert.equal(checked.valid, false);
    assert.equal(checked.diagnostics[0].code, "TARGET_OCCUPIED");
    assert.deepEqual(checked.diagnostics[0].blockingRun?.taskIds, ["exact-task"]);
    assert.equal(checked.nextActions?.[0].input?.runId, "original-run");
    assert.equal(service.targetOccupancy("episode", ["seg1"])[0].runId, "original-run");
    assert.throws(() => service.edit("episode", request), /original-run/);
    assert.deepEqual(service.get("episode"), original);
    const unrelated = service.edit("episode", { operationId: "other-clip", expectedRevision: original.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg2", patch: { styleTemplateId: "soft-light" } }] });
    assert.equal(unrelated.revision, original.revision + 1);
    assert.equal(service.edit("episode", { operationId: "other-clip", expectedRevision: original.revision, ops: [{ type: "patch_director_source", entity: "segment", id: "seg2", patch: { styleTemplateId: "soft-light" } }] }).replayed, true);
});

test("offline and Backend share the activated engine source diagnostics", t => {
    const contract = getProductionContract();
    if (!contract.sourceContract) return t.skip("Activate the versioned Canvas source contract to run this integration check");
    const { db } = fixture(t);
    const service = new EpisodeProductionService(db);
    const source = { fps_num: 24, fps_den: 1, shots: [], segments: [{ id: "SEG001", mode: "Ref2VA", mode_lock: true, mode_selection_reason: "Use the actual reference." }], asset_cards: [{ id: "asset", recipe: "invented" }], style_lock: { preserve_scope: "palette", exclude_scope: ["x"] } };
    const director: DirectorProduction = { schemaVersion: 1, engine: contract.engine, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    const offline = preflightDirector(director);
    const online = service.preflight("episode", { action: "edit", request: { operationId: "check", expectedRevision: 0, ops: [{ type: "set_director_production", director }] } });
    assert.equal(offline.valid, false); assert.equal(online.valid, false);
    assert.ok(offline.diagnostics.some(item => item.code === "INVALID_SOURCE"), JSON.stringify(offline.diagnostics));
    assert.deepEqual(online.diagnostics.filter(item => item.code === "INVALID_SOURCE"), offline.diagnostics.filter(item => item.code === "INVALID_SOURCE"));
    assert.equal(offline.generationReady, false);
    assert.equal(service.get("episode").revision, 0);
});
