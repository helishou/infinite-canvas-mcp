import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { directorHash, promptHash } from "./director.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import express from "express";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "acheng-canvas-"));
    const file = join(dir, "db.sqlite");
    const db = new BackendDatabase(file), stores = createStores(db);
    db.upsertCanvasFolder({ id: "d", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "d", episodeNumber: 1, title: "Episode", synopsis: "", fullPlot: "", canvasId: "canvas" });
    db.setSetting("plugin:minimax-h3:defaults:v1", { modelName: "test-model" });
    const service = new EpisodeProductionService(db, undefined, undefined, false, () => {});
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, stores, service, file, dir };
}
function doc(count = 2): DirectorProduction {
    const engine = { commit: "a".repeat(40), patchVersion: "patch", runtimeId: "engine-test", version: "4.3.9" };
    const shots = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, scene_id: "scene", start_frame: i * 120, end_frame: (i + 1) * 120, visual: `authored ${i}`, camera: { description: "static" }, state_in: {}, state_out: {}, dialogues: [], audio: {} }));
    const segments = shots.map((s, i) => ({ id: `seg${i}`, shot_ids: [s.id], start_frame: s.start_frame, end_frame: s.end_frame, generation_clip_duration: 5, mode: "T2VA" }));
    const source = { fps_num: 24, fps_den: 1, script_scenes: [{ id: "scene-block", scene_id: "scene", text: "Original full text" }], shots, segments, extra_preserved: { detail: "never summarized" } };
    const sourceHash = directorHash(source);
    return { schemaVersion: 1, engine, source, sourceHash, modules: { story: { status: "committed", evidence: ["source reviewed"], unresolved: [] } }, assets: {},
        shotInputs: Object.fromEntries(shots.map(s => [s.id, { keyframePolicy: "none", assetIds: [] }])), boundaries: segments.slice(0, -1).map((s, i) => ({ from: s.id, to: segments[i + 1].id, tailFrame: false, motionContext: false, reason: "authored cut" })),
        artifacts: segments.map(s => { const prompt = `integrated_multimodal_description:\n[Shot 1] ${s.id} performs the complete authored action.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A\n`; const sha256 = promptHash(prompt); return { id: s.id, kind: "h3", targetId: s.id, prompt, sha256, sourceHash, status: "ready", references: [], receipt: { sourceHash, promptHash: sha256, engineRuntimeId: engine.runtimeId, validator: "test-fixture" } }; }),
        executionAuthorized: false, unresolved: [], workflow: { cursor: "done" } };
}
function publish(service: EpisodeProductionService, director: DirectorProduction, id = "ep") {
    const current = service.get(id);
    service.edit(id, { operationId: `edit-${current.revision}`, expectedRevision: current.revision, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { mode: "auto" } }] });
    return service.publish(id, { operationId: `publish-${current.revision}`, expectedRevision: current.revision + 1, stage: "director" });
}

test("director source, complete prompt, partial cursor and stable IDs round-trip without implicit Clips", async t => {
    const { db, stores, service } = fixture(t); const d = doc();
    const published = publish(service, d);
    assert.deepEqual(published.published!.director, d);
    assert.deepEqual(published.published!.clipGroups.map(g => g.id), ["seg0", "seg1"]);
    assert.equal(service.run("ep", 1), null);
    const runner = new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService);
    await runner.syncClips("ep", 1);
    const group = service.get("ep").published!.clipGroups[0];
    const node = (db.getCanvasProject("canvas")!.nodes as any[]).find(n => n.id === group.nodeId);
    assert.equal(node.metadata.segments[0].prompt, d.artifacts[0].prompt);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { resultStorageKey: "history" } }], { runtimeWrite: true });
    await runner.syncClips("ep", 1);
    assert.equal(((db.getCanvasProject("canvas")!.nodes as any[]).find(n => n.id === group.nodeId)).metadata.segments[0].resultStorageKey, "history");
    assert.equal(service.get("ep").published!.director!.engine.runtimeId, d.engine.runtimeId);
});

test("source revisions reject stale receipts, preserve drafts and prohibit projection-only edits", t => {
    const { service } = fixture(t); const d = doc(); publish(service, d);
    const rev = service.get("ep").revision;
    assert.throws(() => service.edit("ep", { operationId: "bad", expectedRevision: rev - 1, ops: [{ type: "set_director_production", director: d }] }), ProductionConflictError);
    const changed = structuredClone(d); changed.source.newFact = "changed"; changed.sourceHash = directorHash(changed.source);
    assert.throws(() => service.edit("ep", { operationId: "stale", expectedRevision: rev, ops: [{ type: "set_director_production", director: changed }] }), /回执版本/);
    changed.artifacts.forEach(a => a.status = "stale"); changed.modules.story = { status: "partial", cursor: "paragraph-2", evidence: [], unresolved: ["continue"] };
    const input = { operationId: "partial", expectedRevision: rev, ops: [{ type: "set_director_production", director: changed }] };
    service.edit("ep", input); assert.equal(service.edit("ep", input).replayed, true);
    assert.equal(service.get("ep").draft.director!.modules.story?.cursor, "paragraph-2");
    assert.throws(() => service.edit("ep", { operationId: "projection", expectedRevision: rev + 1, ops: [{ type: "delete_shot", id: "s0" }] }), /正式源/);
});

test("multi-shot Segment is preserved, illegal time windows and legacy exemptions are rejected", t => {
    const { service } = fixture(t); const d = doc();
    const segments = d.source.segments as any[];
    segments[0].shot_ids = ["s0", "s1"]; segments[0].end_frame = 240; segments[0].generation_clip_duration = 10; segments.pop();
    d.boundaries = []; d.artifacts = []; d.sourceHash = directorHash(d.source);
    assert.deepEqual(publish(service, d).published!.clipGroups[0].shotIds, ["s0", "s1"]);
    const invalid = structuredClone(d); (invalid.source.segments as any[])[0].generation_clip_duration = 16; invalid.sourceHash = directorHash(invalid.source);
    assert.throws(() => publish(service, invalid), /帧窗/);
    invalid.source = { ...d.source, prompt_detail_policy: { profile: "legacy_fixture" } }; invalid.sourceHash = directorHash(invalid.source);
    assert.throws(() => publish(service, invalid), /legacy_fixture/);
});

test("project scope supports independent assets and linked views share the same source", t => {
    const { db, service } = fixture(t); const canvas = new EpisodeProductionService(db, undefined, undefined, true, () => {});
    publish(service, doc()); assert.deepEqual(canvas.get("canvas").draft, service.get("ep").draft);
    db.createCanvasProject({ id: "independent", title: "Assets", nodes: [], connections: [] });
    const d = doc(0); d.source.asset_cards = []; d.sourceHash = directorHash(d.source);
    const result = publish(canvas, d, "independent");
    assert.equal(result.published!.director!.sourceHash, d.sourceHash);
    assert.equal(canvas.get("independent").publishedVersion, 1);
    assert.equal(db.getDramaEpisode("independent"), null);
});

test("version 16 migration backs up data and keeps unknown future versions closed", t => {
    const { db, file, dir } = fixture(t);
    db.db.prepare("DELETE FROM schema_migrations WHERE version=17").run();
    for (const table of ["canvas_productions", "canvas_production_operations", "canvas_production_versions", "canvas_production_runs"]) db.db.exec(`DROP TABLE ${table}`);
    const reopened = new BackendDatabase(file);
    assert.equal(reopened.getDramaEpisode("ep")?.title, "Episode");
    assert.ok(readdirSync(dir).some(n => n.includes("pre-schema-v16-to-v17"))); reopened.close();
});

test("Motion Context group submits one bounded task and standalone next Clip remains separate", async t => {
    const { db, service, stores, dir } = fixture(t); const d = doc(3); d.executionAuthorized = true;
    d.boundaries[0].motionContext = true; d.boundaries[1].tailFrame = true;
    publish(service, d);
    const commands: CanvasGenerationCommand[] = [];
    const fake = { start: async (command: CanvasGenerationCommand) => {
        commands.push(command); const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {});
        const project = db.getCanvasProject("canvas")!; const node = (project.nodes as any[]).find(n => n.id === command.nodeId);
        const start = node.metadata.segments.findIndex((s: any) => s.id === command.segmentId);
        const end = command.runFromCurrent ? node.metadata.segments.findIndex((s: any) => s.id === command.endSegmentId) : start;
        const media = { storageKey: `video:${task.id}`, filePath: join(dir, `${task.id}.mp4`), mimeType: "video/mp4", bytes: 10, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() };
        writeFileSync(media.filePath, "test video"); db.upsertMediaFile(media);
        db.applyCanvasProjectOperations("canvas", undefined, node.metadata.segments.slice(start, end + 1).map((s: any) => ({ type: "update_h3_segment", nodeId: node.id, segmentId: s.id, patch: { resultStorageKey: media.storageKey } })), { runtimeWrite: true });
        stores.tasks.update(task.id, { status: "succeeded" }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    await runner.run("ep", 1); assert.equal(service.run("ep", 1)?.status, "succeeded", service.run("ep", 1)?.error || "");
    assert.equal(commands.length, 2); assert.equal(commands[0].runFromCurrent, true); assert.equal(commands[0].skipCompleted, false);
    assert.notEqual(commands[0].segmentId, commands[0].endSegmentId); assert.equal(commands[1].runFromCurrent, false);
    assert.equal(JSON.stringify(commands).includes('"previousVideoAsReference":true'), false);
    await runner.run("ep", 1); assert.equal(commands.length, 2);
});

test("failed generation pauses without resubmission or deleting earlier results", async t => {
    const { stores, service } = fixture(t); const d = doc(1); d.executionAuthorized = true; publish(service, d);
    let count = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => { count++; const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {}); stores.tasks.update(task.id, { status: "failed", error: "simulated provider failure" }); return { taskId: task.id }; } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake); await runner.run("ep", 1); await runner.run("ep", 1);
    assert.equal(count, 1); assert.equal(service.run("ep", 1)?.status, "paused"); assert.match(service.run("ep", 1)?.error || "", /simulated/);
});

test("asset dependencies and style approval block premature execution while drafts remain recoverable", t => {
    const { service, db } = fixture(t); const d = doc(0);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "character", nodeType: "config", metadata: { smart: true, generationMode: "image" } }]);
    d.assets = { STYLE_MOTHER: { nodeId: "style", version: "v1", status: "planned" }, CHAR: { nodeId: "character", version: "v1", status: "planned" } };
    d.source.asset_plan = [{ id: "STYLE_MOTHER", version: "v1", depends_on: [] }, { id: "CHAR", version: "v1", depends_on: ["STYLE_MOTHER"] }];
    d.source.style_policy = "required"; d.source.style_lock = { anchor_asset_id: "STYLE_MOTHER" };
    d.sourceHash = directorHash(d.source);
    const prompt = "Complete character asset prompt", digest = promptHash(prompt);
    d.artifacts = [{ id: "character-image", kind: "image", targetId: "CHAR", prompt, sha256: digest, sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, promptHash: digest, engineRuntimeId: d.engine.runtimeId, validator: "test" } }];
    assert.throws(() => publish(service, d), /依赖未批准/);
    d.artifacts[0].status = "draft";
    assert.equal(publish(service, d).published!.director!.artifacts[0].status, "draft");
});

test("independent style generation writes real media and waits for review without repeat submission", async t => {
    const { service, stores, db, dir } = fixture(t); const d = doc(0);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "style", nodeType: "config", metadata: { smart: true, generationMode: "image", model: "mock-image" } }]);
    d.assets = { STYLE_MOTHER: { nodeId: "style", version: "v1", status: "planned" } };
    d.source.asset_plan = [{ id: "STYLE_MOTHER", kind: "style", version: "v1", depends_on: [] }]; d.sourceHash = directorHash(d.source);
    const prompt = "The complete style mother prompt", digest = promptHash(prompt);
    d.artifacts = [{ id: "style-image", kind: "image", targetId: "STYLE_MOTHER", prompt, sha256: digest, sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, promptHash: digest, engineRuntimeId: d.engine.runtimeId, validator: "fixture" } }];
    d.executionAuthorized = true; publish(service, d); let submitted = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        submitted++; assert.equal(command.prompt, prompt);
        const task = stores.tasks.create(command.idempotencyKey!, "image", command, {});
        const filePath = join(dir, "style.png"); writeFileSync(filePath, "test-image");
        db.upsertMediaFile({ storageKey: "image:style", filePath, bytes: 10, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "style", metadata: { storageKey: "image:style" } }]);
        stores.tasks.update(task.id, { status: "succeeded" }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake); await runner.run("ep", 1); await runner.run("ep", 1);
    assert.equal(submitted, 1); assert.equal(service.run("ep", 1)?.status, "awaiting_review");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.status, "generated");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.storageKey, "image:style");
});

test("HTTP director operations round-trip and project facade shares the episode revision", async t => {
    const { service, db } = fixture(t);
    const app = express(); app.use(express.json());
    registerDramaProductionRoutes(app, service);
    registerDramaProductionRoutes(app, new EpisodeProductionService(db, undefined, undefined, true, () => {}), undefined, "/canvas/projects/:episodeId/production");
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const edited = await post("/canvas/projects/canvas/production/ops", { operationId: "http-edit", expectedRevision: 0, ops: [{ type: "set_director_production", director: doc() }] });
    assert.equal(edited.status, 200);
    const published = await post("/drama/episodes/ep/production/publish", { operationId: "http-publish", expectedRevision: 1, stage: "director" });
    assert.equal(published.status, 200);
    const current = await (await fetch(base + "/canvas/projects/canvas/production")).json() as any;
    assert.equal(current.production.publishedVersion, 1); assert.equal(current.production.published.director.sourceHash, doc().sourceHash);
    const stale = await post("/canvas/projects/canvas/production/ops", { operationId: "stale", expectedRevision: 0, ops: [{ type: "set_director_production", director: doc() }] });
    assert.equal(stale.status, 409);
});
