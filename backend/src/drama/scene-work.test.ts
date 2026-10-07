import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compilationHash, compilationScopeInput } from "@basketikun/canvas-agent/drama/compilation-scope";
import { directorSceneWorkSchema, dramaProductionPlanSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { mergeSceneSource, SceneWorkCoordinator } from "./scene-work.js";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { ProductionCompilationService } from "./compilation.js";
import { promptHash } from "./director.js";
import { resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { EpisodeProductionRunner } from "./production-runner.js";
import { createStores } from "../stores/index.js";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import { ensureProductionCanvas } from "./production-canvas.js";

function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scene-work-"));
    const db = new BackendDatabase(path.join(root, "test.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", fullPlot: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, root, false, () => {});
    const source = { brief: "confirmed", script_scenes: [{ id: "A", scene_id: "ROOM", beat_ids: ["a"] }, { id: "B", scene_id: "ROOM", beat_ids: ["b"] }], shots: [], segments: [], asset_plan: [], asset_cards: [] };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: compilationHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
    service.edit("ep", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { parallelScenes: true, reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } } }] });
    const compilations = new ProductionCompilationService(service, path.join(root, "compile"));
    const coordinator = new SceneWorkCoordinator(service, compilations, undefined, "ep", { run: async () => { throw new Error("model must not run before shared review"); } });
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, db, service, director, coordinator };
}

function reviewFixture(t: test.TestContext) {
    const value = fixture(t), { root, service, director, db, coordinator } = value;
    director.source.shots = [{ id: "SA", source_scene_id: "A", scene_id: "ROOM", start_frame: 0, end_frame: 120, visual: "look" }];
    director.source.asset_plan = ["K1", "K2"].map(id => ({ id, kind: "prop", canvas_scope: "episode", shot_ids: ["SA"], version: "v1" }));
    director.shotInputs = { SA: { keyframePolicy: "none", assetIds: [] } };
    director.sourceHash = compilationHash(director.source);
    for (const id of ["K1", "K2"]) {
        const storageKey = `image:${id}`, filePath = path.join(root, `${id}.png`); fs.writeFileSync(filePath, id);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: 2, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id, nodeType: "image", position: { x: 0, y: 0 }, metadata: { storageKey } }]);
        director.assets[id] = { nodeId: id, version: "v1", status: "generated", storageKey, sha256: promptHash(id) };
        const prompt = `image ${id}`;
        director.artifacts.push({ id, targetId: id, kind: "image", status: "ready", prompt, sha256: promptHash(prompt), sourceHash: director.sourceHash, references: [], receipt: { promptHash: promptHash(prompt), sourceHash: director.sourceHash, engineRuntimeId: director.engine.runtimeId, validator: "fixture" } });
    }
    service.edit("ep", { operationId: "images", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    service.publish("ep", { operationId: "images-published", expectedRevision: 2, stage: "director" });
    coordinator.start("ep", { operationId: "start-A", expectedRevision: service.get("ep").revision, sceneIds: ["A"], generateMedia: false });
    const current = service.get("ep"), work = Object.values(current.draft.director!.workflow.sceneWorks!)[0];
    service.edit("ep", { operationId: "paused-review", expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: { [work.workId]: { ...work, stage: "review", status: "paused" } } } }] }, undefined, true);
    const reviewInputHash = () => (coordinator.inspect("ep").works[0] as { reviewInputHash: string }).reviewInputHash;
    return { ...value, workId: work.workId, reviewInputHash };
}

function sharedReviewFixture(t: test.TestContext, partial = false, verdict: "approved" | "needs_human" = "approved") {
    const base = fixture(t), { db, root } = base;
    const id = ensureProductionCanvas(db, "shared-assets", "drama").project.id;
    const service = new EpisodeProductionService(db, undefined, root, true, () => {}), director = structuredClone(base.director);
    director.source.script_scenes = []; director.source.asset_plan = ["K1", "K2"].map(assetId => ({ id: assetId, kind: "prop", canvas_scope: "shared", version: "v1" }));
    director.sourceHash = compilationHash(director.source);
    for (const assetId of ["K1", "K2"]) {
        const storageKey = `image:${assetId}`, filePath = path.join(root, `${assetId}.png`); fs.writeFileSync(filePath, assetId);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: 2, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        const ready = assetId === "K1" || !partial;
        db.applyCanvasProjectOperations(id, undefined, [{ type: "add_node", id: assetId, nodeType: "image", position: { x: 0, y: 0 }, metadata: ready ? { storageKey } : {} }]);
        director.assets[assetId] = { nodeId: assetId, version: "v1", status: ready ? "generated" : "planned", ...(ready ? { storageKey, sha256: promptHash(assetId) } : {}) };
        const prompt = `image ${assetId}`;
        director.artifacts.push({ id: assetId, targetId: assetId, kind: "image", status: "ready", prompt, sha256: promptHash(prompt), sourceHash: director.sourceHash, references: [], receipt: { sourceHash: director.sourceHash, promptHash: promptHash(prompt), engineRuntimeId: director.engine.runtimeId, validator: "mock" } });
    }
    service.edit(id, { operationId: "shared-seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { parallelScenes: true, reviewPolicy: { mode: "automatic", shared: "automatic", scene: "automatic" } } }] });
    service.publish(id, { operationId: "shared-publish", expectedRevision: 1, stage: "director" });
    const agents: any[] = [];
    const coordinator = new SceneWorkCoordinator(service, new ProductionCompilationService(service, path.join(root, "shared-compile")), undefined, "canvas", { run: async request => {
        agents.push(request); request.onThread("review-thread"); request.onTurn?.("review-turn");
        const payload = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
        assert.equal(request.review, true); assert.equal(request.images?.length, payload.media.length);
        return { threadId: "review-thread", output: { verdict, evidence: verdict === "approved" ? "mock real input inspected" : "creative choice requires a human", inspectedMedia: verdict === "approved" ? payload.media.map((item: any) => item.storageKey) : [], unresolved: [] } };
    } });
    return { ...base, id, service, coordinator, agents };
}

test("automatic shared review works without scene records and atomically approves generated common assets", async t => {
    const { id, service, coordinator, agents, db } = sharedReviewFixture(t);
    const request = { operationId: "shared-auto", expectedRevision: service.get(id).revision, model: "user-model", effort: "high" };
    coordinator.startSharedReview(id, request); await new Promise(resolve => setImmediate(resolve));
    const current = service.get(id).draft.director!;
    assert.equal(current.assets.K1.status, "approved"); assert.equal(current.assets.K2.status, "approved");
    assert.equal(current.workflow.sharedReview?.verdict, "approved"); assert.equal(Object.values(current.workflow.sharedReviewWorks!)[0].status, "succeeded");
    assert.equal(Object.values(current.workflow.sharedReviewWorks!)[0].agentThreadId, "review-thread");
    assert.equal(current.workflow.sceneWorks, undefined); assert.equal(agents[0].model, "user-model"); assert.equal(agents[0].effort, "high");
    coordinator.startSharedReview(id, request); await new Promise(resolve => setImmediate(resolve)); assert.equal(agents.length, 1);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n, 0, "review never submits media tasks");
});

test("shared asset waves do not approve missing common assets or release the complete foundation", async t => {
    const { id, service, coordinator, db } = sharedReviewFixture(t, true);
    coordinator.startSharedReview(id, { operationId: "wave-1", expectedRevision: service.get(id).revision }); await new Promise(resolve => setImmediate(resolve));
    let director = service.get(id).draft.director!;
    assert.equal(director.assets.K1.status, "approved"); assert.equal(director.assets.K2.status, "planned"); assert.equal(director.workflow.sharedReview, undefined);
    assert.deepEqual(director.workflow.sharedAssetReviews![0].media.map(item => item.targetId), ["K1"]);
    db.applyCanvasProjectOperations(id, undefined, [{ type: "update_node", id: "K2", metadata: { storageKey: "image:K2" } }]);
    service.bindDirectorAsset(id, service.get(id).publishedVersion, "K2", "image:K2");
    coordinator.wake(id); await new Promise(resolve => setImmediate(resolve));
    director = service.get(id).draft.director!; assert.equal(director.workflow.sharedReview?.verdict, "approved");
    assert.equal(director.workflow.sharedReview?.media.length, 2); assert.equal(Object.keys(director.workflow.sharedReviewWorks!).length, 2);
    assert.equal(director.workflow.sharedReviewContinuation?.status, "complete");
});

test("uncertain shared review leaves generated assets unapproved and transfers to human review", async t => {
    const { id, service, coordinator } = sharedReviewFixture(t, false, "needs_human");
    coordinator.startSharedReview(id, { operationId: "shared-uncertain", expectedRevision: service.get(id).revision }); await new Promise(resolve => setImmediate(resolve));
    const director = service.get(id).draft.director!;
    assert.equal(director.assets.K1.status, "generated"); assert.equal(director.workflow.sharedReview, undefined);
    assert.equal(Object.values(director.workflow.sharedReviewWorks!)[0].status, "awaiting_review");
    assert.equal(director.workflow.sharedReviewContinuation?.status, "awaiting_review");
    const before = Object.keys(director.workflow.sharedReviewWorks!).length;
    coordinator.wake(id); await new Promise(resolve => setImmediate(resolve));
    assert.equal(Object.keys(service.get(id).draft.director!.workflow.sharedReviewWorks!).length, before);
});

test("shared review authorization can wait for media and resume after restart without resubmitting generation", async t => {
    const { id, service, coordinator, db, root, agents } = sharedReviewFixture(t, true);
    const current = service.get(id), director = structuredClone(current.draft.director!);
    director.assets.K1 = { nodeId: "K1", version: "v1", status: "planned" };
    service.edit(id, { operationId: "before-any-media", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });
    coordinator.startSharedReview(id, { operationId: "arm-shared", expectedRevision: service.get(id).revision, model: "frozen-model", effort: "high" });
    assert.equal(agents.length, 0); assert.equal(service.get(id).draft.director!.workflow.sharedReviewContinuation?.status, "active");
    assert.ok(service.sceneWorkOwners().includes(id));
    service.bindDirectorAsset(id, service.get(id).publishedVersion, "K1", "image:K1");
    let calls = 0;
    const recovered = new SceneWorkCoordinator(service, new ProductionCompilationService(service, path.join(root, "restarted-compile")), undefined, "canvas", { run: async request => {
        calls++; assert.equal(request.model, "frozen-model"); assert.equal(request.effort, "high");
        const payload = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
        return { threadId: "recover-audit", output: { verdict: "approved", evidence: "mock vision inspected", inspectedMedia: payload.media.map((item: any) => item.storageKey), unresolved: [] } };
    } });
    recovered.recover(id); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(service.get(id).draft.director!.assets.K1.status, "approved");
    assert.equal(service.get(id).draft.director!.workflow.sharedReview, undefined);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n, 0);
});

test("shared continuation pauses on authored input changes before reviewing a new wave", async t => {
    const { id, service, coordinator, agents } = sharedReviewFixture(t, true);
    coordinator.startSharedReview(id, { operationId: "arm-context", expectedRevision: service.get(id).revision }); await new Promise(resolve => setImmediate(resolve));
    const current = service.get(id), director = structuredClone(current.draft.director!);
    director.source.brief = "changed creative direction"; director.sourceHash = compilationHash(director.source); director.artifacts = []; director.modules = {};
    service.edit(id, { operationId: "change-context", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });
    coordinator.wake(id); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.get(id).draft.director!.workflow.sharedReviewContinuation?.status, "paused");
    assert.equal(agents.length, 1);
});

test("human approval of an uncertain shared wave reactivates continuation without repeating the same model review", async t => {
    const { id, service, coordinator, agents } = sharedReviewFixture(t, true, "needs_human");
    coordinator.startSharedReview(id, { operationId: "arm-human", expectedRevision: service.get(id).revision }); await new Promise(resolve => setImmediate(resolve));
    const shared = coordinator.inspect(id).shared as { inputHash: string; reviewAssetIds: string[] };
    coordinator.review(id, { operationId: "human-wave", inputHash: shared.inputHash, assetIds: shared.reviewAssetIds, verdict: "approved", evidence: "human inspected K1" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.get(id).draft.director!.workflow.sharedReviewContinuation?.status, "active");
    assert.equal(service.get(id).draft.director!.assets.K1.status, "approved");
    assert.equal(agents.length, 1); assert.equal(service.get(id).draft.director!.workflow.sharedReview, undefined);
});

test("shared review restart consumes the cached completed response without another model call", async t => {
    const { id, service, coordinator, root } = sharedReviewFixture(t), edit = service.edit.bind(service);
    service.edit = ((ownerId, raw: any, canvas, trusted) => {
        if (raw.ops.some((op: any) => op.type === "review_director_asset")) throw new Error("simulated failure after the response was cached");
        return edit(ownerId, raw, canvas, trusted);
    }) as typeof service.edit;
    coordinator.startSharedReview(id, { operationId: "cached-audit", expectedRevision: service.get(id).revision }); await new Promise(resolve => setImmediate(resolve));
    service.edit = edit;
    const current = service.get(id), work = Object.values(current.draft.director!.workflow.sharedReviewWorks!)[0];
    assert.equal(work.status, "awaiting_review");
    service.edit(id, { operationId: "restore-precrash-state", expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sharedReviewWorks: { [work.workId]: { ...work, status: "running" } } } }] }, undefined, true);
    let called = 0;
    const recovered = new SceneWorkCoordinator(service, new ProductionCompilationService(service, path.join(root, "recovered")), undefined, "canvas", { run: async () => { called++; throw new Error("must not rerun model"); } });
    recovered.recover(id); await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 0); assert.equal(service.get(id).draft.director!.workflow.sharedReviewWorks![work.workId].status, "succeeded");
    assert.equal(service.get(id).draft.director!.workflow.sharedReview?.verdict, "approved");
});

test("incomplete kickoff settings persist as a draft and only confirmed settings seed new productions", t => {
    const { db, service } = fixture(t);
    const oldProduction = JSON.stringify(service.get("ep"));
    const folder = db.listCanvasFolders().find(item => item.id === "drama")!;
    const draft = dramaProductionPlanSchema.parse({ parallelScenes: true, requirements: "unfinished planning" });
    db.upsertCanvasFolder({ ...folder, outline: "confirmed story", productionPlan: draft, expectedPlanningUpdatedAt: folder.updatedAt || folder.createdAt });
    const saved = db.listCanvasFolders().find(item => item.id === "drama")!;
    assert.equal(saved.productionPlan?.parallelScenes, true); assert.equal(saved.productionPlan?.reviewPolicy, undefined); assert.equal(saved.productionPlan?.confirmedAt, undefined);
    db.upsertDramaEpisode({ id: "unconfirmed", dramaId: "drama", episodeNumber: 2, title: "Unconfirmed", synopsis: "" });
    assert.equal(Boolean(service.get("unconfirmed").draft.settings.parallelScenes), false, "unfinished plans must not enable a new production");
    const confirmed = { ...draft, storyboardImageMode: "skip" as const, reviewPolicy: { mode: "automatic" as const, shared: "automatic" as const, scene: "automatic" as const }, confirmedOutline: saved.outline!, confirmedAt: new Date().toISOString() };
    db.upsertCanvasFolder({ ...saved, productionPlan: confirmed, expectedPlanningUpdatedAt: saved.updatedAt });
    db.upsertDramaEpisode({ id: "confirmed", dramaId: "drama", episodeNumber: 3, title: "Confirmed", synopsis: "" });
    assert.equal(service.get("confirmed").draft.settings.parallelScenes, true);
    assert.deepEqual(service.get("confirmed").draft.settings.reviewPolicy, confirmed.reviewPolicy);
    assert.equal(JSON.stringify(service.get("ep")), oldProduction, "saving a plan cannot rewrite an existing production");
});

test("scene HTTP start returns a formal receipt and replays a lost response without a second work", async t => {
    const { service } = fixture(t), app = express(); app.use(express.json());
    registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/drama/episodes/ep/production/scene-work/start`;
    const body = { operationId: "http-start", expectedRevision: 1, sceneIds: ["A", "B"], generateMedia: false };
    const submit = (input = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const first = await submit().then(response => response.json());
    assert.equal(first.ok, true); assert.ok(Number.isInteger(first.production.revision)); assert.equal(first.production.episodeId, "ep");
    assert.equal(first.production.production, undefined, "formal receipts cannot be nested in a second production wrapper");
    const revision = service.get("ep").revision;
    const replay = await submit().then(response => response.json());
    assert.equal(replay.replayed, true); assert.equal(replay.production.revision, first.production.revision);
    assert.equal(Object.keys(service.get("ep").draft.director!.workflow.sceneWorks!).length, 2); assert.equal(service.get("ep").revision, revision);
    const collision = await submit({ ...body, generateMedia: true }); assert.equal(collision.status, 400);
    assert.match((await collision.json()).error, /IDEMPOTENCY_CONFLICT/);
});

test("scene HTTP review survives unrelated global revisions while retaining its frozen media identity", async t => {
    const { service, workId, reviewInputHash } = reviewFixture(t), expectedRevision = service.get("ep").revision;
    const inputHash = reviewInputHash();
    service.edit("ep", { operationId: "unrelated-progress", expectedRevision, ops: [{ type: "set_director_workflow", patch: { cursor: "another scene advanced" } }] });
    const app = express(); app.use(express.json()); registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/drama/episodes/ep/production/scene-work/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: "independent-review", expectedRevision, workId, inputHash, verdict: "approved", evidence: "the frozen images are still current" }) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(service.get("ep").draft.director!.assets.K1.status, "approved");
    assert.equal(service.get("ep").draft.director!.workflow.sceneWorks![workId].review?.mediaInputHash, inputHash);
    assert.equal(service.get("ep").draft.director!.workflow.sceneWorks![workId].status, "paused");
});

test("review rejects replaced output images even when compiler inputs and authored source stay unchanged", async t => {
    const { service, db, root, coordinator, workId, reviewInputHash } = reviewFixture(t);
    const oldHash = reviewInputHash(), sourceHash = service.get("ep").draft.director!.sourceHash;
    const inputHash = compilationScopeInput(service.get("ep").draft.director!, { sceneId: "A" }).inputHash;
    const filePath = path.join(root, "replacement.png"); fs.writeFileSync(filePath, "replacement");
    db.upsertMediaFile({ storageKey: "image:replacement", filePath, mimeType: "image/png", bytes: 11, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "K1", metadata: { storageKey: "image:replacement" } }]);
    service.bindDirectorAsset("ep", service.get("ep").publishedVersion, "K1", "image:replacement");
    assert.equal(service.get("ep").draft.director!.sourceHash, sourceHash);
    assert.equal(compilationScopeInput(service.get("ep").draft.director!, { sceneId: "A" }).inputHash, inputHash);
    assert.notEqual(reviewInputHash(), oldHash);
    const before = JSON.stringify(service.get("ep"));
    await assert.rejects(coordinator.review("ep", { workId, inputHash: oldHash, verdict: "approved", evidence: "old picture inspected" }), /REVIEW_INPUT_CHANGED/);
    assert.equal(JSON.stringify(service.get("ep")), before);
});

test("multi-asset review rolls back all assets and the work receipt if one media check fails", async t => {
    const { service, coordinator, workId, reviewInputHash } = reviewFixture(t);
    const before = JSON.stringify(service.get("ep")), edit = service.edit.bind(service);
    service.edit = ((id, raw: any, canvas, trusted) => {
        const request = structuredClone(raw), assetOps = request.ops.filter((op: any) => op.type === "review_director_asset");
        if (assetOps.length === 2) assetOps[1].sha256 = "0".repeat(64);
        return edit(id, request, canvas, trusted);
    }) as typeof service.edit;
    await assert.rejects(coordinator.review("ep", { workId, inputHash: reviewInputHash(), verdict: "approved", evidence: "both inspected" }), /摘要/);
    assert.equal(JSON.stringify(service.get("ep")), before);
    service.edit = edit;
    await coordinator.review("ep", { operationId: "atomic-review", workId, inputHash: reviewInputHash(), verdict: "approved", evidence: "both inspected" });
    const approved = service.get("ep");
    assert.equal(approved.revision, JSON.parse(before).revision + 1);
    assert.equal(approved.draft.director!.assets.K1.status, "approved"); assert.equal(approved.draft.director!.assets.K2.status, "approved");
    assert.equal(approved.draft.director!.workflow.sceneWorks![workId].status, "paused", "review does not implicitly unpause a scene");
});
test("new production requires explicit settings, shared review blocks only its production and start replays", t => {
    const { service, coordinator } = fixture(t);
    const input = { operationId: "start", expectedRevision: 1, sceneIds: ["A", "B"], generateMedia: false };
    coordinator.start("ep", input);
    const state = coordinator.inspect("ep"); assert.equal(state.works.length, 2);
    assert.ok(state.works.every(work => work.status === "awaiting_review" && !work.generationAuthorized));
    const beforeReplay = service.get("ep").revision;
    assert.equal(coordinator.start("ep", input).replayed, true);
    assert.equal(service.get("ep").revision, beforeReplay);
    coordinator.pause("ep", state.works[0].workId);
    assert.equal(coordinator.inspect("ep").works.find(work => work.workId === state.works[0].workId)!.status, "paused");
    assert.equal(coordinator.inspect("ep").works.find(work => work.workId === state.works[1].workId)!.status, "awaiting_review");
});

test("asset-wave approval retains scoped evidence without granting whole-scene shooting approval", async t => {
    const { service, coordinator, workId, reviewInputHash } = reviewFixture(t);
    await coordinator.review("ep", { operationId: "wave-K1", workId, assetIds: ["K1"], inputHash: reviewInputHash(), verdict: "approved", evidence: "K1 inspected; K2 remains pending" });
    const director = service.get("ep").draft.director!, work = director.workflow.sceneWorks![workId];
    assert.equal(director.assets.K1.status, "approved"); assert.equal(director.assets.K2.status, "generated");
    assert.equal(work.review, undefined); assert.equal(work.stage, "assets"); assert.equal(work.status, "paused");
    assert.deepEqual(work.assetReviews![0].media.map(item => item.targetId), ["K1"]);
    assert.equal(work.assetReviews![0].evidence, "K1 inspected; K2 remains pending");
});

test("skip storyboard mode waives only keyframes and still requires real prop assets", async t => {
    const { service, coordinator, workId } = reviewFixture(t);
    const current = service.get("ep"), director = structuredClone(current.draft.director!);
    director.source.asset_plan = [...director.source.asset_plan as any[], { id: "missing-frame", kind: "keyframe", canvas_scope: "episode", shot_ids: ["SA"] }, { id: "missing-prop", kind: "prop", canvas_scope: "episode", shot_ids: ["SA"] }];
    director.sourceHash = compilationHash(director.source); director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    service.edit("ep", { operationId: "skip-with-prop", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { storyboardImageMode: "skip" } }] });
    const inputHash = (coordinator.inspect("ep").works[0] as { reviewInputHash: string }).reviewInputHash;
    await assert.rejects(coordinator.review("ep", { workId, inputHash, verdict: "approved", evidence: "cannot waive required props" }), error => String(error).includes("missing-prop") && !String(error).includes("missing-frame"));
});

test("a no-op pause still persists a replay receipt and rejects operation identity reuse", t => {
    const { service, coordinator } = fixture(t);
    coordinator.start("ep", { operationId: "start", expectedRevision: 1, sceneIds: ["A"], generateMedia: false });
    const work = coordinator.inspect("ep").works[0]; coordinator.pause("ep", work.workId);
    const command = { action: "pause", workId: work.workId };
    assert.equal(coordinator.commandReceipt("ep", "pause-receipt", command), undefined);
    coordinator.pause("ep", work.workId, "pause-receipt");
    assert.ok(coordinator.commandReceipt("ep", "pause-receipt", command));
    assert.throws(() => coordinator.commandReceipt("ep", "pause-receipt", { action: "resume", workId: work.workId }), /IDEMPOTENCY_CONFLICT/);
    assert.equal(service.get("ep").draft.director!.workflow.sceneWorks![work.workId].status, "paused");
});
test("scene source merge rejects shared and other-scene writes, keeps unrelated facts and partial results", t => {
    const { director } = fixture(t);
    const input = compilationScopeInput(director, { sceneId: "A" });
    const work = directorSceneWorkSchema.parse({ workId: "work-A", sceneId: "A", inputRevision: 1, sourceHash: director.sourceHash, inputHash: input.inputHash, status: "running", stage: "create", policy: { mode: "manual", shared: "manual", scene: "manual" }, updatedAt: new Date().toISOString() });
    const response = { status: "complete", sourceJson: JSON.stringify(input.director.source), shotInputsJson: "{}", boundariesJson: "[]", evidence: ["authored"], unresolved: [], cursor: "" };
    const source = structuredClone(input.director.source) as any;
    source.shots = [{ id: "S-A", source_scene_id: "A", scene_id: "ROOM", visual: "visible event" }];
    assert.ok(mergeSceneSource(director, work, { ...response, sourceJson: JSON.stringify(source) }).director);
    source.shots[0].source_scene_id = "B";
    assert.throws(() => mergeSceneSource(director, work, { ...response, sourceJson: JSON.stringify(source) }), /OUTSIDE_SCOPE/);
    source.shots = []; source.brief = "changed shared story";
    assert.throws(() => mergeSceneSource(director, work, { ...response, sourceJson: JSON.stringify(source) }), /OUTSIDE_SCOPE/);
    const partial = mergeSceneSource(director, work, { ...response, status: "partial", cursor: "next sentence" });
    assert.equal(partial.director, undefined); assert.equal(partial.result.cursor, "next sentence");
    assert.equal(director.source.brief, "confirmed");
});

test("scene repairs retain media but require new review only for assets whose inputs changed", t => {
    const { service, workId } = reviewFixture(t), director = service.get("ep").draft.director!;
    const scope = compilationScopeInput(director, { sceneId: "A" });
    const work = { ...director.workflow.sceneWorks![workId], inputHash: scope.inputHash };
    const source = structuredClone(scope.director.source) as any; source.asset_plan.find((item: any) => item.id === "K1").description = "new visual requirement";
    const merged = mergeSceneSource(director, work, { status: "complete", sourceJson: JSON.stringify(source), shotInputsJson: JSON.stringify(scope.director.shotInputs), boundariesJson: "[]", evidence: ["targeted repair"], unresolved: [], cursor: "" }).director!;
    assert.equal(merged.assets.K1.inputOutdated, true); assert.equal(Boolean(merged.assets.K2.inputOutdated), false);
    assert.equal(merged.assets.K1.storageKey, director.assets.K1.storageKey); assert.equal(merged.assets.K1.sha256, director.assets.K1.sha256);
});
test("stale manual reviews cannot approve a changed scene source", async t => {
    const { coordinator } = fixture(t); coordinator.start("ep", { operationId: "start", expectedRevision: 1, sceneIds: ["A"], generateMedia: false });
    await assert.rejects(coordinator.review("ep", { inputHash: "0".repeat(64), verdict: "approved", evidence: "viewed" }), /REVIEW_INPUT_CHANGED/);
});

test("public workflow and full source writes cannot forge coordinator approval or erase work history", t => {
    const { service, coordinator } = fixture(t);
    coordinator.start("ep", { operationId: "start", expectedRevision: 1, sceneIds: ["A"], generateMedia: false });
    const current = service.get("ep");
    const request = { operationId: "forged", expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: {} } }] };
    assert.throws(() => service.edit("ep", request), /SCENE_RUNTIME_OWNED/);
    const director = structuredClone(current.draft.director!); delete director.workflow.sceneWorks;
    assert.throws(() => service.edit("ep", { ...request, ops: [{ type: "set_director_production", director }] }), /SCENE_RUNTIME_OWNED/);
    assert.equal(service.get("ep").revision, current.revision);
    assert.equal(coordinator.inspect("ep").works.length, 1);
});

test("asset-wave review rejects absent media without approving a scene", async t => {
    const { service, coordinator } = fixture(t);
    coordinator.start("ep", { operationId: "start", expectedRevision: 1, sceneIds: ["A"], generateMedia: false });
    const work = coordinator.inspect("ep").works[0];
    const initial = service.get("ep");
    service.edit("ep", { operationId: "review-stage", expectedRevision: initial.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: { [work.workId]: { ...initial.draft.director!.workflow.sceneWorks![work.workId], stage: "review" } } } }] }, undefined, true);
    const before = service.get("ep").revision;
    await assert.rejects(coordinator.review("ep", { workId: work.workId, assetIds: [], inputHash: work.inputHash, verdict: "approved", evidence: "no actual image" }), /缺少真实素材/);
    assert.equal(service.get("ep").revision, before);
    assert.equal(coordinator.inspect("ep").works[0].review, undefined);
});

test("explicit media continuation preserves the original work identity and other scene authorization", t => {
    const { service, coordinator } = fixture(t);
    coordinator.start("ep", { operationId: "source-only", expectedRevision: 1, sceneIds: ["A", "B"], generateMedia: false });
    const current = service.get("ep"), works = structuredClone(current.draft.director!.workflow.sceneWorks!);
    const a = Object.values(works).find(work => work.sceneId === "A")!;
    a.stage = "review"; a.status = "awaiting_review";
    service.edit("ep", { operationId: "source-ready", expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: works } }] }, undefined, true);
    const input = { operationId: "authorize-A", expectedRevision: service.get("ep").revision, sceneIds: ["A"], generateMedia: true };
    coordinator.start("ep", input);
    const state = coordinator.inspect("ep");
    assert.equal(state.works.length, 2); assert.equal(state.works.find(work => work.sceneId === "A")?.workId, a.workId);
    assert.equal(state.works.find(work => work.sceneId === "A")?.generationAuthorized, true);
    assert.equal(state.works.find(work => work.sceneId === "B")?.generationAuthorized, false);
    const revision = service.get("ep").revision; coordinator.start("ep", input); assert.equal(service.get("ep").revision, revision);
});

test("scene coordinator progresses independent source, scoped compilation, automatic review and H3 closeout", async t => {
    const { service, db, root, director } = fixture(t), stores = createStores(db);
    director.engine = resolveAchengEngine();
    service.edit("ep", { operationId: "runtime", expectedRevision: 1, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { storyboardImageMode: "skip", h3Model: "fake-h3", videoAspectRatio: "16:9", videoAspectRatioConfirmed: true, reviewPolicy: { mode: "mixed", shared: "manual", scene: "automatic" } } }] });
    const compiler = (input: DirectorProduction) => {
        const artifacts = (input.source.segments as any[]).map(segment => {
            const prompt = `integrated_multimodal_description:\n[Shot 1] ${segment.id} moves.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A\n`;
            return { id: segment.id, targetId: segment.id, kind: "h3" as const, status: "ready" as const, prompt, sha256: promptHash(prompt), sourceHash: input.sourceHash, references: [], receipt: { promptHash: promptHash(prompt), sourceHash: input.sourceHash, engineRuntimeId: input.engine.runtimeId, validator: "mock" } };
        });
        return { director: { ...input, artifacts }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    };
    const compilation = new ProductionCompilationService(service, path.join(root, "compiler"), compiler);
    let generated = 0;
    const generation = { start: async (command: any) => {
        generated++; const task = stores.tasks.create(command.idempotencyKey, "canvas-h3-run", command, {});
        const storageKey = `video:${task.id}`, filePath = path.join(root, `${task.id}.mp4`); fs.writeFileSync(filePath, "mock video");
        db.upsertMediaFile({ storageKey, filePath, mimeType: "video/mp4", bytes: 10, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_h3_segment", nodeId: command.nodeId, segmentId: command.segmentId, patch: { resultStorageKey: storageKey } }], { runtimeWrite: true });
        stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey }] } }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(service, stores, generation);
    const coordinator = new SceneWorkCoordinator(service, compilation, runner, "episode", { run: async request => {
        if (request.review) {
            const payload = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
            return { threadId: "review", output: { verdict: payload.source.script_scenes[0].id === "A" ? "needs_human" : "approved", evidence: "mock scene A needs a creative decision; B can proceed", inspectedMedia: [], unresolved: [] } };
        }
        const source = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1)).source;
        const sceneId = source.script_scenes[0].id, start = sceneId === "A" ? 0 : 120;
        source.shots = [{ id: `shot-${sceneId}`, source_scene_id: sceneId, scene_id: "ROOM", start_frame: start, end_frame: start + 120, visual: "move", dialogues: [], audio: {} }];
        source.segments = [{ id: `segment-${sceneId}`, shot_ids: [`shot-${sceneId}`], start_frame: start, end_frame: start + 120, generation_clip_duration: 5, mode: "T2VA" }];
        return { threadId: `agent-${sceneId}`, output: { status: "complete", sourceJson: JSON.stringify(source), shotInputsJson: JSON.stringify({ [`shot-${sceneId}`]: { assetIds: [], keyframePolicy: "none" } }), boundariesJson: "[]", evidence: ["mock authoring"], unresolved: [], cursor: "" } };
    } });
    compilation.onSettled = id => coordinator.wake(id);
    coordinator.start("ep", { operationId: "parallel-start", expectedRevision: service.get("ep").revision, sceneIds: ["A", "B"], generateMedia: true });
    await coordinator.review("ep", { inputHash: coordinator.inspect("ep").shared!.inputHash as string, verdict: "approved", evidence: "mock foundation inspected" });
    for (let step = 0; step < 150; step++) {
        coordinator.wake("ep"); await new Promise(resolve => setImmediate(resolve));
        const works = coordinator.inspect("ep").works;
        if (works.some(work => work.sceneId === "B" && work.status === "succeeded") || works.some(work => ["blocked", "failed"].includes(work.status))) break;
    }
    const waiting = coordinator.inspect("ep").works;
    assert.equal(waiting.find(work => work.sceneId === "A")?.status, "awaiting_review", JSON.stringify(waiting));
    assert.equal(waiting.find(work => work.sceneId === "B")?.status, "succeeded", JSON.stringify(waiting));
    assert.equal(generated, 1, "A waits for human review while B finishes");
    const a = waiting.find(work => work.sceneId === "A")!;
    await coordinator.review("ep", { workId: a.workId, inputHash: (coordinator.inspect("ep").works.find(work => work.workId === a.workId) as { reviewInputHash: string }).reviewInputHash, verdict: "approved", evidence: "mock human resolves creative choice" });
    for (let step = 0; step < 150; step++) {
        coordinator.wake("ep"); await new Promise(resolve => setImmediate(resolve));
        if (coordinator.inspect("ep").works.every(work => ["succeeded", "blocked", "failed"].includes(work.status))) break;
    }
    const works = coordinator.inspect("ep").works;
    assert.ok(works.every(work => work.status === "succeeded"), JSON.stringify(works.map(work => ({ scene: work.sceneId, stage: work.stage, status: work.status, error: work.error }))));
    assert.equal(generated, 2); assert.equal(service.listBatches("ep").filter(batch => batch.status === "succeeded").length, 2);
    coordinator.wake("ep"); await new Promise(resolve => setImmediate(resolve)); assert.equal(generated, 2, "completed work must not generate again");
});
