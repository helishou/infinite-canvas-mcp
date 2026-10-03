import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("successful generation preflight preserves currentWork and creates no run or receipt", async t => {
    const { db, service, stores } = fixture(t);
    const d = doc(1);
    d.workflow = { mediaProductionMode: "automatic", currentWork: { workId: "work", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: 0 } };
    publish(service, d);
    await new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService).syncClips("ep", 1);
    const current = service.get("ep"), before = JSON.stringify(current);
    const request = { runId: "run", workId: "work", idempotencyKey: "run", expectedRevision: current.revision, version: 1, targets: ["segment:seg0"] };
    const preflight = service.preflight("ep", { action: "generate", request });
    assert.equal(preflight.valid, true, JSON.stringify(preflight.diagnostics));
    assert.equal(JSON.stringify(service.get("ep")), before);
    assert.equal(service.getBatch("ep", "run"), null);
    const batch = service.startBatch("ep", request);
    assert.equal(service.get("ep").draft.director?.workflow.currentWork?.runId, "run");
    assert.equal(service.startBatch("ep", request).runId, batch.runId);
});

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

test("early Acheng planning drafts save without node bindings and readiness scopes missing compile work", t => {
    const { service } = fixture(t);
    const d = doc(0);
    d.source = { brief: "写一个独立资产计划", fps_num: 24, fps_den: 1, script_scenes: [{ id: "scene1", scene_id: "scene1", scene_name: "雨夜站台", text: "保留的逐字对白。", extension: { owner: "acheng" } }], shots: [], asset_plan: [{ id: "STYLE_MOTHER", kind: "style", description: "冷雨与暖灯形成对照。", depends_on: [] }], segments: [], extension: { authored: true } };
    d.sourceHash = directorHash(d.source);
    d.assets = { STYLE_MOTHER: { version: "v1", status: "planned" } };
    d.artifacts = [];
    d.modules = { story: { status: "partial", cursor: { scene: "scene1" }, evidence: [], unresolved: ["下一段待写"] }, assets: { status: "planned", evidence: [], unresolved: [] } };
    const current = service.get("ep");
    const edited = service.edit("ep", { operationId: "early-plan", expectedRevision: current.revision, ops: [{ type: "set_director_production", director: d }] });
    assert.equal(edited.draft.director?.assets.STYLE_MOTHER.nodeId, undefined);
    assert.match(service.workflowReadiness("ep").targets.find(item => item.id === "asset:STYLE_MOTHER")?.blockers.join(" ") || "", /尚未发布/);
    const patched = service.edit("ep", { operationId: "patch-scene", expectedRevision: edited.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "scene1", patch: { text: "修订后的逐字对白。" } }] });
    assert.equal((patched.draft.director!.source.extension as any).authored, true);
    assert.equal((patched.draft.director!.source.script_scenes as any[])[0].text, "修订后的逐字对白。");
    assert.equal((patched.draft.director!.modules.story!.cursor as any).scene, "scene1");
    const published = service.publish("ep", { operationId: "publish-early", expectedRevision: patched.revision, stage: "director" });
    assert.equal(published.publishedVersion, 1);
    assert.equal(service.run("ep", 1), null);
    const readiness = service.workflowReadiness("ep");
    assert.equal(readiness.targets.find(item => item.id === "asset:STYLE_MOTHER")?.status, "blocked");
    assert.match(readiness.targets.find(item => item.id === "asset:STYLE_MOTHER")?.blockers.join(" ") || "", /完整编译提示词/);
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

test("multi-shot Segment is preserved, invalid windows remain saved but blocked, and legacy fixtures are rejected", t => {
    const { service } = fixture(t); const d = doc();
    const segments = d.source.segments as any[];
    segments[0].shot_ids = ["s0", "s1"]; segments[0].end_frame = 240; segments[0].generation_clip_duration = 10; segments.pop();
    d.boundaries = []; d.artifacts = []; d.sourceHash = directorHash(d.source);
    assert.deepEqual(publish(service, d).published!.clipGroups[0].shotIds, ["s0", "s1"]);
    const invalid = structuredClone(d); (invalid.source.segments as any[])[0].generation_clip_duration = 16; invalid.sourceHash = directorHash(invalid.source);
    const invalidSaved = publish(service, invalid);
    assert.equal(invalidSaved.publishedVersion, 2);
    assert.ok(service.workflowReadiness("ep", "published").targets.find(item => item.id === "segment:seg0")?.blockers.some(item => /4–15/.test(item)));
    invalid.source = { ...d.source, prompt_detail_policy: { profile: "legacy_fixture" } }; invalid.sourceHash = directorHash(invalid.source);
    assert.throws(() => publish(service, invalid), /legacy_fixture/);
});

test("structured Segment regrouping preserves Shot content and invalidates only its compile receipt", t => {
    const { service } = fixture(t); const d = doc(3);
    (d.source.shots as any[])[1].dialogues = [{ speaker: "信使", text: "这句对白必须保留。" }]; d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    publish(service, d);
    const current = service.get("ep");
    const regrouped = service.edit("ep", { operationId: "regroup", expectedRevision: current.revision, ops: [{ type: "set_director_segment_group", segmentId: "seg0", shotIds: ["s0", "s1"], removeSegmentIds: ["seg1"] }] });
    const director = regrouped.draft.director!;
    assert.equal((director.source.segments as any[]).length, 2);
    assert.deepEqual((director.source.segments as any[])[0].shot_ids, ["s0", "s1"]);
    assert.equal((director.source.segments as any[])[0].generation_clip_duration, 10);
    assert.equal((director.source.shots as any[])[1].dialogues[0].text, "这句对白必须保留。");
    assert.ok(director.artifacts.every(item => item.status === "stale"));
    assert.deepEqual(regrouped.draft.clipGroups.map(group => group.shotIds), [["s0", "s1"], ["s2"]]);

    const latest = service.get("ep");
    assert.throws(() => service.edit("ep", { operationId: "non-adjacent", expectedRevision: latest.revision, ops: [{ type: "set_director_segment_group", segmentId: "seg0", shotIds: ["s0", "s2"], removeSegmentIds: [] }] }), /相邻 Shot/);
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

test("version 16 migration backs up data and creates run history without rewriting production rows", t => {
    const { db, file, dir } = fixture(t);
    db.db.prepare("DELETE FROM schema_migrations WHERE version>=17").run();
    for (const table of ["canvas_productions", "canvas_production_operations", "canvas_production_versions", "canvas_production_runs"]) db.db.exec(`DROP TABLE ${table}`);
    db.db.exec("DROP TABLE canvas_production_batches; DROP TABLE episode_production_batches");
    const reopened = new BackendDatabase(file);
    assert.equal(reopened.getDramaEpisode("ep")?.title, "Episode");
    assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_production_batches'").get());
    assert.ok(readdirSync(dir).some(n => n.includes("pre-schema-v16-to-v22"))); reopened.close();
});

test("version 21 databases add production batch storage in schema version 22", t => {
    const { db, file } = fixture(t);
    db.db.exec("DELETE FROM schema_migrations WHERE version=22; DROP TABLE canvas_production_batches; DROP TABLE episode_production_batches");
    const upgraded = new BackendDatabase(file);
    const version = upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    assert.equal(version.version, 22);
    assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='episode_production_batches'").get());
    assert.equal(upgraded.getDramaEpisode("ep")?.title, "Episode");
    upgraded.close();
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
    const first = service.startBatch("ep", { runId: "motion-chain", idempotencyKey: "motion-chain", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg0"] });
    const duplicateIntent = { runId: "other-motion-chain", idempotencyKey: "other-motion-chain", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg1"] };
    assert.throws(() => service.startBatch("ep", duplicateIntent), /已由运行 motion-chain 占用/);
    assert.equal(service.startBatch("ep", { ...duplicateIntent, runId: "motion-chain", idempotencyKey: "motion-chain", targets: ["segment:seg0"] }).runId, "motion-chain", "an idempotent replay returns the existing run before overlap checks");
    await runner.runBatch("ep", first.runId); assert.equal(service.getBatch("ep", first.runId)?.status, "succeeded", service.getBatch("ep", first.runId)?.error || "");
    assert.equal(commands.length, 1); assert.equal(commands[0].runFromCurrent, true); assert.equal(commands[0].skipCompleted, false);
    assert.notEqual(commands[0].segmentId, commands[0].endSegmentId);
    assert.equal(JSON.stringify(commands).includes('"previousVideoAsReference":true'), false);
    const second = service.startBatch("ep", { runId: "tail-frame-next", idempotencyKey: "tail-frame-next", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg2"] });
    await runner.runBatch("ep", second.runId);
    assert.equal(commands.length, 2); assert.equal(commands[1].runFromCurrent, false);
    await runner.runBatch("ep", first.runId); assert.equal(commands.length, 2);
});

test("failed generation pauses without resubmission or deleting earlier results", async t => {
    const { stores, service } = fixture(t); const d = doc(1); d.executionAuthorized = true; publish(service, d);
    let count = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => { count++; const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {}); stores.tasks.update(task.id, { status: "failed", error: "simulated provider failure" }); return { taskId: task.id }; } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const batch = service.startBatch("ep", { runId: "failed-run", idempotencyKey: "failed-run", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg0"] });
    await runner.runBatch("ep", batch.runId); await runner.runBatch("ep", batch.runId);
    assert.equal(count, 1); assert.equal(service.getBatch("ep", batch.runId)?.status, "failed"); assert.match(service.getBatch("ep", batch.runId)?.error || "", /simulated/);
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
    const saved = publish(service, d);
    assert.equal(saved.publishedVersion, 1);
    const readiness = service.workflowReadiness("ep", "published");
    assert.equal(readiness.targets.find(item => item.id === "asset:CHAR")?.status, "blocked");
    assert.match(readiness.targets.find(item => item.id === "asset:CHAR")?.blockers.join(" ") || "", /STYLE_MOTHER/);
    assert.equal(service.get("ep").draft.director?.sourceHash, d.sourceHash);
});

test("automatic dependency runs pause for review, then continue the same runId without regenerating approved media", async t => {
    const { service, stores, db, dir } = fixture(t); const d = doc(0);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "style", nodeType: "config", metadata: { smart: true, generationMode: "image", model: "mock-image" } }]);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "character", nodeType: "image", metadata: { model: "mock-image" } }]);
    d.assets = { STYLE_MOTHER: { nodeId: "style", version: "v1", status: "planned" }, CHAR: { nodeId: "character", version: "v1", status: "planned" } };
    d.source.asset_plan = [{ id: "STYLE_MOTHER", kind: "style", version: "v1", depends_on: [] }, { id: "CHAR", kind: "character", version: "v1", depends_on: ["STYLE_MOTHER"] }];
    d.source.style_policy = "required"; d.source.style_lock = { anchor_asset_id: "STYLE_MOTHER" };
    d.workflow = { contentDeliveryMode: "auto_file_batch", mediaProductionMode: "automatic" };
    d.sourceHash = directorHash(d.source);
    const stylePrompt = "The complete style mother prompt", styleDigest = promptHash(stylePrompt);
    const characterPrompt = "The complete character prompt", characterDigest = promptHash(characterPrompt);
    const styleMediaHash = crypto.createHash("sha256").update("test-STYLE_MOTHER").digest("hex");
    d.artifacts = [
        { id: "style-image", kind: "image", targetId: "STYLE_MOTHER", prompt: stylePrompt, sha256: styleDigest, sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, promptHash: styleDigest, engineRuntimeId: d.engine.runtimeId, validator: "fixture" } },
        { id: "character-image", kind: "image", targetId: "CHAR", prompt: characterPrompt, sha256: characterDigest, sourceHash: d.sourceHash, status: "ready", references: [{ label: "<Picture 1>", nodeId: "style", storageKey: "image:style_mother", sha256: styleMediaHash, role: "style mother" }], receipt: { sourceHash: d.sourceHash, promptHash: characterDigest, engineRuntimeId: d.engine.runtimeId, validator: "fixture" } },
    ];
    publish(service, d); let submitted = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        submitted++;
        const assetId = command.nodeId === "style" ? "STYLE_MOTHER" : "CHAR";
        assert.equal(command.prompt, assetId === "STYLE_MOTHER" ? stylePrompt : characterPrompt);
        const task = stores.tasks.create(command.idempotencyKey!, "image", command, {});
        const storageKey = `image:${assetId.toLowerCase()}`, bytes = `test-${assetId}`, filePath = join(dir, `${assetId}.png`); writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: command.nodeId, metadata: { storageKey } }]);
        stores.tasks.update(task.id, { status: "succeeded" }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const batch = service.startBatch("ep", { runId: "style-run", idempotencyKey: "style-run", expectedRevision: service.get("ep").revision, version: 1, targets: ["asset:STYLE_MOTHER"], scope: "all_ready" });
    await runner.runBatch("ep", batch.runId); await runner.runBatch("ep", batch.runId);
    assert.equal(submitted, 1); assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.status, "generated");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.storageKey, "image:style_mother");
    const sha256 = styleMediaHash;
    const current = service.get("ep");
    assert.throws(() => service.edit("ep", { operationId: "bad-review", expectedRevision: current.revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 2, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256, verdict: "approved", evidence: "checked" }] }), /审核目标不属于/);
    assert.throws(() => service.edit("ep", { operationId: "bad-hash", expectedRevision: current.revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 1, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256: "0".repeat(64), verdict: "approved", evidence: "checked" }] }), /摘要/);
    const reviewed = service.edit("ep", { operationId: "asset-review", expectedRevision: service.get("ep").revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 1, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256, verdict: "approved", evidence: "identity and style checked" }] });
    assert.equal(reviewed.published!.director!.assets.STYLE_MOTHER.status, "approved");
    const readinessAfterStyle = service.workflowReadiness("ep", "published");
    assert.equal(readinessAfterStyle.targets.find(item => item.id === "asset:CHAR")?.status, "ready", JSON.stringify(readinessAfterStyle.targets));
    const continued = service.resumeBatch("ep", batch.runId);
    assert.ok(continued.targets.includes("asset:CHAR"), "automatic scope should release newly ready dependencies after approval");
    await runner.runBatch("ep", batch.runId);
    assert.equal(submitted, 2);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
    const charMediaHash = crypto.createHash("sha256").update("test-CHAR").digest("hex");
    service.edit("ep", { operationId: "char-review", expectedRevision: service.get("ep").revision, ops: [{ type: "review_director_asset", assetId: "CHAR", version: 1, sourceHash: d.sourceHash, nodeId: "character", storageKey: "image:char", sha256: charMediaHash, verdict: "approved", evidence: "character follows STYLE_MOTHER" }] });
    service.resumeBatch("ep", batch.runId);
    await runner.runBatch("ep", batch.runId);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "succeeded");
    assert.equal(submitted, 2);
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
    const readiness = await (await fetch(base + "/drama/episodes/ep/production/readiness")).json() as any;
    assert.equal(readiness.readiness.targets.find((item: any) => item.id === "segment:seg0")?.status, "ready");
    const missingBatch = await fetch(base + "/drama/episodes/ep/production/batches/not-started");
    assert.equal(missingBatch.status, 200);
    assert.equal((await missingBatch.json() as any).run, null);
    const runInput = { runId: "http-run", idempotencyKey: "http-run", expectedRevision: current.production.revision, version: 1, targets: ["segment:seg0"] };
    const started = await post("/drama/episodes/ep/production/runs", runInput);
    assert.equal(started.status, 200);
    const replay = await post("/drama/episodes/ep/production/runs", runInput);
    assert.equal((await replay.json() as any).run.runId, "http-run");
    const paused = await post("/drama/episodes/ep/production/batches/http-run/pause", {});
    assert.equal((await paused.json() as any).run.status, "paused");
    const resumed = await post("/drama/episodes/ep/production/batches/http-run/resume", {});
    assert.equal((await resumed.json() as any).run.status, "pending");
    const stale = await post("/canvas/projects/canvas/production/ops", { operationId: "stale", expectedRevision: 0, ops: [{ type: "set_director_production", director: doc() }] });
    assert.equal(stale.status, 409);
});

test("currentWork readiness presentation stays outside the content hash and validates run ownership across aliases", t => {
    const { service, db } = fixture(t);
    const d = doc(1);
    const initialHash = d.sourceHash;
    const current = service.get("ep");
    const edited = service.edit("ep", { operationId: "set-current-work", expectedRevision: current.revision, ops: [
        { type: "set_director_production", director: d },
        { type: "set_director_workflow", patch: { currentWork: { workId: "work-stable", module: "story", action: "author", targetKind: "story", inputRevision: current.revision, sourceHash: initialHash } } },
    ] });
    assert.equal(edited.draft.director?.sourceHash, initialHash);
    assert.equal(edited.draft.director?.workflow.currentWork?.workId, "work-stable");
    const presentation = service.workflowReadiness("ep").presentation;
    assert.equal(presentation?.owner.kind, "episode");
    assert.equal(presentation?.workspace, "story");
    assert.equal(presentation?.workId, "work-stable");

    const beforeRun = service.get("ep");
    assert.throws(() => service.edit("ep", { operationId: "bad-current-work-run", expectedRevision: beforeRun.revision, ops: [{
        type: "set_director_workflow", patch: { currentWork: { workId: "work-stable", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: beforeRun.revision, sourceHash: initialHash, runId: "wrong-object-run" } },
    }] }), /runId/);
    assert.throws(() => service.edit("ep", { operationId: "stale-current-work", expectedRevision: beforeRun.revision, ops: [{
        type: "set_director_workflow", patch: { currentWork: { workId: "work-stable", module: "assets", action: "author", inputRevision: beforeRun.revision, sourceHash: "0".repeat(64) } },
    }] }), /源哈希/);

    const route = new EpisodeProductionService(db, undefined, undefined, true, () => {}).workflowReadiness("canvas").presentation;
    assert.equal(route?.owner.kind, "canvas");
    assert.equal(route?.owner.id, "canvas");
    assert.ok(route?.aliases?.includes("ep"));
});

test("legacy readiness infers a stable presentation without persisting a work focus", t => {
    const { service, db } = fixture(t);
    const empty = service.get("ep");
    const uninitialized = service.workflowReadiness("ep").presentation;
    assert.equal(uninitialized?.workspace, "overview");
    assert.equal(uninitialized?.action, "blocked");
    assert.equal(uninitialized?.workId, "legacy:ep");
    assert.deepEqual(service.get("ep"), empty);

    const canvasView = new EpisodeProductionService(db, undefined, undefined, true, () => {}).workflowReadiness("canvas").presentation;
    assert.equal(canvasView?.owner.kind, "canvas");
    assert.equal(canvasView?.owner.id, "canvas");
    assert.equal(canvasView?.workId, uninitialized?.workId);
    assert.ok(canvasView?.aliases?.includes("ep"));

    const director = doc(0);
    director.modules.assets = { status: "partial", evidence: [], unresolved: ["缺少 STYLE_MOTHER"] };
    const current = service.get("ep");
    service.edit("ep", { operationId: "legacy-director", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });
    const inferred = service.workflowReadiness("ep").presentation;
    assert.equal(inferred?.workId, "legacy:ep");
    assert.equal(inferred?.workspace, "assets");
    assert.equal(inferred?.action, "author");
    assert.equal(inferred?.reason, "缺少 STYLE_MOTHER");
    assert.equal(service.get("ep").draft.director?.workflow.currentWork, undefined);
});

test("production batches bind workId and runId atomically and replay without a second revision", t => {
    const { service } = fixture(t);
    const d = doc(1);
    d.workflow = { ...d.workflow, currentWork: { workId: "bounded-work", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: 0, sourceHash: d.sourceHash } };
    const settingsBase = service.get("ep");
    service.edit("ep", { operationId: "settings-before-run", expectedRevision: settingsBase.revision, ops: [{ type: "set_settings", patch: { h3Model: "test-h3" } }] });
    publish(service, d);
    const before = service.get("ep");
    const input = { runId: "bounded-run", idempotencyKey: "bounded-run", workId: "bounded-work", expectedRevision: before.revision, version: before.publishedVersion, targets: ["segment:seg0"], scope: "selected" as const };
    const run = service.startBatch("ep", input);
    const after = service.get("ep");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.draft.director?.workflow.currentWork?.runId, run.runId);
    assert.equal(after.draft.director?.sourceHash, d.sourceHash);
    assert.equal(service.workflowReadiness("ep", "draft", run.runId).presentation?.runId, run.runId);
    assert.equal(service.startBatch("ep", input).runId, run.runId);
    assert.equal(service.get("ep").revision, after.revision);
});
