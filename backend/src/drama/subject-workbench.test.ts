import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directorModules, directorProductionSchema, productionWriteReceipt, projectProductionRead, resolveSubjectPictureBindingIds, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { directorHash, promptHash } from "./director.js";
import { ClipRefreshCoordinator } from "./clip-refresh.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";

function fixture(t: test.TestContext, withCanvas = false, setup?: (db: BackendDatabase, directory: string) => void) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subject-workbench-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite")), events = new BackendEventBus();
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    if (withCanvas) {
        db.createCanvasProject({ id: "CANVAS_EP", title: "Fixture canvas", nodes: [], connections: [] });
        db.updateDramaEpisode("ep", { canvasId: "CANVAS_EP" });
    }
    setup?.(db, directory);
    const service = new EpisodeProductionService(db, events, directory, false, () => {});
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return service;
}

function directorV2(): DirectorProduction {
    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        character_registry: [{ id: "P", name: "人物" }], scene_registry: [{ id: "SCENE", name: "鸡窝外" }],
        script_scenes: [{ id: "SCENE", scene_id: "SCENE", scene_name: "鸡窝外", text: "", beat_ids: [] }],
        subject_registry: [{ id: "P", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P" }, pictureBindings: [
            { id: "P_ID", assetId: "A1", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" }, selection: { mode: "latest_success" }, provides: ["identity"], retain: ["identity"], exclude: ["pose"], applicableState: {}, defaultFor: ["identity"] },
        ] }],
        asset_plan: [{ id: "A1", kind: "character", shot_ids: ["S1"] }], asset_cards: [], utterances: [],
        shots: [{ id: "S1", scene_id: "SCENE", timeline_id: "main", story_order: 0, duration_frames: 48,
            subject_usages: [{ subjectId: "P", presentation: "visible", pictureBindingIds: ["P_ID"], referencePurpose: ["identity"], continuityFactIds: ["F1"], stateRequirements: [] }],
            camera: { framing: "MCU", attention_subject_ids: ["P"], editorial_reason: "Keep the character's changing reaction readable." },
            visual: "The character looks toward the window.", keyframes: [], utterance_refs: [] }],
        segments: [{ id: "C1", shot_ids: ["S1"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "Use the approved identity reference." }],
        ledger: { contract_version: 2, facts: [{ id: "F1", object_kind: "character", object_id: "P", allowed_values: ["outside"], value_descriptions: { outside: "The character remains outside the coop window." } }],
            timelines: [{ id: "main" }], initial: [{ id: "I1", timeline_id: "main", fact_id: "F1", value: "outside" }], events: [], requirements: [], coverage: [] },
        unrelated_story_material: "unrelated archived production notes ".repeat(6000),
    };
    const director = directorProductionSchema.parse({ schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "4.3.9" },
        source, sourceHash: "b".repeat(64),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: { A1: { assetId: "A1", version: "v1", status: "planned" } },
        shotInputs: { S1: { keyframePolicy: "none", assetIds: [] } }, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    });
    director.sourceHash = directorHash(director.source);
    return director;
}

test("Subject, Shot and Clip workbenches read one V2 source and Clip edits register only the selected refresh", t => {
    const service = fixture(t), director = directorV2();
    const created = service.get("ep");
    const saved = service.edit("ep", { operationId: "save-v2", expectedRevision: created.revision, ops: [{ type: "set_director_production", director }] });
    assert.equal(saved.revision, created.revision + 1);

    const subject = projectProductionRead(service.subjectWorkbench("ep", "P"), { view: "subject_workbench", targetIds: ["P"] });
    const shot = projectProductionRead(service.shotWorkbench("ep", "S1"), { view: "shot_workbench", targetIds: ["S1"], includeContext: true });
    const clipReadStartedAt = performance.now();
    const clip = projectProductionRead(service.clipWorkbench("ep", "C1"), { view: "clip_workbench", targetIds: ["C1"], includeContext: true });
    const clipReadElapsedMs = performance.now() - clipReadStartedAt;
    assert.equal(subject.revision, shot.revision);
    assert.equal(shot.revision, clip.revision);
    assert.equal((subject.workbench as any).subject.id, "P");
    assert.equal((shot.workbench as any).shot.id, "S1");
    assert.deepEqual((shot.workbench as any).context.continuity.start.map((item: any) => item.factId), ["F1"]);
    assert.deepEqual((clip.workbench as any).segment.shot_ids, ["S1"]);
    assert.deepEqual((clip.workbench as any).context.continuity.facts.map((item: any) => item.id), ["F1"]);
    assert.equal(Object.hasOwn(clip, "draft"), false);
    const fullBytes = Buffer.byteLength(JSON.stringify(service.get("ep")));
    const targetBytes = Buffer.byteLength(JSON.stringify(clip));
    assert.ok(targetBytes < fullBytes, `target workbench ${targetBytes} bytes should be smaller than full read ${fullBytes} bytes`);

    const current = service.get("ep");
    const edited = service.edit("ep", { operationId: "edit-shot-refresh", expectedRevision: current.revision, ops: [
        { type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: "The character leans toward the window, listening." } },
        { type: "request_director_clip_refresh", segmentId: "C1" },
    ] });
    assert.equal(edited.revision, current.revision + 1);
    const jobs = service.clipRefreshStore("ep").byEditAll("edit-shot-refresh");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].segmentId, "C1");
    assert.equal(jobs[0].status, "queued");
    assert.equal(service.clipRefreshStore("ep").pending().length, 1);
    const receipt = productionWriteReceipt({ ok: true, production: edited }, { tool: "production_edit", input: { operationId: "edit-shot-refresh" } });
    console.log(JSON.stringify({ scenario: "single-shot edit and Clip refresh intent", nonStatusCalls: 2, targetWorkbenchBytes: targetBytes,
        fullProductionBytes: fullBytes, targetReadRatio: Number((targetBytes / fullBytes).toFixed(3)), writeReceiptBytes: Buffer.byteLength(JSON.stringify(receipt)),
        clipWorkbenchElapsedMs: Number(clipReadElapsedMs.toFixed(2)), selectedTargets: jobs.map(job => job.segmentId), mediaSubmitted: (receipt as any).production?.clipRefresh?.mediaSubmitted ?? (receipt as any).mediaSubmitted }));
});

test("saving visible Shot text is allowed while its required identity image is still missing", t => {
    const service = fixture(t), director = directorV2();
    const subject = (director.source.subject_registry as any[])[0];
    subject.pictureBindings = [];
    (director.source.shots as any[])[0].subject_usages[0].pictureBindingIds = [];
    director.sourceHash = directorHash(director.source);
    const current = service.get("ep");

    const saved = service.edit("ep", { operationId: "save-shot-without-image", expectedRevision: current.revision,
        ops: [{ type: "set_director_production", director }] });

    assert.equal(saved.draft.director?.sourceHash, directorHash(director.source));
    assert.deepEqual((saved.draft.director?.source.shots as any[])[0].subject_usages[0].pictureBindingIds, []);
    assert.equal(saved.revision, current.revision + 1);
});

test("ordinary Shot saves queue one Clip refresh and replay the saved intent without unrelated blockers", t => {
    const service = fixture(t, true), director = directorV2();
    (director.source.shots as any[]).push({ ...(director.source.shots as any[])[0], id: "S2", story_order: 1,
        subject_usages: [], visual: "An unrelated empty doorway." });
    (director.source.segments as any[]).push({ id: "C2", shot_ids: ["S2"], mode: "T2VA" });
    director.shotInputs.S2 = { keyframePolicy: "none", assetIds: [] };
    director.sourceHash = directorHash(director.source);
    const initial = service.edit("ep", { operationId: "auto-initial", expectedRevision: service.get("ep").revision,
        ops: [{ type: "set_director_production", director }] });
    const input = { operationId: "auto-shot-save", expectedRevision: initial.revision,
        ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: "The character turns toward a sound." } }] };
    const saved = service.edit("ep", input) as any;
    const jobs = service.clipRefreshStore("ep").byEditAll(input.operationId);
    assert.deepEqual(jobs.map(job => [job.segmentId, job.status]), [["C1", "queued"]]);
    assert.equal(saved.clipRefresh.sourceSaved, true);
    assert.equal(saved.clipRefresh.mediaSubmitted, false);
    assert.deepEqual(saved.referenceSync || [], [], "queued compilation must not report a missing-artifact failure");
    const restored = service.operationReceipt("ep", input.operationId) as any;
    assert.equal(restored.clipRefresh.operationId, jobs[0].operationId, "lost-response recovery keeps the original refresh identity");
    assert.deepEqual(restored.referenceSync || [], []);
    const replayed = service.edit("ep", input) as any;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.revision, saved.revision);
    assert.equal(service.clipRefreshStore("ep").byEditAll(input.operationId).length, 1);
    const receipt = productionWriteReceipt({ ok: true, production: saved }, { tool: "production_edit", input });
    assert.equal((receipt as any).clipRefreshSummary.running, 1);
    assert.equal((receipt as any).clipRefreshSummary.blocked, 0);
});

test("an explicit refresh repairs an unchanged Clip with no current artifact", t => {
    const service = fixture(t, true), director = directorV2();
    const initial = service.edit("ep", { operationId: "refresh-initial", expectedRevision: service.get("ep").revision,
        ops: [{ type: "set_director_production", director }] });
    const saved = service.edit("ep", { operationId: "refresh-missing", expectedRevision: initial.revision,
        ops: [{ type: "request_director_clip_refresh", segmentId: "C1" }] }) as any;
    assert.equal(saved.clipRefresh.status, "queued");
    assert.deepEqual(saved.referenceSync || [], []);
    assert.equal(service.clipRefreshStore("ep").byEditAll("refresh-missing").length, 1);
});

test("saving unchanged Shot content neither recompiles nor reports existing missing artifacts", t => {
    const service = fixture(t, true), director = directorV2();
    const initial = service.edit("ep", { operationId: "no-op-initial", expectedRevision: service.get("ep").revision,
        ops: [{ type: "set_director_production", director }] });
    const saved = service.edit("ep", { operationId: "no-op-save", expectedRevision: initial.revision,
        ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: (director.source.shots as any[])[0].visual } }] }) as any;
    assert.equal(service.clipRefreshStore("ep").byEditAll("no-op-save").length, 0);
    assert.deepEqual(saved.referenceSync || [], []);
});

test("an automatically registered refresh applies compiled input once and reaches translation without submitting media", async t => {
    let database!: BackendDatabase;
    const service = fixture(t, true, db => { database = db; }), director = directorV2();
    director.source.subject_registry = [];
    director.source.character_registry = [];
    director.source.asset_plan = [];
    director.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] };
    (director.source.shots as any[])[0].subject_usages = [];
    (director.source.shots as any[])[0].camera.attention_subject_ids = [];
    (director.source.segments as any[])[0].mode = "T2VA";
    director.assets = {};
    director.sourceHash = directorHash(director.source);
    const initial = service.edit("ep", { operationId: "pipeline-initial", expectedRevision: service.get("ep").revision,
        ops: [{ type: "set_director_production", director }] });
    const saved = service.edit("ep", { operationId: "pipeline-edit", expectedRevision: initial.revision,
        ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: "The door opens slowly." } }] }) as any;
    let enqueues = 0, applications = 0, translations = 0;
    const prompt = "integrated_multimodal_description:\n[Shot 1] The door opens slowly.\n\noverall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nNone.\n";
    const compilations = {
        enqueue: () => { enqueues++; return { status: "succeeded", preparedId: "pipeline-prepared" }; },
        getCompilation: (_id: string, _owner: string, _key: string, view?: string) => view === "targets"
            ? { items: [{ targetId: "C1", status: "ready" }], total: 1 } : { status: "succeeded" },
        apply: () => {
            applications++;
            const current = service.get("ep"), compiled = structuredClone(current.draft.director!);
            const sha256 = promptHash(prompt);
            compiled.artifacts = [{ id: "h3-C1", targetId: "C1", kind: "h3", status: "ready", prompt, sha256,
                sourceHash: compiled.sourceHash, references: [], receipt: { sourceHash: compiled.sourceHash,
                    promptHash: sha256, engineRuntimeId: compiled.engine.runtimeId, validator: "fixture" } }];
            return service.edit("ep", { operationId: "pipeline-apply", expectedRevision: current.revision,
                ops: [{ type: "set_director_production", director: compiled }] }, undefined, false, undefined, undefined, new Set(["C1"]));
        },
    };
    Object.assign(service, { translateCompiledPrompts: async () => { translations++; return {}; } });
    const coordinator = new ClipRefreshCoordinator(service, compilations as any, "fixture");
    coordinator.wake("ep");
    await new Promise<void>(resolve => setImmediate(resolve));
    const job = service.clipRefreshStore("ep").get(saved.clipRefresh.operationId)!;
    assert.equal(job.status, "succeeded");
    assert.deepEqual([enqueues, applications, translations], [1, 1, 1]);
    assert.deepEqual(job.application.referenceSync.map((item: any) => [item.targetId, item.status]), [["C1", "ready"]]);
    const node = (database.getCanvasProject("CANVAS_EP")!.nodes as any[]).find(node => node.type === "minimax-h3:video");
    assert.equal(node.metadata.segments[0].prompt, prompt);
    assert.equal(service.clipRefreshStore("ep").byEditAll("pipeline-apply").length, 0, "applying compiled input must not queue another compile");
    coordinator.wake("ep");
    assert.deepEqual([enqueues, applications, translations], [1, 1, 1]);
    assert.equal((productionWriteReceipt({ ok: true, production: saved }, { tool: "production_edit", input: { operationId: "pipeline-edit" } }) as any).mediaSubmitted, false);
});

test("a visible Subject image dependency keeps its Segment blocked until the archived asset is available", t => {
    const service = fixture(t, true, db => {
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "image", position: { x: 0, y: 0 }, metadata: { prompt: "Character identity reference" } }], { runtimeWrite: true });
    }), director = directorV2();
    const current = service.get("ep");
    service.edit("ep", { operationId: "save-visible-subject-plan", expectedRevision: current.revision,
        ops: [{ type: "set_director_production", director }] });

    const readiness = service.workflowReadiness("ep", "draft");
    const segment = readiness.targets.find(item => item.id === "segment:C1");
    const asset = readiness.targets.find(item => item.id === "asset:A1");
    assert.equal(segment?.status, "blocked");
    assert.ok(segment?.blockers.some(item => item.includes("依赖资产 A1 的媒体未就绪")), JSON.stringify(segment?.blockers));
    assert.ok(!segment?.blockers.some(item => item.includes("先发布再生产")), JSON.stringify(segment?.blockers));
    assert.equal(asset?.status, "blocked");

    assert.throws(() => service.startBatch("ep", { runId: "missing-subject-media-run", idempotencyKey: "missing-subject-media-request",
        expectedRevision: service.get("ep").revision, expectedCanvasRevision: readiness.canvasRevision, targets: ["segment:C1"] }),
    error => (error as any).diagnostics?.some((item: any) => item.code === "PRODUCTION_MEDIA_DEPENDENCY" && item.targetId === "segment:C1" && item.blockingActions?.includes("generate")));
    assert.equal(service.listBatches("ep").some(batch => batch.runId === "missing-subject-media-run"), false);
});

test("Clip compilation infers text mode for offscreen voices instead of stale reference mode", t => {
    let database!: BackendDatabase;
    const service = fixture(t, true, db => { database = db; });
    const director = directorV2();
    const usage = (director.source.shots as any[])[0].subject_usages[0];
    usage.presentation = "offscreen_voice";
    usage.pictureBindingIds = [];
    (director.source.segments as any[])[0].mode = "Ref2VA";
    delete (director.source.segments as any[])[0].mode_lock;
    director.sourceHash = directorHash(director.source);
    const current = service.get("ep");
    const saved = service.edit("ep", { operationId: "seed-clip-mode", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });
    const group = saved.draft.clipGroups.find(item => item.id === "C1")!;
    const project = database.getCanvasProject("CANVAS_EP")!;
    database.applyCanvasProjectOperations("CANVAS_EP", Number(project.revision), [{ type: "update_h3_segment", nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { taskMode: "t2v" } }], { runtimeWrite: true });

    const resolved = service.resolveSubjectPictureInputs("ep", saved.draft.director!, ["C1"], true);
    const segment = (resolved.source.segments as any[]).find(item => item.id === "C1");
    assert.equal(segment.mode, "T2VA");
    assert.equal(segment.mode_lock, undefined);
    assert.equal(resolved.sourceHash, directorHash(resolved.source));
});

test("explicitly clearing pictures is saveable and permits Ref2VA compile with advisory diagnostics", t => {
    const service = fixture(t, true), director = directorV2();
    const usage = (director.source.shots as any[])[0].subject_usages[0];
    usage.pictureBindingMode = "explicit";
    usage.pictureBindingIds = [];
    director.sourceHash = directorHash(director.source);
    const seeded = service.edit("ep", { operationId: "seed-explicit-empty-reference", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const savedUsage = (seeded.draft.director!.source.shots as any[])[0].subject_usages[0];
    assert.equal(savedUsage.pictureBindingMode, "explicit");
    assert.deepEqual(savedUsage.pictureBindingIds, []);
    assert.deepEqual(resolveSubjectPictureBindingIds((seeded.draft.director!.source.subject_registry as any[])[0], savedUsage).bindingIds, []);
    const shotRead = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(shotRead.context.resolvedSubjectUsages[0].pictureBindings.length, 0);
    assert.deepEqual(shotRead.runtime.resolutionDiagnostics, []);
    // REF2VA_IMAGE_REQUIRED 硬卡控已移除：无图 Ref2VA 段编译放行，仅保留 advisory 诊断。
    const noImageCompiled = service.resolveSubjectPictureInputs("ep", seeded.draft.director!, ["C1"], true);
    assert.equal((noImageCompiled.source.segments as any[])[0].mode, "Ref2VA");
    assert.equal(noImageCompiled.assets.A1.storageKey, undefined);

    const textMode = structuredClone(service.get("ep").draft.director!);
    const segment = (textMode.source.segments as any[])[0];
    segment.mode = segment.mode_lock = "T2VA";
    segment.mode_selection_reason = "Use a text-only generation mode.";
    textMode.sourceHash = directorHash(textMode.source);
    const textSaved = service.edit("ep", { operationId: "seed-explicit-empty-text-mode", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director: textMode }] });
    const textCompiled = service.resolveSubjectPictureInputs("ep", textSaved.draft.director!, ["C1"], true);
    assert.equal((textCompiled.source.segments as any[])[0].mode, "T2VA");
    assert.equal(textCompiled.assets.A1.storageKey, undefined);
});

test("Clip mode inference retains Ref2VA when a visible Subject has a verified image", t => {
    const storageKey = "image:visible-subject", bytes = Buffer.from("visible-image");
    const service = fixture(t, true, (db, directory) => {
        const filePath = path.join(directory, "visible-subject.png");
        fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "character", position: { x: 0, y: 0 }, metadata: {
            characterImages: [{ storageKey, url: "/media/visible-subject.png" }], characterPrimaryIndex: 0,
        } }], { runtimeWrite: true });
    });
    const director = directorV2();
    (director.source.segments as any[])[0].mode = "T2VA";
    delete (director.source.segments as any[])[0].mode_lock;
    director.sourceHash = directorHash(director.source);
    const current = service.get("ep");
    service.edit("ep", { operationId: "seed-visible-subject-mode", expectedRevision: current.revision, ops: [{ type: "set_director_production", director }] });

    const resolved = service.resolveSubjectPictureInputs("ep", service.get("ep").draft.director!, ["C1"], true);
    assert.equal((resolved.source.segments as any[])[0].mode, "Ref2VA");
    assert.equal(resolved.assets.A1.storageKey, storageKey);
});

test("node-managed reference selection freezes the selected image and registers only its actual Clip consumer", t => {
    let database!: BackendDatabase;
    const service = fixture(t, true, (db, directory) => {
        database = db;
        for (const name of ["old", "latest"]) {
            const filePath = path.join(directory, name + ".png");
            fs.writeFileSync(filePath, Buffer.from(name));
            db.upsertMediaFile({ storageKey: "image:" + name, filePath, mimeType: "image/png", bytes: name.length, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        }
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "config", title: "Subject image", position: { x: 0, y: 0 }, width: 200, height: 200,
            metadata: { smart: true, generationMode: "image", prompt: "Current prompt", model: "Current model", primaryImageId: "latest",
                images: [{ id: "old", status: "success", storageKey: "image:old", generationTaskSequence: 1 }, { id: "latest", status: "success", storageKey: "image:latest", generationTaskSequence: 2 }] } }], { runtimeWrite: true });
    });
    const d = directorV2();
    (d.source.subject_registry as any[])[0].pictureBindings[0].selection = { mode: "node_selection" };
    d.sourceHash = directorHash(d.source);
    const initial = service.resolveSubjectPictureInputs("ep", d, ["C1"], true);
    assert.equal(initial.assets.A1.storageKey, "image:latest");
    service.edit("ep", { operationId: "save-node-consumer", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director: initial }] });
    const project = database.getCanvasProject("CANVAS_EP")!;
    const selected = database.applyCanvasProjectOperations("CANVAS_EP", Number(project.revision), [{ type: "update_node", id: "IMAGE_P", metadata: { smartImageReferenceSelection: { mode: "selected_result", resultId: "old" } } }], { operationId: "pin-image" });
    const replay = database.applyCanvasProjectOperations("CANVAS_EP", Number(project.revision), [{ type: "update_node", id: "IMAGE_P", metadata: { smartImageReferenceSelection: { mode: "selected_result", resultId: "old" } } }], { operationId: "pin-image" });
    assert.equal(replay.duplicated, true);
    assert.equal(replay.revision, selected.revision);
    assert.throws(() => database.applyCanvasProjectOperations("CANVAS_EP", selected.revision, [{ type: "update_node", id: "IMAGE_P", metadata: { smartImageReferenceSelection: { mode: "selected_result", resultId: "missing" } } }], { operationId: "invalid-pin" }), /SMART_IMAGE_REFERENCE_SELECTION_INVALID/);
    assert.equal(database.getCanvasProject("CANVAS_EP")!.revision, selected.revision);
    assert.equal((database.getCanvasProject("CANVAS_EP")!.nodes as any[])[0].metadata.prompt, "Current prompt");
    const frozen = service.resolveSubjectPictureInputs("ep", service.get("ep").draft.director!, ["C1"], true);
    assert.equal(frozen.assets.A1.storageKey, "image:old");
    assert.equal((frozen.assets.A1.selectedResult as any).imageId, "old");
    const coordinator = new ClipRefreshCoordinator(service, {} as any, "episode");
    coordinator.wake = () => {}; // Inspect durable intent without running a compiler or media task.
    coordinator.wakeSourceCanvas("CANVAS_EP", ["IMAGE_P"], selected.revision, "pin-image");
    coordinator.wakeSourceCanvas("CANVAS_EP", ["IMAGE_P"], selected.revision, "pin-image");
    const jobs = service.clipRefreshStore("ep").byEditAll(`smart-result:CANVAS_EP:${selected.revision}:pin-image`);
    assert.deepEqual(jobs.map(job => job.segmentId), ["C1"]);
    assert.equal(jobs[0].snapshot.assets.A1.storageKey, "image:old");
    coordinator.wakeSourceCanvas("CANVAS_EP", ["UNRELATED"], selected.revision, "unrelated-image");
    assert.equal(service.clipRefreshStore("ep").byEditAll(`smart-result:CANVAS_EP:${selected.revision}:unrelated-image`).length, 0);
    assert.equal(initial.assets.A1.storageKey, "image:latest");
});

test("Subject bindings can resolve a verified formal asset projection after its canvas node is retyped", t => {
    const taskId = "subject-formal-image-task", storageKey = "image:formal-asset";
    const bytes = Buffer.from("formal generated Subject image");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    let database!: BackendDatabase;
    const service = fixture(t, true, (db, directory) => {
        database = db;
        const filePath = path.join(directory, "formal-asset.png");
        fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 16, height: 16, durationMs: null, createdAt: new Date().toISOString() });
        const task = db.createTask(taskId, "canvas-image", { projectId: "CANVAS_EP", nodeId: "IMAGE_P" }, {});
        db.updateTask(task.id, { status: "succeeded", result: { media: [{ storageKey, mimeType: "image/png" }] } });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "character", title: "Formal asset projection", position: { x: 0, y: 0 }, width: 200, height: 200,
            metadata: { productionAssetId: "A1", generationTaskId: taskId, generatedImageHistory: [{ storageKey, taskId }] } }], { runtimeWrite: true });
    });
    const director = directorV2();
    (director.source.subject_registry as any[])[0].pictureBindings[0].selection = { mode: "node_selection" };
    (director.assets as any).A1 = { assetId: "A1", nodeId: "IMAGE_P", version: "v1", status: "generated", storageKey, generationTaskId: taskId, sha256 };
    director.sourceHash = directorHash(director.source);

    const resolved = service.resolveSubjectPictureInputs("ep", director, ["C1"], true);
    assert.equal(resolved.assets.A1.storageKey, storageKey);
    assert.equal(resolved.assets.A1.sha256, sha256);
    assert.equal((resolved.assets.A1.selectedResult as any).taskId, taskId);
    assert.equal((database.getCanvasProject("CANVAS_EP")!.nodes as any[])[0].type, "character");

    const media = database.getMediaFile(storageKey)!;
    const tamperedBytes = Buffer.from(bytes);
    tamperedBytes[0] ^= 1;
    fs.writeFileSync(media.filePath, tamperedBytes);
    fs.utimesSync(media.filePath, new Date(), new Date(Date.now() + 2000));
    assert.throws(() => service.resolveSubjectPictureInputs("ep", director, ["C1"], true), (error: any) =>
        error.diagnostics?.[0]?.code === "SUBJECT_IMAGE_HASH_MISMATCH");
});

test("Subject bindings accept an archived image node without requiring smart-node metadata", t => {
    const storageKey = "image:ordinary-node", bytes = Buffer.from("ordinary archived image");
    const service = fixture(t, true, (db, directory) => {
        const filePath = path.join(directory, "ordinary-image.png");
        fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 16, height: 16, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "image", title: "普通图片节点", position: { x: 0, y: 0 }, width: 200, height: 200,
            metadata: { storageKey, mimeType: "image/png" } }], { runtimeWrite: true });
    });
    const director = directorV2();
    director.sourceHash = directorHash(director.source);
    const resolved = service.resolveSubjectPictureInputs("ep", director, ["C1"], true);
    assert.equal(resolved.assets.A1.storageKey, storageKey);
    assert.equal(resolved.assets.A1.status, "generated");
});

test("an ungenerated required keyframe stays a draft input and blocks only media generation", t => {
    const service = fixture(t, true, db => {
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "KF_SOURCE", nodeType: "config", title: "Planned keyframe", position: { x: 0, y: 0 }, width: 200, height: 200,
            metadata: { generationMode: "image", productionAssetId: "KF_PENDING", prompt: "A planned keyframe" } }], { runtimeWrite: true });
    });
    const director = directorV2(), source = director.source as Record<string, any>;
    source.subject_registry[0].pictureBindings = [];
    source.shots[0].subject_usages[0].presentation = "state_context";
    source.shots[0].subject_usages[0].pictureBindingIds = [];
    source.shots[0].keyframes = [{ id: "KF_PENDING", assetId: "KF_PENDING", sourceNode: { projectId: "CANVAS_EP", nodeId: "KF_SOURCE" },
        selection: { mode: "node_selection" }, requiredForSubmission: true }];
    director.sourceHash = directorHash(source);

    assert.throws(() => service.resolveSubjectPictureInputs("ep", director, ["C1"], true), (error: any) =>
        error.diagnostics?.[0]?.code === "SUBJECT_IMAGE_RESULT_MISSING");
    const diagnostics: any[] = [];
    const draftInput = service.resolveSubjectPictureInputs("ep", director, ["C1"], true, undefined, diagnostics);
    assert.equal(draftInput.assets.KF_PENDING, undefined);
    assert.deepEqual(diagnostics.map(item => ({ code: item.code, targetId: item.targetId, severity: item.severity, blocksCompilation: item.blocksCompilation, blockingActions: item.blockingActions })), [
        { code: "SUBJECT_IMAGE_RESULT_MISSING", targetId: "C1", severity: "warning", blocksCompilation: false, blockingActions: ["generate"] },
    ]);
});

test("Shot workbenches report compiler validity without requiring browsers to hash the source", t => {
    const service = fixture(t, true), director = directorV2();
    const source = director.source as Record<string, any>;
    source.subject_registry[0].pictureBindings = [];
    source.shots[0].subject_usages[0].presentation = "state_context";
    source.shots[0].subject_usages[0].pictureBindingIds = [];
    source.segments[0].mode = source.segments[0].mode_lock = "T2VA";
    director.sourceHash = directorHash(source);
    const prompt = "A character listens outside the window.", sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
    director.artifacts = [{ id: "COMPILED_C1", kind: "h3", targetId: "C1", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, validator: "fixture" } }];
    const saved = service.edit("ep", { operationId: "save-compiler-status", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const current = projectProductionRead(service.shotWorkbench("ep", "S1"), { view: "shot_workbench", targetIds: ["S1"], includeRuntime: true }).workbench as any;
    assert.deepEqual(current.runtime.resolutionDiagnostics, []);
    assert.deepEqual(current.runtime.directorArtifacts, [{ id: "COMPILED_C1", status: "ready", sha256, current: true }]);
    assert.equal(Object.hasOwn(current.runtime.directorArtifacts[0], "prompt"), false);
    service.edit("ep", { operationId: "invalidate-compiler-status", expectedRevision: saved.revision, ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: "The character steps away." } }] });
    const changed = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(changed.runtime.directorArtifacts[0].current, false);
});

test("unresolved image bindings do not advertise a ready Prompt as current", t => {
    const service = fixture(t, true), director = directorV2();
    const prompt = "Listen outside.", sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
    director.artifacts = [{ id: "COMPILED_C1", kind: "h3", targetId: "C1", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, validator: "compile_h3/validate_package",
            diagnostics: { accepted: true, formatPass: "PASSED", detailPolicy: { minimum_words: 0 } } } }];
    service.edit("ep", { operationId: "save-missing-reference", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const read = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(read.runtime.resolutionDiagnostics[0].code, "SUBJECT_IMAGE_SOURCE_MISSING");
    assert.equal(read.runtime.directorArtifacts[0].current, false);
});

test("design-only images do not invalidate compilation for a mode that does not consume them", t => {
    const service = fixture(t, true), director = directorV2(), source = director.source as Record<string, any>;
    source.segments[0].mode = source.segments[0].mode_lock = "T2VA";
    director.sourceHash = directorHash(source);
    const prompt = "Listen outside.", sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
    director.artifacts = [{ id: "COMPILED_C1", kind: "h3", targetId: "C1", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, validator: "fixture" } }];
    service.edit("ep", { operationId: "save-design-only", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const read = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(read.runtime.resolutionDiagnostics[0].code, "SUBJECT_IMAGE_SOURCE_MISSING");
    assert.equal(read.runtime.directorArtifacts[0].current, true);
});

test("Prompt reverse sync maps a physical canvas Clip to a different source Segment ID", t => {
    let database!: BackendDatabase;
    const service = fixture(t, true, db => { database = db; });
    const d = directorV2(), source = d.source as Record<string, any>;
    source.subject_registry[0].pictureBindings = [];
    source.shots[0].subject_usages[0].presentation = "state_context";
    source.shots[0].subject_usages[0].pictureBindingIds = [];
    source.segments[0].mode = source.segments[0].mode_lock = "T2VA";
    d.sourceHash = directorHash(source);
    const visual = String(source.shots[0].visual), prompt = "integrated_multimodal_description:\n" + visual;
    const sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
    d.artifacts = [{ id: "ART_C1", kind: "h3", targetId: "C1", prompt, sha256, sourceHash: d.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: d.sourceHash, promptHash: sha256, engineRuntimeId: d.engine.runtimeId, validator: "fixture", sourceMap: { version: 1, offsetUnit: "utf16", segmentId: "C1", sourceHash: d.sourceHash, promptHash: sha256,
            entries: [{ start: prompt.indexOf(visual), end: prompt.length, sourceKind: "shot", sourceId: "S1", field: "visual", sourceText: visual, sourceValue: visual, sourceStart: 0, sourceEnd: visual.length }] } } }];
    service.edit("ep", { operationId: "save-reverse-baseline", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director: d }] });
    database.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "VIDEO", nodeType: "minimax-h3:video", title: "Clip", position: { x: 0, y: 0 }, width: 500, height: 400,
        metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", productionSceneId: "SCENE", segments: [{ id: "PHYSICAL_C1", prompt, duration: 2, productionClipProjection: { targetId: "C1" } }] } }], { runtimeWrite: true });
    service.edit("ep", { operationId: "bind-reverse-target", expectedRevision: service.get("ep").revision, ops: [{ type: "bind_director_segment", targetId: "C1", nodeId: "VIDEO", segmentId: "PHYSICAL_C1" }] });
    const editedPrompt = prompt.replace("looks toward", "listens beside");
    const canvas = database.applyCanvasProjectOperations("CANVAS_EP", Number(database.getCanvasProject("CANVAS_EP")!.revision), [{ type: "update_h3_segment", nodeId: "VIDEO", segmentId: "PHYSICAL_C1", patch: { prompt: editedPrompt } }], { operationId: "manual-prompt" });
    const before = service.get("ep");
    const request = { operationId: "reverse-source-target", expectedRevision: before.revision, ops: [{ type: "reverse_sync_director_prompt", segmentId: "C1", artifactId: "ART_C1", sourceHash: before.draft.director!.sourceHash, basePromptHash: sha256, prompt: editedPrompt, canvasRevision: canvas.revision }] };
    const liveGroup = before.draft.clipGroups.find(group => group.id === "C1");
    const liveNode = (database.getCanvasProject("CANVAS_EP")!.nodes as any[]).find(node => node.id === "VIDEO");
    const liveClip = liveNode.metadata.segments.find((clip: any) => clip.id === "PHYSICAL_C1");
    assert.equal(liveGroup?.segmentId, "PHYSICAL_C1");
    assert.equal(liveClip.productionClipProjection.targetId, "C1");
    assert.equal(liveClip.prompt, editedPrompt);
    const result = service.edit("ep", request);
    assert.equal((result.draft.director!.source.shots as any[])[0].visual, visual.replace("looks toward", "listens beside"));
    assert.equal(result.draft.director!.artifacts[0].status, "stale");
    const currentClip = (database.getCanvasProject("CANVAS_EP")!.nodes as any[]).find(node => node.id === "VIDEO").metadata.segments.find((clip: any) => clip.id === "PHYSICAL_C1");
    assert.equal(currentClip.prompt, editedPrompt, "the manual Prompt remains while compilation is queued");
    assert.equal(result.draft.clipGroups[0].segmentId, "PHYSICAL_C1");
    assert.equal(service.edit("ep", request).replayed, true);
});

test("Subject CRUD edits the original character registry and refuses referenced Subject deletion", t => {
    const service = fixture(t, true), d = directorV2();
    const saved = service.edit("ep", { operationId: "crud-source", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director: d }] });
    const named = service.edit("ep", { operationId: "crud-name", expectedRevision: saved.revision, ops: [{ type: "patch_director_source", entity: "character", id: "P", patch: { name: "栓子", appearance: "穿灰色棉衣的孩子。" } }] });
    assert.equal((named.draft.director!.source.character_registry as any[])[0].name, "栓子");
    assert.equal(Object.hasOwn((named.draft.director!.source.subject_registry as any[])[0], "name"), false);
    assert.throws(() => service.edit("ep", { operationId: "crud-remove-used", expectedRevision: named.revision, ops: [{ type: "delete_director_subject", id: "P" }] }), /SUBJECT_STILL_REFERENCED/);
    const replaceSource = named.draft.director!.source as any;
    replaceSource.character_registry.push({ id: "P2", name: "替代人物" });
    replaceSource.subject_registry.push({ id: "SUB_P2", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P2" }, pictureBindings: [] });
    replaceSource.utterances = [{ id: "U1", speakerSubjectId: "P", text: "对白保留", voiceover: false, start: { shotId: "S1", localFrame: 0 }, end: { shotId: "S1", localFrame: 24 } }];
    replaceSource.shots[0].utterance_refs = [{ utteranceId: "U1", role: "speaker", localStartFrame: 0, localEndFrame: 24, textStart: 0, textEnd: 4 }];
    replaceSource.shots[0].keyframes = [{ id: "KF1", assetId: "KF1", sourceNode: { projectId: "CANVAS_EP", nodeId: "KF1" }, selection: { mode: "latest_success" }, anchor: "opening", subjectIds: ["P"], subjectPictureBindingIds: { P: [] }, retain: [], exclude: [], requiredForSubmission: false }];
    replaceSource.shots[0].reference_requirements = [{ id: "REF1", asset_id: "A1", asset_version: "v1", purpose: "构图参考", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" }, selection: { mode: "latest_success" }, retain: [], exclude: [], requiredForSubmission: false, subjectIds: ["P"], subjectPictureBindingIds: { P: ["P_ID"] } }];
    replaceSource.shots[0].utterance_refs[0].textEnd = Array.from("对白保留").length;
    replaceSource.shots[0].subject_usages[0].pictureBindingIds = ["P_ID"];
    named.draft.director!.sourceHash = directorHash(replaceSource);
    const replacementSaved = service.edit("ep", { operationId: "crud-add-replacement", expectedRevision: named.revision, ops: [{ type: "set_director_production", director: named.draft.director }] });
    const replacement = service.edit("ep", { operationId: "crud-remove-used-replace", expectedRevision: replacementSaved.revision, ops: [{ type: "delete_director_subject", id: "P", referenceAction: "replace", replacementSubjectId: "SUB_P2" }] });
    const replacedShot = (replacement.draft.director!.source.shots as any[])[0];
    assert.equal(replacedShot.subject_usages[0].subjectId, "SUB_P2");
    assert.deepEqual(replacedShot.subject_usages[0].pictureBindingIds, []);
    assert.deepEqual(replacedShot.camera.attention_subject_ids, ["SUB_P2"]);
    assert.deepEqual(replacedShot.keyframes[0].subjectIds, ["SUB_P2"]);
    assert.equal(Object.hasOwn(replacedShot.keyframes[0].subjectPictureBindingIds, "P"), false);
    assert.deepEqual(replacedShot.reference_requirements[0].subjectIds, ["SUB_P2"]);
    assert.equal((replacement.draft.director!.source.utterances as any[])[0].speakerSubjectId, "SUB_P2");
    assert.equal(((replacement.draft.director!.source.ledger as any).facts as any[])[0].object_id, "P2");
    assert.ok((replacement.draft.director!.source.subject_registry as any[]).every(row => row.id !== "P"));
    const cleared = service.edit("ep", { operationId: "crud-remove-replacement-clear", expectedRevision: replacement.revision, ops: [{ type: "delete_director_subject", id: "SUB_P2", referenceAction: "clear" }] });
    const clearedSource = cleared.draft.director!.source as any;
    assert.equal(clearedSource.shots[0].subject_usages.length, 0);
    assert.deepEqual(clearedSource.shots[0].camera.attention_subject_ids, []);
    assert.equal(clearedSource.shots[0].keyframes[0].subjectIds.length, 0);
    assert.equal(clearedSource.shots[0].reference_requirements[0].subjectIds.length, 0);
    assert.equal(clearedSource.utterances.length, 0);
    assert.equal(clearedSource.shots[0].utterance_refs.length, 0);
    assert.equal(clearedSource.ledger.facts.length, 0);
    const next = service.edit("ep", { operationId: "crud-register-unused", expectedRevision: cleared.revision, ops: [{ type: "upsert_director_subject", subject: { id: "ENV", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "scene", id: "SCENE" }, pictureBindings: [] } }] });
    const deleted = service.edit("ep", { operationId: "crud-remove-unused", expectedRevision: next.revision, ops: [{ type: "delete_director_subject", id: "ENV" }] });
    assert.equal((deleted.draft.director!.source.subject_registry as any[]).some(row => row.id === "ENV"), false);
    assert.equal((deleted.draft.director!.source.scene_registry as any[])[0].id, "SCENE");
});

test("removing a referenced scene Subject can rebind its Shot and continuity references", t => {
    const service = fixture(t, true), director = directorV2(), source = director.source as any;
    source.scene_registry.push({ id: "SCENE2", name: "替代场景" });
    source.script_scenes.push({ id: "SCENE2", scene_id: "SCENE2", scene_name: "替代场景", text: "", beat_ids: [] });
    source.subject_registry.push(
        { id: "SUB_SCENE", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "scene", id: "SCENE" }, pictureBindings: [] },
        { id: "SUB_SCENE2", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "scene", id: "SCENE2" }, pictureBindings: [] },
    );
    source.shots[0].subject_usages.push({ subjectId: "SUB_SCENE", presentation: "state_context", pictureBindingIds: [], referencePurpose: [], continuityFactIds: ["F_SCENE"], stateRequirements: [] });
    source.shots[0].camera.attention_subject_ids.push("SUB_SCENE");
    source.shots[0].keyframes = [{ id: "KF_SCENE", assetId: "KF_SCENE", sourceNode: { projectId: "CANVAS_EP", nodeId: "KF_SCENE" }, selection: { mode: "latest_success" }, anchor: "opening", subjectIds: ["SUB_SCENE"], retain: [], exclude: [], requiredForSubmission: false }];
    source.shots[0].reference_requirements = [{ id: "REF_SCENE", asset_id: "A1", asset_version: "v1", purpose: "构图参考", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" }, selection: { mode: "latest_success" }, retain: [], exclude: [], requiredForSubmission: false, subjectIds: ["SUB_SCENE"] }];
    source.ledger.facts.push({ id: "F_SCENE", object_kind: "scene", object_id: "SCENE", allowed_values: ["intact"], value_descriptions: { intact: "场景完整" } });
    source.ledger.initial.push({ id: "I_SCENE", timeline_id: "main", fact_id: "F_SCENE", value: "intact" });
    director.sourceHash = directorHash(source);
    const saved = service.edit("ep", { operationId: "scene-subject-source", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const removed = service.edit("ep", { operationId: "scene-subject-rebind-delete", expectedRevision: saved.revision, ops: [{ type: "delete_director_subject", id: "SUB_SCENE", referenceAction: "replace", replacementSubjectId: "SUB_SCENE2" }] });
    const result = removed.draft.director!.source as any;
    assert.ok(result.subject_registry.every((subject: any) => subject.id !== "SUB_SCENE"));
    assert.equal(result.shots[0].scene_id, "SCENE2");
    assert.equal(result.shots[0].subject_usages[1].subjectId, "SUB_SCENE2");
    assert.deepEqual(result.shots[0].camera.attention_subject_ids, ["P", "SUB_SCENE2"]);
    assert.deepEqual(result.shots[0].keyframes[0].subjectIds, ["SUB_SCENE2"]);
    assert.deepEqual(result.shots[0].reference_requirements[0].subjectIds, ["SUB_SCENE2"]);
    assert.equal(result.ledger.facts.find((fact: any) => fact.id === "F_SCENE").object_id, "SCENE2");
    assert.equal(result.ledger.initial.find((state: any) => state.id === "I_SCENE").fact_id, "F_SCENE");
});

test("binding reuse deduplicates identical semantics and rejects unknown Shot references", t => {
    let database!: BackendDatabase;
    const service = fixture(t, false, db => { database = db; }), d = directorV2();
    const source = d.source as any;
    const subject = source.subject_registry[0];
    const duplicate = { ...structuredClone(subject.pictureBindings[0]), id: "P_DUP" };
    subject.pictureBindings.push(duplicate);
    source.shots[0].subject_usages[0].pictureBindingIds = ["P_DUP"];
    d.sourceHash = directorHash(source);
    const saved = service.edit("ep", { operationId: "duplicate-bindings", expectedRevision: service.get("ep").revision,
        ops: [{ type: "set_director_production", director: d }] });
    assert.equal((service.get("ep").draft.director!.source.subject_registry as any[])[0].pictureBindings.length, 2, "read must preserve source identity and hash");
    const repaired = service.edit("ep", { operationId: "reuse-binding", expectedRevision: saved.revision,
        ops: [{ type: "upsert_director_subject", subject }] });
    assert.equal((repaired.draft.director!.source.subject_registry as any[])[0].pictureBindings.length, 1);
    assert.deepEqual((repaired.draft.director!.source.shots as any[])[0].subject_usages[0].pictureBindingIds, ["P_ID"]);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM production_clip_source_dependencies WHERE owner_id='ep'").get().count, 1);
    const unknown = structuredClone((repaired.draft.director!.source.shots as any[])[0].subject_usages);
    unknown[0].pictureBindingIds = ["MISSING_BINDING"];
    assert.throws(() => service.edit("ep", { operationId: "unknown-binding", expectedRevision: repaired.revision,
        ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { subject_usages: unknown } }] }), /MISSING_BINDING/);
    assert.equal(service.get("ep").revision, repaired.revision);
    const distinct = structuredClone((repaired.draft.director!.source.subject_registry as any[])[0]);
    distinct.pictureBindings.push({ ...structuredClone(distinct.pictureBindings[0]), id: "P_SIDE", retain: ["侧脸身份"], selection: { mode: "node_selection" }, defaultFor: [] });
    const preserved = service.edit("ep", { operationId: "distinct-semantics", expectedRevision: repaired.revision,
        ops: [{ type: "upsert_director_subject", subject: distinct }] });
    assert.equal((preserved.draft.director!.source.subject_registry as any[])[0].pictureBindings.length, 2, "same node with a different purpose must remain distinct");
});


test("optional Shot frame preview resolves node media without changing submission or formal source", t => {
    const service = fixture(t, true, (db, directory) => {
        const filePath = path.join(directory, "frame.png");
        fs.writeFileSync(filePath, Buffer.from("frame"));
        db.upsertMediaFile({ storageKey: "image:frame", filePath, mimeType: "image/png", bytes: 5, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "FRAME_NODE", nodeType: "config", title: "窝内分镜图", position: { x: 0, y: 0 }, width: 200, height: 200,
            metadata: { smart: true, generationMode: "image", images: [{ id: "frame", status: "success", storageKey: "image:frame", generationTaskSequence: 1 }] } }], { runtimeWrite: true });
    });
    const director = directorV2(), source = director.source as Record<string, any>;
    source.subject_registry[0].pictureBindings = [];
    source.shots[0].subject_usages[0].pictureBindingIds = [];
    source.shots[0].subject_usages[0].presentation = "state_context";
    source.segments[0].mode = source.segments[0].mode_lock = "T2VA";
    source.shots[0].keyframes = [{ id: "KF1", assetId: "KF1", sourceNode: { projectId: "CANVAS_EP", nodeId: "FRAME_NODE" }, selection: { mode: "node_selection" }, anchor: "at_frame", localFrame: 0, subjectIds: ["P"], retain: ["构图"], exclude: [], requiredForSubmission: false }];
    director.sourceHash = directorHash(source);
    const saved = service.edit("ep", { operationId: "optional-frame", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const before = JSON.stringify(saved.draft.director);
    const preview = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(preview.context.keyframeMedia[0].resolved?.storageKey, "image:frame");
    assert.equal(saved.draft.director!.source.shots[0].keyframes[0].requiredForSubmission, false);
    assert.equal(JSON.stringify(service.get("ep").draft.director), before);
    const submitted = service.resolveSubjectPictureInputs("ep", saved.draft.director!, ["C1"], true);
    assert.equal(submitted.assets.KF1, undefined);
});


test("manual Subject preview resolves an archived typed node before any Shot consumes the image, without saving a second asset source", t => {
    const storageKey = "manual:unused-character", bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7sAAAAASUVORK5CYII=", "base64");
    let database!: BackendDatabase;
    const service = fixture(t, true, (db, directory) => {
        database = db;
        const filePath = path.join(directory, "manual-character.png"); fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "character", position: { x: 0, y: 0 }, metadata: { characterName: "手工角色", characterImages: [{ storageKey, width: 1, height: 1 }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    });
    const director = directorV2(), source = director.source as any;
    source.shots[0].subject_usages[0].presentation = "state_context";
    source.shots[0].subject_usages[0].pictureBindingIds = [];
    source.shots[0].subject_usages[0].referencePurpose = [];
    source.subject_registry[0].pictureBindings[0].selection = { mode: "node_selection" };
    source.segments[0].mode = source.segments[0].mode_lock = "T2VA";
    director.modules.story = { status: "partial", evidence: [], unresolved: ["缺少 Backend story 验证回执"] };
    director.sourceHash = directorHash(source);
    service.edit("ep", { operationId: "manual-preview-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const before = JSON.stringify(service.get("ep"));
    const workbench = service.subjectWorkbench("ep", "P").subjectWorkbench;
    assert.equal(workbench.pictureBindings[0].resolved?.storageKey, storageKey, JSON.stringify({ resolutionDiagnostics: workbench.resolutionDiagnostics, binding: workbench.pictureBindings[0] }));
    assert.equal(JSON.stringify(service.get("ep")), before);
    const checked = service.workflowReadiness("ep");
    assert.equal(checked.canvasRevision, Number(database.getCanvasProject("CANVAS_EP")!.revision));
    assert.doesNotMatch(checked.nextAction, /先发布/);
    assert.equal(checked.unresolved.some(reason => reason.includes("story 验证回执")), false);
    assert.equal((service.get("ep").draft.director!.modules.story.unresolved)[0], "缺少 Backend story 验证回执");
});

test("first Subject registration binds its canonical entity node, replay and explicit unbinding preserve intent", t => {
    const service = fixture(t, true);
    const director = directorV2();
    service.edit("ep", { operationId: "auto-binding-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const subject = { id: "ENV_AUTO", kind: "scene" as const, entityRef: { ownerKind: "episode" as const, ownerId: "ep", kind: "scene" as const, id: "SCENE" }, pictureBindings: [] };
    const revision = service.get("ep").revision;
    const request = { operationId: "auto-register", expectedRevision: revision, ops: [{ type: "upsert_director_subject" as const, subject }] };
    const saved = service.edit("ep", request);
    const registered = (saved.draft.director!.source.subject_registry as any[]).find(row => row.id === subject.id);
    assert.equal(registered.pictureBindings.length, 1);
    const workbench = service.subjectWorkbench("ep", subject.id).subjectWorkbench;
    assert.deepEqual(registered.pictureBindings[0].sourceNode, { projectId: "CANVAS_EP", nodeId: workbench.entityNodeSource!.nodeId });
    assert.deepEqual(registered.pictureBindings[0].selection, { mode: "node_selection" });
    assert.equal(service.edit("ep", request).revision, saved.revision);
    const unbound = service.edit("ep", { operationId: "auto-unbind", expectedRevision: saved.revision, ops: [{ type: "upsert_director_subject", subject }] });
    assert.deepEqual((unbound.draft.director!.source.subject_registry as any[]).find(row => row.id === subject.id).pictureBindings, []);
});

test("an episode Subject can switch to another same-type registered canvas entity while Shots retain the Subject ID", t => {
    const service = fixture(t, true), director = directorV2();
    (director.source.character_registry as any[]).push({ id: "P2", name: "另一角色" });
    (director.source.asset_plan as any[]).push({ id: "A2", kind: "character", entity_id: "P2", asset_name: "另一角色", version: "v1", depends_on: [] });
    director.assets.A2 = { version: "v1", status: "planned" };
    director.sourceHash = directorHash(director.source);
    service.edit("ep", { operationId: "switch-subject-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const current = service.get("ep"), nodeId = productionLayoutStableId("production-entity", "episode", "ep", "character", "P2");
    const subject = (current.draft.director!.source.subject_registry as any[]).find(item => item.id === "P")!;
    const switched = service.edit("ep", { operationId: "switch-subject-entity", expectedRevision: current.revision, ops: [{ type: "upsert_director_subject", subject: {
        ...subject,
        entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P2" },
        pictureBindings: [{ id: "P2_ID", assetId: "A2", sourceNode: { projectId: "CANVAS_EP", nodeId }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["新角色身份"], exclude: [], applicableState: {}, defaultFor: ["identity"] }],
    } }] });
    const updated = (switched.draft.director!.source.subject_registry as any[]).find(item => item.id === "P");
    assert.equal(updated.entityRef.id, "P2");
    assert.equal((switched.draft.director!.source.ledger as any).facts[0].object_id, "P2");
    assert.deepEqual((switched.draft.director!.source.shots as any[])[0].subject_usages[0].pictureBindingIds, ["P2_ID"]);
    assert.deepEqual(service.subjectWorkbench("ep", "P").subjectWorkbench.entityNodeSource, { projectId: "CANVAS_EP", nodeId, kind: "character", entityId: "P2" });
    assert.throws(() => service.edit("ep", { operationId: "switch-subject-unregistered", expectedRevision: switched.revision, ops: [{ type: "upsert_director_subject", subject: {
        ...updated, entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "MISSING" },
    } }] }), /已登记的同类型画布实体/);
});

test("switching to an entity used by another Subject swaps bindings and preserves both Subjects' Shot references", t => {
    const service = fixture(t, true), director = directorV2(), source = director.source as any;
    source.character_registry.push({ id: "P2", name: "另一角色" });
    source.asset_plan.push({ id: "A2", kind: "character", entity_id: "P2", asset_name: "另一角色", version: "v1", depends_on: [] });
    source.subject_registry.push({ id: "OTHER", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P2" }, pictureBindings: [
        { id: "P2_ID", assetId: "A2", sourceNode: { projectId: "CANVAS_EP", nodeId: productionLayoutStableId("production-entity", "episode", "ep", "character", "P2") }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["other identity"], exclude: [], applicableState: {}, defaultFor: ["identity"] },
    ] });
    source.shots[0].subject_usages.push({ subjectId: "OTHER", presentation: "visible", pictureBindingIds: ["P2_ID"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] });
    director.assets.A2 = { version: "v1", status: "planned" };
    director.sourceHash = directorHash(source);
    service.edit("ep", { operationId: "swap-subject-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const current = service.get("ep"), subject = (current.draft.director!.source.subject_registry as any[]).find(item => item.id === "P")!;
    const selectedNode = productionLayoutStableId("production-entity", "episode", "ep", "character", "P2");
    const nextBinding = { id: "P_SELECTED_P2", assetId: "A2", sourceNode: { projectId: "CANVAS_EP", nodeId: selectedNode }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["selected identity"], exclude: [], applicableState: {}, defaultFor: ["identity"] };
    const saved = service.edit("ep", { operationId: "swap-subject-bindings", expectedRevision: current.revision, ops: [{ type: "upsert_director_subject", subject: { ...subject, entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P2" }, pictureBindings: [nextBinding] } }] });
    const subjects = saved.draft.director!.source.subject_registry as any[];
    assert.equal(subjects.find(item => item.id === "P")!.entityRef.id, "P2");
    assert.equal(subjects.find(item => item.id === "OTHER")!.entityRef.id, "P");
    assert.deepEqual((saved.draft.director!.source.shots as any[])[0].subject_usages[0].pictureBindingIds, ["P_SELECTED_P2"]);
    assert.deepEqual((saved.draft.director!.source.shots as any[])[0].subject_usages[1].pictureBindingIds, ["P_ID"]);
});

test("auto-bound character consumes the canonical node image without copying media into the Subject", t => {
    let database!: BackendDatabase;
    const storageKey = "auto-character-image";
    const service = fixture(t, true, (db, directory) => {
        database = db;
        const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7sAAAAASUVORK5CYII=", "base64");
        const filePath = path.join(directory, "auto-character.png"); fs.writeFileSync(filePath, bytes);
        db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
    });
    const director = directorV2();
    (director.source.character_registry as any[]).push({ id: "P_NEW", name: "New character" });
    director.sourceHash = directorHash(director.source);
    service.edit("ep", { operationId: "auto-character-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const nodeId = (database.getCanvasProject("CANVAS_EP")!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "P_NEW").id;
    database.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "update_node", id: nodeId, metadata: { characterImages: [{ storageKey, width: 1, height: 1 }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    const saved = service.edit("ep", { operationId: "auto-character-register", expectedRevision: service.get("ep").revision, ops: [{ type: "upsert_director_subject", subject: { id: "P_AUTO", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P_NEW" }, pictureBindings: [] } }] });
    const workbench = service.subjectWorkbench("ep", "P_AUTO").subjectWorkbench;
    assert.equal(workbench.pictureBindings.length, 1);
    assert.equal(workbench.pictureBindings[0].resolved?.storageKey, storageKey);
    assert.equal((saved.draft.director!.source.subject_registry as any[]).find(row => row.id === "P_AUTO").pictureBindings[0].storageKey, undefined);
});

test("character picture bindings resolve distinct stable keys and keep them across cover changes", t => {
    let database!: BackendDatabase;
    const keys = ["character-cover", "character-outfit", "character-scene-state"];
    const service = fixture(t, true, (db, directory) => {
        database = db;
        const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7sAAAAASUVORK5CYII=", "base64");
        for (const storageKey of keys) {
            const filePath = path.join(directory, `${storageKey}.png`);
            fs.writeFileSync(filePath, bytes);
            db.upsertMediaFile({ storageKey, filePath, mimeType: "image/png", bytes: bytes.length, width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
        }
        db.createCanvasProject({ id: "FOREIGN_CANVAS", title: "Unrelated canvas", nodes: [], connections: [] });
        db.applyCanvasProjectOperations("FOREIGN_CANVAS", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "character", position: { x: 0, y: 0 }, metadata: {
            characterImages: keys.map((storageKey, index) => ({ id: `image-${index}`, storageKey, url: `/media/${storageKey}.png`, outfit: `look-${index}` })), characterPrimaryIndex: 0,
        } }], { runtimeWrite: true });
        db.applyCanvasProjectOperations("CANVAS_EP", undefined, [{ type: "add_node", id: "IMAGE_P", nodeType: "character", position: { x: 0, y: 0 }, metadata: {
            characterImages: keys.map((storageKey, index) => ({ id: `image-${index}`, storageKey, url: `/media/${storageKey}.png`, outfit: `look-${index}` })), characterPrimaryIndex: 0,
        } }], { runtimeWrite: true });
    });
    const director = directorV2();
    const subject = (director.source.subject_registry as any[])[0];
    subject.pictureBindings.push({ id: "P_OUTFIT", assetId: "A2", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" },
        selection: { mode: "selected_result", resultId: "IMAGE_P:character-image:character-outfit" }, provides: ["clothing"], retain: ["clothing"], exclude: ["pose"], applicableState: {}, defaultFor: [] });
    subject.pictureBindings.push({ id: "P_COVER", assetId: "A3", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" },
        selection: { mode: "selected_result", resultId: "IMAGE_P:character-image:character-cover" }, provides: ["appearance"], retain: ["appearance"], exclude: [], applicableState: {}, defaultFor: [] });
    director.sourceHash = directorHash(director.source);
    service.edit("ep", { operationId: "character-multi-image-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });

    const firstRead = service.subjectWorkbench("ep", "P").subjectWorkbench;
    assert.deepEqual(Object.fromEntries(firstRead.pictureBindings.map((binding: any) => [binding.id, binding.resolved?.storageKey])), {
        P_ID: keys[0], P_OUTFIT: keys[1], P_COVER: keys[0],
    });

    const project = database.getCanvasProject("CANVAS_EP")!;
    database.applyCanvasProjectOperations("CANVAS_EP", Number(project.revision), [{ type: "update_node", id: "IMAGE_P", metadata: { characterPrimaryIndex: 2 } }], { runtimeWrite: true });
    const afterCoverChange = service.subjectWorkbench("ep", "P").subjectWorkbench;
    assert.deepEqual(Object.fromEntries(afterCoverChange.pictureBindings.map((binding: any) => [binding.id, binding.resolved?.storageKey])), {
        P_ID: keys[2], P_OUTFIT: keys[1], P_COVER: keys[0],
    });

    const badHashProject = database.getCanvasProject("CANVAS_EP")!;
    database.applyCanvasProjectOperations("CANVAS_EP", Number(badHashProject.revision), [{ type: "update_node", id: "IMAGE_P", metadata: {
        characterImages: keys.map((storageKey, index) => ({ id: `image-${index}`, storageKey, url: `/media/${storageKey}.png`, outfit: `look-${index}`, ...(index === 1 ? { sha256: "0".repeat(64) } : {}) })),
    } }], { runtimeWrite: true });
    const hashInput = structuredClone(director);
    (hashInput.source.shots as any[])[0].subject_usages[0].pictureBindingIds = ["P_ID", "P_OUTFIT", "P_COVER"];
    hashInput.sourceHash = directorHash(hashInput.source);

    const outfitMedia = database.getMediaFile(keys[1])!;
    database.upsertMediaFile({ ...outfitMedia, bytes: Number(outfitMedia.bytes) + 1 });
    assert.throws(() => service.resolveSubjectPictureInputs("ep", hashInput, undefined, false, ["P"]), /不一致/u);
    database.upsertMediaFile(outfitMedia);

    assert.throws(() => service.resolveSubjectPictureInputs("ep", hashInput, undefined, false, ["P"]), /图片来源记录的哈希与归档字节不一致/u);

    const invalid = structuredClone(director);
    (invalid.source.subject_registry as any[])[0].pictureBindings[1].selection.resultId = "foreign-image-key";
    invalid.sourceHash = directorHash(invalid.source);
    assert.throws(() => service.resolveSubjectPictureInputs("ep", invalid, undefined, false, ["P"]));

    const foreign = structuredClone(director);
    (foreign.source.subject_registry as any[])[0].pictureBindings[1].sourceNode.projectId = "FOREIGN_CANVAS";
    (foreign.source.shots as any[])[0].subject_usages[0].pictureBindingIds = ["P_OUTFIT"];
    foreign.sourceHash = directorHash(foreign.source);
    assert.throws(() => service.resolveSubjectPictureInputs("ep", foreign, undefined, false, ["P"]), (error: any) => error.diagnostics?.[0]?.code === "SUBJECT_IMAGE_NODE_OWNER");
});

test("v2 Shot saves existing picture bindings and keyframes through separate source operations", t => {
    const service = fixture(t, true), director = directorV2();
    const subject = (director.source.subject_registry as any[])[0];
    subject.pictureBindings.push({ id: "P_ALT", assetId: "A2", sourceNode: { projectId: "CANVAS_EP", nodeId: "IMAGE_P" },
        selection: { mode: "latest_success" }, provides: ["appearance"], retain: ["appearance"], exclude: [], applicableState: {}, defaultFor: [] });
    director.sourceHash = directorHash(director.source);
    const saved = service.edit("ep", { operationId: "v2-shot-reference-seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const shot = (director.source.shots as any[])[0];
    const keyframes = [{ id: "KF_S1", assetId: "KF_S1", sourceNode: { projectId: "CANVAS_EP", nodeId: "FRAME_NODE" }, selection: { mode: "latest_success" },
        anchor: "opening", subjectIds: ["P"], retain: ["composition"], exclude: [], requiredForSubmission: false }];
    service.edit("ep", { operationId: "v2-shot-reference-edit", expectedRevision: saved.revision, ops: [
        { type: "patch_director_source", entity: "shot", id: "S1", patch: { subject_usages: shot.subject_usages.map((usage: any) => ({ ...usage, pictureBindingIds: ["P_ALT"] })) } },
        { type: "set_director_shot_keyframes", shotId: "S1", keyframes },
    ] });
    const afterSave = service.get("ep").draft.director!;
    const savedUsage = (afterSave.source.shots as any[])[0].subject_usages[0];
    assert.deepEqual(savedUsage.pictureBindingIds, ["P_ALT"]);
    assert.deepEqual((afterSave.source.shots as any[])[0].keyframes, keyframes);

    service.edit("ep", { operationId: "v2-shot-keyframe-clear", expectedRevision: service.get("ep").revision, ops: [
        { type: "patch_director_source", entity: "shot", id: "S1", patch: { subject_usages: [{ ...savedUsage, pictureBindingIds: [] }] } },
        { type: "set_director_shot_keyframes", shotId: "S1", keyframes: [] },
    ] });
    const afterClear = service.get("ep").draft.director!;
    const clearedUsage = (afterClear.source.shots as any[])[0].subject_usages[0];
    assert.deepEqual(clearedUsage.pictureBindingIds, []);
    assert.deepEqual(resolveSubjectPictureBindingIds((afterClear.source.subject_registry as any[])[0], clearedUsage).bindingIds, ["P_ID"]);
    assert.deepEqual((afterClear.source.shots as any[])[0].keyframes, []);

    service.edit("ep", { operationId: "v2-shot-reference-zero", expectedRevision: service.get("ep").revision, ops: [
        { type: "patch_director_source", entity: "shot", id: "S1", patch: { subject_usages: [{ ...clearedUsage, pictureBindingMode: "explicit", pictureBindingIds: [] }] } },
    ] });
    const explicitClear = service.shotWorkbench("ep", "S1").shotWorkbench;
    const explicitUsage = (service.get("ep").draft.director!.source.shots as any[])[0].subject_usages[0];
    const explicitSubject = (service.get("ep").draft.director!.source.subject_registry as any[])[0];
    assert.equal(explicitUsage.pictureBindingMode, "explicit");
    assert.deepEqual(explicitUsage.pictureBindingIds, []);
    assert.deepEqual(explicitClear.context.resolvedSubjectUsages[0].pictureBindings, []);
    assert.deepEqual(resolveSubjectPictureBindingIds(explicitSubject, explicitUsage).bindingIds, []);
    assert.deepEqual((service.get("ep").draft.director!.source.subject_registry as any[])[0].pictureBindings.map((binding: any) => binding.id).sort(), ["P_ALT", "P_ID"]);
});
