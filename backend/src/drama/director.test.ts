import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { NativeProductionGeneration } from "./native-generation.js";
import { BackendEventBus } from "../events.js";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { directorHash, projectDirector, promptHash } from "./director.js";
import { emptyEpisodeProduction, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { compilationScopeInput, currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import { effectiveTargetInput, inputHash } from "./canvas-inputs.js";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import express from "express";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { historicalDatabase } from "../test-helpers/historical-database.js";

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
    const shots = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, scene_id: "scene", source_scene_id: "scene-block", timeline_id: "main", story_order: i, duration_frames: 120, visual: `authored ${i}`, camera: { description: "static" } }));
    const segments = shots.map((s, i) => ({ id: `seg${i}`, shot_ids: [s.id], mode: "T2VA" }));
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [], scene_registry: [], script_scenes: [{ id: "scene-block", scene_id: "scene", text: "Original full text" }], shots, segments, utterances: [], asset_plan: [], extra_preserved: { detail: "never summarized" }, ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] } };
    const sourceHash = directorHash(source);
    return { schemaVersion: 1, engine, source, sourceHash, modules: { story: { status: "committed", evidence: ["source reviewed"], unresolved: [] } }, assets: {},
        shotInputs: Object.fromEntries(shots.map(s => [s.id, { keyframePolicy: "none", assetIds: [] }])), boundaries: segments.slice(0, -1).map((s, i) => ({ from: s.id, to: segments[i + 1].id, tailFrame: false, motionContext: false, reason: "authored cut" })),
        artifacts: segments.map(s => { const prompt = `integrated_multimodal_description:\n[Shot 1] ${s.id} performs the complete authored action.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A\n`; const sha256 = promptHash(prompt); return { id: s.id, kind: "h3", targetId: s.id, prompt, sha256, sourceHash, status: "ready", references: [], receipt: { sourceHash, promptHash: sha256, engineRuntimeId: engine.runtimeId, validator: "test-fixture" } }; }),
        executionAuthorized: false, unresolved: [], workflow: { cursor: "done" } };
}
async function publish(service: EpisodeProductionService, director: DirectorProduction, id = "ep", storyboardImageMode?: "generate" | "skip") {
    const current = service.get(id);
    await service.edit(id, { operationId: `edit-${current.revision}`, expectedRevision: current.revision, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { mode: "auto", ...(storyboardImageMode ? { storyboardImageMode } : {}) } }] });
    return await service.publish(id, { operationId: `publish-${current.revision}`, expectedRevision: current.revision + 1, stage: "director" });
}

test("parallel H3 completion requires terminal task, active archived output and matching frozen inputs", async t => {
    const { service, stores, db, dir } = fixture(t), d = doc(1);
    await publish(service, d, "ep", "skip");
    await service.edit("ep", { operationId: "parallel", expectedRevision: service.get("ep").revision, ops: [{ type: "set_settings", patch: { parallelScenes: true, reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } } }] });
    const work = { workId: "work", sceneId: "scene-block", inputRevision: 1, sourceHash: d.sourceHash, inputHash: compilationScopeInput(d, { sceneId: "scene-block" }).inputHash, stage: "produce", status: "pending", policy: { mode: "manual", shared: "manual", scene: "manual" }, updatedAt: new Date().toISOString(), review: { sourceHash: d.sourceHash, inputHash: compilationScopeInput(d, { sceneId: "scene-block" }).inputHash, verdict: "approved", mode: "manual", evidence: "source inspected", media: [], checkedAt: new Date().toISOString() } };
    await service.edit("ep", { operationId: "review", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: { work } } }] }, undefined, true);
    await service.publish("ep", { operationId: "parallel-publish", expectedRevision: service.get("ep").revision, stage: "director" });
    const fake = { start: async (command: CanvasGenerationCommand) => {
        const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {});
        const storageKey = `video:${task.id}`, filePath = join(dir, "result.mp4"); writeFileSync(filePath, "test-video");
        db.upsertMediaFile({ storageKey, filePath, mimeType: "video/mp4", bytes: 10, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: command.nodeId, segmentId: command.segmentId!, patch: { resultStorageKey: storageKey } }], { runtimeWrite: true });
        stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey }] } }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const batch = await service.startBatch("ep", { inputBasis: "published", runId: "parallel-video", idempotencyKey: "parallel-video", expectedRevision: service.get("ep").revision, version: service.get("ep").publishedVersion, targets: ["segment:seg0"] });
    await runner.runBatch("ep", batch.runId);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "succeeded", service.getBatch("ep", batch.runId)?.error || "");
    assert.equal(service.workflowReadiness("ep", "published").targets.find(target => target.id === "segment:seg0")?.status, "complete");
    const taskId = service.getBatch("ep", batch.runId)!.submitted[0].taskId;
    stores.tasks.update(taskId, { result: null });
    assert.equal(service.workflowReadiness("ep", "published").targets.find(target => target.id === "segment:seg0")?.status, "ready", "node-only output cannot establish completion");
});

test("independent successful Clips remain complete in a failed batch without parallelScenes", async t => {
    const { service, stores, db, dir } = fixture(t), director = doc(2);
    director.workflow.mediaProductionMode = "automatic";
    await publish(service, director, "ep", "skip");
    const commands: CanvasGenerationCommand[] = [];
    let failSecond = true;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        commands.push(command);
        const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {});
        if (command.segmentId === service.get("ep").published!.clipGroups[1].segmentId && failSecond) {
            stores.tasks.update(task.id, { status: "failed", error: "fetch failed" });
        } else {
            const storageKey = `video:${task.id}`, filePath = join(dir, `${task.id}.mp4`);
            writeFileSync(filePath, "archived-video");
            db.upsertMediaFile({ storageKey, filePath, mimeType: "video/mp4", bytes: 14, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() });
            db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: command.nodeId, segmentId: command.segmentId!, patch: { resultStorageKey: storageKey } }], { runtimeWrite: true });
            stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey }] } });
        }
        return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const start = async (runId: string, targets: string[]) => await service.startBatch("ep", { inputBasis: "canvas", runId, idempotencyKey: runId,
        expectedRevision: service.get("ep").revision, version: service.get("ep").publishedVersion, targets });
    await runner.syncClips("ep", service.get("ep").publishedVersion);
    db.applyCanvasProjectOperations("canvas", undefined, service.get("ep").published!.clipGroups.map(group => ({ type: "update_h3_segment", nodeId: group.nodeId!, segmentId: group.segmentId!,
        patch: { modelName: "test-model", h3ParameterPolicy: "overrides", h3ParameterOverrides: { modelName: "test-model" } } })));
    await runner.runBatch("ep", (await start("mixed", ["segment:seg0", "segment:seg1"])).runId);
    assert.equal(service.getBatch("ep", "mixed")!.status, "failed");
    const mixed = service.getBatch("ep", "mixed")!;
    assert.equal(mixed.submitted.find(item => item.id === "segment:seg0")?.status, "succeeded", mixed.error || "");
    const first = mixed.executionSnapshot!.targets[0], firstTask = stores.tasks.get(mixed.submitted[0].taskId)!;
    assert.equal(firstTask.projectId, "canvas");
    assert.equal(firstTask.nodeId, first.nodeId);
    const firstNode = (db.getCanvasProject("canvas")!.nodes as any[]).find(node => node.id === first.nodeId);
    const firstClip = firstNode.metadata.segments.find((clip: any) => clip.id === first.segmentId);
    assert.equal(firstClip.resultStorageKey, (firstTask.result!.media as any[])[0].storageKey);
    assert.equal(inputHash(effectiveTargetInput(db.getCanvasProject("canvas")!, first.nodeId, first.segmentId, db.getSetting("plugin:minimax-h3:defaults:v1") as any)), first.inputHash);
    const states = () => service.workflowReadiness("ep", "published").targets.filter(target => target.kind === "segment").map(target => target.status);
    assert.deepEqual(states(), ["complete", "ready"]);
    await runner.syncClips("ep", service.get("ep").publishedVersion, ["seg0"]);
    assert.equal(commands.length, 2, "resynchronizing a complete Clip does not submit a new task");
    failSecond = false;
    await runner.runBatch("ep", (await start("retry-failed", ["segment:seg1"])).runId);
    assert.equal(service.getBatch("ep", "retry-failed")!.status, "succeeded", service.getBatch("ep", "retry-failed")!.error || "");
    const retry = service.getBatch("ep", "retry-failed")!, frozen = retry.executionSnapshot!, target = frozen.targets[0];
    assert.equal(inputHash(effectiveTargetInput(db.getCanvasProject("canvas")!, target.nodeId, target.segmentId, db.getSetting("plugin:minimax-h3:defaults:v1") as any)), target.inputHash);
    assert.deepEqual(states(), ["complete", "complete"]);
    assert.equal(commands.length, 3, "only the failed target is regenerated");
    const group = service.get("ep").published!.clipGroups[0];
    const project = db.getCanvasProject("canvas")!;
    const node = (project.nodes as any[]).find(node => node.id === group.nodeId);
    const clip = node.metadata.segments.find((clip: any) => clip.id === group.segmentId);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { prompt: clip.prompt + " Changed saved input." } }]);
    assert.deepEqual(states(), ["ready", "complete"], "historical success cannot complete a changed current input");
});

for (const edited of [false, true]) test(`fresh compilation owns the prepared Clip Prompt: edited=${edited}`, async t => {
    const { service, stores, db } = fixture(t), director = doc(1);
    await service.edit("ep", { operationId: "draft-without-prompt", expectedRevision: 0, ops: [
        { type: "set_director_production", director: { ...director, artifacts: [] } },
        { type: "set_settings", patch: { storyboardImageMode: "skip" } },
    ] });
    const runner = new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService);
    await runner.prepareTargets("ep", service.get("ep").revision, ["segment:seg0"], "prepare-empty");
    const group = service.get("ep").draft.clipGroups[0];
    const clip = () => (db.getCanvasProject("canvas")!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.equal(clip().prompt, "");
    assert.equal(clip().productionClipProjection.targetId, "seg0");
    if (edited) db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { prompt: "User authored replacement" } }]);
    const applied = await service.edit("ep", { operationId: "apply-compiled-prompt", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] }, undefined, false, undefined, undefined, new Set(["seg0"]));
    assert.equal(clip().prompt, director.artifacts[0].prompt);
    assert.ok(applied.referenceSync?.some(item => item.targetId === "seg0" && item.status === "ready"));
    if (edited) assert.equal(clip().productionClipProjection.conflicts.includes("prompt"), false);
});

test("skipping storyboard images retains written shots and allows ready H3 segments", async t => {
    const { service, stores } = fixture(t);
    const d = doc(1);
    const keyframeId = "FRAME-S0";
    d.source.asset_plan = [{ asset_id: keyframeId, kind: "keyframe", name: "s0 frame" }];
    d.shotInputs = {};
    d.assets[keyframeId] = { version: "v1", status: "planned" };
    const imagePrompt = "A clear storyboard keyframe for s0";
    const imageDigest = promptHash(imagePrompt);
    d.sourceHash = directorHash(d.source);
    d.artifacts = [...d.artifacts.map(artifact => ({ ...artifact, sourceHash: d.sourceHash, receipt: { ...artifact.receipt, sourceHash: d.sourceHash } })), {
        id: "frame-artifact", kind: "image", targetId: keyframeId, prompt: imagePrompt, sha256: imageDigest, sourceHash: d.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: d.sourceHash, promptHash: imageDigest, engineRuntimeId: d.engine.runtimeId, validator: "test-fixture" },
    }];
    const published = await publish(service, d, "ep", "skip");
    assert.equal(published.published?.shots[0].visual, "authored 0");
    assert.equal(published.published?.shots[0].keyframePolicy, "none");
    assert.deepEqual(published.published?.clipGroups[0].shotIds, ["s0"]);
    const readiness = service.workflowReadiness("ep", "published");
    assert.equal(readiness.targets.some(target => target.id === "frame:s0" || target.id === `asset:${keyframeId}`), false);
    assert.equal(readiness.targets.find(target => target.id === "segment:seg0")?.status, "ready", readiness.targets.find(target => target.id === "segment:seg0")?.blockers.join("; "));
    const runner = new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService);
    await assert.rejects(() => runner.prepareTargets("ep", service.get("ep").revision, ["frame:s0"], "prepare-skipped-frame"), /跳过分镜图/);
    await assert.rejects(() => runner.prepareTargets("ep", service.get("ep").revision, [`asset:${keyframeId}`], "prepare-skipped-frame-asset"), /跳过分镜图/);
    await runner.syncClips("ep", published.publishedVersion);
    const synced = service.get("ep").published!;
    const group = synced.clipGroups[0];
    const node = (stores.projects.get("canvas")?.nodes as Array<{ id: string; metadata?: Record<string, unknown> }>).find(item => item.id === group.nodeId);
    const clip = (node?.metadata?.segments as Array<Record<string, unknown>>).find(item => item.id === group.segmentId);
    assert.deepEqual(clip?.storyboardShots, [{ id: "s0", duration: 5 }]);
});

test('Clip sync loads saved defaults, persists episode aspect and keeps existing user parameters and history', async t => {
    const { db, stores, service } = fixture(t);
    db.setSetting('plugin:minimax-h3:defaults:v1', { modelName: 'test-model', sampler: 'er_sde', megapixels: 0.6, latentUpscaleEnabled: true, loraSlots: [{ name: 'turbo', strength: 0.75, enabled: true }] });
    const current = service.get('ep');
    await service.edit('ep', { operationId: 'settings-first', expectedRevision: current.revision, ops: [{ type: 'set_settings', patch: { videoAspectRatio: '9:16', videoAspectRatioConfirmed: true } }] });
    await publish(service, doc());
    assert.equal(service.get('ep').draft.settings.videoAspectRatioConfirmed, true);
    const runner = new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService);
    await runner.syncClips('ep', 1);
    const group = service.get('ep').published!.clipGroups[0];
    const node = () => (db.getCanvasProject('canvas')!.nodes as any[]).find(item => item.id === group.nodeId);
    assert.equal(node().metadata.sampler, 'er_sde');
    assert.equal(node().metadata.megapixels, 0.6);
    assert.equal(node().metadata.segments[0].aspectRatio, '9:16');
    assert.equal(node().metadata.latentUpscaleEnabled, true);
    db.applyCanvasProjectOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { modelName: 'user-model', sampler: 'euler', loraSlots: [{ name: 'user-lora', strength: 0.4, enabled: true }] } }]);
    db.applyCanvasProjectOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { resultStorageKey: 'old-result' } }], { runtimeWrite: true });
    await runner.syncClips('ep', 1);
    assert.equal(node().metadata.segments[0].modelName, 'user-model');
    assert.equal(node().metadata.segments[0].sampler, 'euler');
    assert.equal(node().metadata.segments[0].resultStorageKey, 'old-result');
    const requirements = stores.projects.getH3ProductionRequirements!('canvas');
    assert.equal(requirements!.videoAspectRatio, '9:16');
    assert.equal(requirements!.clips.length, 2);
});

test('published H3 batch and native submission retain UI settings instead of old node parameters', async t => {
    const { db, stores, service } = fixture(t);
    db.setSetting('plugin:minimax-h3:defaults:v1', { megapixels: 0.6, latentUpscaleEnabled: true, latentUpscaleConfirmationMode: true, loraSlots: [{ name: 'old-turbo', strength: 0.75, enabled: true }] });
    await publish(service, doc(), 'ep', 'skip');
    await new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService).syncClips('ep', 1);
    const group = service.get('ep').published!.clipGroups[0];
    const uiSettings = { modelName: 'ui-model', megapixels: 0.8, videoSteps: 12, latentUpscaleEnabled: false, latentUpscaleConfirmationMode: false, loraSlots: [{ name: 'ui-dmad', strength: 1, enabled: true }], h3ParameterPolicy: 'overrides' };
    stores.projects.applyOperations('canvas', undefined, [{ type: 'update_h3_segment', nodeId: group.nodeId!, segmentId: group.segmentId!, patch: uiSettings }]);
    const saved = stores.projects.get('canvas')!;
    const before = JSON.stringify(saved);
    const batch = await service.startBatch('ep', { inputBasis: 'published', runId: 'published-ui-settings', idempotencyKey: 'published-ui-settings', expectedRevision: service.get('ep').revision, version: 1, targets: [`segment:${group.id}`] });
    assert.ok(batch.executionSnapshot);
    const observer = new NativeProductionGeneration(db, stores, service, service, new BackendEventBus());
    const native = observer.prepare({ inputBasis: 'published', mode: 'video', operation: 'h3-run', projectId: 'canvas', nodeId: group.nodeId!, segmentId: group.segmentId! });
    assert.ok(native.executionProject);
    for (const project of [batch.executionSnapshot!.project, native.executionProject!]) {
        const node = (project.nodes as any[]).find(node => node.id === group.nodeId);
        const segment = node.metadata.segments.find((clip: any) => clip.id === group.segmentId);
        const runtime = resolveH3Runtime(segment, {}, node.metadata, {}).params;
        assert.equal(runtime.modelName, 'ui-model');
        assert.equal(runtime.megapixels, 0.8);
        assert.equal(runtime.steps, 12);
        assert.equal(runtime.latentUpscaleEnabled, false);
        assert.equal(runtime.latentUpscaleConfirmationMode, false);
        assert.deepEqual(runtime.loraSlots, uiSettings.loraSlots);
        assert.equal(segment.prompt, service.get('ep').published!.director!.artifacts.find(artifact => artifact.kind === 'h3' && artifact.targetId === group.id)!.prompt);
    }
    assert.equal(JSON.stringify(stores.projects.get('canvas')), before);
    assert.equal(stores.tasks.list().length, 0);
});

test("successful generation preflight preserves currentWork and creates no run or receipt", async t => {
    const { db, service, stores } = fixture(t);
    const d = doc(1);
    d.workflow = { mediaProductionMode: "automatic", currentWork: { workId: "work", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: 0 } };
    await publish(service, d);
    await new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService).syncClips("ep", 1);
    const current = service.get("ep"), before = JSON.stringify(current);
    const request = { inputBasis: "published" as const, runId: "run", workId: "work", idempotencyKey: "run", expectedRevision: current.revision, version: 1, targets: ["segment:seg0"] };
    const preflight = await service.preflight("ep", { action: "generate", request });
    assert.equal(preflight.valid, true, JSON.stringify(preflight.diagnostics));
    assert.equal(JSON.stringify(service.get("ep")), before);
    assert.equal(service.getBatch("ep", "run"), null);
    const batch = await service.startBatch("ep", request);
    assert.equal(service.get("ep").draft.director?.workflow.currentWork?.runId, "run");
    assert.equal((await service.startBatch("ep", request)).runId, batch.runId);
});

test("canvas aliases create, replay and control the canonical episode batch", async t => {
    const { db, service, stores } = fixture(t);
    const director = doc(1);
    director.workflow = { mediaProductionMode: "automatic" };
    await publish(service, director);
    await new EpisodeProductionRunner(service, stores, {} as CanvasGenerationService).syncClips("ep", 1);
    const canvas = new EpisodeProductionService(db, undefined, undefined, true, () => {});
    const input = { inputBasis: "published" as const, runId: "alias-run", idempotencyKey: "alias-run", expectedRevision: canvas.get("canvas").revision, version: 1, targets: ["segment:seg0"] };
    const run = await canvas.startBatch("canvas", input);
    assert.equal(run.episodeId, "ep");
    assert.equal(service.getBatch("ep", "alias-run")?.runId, run.runId);
    assert.equal((await canvas.startBatch("canvas", input)).runId, run.runId);
    assert.equal(db.db.prepare("SELECT count(*) n FROM canvas_production_batches").get()?.n, 0);
    assert.equal(canvas.pauseBatch("canvas", "alias-run").status, "paused");
    assert.equal(canvas.resumeBatch("canvas", "alias-run").status, "pending");
    const executing = canvas.batchForRun("canvas", "alias-run")!;
    assert.equal(executing.episodeId, "canvas", "runner retains the caller alias while its service delegates persistence");
    canvas.updateBatch({ ...executing, status: "succeeded" });
    assert.equal(service.getBatch("ep", "alias-run")?.status, "succeeded");
    assert.deepEqual(canvas.pendingBatches(), []);
});

test("director source, complete prompt, partial cursor and stable IDs round-trip without implicit Clips", async t => {
    const { db, stores, service } = fixture(t); const d = doc();
    const published = await publish(service, d);
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

test("early Acheng planning drafts save without node bindings and readiness scopes missing compile work", async t => {
    const { service } = fixture(t);
    const d = doc(0);
    d.source = { version: 2, prompt_assembly: { version: 2 }, brief: "写一个独立资产计划", fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [], scene_registry: [], script_scenes: [{ id: "scene1", scene_id: "scene1", scene_name: "雨夜站台", text: "保留的逐字对白。", extension: { owner: "acheng" } }], shots: [], asset_plan: [{ id: "STYLE_MOTHER", kind: "style", description: "冷雨与暖灯形成对照。", depends_on: [] }], segments: [], utterances: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] }, extension: { authored: true } };
    d.sourceHash = directorHash(d.source);
    d.assets = { STYLE_MOTHER: { version: "v1", status: "planned" } };
    d.artifacts = [];
    d.modules = { story: { status: "partial", cursor: { scene: "scene1" }, evidence: [], unresolved: ["下一段待写"] }, assets: { status: "planned", evidence: [], unresolved: [] } };
    const current = service.get("ep");
    const edited = await service.edit("ep", { operationId: "early-plan", expectedRevision: current.revision, ops: [{ type: "set_director_production", director: d }] });
    assert.equal(edited.draft.director?.assets.STYLE_MOTHER.nodeId, undefined);
    assert.match(service.workflowReadiness("ep").targets.find(item => item.id === "asset:STYLE_MOTHER")?.blockers.join(" ") || "", /未绑定画布/);
    const patched = await service.edit("ep", { operationId: "patch-scene", expectedRevision: edited.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "scene1", patch: { text: "修订后的逐字对白。" } }] });
    assert.notEqual(patched.draft.director!.sourceHash, edited.draft.director!.sourceHash);
    assert.equal(patched.draft.director!.sourceHash, directorHash(patched.draft.director!.source), "局部编辑由 Backend 重算完整源哈希，不需要 Agent 回读整稿再算哈希");
    assert.equal((patched.draft.director!.source.extension as any).authored, true);
    assert.equal((patched.draft.director!.source.script_scenes as any[])[0].text, "修订后的逐字对白。");
    assert.equal((patched.draft.director!.modules.story!.cursor as any).scene, "scene1");
    const published = await service.publish("ep", { operationId: "publish-early", expectedRevision: patched.revision, stage: "director" });
    assert.equal(published.publishedVersion, 1);
    assert.equal(service.run("ep", 1), null);
    const readiness = service.workflowReadiness("ep");
    assert.equal(readiness.targets.find(item => item.id === "asset:STYLE_MOTHER")?.status, "blocked");
    assert.match(readiness.targets.find(item => item.id === "asset:STYLE_MOTHER")?.blockers.join(" ") || "", /未绑定画布/);
});

test("changing a script scene environment updates its shots atomically and rejects clips crossing environments", async t => {
    const { service } = fixture(t);
    const director = doc(2) as any;
    director.source.scene_registry = [{ id: "scene", name: "草地" }, { id: "room", name: "车厢" }];
    director.sourceHash = directorHash(director.source);
    const seeded = await service.edit("ep", { operationId: "seed-scene-environment", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const changed = await service.edit("ep", { operationId: "change-scene-environment", expectedRevision: seeded.revision, ops: [{ type: "set_director_scene_environment", sceneId: "scene-block", environmentId: "room" }] });
    assert.equal((changed.draft.director!.source.script_scenes as any[])[0].scene_id, "room");
    assert.deepEqual((changed.draft.director!.source.shots as any[]).map(shot => shot.scene_id), ["room", "room"]);
    assert.equal(changed.draft.director!.sourceHash, directorHash(changed.draft.director!.source));

    const crossScene = structuredClone(changed.draft.director!) as any;
    crossScene.source.scene_registry.push({ id: "other-room", name: "另一处空间" });
    crossScene.source.script_scenes.push({ id: "other-occurrence", scene_id: "other-room", text: "Second scene" });
    crossScene.source.shots[1].scene_id = "other-room";
    crossScene.source.shots[1].source_scene_id = "other-occurrence";
    crossScene.source.segments[0].shot_ids.push("s1");
    crossScene.source.segments.splice(1, 1);
    crossScene.sourceHash = directorHash(crossScene.source);
    const withCrossScene = await service.edit("ep", { operationId: "seed-cross-scene-clip", expectedRevision: changed.revision, ops: [{ type: "set_director_production", director: crossScene }] });
    await assert.rejects(async () => await service.edit("ep", { operationId: "reject-cross-scene-move", expectedRevision: withCrossScene.revision, ops: [{ type: "set_director_scene_environment", sceneId: "scene-block", environmentId: "scene" }] }), /会让 Clip .*跨场景/);
});

test("environment source patches persist an existing scene-registry row in a v2 production", async t => {
    const { service } = fixture(t);
    const director = doc(2) as any;
    director.source.scene_registry = [];
    director.sourceHash = directorHash(director.source);
    const seeded = await service.edit("ep", { operationId: "seed-environment-source", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });

    const updated = await service.edit("ep", { operationId: "patch-existing-environment", expectedRevision: seeded.revision, ops: [{
        type: "patch_director_source", entity: "environment", id: "SCENE_HUT",
        patch: { description: "室内空间图和方位关系。", prompt_description: "南侧柴门，西侧药桌，中央承重柱，东侧草席和药架。" },
    }] });

    assert.deepEqual((updated.draft.director!.source.scene_registry as any[])[0], {
        id: "SCENE_HUT", description: "室内空间图和方位关系。",
        prompt_description: "南侧柴门，西侧药桌，中央承重柱，东侧草席和药架。",
    });
    assert.equal(updated.draft.director!.sourceHash, directorHash(updated.draft.director!.source));
});

test("projectDirector rebuilds v2 Clips when the stored projection is absent", t => {
    const data = emptyEpisodeProduction() as any;
    data.director = doc(2);
    delete data.clipGroups;

    projectDirector(data, false);

    assert.deepEqual(data.clipGroups.map((group: any) => group.id), ["seg0", "seg1"]);
    assert.deepEqual(data.clipGroups.map((group: any) => group.nodeId), [null, null]);
});

test("scene script-block patches replace the structured blocks with full-array semantics", async t => {
    const { service } = fixture(t);
    const d = doc(0);
    d.source = { version: 2, prompt_assembly: { version: 2 }, brief: "测试剧本段落结构编辑", fps_num: 24, fps_den: 1, subject_registry: [], character_registry: [{ id: "C1", name: "栓子" }], scene_registry: [{ id: "LOC3", name: "栓子家院落" }],
        script_scenes: [{ id: "SC03", scene_id: "LOC3", scene_name: "第三场：无人相信", text: "第一段。",
            blocks: [
                { id: "SC03-N01", kind: "action", text: "第一段。", beat_ids: ["B3"] },
                { id: "SC03-N02", kind: "dialogue", speaker: "旁白", text: "邻居不信栓子。" },
                { id: "SC03-N03", kind: "action", text: "硬切至傍晚。" }],
            beat_ids: ["B3"] }] as any, shots: [], asset_plan: [], segments: [], utterances: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
    d.sourceHash = directorHash(d.source);
    const current = service.get("ep");
    const base = await service.edit("ep", { operationId: "seed-scene-blocks", expectedRevision: current.revision, ops: [{ type: "set_director_production", director: d }] });
    // 整段数组替换：删一段、换说话人、重排、补新段——一次提交全部生效，扩展字段不被吞掉。
    const nextBlocks = [
        { id: "SC03-N02", kind: "dialogue", speaker: "栓子", text: "不是我偷的。" },
        { id: "SC03-N01", kind: "action", text: "第一段改写了。", beat_ids: ["B3"] },
        { id: "SC03-N04", kind: "action", text: "新补的一段动作。" }];
    const patched = await service.edit("ep", { operationId: "patch-scene-blocks", expectedRevision: base.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "SC03", patch: { blocks: nextBlocks } }] });
    const scene = (patched.draft.director!.source.script_scenes as any[])[0];
    assert.equal(scene.blocks.length, 3, "整段数组直接替换，旧 N03 消失且顺序按提交为准");
    assert.deepEqual(scene.blocks.map((block: any) => block.id), ["SC03-N02", "SC03-N01", "SC03-N04"]);
    assert.equal(scene.blocks[0].speaker, "栓子", "对白块的说话人随段落一起修改");
    assert.deepEqual(scene.blocks[1].beat_ids, ["B3"], "passthrough 保留段落的编译扩展字段");
    assert.notEqual(patched.draft.director!.sourceHash, base.draft.director!.sourceHash);
    // 空数组合法（清空全部段落），但形状不合格的条目必须拒绝且不改动源稿。
    await assert.rejects(async () => await service.edit("ep", { operationId: "bad-blocks", expectedRevision: patched.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "SC03", patch: { blocks: [{ id: "X", kind: "narration", text: "" }] } }] }), /剧本段落/);
    const empty = await service.edit("ep", { operationId: "clear-blocks", expectedRevision: patched.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "SC03", patch: { blocks: [] } }] });
    assert.equal((empty.draft.director!.source.script_scenes as any[])[0].blocks.length, 0);
});

test("source revisions retire stale receipts, preserve drafts and enforce Clip integrity", async t => {
    const { service } = fixture(t); const d = doc(); await publish(service, d);
    const rev = service.get("ep").revision;
    const publishedSourceHash = service.get("ep").published!.director!.sourceHash;
    const acceptedStale = await service.edit("ep", { operationId: "bad", expectedRevision: rev - 1, ops: [{ type: "set_director_production", director: d }] }); // 乐观锁放行：过期 revision 不再拦截，写入落地并推进版本
    assert.equal(acceptedStale.revision, rev + 1);
    const changed = structuredClone(d); changed.source.newFact = "changed"; changed.sourceHash = directorHash(changed.source);
    const saved = await service.edit("ep", { operationId: "stale", expectedRevision: rev, ops: [{ type: "set_director_production", director: changed }] });
    assert.equal(saved.draft.director!.source.newFact, "changed");
    assert.ok(saved.draft.director!.artifacts.every(artifact => artifact.status === "stale"));
    assert.deepEqual(saved.draft.director!.artifacts.map(artifact => artifact.receipt), d.artifacts.map(artifact => artifact.receipt), "old receipts remain historical evidence, never rewritten to approve new input");
    assert.ok(saved.draft.director!.artifacts.every(artifact => !currentCompilationArtifact(saved.draft.director!, artifact)));
    assert.equal(saved.published!.director!.sourceHash, publishedSourceHash, "saving a new source never rewrites the published version");
    changed.artifacts.forEach(a => a.status = "stale"); changed.modules.story = { status: "partial", cursor: "paragraph-2", evidence: [], unresolved: ["continue"] };
    const input = { operationId: "partial", expectedRevision: saved.revision, ops: [{ type: "set_director_production", director: changed }] };
    await service.edit("ep", input); assert.equal((await service.edit("ep", input)).replayed, true);
    assert.notEqual(service.get("ep").draft.director!.modules.story?.cursor, "paragraph-2", "a source replacement must not import caller-owned runtime module state");
    await assert.rejects(async () => await service.edit("ep", { operationId: "projection", expectedRevision: service.get("ep").revision, ops: [{ type: "delete_shot", id: "s0" }] }), /SHOT_LAST_IN_CLIP/);
});

test("production operation identity survives pruning its heavyweight replay receipt", async t => {
    const { service, db } = fixture(t);
    const initial = await publish(service, doc());
    const request = { operationId: "durable-operation-key", expectedRevision: initial.revision,
        ops: [{ type: "set_director_brief" as const, brief: "Durable edit" }] };
    const committed = await service.edit("ep", request);
    const key = db.db.prepare("SELECT request_hash, committed_revision FROM production_operation_keys WHERE owner_kind='episode' AND owner_id='ep' AND operation_id=?")
        .get(request.operationId) as { request_hash: string; committed_revision: number } | undefined;
    assert.equal(key?.committed_revision, committed.revision);
    db.db.prepare("DELETE FROM episode_production_operations WHERE operation_id=?").run(request.operationId);
    await assert.rejects(async () => await service.edit("ep", request), { code: "OPERATION_RECEIPT_UNAVAILABLE" });
    assert.equal(service.get("ep").revision, committed.revision, "a pruned receipt must not allow the source mutation to run twice");
});

test("production source tombstones restore stale edits and protect a revived generation from an old delete", async t => {
    const { service, db } = fixture(t);
    const source = doc();
    source.source.asset_plan = [{ id: "PROP_LIFE", asset_id: "PROP_LIFE", asset_name: "遗物", name: "遗物", kind: "prop", description: "original", depends_on: [] }];
    source.sourceHash = directorHash(source.source);
    await publish(service, source);
    const baseRevision = service.get("ep").revision;
    await service.edit("ep", { operationId: "delete-lifecycle-asset", expectedRevision: baseRevision,
        ops: [{ type: "delete_director_asset", id: "PROP_LIFE", confirmed: true }] });
    await service.edit("ep", { operationId: "revive-lifecycle-asset", expectedRevision: baseRevision,
        ops: [{ type: "patch_director_source", entity: "asset", id: "PROP_LIFE", patch: { description: "edited after delete" } }] });
    const current = service.get("ep");
    let plan = (current.draft.director!.source.asset_plan as Array<Record<string, unknown>>).find(item => item.id === "PROP_LIFE");
    assert.equal(plan?.description, "edited after delete");
    assert.equal(plan?.asset_name, "遗物", "resurrection preserves the deletion snapshot before applying the late patch");
    await service.edit("ep", { operationId: "old-generation-delete", expectedRevision: baseRevision,
        ops: [{ type: "delete_director_asset", id: "PROP_LIFE", confirmed: true }] });
    plan = (service.get("ep").draft.director!.source.asset_plan as Array<Record<string, unknown>>).find(item => item.id === "PROP_LIFE");
    assert.equal(plan?.description, "edited after delete", "the old delete cannot remove the revived generation");
    const pruneBase = service.get("ep").revision;
    await service.edit("ep", { operationId: "delete-before-prune", expectedRevision: pruneBase,
        ops: [{ type: "delete_director_asset", id: "PROP_LIFE", confirmed: true }] });
    db.db.prepare("DELETE FROM production_source_lifecycle_events WHERE owner_kind='episode' AND owner_id='ep' AND revision<=?").run(pruneBase);
    await assert.rejects(async () => await service.edit("ep", { operationId: "edit-after-prune", expectedRevision: pruneBase,
        ops: [{ type: "patch_director_source", entity: "asset", id: "PROP_LIFE", patch: { description: "must stay local" } }] }),
        { code: "BASE_HISTORY_UNAVAILABLE" });
    assert.equal((service.get("ep").draft.director!.source.asset_plan as Array<Record<string, unknown>>).some(item => item.id === "PROP_LIFE"), false);
});

test("multi-shot Segment is preserved, invalid windows remain saved but blocked, and legacy fixtures are rejected", async t => {
    const { service } = fixture(t); const d = doc(4);
    const segments = d.source.segments as any[];
    segments[0].shot_ids = ["s0", "s1"]; segments[0].start_frame = 0; segments[0].end_frame = 240;
    segments[1].shot_ids = ["s2", "s3"]; segments[1].start_frame = 240; segments[1].end_frame = 480; segments.splice(2);
    d.boundaries = [{ from: "seg0", to: "seg1", tailFrame: false, motionContext: false, reason: "authored cut" }];
    d.artifacts = []; d.sourceHash = directorHash(d.source);
    assert.deepEqual((await publish(service, d)).published!.clipGroups.map(group => group.shotIds), [["s0", "s1"], ["s2", "s3"]]);
    const invalid = structuredClone(d); (invalid.source.segments as any[])[0].end_frame = 384; invalid.sourceHash = directorHash(invalid.source);
    const invalidSaved = await publish(service, invalid);
    assert.equal(invalidSaved.publishedVersion, 2);
    assert.ok(service.workflowReadiness("ep", "published").targets.find(item => item.id === "segment:seg0")?.blockers.includes("Segment 帧窗必须与 Shots 的派生帧窗一致"));
    invalid.source = { ...d.source, prompt_detail_policy: { profile: "legacy_fixture" } }; invalid.sourceHash = directorHash(invalid.source);
    await assert.rejects(async () => await publish(service, invalid), /legacy_fixture/);
});

test("v2 Clip readiness derives timing from Shot durations instead of requiring stored seconds", async t => {
    const { service } = fixture(t), director = doc(1);
    director.artifacts = [];
    await service.edit("ep", { operationId: "derived-clip-window", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const target = service.workflowReadiness("ep").targets.find(item => item.id === "segment:seg0");
    assert.ok(target);
    assert.equal(target.blockers.some(blocker => blocker.includes("帧窗与秒数须一致")), false);
});

test("readiness blocks explicit environment usage when its H3 artifact lacks a scene reference", async t => {
    const { service } = fixture(t), d = doc(2);
    d.modules.continuity = { status: "planned", evidence: [], unresolved: [] };
    d.source.script_scenes = [];
    d.source.scene_registry = [{ id: "scene", name: "Room" }];
    const sceneSubject = { id: "SUB_SCENE", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "scene", id: "scene" }, pictureBindings: [
        { id: "SCENE_ENV", assetId: "SCENE_IMAGE", sourceNode: { projectId: "canvas", nodeId: "scene-image" }, selection: { mode: "node_selection" }, provides: ["environment"], retain: ["layout"], exclude: ["people"], applicableState: {}, defaultFor: ["environment"] },
    ] };
    d.source.subject_registry = [sceneSubject];
    (d.source.shots as any[])[0].subject_usages = [{ subjectId: "SUB_SCENE", presentation: "state_context", referencePurpose: ["environment"], pictureBindingIds: ["SCENE_ENV"], continuityFactIds: [], stateRequirements: [] }];
    (d.source.shots as any[])[1].subject_usages = [{ subjectId: "SUB_SCENE", presentation: "state_context", referencePurpose: ["environment"], pictureBindingIds: [], continuityFactIds: [], stateRequirements: [] }];
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    d.artifacts[0].references = [{ label: "<Picture 1>", nodeId: "scene-image", storageKey: "image:scene", sha256: "b".repeat(64), role: "scene" }];
    const current = service.get("ep");
    await service.edit("ep", { operationId: "set-model", expectedRevision: current.revision, ops: [{ type: "set_settings", patch: { h3Model: "test-model" } }] });
    await publish(service, d);
    const readiness = service.workflowReadiness("ep", "published");
    assert.equal((readiness.modules.continuity as Record<string, unknown>).verifiedStatus, "unchecked", "compiled artifacts do not imply continuity verification");
    const targets = readiness.targets.filter(item => item.kind === "segment");
    const first = targets.find(item => item.targetId === "seg0")!;
    const second = targets.find(item => item.targetId === "seg1")!;
    assert.ok(!first.warnings?.some(item => item.includes("此段没有场景参考图")), "a scene reference anchors the first Clip");
    assert.ok(second.blockers.some(item => item.includes("当前 H3 产物未绑定场景图")), "an explicit environment usage requires a matching H3 scene reference");

    const noSceneUsage = structuredClone(d);
    (noSceneUsage.source.shots as any[])[1].subject_usages = [];
    noSceneUsage.sourceHash = directorHash(noSceneUsage.source);
    noSceneUsage.artifacts.forEach(artifact => { artifact.sourceHash = noSceneUsage.sourceHash; artifact.receipt.sourceHash = noSceneUsage.sourceHash; });
    const latest = service.get("ep");
    await publish(service, noSceneUsage, "ep");
    const withoutDeclaration = service.workflowReadiness("ep", "published").targets.find(item => item.id === "segment:seg1")!;
    assert.ok(!withoutDeclaration.warnings?.some(item => item.includes("此段没有场景参考图")), "a same-scene ID alone does not infer an environment-image requirement");
    assert.ok(latest.revision < service.get("ep").revision);
});

test("structured Segment regrouping preserves Shot content and invalidates only its compile receipt", async t => {
    const { service } = fixture(t); const d = doc(3);
    const source = d.source as Record<string, any>;
    source.utterances = [{ id: "UTT_S1", speakerName: "信使", text: "这句对白必须保留。", start: { shotId: "s1", localFrame: 0 }, end: { shotId: "s1", localFrame: 30 } }];
    source.shots[1].utterance_refs = [{ utteranceId: "UTT_S1", role: "speaker", localStartFrame: 0, localEndFrame: 30, textStart: 0, textEnd: "这句对白必须保留。".length }];
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    await publish(service, d);
    const current = service.get("ep");
    const regrouped = await service.edit("ep", { operationId: "regroup", expectedRevision: current.revision, ops: [{ type: "set_director_segment_group", segmentId: "seg0", shotIds: ["s0", "s1"], removeSegmentIds: ["seg1"] }] });
    const director = regrouped.draft.director!;
    assert.equal((director.source.segments as any[]).length, 2);
    assert.deepEqual((director.source.segments as any[])[0].shot_ids, ["s0", "s1"]);
    assert.equal(Object.hasOwn((director.source.segments as any[])[0], "generation_clip_duration"), false);
    const windows = subjectShotWindows(director.source);
    assert.deepEqual([windows.get("s0")?.startFrame, windows.get("s1")?.endFrame], [0, 240]);
    assert.equal((director.source.utterances as any[])[0].text, "这句对白必须保留。");
    assert.ok(director.artifacts.every(item => item.status === "stale"));
    assert.deepEqual(regrouped.draft.clipGroups.map(group => group.shotIds), [["s0", "s1"], ["s2"]]);

    const latest = service.get("ep");
    await assert.rejects(async () => await service.edit("ep", { operationId: "non-adjacent", expectedRevision: latest.revision, ops: [{ type: "set_director_segment_group", segmentId: "seg0", shotIds: ["s0", "s2"], removeSegmentIds: [] }] }), /相邻 Shot/);
});

test("project scope supports independent assets and linked views share the same source", async t => {
    const { db, service } = fixture(t); const canvas = new EpisodeProductionService(db, undefined, undefined, true, () => {});
    await publish(service, doc()); assert.deepEqual(canvas.get("canvas").draft, service.get("ep").draft);
    db.createCanvasProject({ id: "independent", title: "Assets", nodes: [], connections: [] });
    const d = doc(0); d.source.asset_cards = []; d.sourceHash = directorHash(d.source);
    const result = await publish(canvas, d, "independent");
    assert.equal(result.published!.director!.sourceHash, d.sourceHash);
    assert.equal(canvas.get("independent").publishedVersion, 1);
    assert.equal(db.getDramaEpisode("independent"), null);
});

for (const previousVersion of [16, 21] as const) test(`version ${previousVersion} upgrades with a verified backup and preserves production history`, t => {
    const dir = mkdtempSync(join(tmpdir(), "director-migration-")), file = join(dir, "db.sqlite");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const seed = historicalDatabase(t, file, previousVersion);
    seed.prepare("INSERT INTO canvas_folders (id,name,created_at) VALUES ('d','Drama','2026-01-01')").run();
    seed.prepare("INSERT INTO drama_projects (folder_id,outline,updated_at) VALUES ('d','Original outline','2026-01-01')").run();
    seed.prepare("INSERT INTO drama_episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES ('ep','d',1,'Episode','2026-01-01','2026-01-01')").run();
    const snapshot = JSON.stringify({ ...emptyEpisodeProduction(), scenes: [{ id: "original-scene", heading: "Original scene", location: "Room", timeOfDay: "Night", blocks: [{ id: "original-text", kind: "action", text: "Keep this complete published production" }] }] });
    seed.prepare("INSERT INTO episode_productions (episode_id,revision,draft_json,published_json,published_version,updated_at) VALUES ('ep',7,?,?,2,'2026-01-01')").run(snapshot, snapshot);
    seed.prepare("INSERT INTO episode_production_versions (episode_id,version,stage,snapshot_json,impact_json,created_at) VALUES ('ep',2,'director',?,'{}','2026-01-01')").run(snapshot);
    seed.close();
    const upgraded = new BackendDatabase(file);
    try {
        assert.equal(upgraded.getDramaEpisode("ep")?.title, "Episode");
        assert.equal(upgraded.db.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
        for (const table of ["canvas_productions", "canvas_production_runs", "canvas_production_batches", "episode_production_batches"]) {
            assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
        }
        assert.deepEqual({ ...upgraded.db.prepare("SELECT revision,draft_json,published_json,published_version FROM episode_productions WHERE episode_id='ep'").get() },
            { revision: 7, draft_json: snapshot, published_json: snapshot, published_version: 2 });
        assert.equal(upgraded.db.prepare("SELECT snapshot_json FROM episode_production_versions WHERE episode_id='ep' AND version=2").get()?.snapshot_json, snapshot);
        const backups = readdirSync(dir).filter(name => name.includes(`pre-schema-v${previousVersion}-to-v${DATABASE_SCHEMA_VERSION}-`));
        assert.equal(backups.length, 1);
        const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
        try {
            assert.equal(backup.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
            assert.equal(backup.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version, previousVersion);
            assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='episode_production_batches'").get(), undefined);
            assert.equal(backup.prepare("SELECT published_json FROM episode_productions WHERE episode_id='ep'").get()?.published_json, snapshot);
        } finally { backup.close(); }
    } finally { upgraded.close(); }
});

test("Motion Context group submits one bounded task and standalone next Clip remains separate", async t => {
    const { db, service, stores, dir } = fixture(t); const d = doc(3); d.executionAuthorized = true;
    d.boundaries[0].motionContext = true; d.boundaries[1].tailFrame = true;
    await publish(service, d);
    const commands: CanvasGenerationCommand[] = [];
    const fake = { start: async (command: CanvasGenerationCommand) => {
        commands.push(command); const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {});
        const project = db.getCanvasProject("canvas")!; const node = (project.nodes as any[]).find(n => n.id === command.nodeId);
        const start = node.metadata.segments.findIndex((s: any) => s.id === command.segmentId);
        const end = command.runFromCurrent ? node.metadata.segments.findIndex((s: any) => s.id === command.endSegmentId) : start;
        const media = { storageKey: `video:${task.id}`, filePath: join(dir, `${task.id}.mp4`), mimeType: "video/mp4", bytes: 10, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() };
        writeFileSync(media.filePath, "test video"); db.upsertMediaFile(media);
        db.applyCanvasProjectOperations("canvas", undefined, node.metadata.segments.slice(start, end + 1).map((s: any) => ({ type: "update_h3_segment", nodeId: node.id, segmentId: s.id, patch: { resultStorageKey: media.storageKey } })), { runtimeWrite: true });
        stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey: media.storageKey }] } }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const first = await service.startBatch("ep", { inputBasis: "published", runId: "motion-chain", idempotencyKey: "motion-chain", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg0"] });
    const duplicateIntent = { inputBasis: "published" as const, runId: "other-motion-chain", idempotencyKey: "other-motion-chain", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg1"] };
    await assert.rejects(async () => await service.startBatch("ep", duplicateIntent), /已由运行 motion-chain 占用/);
    assert.equal((await service.startBatch("ep", { ...duplicateIntent, runId: "motion-chain", idempotencyKey: "motion-chain", targets: ["segment:seg0"] })).runId, "motion-chain", "an idempotent replay returns the existing run before overlap checks");
    await runner.runBatch("ep", first.runId); assert.equal(service.getBatch("ep", first.runId)?.status, "succeeded", service.getBatch("ep", first.runId)?.error || "");
    assert.equal(commands.length, 1); assert.equal(commands[0].runFromCurrent, true); assert.equal(commands[0].skipCompleted, false);
    assert.notEqual(commands[0].segmentId, commands[0].endSegmentId);
    assert.equal(JSON.stringify(commands).includes('"previousVideoAsReference":true'), false);
    const second = await service.startBatch("ep", { inputBasis: "published", runId: "tail-frame-next", idempotencyKey: "tail-frame-next", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg2"] });
    await runner.runBatch("ep", second.runId);
    assert.equal(commands.length, 2); assert.equal(commands[1].runFromCurrent ?? false, false);
    assert.equal(commands[1].endSegmentId, undefined, "the standalone Clip must not include a following range");
    await runner.runBatch("ep", first.runId); assert.equal(commands.length, 2);
});

test("failed generation pauses without resubmission or deleting earlier results", async t => {
    const { stores, service } = fixture(t); const d = doc(1); d.executionAuthorized = true; await publish(service, d);
    let count = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => { count++; const task = stores.tasks.create(command.idempotencyKey!, "canvas-h3-run", command, {}); stores.tasks.update(task.id, { status: "failed", error: "simulated provider failure" }); return { taskId: task.id }; } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const batch = await service.startBatch("ep", { inputBasis: "published", runId: "failed-run", idempotencyKey: "failed-run", expectedRevision: service.get("ep").revision, version: 1, targets: ["segment:seg0"] });
    await runner.runBatch("ep", batch.runId); await runner.runBatch("ep", batch.runId);
    assert.equal(count, 1); assert.equal(service.getBatch("ep", batch.runId)?.status, "failed"); assert.match(service.getBatch("ep", batch.runId)?.error || "", /simulated/);
});

test("asset dependencies and style approval block premature execution while drafts remain recoverable", async t => {
    const { service, db } = fixture(t); const d = doc(0);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "character", nodeType: "config", metadata: { smart: true, generationMode: "image" } }]);
    d.assets = { STYLE_MOTHER: { nodeId: "style", version: "v1", status: "planned" }, CHAR: { nodeId: "character", version: "v1", status: "planned" } };
    d.source.asset_plan = [{ id: "STYLE_MOTHER", version: "v1", depends_on: [] }, { id: "CHAR", version: "v1", depends_on: ["STYLE_MOTHER"] }];
    d.source.style_policy = "required"; d.source.style_lock = { anchor_asset_id: "STYLE_MOTHER" };
    d.sourceHash = directorHash(d.source);
    const prompt = "Complete character asset prompt", digest = promptHash(prompt);
    d.artifacts = [{ id: "character-image", kind: "image", targetId: "CHAR", prompt, sha256: digest, sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, promptHash: digest, engineRuntimeId: d.engine.runtimeId, validator: "test" } }];
    const saved = await publish(service, d);
    assert.equal(saved.publishedVersion, 1);
    const readiness = service.workflowReadiness("ep", "published");
    assert.equal(readiness.targets.find(item => item.id === "asset:CHAR")?.status, "blocked");
    assert.match(readiness.targets.find(item => item.id === "asset:CHAR")?.blockers.join(" ") || "", /STYLE_MOTHER/);
    assert.equal(service.get("ep").draft.director?.sourceHash, d.sourceHash);
});

for (const reviewMode of ["manual", "none"] as const) test(`automatic dependency runs preserve review policy and original task IDs: ${reviewMode}`, async t => {
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
    await service.edit("ep", { operationId: "review-policy", expectedRevision: service.get("ep").revision, ops: [{ type: "set_settings", patch: { reviewPolicy: { mode: reviewMode, shared: reviewMode, scene: reviewMode } } }] });
    await publish(service, d); let submitted = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        submitted++;
        const assetId = command.nodeId === "style" ? "STYLE_MOTHER" : "CHAR";
        assert.equal(command.prompt, assetId === "STYLE_MOTHER" ? stylePrompt : characterPrompt);
        const task = stores.tasks.create(command.idempotencyKey!, "image", command, {});
        const storageKey = `image:${assetId.toLowerCase()}`, bytes = `test-${assetId}`, filePath = join(dir, `${assetId}.png`); writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: command.nodeId, metadata: { storageKey } }]);
        stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey }] } }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    const batch = await service.startBatch("ep", { inputBasis: "published", runId: "style-run", idempotencyKey: "style-run", expectedRevision: service.get("ep").revision, version: 1, targets: ["asset:STYLE_MOTHER"], scope: "all_ready" });
    db.db.prepare("UPDATE episode_production_batches SET execution_snapshot_json=NULL WHERE run_id=?").run(batch.runId); // Legacy runs retain their original review/expansion semantics.
    await runner.runBatch("ep", batch.runId); await runner.runBatch("ep", batch.runId);
    assert.equal(submitted, 1);
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.status, "generated");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.storageKey, "image:style_mother");
    if (reviewMode === "none" || reviewMode === "manual") {
        assert.equal(service.getBatch("ep", batch.runId)?.status, "succeeded");
        assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.evidence, undefined, "generated media remains unapproved without an explicit review");
        return;
    }
    assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
    const originalTaskId = service.getBatch("ep", batch.runId)!.submitted[0].taskId;
    service.resumeBatch("ep", batch.runId);
    await runner.runBatch("ep", batch.runId);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review", service.getBatch("ep", batch.runId)?.error || "");
    assert.equal(submitted, 1, "resume before approval cannot release a newly ready dependent asset");
    assert.equal(service.getBatch("ep", batch.runId)!.submitted[0].taskId, originalTaskId);
    const duplicateReviewTarget = async () => await service.startBatch("ep", { inputBasis: "published", runId: "style-rerun", idempotencyKey: "style-rerun", expectedRevision: service.get("ep").revision, version: 1, targets: ["asset:STYLE_MOTHER"], scope: "selected" });
    await assert.rejects(duplicateReviewTarget, /暂停不会释放目标.*退回旧结果/);
    const pausedReview = service.pauseBatch("ep", batch.runId);
    assert.equal(pausedReview.status, "awaiting_review");
    assert.equal(pausedReview.pauseRequested, true);
    await assert.rejects(duplicateReviewTarget, /暂停不会释放目标.*退回旧结果/);
    assert.equal(service.getBatch("ep", "style-rerun"), null);
    assert.equal(submitted, 1, "a paused review must not resubmit the same generated target");
    await service.edit("ep", { operationId: "prompt-only-preflight", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_workflow", patch: { mediaProductionMode: "prompt_only" } }] });
    const beforePreflight = JSON.stringify({ production: service.get("ep"), batch: service.getBatch("ep", batch.runId) });
    const blocked = await service.preflight("ep", { action: "generate", request: { inputBasis: "published", runId: "another-run", idempotencyKey: "another-key", expectedRevision: service.get("ep").revision, version: 1, targets: ["asset:STYLE_MOTHER"] } });
    assert.equal(blocked.valid, false);
    assert.ok(blocked.diagnostics.some(item => item.code === "MEDIA_MODE_PROMPT_ONLY"));
    const occupied = blocked.diagnostics.find(item => item.code === "TARGET_AWAITING_REVIEW");
    assert.equal(occupied?.blockingRun?.runId, batch.runId);
    assert.equal(occupied?.blockingRun?.taskIds.length, 1);
    assert.deepEqual(occupied?.nextAction?.input, { kind: "episode", id: "ep", runId: batch.runId });
    assert.equal(JSON.stringify({ production: service.get("ep"), batch: service.getBatch("ep", batch.runId) }), beforePreflight);
    const replayInput = { inputBasis: "published" as const, runId: batch.runId, idempotencyKey: batch.idempotencyKey, expectedRevision: batch.sourceRevision, version: 1, targets: ["asset:STYLE_MOTHER"], scope: "all_ready" };
    assert.equal((await service.preflight("ep", { action: "generate", request: replayInput })).valid, true, "a stale-revision replay must still recover the original receipt");
    assert.equal((await service.startBatch("ep", replayInput)).runId, batch.runId);
    const collision = await service.preflight("ep", { action: "generate", request: { ...replayInput, runId: "wrong-run", targets: ["asset:CHAR"] } });
    assert.equal(collision.diagnostics[0].code, "IDEMPOTENCY_CONFLICT");
    assert.equal(collision.nextActions?.[0].input?.runId, batch.runId);
    await service.edit("ep", { operationId: "restore-automatic-preflight", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_workflow", patch: { mediaProductionMode: "automatic" } }] });
    const sha256 = styleMediaHash;
    const current = service.get("ep");
    await assert.rejects(async () => await service.edit("ep", { operationId: "bad-review", expectedRevision: current.revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 2, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256, verdict: "approved", evidence: "checked" }] }), /审核目标不属于/);
    await assert.rejects(async () => await service.edit("ep", { operationId: "bad-hash", expectedRevision: current.revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 1, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256: "0".repeat(64), verdict: "approved", evidence: "checked" }] }), /摘要/);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
    assert.equal(service.get("ep").published!.director!.assets.STYLE_MOTHER.status, "generated");
    const reviewed = await service.edit("ep", { operationId: "asset-review", expectedRevision: service.get("ep").revision, ops: [{ type: "review_director_asset", assetId: "STYLE_MOTHER", version: 1, sourceHash: d.sourceHash, nodeId: "style", storageKey: "image:style_mother", sha256, verdict: "approved", evidence: "identity and style checked" }] });
    assert.equal(reviewed.published!.director!.assets.STYLE_MOTHER.status, "approved");
    const readinessAfterStyle = service.workflowReadiness("ep", "published");
    assert.equal(readinessAfterStyle.targets.find(item => item.id === "asset:CHAR")?.status, "ready", JSON.stringify(readinessAfterStyle.targets));
    const historical = service.getBatch("ep", batch.runId)!;
    service.updateBatch({ ...historical, submitted: historical.submitted.map(({ projectId, nodeId, ...item }) => item) });
    assert.equal(service.getBatch("ep", batch.runId)!.submitted[0].nodeId, undefined, "older receipts can lack denormalized node context");
    const originalResult = stores.tasks.get(originalTaskId)!.result;
    const styleFile = db.getMediaFile("image:style_mother")!.filePath;
    for (const invalidate of [
        () => stores.tasks.update(originalTaskId, { result: null }),
        () => writeFileSync(styleFile, "changed-after-review"),
    ]) {
        invalidate();
        service.resumeBatch("ep", batch.runId);
        await runner.runBatch("ep", batch.runId);
        assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
        assert.equal(submitted, 1, "approval cannot release dependencies when original task media or archived bytes no longer match");
        stores.tasks.update(originalTaskId, { result: originalResult });
        writeFileSync(styleFile, "test-STYLE_MOTHER");
    }
    await runner.prepareTargets("ep", service.get("ep").revision, ["asset:CHAR"], "prepare-character-reference");
    const continued = service.resumeBatch("ep", batch.runId);
    assert.ok(continued.targets.includes("asset:CHAR"), "automatic scope should release newly ready dependencies after approval");
    await runner.runBatch("ep", batch.runId);
    assert.equal(submitted, 2, service.getBatch("ep", batch.runId)?.error || "");
    assert.equal(service.getBatch("ep", batch.runId)?.status, "awaiting_review");
    const charMediaHash = crypto.createHash("sha256").update("test-CHAR").digest("hex");
    await service.edit("ep", { operationId: "char-review", expectedRevision: service.get("ep").revision, ops: [{ type: "review_director_asset", assetId: "CHAR", version: 1, sourceHash: d.sourceHash, nodeId: "character", storageKey: "image:char", sha256: charMediaHash, verdict: "approved", evidence: "character follows STYLE_MOTHER" }] });
    service.resumeBatch("ep", batch.runId);
    await runner.runBatch("ep", batch.runId);
    assert.equal(service.getBatch("ep", batch.runId)?.status, "succeeded");
    assert.equal(submitted, 2);
    assert.equal(service.getBatch("ep", batch.runId)!.submitted[0].taskId, originalTaskId);
});

test("legacy version-only runs generate keyframes without misclassifying Shot IDs as assets", async t => {
    const { service, stores, db, dir } = fixture(t), director = doc(1);
    director.source.segments = [{ id: "seg0", shot_ids: ["s0"], mode: "T2VA" }];
    director.source.asset_plan = [{ id: "FRAME", kind: "keyframe", version: "v1", depends_on: [] }];
    director.boundaries = [];
    director.shotInputs.s0 = { keyframePolicy: "new", keyframeAssetId: "FRAME", assetIds: [] };
    director.assets.FRAME = { version: "v1", status: "planned" };
    director.sourceHash = directorHash(director.source);
    director.executionAuthorized = true;
    const prompt = "A complete keyframe prompt", sha256 = promptHash(prompt);
    const h3Artifact = { ...director.artifacts[0], sourceHash: director.sourceHash, receipt: { ...director.artifacts[0].receipt, sourceHash: director.sourceHash } };
    director.artifacts = [h3Artifact, { id: "frame-image", kind: "image", targetId: "FRAME", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, validator: "test-fixture" } }];
    await service.edit("ep", { operationId: "legacy-frame", expectedRevision: 0, ops: [{ type: "set_director_production", director },
        { type: "set_settings", patch: { imageModel: "mock-image", reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } } }] });
    let submitted = 0;
    const fake = { start: async (command: CanvasGenerationCommand) => {
        submitted++;
        const task = stores.tasks.create(command.idempotencyKey!, "image", command, {});
        const storageKey = "image:legacy-frame", filePath = join(dir, "frame.png"), bytes = "legacy-frame";
        writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: command.nodeId, metadata: { storageKey } }]);
        stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey }] } });
        return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, fake);
    await runner.prepareTargets("ep", service.get("ep").revision, ["frame:s0"], "prepare-legacy-frame");
    await service.publish("ep", { operationId: "publish-legacy-frame", expectedRevision: service.get("ep").revision, stage: "director" });
    // Model an already-authorized historical publication: new source writes intentionally clear this legacy execution flag.
    const publishedRow = db.db.prepare("SELECT published_json FROM episode_productions WHERE episode_id='ep'").get() as { published_json: string };
    const legacySnapshot = JSON.parse(publishedRow.published_json);
    legacySnapshot.director.executionAuthorized = true;
    const legacyJson = JSON.stringify(legacySnapshot);
    db.db.prepare("UPDATE episode_productions SET published_json=? WHERE episode_id='ep'").run(legacyJson);
    db.db.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id='ep' AND version=1").run(legacyJson);
    const plan = { changedSceneIds: [], affectedShotIds: ["s0"], imageShotIds: ["s0"], clipGroupIds: [], missingAssetNodeIds: [] };
    db.db.prepare("INSERT INTO episode_production_runs (episode_id,version,status,plan_json,submitted_json,updated_at) VALUES ('ep',1,'pending',?,'[]','2026-01-01')").run(JSON.stringify(plan));
    await runner.run("ep", 1);
    const completed = service.run("ep", 1)!;
    assert.equal(completed.runId, undefined);
    assert.equal(completed.status, "succeeded", completed.error || "");
    assert.equal(completed.submitted[0].id, "s0");
    const frame = service.get("ep").published!.keyframes.s0;
    assert.equal(frame.storageKey, "image:legacy-frame");
    assert.equal(submitted, 1);
    await runner.run("ep", 1);
    assert.equal(service.run("ep", 1)?.status, "succeeded");
    assert.equal(submitted, 1, "replaying a completed legacy version-only run does not resubmit");
    assert.equal(service.run("ep", 1)!.submitted[0].taskId, completed.submitted[0].taskId);
});

test("HTTP hashes the source itself through the shared production contract", async t => {
    const { service } = fixture(t);
    const app = express(); app.use(express.json()); registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/canvas/production/hash`;
    const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const source of [{ brief: "x" }, {}, { title: "角色", nested: { z: [2, 1], a: true } }]) {
        const response = await post({ source }); assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, hash: directorHash(source) });
    }
    for (const body of [{}, { source: null }, { source: [] }, { source: 1 }, { source: {}, unexpected: true }]) {
        assert.equal((await post(body)).status, 400);
    }
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
    const runInput = { inputBasis: "published" as const, runId: "http-run", idempotencyKey: "http-run", expectedRevision: current.production.revision, version: 1, targets: ["segment:seg0"] };
    const started = await post("/drama/episodes/ep/production/runs", runInput);
    assert.equal(started.status, 200);
    const replay = await post("/drama/episodes/ep/production/runs", runInput);
    assert.equal((await replay.json() as any).run.runId, "http-run");
    const paused = await post("/drama/episodes/ep/production/batches/http-run/pause", {});
    assert.equal((await paused.json() as any).run.status, "paused");
    const resumed = await post("/drama/episodes/ep/production/batches/http-run/resume", {});
    assert.equal((await resumed.json() as any).run.status, "pending");
    const stale = await post("/canvas/projects/canvas/production/ops", { operationId: "stale", expectedRevision: 0, ops: [{ type: "set_director_production", director: doc() }] });
    assert.equal(stale.status, 200, "stale expectedRevision writes are accepted (last-write-wins)");
    assert.ok((await stale.json() as any).production.revision > current.production.revision);
});

test("currentWork readiness presentation stays outside the content hash and validates run ownership across aliases", async t => {
    const { service, db } = fixture(t);
    const d = doc(1);
    const initialHash = d.sourceHash;
    const current = service.get("ep");
    const edited = await service.edit("ep", { operationId: "set-current-work", expectedRevision: current.revision, ops: [
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
    await assert.rejects(async () => await service.edit("ep", { operationId: "bad-current-work-run", expectedRevision: beforeRun.revision, ops: [{
        type: "set_director_workflow", patch: { currentWork: { workId: "work-stable", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: beforeRun.revision, sourceHash: initialHash, runId: "wrong-object-run" } },
    }] }), /runId/);
    await assert.rejects(async () => await service.edit("ep", { operationId: "stale-current-work", expectedRevision: beforeRun.revision, ops: [{
        type: "set_director_workflow", patch: { currentWork: { workId: "work-stable", module: "assets", action: "author", inputRevision: beforeRun.revision, sourceHash: "0".repeat(64) } },
    }] }), /源哈希/);

    const route = new EpisodeProductionService(db, undefined, undefined, true, () => {}).workflowReadiness("canvas").presentation;
    assert.equal(route?.owner.kind, "canvas");
    assert.equal(route?.owner.id, "canvas");
    assert.ok(route?.aliases?.includes("ep"));
});

test("legacy readiness infers a stable presentation without persisting a work focus", async t => {
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
    await service.edit("ep", { operationId: "legacy-director", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });
    const inferred = service.workflowReadiness("ep").presentation;
    assert.equal(inferred?.workId, "legacy:ep");
    assert.equal(inferred?.workspace, "assets");
    assert.equal(inferred?.action, "author");
    assert.equal(inferred?.reason, "缺少 STYLE_MOTHER");
    assert.equal(service.get("ep").draft.director?.workflow.currentWork, undefined);
});

test("production batches bind workId and runId atomically and replay without a second revision", async t => {
    const { service } = fixture(t);
    const d = doc(1);
    d.workflow = { ...d.workflow, currentWork: { workId: "bounded-work", module: "model", action: "produce", targetKind: "segment", targetId: "seg0", inputRevision: 0, sourceHash: d.sourceHash } };
    const settingsBase = service.get("ep");
    await service.edit("ep", { operationId: "settings-before-run", expectedRevision: settingsBase.revision, ops: [{ type: "set_settings", patch: { h3Model: "test-h3" } }] });
    await publish(service, d);
    const before = service.get("ep");
    const input = { inputBasis: "published" as const, runId: "bounded-run", idempotencyKey: "bounded-run", workId: "bounded-work", expectedRevision: before.revision, version: before.publishedVersion, targets: ["segment:seg0"], scope: "selected" as const };
    const run = await service.startBatch("ep", input);
    const after = service.get("ep");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.draft.director?.workflow.currentWork?.runId, run.runId);
    assert.equal(after.draft.director?.sourceHash, d.sourceHash);
    assert.equal(service.workflowReadiness("ep", "draft", run.runId).presentation?.runId, run.runId);
    assert.equal((await service.startBatch("ep", input)).runId, run.runId);
    assert.equal(service.get("ep").revision, after.revision);
});

test("asset deletion clears draft dependencies and leaves canvas media untouched", async t => {
    const { service, db } = fixture(t);
    const director = doc(0);
    const before = service.get("ep");
    await service.edit("ep", { operationId: "seed-manual-assets", expectedRevision: before.revision, ops: [{ type: "set_director_production", director }] });
    const assetOp = (id: string, name: string, subjectId?: string) => ({
        type: "create_manual_director_asset" as const,
        assetPlan: { id, kind: "prop" as const, asset_name: name, version: "v1", description: "", purpose: name, depends_on: [], status: "planned" as const },
        assetCard: { id, asset_id: id, asset_kind: "prop" as const, asset_version: "v1", prompt: name, references: [] },
        ...(subjectId ? { subject: { id: subjectId, kind: "prop" as const, entityRef: { ownerKind: "episode" as const, ownerId: "ep", kind: "asset" as const, id }, pictureBindings: [] } } : {}),
    });
    const base = service.get("ep");
    await service.edit("ep", { operationId: "create-manual-assets", expectedRevision: base.revision, ops: [assetOp("PROP_A", "A", "SUB_PROP_A"), assetOp("PROP_B", "B")] });
    const created = service.get("ep");
    await service.edit("ep", { operationId: "link-manual-asset", expectedRevision: created.revision, ops: [{ type: "patch_director_source", entity: "asset", id: "PROP_B", patch: { depends_on: ["PROP_A"] } }] });
    const seeded = service.get("ep");
    const mediaBefore = db.db.prepare("SELECT * FROM media_files ORDER BY storage_key").all();
    await service.edit("ep", { operationId: "delete-linked-manual-asset", expectedRevision: seeded.revision, ops: [{ type: "delete_director_asset", id: "PROP_A", confirmed: true }] });
    const deleted = service.get("ep");
    assert.deepEqual((deleted.draft.director!.source.asset_plan as any[]).map(item => item.id), ["PROP_B"]);
    assert.deepEqual((deleted.draft.director!.source.asset_plan as any[]).find(item => item.id === "PROP_B").depends_on, []);
    assert.deepEqual((deleted.draft.director!.source.asset_cards as any[]).map(item => item.id), ["PROP_B"]);
    assert.deepEqual(deleted.draft.director!.source.subject_registry, []);
    assert.equal(deleted.draft.director!.assets.PROP_A, undefined);
    assert.equal(deleted.draft.director!.sourceHash, directorHash(deleted.draft.director!.source));
    assert.deepEqual(db.db.prepare("SELECT * FROM media_files ORDER BY storage_key").all(), mediaBefore, "deleting a draft asset does not delete or rewrite media");

    const timestamp = new Date().toISOString();
    db.db.prepare("INSERT INTO tasks (id,kind,status,input_json,params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("asset-history-task", "image", "failed", "{}", "{}", timestamp, timestamp);
    db.db.prepare("INSERT INTO production_task_bindings (task_id,owner_kind,owner_id,version,source_hash,target_kind,target_id,project_id,node_id,targets_json) VALUES (?,?,?,?,?,?,?,?,?,?)").run("asset-history-task", "episode", "ep", 1, deleted.draft.director!.sourceHash, "asset", "PROP_B", "canvas", "asset-node", "[]");
    const withHistory = service.get("ep");
    await service.edit("ep", { operationId: "delete-asset-with-task-history", expectedRevision: withHistory.revision, ops: [{ type: "delete_director_asset", id: "PROP_B", confirmed: true }] });
    const removedWithHistory = service.get("ep");
    assert.equal(removedWithHistory.revision, withHistory.revision + 1);
    assert.equal(removedWithHistory.draft.director!.source.asset_plan!.some(item => item.id === "PROP_B"), false);
    assert.equal((db.db.prepare("SELECT task_id FROM production_task_bindings WHERE target_id='PROP_B'").get() as any)?.task_id, "asset-history-task");
});

test("wholesale source replacement strips manual provenance without blocking safe asset deletion", async t => {
    const { service } = fixture(t);
    const director = doc(0);
    director.source.asset_plan = [{ id: "FORGED_MANUAL", kind: "prop", created_by: "manual", asset_name: "Forged", version: "v1", description: "", purpose: "", depends_on: [], status: "planned" }];
    director.source.asset_cards = [{ id: "FORGED_MANUAL", asset_id: "FORGED_MANUAL", asset_kind: "prop", asset_version: "v1", prompt: "", references: [] }];
    director.sourceHash = directorHash(director.source);
    const before = service.get("ep");
    await service.edit("ep", { operationId: "forged-manual-origin", expectedRevision: before.revision, ops: [{ type: "set_director_production", director }] });
    const current = service.get("ep");
    assert.equal((current.draft.director!.source.asset_plan as any[])[0].created_by, undefined);
    await service.edit("ep", { operationId: "delete-unused-director-asset", expectedRevision: current.revision, ops: [{ type: "delete_director_asset", id: "FORGED_MANUAL", confirmed: true }] });
    const deleted = service.get("ep");
    assert.equal(deleted.revision, current.revision + 1);
    assert.equal(deleted.draft.director!.source.asset_plan!.some(item => item.id === "FORGED_MANUAL"), false);
});

test("asset deletion removes only the current draft when the asset is in an immutable published version", async t => {
    const { service } = fixture(t);
    const director = doc(0);
    const initial = service.get("ep");
    await service.edit("ep", { operationId: "seed-published-manual-asset", expectedRevision: initial.revision, ops: [{ type: "set_director_production", director }] });
    const base = service.get("ep");
    const assetPlan = { id: "PROP_PUBLISHED", kind: "prop" as const, asset_name: "Published prop", version: "v1", description: "", purpose: "Published prop", depends_on: [], status: "planned" as const };
    const assetCard = { id: "PROP_PUBLISHED", asset_id: "PROP_PUBLISHED", asset_kind: "prop" as const, asset_version: "v1", prompt: "Published prop", references: [] };
    await service.edit("ep", { operationId: "create-published-manual-asset", expectedRevision: base.revision, ops: [{ type: "create_manual_director_asset", assetPlan, assetCard }] });
    const withAsset = service.get("ep");
    await publish(service, withAsset.draft.director!);
    const current = service.get("ep");
    await service.edit("ep", { operationId: "delete-published-asset-from-draft", expectedRevision: current.revision, ops: [{ type: "delete_director_asset", id: "PROP_PUBLISHED", confirmed: true }] });
    const after = service.get("ep");
    assert.equal(after.revision, current.revision + 1);
    assert.equal(after.draft.director!.source.asset_plan!.some(item => item.id === "PROP_PUBLISHED"), false);
    assert.ok(after.published?.director?.source.asset_plan?.some(item => item.id === "PROP_PUBLISHED"));
});

