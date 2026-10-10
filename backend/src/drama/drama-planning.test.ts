import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { EpisodeProductionService } from "./production.js";
import { dramaProductionPlanSchema, productionImageModel } from "@basketikun/canvas-agent/drama/production-contract";

test("confirmed category models persist, seed new production, and leave existing settings intact", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drama-planning-"));
    const file = path.join(directory, "db.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => { db.close(); assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
    const folder = db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, outline: "Story", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const service = new EpisodeProductionService(db, undefined, directory, false, () => {});
    db.upsertDramaEpisode({ dramaId: "drama", id: "old", episodeNumber: 1, title: "Old", synopsis: "" });
    service.edit("old", { operationId: "old-settings", expectedRevision: 0, ops: [{ type: "set_settings", patch: { imageModel: "old-image", h3Model: "old-video" } }] });
    const plan = dramaProductionPlanSchema.parse({ imageModel: "general", imageModelsByKind: { character: "role-model", scene: "scene-model", keyframe: "frame-model" }, h3Model: "video", videoAspectRatio: "16:9", storyboardImageMode: "skip", confirmedOutline: "Story", confirmedAt: new Date().toISOString() });
    const saved = db.upsertCanvasFolder({ ...folder, productionPlan: plan, expectedPlanningUpdatedAt: folder.updatedAt, updatedAt: "2026-02-01" });
    assert.deepEqual(db.listCanvasFolders()[0].productionPlan, plan);
    db.upsertDramaEpisode({ dramaId: "drama", id: "new", episodeNumber: 2, title: "New", synopsis: "" });
    const inherited = service.get("new").draft.settings;
    assert.equal(inherited.h3Model, "video");
    assert.equal(inherited.videoAspectRatio, "16:9");
    assert.equal(inherited.storyboardImageMode, "skip");
    const source = { asset_plan: [{ asset_id: "role", kind: "character" }, { asset_id: "scene", kind: "scene" }, { asset_id: "frame", kind: "keyframe" }, { asset_id: "prop", kind: "prop" }] };
    assert.deepEqual(["role", "scene", "frame", "prop"].map(id => productionImageModel(inherited, source, id)), ["role-model", "scene-model", "frame-model", "general"]);
    assert.equal(productionImageModel({ ...inherited, imageModels: { scene: "individual" } }, source, "scene"), "individual");
    assert.equal(service.get("old").draft.settings.imageModel, "old-image");
    assert.equal(service.get("old").draft.settings.h3Model, "old-video");
    assert.equal(service.get("old").draft.settings.storyboardImageMode, undefined);
    assert.throws(() => db.upsertCanvasFolder({ ...folder, productionPlan: plan, expectedPlanningUpdatedAt: folder.updatedAt }), /其他窗口/);
    assert.deepEqual(db.listCanvasFolders()[0].productionPlan, plan);
    const renamed = db.upsertCanvasFolder({ id: saved.id, name: "Renamed", createdAt: saved.createdAt, isDrama: true, outline: "Story" });
    assert.equal(db.listCanvasFolders()[0].productionPlan?.imageModelsByKind.scene, "scene-model");
    assert.equal(Object.hasOwn(renamed, "expectedPlanningUpdatedAt"), false);
});

test("v39 migrates old review policies to none without touching published production", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drama-review-policy-v39-"));
    const file = path.join(directory, "db.sqlite");
    let db = new BackendDatabase(file);
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const folder = db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, outline: "Story", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const manualPlan = dramaProductionPlanSchema.parse({ imageModel: "", imageModelsByKind: {}, h3Model: "", confirmedOutline: "Story", confirmedAt: new Date().toISOString(),
        reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } });
    db.upsertCanvasFolder({ ...folder, productionPlan: manualPlan, expectedPlanningUpdatedAt: folder.updatedAt });
    db.upsertDramaEpisode({ dramaId: "drama", id: "episode", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, undefined, directory, false, () => {});
    service.edit("episode", { operationId: "manual-review-setting", expectedRevision: 0, ops: [{ type: "set_settings", patch: { reviewPolicy: manualPlan.reviewPolicy } }] });
    db.db.prepare("DELETE FROM schema_migrations WHERE version=39").run();
    db.close();

    db = new BackendDatabase(file);
    const migratedService = new EpisodeProductionService(db, undefined, directory, false, () => {});
    assert.equal(migratedService.get("episode").draft.settings.reviewPolicy.mode, "none");
    assert.equal(db.listCanvasFolders()[0].productionPlan?.reviewPolicy?.mode, "none");
    assert.equal(db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
});

test("a v24 database upgrades to the current schema, snapshots first and preserves existing outlines", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drama-plan-upgrade-"));
    t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
    const file = path.join(directory, "db.sqlite");
    let db = new BackendDatabase(file);
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, outline: "Preserved", createdAt: "2026-01-01" });
    // Simulate a genuine v24 database: nothing above v24 recorded and the v25 column absent.
    // Dropping only the v25 row would leave MAX(version) at the current schema and skip every migration.
    db.db.exec(`ALTER TABLE drama_projects DROP COLUMN production_plan_json`);
    db.db.exec(`DELETE FROM schema_migrations WHERE version > 24`);
    db.close();
    db = new BackendDatabase(file);
    try {
        assert.equal(db.listCanvasFolders()[0].outline, "Preserved");
        assert.equal(db.listCanvasFolders()[0].productionPlan, undefined);
        assert.equal(db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
        assert.equal((db.db.prepare("PRAGMA table_info(drama_projects)").all() as Array<Record<string, unknown>>).some(column => column.name === "production_plan_json"), true);
        assert.equal(fs.readdirSync(directory).filter(name => name.includes(`.pre-schema-v24-to-v${DATABASE_SCHEMA_VERSION}-`)).length, 1);
    } finally { db.close(); }
});
