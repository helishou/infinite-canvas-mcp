import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directorModules, directorProductionSchema, productionWriteReceipt, projectProductionRead, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { directorHash } from "./director.js";
import { ClipRefreshCoordinator } from "./clip-refresh.js";

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
        prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
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
    const shot = projectProductionRead(service.shotWorkbench("ep", "S1"), { view: "shot_workbench", targetIds: ["S1"] });
    const clipReadStartedAt = performance.now();
    const clip = projectProductionRead(service.clipWorkbench("ep", "C1"), { view: "clip_workbench", targetIds: ["C1"] });
    const clipReadElapsedMs = performance.now() - clipReadStartedAt;
    assert.equal(subject.revision, shot.revision);
    assert.equal(shot.revision, clip.revision);
    assert.equal((subject.workbench as any).subject.id, "P");
    assert.equal((shot.workbench as any).shot.id, "S1");
    assert.deepEqual((shot.workbench as any).continuity.start.map((item: any) => item.factId), ["F1"]);
    assert.deepEqual((clip.workbench as any).segment.shot_ids, ["S1"]);
    assert.deepEqual((clip.workbench as any).continuity.facts.map((item: any) => item.id), ["F1"]);
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
            metadata: { smart: true, generationMode: "image", prompt: "Current prompt", model: "Current model", primaryImageId: "old",
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
    const current = projectProductionRead(service.shotWorkbench("ep", "S1"), { view: "shot_workbench", targetIds: ["S1"] }).workbench as any;
    assert.deepEqual(current.resolutionDiagnostics, []);
    assert.deepEqual(current.directorArtifacts, [{ id: "COMPILED_C1", status: "ready", sha256, current: true }]);
    assert.equal(Object.hasOwn(current.directorArtifacts[0], "prompt"), false);
    service.edit("ep", { operationId: "invalidate-compiler-status", expectedRevision: saved.revision, ops: [{ type: "patch_director_source", entity: "shot", id: "S1", patch: { visual: "The character steps away." } }] });
    const changed = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(changed.directorArtifacts[0].current, false);
});

test("unresolved image bindings do not advertise a ready Prompt as current", t => {
    const service = fixture(t, true), director = directorV2();
    const prompt = "Listen outside.", sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
    director.artifacts = [{ id: "COMPILED_C1", kind: "h3", targetId: "C1", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, validator: "compile_h3/validate_package",
            diagnostics: { accepted: true, formatPass: "PASSED", detailPolicy: { minimum_words: 0 } } } }];
    service.edit("ep", { operationId: "save-missing-reference", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const read = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(read.resolutionDiagnostics[0].code, "SUBJECT_IMAGE_NODE_INVALID");
    assert.equal(read.directorArtifacts[0].current, false);
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
    assert.equal(read.resolutionDiagnostics[0].code, "SUBJECT_IMAGE_NODE_INVALID");
    assert.equal(read.directorArtifacts[0].current, true);
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
        metadata: { segments: [{ id: "PHYSICAL_C1", prompt, duration: 2, productionClipProjection: { targetId: "C1" } }] } }], { runtimeWrite: true });
    service.edit("ep", { operationId: "bind-reverse-target", expectedRevision: service.get("ep").revision, ops: [{ type: "bind_director_segment", targetId: "C1", nodeId: "VIDEO", segmentId: "PHYSICAL_C1" }] });
    const editedPrompt = prompt.replace("looks toward", "listens beside");
    const canvas = database.applyCanvasProjectOperations("CANVAS_EP", Number(database.getCanvasProject("CANVAS_EP")!.revision), [{ type: "update_h3_segment", nodeId: "VIDEO", segmentId: "PHYSICAL_C1", patch: { prompt: editedPrompt } }], { operationId: "manual-prompt" });
    const before = service.get("ep");
    const request = { operationId: "reverse-source-target", expectedRevision: before.revision, ops: [{ type: "reverse_sync_director_prompt", segmentId: "C1", artifactId: "ART_C1", sourceHash: before.draft.director!.sourceHash, basePromptHash: sha256, prompt: editedPrompt, canvasRevision: canvas.revision }] };
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
    const next = service.edit("ep", { operationId: "crud-register-unused", expectedRevision: named.revision, ops: [{ type: "upsert_director_subject", subject: { id: "ENV", kind: "scene", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "scene", id: "SCENE" }, pictureBindings: [] } }] });
    const deleted = service.edit("ep", { operationId: "crud-remove-unused", expectedRevision: next.revision, ops: [{ type: "delete_director_subject", id: "ENV" }] });
    assert.equal((deleted.draft.director!.source.subject_registry as any[]).some(row => row.id === "ENV"), false);
    assert.equal((deleted.draft.director!.source.scene_registry as any[])[0].id, "SCENE");
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
    source.shots[0].keyframes = [{ id: "KF1", assetId: "KF1", sourceNode: { projectId: "CANVAS_EP", nodeId: "FRAME_NODE" }, selection: { mode: "node_selection" }, anchor: "at_frame", localFrame: 0, subjectIds: ["P"], retain: ["构图"], exclude: [], requiredForSubmission: false }];
    director.sourceHash = directorHash(source);
    const saved = service.edit("ep", { operationId: "optional-frame", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director }] });
    const before = JSON.stringify(saved.draft.director);
    const preview = service.shotWorkbench("ep", "S1").shotWorkbench;
    assert.equal(preview.keyframes[0].resolved?.storageKey, "image:frame");
    assert.equal(preview.keyframes[0].requiredForSubmission, false);
    assert.equal(JSON.stringify(service.get("ep").draft.director), before);
    const submitted = service.resolveSubjectPictureInputs("ep", saved.draft.director!, ["C1"], true);
    assert.equal(submitted.assets.KF1, undefined);
});

