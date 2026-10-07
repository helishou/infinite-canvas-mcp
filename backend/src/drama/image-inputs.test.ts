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
import { CanvasGenerationService } from "../canvas/generation-service.js";
import { NativeProductionGeneration } from "./native-generation.js";
import { directorHash, promptHash, validateDirectorMedia } from "./director.js";
import { assertImageReferenceCoverage, verifyImageInput } from "./image-inputs.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

test("legacy image nodes without reference summaries accept independent edits and replay receipts", t => {
    const f = fixture(t);
    const legacy = structuredClone(f.project());
    legacy.id = "legacy-no-reference-summary";
    for (const node of legacy.nodes as any[]) delete node.metadata?.canvasReferenceNodeIds;
    f.db.createCanvasProject(legacy);
    const baseRevision = Number(f.db.getCanvasProject(legacy.id)!.revision);
    const input = f.input();
    const move = [{ type: "update_node", id: "frame", patch: { position: { x: 12, y: 34 } } }];
    const first = f.db.applyCanvasProjectOperations(legacy.id, undefined, move, { operationId: "legacy-move", baseRevision });
    const second = f.db.applyCanvasProjectOperations(legacy.id, undefined, [{ type: "update_node", id: input.sourceNodeId, patch: { title: "Independent title" } }], { operationId: "legacy-title", baseRevision });
    const nodes = second.project.nodes as any[];
    assert.deepEqual(nodes.find(node => node.id === "frame").position, { x: 12, y: 34 });
    assert.equal(nodes.find(node => node.id === input.sourceNodeId).title, "Independent title");
    assert.deepEqual(nodes.find(node => node.id === "frame").metadata.canvasReferenceNodeIds, f.names);
    assert.deepEqual(nodes.find(node => node.id === "frame").metadata.productionImageInput, input);
    const replay = f.db.applyCanvasProjectOperations(legacy.id, undefined, move, { operationId: "legacy-move", baseRevision });
    assert.equal(replay.duplicated, true);
    assert.equal(replay.revision, first.revision);
    assert.equal(f.db.getCanvasProject(legacy.id)!.revision, second.revision);
    assert.throws(() => f.db.applyCanvasProjectOperations(legacy.id, undefined, [{ type: "update_node", id: input.sourceNodeId, patch: { title: "Conflicting title" } }], { baseRevision }), { code: "FIELD_CONFLICT" });
});

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formal-image-input-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite")), stores = createStores(db), events = new BackendEventBus();
    const names = ["CUIZI", "SHUANZI", "NEIGHBOR", "COURTYARD", "STYLE"];
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", title: "Episode", episodeNumber: 1, synopsis: "", canvasId: "canvas" });
    const assets: DirectorProduction["assets"] = {};
    for (const id of names) {
        const filePath = path.join(directory, `${id}.png`), bytes = Buffer.from(`approved-${id}`), storageKey = `image:${id}`;
        fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        assets[id] = { nodeId: id, storageKey, sha256: promptHash(bytes.toString()), version: "v1", status: "approved", evidence: "Media reviewed" };
    }
    assets.FRAME = { nodeId: "frame", version: "v1", status: "planned" };
    db.applyCanvasProjectOperations("canvas", undefined, [...names.map(id => ({ type: "add_node", id, nodeType: "image", metadata: { storageKey: assets[id].storageKey } })),
        { type: "add_node", id: "frame", nodeType: "image", title: "SH001", position: { x: 1000, y: 0 }, width: 340, height: 260 }]);
    const source = { fps_num: 24, fps_den: 1, style_policy: "waived", style_policy_reason: "fixture uses an explicit style reference",
        asset_plan: [...names.map(id => ({ id, kind: "character", version: "v1", depends_on: [] })), { id: "FRAME", kind: "keyframe", version: "v1", depends_on: names }],
        asset_cards: [{ id: "FRAME", asset_version: "v1", references: names.map((id, index) => ({ image: index + 1, asset_id: id, asset_version: "v1", role: id === "STYLE" ? "style" : "character_identity", subject: id, preserve: "registered traits", exclude: "other identities" })) }],
        script_scenes: [{ id: "scene", scene_id: "yard", text: "Three characters in the courtyard" }],
        shots: [{ id: "SH001", scene_id: "yard", start_frame: 0, end_frame: 120, visual: "Neighbor in the background", camera: "static", state_in: {}, state_out: {}, required_assets: names }], segments: [] };
    const sourceHash = directorHash(source), prompt = "Approved shot uses Picture 1 through Picture 5", sha256 = promptHash(prompt);
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), runtimeId: "fixture", patchVersion: "test", version: "1" }, source, sourceHash, assets,
        modules: { assets: { status: "committed", evidence: [], unresolved: [] } }, shotInputs: { SH001: { keyframePolicy: "new", keyframeAssetId: "FRAME", assetIds: names } },
        artifacts: [{ id: "frame-input", kind: "image", targetId: "FRAME", prompt, sha256, sourceHash, status: "ready", references: names.map((id, index) => ({ label: `<Picture ${index + 1}>`, nodeId: id, storageKey: assets[id].storageKey!, sha256: assets[id].sha256!, role: id === "STYLE" ? "style" : "character_identity", preserve: "registered traits", exclude: "other identities" })),
            receipt: { sourceHash, promptHash: sha256, engineRuntimeId: "fixture", validator: "test" } }], boundaries: [], executionAuthorized: false, unresolved: [], workflow: { mediaProductionMode: "automatic" } };
    const service = new EpisodeProductionService(db, events, directory, false, () => {});
    service.edit("ep", { operationId: "source", expectedRevision: 0, ops: [{ type: "set_director_production", director }, { type: "set_settings", patch: { imageModel: "test-image", mode: "auto" } }] });
    service.publish("ep", { operationId: "publish", expectedRevision: 1, stage: "director" });
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { db, stores, service, events, director, names, directory, project: () => db.getCanvasProject("canvas")!, input: () => (db.getCanvasProject("canvas")!.nodes as any[]).find(node => node.id === "frame").metadata.productionImageInput };
}

test("five formal references project exact media, ordering and roles before any task, and survive native generation", async t => {
    const f = fixture(t), input = f.input();
    assert.deepEqual(input.references.map((ref: any) => ref.assetId), f.names);
    assert.deepEqual(input.references.map((ref: any) => ref.assetVersion), f.names.map(() => "v1"));
    assert.equal((f.project().connections as any[]).filter(edge => edge.toNodeId === input.sourceNodeId).length, 5);
    const calls: CanvasGenerationCommand[] = [];
    const generation = new CanvasGenerationService({ start(command: CanvasGenerationCommand) {
        calls.push(structuredClone(command)); const task = f.stores.tasks.create(command.clientTaskId || crypto.randomUUID(), "canvas-image", command, {}); return { taskId: task.id, executor: "fixture" };
    } } as any, {} as any, f.stores, f.events, {} as any, {} as any);
    const native = new NativeProductionGeneration(f.db, f.stores, f.service, f.service, f.events);
    generation.observeProduction(native);
    await generation.start({ mode: "image", projectId: "canvas", nodeId: input.sourceNodeId, model: "test-image", prompt: f.director.artifacts[0].prompt, idempotencyKey: "manual" });
    assert.deepEqual(calls[0].references?.map(ref => ref.storageKey), input.references.map((ref: any) => ref.storageKey));
    assert.equal(calls[0].nodeId, "frame");
    assert.equal(calls[0].params?.canvasFrozenInput, true);
    await assert.rejects(() => generation.start({ mode: "image", projectId: "canvas", nodeId: "frame", model: "test-image", prompt: f.director.artifacts[0].prompt, references: [] }), /正在由任务/);
    assert.equal(calls.length, 1);
});

test("automatic production freezes the same five references and never restarts a paused run", async t => {
    const f = fixture(t), input = f.input(), calls: CanvasGenerationCommand[] = [];
    const fake = { async start(command: CanvasGenerationCommand) {
        calls.push(structuredClone(command));
        const task = f.stores.tasks.create(command.idempotencyKey!, "canvas-image", command, {});
        f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "frame", metadata: { storageKey: f.director.assets.CUIZI.storageKey } }], { runtimeWrite: true });
        f.stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey: f.director.assets.CUIZI.storageKey }] } }); return { taskId: task.id };
    } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(f.service, f.stores, fake);
    const batch = f.service.startBatch("ep", { inputBasis: "published", runId: "run", idempotencyKey: "run", expectedRevision: f.service.get("ep").revision, version: 1, targets: ["frame:SH001"] });
    await runner.runBatch("ep", batch.runId);
    assert.equal(calls.length, 1, f.service.getBatch("ep", "run")?.error || "must submit once");
    assert.deepEqual(calls[0].references?.map(ref => ref.storageKey), input.references.map((ref: any) => ref.storageKey));
    await runner.runBatch("ep", "run");
    assert.equal(calls.length, 1);
});

test("reference removal edits the canvas atomically and preserves director baselines and frozen tasks", t => {
    const f = fixture(t), before = f.service.get("ep"), input = f.input(), frozen = structuredClone(input);
    const task = f.stores.tasks.create("frozen", "canvas-image", { params: { productionImageInput: frozen } }, {});
    const edge = (f.project().connections as any[]).find(edge => edge.fromNodeId === "NEIGHBOR" && edge.toNodeId === input.sourceNodeId);
    const request = [{ type: "delete_connections", id: edge.id }], revision = Number(f.project().revision);
    const receipt = f.db.applyCanvasProjectOperations("canvas", revision, request, { operationId: "remove-neighbor" });
    const current = f.service.get("ep"), d = current.draft.director!;
    assert.equal(current.revision, before.revision);
    assert.equal(d.artifacts[0].status, "ready"); assert.ok(!f.input().stale);
    assert.deepEqual((d.source.asset_cards as any[])[0].references.map((ref: any) => ref.asset_id), f.names);
    assert.deepEqual(current.published, before.published);
    assert.deepEqual(f.stores.tasks.get(task.id)!.input.params, { productionImageInput: frozen });
    assert.deepEqual(receipt.operations.filter((op: any) => op.type === "update_node").map((op: any) => op.id).sort(), ["frame", input.sourceNodeId].sort());
    assert.equal(f.db.applyCanvasProjectOperations("canvas", revision, request, { operationId: "remove-neighbor" }).duplicated, true);
    assert.equal(f.service.get("ep").revision, current.revision);
    const fakeReady = structuredClone(d); fakeReady.artifacts[0].references = fakeReady.artifacts[0].references.filter(ref => ref.nodeId !== "NEIGHBOR");
    assert.throws(() => assertImageReferenceCoverage(fakeReady, fakeReady.artifacts[0]), /遗漏正式依赖参考/);
});

test("reordering uses current canvas references; missing media blocks generation and forged manifests rollback", t => {
    const f = fixture(t), input = f.input(), project = f.project();
    const edges = (project.connections as any[]).filter(edge => edge.toNodeId === input.sourceNodeId);
    const order = ["SHUANZI", "CUIZI", "NEIGHBOR", "COURTYARD", "STYLE"];
    f.db.applyCanvasProjectOperations("canvas", Number(project.revision), [{ type: "delete_connections", ids: edges.map(edge => edge.id) }, ...order.map((fromNodeId, index) => ({ type: "connect_nodes", fromNodeId, toNodeId: input.sourceNodeId, order: index }))], { operationId: "order" });
    const d = f.service.get("ep").draft.director!, refs = (d.source.asset_cards as any[])[0].references;
    assert.deepEqual(refs.map((ref: any) => [ref.image, ref.asset_id]), f.names.map((id, i) => [i + 1, id]));
    assert.deepEqual(f.service.canvasExecution("ep", ["frame:SH001"]).targets[0].command.references?.map(ref => ref.sourceNodeId), order);
    const stable = JSON.stringify(f.project()), formal = JSON.stringify(f.service.get("ep"));
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "unknown", nodeType: "image" }, { type: "connect_nodes", fromNodeId: "unknown", toNodeId: input.sourceNodeId }]);
    assert.equal(f.service.canvasExecution("ep", ["frame:SH001"]).blockedTargets.length, 1);
    assert.equal(JSON.stringify(f.service.get("ep")), formal);
    assert.throws(() => f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "frame", metadata: { productionImageInput: { ...f.input(), references: [] } } }]), /不能直接修改/);
});

test("changed reference bytes, identity version and canvas drift fail before task submission", t => {
    const f = fixture(t), d = f.service.get("ep").published!.director!, artifact = d.artifacts[0];
    fs.writeFileSync(path.join(f.directory, "CUIZI.png"), "changed");
    assert.throws(() => validateDirectorMedia(f.db, "canvas", d, ["FRAME"]), /字节或版本不一致/);
    const changed = structuredClone(d); changed.assets.CUIZI.version = "v2";
    changed.artifacts[0].references[0].assetVersion = "v1";
    assert.throws(() => assertImageReferenceCoverage(changed, changed.artifacts[0]), /批准版本已变化/);
    const project = structuredClone(f.project()); project.connections = [];
    assert.throws(() => verifyImageInput(project, d, artifact, "frame"), /连线数量或顺序已变化/);
    const editedPrompt = structuredClone(f.project());
    (editedPrompt.nodes as any[]).find(node => node.id === f.input().sourceNodeId).metadata.prompt = "User's unsaved formal prompt edit";
    assert.throws(() => verifyImageInput(editedPrompt, d, artifact, "frame"), /提示词已有修改/);
});

test("adding an approved identity back updates the formal draft and preserves its reference scope", t => {
    const f = fixture(t), input = f.input();
    const edge = (f.project().connections as any[]).find(edge => edge.fromNodeId === "NEIGHBOR" && edge.toNodeId === input.sourceNodeId);
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "delete_connections", id: edge.id }]);
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "connect_nodes", fromNodeId: "NEIGHBOR", toNodeId: input.sourceNodeId, order: 2.5 }]);
    const d = f.service.get("ep").draft.director!, ref = (d.source.asset_cards as any[])[0].references.find((ref: any) => ref.asset_id === "NEIGHBOR");
    assert.equal(ref.asset_version, "v1"); assert.equal(ref.role, "character_identity"); assert.equal(ref.preserve, "registered traits");
    assert.equal(f.input().references.length, 5);
    assert.ok(d.shotInputs.SH001.assetIds.includes("NEIGHBOR"));
    assert.equal(f.service.get("ep").published!.director!.artifacts[0].references.length, 5);
});

test("new approved media versions refresh only the projection and preserve frozen tasks and old publications", t => {
    const f = fixture(t), old = f.service.get("ep"), frozen = structuredClone(f.input());
    f.stores.tasks.create("old-task", "canvas-image", { params: { productionImageInput: frozen } }, {});
    const bytes = Buffer.from("approved identity v2"), filePath = path.join(f.directory, "CUIZI-v2.png"), storageKey = "image:CUIZI-v2";
    fs.writeFileSync(filePath, bytes);
    f.db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "CUIZI", metadata: { storageKey } }]);
    const d = structuredClone(old.draft.director!);
    Object.assign(d.assets.CUIZI, { storageKey, sha256: promptHash(bytes.toString()), version: "v2" });
    (d.source.asset_plan as any[]).find(plan => plan.id === "CUIZI").version = "v2";
    (d.source.asset_cards as any[])[0].references[0].asset_version = "v2";
    d.sourceHash = directorHash(d.source);
    d.artifacts[0].sourceHash = d.sourceHash; d.artifacts[0].receipt.sourceHash = d.sourceHash;
    Object.assign(d.artifacts[0].references[0], { storageKey, sha256: d.assets.CUIZI.sha256, assetVersion: "v2" });
    f.service.edit("ep", { operationId: "new-media", expectedRevision: old.revision, ops: [{ type: "set_director_production", director: d }] });
    assert.equal(f.input().references[0].assetVersion, "v2"); assert.equal(f.input().references[0].storageKey, storageKey);
    assert.deepEqual(f.stores.tasks.get("old-task")!.input.params, { productionImageInput: frozen });
    assert.deepEqual(f.service.get("ep").published, old.published);
    assert.throws(() => verifyImageInput(f.project(), old.published!.director!, old.published!.director!.artifacts[0], "frame"), /正式编译不一致/);
});

test("legacy prompt differences preserve history, accept a director baseline, and generate saved edits", t => {
    const f = fixture(t), input = f.input(), original = f.service.get("ep");
    f.db.applyCanvasProjectOperations("canvas", undefined, ["frame", input.sourceNodeId].map(id => ({ type: "update_node", id,
        metadata: { prompt: "Existing manually revised prompt" }, metadataDelete: ["productionImageInput"] })), { runtimeWrite: true });
    const project = structuredClone(f.project());
    const changed = f.service.edit("ep", { operationId: "unrelated-workflow", expectedRevision: original.revision,
        ops: [{ type: "set_director_workflow", patch: { agentThreadId: "new-conversation" } }] });
    assert.equal(changed.draft.director!.workflow.agentThreadId, "new-conversation");
    assert.deepEqual(changed.published, original.published);
    for (const id of ["frame", input.sourceNodeId]) assert.equal((f.project().nodes as any[]).find(node => node.id === id).metadata.prompt, "Existing manually revised prompt");
    assert.equal(f.service.canvasExecution("ep", ["frame:SH001"]).targets[0].command.prompt, "Existing manually revised prompt");
    assert.equal(f.stores.tasks.list().length, 0);
});
