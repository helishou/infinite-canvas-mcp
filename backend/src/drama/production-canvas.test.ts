import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { buildProductionClip, clipInputHash, productionClipProjection } from "./clip-inputs.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { ensureProductionCanvas, productionCanvasContext } from "./production-canvas.js";
import { SharedAssetCoordinator, listApprovedSharedAssets, sharedProjectionNodeId, validateSharedAssetSource } from "./shared-assets.js";
import { directorHash, promptHash } from "./director.js";
import { NativeProductionGeneration } from "./native-generation.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import type { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";
import { productionWriteReceipt } from "@basketikun/canvas-agent/drama/production-contract";
import express from "express";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerBackendMcpHttpRoutes } from "../mcp.js";
import { registerDramaProductionRoutes } from "../server/drama-production-routes.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "production-canvas-"));
    const file = path.join(directory, "db.sqlite"), db = new BackendDatabase(file), stores = createStores(db), events = new BackendEventBus();
    db.onCanvasCommit(commit => events.publishCanvasDelta({ entityId: commit.projectId, revision: commit.revision, operations: commit.operations }));
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    db.upsertDramaEpisode({ id: "ep2", dramaId: "drama", episodeNumber: 2, title: "Episode 2", synopsis: "" });
    const episode = new EpisodeProductionService(db, events, directory, false, () => {});
    const shared = new EpisodeProductionService(db, events, directory, true, () => {});
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { db, stores, events, episode, shared, directory, file };
}
function director(): DirectorProduction {
    const source = { fps_num: 24, fps_den: 1, style_policy: "waived", style_policy_reason: "one existing identity reference",
        scene_registry: [{ id: "room", name: "Room" }], script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "First visit", beat_ids: ["b1"] }, { id: "night", scene_id: "room", scene_name: "Night", text: "Return", beat_ids: ["b2"] }],
        asset_plan: [{ asset_id: "ROLE", asset_name: "Character", version: "v1", depends_on: [] }, { asset_id: "FRAME", asset_name: "Opening frame", version: "v1", depends_on: ["ROLE"] }],
        shots: [{ id: "s1", title: "Entrance", scene_id: "room", story_beat_ids: ["b1"], start_frame: 0, end_frame: 120, visual: "Enter", camera: "static", state_in: {}, state_out: {}, required_assets: ["ROLE"], dialogues: [] },
            { id: "s2", title: "Return", scene_id: "room", story_beat_ids: ["b2"], start_frame: 120, end_frame: 240, visual: "Return", camera: "static", state_in: {}, state_out: {}, required_assets: ["ROLE"], dialogues: [] }],
        segments: [{ id: "seg1", shot_ids: ["s1"], start_frame: 0, end_frame: 120, generation_clip_duration: 5, mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], start_frame: 120, end_frame: 240, generation_clip_duration: 5, mode: "T2VA" }] };
    const sourceHash = directorHash(source), engine = { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" };
    const artifacts: DirectorProduction["artifacts"] = ["ROLE", "FRAME", "seg1", "seg2"].map(id => {
        const prompt = `integrated_multimodal_description:\n[Shot 1] Complete ${id}.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A\n`, sha256 = promptHash(prompt);
        return { id, targetId: id, kind: id.startsWith("seg") ? "h3" : "image", prompt, sha256, sourceHash, status: "ready", references: [], receipt: { sourceHash, promptHash: sha256, engineRuntimeId: engine.runtimeId, validator: "fixture" } };
    });
    return { schemaVersion: 1, engine, source, sourceHash, artifacts, assets: { ROLE: { version: "v1", status: "planned" } },
        modules: { story: { status: "committed", evidence: [], unresolved: [] } }, shotInputs: { s1: { assetIds: ["ROLE"], keyframePolicy: "new", keyframeAssetId: "FRAME" }, s2: { assetIds: ["ROLE"], keyframePolicy: "none" } },
        boundaries: [{ from: "seg1", to: "seg2", tailFrame: false, motionContext: false, reason: "Authored cut" }], executionAuthorized: false, unresolved: [], workflow: { mediaProductionMode: "automatic" } };
}
function save(service: EpisodeProductionService, id: string, d: DirectorProduction) {
    const current = service.get(id);
    return service.edit(id, { operationId: crypto.randomUUID(), expectedRevision: current.revision, ops: [{ type: "set_director_production", director: d }] });
}
function publish(service: EpisodeProductionService, id: string) {
    return service.publish(id, { operationId: crypto.randomUUID(), expectedRevision: service.get(id).revision, stage: "director" });
}

test("large preparation, arrangement and synchronization recover lost responses without duplicate effects", async t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    (d.source.script_scenes as any[]).forEach(scene => { scene.text = "完整剧情😀".repeat(25000); });
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.prompt += "完整镜头正文😀".repeat(10000); artifact.sha256 = promptHash(artifact.prompt); artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; artifact.receipt.promptHash = artifact.sha256; });
    save(f.episode, "ep", d); const published = publish(f.episode, "ep");
    const generation = { run: () => { throw new Error("Acceptance must never submit media"); } } as unknown as CanvasGenerationService;
    let runner = new EpisodeProductionRunner(f.episode, f.stores, generation);
    const measure = (tool: string, input: Record<string, unknown>, action: () => any) => {
        const start = performance.now(), production = action();
        const beforeBytes = Buffer.byteLength(JSON.stringify({ ok: true, production }));
        const receipt = productionWriteReceipt({ ok: true, production }, { tool, input });
        console.log(JSON.stringify({ tool, calls: 1, beforeBytes, afterBytes: Buffer.byteLength(JSON.stringify(receipt)), elapsedMs: Math.round(performance.now() - start) }));
        assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 8192);
        return production;
    };
    const revision = f.episode.get("ep").revision;
    const prepareInput = { kind: "episode", id: "ep", expectedRevision: revision, operationId: "lost-prepare", targets: ["segment:seg1"] };
    measure("production_prepare_targets", prepareInput, () => runner.prepareTargets("ep", revision, prepareInput.targets, prepareInput.operationId));
    const afterPrepare = f.db.getCanvasProject(projectId)!;
    const reopened = new EpisodeProductionService(f.db, f.events, f.directory, false, () => {});
    runner = new EpisodeProductionRunner(reopened, f.stores, generation);
    const app = express(); app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    registerDramaProductionRoutes(app, reopened, runner);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const client = new Client({ name: "lost-response-recovery", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const recover = async (tool: string, input: Record<string, unknown>) => {
        const start = performance.now();
        const response: any = await client.callTool({ name: tool, arguments: input });
        assert.equal(response.isError, undefined, JSON.stringify(response));
        assert.ok(Buffer.byteLength(JSON.stringify(response)) < 8192);
        console.log(JSON.stringify({ tool, recoveryCalls: 1, recoveryMcpBytes: Buffer.byteLength(JSON.stringify(response)), elapsedMs: Math.round(performance.now() - start) }));
        return JSON.parse(response.content[0].text);
    };
    assert.equal((await recover("production_prepare_targets", prepareInput)).production.replayed, true);
    assert.equal(f.db.getCanvasProject(projectId)!.revision, afterPrepare.revision);
    const arrangeRevision = reopened.get("ep").revision;
    const arrangeInput = { kind: "episode", id: "ep", sceneId: "morning", expectedRevision: arrangeRevision, operationId: "lost-arrange" };
    measure("production_arrange_scene", arrangeInput, () => runner.arrangeScene("ep", "morning", arrangeRevision, arrangeInput.operationId));
    const afterArrange = f.db.getCanvasProject(projectId)!;
    assert.equal((await recover("production_arrange_scene", arrangeInput)).production.replayed, true);
    assert.equal(f.db.getCanvasProject(projectId)!.revision, afterArrange.revision);
    measure("production_sync_clips", { kind: "episode", id: "ep" }, () => runner.syncClips("ep", published.publishedVersion));
    const afterSync = f.db.getCanvasProject(projectId)!;
    const productionRevision = reopened.get("ep").revision;
    const repeatedSync = await recover("production_sync_clips", { kind: "episode", id: "ep" });
    assert.equal(repeatedSync.counts.updated, 0);
    assert.equal(repeatedSync.counts.skipped, published.published!.clipGroups.length);
    assert.equal(f.db.getCanvasProject(projectId)!.revision, afterSync.revision, "repeated synchronization must not rewrite identical Clip inputs");
    assert.equal(reopened.get("ep").revision, productionRevision);
    assert.deepEqual((f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.type === "minimax-h3:video").map(node => node.metadata.segments.map((segment: any) => segment.id)),
        (afterSync.nodes as any[]).filter(node => node.type === "minimax-h3:video").map(node => node.metadata.segments.map((segment: any) => segment.id)));
    assert.equal(f.stores.tasks.list().length, 0);
});

test("synchronization repairs shared-node Clip ordering once and then leaves revisions unchanged", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "One scene", beat_ids: ["b1", "b2"] }];
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    save(f.episode, "ep", d); const published = publish(f.episode, "ep");
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const first = runner.syncClips("ep", published.publishedVersion);
    const [a, b] = first.published!.clipGroups;
    assert.equal(a.nodeId, b.nodeId);
    f.stores.projects.applyOperations(projectId, undefined, [{ type: "move_h3_segment", nodeId: a.nodeId!, segmentId: b.segmentId!, beforeSegmentId: a.segmentId! }], { runtimeWrite: true });
    const repaired = runner.syncClips("ep", published.publishedVersion);
    const segments = () => ((f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === a.nodeId).metadata.segments as any[]).map(segment => segment.id);
    assert.deepEqual(segments(), [a.segmentId, b.segmentId]); assert.ok(repaired.syncReceipt.reordered > 0);
    const revision = f.db.getCanvasProject(projectId)!.revision;
    const repeated = runner.syncClips("ep", published.publishedVersion);
    assert.equal(f.db.getCanvasProject(projectId)!.revision, revision);
    assert.equal(repeated.syncReceipt.updated, 0); assert.equal(repeated.syncReceipt.reordered, 0); assert.equal(repeated.syncReceipt.skipped, 2);
    assert.equal(f.stores.tasks.list().length, 0);
});

test("script text nodes persist original blocks, synchronize collaborative edits atomically and replay once", t => {
    const f = fixture(t), canvasId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "action", scene_id: "room", scene_name: "Morning", kind: "action", text: "原动作", beat_ids: ["b1"] }, { id: "dialogue", scene_id: "room", kind: "dialogue", text: "原对白", beat_ids: ["b1"] }];
    d.sourceHash = directorHash(d.source); d.artifacts = d.artifacts.map(item => ({ ...item, status: "stale" }));
    save(f.episode, "ep", d);
    const project = f.db.getCanvasProject(canvasId)!;
    const scripts = (project.nodes as any[]).filter(node => node.metadata.productionScriptId);
    assert.equal(scripts.length, 2);
    assert.deepEqual(scripts.map(node => node.metadata.content), ["原动作", "原对白"]);
    const node = scripts[1], target = { nodeId: node.id, field: "content" as const };
    const document = f.db.getCanvasText(canvasId, target), prior = f.episode.get("ep");
    const request = [{ type: "text_replace", target, documentId: document.documentId, expectedText: "原对白", text: "新对白😀" }];
    const changed = f.db.applyCanvasProjectOperations(canvasId, Number(project.revision), request, { operationId: "script-text-edit" });
    const current = f.episode.get("ep"), blocks = current.draft.director!.source.script_scenes as any[];
    assert.deepEqual(blocks.map(block => [block.id, block.kind, block.text, block.beat_ids]), [["action", "action", "原动作", ["b1"]], ["dialogue", "dialogue", "新对白😀", ["b1"]]]);
    assert.equal(current.revision, prior.revision + 1);
    assert.equal(current.draft.director!.sourceHash, directorHash(current.draft.director!.source));
    assert.equal(current.draft.director!.executionAuthorized, false);
    assert.deepEqual(current.published, prior.published);
    assert.equal(f.db.applyCanvasProjectOperations(canvasId, Number(project.revision), request, { operationId: "script-text-edit" }).duplicated, true);
    assert.deepEqual(f.episode.get("ep"), current);
    assert.equal(changed.project.revision, Number(project.revision) + 1);
    const beforeFailure = f.db.getCanvasProject(canvasId);
    assert.throws(() => f.db.applyCanvasProjectOperations(canvasId, Number(beforeFailure!.revision), [{ type: "update_node", id: node.id, metadata: { content: "不能提交" } }, { type: "update_node", id: "missing", metadata: { content: "错误" } }], { operationId: "failed-script-edit" }));
    assert.deepEqual(f.episode.get("ep"), current);
    assert.deepEqual(f.db.getCanvasProject(canvasId), beforeFailure);
});

test("formal script edits update the same text node and document while preserving user layout and other scenes", t => {
    const f = fixture(t), canvasId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const scripts = (f.db.getCanvasProject(canvasId)!.nodes as any[]).filter(node => node.metadata.productionScriptId);
    const node = scripts[0], other = scripts[1], target = { nodeId: node.id, field: "content" as const };
    f.db.getCanvasText(canvasId, target);
    f.db.applyCanvasProjectOperations(canvasId, undefined, [{ type: "update_node", id: node.id, patch: { position: { x: 300, y: 800 }, width: 700 } }]);
    const current = f.episode.get("ep");
    const request = { operationId: "source-script-edit", expectedRevision: current.revision, ops: [{ type: "patch_director_source", entity: "scene", id: "morning", patch: { text: "Changed scene" } }] };
    f.episode.edit("ep", request);
    const project = f.db.getCanvasProject(canvasId)!, edited = (project.nodes as any[]).find(item => item.id === node.id);
    assert.equal(edited.metadata.content, "Changed scene");
    assert.deepEqual(edited.position, { x: 300, y: 800 }); assert.equal(edited.width, 700);
    assert.deepEqual((project.nodes as any[]).find(item => item.id === other.id), other);
    assert.equal(f.db.getCanvasText(canvasId, target).text, "Changed scene");
    assert.equal(f.episode.edit("ep", request).replayed, true);
    assert.deepEqual(f.db.getCanvasProject(canvasId), project);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const revision = f.episode.get("ep").revision;
    runner.prepareTargets("ep", revision, ["scene:morning"], "prepare-script-nodes");
    runner.prepareTargets("ep", revision, ["scene:morning"], "prepare-script-nodes");
    assert.deepEqual(f.db.getCanvasProject(canvasId), project);
});

test("asset preparation follows its declared canvas and rejects the wrong owner without reserving the operation", t => {
    const f = fixture(t), episodeCanvas = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const episodeDirector = director();
    (episodeDirector.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope = "shared";
    episodeDirector.sourceHash = directorHash(episodeDirector.source);
    episodeDirector.artifacts = episodeDirector.artifacts.map(item => ({ ...item, status: "stale" }));
    save(f.episode, "ep", episodeDirector);
    const sharedTarget = f.episode.workflowReadiness("ep").targets.find(item => item.id === "asset:ROLE")!;
    assert.match(sharedTarget.blockers.join(";"), /共享资产 ROLE 尚未采用/);
    const published = publish(f.episode, "ep"), blockedRun = { runId: "unadopted-shared", idempotencyKey: "unadopted-shared", expectedRevision: f.episode.get("ep").revision, version: published.publishedVersion, targets: ["asset:ROLE"] };
    const generationPreflight = f.episode.preflight("ep", { action: "generate", request: blockedRun });
    assert.equal(generationPreflight.valid, false);
    assert.match(generationPreflight.diagnostics.map(item => item.message).join(";"), /共享资产 ROLE 尚未采用/);
    assert.equal(f.episode.getBatch("ep", blockedRun.runId), null);
    const episodeRunner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    assert.throws(() => episodeRunner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "wrong-episode-owner"), /属于剧目共享/);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("wrong-episode-owner"), undefined);
    assert.ok(f.db.getCanvasProject(episodeCanvas));

    const sharedCanvas = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const sharedDirector = director();
    (sharedDirector.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope = "episode";
    sharedDirector.sourceHash = directorHash(sharedDirector.source);
    sharedDirector.artifacts = sharedDirector.artifacts.map(item => ({ ...item, status: "stale" }));
    save(f.shared, sharedCanvas, sharedDirector);
    const sharedRunner = new EpisodeProductionRunner(f.shared, f.stores, {} as CanvasGenerationService);
    assert.throws(() => sharedRunner.prepareTargets(sharedCanvas, f.shared.get(sharedCanvas).revision, ["asset:ROLE"], "wrong-shared-owner"), /属于本集专用/);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("wrong-shared-owner"), undefined);
});

function historyFixture(t: test.TestContext) {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE", "frame:s1", "segment:seg1", "segment:seg2"], "history-prepare");
    const published = publish(f.episode, "ep");
    function result(kind: "asset" | "keyframe" | "segment", targetId: string, storageKey: string) {
        const nodeId = kind === "segment" ? published.draft.clipGroups.find(group => group.id === targetId)!.nodeId! : kind === "keyframe" ? published.draft.director!.assets.FRAME.nodeId! : published.draft.director!.assets.ROLE.nodeId!;
        const segmentId = kind === "segment" ? published.draft.clipGroups.find(group => group.id === targetId)!.segmentId! : undefined;
        const mimeType = kind === "segment" ? "video/mp4" : "image/png";
        const filePath = path.join(f.directory, `${targetId}.media`); fs.writeFileSync(filePath, storageKey);
        f.db.upsertMediaFile({ storageKey, filePath, mimeType, bytes: storageKey.length, width: 8, height: 8, durationMs: kind === "segment" ? 5000 : null, createdAt: new Date().toISOString() });
        const task = f.db.createTask(`history:${targetId}`, "fixture", { projectId, nodeId, segmentId }, {});
        f.db.updateTask(task.id, { status: "succeeded", result: { media: [{ storageKey, mimeType }] } });
        f.db.db.prepare("INSERT INTO production_task_bindings(task_id,owner_kind,owner_id,version,source_hash,project_id,node_id,target_kind,target_id,targets_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(task.id, "episode", "ep", published.publishedVersion, published.draft.director!.sourceHash, projectId, nodeId, kind, targetId, JSON.stringify([{ targetId, segmentId }]), "bound");
        const log = f.db.createGenerationLog({ projectId, nodeId, segmentId, status: "success", platform: kind === "segment" ? "h3" : "image", model: "fixture", runtimeTaskId: task.id, references: [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 0, outputs: [{ storageKey, mimeType }], params: {} });
        return { type: "select_director_result" as const, targetKind: kind, targetId, nodeId, storageKey, generationLogId: log.id, canvasRevision: Number(f.db.getCanvasProject(projectId)!.revision) };
    }
    return { ...f, projectId, result };
}

test("history selection atomically restores one formal result, preserves task inputs and replays without notification", t => {
    const f = historyFixture(t), op = f.result("asset", "ROLE", "image:old");
    const request = { operationId: "select-old", expectedRevision: f.episode.get("ep").revision, ops: [op] };
    const originalTask = f.db.getTask("history:ROLE");
    const canvasBefore = f.db.getCanvasProject(f.projectId);
    assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
    assert.deepEqual(f.db.getCanvasProject(f.projectId), canvasBefore, "preflight is read-only");
    let notifications = 0; f.db.onCanvasCommit(() => { notifications++; assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.storageKey, "image:old"); });
    const selected = f.episode.edit("ep", request);
    assert.equal(selected.draft.director!.assets.ROLE.status, "generated");
    assert.equal(selected.published!.director!.assets.ROLE.storageKey, "image:old");
    assert.equal((f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === op.nodeId).metadata.storageKey, "image:old");
    assert.equal(notifications, 1); assert.deepEqual(f.db.getTask("history:ROLE"), originalTask);
    assert.equal(f.episode.edit("ep", request).replayed, true); assert.equal(notifications, 1);
});

test("history selection rolls back canvas, production and receipts when a later operation fails", t => {
    const f = historyFixture(t), op = f.result("asset", "ROLE", "image:rollback");
    const project = f.db.getCanvasProject(f.projectId), record = f.episode.get("ep"); let notifications = 0; f.db.onCanvasCommit(() => notifications++);
    assert.throws(() => f.episode.edit("ep", { operationId: "failed-select", expectedRevision: record.revision, ops: [op, { type: "bind_director_asset", assetId: "MISSING", nodeId: "missing" }] }));
    assert.deepEqual(f.db.getCanvasProject(f.projectId), project); assert.deepEqual(f.episode.get("ep"), record); assert.equal(notifications, 0);
    assert.equal(f.db.getCanvasOperationReceipt(f.projectId, "failed-select:result:asset:ROLE").committed, false);
});

test("history selection rejects mismatched tasks and Clips, active generation and stale canvas revisions", t => {
    const f = historyFixture(t), image = f.result("asset", "ROLE", "image:valid");
    const select = (op: Record<string, unknown>) => f.episode.edit("ep", { operationId: crypto.randomUUID(), expectedRevision: f.episode.get("ep").revision, ops: [op] });
    assert.throws(() => select({ ...image, storageKey: "image:forged" }), /不一致/);
    assert.throws(() => select({ ...image, canvasRevision: image.canvasRevision + 1 }), /画布已变化/);
    const video = f.result("segment", "seg1", "video:old");
    assert.throws(() => select({ ...video, targetId: "seg2" }), /Clip/);
    const nodeId = video.nodeId;
    f.db.applyCanvasProjectOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_h3_segment", nodeId, segmentId: f.episode.get("ep").draft.clipGroups[0].segmentId, patch: { status: "loading" } }], { runtimeWrite: true });
    assert.throws(() => select({ ...video, canvasRevision: Number(f.db.getCanvasProject(f.projectId)!.revision) }), /正在生成/);
});

test("history selection restores the exact Clip without changing authored timing or continuity", t => {
    const f = historyFixture(t), op = f.result("segment", "seg2", "video:second");
    const before = f.episode.get("ep");
    const selected = f.episode.edit("ep", { operationId: "select-clip", expectedRevision: before.revision, ops: [op] });
    const nodes = f.db.getCanvasProject(f.projectId)!.nodes as any[];
    const clips = nodes.flatMap(node => node.type === "minimax-h3:video" ? node.metadata.segments : []);
    const restoredClip = nodes.find(node => node.id === op.nodeId).metadata.segments[0];
    assert.equal(restoredClip.resultStorageKey, "video:second");
    assert.equal(clips.filter((clip: any) => clip.resultStorageKey).length, 1);
    assert.deepEqual(selected.draft.director!.source, before.draft.director!.source); assert.deepEqual(selected.draft.director!.boundaries, before.draft.director!.boundaries);
    assert.equal(selected.draft.clipGroups[1].selectedResult?.generationLogId, op.generationLogId);
    assert.throws(() => f.db.applyCanvasProjectOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "restore_h3_output", nodeId: op.nodeId, segmentId: before.draft.clipGroups[1].segmentId, generationLogId: op.generationLogId, storageKey: op.storageKey, settings: {} }]), /正式制作片段/);
});

test("archived H3 video results return to their scene Clips with original task provenance and no new task", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, sourceHash: d.sourceHash, receipt: { ...artifact.receipt, sourceHash: d.sourceHash } }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "prepare-scene-video-targets");
    const targetGroup = prepared.draft.clipGroups.find(group => group.id === "seg1")!;
    const targetNodeId = targetGroup.nodeId!, segmentId = targetGroup.segmentId!;
    const targetNode = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === targetNodeId)!;
    const targetClip = structuredClone(targetNode.metadata.segments.find((segment: any) => segment.id === segmentId));
    assert.ok(targetClip.productionClipProjection);

    const oldNodeId = "archived-h3-before-scene-split", storageKey = "video:restored-scene-result";
    const filePath = path.join(f.directory, "restored-scene-result.mp4"); fs.writeFileSync(filePath, "verified archived video bytes");
    f.db.upsertMediaFile({ storageKey, filePath, mimeType: "video/mp4", bytes: fs.statSync(filePath).size, width: 16, height: 9, durationMs: 5000, createdAt: new Date().toISOString() });
    const task = f.db.createTask("archived-scene-result-task", "comfyui:minimax-h3", { projectId, nodeId: oldNodeId, segmentId }, { model: "fixture" });
    f.db.updateTask(task.id, { status: "succeeded", result: { media: [{ storageKey, mimeType: "video/mp4" }] } });
    const oldLog = f.db.createGenerationLog({ projectId, nodeId: oldNodeId, segmentId, status: "success", platform: "h3", model: "fixture", runtimeTaskId: task.id, references: [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 0, outputs: [{ storageKey, mimeType: "video/mp4" }], params: {} });
    const oldClip = { ...targetClip, status: "success", progress: 1, result: `/media/${encodeURIComponent(storageKey)}`, resultStorageKey: storageKey, results: [{ url: `/media/${encodeURIComponent(storageKey)}`, storageKey, mimeType: "video/mp4" }] };
    let project = f.db.getCanvasProject(projectId)!;
    f.db.applyCanvasProjectOperations(projectId, Number(project.revision), [{
        type: "add_node", id: oldNodeId, nodeType: "minimax-h3:video", title: "H3 Clips（迁移前归档）", position: { x: 3000, y: 0 }, width: 1960, height: 1080,
        metadata: { ...createH3NodeMetadata({}, { segments: [oldClip] }), segments: [oldClip], productionArchiveLabel: "旧版 H3 Clips；保留原视频、结果和任务历史" },
    }]);

    let current = f.episode.get("ep");
    f.episode.edit("ep", { operationId: "bind-published-old-scene-h3", expectedRevision: current.revision, ops: [{ type: "bind_director_segment", targetId: targetGroup.id, nodeId: oldNodeId, segmentId }] });
    const published = publish(f.episode, "ep");
    assert.equal(published.published!.clipGroups.find(group => group.id === targetGroup.id)!.nodeId, oldNodeId);
    current = f.episode.get("ep");
    f.episode.edit("ep", { operationId: "bind-draft-new-scene-h3", expectedRevision: current.revision, ops: [{ type: "bind_director_segment", targetId: targetGroup.id, nodeId: targetNodeId, segmentId }] });
    current = f.episode.get("ep"); project = f.db.getCanvasProject(projectId)!;
    const oldNodeBefore = (project.nodes as any[]).find(node => node.id === oldNodeId), oldClipBefore = structuredClone(oldNodeBefore.metadata.segments[0]);
    const oldTaskBefore = f.db.getTask(task.id);
    const request = { operationId: "restore-archived-scene-results", expectedRevision: current.revision, ops: [{ type: "restore_archived_scene_results", sourceNodeId: oldNodeId, expectedCanvasRevision: Number(project.revision) }] };
    assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
    assert.deepEqual(f.db.getCanvasProject(projectId), project, "restore preflight must not change the canvas");
    const restored = f.episode.edit("ep", request);
    const after = f.db.getCanvasProject(projectId)!, nodes = after.nodes as any[];
    const activeNode = nodes.find(node => node.id === targetNodeId), activeClip = activeNode.metadata.segments.find((segment: any) => segment.id === segmentId);
    const archiveNode = nodes.find(node => node.id === oldNodeId);
    assert.equal(restored.publishedVersion, published.publishedVersion, "restoring draft playback must not republish or rewrite the published mapping");
    assert.equal(activeClip.status, "success"); assert.equal(activeClip.resultStorageKey, storageKey);
    assert.equal(activeClip.archivedResultOrigin.generationLogId, oldLog.id);
    assert.equal(restored.draft.clipGroups.find(group => group.id === targetGroup.id)!.selectedResult?.sourceNodeId, oldNodeId);
    assert.deepEqual(archiveNode.metadata.segments[0], oldClipBefore, "archived source output stays unchanged");
    assert.deepEqual(f.db.getTask(task.id), oldTaskBefore);
    assert.deepEqual(f.db.getGenerationLog(oldLog.id), oldLog);
    assert.equal(f.stores.tasks.list().length, 1, "restoration does not create a generation task");
    assert.equal(f.episode.edit("ep", request).replayed, true);
    assert.deepEqual(f.db.getCanvasProject(projectId), after);
});
function approve(f: ReturnType<typeof fixture>, projectId: string, revision: number) {
    const storageKey = `image:role-${revision}`, filePath = path.join(f.directory, `role-${revision}.png`);
    fs.writeFileSync(filePath, Buffer.from(`reference bytes ${revision}`));
    f.db.upsertMediaFile({ storageKey, filePath, bytes: fs.statSync(filePath).size, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    const project = f.db.getCanvasProject(projectId)!;
    const exists = (project.nodes as any[]).some(node => node.id === "role");
    f.db.applyCanvasProjectOperations(projectId, Number(project.revision), [exists ? { type: "update_node", id: "role", metadata: { storageKey } } : { type: "add_node", id: "role", nodeType: "image", title: "Character", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { storageKey } }]);
    const d = director(); d.assets.ROLE = { nodeId: "role", version: "v1", status: "generated", storageKey, sha256 };
    save(f.shared, projectId, d); const published = publish(f.shared, projectId);
    const current = f.shared.get(projectId);
    const review = { operationId: crypto.randomUUID(), expectedRevision: current.revision, ops: [{ type: "review_director_asset", assetId: "ROLE", nodeId: "role", version: published.publishedVersion, sourceHash: d.sourceHash, storageKey, sha256, verdict: "approved", evidence: "Reviewed exact archived image" }] };
    assert.equal(f.shared.preflight(projectId, { action: "edit", request: review }).valid, true);
    const before = listApprovedSharedAssets(f.db, "drama").length;
    assert.equal(listApprovedSharedAssets(f.db, "drama").length, before, "preflight does not publish shared versions");
    f.shared.edit(projectId, review);
    return listApprovedSharedAssets(f.db, "drama")[0];
}

test("first target preparation creates only the unbound episode canvas and replays its receipt", t => {
    const f = fixture(t); save(f.episode, "ep", director());
    let submitted = 0;
    const runner = new EpisodeProductionRunner(f.episode, f.stores, { start() { submitted++; throw new Error("No generation"); } } as unknown as CanvasGenerationService);
    const revision = f.episode.get("ep").revision;
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
    const prepared = runner.prepareTargets("ep", revision, ["asset:ROLE"], "first-unbound");
    const canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    assert.ok(canvasId); assert.ok(prepared.layoutReceipt);
    const project = structuredClone(f.db.getCanvasProject(canvasId));
    assert.equal(runner.prepareTargets("ep", revision, ["asset:ROLE"], "first-unbound").replayed, true);
    assert.deepEqual(f.db.getCanvasProject(canvasId), project);
    assert.equal(submitted, 0);
    assert.throws(() => runner.prepareTargets("ep", prepared.revision, ["scene:morning"], "first-unbound"), /operationId/);
});

test("first target preparation rejects invalid requests before reserving an operation or creating a canvas", t => {
    const f = fixture(t); save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const revision = f.episode.get("ep").revision;
    for (const [index, targets] of [["ROLE"], ["unknown:ROLE"], ["scene:missing"], ["frame:missing"], ["asset:missing"]].entries()) {
        const operationId = "invalid-unbound-" + index;
        assert.throws(() => runner.prepareTargets("ep", revision, targets, operationId));
        assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get(operationId), undefined);
        assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
    }
    assert.throws(() => runner.prepareTargets("ep", revision - 1, ["asset:ROLE"], "stale-unbound"));
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
});

test("first target preparation recovers an accepted layout failure on the same seeded canvas", t => {
    const f = fixture(t); save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const revision = f.episode.get("ep").revision, original = f.episode.ensureLayoutPlan.bind(f.episode);
    f.episode.ensureLayoutPlan = () => { throw new Error("injected layout failure"); };
    assert.throws(() => runner.prepareTargets("ep", revision, ["asset:ROLE"], "recover-unbound"), /injected/);
    const canvasId = f.db.getDramaEpisode("ep")!.canvasId;
    assert.ok(canvasId);
    f.episode.ensureLayoutPlan = original;
    assert.ok(runner.prepareTargets("ep", revision, ["asset:ROLE"], "recover-unbound").layoutReceipt);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, canvasId);
});

test("first target preparation preserves foreign seeds and refuses missing fixed bindings", t => {
    const f = fixture(t); save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const seedId = "production-episode-" + crypto.createHash("sha256").update("ep").digest("hex").slice(0, 24);
    f.db.createCanvasProject({ id: seedId, title: "User canvas", nodes: [], connections: [] });
    const foreign = structuredClone(f.db.getCanvasProject(seedId));
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "foreign-seed"), /身份冲突/);
    assert.deepEqual(f.db.getCanvasProject(seedId), foreign);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
    f.db.createCanvasProject({ id: "missing-original", title: "Original bound canvas", nodes: [], connections: [] });
    f.db.updateDramaEpisode("ep", { canvasId: "missing-original" });
    const originalGet = f.db.getCanvasProject.bind(f.db);
    f.db.getCanvasProject = id => id === "missing-original" ? null : originalGet(id);
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "missing-fixed"), /恢复原画布/);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("missing-fixed"), undefined);
    assert.deepEqual(f.db.getCanvasProject(seedId), foreign);
});

test("preparation receipt write failure rolls back bindings and nodes before recovering the original operation", t => {
    const f = fixture(t); save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const revision = f.episode.get("ep").revision;
    const prepare = f.db.db.prepare.bind(f.db.db);
    f.db.db.prepare = ((sql: string) => {
        if (sql.startsWith("UPDATE production_preparations SET receipt_json")) throw new Error("injected receipt write failure");
        return prepare(sql);
    }) as typeof f.db.db.prepare;
    assert.throws(() => runner.prepareTargets("ep", revision, ["asset:ROLE"], "atomic-preparation"), /receipt write failure/);
    f.db.db.prepare = prepare;
    assert.equal(f.episode.get("ep").revision, revision);
    const canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    assert.equal((f.db.getCanvasProject(canvasId)!.nodes as any[]).length, 0);
    const recovered = runner.prepareTargets("ep", revision, ["asset:ROLE"], "atomic-preparation");
    assert.ok(recovered.layoutReceipt);
    assert.equal(runner.prepareTargets("ep", revision, ["asset:ROLE"], "atomic-preparation").replayed, true);
});

test("first target preparation rejects shared-scope assets and cross-owner operation reuse before creating a canvas", t => {
    const f = fixture(t), d = director();
    (d.source.asset_plan as any[])[0].canvas_scope = "shared"; d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "shared-unbound"), /共享/);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("shared-unbound"), undefined);
    save(f.episode, "ep2", director());
    runner.prepareTargets("ep2", f.episode.get("ep2").revision, ["asset:ROLE"], "owner-bound-operation");
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "owner-bound-operation"), /operationId/);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
});

test("fixed episode and shared canvases: repeated preparation, ownership, initial binding and protected deletion", t => {
    const f = fixture(t);
    const a = ensureProductionCanvas(f.db, "episode", "ep"), b = ensureProductionCanvas(f.db, "episode", "ep");
    assert.equal(a.project.id, b.project.id); assert.equal(b.created, false);
    const shared = ensureProductionCanvas(f.db, "shared-assets", "drama");
    assert.equal(ensureProductionCanvas(f.db, "shared-assets", "drama").project.id, shared.project.id);
    assert.equal(productionCanvasContext(f.db, a.project.id).owner?.id, "ep");
    assert.equal(productionCanvasContext(f.db, shared.project.id).role, "shared-assets");
    assert.throws(() => f.db.updateDramaEpisode("ep", { canvasId: shared.project.id }), /不允许|已属于|已有/);
    assert.throws(() => f.db.updateDramaEpisode("ep", { canvasId: null }), /不允许/);
    assert.throws(() => f.db.upsertDramaEpisode({ dramaId: "drama", episodeNumber: 1, title: "changed", synopsis: "", canvasId: null }), /不允许/);
    assert.equal(f.db.upsertDramaEpisode({ dramaId: "drama", episodeNumber: 1, title: "changed", synopsis: "" }).canvasId, a.project.id);
    assert.throws(() => f.db.updateDramaEpisode("ep2", { canvasId: shared.project.id }), /其他制作/);
    assert.throws(() => f.db.deleteCanvasProject(a.project.id), /仍绑定/);
    assert.throws(() => f.db.deleteCanvasProject(shared.project.id), /仍绑定/);
    f.db.deleteDramaEpisode("ep"); assert.equal(f.db.deleteCanvasProject(a.project.id), 1);
});

test("target preparation is recoverable, preserves layout, reuses frame IDs, and separates repeat visits to one environment", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    save(f.episode, "ep", director());
    let submissions = 0;
    f.episode.edit("ep", { operationId: "category-models", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "set_settings", patch: { imageModelsByKind: { keyframe: "frame-model" } } }] });
    const runner = new EpisodeProductionRunner(f.episode, f.stores, { start() { submissions++; throw new Error("Must not generate"); } } as unknown as CanvasGenerationService);
    const revision = f.episode.get("ep").revision;
    const prepared = runner.prepareTargets("ep", revision, ["frame:s1", "segment:seg1", "segment:seg2"], "prepare-1");
    const nodes = f.db.getCanvasProject(project.id)!.nodes as any[];
    assert.equal(nodes.filter(node => node.type === "minimax-h3:video").length, 2);
    assert.equal(nodes.filter(node => node.metadata?.productionSceneId === "morning").length, 1);
    assert.equal(nodes.filter(node => node.metadata?.productionSceneId === "night").length, 1);
    assert.notEqual(prepared.draft.clipGroups[0].nodeId, prepared.draft.clipGroups[1].nodeId);
    const frame = nodes.find(node => node.id === prepared.draft.director!.assets.FRAME.nodeId);
    assert.equal(frame.metadata.model, "frame-model");
    f.db.applyCanvasProjectOperations(project.id, Number(f.db.getCanvasProject(project.id)!.revision), [{ type: "update_node", id: frame.id, patch: { position: { x: 123, y: 456 }, width: 222 } }]);
    assert.equal(runner.prepareTargets("ep", revision, ["frame:s1", "segment:seg1", "segment:seg2"], "prepare-1").revision, prepared.revision);
    assert.deepEqual((f.db.getCanvasProject(project.id)!.nodes as any[]).find(node => node.id === frame.id).position, { x: 123, y: 456 });
    assert.equal(submissions, 0); assert.equal(f.episode.get("ep").publishedVersion, 0);
    assert.throws(() => runner.prepareTargets("ep", revision, ["asset:ROLE"], "prepare-1"), /不同.*请求/);
});

test("approved shared versions propagate without a browser and retain historical snapshots; foreign and forged sources are rejected", t => {
    const f = fixture(t), assetCanvas = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const first = approve(f, assetCanvas, 1);
    const episodeCanvas = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    ensureProductionCanvas(f.db, "episode", "ep2");
    const framePath = path.join(f.directory, "existing-frame.png"), frameBytes = Buffer.from("existing frame bytes");
    fs.writeFileSync(framePath, frameBytes);
    const frameStorageKey = "image:existing-frame", frameHash = crypto.createHash("sha256").update(frameBytes).digest("hex");
    f.db.upsertMediaFile({ storageKey: frameStorageKey, filePath: framePath, bytes: frameBytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations(episodeCanvas, Number(f.db.getCanvasProject(episodeCanvas)!.revision), [
        { type: "add_node", id: "existing-role", nodeType: "image", title: "Existing character", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { storageKey: first.storageKey } },
        { type: "add_node", id: "existing-frame", nodeType: "image", title: "Existing frame", position: { x: 400, y: 0 }, width: 300, height: 300, metadata: { storageKey: frameStorageKey } },
    ]);
    const episodeDirector = director();
    episodeDirector.assets.ROLE = { nodeId: "existing-role", version: "v1", storageKey: first.storageKey, sha256: first.sha256, status: "approved", evidence: "Existing image reviewed before shared adoption" };
    episodeDirector.assets.FRAME = { nodeId: "existing-frame", version: "v1", storageKey: frameStorageKey, sha256: frameHash, status: "approved", evidence: "Existing frame" };
    save(f.episode, "ep", episodeDirector); save(f.episode, "ep2", director());
    assert.equal((f.db.getCanvasProject(episodeCanvas)!.nodes as any[]).some(node => node.id === sharedProjectionNodeId("ep", "ROLE")), false);
    const adopted = f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: first.id, expectedRevision: f.episode.get("ep").revision, operationId: "adopt-1" });
    const adoptedNode = adopted.draft.director!.assets.ROLE.nodeId!;
    const adoptedCanvas = f.db.getCanvasProject(episodeCanvas)!;
    const adoptedLayoutUnit = f.db.getProductionLayoutPlan(episodeCanvas)!.units.find(unit => unit.targets.includes("asset:ROLE"))!;
    const adoptedMember = adoptedLayoutUnit.members.find(member => member.nodeId === adoptedNode)!;
    const adoptedCanvasNode = (adoptedCanvas.nodes as any[]).find(node => node.id === adoptedNode);
    assert.deepEqual(adoptedCanvasNode.position, adoptedMember.position);
    assert.equal(adoptedCanvasNode.metadata.productionLayoutUnitId, adoptedLayoutUnit.id);
    const historical = structuredClone(adopted.draft.director!.assets.ROLE);
    assert.equal((adopted.draft.director!.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope, "shared");
    assert.equal(adopted.draft.director!.assets.FRAME.inputOutdated, undefined, "unchanged media stays usable when ownership is adopted");
    assert.equal(adopted.draft.director!.artifacts.every(item => item.status === "stale"), true);
    assert.equal(f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: first.id, expectedRevision: 1, operationId: "adopt-1" }).replayed, true);
    assert.throws(() => f.db.applyCanvasProjectOperations(episodeCanvas, Number(f.db.getCanvasProject(episodeCanvas)!.revision), [{ type: "update_node", id: adoptedNode, metadata: { storageKey: "image:forged" } }]), /共享引用内容/);
    let compiled = 0;
    const compiler = ((d: DirectorProduction) => {
        compiled++; const next = structuredClone(d); next.sourceHash = directorHash(next.source);
        for (const artifact of next.artifacts) { artifact.status = "ready"; artifact.sourceHash = next.sourceHash; artifact.receipt.sourceHash = next.sourceHash; if (artifact.targetId === "FRAME" || artifact.kind === "h3") artifact.references = [{ label: "<Picture 1>", nodeId: next.assets.ROLE.nodeId!, storageKey: next.assets.ROLE.storageKey!, sha256: next.assets.ROLE.sha256!, role: "character_identity" }]; }
        return { director: next, diagnostics: [], audit: {}, sourceAdjustments: [] };
    }) as unknown as typeof compileAchengDirector;
    const coordinator = new SharedAssetCoordinator(f.db, f.episode, f.events, undefined, compiler);
    coordinator.drain();
    assert.equal(f.episode.get("ep").draft.director!.assets.FRAME.inputOutdated, undefined, "unchanged media remains valid after reference recompilation");
    const second = approve(f, assetCanvas, 2);
    assert.notEqual(second.id, first.id); assert.equal(historical.storageKey, first.storageKey);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM drama_asset_adoptions WHERE status='pending'").get()?.count, 1);
    coordinator.drain();
    const current = f.episode.get("ep");
    assert.equal(current.draft.director!.assets.ROLE.sharedSource?.approvedId, second.id);
    assert.equal(current.draft.director!.assets.ROLE.nodeId, adoptedNode);
    assert.equal(current.draft.director!.assets.FRAME.inputOutdated, true, "a changed shared media version invalidates dependent media");
    const adoption = f.db.db.prepare("SELECT status, error FROM drama_asset_adoptions WHERE approved_id=?").get(second.id);
    assert.equal(adoption?.status, "applied", String(adoption?.error || ""));
    assert.equal(compiled, 2); assert.equal(f.episode.get("ep2").draft.director!.assets.ROLE.status, "planned");
    assert.equal(JSON.parse(String(f.db.db.prepare("SELECT snapshot_json FROM drama_asset_versions WHERE id=?").get(first.id)?.snapshot_json)).content, first.storageKey);
    assert.throws(() => validateSharedAssetSource(f.db, episodeCanvas, { ...current.draft.director!.assets.ROLE, sharedSource: { ...current.draft.director!.assets.ROLE.sharedSource!, dramaId: "foreign" } }), /剧目.*不一致/);
    fs.writeFileSync(path.join(f.directory, "role-2.png"), "changed bytes");
    assert.throws(() => validateSharedAssetSource(f.db, episodeCanvas, current.draft.director!.assets.ROLE), /摘要/);
});

test("promoting an already reviewed episode asset preserves its source and adds a provenance-backed shared approval", t => {
    const f = fixture(t), sourceCanvas = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const filePath = path.join(f.directory, "promoted-role.png"), bytes = Buffer.from("previously reviewed role image");
    fs.writeFileSync(filePath, bytes);
    const storageKey = "image:promoted-role", sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    f.db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations(sourceCanvas, Number(f.db.getCanvasProject(sourceCanvas)!.revision), [{ type: "add_node", id: "episode-role", nodeType: "image", title: "Character", position: { x: 80, y: 120 }, width: 300, height: 300, metadata: { storageKey } }]);
    const d = director();
    (d.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope = "shared";
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, status: "stale" }));
    d.assets.ROLE = { nodeId: "episode-role", version: "v8", storageKey, sha256, status: "generated", selectedResult: { taskId: "original-image-task" } };
    save(f.episode, "ep", d);
    const published = publish(f.episode, "ep");
    const reviewed = f.episode.edit("ep", { operationId: "review-before-promotion", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "review_director_asset",
        assetId: "ROLE", version: published.publishedVersion, sourceHash: d.sourceHash, nodeId: "episode-role", storageKey, sha256, verdict: "approved", evidence: "Reviewed the original archived character image" }] });
    const originalNodeBefore = structuredClone((f.db.getCanvasProject(sourceCanvas)!.nodes as any[]).find(node => node.id === "episode-role"));
    const preview = f.episode.previewSharedAssetPromotion("ep", "ROLE", reviewed.revision);
    assert.equal(preview.storageKey, storageKey); assert.equal(preview.sha256, sha256); assert.equal(preview.sharedCanvasId, null);
    assert.equal(preview.sourceGenerationTaskId, "original-image-task");
    const promoted = f.episode.promoteExistingSharedAsset("ep", { assetId: "ROLE", expectedRevision: reviewed.revision, expectedSourceCanvasRevision: preview.sourceCanvasRevision,
        expectedSharedCanvasRevision: preview.sharedCanvasRevision, operationId: "promote-role" });
    assert.equal(promoted.replayed, false);
    const sharedProject = f.db.getCanvasProject(promoted.canvasId!)!;
    const importedNode = (sharedProject.nodes as any[]).find(node => node.id === promoted.nodeId);
    assert.equal(importedNode.metadata.storageKey, storageKey);
    assert.deepEqual(importedNode.metadata.sharedPromotionOrigin, { episodeId: "ep", sourceCanvasId: sourceCanvas, sourceNodeId: "episode-role", sourceVersion: published.publishedVersion,
        sourceGenerationTaskId: "original-image-task", sourceStorageKey: storageKey, sourceSha256: sha256 });
    assert.throws(() => f.db.applyCanvasProjectOperations(promoted.canvasId!, Number(sharedProject.revision), [{ type: "update_node", id: promoted.nodeId, metadata: { sharedPromotionOrigin: {} } }]), /接入来源由 Backend 登记/);
    const approved = listApprovedSharedAssets(f.db, "drama").find(asset => asset.assetId === "ROLE")!;
    assert.equal(approved.storageKey, storageKey); assert.equal(approved.sha256, sha256);
    assert.equal(approved.snapshot.metadata.sharedPromotionOrigin.sourceNodeId, "episode-role");
    assert.deepEqual((f.db.getCanvasProject(sourceCanvas)!.nodes as any[]).find(node => node.id === "episode-role"), originalNodeBefore);
    assert.equal(f.episode.promoteExistingSharedAsset("ep", { assetId: "ROLE", expectedRevision: reviewed.revision, expectedSourceCanvasRevision: preview.sourceCanvasRevision,
        expectedSharedCanvasRevision: preview.sharedCanvasRevision, operationId: "promote-role" }).replayed, true);
    approve(f, promoted.canvasId!, 2);
    assert.throws(() => f.episode.previewSharedAssetPromotion("ep", "ROLE", reviewed.revision), /其他媒体版本/);
});

test("shared adoption conflicts preserve edits and can be resumed after explicit review", t => {
    const f = fixture(t), assetCanvas = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const first = approve(f, assetCanvas, 1); ensureProductionCanvas(f.db, "episode", "ep"); save(f.episode, "ep", director());
    f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: first.id, expectedRevision: f.episode.get("ep").revision, operationId: "adopt" });
    const second = approve(f, assetCanvas, 2);
    f.episode.edit("ep", { operationId: "user-edit", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "set_director_brief", brief: "Preserve this user edit" }] });
    new SharedAssetCoordinator(f.db, f.episode, f.events).drain();
    const update = f.episode.sharedAssets("ep").updates[0] as any;
    assert.equal(update.status, "blocked"); assert.match(update.error, /并发编辑/);
    assert.equal(f.episode.get("ep").draft.director!.source.brief, "Preserve this user edit");
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.sharedSource?.approvedId, first.id);
    f.episode.retrySharedUpdate("ep", update.id, f.episode.get("ep").revision);
    const resumed = f.db.db.prepare("SELECT status, approved_id FROM drama_asset_adoptions WHERE id=?").get(update.id);
    assert.equal(resumed?.status, "pending"); assert.equal(resumed?.approved_id, second.id);
});

test("a completed old task binds only its original publication after a shared-input publication advances", t => {
    const f = fixture(t), canvasId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["frame:s1"], "prepare-frame");
    const first = publish(f.episode, "ep"), frameId = first.published!.director!.assets.FRAME.nodeId!;
    const makeMedia = (id: string) => {
        const filePath = path.join(f.directory, `${id}.png`); fs.writeFileSync(filePath, id);
        f.db.upsertMediaFile({ storageKey: `image:${id}`, filePath, bytes: id.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        f.db.applyCanvasProjectOperations(canvasId, Number(f.db.getCanvasProject(canvasId)!.revision), [{ type: "update_node", id: frameId, metadata: { storageKey: `image:${id}` } }], { runtimeWrite: true });
        return `image:${id}`;
    };
    const firstKey = makeMedia("first");
    f.episode.bindRuntime("ep", first.publishedVersion, { shotId: "s1", nodeId: frameId, storageKey: firstKey });
    const second = publish(f.episode, "ep");
    const frozen = structuredClone(second.published);
    const lateKey = makeMedia("late-old-task");
    f.episode.bindRuntime("ep", first.publishedVersion, { shotId: "s1", nodeId: frameId, storageKey: lateKey });
    assert.deepEqual(f.episode.get("ep").published, frozen);
    assert.equal(f.episode.version("ep", first.publishedVersion).snapshot.keyframes.s1.storageKey, lateKey);
    assert.equal(f.episode.get("ep").publishedVersion, second.publishedVersion);
});

test("adoption work survives a new database connection and failed compilation preserves its installed source", t => {
    const f = fixture(t), assetCanvas = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const approved = approve(f, assetCanvas, 1); ensureProductionCanvas(f.db, "episode", "ep"); save(f.episode, "ep", director());
    f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: approved.id, expectedRevision: f.episode.get("ep").revision, operationId: "durable-adopt" });
    const reopened = new BackendDatabase(f.file);
    try {
        const service = new EpisodeProductionService(reopened, f.events, f.directory, false, () => {});
        const compiler = (() => { throw new Error("Pinned compiler unavailable"); }) as unknown as typeof compileAchengDirector;
        new SharedAssetCoordinator(reopened, service, f.events, undefined, compiler).drain();
        const job = service.sharedAssets("ep").updates[0] as any;
        assert.equal(job.status, "blocked"); assert.match(job.error, /Pinned compiler unavailable/);
        assert.equal(service.get("ep").draft.director!.assets.ROLE.sharedSource?.approvedId, approved.id);
        assert.equal(service.get("ep").publishedVersion, 0);
        service.retrySharedUpdate("ep", job.id, service.get("ep").revision);
        assert.equal(reopened.db.prepare("SELECT status FROM drama_asset_adoptions WHERE id=?").get(job.id)?.status, "compiling");
    } finally { reopened.close(); }
});

test("native image controls use the original node and expose an exact task for production review", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "prepare-native");
    const published = publish(f.episode, "ep"), nodeId = published.published!.director!.assets.ROLE.nodeId!;
    const observer = new NativeProductionGeneration(f.db, f.stores, f.episode, f.shared, f.events);
    const prepared = observer.prepare({ mode: "image", projectId, nodeId, prompt: published.published!.director!.artifacts.find(artifact => artifact.targetId === "ROLE")!.prompt, model: "fixture" });
    assert.equal(prepared.command.params?.writeBackToTarget, true);
    assert.throws(() => observer.prepare({ ...prepared.command, prompt: "uncompiled edit" }), /正式图像产物/);
    const task = f.stores.tasks.create("native-task", "canvas-image", { projectId, nodeId }, { canvasBinding: { projectId, nodeId } });
    const unsubscribe = observer.start();
    observer.submitted(task.id, prepared.context);
    assert.equal(f.episode.get("ep").draft.director?.workflow.currentWork?.taskId, task.id);
    assert.equal(f.episode.workflowReadiness("ep").presentation?.taskId, task.id);
    const filePath = path.join(f.directory, "native.png"); fs.writeFileSync(filePath, "native bytes");
    f.db.upsertMediaFile({ storageKey: "image:native", filePath, bytes: 12, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [{ type: "update_node", id: nodeId, metadata: { storageKey: "image:native" } }], { runtimeWrite: true });
    f.stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey: "image:native" }] } });
    f.events.publish({ type: "task.updated", entityId: task.id, payload: { status: "succeeded" } });
    assert.equal(f.episode.get("ep").published!.director!.assets.ROLE.status, "generated");
    assert.equal(f.episode.get("ep").published!.director!.assets.ROLE.storageKey, "image:native");
    assert.equal(f.episode.workflowReadiness("ep").presentation?.status, "needs_review");
    assert.equal(f.db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(task.id)?.status, "bound");
    unsubscribe();
});

test("native H3 tracking follows the active Clip while a pending decision keeps presentation priority", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "sequence", scene_id: "room", scene_name: "Sequence", text: "Both shots share this scene", beat_ids: ["b1", "b2"] }];
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source); d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const clipReady = runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "prepare-h3");
    assert.equal(clipReady.referenceSync?.[0].status, "ready", JSON.stringify(clipReady.referenceSync));
    const preparedGroup = clipReady.draft.clipGroups[0];
    const storedClip = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === preparedGroup.nodeId).metadata.segments.find((clip: any) => clip.id === preparedGroup.segmentId);
    assert.ok(storedClip.productionClipProjection);
    assert.equal(storedClip.productionClipProjection.inputHash, clipInputHash(storedClip), JSON.stringify(clipReady.referenceSync));
    const current = publish(f.episode, "ep"), groups = current.published!.clipGroups;
    const nodeId = groups[0].nodeId!, first = groups[0].segmentId!, second = groups[1].segmentId!;
    f.stores.projects.applyOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [{ type: "update_h3_segment", nodeId, segmentId: first, patch: { prompt: "integrated_multimodal_description:\nManual Clip edit.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A" } }], { operationId: "native-manual-prompt" });
    const observer = new NativeProductionGeneration(f.db, f.stores, f.episode, f.shared, f.events);
    const prepared = observer.prepare({ mode: "video", operation: "h3-run", projectId, nodeId, segmentId: first, runFromCurrent: true, endSegmentId: second });
    const task = f.stores.tasks.create("native-h3", "canvas-h3", { projectId, nodeId, segmentId: first }, { canvasBinding: { projectId, nodeId, segmentId: first } });
    observer.submitted(task.id, prepared.context);
    f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [
        { type: "update_h3_segment", nodeId, segmentId: first, patch: { status: "success", parentTaskId: task.id } },
        { type: "update_h3_segment", nodeId, segmentId: second, patch: { status: "loading", parentTaskId: task.id } },
    ], { runtimeWrite: true });
    const presentation = f.episode.workflowReadiness("ep").presentation!;
    assert.equal(presentation.taskId, task.id); assert.equal(presentation.segmentId, second); assert.equal(presentation.targetId, "seg2");
    const decisionInput = f.episode.get("ep");
    const work = decisionInput.draft.director!.workflow.currentWork!;
    f.episode.edit("ep", { operationId: "pending-decision", expectedRevision: decisionInput.revision, ops: [{ type: "set_director_workflow", patch: {
        pendingDecisions: [{ id: "identity-choice", workId: work.workId, module: "assets", targetKind: "asset", targetId: "ROLE", prompt: "Choose the identity reference", choices: ["Keep", "Replace"], sourceHash: decisionInput.draft.director!.sourceHash, sourceRevision: decisionInput.revision, status: "pending" }],
    } }] });
    const decisionPresentation = f.episode.workflowReadiness("ep").presentation!;
    assert.equal(decisionPresentation.targetId, "ROLE"); assert.equal(decisionPresentation.action, "author");
    assert.equal(decisionPresentation.taskId, undefined, "the active native task must not take focus from a formal decision");
});

test("each formal scene owns one H3 node and keeps its scripts, frames and clips in the same area", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "scene-h3-layout");
    const groups = prepared.draft.clipGroups;
    assert.notEqual(groups[0].nodeId, groups[1].nodeId, "two scene occurrences sharing one environment still need separate H3 nodes");
    const nodes = f.db.getCanvasProject(projectId)!.nodes as any[];
    const scenes = new Map(["morning", "night"].map(sceneId => [sceneId, nodes.find(node => node.metadata?.productionSceneId === sceneId)]));
    for (const [index, sceneId] of ["morning", "night"].entries()) {
        const group = scenes.get(sceneId)!;
        const h3 = nodes.find(node => node.id === groups[index].nodeId);
        assert.ok(group, `scene group ${sceneId} is materialized`);
        assert.equal(h3.metadata.groupId, group.id);
        assert.ok(h3.position.x >= group.position.x && h3.position.y >= group.position.y);
        assert.ok(h3.position.x + h3.width <= group.position.x + group.width);
        assert.ok(h3.position.y + h3.height <= group.position.y + group.height);
        assert.match(h3.title, sceneId === "morning" ? /Morning/ : /Night/);
        const script = nodes.find(node => node.metadata?.productionScriptId === sceneId);
        assert.equal(script.metadata.groupId, group.id);
        assert.ok(script.position.x >= group.position.x && script.position.y >= group.position.y);
    }
    assert.equal(f.stores.tasks.list().length, 0, "scene H3 layout preparation must not generate media");
});

test("scene H3 preparation inherits saved layout and preserves materialized and reserved geometry", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    f.db.setSetting("plugin:minimax-h3:defaults:v1", { layout: { width: 3572.6, height: 2145, panes: { minimaxPreviewH: 1303 } } });
    save(f.episode, "ep", director());
    const reserved = f.episode.ensureLayoutPlan("ep");
    f.db.setSetting("plugin:minimax-h3:defaults:v1", { layout: { width: 4200, height: 2800 } });
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "scene-h3-layout");
    const groups = prepared.draft.clipGroups;
    assert.notEqual(groups[0].nodeId, groups[1].nodeId, "two scene occurrences sharing one environment still need separate H3 nodes");
    const nodes = f.db.getCanvasProject(projectId)!.nodes as any[];
    const scenes = new Map(["morning", "night"].map(sceneId => [sceneId, nodes.find(node => node.metadata?.productionSceneId === sceneId)]));
    for (const [index, sceneId] of ["morning", "night"].entries()) {
        const group = scenes.get(sceneId)!;
        const h3 = nodes.find(node => node.id === groups[index].nodeId);
        assert.equal(h3.width, 3573);
        assert.equal(h3.height, 2145);
        assert.ok(group, `scene group ${sceneId} is materialized`);
        assert.equal(h3.metadata.groupId, group.id);
        assert.ok(h3.position.x >= group.position.x && h3.position.y >= group.position.y);
        assert.ok(h3.position.x + h3.width <= group.position.x + group.width);
        assert.ok(h3.position.y + h3.height <= group.position.y + group.height);
        assert.match(h3.title, sceneId === "morning" ? /Morning/ : /Night/);
        const script = nodes.find(node => node.metadata?.productionScriptId === sceneId);
        assert.equal(script.metadata.groupId, group.id);
        assert.ok(script.position.x >= group.position.x && script.position.y >= group.position.y);
    }
    const recompiled = f.episode.ensureLayoutPlan("ep");
    for (const unit of reserved.units.filter(unit => unit.area === "video")) {
        assert.deepEqual(recompiled.units.find(item => item.id === unit.id)!.members, unit.members);
    }
    assert.equal(f.stores.tasks.list().length, 0, "scene H3 layout preparation must not generate media");
});

test("Clip synchronization also assigns unbound segments to their scene H3 nodes", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    save(f.episode, "ep", d);
    const published = publish(f.episode, "ep"), runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.syncClips("ep", published.publishedVersion);
    const synced = f.episode.get("ep").published!.clipGroups;
    assert.notEqual(synced[0].nodeId, synced[1].nodeId);
    const nodes = f.db.getCanvasProject(projectId)!.nodes as any[];
    for (const group of synced) {
        const sceneId = group.id === "seg1" ? "morning" : "night";
        const sceneGroup = nodes.find(item => item.metadata?.productionSceneId === sceneId);
        const node = nodes.find(item => item.id === group.nodeId);
        const expectedGroupId = `production-scene-${crypto.createHash("sha256").update(`ep\0${sceneId}`).digest("hex").slice(0, 24)}`;
        assert.ok(sceneGroup);
        assert.equal(node.metadata.groupId, expectedGroupId);
        assert.equal(node.metadata.groupId, sceneGroup.id);
    }
});

test("new Segment preparation rejects a scene-spanning clip until it is split", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    (d.source.segments as any[])[0].shot_ids = ["s1", "s2"];
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const readiness = f.episode.workflowReadiness("ep").targets.find(target => target.id === "segment:seg1")!;
    assert.match(readiness.blockers.join("; "), /跨越多个正式场次/);
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "cross-scene-segment"), /跨越多个场次/);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("cross-scene-segment"), undefined);
    assert.ok(f.db.getCanvasProject(projectId));
});


test("version 23 installations gain layout plans, preparation receipts and native bindings without rewriting shared versions", t => {
    const f = fixture(t), sharedId = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const approved = approve(f, sharedId, 1);
    f.db.db.exec("DELETE FROM schema_migrations WHERE version>=24; DROP TABLE production_preparations; DROP TABLE production_task_bindings; ALTER TABLE drama_projects DROP COLUMN production_plan_json");
    const upgraded = new BackendDatabase(f.file);
    try {
        assert.equal(upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 32);
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_preparations'").get());
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_task_bindings'").get());
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_layout_plans'").get());
        assert.equal(listApprovedSharedAssets(upgraded, "drama")[0].id, approved.id);
        assert.equal(upgraded.listCanvasFolders().find(folder => folder.id === "drama")?.sharedAssetCanvasId, sharedId);
        assert.ok(fs.readdirSync(f.directory).some(name => name.includes('pre-schema-v23-to-v32')));
    } finally { upgraded.close(); }
});


test("asset preparation uses a compact zone and repeat preparation preserves manually moved nodes", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = Array.from({ length: 12 }, (_, i) => ({ id: `block-${i}`, scene_id: "room", scene_name: `Scene ${i}`, text: `Script ${i}`, beat_ids: [`b${i}`] }));
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "compact-asset");
    const nodeId = f.episode.get("ep").draft.director!.assets.ROLE.nodeId;
    const node = () => (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === nodeId);
    assert.deepEqual(node().position, f.db.getProductionLayoutPlan(projectId)!.units.find(unit => unit.id === "asset:ROLE")!.members[0].position);
    f.db.applyCanvasProjectOperations(projectId, undefined, [{ type: "update_node", id: nodeId, patch: { position: { x: 200, y: 100 }, width: 480 } }]);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "compact-asset-again");
    assert.deepEqual(node().position, { x: 200, y: 100 });
    assert.equal(node().width, 480);
    assert.equal((f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.id === nodeId).length, 1);
});


test("scene arrangement fits resized images and attached prompts and replays without moving other scenes", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["frame:s1"], "layout-frame");
    const project = f.db.getCanvasProject(projectId)!, frame = (project.nodes as any[]).find(node => node.metadata?.productionShotId === "s1");
    f.db.applyCanvasProjectOperations(projectId, undefined, [{ type: "update_node", id: frame.id, patch: { width: 900, height: 900 } }, { type: "add_node", id: "frame-prompt", nodeType: "config", width: 520, height: 300, metadata: { prompt: "keep this prompt", productionShotId: "s1", groupId: frame.metadata.groupId } }]);
    const otherScripts = (f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId && node.metadata?.productionScriptSceneId !== "morning").map(node => [node.id, node.position]);
    const revision = f.episode.get("ep").revision;
    runner.arrangeScene("ep", "morning", revision, "layout-arrange");
    const after = f.db.getCanvasProject(projectId)!, nodes = after.nodes as any[], image = nodes.find(node => node.id === frame.id), prompt = nodes.find(node => node.id === "frame-prompt"), group = nodes.find(node => node.id === frame.metadata.groupId);
    assert.equal(prompt.position.x, image.position.x);
    assert.ok(prompt.position.y >= image.position.y + image.height + 60);
    assert.ok(prompt.position.y + prompt.height <= group.position.y + group.height);
    assert.ok(image.position.x + image.width <= group.position.x + group.width);
    assert.equal(prompt.metadata.prompt, "keep this prompt");
    assert.deepEqual(nodes.filter(node => node.metadata?.productionScriptId && node.metadata?.productionScriptSceneId !== "morning").map(node => [node.id, node.position]), otherScripts);
    runner.arrangeScene("ep", "morning", revision, "layout-arrange");
    assert.equal(f.db.getCanvasProject(projectId)!.revision, after.revision);
});

test("whole-plan layout stays stable when formal targets are prepared in different orders", async t => {
    const scenarios: Array<{ order: string[]; nodes: Record<string, { x: number; y: number }> }> = [];
    for (const [index, order] of [["asset-first", ["asset:ROLE", "frame:s1"]], ["frame-first", ["frame:s1", "asset:ROLE"]]] as Array<[string, string[]]>) {
        const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
        const d = director();
        d.source.script_scenes = [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "Morning".repeat(400), beat_ids: ["b1"] }, { id: "night", scene_id: "room", scene_name: "Night", text: "Night".repeat(400), beat_ids: ["b2"] }];
        d.sourceHash = directorHash(d.source);
        d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
        save(f.episode, "ep", d);
        const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
        for (const [step, target] of order.entries()) {
            const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, [target], `${index}:${step}:${target}`);
            assert.ok(prepared.layoutReceipt?.planHash);
            assert.ok(prepared.layoutReceipt?.algorithmVersion);
            assert.ok(prepared.layoutReceipt!.canvasRevision >= 0);
        }
        const layout = f.db.getProductionLayoutPlan(projectId)!;
        const role = f.episode.get("ep").draft.director!.assets.ROLE.nodeId!;
        const frame = f.episode.get("ep").draft.director!.assets.FRAME.nodeId!;
        assert.ok(layout.units.some(unit => unit.id === "keyframe-asset:FRAME" && unit.targets.includes("frame:s1") && unit.members.some(member => member.role === "keyframe")));
        assert.ok(layout.units.some(unit => unit.id === "frame-prompt:s1" && unit.members.some(member => member.role === "prompt")));
        const roleNode = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === role);
        const frameNode = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === frame);
        assert.ok(roleNode.metadata.productionLayoutUnitId);
        assert.ok(frameNode.metadata.productionLayoutUnitId);
        scenarios.push({ order, nodes: { ROLE: roleNode.position, FRAME: frameNode.position } });
        assert.equal(f.stores.tasks.list().length, 0, "layout preparation must not submit media");
    }
    assert.deepEqual(scenarios[0].nodes, scenarios[1].nodes);
});

test("scene preparation receipts include its projected script units", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "New script projection", beat_ids: ["b1"] }];
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, ["scene:morning"], "prepare-scene-receipt");
    const projected = (f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId);
    assert.ok(projected.length > 0);
    assert.ok([...prepared.layoutReceipt!.created, ...prepared.layoutReceipt!.reused].some(item => item.target === "scene:morning" && projected.some(node => item.nodeIds.includes(node.id))));
});

function referenceClipFixture(t: test.TestContext) {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const file = path.join(f.directory, "approved.png"); fs.writeFileSync(file, "approved identity");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    f.db.upsertMediaFile({ storageKey: "approved.png", filePath: file, mimeType: "image/png", bytes: 17, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.stores.projects.applyOperations(projectId, 0, [{ type: "add_node", id: "identity", nodeType: "image", metadata: { storageKey: "approved.png" } }], { runtimeWrite: true });
    const d = director(); d.assets.ROLE = { nodeId: "identity", storageKey: "approved.png", sha256, version: "v1", status: "approved", evidence: "Reviewed identity" };
    Object.values(d.shotInputs).forEach(input => { input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    (d.source.segments as any[])[0].mode = "I2VA";
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    const artifact = d.artifacts.find(a => a.targetId === "seg1")!;
    artifact.prompt = artifact.prompt.replace("Complete seg1", "<Picture 1> Complete seg1"); artifact.sha256 = promptHash(artifact.prompt); artifact.receipt.promptHash = artifact.sha256;
    artifact.references = [{ label: "<Picture 1>", nodeId: "identity", storageKey: "approved.png", sha256, role: "reference" }];
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    return { ...f, projectId, runner, d, file };
}
test("first and repeated Clip preparation persist approved references and identical frozen receipts", t => {
    const f = referenceClipFixture(t), revision = f.episode.get("ep").revision;
    const first = f.runner.prepareTargets("ep", revision, ["segment:seg1"], "reference-first");
    assert.equal(first.referenceSync?.[0].status, "ready", JSON.stringify(first.referenceSync));
    assert.equal(first.referenceSync?.[0].referenceCount, 1);
    const group = first.draft.clipGroups.find(group => group.id === "seg1")!;
    const read = () => (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.equal(read().referenceBindings[0].storageKey, "approved.png");
    assert.equal(read().productionClipProjection.inputHash, clipInputHash(read()));
    assert.deepEqual(f.runner.prepareTargets("ep", revision, ["segment:seg1"], "reference-first").referenceSync, first.referenceSync);
    assert.equal(f.runner.prepareTargets("ep", first.revision, ["segment:seg1"], "reference-again").referenceSync?.[0].status, "ready");
    const canvas = f.db.getCanvasProject(f.projectId)!;
    const projection = structuredClone(read().productionClipProjection);
    const edit = f.stores.projects.applyOperations(f.projectId, Number(canvas.revision), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { prompt: "hand rewritten" } }], { operationId: "manual-edit" });
    assert.equal(read().prompt, "hand rewritten");
    assert.deepEqual(read().productionClipProjection, projection);
    assert.equal(edit.revision, Number(canvas.revision) + 1);
    const prepared = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "preserve-manual-edit");
    assert.equal(prepared.referenceSync?.[0].status, "blocked");
    assert.match(JSON.stringify(prepared.referenceSync), /CLIP_EDIT_CONFLICT/);
    assert.equal(read().prompt, "hand rewritten", "recompilation must retain the edited Clip prompt");
});
test("unapproved references remain explicitly blocked and applying a new compiled input repairs an existing Clip", t => {
    const f = referenceClipFixture(t);
    const candidate = structuredClone(f.d); candidate.assets.ROLE.status = "generated";
    save(f.episode, "ep", candidate);
    const draft = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "reference-blocked");
    assert.equal(draft.referenceSync?.[0].status, "blocked");
    const group = draft.draft.clipGroups.find(group => group.id === "seg1")!;
    const read = () => (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.deepEqual(read().referenceBindings, []);
    candidate.assets.ROLE.status = "approved"; save(f.episode, "ep", candidate);
    assert.equal(read().referenceBindings.length, 1, "compilation/source apply projects existing Clip in the same transaction");
    const before = structuredClone(read());
    f.stores.projects.applyOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { status: "running" } }], { runtimeWrite: true });
    const busy = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "reference-busy");
    assert.equal(busy.referenceSync?.[0].status, "blocked"); assert.equal(read().prompt, before.prompt);
    assert.deepEqual(read().referenceBindings, before.referenceBindings);
});
test("a late invalid node or H3 field rolls back a mixed batch and its revision", t => {
    const f = referenceClipFixture(t); const project = f.db.getCanvasProject(f.projectId)!;
    assert.throws(() => f.stores.projects.applyOperations(f.projectId, Number(project.revision), [
        { type: "update_node", id: "identity", patch: { title: "must roll back" } },
        { type: "update_node", id: "identity", patch: { widht: 100 } },
    ], { operationId: "late-invalid" }));
    assert.equal(f.db.getCanvasProject(f.projectId)!.revision, project.revision);
    assert.deepEqual(f.db.getCanvasProject(f.projectId)!.nodes, project.nodes);
});

test("manual Clip conflicts preserve edits and can be reconciled through the authored source", t => {
    const f = referenceClipFixture(t);
    const prepared = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "conflict-prepare");
    const group = prepared.draft.clipGroups.find(group => group.id === "seg1")!;
    f.stores.projects.applyOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { title: "Reviewed entrance" } }], { operationId: "manual-title" });
    const blocked = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "conflict-read");
    assert.equal(blocked.referenceSync?.[0].status, "blocked");
    const candidate = structuredClone(f.episode.get("ep").draft.director!);
    (candidate.source.shots as any[])[0].title = "Reviewed entrance"; candidate.sourceHash = directorHash(candidate.source);
    candidate.artifacts.forEach(a => { a.sourceHash = candidate.sourceHash; a.receipt.sourceHash = candidate.sourceHash; });
    save(f.episode, "ep", candidate);
    const ready = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "conflict-resolved");
    assert.equal(ready.referenceSync?.[0].status, "ready", JSON.stringify(ready.referenceSync));
});

test("adopt user soft-light preserves canonical prompt bytes and survives formal Clip projection", t => {
    const f = referenceClipFixture(t);
    const prepared = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "style-prepare");
    const group = prepared.draft.clipGroups.find(group => group.id === "seg1")!;
    const prompt = prepared.draft.director!.artifacts.find(artifact => artifact.targetId === "seg1")!.prompt;
    f.stores.projects.applyOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { styleTemplateId: "soft-light" } }], { operationId: "manual-soft-light" });
    const request = { operationId: "adopt-soft-light", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "adopt_director_clip_style", targetId: "seg1", nodeId: group.nodeId!, segmentId: group.segmentId!, canvasRevision: Number(f.db.getCanvasProject(f.projectId)!.revision), styleTemplateId: "soft-light" }] };
    assert.throws(() => f.episode.edit("ep", { ...request, operationId: "stale-adopt", ops: [{ ...request.ops[0], canvasRevision: request.ops[0].canvasRevision - 1 }] }), /画布版本/);
    const adopted = f.episode.edit("ep", request);
    assert.equal((adopted.draft.director!.source.segments as any[])[0].styleTemplateId, "soft-light");
    assert.equal(adopted.draft.director!.artifacts.find(artifact => artifact.targetId === "seg1")!.prompt, prompt);
    assert.equal(f.episode.edit("ep", request).replayed, true);
    const compiled = structuredClone(adopted.draft.director!);
    compiled.artifacts.forEach(artifact => { artifact.status = "ready"; artifact.sourceHash = compiled.sourceHash; artifact.receipt.sourceHash = compiled.sourceHash; });
    save(f.episode, "ep", compiled);
    const ready = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "style-sync");
    assert.equal(ready.referenceSync?.find(sync => sync.targetId === "seg1")?.status, "ready", JSON.stringify(ready.referenceSync));
    const clip = (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.equal(clip.styleTemplateId, "soft-light"); assert.equal(clip.prompt, prompt);
    const runtime = resolveH3Runtime({ ...clip, h3ParameterPolicy: "defaults" }, {}, {}, { styleTemplateId: "cold-xianxia", videoSteps: 17 });
    assert.equal(runtime.params.styleTemplateId, "soft-light"); assert.equal(runtime.sources.styleTemplateId, "clip"); assert.equal(runtime.params.steps, 17);
    assert.equal(resolveH3Runtime({ ...clip, styleTemplateId: null, h3ParameterPolicy: "defaults" }, {}, {}, { styleTemplateId: "cold-xianxia" }).params.styleTemplateId, null);
    assert.equal(resolveH3Runtime({ ...clip, styleTemplateId: null, productionClipProjection: { ...clip.productionClipProjection, styleTemplateDeclared: false }, h3ParameterPolicy: "defaults" }, {}, {}, { styleTemplateId: "cold-xianxia" }).params.styleTemplateId, "cold-xianxia");
});

test("a new approved reference version projects only current Clips and retains the published input", t => {
    const f = referenceClipFixture(t);
    const prepared = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "version-first");
    const original = publish(f.episode, "ep");
    const file = path.join(f.directory, "identity-v2.png"); fs.writeFileSync(file, "new reviewed identity");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    f.db.upsertMediaFile({ storageKey: "identity-v2.png", filePath: file, mimeType: "image/png", bytes: 21, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.stores.projects.applyOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_node", id: "identity", metadata: { storageKey: "identity-v2.png" } }]);
    const candidate = structuredClone(f.episode.get("ep").draft.director!);
    (candidate.source.asset_plan as any[]).find(plan => plan.asset_id === "ROLE").version = "v2";
    candidate.assets.ROLE = { ...candidate.assets.ROLE, version: "v2", storageKey: "identity-v2.png", sha256 };
    candidate.sourceHash = directorHash(candidate.source);
    candidate.artifacts.forEach(a => { a.sourceHash = candidate.sourceHash; a.receipt.sourceHash = candidate.sourceHash; });
    const artifact = candidate.artifacts.find(a => a.targetId === "seg1")!;
    artifact.references[0] = { ...artifact.references[0], storageKey: "identity-v2.png", sha256 };
    save(f.episode, "ep", candidate);
    const group = prepared.draft.clipGroups.find(group => group.id === "seg1")!;
    const clip = (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.equal(clip.referenceBindings[0].storageKey, "identity-v2.png");
    assert.equal(f.episode.version("ep", original.publishedVersion).snapshot.director!.artifacts.find(a => a.targetId === "seg1")!.references[0].storageKey, "approved.png");
    candidate.artifacts.forEach(a => { a.status = "stale"; }); save(f.episode, "ep", candidate);
    const stale = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "version-stale");
    assert.equal(stale.referenceSync?.[0].status, "blocked");
    assert.equal(clip.referenceBindings[0].storageKey, "identity-v2.png");
});

test("formal outgoing flags survive projection and defaults; terminal Clip closes the chain", t => {
    const f = referenceClipFixture(t), candidate = structuredClone(f.d);
    candidate.boundaries[0] = { from: "seg1", to: "seg2", tailFrame: true, motionContext: true, reason: "Continue the held egg and uninterrupted hand action" };
    save(f.episode, "ep", candidate);
    const current = f.episode.get("ep"), project = f.db.getCanvasProject(f.projectId)!;
    const head = buildProductionClip(project, current.draft, current.draft.clipGroups[0], "head");
    const tail = buildProductionClip(project, current.draft, current.draft.clipGroups[1], "tail");
    assert.equal(head.tailFrameContinuation, true); assert.equal(head.motionContextEnabled, true);
    const resolved = resolveH3Runtime({ ...head, h3ParameterPolicy: "defaults" }, {}, { motionContextEnabled: false, tailFrameContinuation: false }, { motionContextEnabled: false, tailFrameContinuation: false });
    assert.equal(resolved.params.motionContextEnabled, true); assert.equal(resolved.params.tailFrameContinuation, true);
    const prepared = f.runner.prepareTargets("ep", current.revision, ["segment:seg1", "segment:seg2"], "enabled-flags");
    const group = prepared.draft.clipGroups[0]; publish(f.episode, "ep");
    const observer = new NativeProductionGeneration(f.db, f.stores, f.episode, f.shared, f.events);
    assert.throws(() => observer.prepare({ mode: "video", operation: "h3-run", projectId: f.projectId, nodeId: group.nodeId!, segmentId: group.segmentId!, params: { motionContextEnabled: false } }), /DIRECTOR_CONTINUITY_CHANGED/);
    assert.equal(tail.tailFrameContinuation, false); assert.equal(tail.motionContextEnabled, false);
    candidate.boundaries = []; save(f.episode, "ep", candidate);
    const blocked = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "missing-boundary");
    assert.equal(blocked.referenceSync?.[0].status, "blocked");
    assert.match(blocked.referenceSync![0].diagnostics[0].message, /MISSING_CONTINUITY_DECISION/);
});
