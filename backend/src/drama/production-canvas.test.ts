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
import { SharedAssetCoordinator, listApprovedSharedAssets, validateSharedAssetSource } from "./shared-assets.js";
import { directorHash, promptHash } from "./director.js";
import { NativeProductionGeneration } from "./native-generation.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import type { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";

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
    const clips = (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === op.nodeId).metadata.segments;
    assert.equal(clips[1].resultStorageKey, "video:second"); assert.equal(clips[0].resultStorageKey, undefined);
    assert.deepEqual(selected.draft.director!.source, before.draft.director!.source); assert.deepEqual(selected.draft.director!.boundaries, before.draft.director!.boundaries);
    assert.equal(selected.draft.clipGroups[1].selectedResult?.generationLogId, op.generationLogId);
    assert.throws(() => f.db.applyCanvasProjectOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "restore_h3_output", nodeId: op.nodeId, segmentId: before.draft.clipGroups[1].segmentId, generationLogId: op.generationLogId, storageKey: op.storageKey, settings: {} }]), /正式制作片段/);
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
    assert.equal(nodes.filter(node => node.type === "minimax-h3:video").length, 1);
    assert.equal(nodes.filter(node => node.metadata?.productionSceneId === "morning").length, 1);
    assert.equal(nodes.filter(node => node.metadata?.productionSceneId === "night").length, 0);
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
    save(f.episode, "ep", director()); save(f.episode, "ep2", director());
    const adopted = f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: first.id, expectedRevision: f.episode.get("ep").revision, operationId: "adopt-1" });
    const adoptedNode = adopted.draft.director!.assets.ROLE.nodeId!;
    const historical = structuredClone(adopted.draft.director!.assets.ROLE);
    assert.equal(f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: first.id, expectedRevision: 1, operationId: "adopt-1" }).replayed, true);
    assert.throws(() => f.db.applyCanvasProjectOperations(episodeCanvas, Number(f.db.getCanvasProject(episodeCanvas)!.revision), [{ type: "update_node", id: adoptedNode, metadata: { storageKey: "image:forged" } }]), /共享引用内容/);
    const second = approve(f, assetCanvas, 2);
    assert.notEqual(second.id, first.id); assert.equal(historical.storageKey, first.storageKey);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM drama_asset_adoptions WHERE status='pending'").get()?.count, 1);
    let compiled = 0;
    const compiler = ((d: DirectorProduction) => {
        compiled++; const next = structuredClone(d);
        for (const artifact of next.artifacts) { artifact.status = "ready"; if (artifact.kind === "h3") artifact.references = [{ label: "<Picture 1>", nodeId: next.assets.ROLE.nodeId!, storageKey: next.assets.ROLE.storageKey!, sha256: next.assets.ROLE.sha256!, role: "character_identity" }]; }
        return { director: next, diagnostics: [], audit: {}, sourceAdjustments: [] };
    }) as unknown as typeof compileAchengDirector;
    new SharedAssetCoordinator(f.db, f.episode, f.events, undefined, compiler).drain();
    const current = f.episode.get("ep");
    assert.equal(current.draft.director!.assets.ROLE.sharedSource?.approvedId, second.id);
    assert.equal(current.draft.director!.assets.ROLE.nodeId, adoptedNode);
    assert.equal(f.db.db.prepare("SELECT status FROM drama_asset_adoptions WHERE approved_id=?").get(second.id)?.status, "applied");
    assert.equal(compiled, 1); assert.equal(f.episode.get("ep2").draft.director!.assets.ROLE.status, "planned");
    assert.equal(JSON.parse(String(f.db.db.prepare("SELECT snapshot_json FROM drama_asset_versions WHERE id=?").get(first.id)?.snapshot_json)).content, first.storageKey);
    assert.throws(() => validateSharedAssetSource(f.db, episodeCanvas, { ...current.draft.director!.assets.ROLE, sharedSource: { ...current.draft.director!.assets.ROLE.sharedSource!, dramaId: "foreign" } }), /剧目.*不一致/);
    fs.writeFileSync(path.join(f.directory, "role-2.png"), "changed bytes");
    assert.throws(() => validateSharedAssetSource(f.db, episodeCanvas, current.draft.director!.assets.ROLE), /摘要/);
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
    (d.source.shots as any[]).forEach(shot => { shot.required_assets = []; });
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source); d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "prepare-h3");
    const current = publish(f.episode, "ep"), groups = current.published!.clipGroups;
    const nodeId = groups[0].nodeId!, first = groups[0].segmentId!, second = groups[1].segmentId!;
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

test("version 23 installations gain preparation receipts and native bindings without rewriting shared versions", t => {
    const f = fixture(t), sharedId = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const approved = approve(f, sharedId, 1);
    f.db.db.exec("DELETE FROM schema_migrations WHERE version>=24; DROP TABLE production_preparations; DROP TABLE production_task_bindings; ALTER TABLE drama_projects DROP COLUMN production_plan_json");
    const upgraded = new BackendDatabase(f.file);
    try {
        assert.equal(upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 25);
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_preparations'").get());
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_task_bindings'").get());
        assert.equal(listApprovedSharedAssets(upgraded, "drama")[0].id, approved.id);
        assert.equal(upgraded.listCanvasFolders().find(folder => folder.id === "drama")?.sharedAssetCanvasId, sharedId);
        assert.ok(fs.readdirSync(f.directory).some(name => name.includes('pre-schema-v23-to-v25')));
    } finally { upgraded.close(); }
});
