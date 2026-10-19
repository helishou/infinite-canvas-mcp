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
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";
import { EpisodeProductionRunner } from "./production-runner.js";
import { ProductionCompilationService } from "./compilation.js";
import { ensureProductionCanvas, productionCanvasContext } from "./production-canvas.js";
import { SharedAssetCoordinator, listApprovedSharedAssets, sharedProjectionNodeId, validateSharedAssetSource } from "./shared-assets.js";
import { directorHash, projectDirector, promptHash, publicProductionRecord } from "./director.js";
import { decodeReceipt } from "./receipt-storage.js";
import { createManualDirectorAsset as createManualDirectorAssetSource } from "./director-asset-delete.js";
import { productionScriptNodes } from "./script-nodes.js";
import { NativeProductionGeneration } from "./native-generation.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { compilationScopeInput, currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import type { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";
import { directorSourceV2Diagnostics, emptyEpisodeProduction, productionEditSchema, productionWriteReceipt } from "@basketikun/canvas-agent/drama/production-contract";
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
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, style_policy: "waived", style_policy_reason: "one existing identity reference",
        subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }], script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "First visit", beat_ids: ["b1"] }, { id: "night", scene_id: "room", scene_name: "Night", text: "Return", beat_ids: ["b2"] }],
        asset_plan: [{ asset_id: "ROLE", asset_name: "Character", version: "v1", depends_on: [] }, { asset_id: "FRAME", asset_name: "Opening frame", version: "v1", depends_on: ["ROLE"] }],
        shots: [{ id: "s1", title: "Entrance", scene_id: "room", story_beat_ids: ["b1"], story_order: 0, duration_frames: 120, visual: "Enter", camera: "static" },
            { id: "s2", title: "Return", scene_id: "room", story_beat_ids: ["b2"], story_order: 1, duration_frames: 120, visual: "Return", camera: "static" }],
        segments: [{ id: "seg1", shot_ids: ["s1"], mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], mode: "T2VA" }], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
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
function addManualScriptNodes(f: ReturnType<typeof fixture>, canvasId: string) {
    const owner = { kind: "episode" as const, id: "ep" };
    const scripts = productionScriptNodes(f.episode.get("ep").draft, owner);
    const project = f.db.getCanvasProject(canvasId)!;
    f.db.applyCanvasProjectOperations(canvasId, Number(project.revision || 0), scripts.map((script, index) => ({
        type: "add_node", id: script.id, nodeType: "text", title: script.title,
        position: { x: index * 640, y: 0 }, width: 560, height: 320,
        metadata: { content: script.content, status: "success", productionScriptId: script.scriptId, productionScriptSceneId: script.sceneId },
    })), { runtimeWrite: true });
    return (f.db.getCanvasProject(canvasId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId);
}
// Old persisted productions can predate automatic canvas materialization during edits.
// Seed that storage state directly so preparation tests still exercise first binding.
function seedUnboundEpisode(f: ReturnType<typeof fixture>, id = "ep", d = director()) {
    const draft = emptyEpisodeProduction();
    draft.director = structuredClone(d);
    projectDirector(draft);
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 1, ?, NULL, 0, ?)")
        .run(id, JSON.stringify(draft), new Date().toISOString());
    assert.equal(f.db.getDramaEpisode(id)!.canvasId, null);
}
function publish(service: EpisodeProductionService, id: string) {
    return service.publish(id, { operationId: crypto.randomUUID(), expectedRevision: service.get(id).revision, stage: "director" });
}

test("shared character changes immediately refresh linked H3 references without changing prompt or output", t => {
    const f = fixture(t), shared = ensureProductionCanvas(f.db, "shared-assets", "drama");
    const episodeCanvas = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "shared-character", nodeType: "character", title: "共享人物", position: { x: 0, y: 0 }, width: 240, height: 320,
        metadata: { productionEntity: { ownerKind: "canvas", ownerId: shared.project.id, kind: "character", entityId: "CANON_CHARACTER" }, characterName: "共享人物", characterImages: [{ id: "old-image", storageKey: "image:old", url: "/media/old.png", name: "身份图" }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    save(f.episode, "ep", director());
    const current = f.episode.get("ep");
    const sharedSource = { dramaId: "drama", assetId: "SHARED_CHARACTER", sourceProjectId: shared.project.id, sourceNodeId: "shared-character" };
    const createAsset: any = { type: "create_manual_director_asset", assetPlan: { id: "SHARED_CHARACTER", kind: "character", asset_name: "共享人物", entity_id: "CHAR_SHARED", version: "v1", description: "角色身份", purpose: "共享角色", depends_on: [], status: "planned", canvas_scope: "episode", sharedSource },
        assetCard: { id: "SHARED_CHARACTER", asset_id: "SHARED_CHARACTER", asset_kind: "character", asset_version: "v1", prompt: "", references: [] }, registryKind: "character",
        registryEntity: { id: "CHAR_SHARED", name: "共享人物", description: "角色身份", appearance: "角色身份" },
        subject: { id: "SUB_SHARED", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "CHAR_SHARED" }, pictureBindings: [] } };
    const added = f.episode.edit("ep", { operationId: "add-shared-character-for-h3-sync", expectedRevision: current.revision, ops: [createAsset] });
    const entityNode = (f.db.getCanvasProject(episodeCanvas)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED");
    const pictureBinding = added.draft.director!.source.subject_registry.find((subject: any) => subject.id === "SUB_SHARED")!.pictureBindings[0];
    const clip = { id: "shared-clip", prompt: "Keep <Picture 1> as the identity reference.", duration: 5, taskMode: "ref2va", status: "success", resultStorageKey: "video:old",
        referenceBindings: [{ id: "shared-ref", assetId: "shared-ref", label: "<Picture 1>", role: "character_identity", tags: [], enabled: false, usage: "reference", mediaType: "image", sourceNodeId: entityNode.id, subjectId: "SUB_SHARED", pictureBindingId: pictureBinding.id, storageKey: "image:old" }],
        h3CharacterGroups: { character: { id: "character", characterNodeId: entityNode.id, subjectId: "SUB_SHARED", characterName: "共享人物", characterAssetId: "SHARED_CHARACTER", outfits: [{ id: "outfit", name: "身份图", role: "character_identity", enabled: true, sourceNodeId: entityNode.id, subjectId: "SUB_SHARED", pictureBindingId: pictureBinding.id, storageKey: "image:old", url: "/media/old.png" }] } },
        productionClipProjection: { fieldHashes: {} } };
    f.db.applyCanvasProjectOperations(episodeCanvas, undefined, [{ type: "add_node", id: "h3-shared", nodeType: "minimax-h3:video", title: "H3", position: { x: 600, y: 0 }, width: 620, height: 500,
        metadata: { ...createH3NodeMetadata({}, { segments: [clip] }), productionOwnerKind: "episode", productionOwnerId: "ep" } }]);

    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "update_node", id: "shared-character", metadata: { characterImages: [{ id: "new-image", storageKey: "image:new", url: "/media/new.png", name: "新版身份图" }], characterPrimaryIndex: 0 } }]);

    const synced = (f.db.getCanvasProject(episodeCanvas)!.nodes as any[]).find(node => node.id === "h3-shared").metadata.segments[0];
    assert.equal(synced.referenceBindings[0].storageKey, "image:new");
    assert.equal(synced.referenceBindings[0].enabled, true, "shared-derived references replace a manual H3 disable");
    assert.equal(synced.h3CharacterGroups.character.outfits[0].storageKey, "image:new");
    assert.equal(synced.prompt, clip.prompt);
    assert.equal(synced.duration, clip.duration);
    assert.equal(synced.resultStorageKey, "video:old");
    assert.equal(synced.inputOutdated, true);
});

test("Acheng v2 storage keeps source as the only authored storyboard and explicitly deduplicates clean historical mirrors", t => {
    const f = fixture(t);
    ensureProductionCanvas(f.db, "episode", "ep");
    const saved = save(f.episode, "ep", director());
    const stored = JSON.parse((f.db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id='ep'").get() as any).draft_json);
    assert.equal(Object.hasOwn(stored, "scenes"), false);
    assert.equal(Object.hasOwn(stored, "shots"), false);
    assert.equal(Object.hasOwn(stored, "clipGroups"), false);
    assert.equal(saved.draft.shots.length, 2, "legacy projection remains an in-memory compatibility view");

    publish(f.episode, "ep");
    const projectedRecord = f.episode.get("ep");
    const dualWrite = (snapshot: any) => ({ ...snapshot, director: structuredClone(snapshot.director) });
    f.db.db.prepare("UPDATE episode_productions SET draft_json=?, published_json=? WHERE episode_id='ep'")
        .run(JSON.stringify(dualWrite(projectedRecord.draft)), JSON.stringify(dualWrite(projectedRecord.published)));
    const before = (f.db.db.prepare("SELECT draft_json, revision FROM episode_productions WHERE episode_id='ep'").get() as any);
    const report = f.episode.inspectSingleSourceStorage("ep");
    const afterInspect = (f.db.db.prepare("SELECT draft_json, revision FROM episode_productions WHERE episode_id='ep'").get() as any);
    assert.deepEqual(report, { episodeId: "ep", revision: before.revision, status: "ready", blockers: [] });
    assert.equal(afterInspect.draft_json, before.draft_json, "inspection must not write");
    const sourceHash = f.episode.get("ep").draft.director!.sourceHash;
    const applied = f.episode.applySingleSourceStorage("ep", before.revision, "dedupe-v2-source");
    assert.equal(applied.revision, before.revision + 1);
    assert.equal(applied.draft.director!.sourceHash, sourceHash);
    const canonical = f.db.db.prepare("SELECT draft_json, published_json FROM episode_productions WHERE episode_id='ep'").get() as any;
    for (const raw of [canonical.draft_json, canonical.published_json]) for (const field of ["scenes", "shots", "clipGroups"]) assert.equal(Object.hasOwn(JSON.parse(raw), field), false);
    assert.throws(() => f.episode.applySingleSourceStorage("ep", before.revision, "stale-v2-source"), /revision|版本/i);
});

test("v2 mirror migration judges information loss, not byte equality: key order and newly derived fields never block, real conflicts do", t => {
    const f = fixture(t);
    ensureProductionCanvas(f.db, "episode", "ep");
    save(f.episode, "ep", director());
    publish(f.episode, "ep");
    const projectedRecord = f.episode.get("ep");
    // 深拷贝整份草稿：shallow spread 会让 draft.shots 与基线共享引用，
    // 上一步的改动会渗进下一步的「干净基线」。
    const dualWrite = (snapshot: any) => structuredClone(snapshot);
    const writeMirror = (mutate?: (draft: any) => void) => {
        const draft = dualWrite(projectedRecord.draft);
        mutate?.(draft);
        f.db.db.prepare("UPDATE episode_productions SET draft_json=?, published_json=NULL WHERE episode_id='ep'")
            .run(JSON.stringify(draft));
    };

    // (1) 仅键序不同：早期 dialogue block 写作 {id,kind,text,speaker}，投影产 {id,kind,speaker,text}。
    //     值完全一致 → 不得阻塞（JSON.stringify 指纹会误判，这正是迁移死锁的成因）。
    writeMirror(draft => {
        const block: any = draft.scenes?.[0]?.blocks?.[0];
        if (block) draft.scenes[0].blocks[0] = { id: block.id, kind: block.kind, text: block.text, ...(block.speaker ? { speaker: block.speaker } : {}) };
    });
    assert.equal(f.episode.inspectSingleSourceStorage("ep").status, "ready", "key-order-only differences must not block migration");

    // (2) 投影新增派生字段（镜像里没有）：删掉镜像不丢信息 → 放行。
    writeMirror(draft => {
        for (const shot of draft.shots || []) { delete shot.characters; delete shot.startFrame; delete shot.endFrame; delete shot.stateUnresolved; }
    });
    assert.equal(f.episode.inspectSingleSourceStorage("ep").status, "ready", "fields the projection derives must not block migration");

    // (3) 真冲突：镜像里值与 source 投影不一致 → 必须阻塞。
    writeMirror(draft => { if (draft.shots?.[0]) draft.shots[0].title = "被篡改的标题"; });
    const conflicted = f.episode.inspectSingleSourceStorage("ep");
    assert.equal(conflicted.status, "blocked", "a value that disagrees with the source must block");
    assert.ok(conflicted.blockers.some(b => b.includes("title")), `expected a title conflict, got ${JSON.stringify(conflicted.blockers)}`);

    // (4) 真丢信息：镜像含投影不产出的 Shot（例如 source 已删、镜像还留着）
    //     → 去重会把这些内容一并抹掉，必须阻塞。
    writeMirror(draft => {
        const template = draft.shots?.[0];
        if (template) draft.shots.push({ ...structuredClone(template), id: "s-mirror-only", sceneId: template.sceneId });
    });
    const lossy = f.episode.inspectSingleSourceStorage("ep");
    assert.equal(lossy.status, "blocked", "a Shot the projection cannot produce must block because dedup would lose it");
    assert.ok(lossy.blockers.some(b => b.includes("shots")), `expected a shots blocker, got ${JSON.stringify(lossy.blockers)}`);
});

test("Acheng Segment Canvas lookup requires one owner-bound target and blocks ambiguous runtime association", t => {
    const f = fixture(t);
    ensureProductionCanvas(f.db, "episode", "ep");
    save(f.episode, "ep", director());
    const canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    const project = f.db.getCanvasProject(canvasId)!;
    const sourceHash = f.episode.get("ep").draft.director!.sourceHash;
    assert.equal(f.episode.resolveDirectorSegmentRuntime("ep", "not-present").status, "missing");
    const target = (project.nodes as any[]).flatMap(node => (node.metadata?.segments || []).map((segment: any) => ({ node, segment })))
        .find(item => item.segment.productionClipProjection?.targetId === "seg1");
    assert.ok(target, "source Segment is projected to its owner Canvas");
    assert.equal(f.episode.resolveDirectorSegmentRuntime("ep", "seg1").status, "resolved");
    f.db.applyCanvasProjectOperations(canvasId, project.revision, [{ type: "add_node", id: "duplicate-segment-owner", nodeType: target.node.type, title: "duplicate", position: { x: 800, y: 800 }, width: target.node.width, height: target.node.height,
        metadata: { ...target.node.metadata, segments: [{ ...target.segment, id: "duplicate-segment-id" }] } }], { runtimeWrite: true });
    assert.equal(f.episode.resolveDirectorSegmentRuntime("ep", "seg1").status, "ambiguous");
    assert.equal(f.episode.get("ep").draft.director!.sourceHash, sourceHash, "runtime ambiguity must not change authored source");
});

test("ordinary reads reject a legacy Director format while explicit prepared-v2 migration uses the revision transaction", t => {
    const f = fixture(t), legacy = director();
    legacy.source.version = 1;
    (legacy.source.ledger as any).contract_version = 1;
    legacy.sourceHash = directorHash(legacy.source);
    const draft = emptyEpisodeProduction(); draft.director = legacy;
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 7, ?, ?, 3, ?)")
        .run("ep", JSON.stringify(draft), JSON.stringify(draft), new Date().toISOString());
    assert.throws(() => f.episode.get("ep"), /UNSUPPORTED_PRODUCTION_FORMAT|旧版 Acheng/);
    const migrated = f.episode.migrateSubjectPromptV2("ep", 7, "prepared-v2-source", director().source as Record<string, unknown>);
    assert.equal(migrated.revision, 8);
    const current = f.episode.get("ep");
    assert.equal(current.storageFormat, "v2-single-source", "a preserved legacy published snapshot is not a v2 mirror");
    assert.equal(current.publishedFormatStatus, "legacy-maintenance-required");
    assert.equal(publicProductionRecord(current).published, null, "ordinary API payloads do not expose the old Director snapshot");
    assert.equal(current.publishedVersion, 3, "the historical version identity is preserved");
    const stored = JSON.parse((f.db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id='ep'").get() as any).draft_json);
    assert.equal(stored.director.source.version, 2);
    assert.equal(Object.hasOwn(stored, "shots"), false);
});

test("episode asset registration creates an identity-bound shared reference and removal keeps its source", t => {
    const f = fixture(t), shared = ensureProductionCanvas(f.db, "shared-assets", "drama");
    ensureProductionCanvas(f.db, "episode", "ep");
    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "shared-person", nodeType: "character", title: "共享人物", position: { x: 80, y: 90 }, width: 240, height: 320,
        metadata: { productionEntity: { ownerKind: "canvas", ownerId: shared.project.id, kind: "character", entityId: "CANON_PERSON" }, characterName: "共享人物", characterDescription: "蓝色长发", characterImages: [{ storageKey: "image:shared-person", name: "共享人物身份图", width: 512, height: 768, bytes: 123, mimeType: "image/png" }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    save(f.episode, "ep", director());
    const current = f.episode.get("ep");
    const operation: any = { type: "create_manual_director_asset", assetPlan: { id: "AST_SHARED_PERSON", kind: "character", asset_name: "共享人物", entity_id: "CHAR_SHARED_PERSON", version: "v1", description: "蓝色长发", purpose: "剧目共享资产", depends_on: [], status: "planned", canvas_scope: "episode",
        sharedSource: { dramaId: "drama", assetId: "AST_SHARED_PERSON", sourceProjectId: shared.project.id, sourceNodeId: "shared-person" } },
        assetCard: { id: "AST_SHARED_PERSON", asset_id: "AST_SHARED_PERSON", asset_kind: "character", asset_version: "v1", prompt: "", references: [] }, registryKind: "character",
        registryEntity: { id: "CHAR_SHARED_PERSON", name: "共享人物", description: "蓝色长发", appearance: "蓝色长发" },
        subject: { id: "SUBJECT_SHARED_PERSON", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "CHAR_SHARED_PERSON" }, pictureBindings: [] } };
    const manualProbe = structuredClone(current.draft.director!);
    createManualDirectorAssetSource(manualProbe, operation, { kind: "episode", id: "ep" });
    assert.equal((manualProbe.source.character_registry as any[]).some(item => item.id === "CHAR_SHARED_PERSON"), true);
    assert.deepEqual(directorSourceV2Diagnostics(manualProbe.source as any).filter(issue => issue.message.includes("Subject 必须")), []);
    const parsedOperation = productionEditSchema.parse({ operationId: "probe-shared", expectedRevision: current.revision, ops: [operation] }).ops[0] as any;
    assert.equal(parsedOperation.registryEntity.id, "CHAR_SHARED_PERSON");
    const added = f.episode.edit("ep", { operationId: "include-shared-person", expectedRevision: current.revision, ops: [operation] });
    const plan = added.draft.director!.source.asset_plan.find((item: any) => item.id === "AST_SHARED_PERSON") as any;
    const projectId = f.db.getDramaEpisode("ep")!.canvasId!;
    const ref = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED_PERSON");
    const registeredSubject = added.draft.director!.source.subject_registry.find((subject: any) => subject.id === "SUBJECT_SHARED_PERSON") as any;
    assert.equal(plan.sharedSource.sourceNodeId, "shared-person");
    assert.equal(added.draft.director!.source.asset_cards.find((card: any) => card.id === "AST_SHARED_PERSON")?.reference_policy, "none");
    assert.equal(registeredSubject.pictureBindings.length, 1);
    assert.deepEqual(registeredSubject.pictureBindings[0].sourceNode, { projectId, nodeId: ref.id });
    assert.equal(registeredSubject.pictureBindings[0].assetId, "AST_SHARED_PERSON");
    assert.equal(ref.metadata.sharedAssetReference.writeThrough, true);
    assert.equal(ref.metadata.sharedAssetReference.sourceProjectId, shared.project.id);
    assert.equal(f.db.getAssetRecord("AST_SHARED_PERSON")!.metadata.sharedAssetSource.sourceNodeId, "shared-person");
    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "update_node", id: "shared-person", metadata: { characterImages: [{ storageKey: "image:shared-person-v2", name: "共享人物身份图 v2", width: 640, height: 960, bytes: 456, mimeType: "image/png" }], characterPrimaryIndex: 0 } }]);
    assert.equal((f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === ref.id).metadata.characterImages[0].storageKey, "image:shared-person-v2");
    const duplicate = f.episode.edit("ep", { operationId: "include-shared-person-again", expectedRevision: added.revision, ops: [operation] });
    assert.equal(duplicate.draft.director!.source.asset_plan.filter((item: any) => item.id === "AST_SHARED_PERSON").length, 1);
    assert.equal((f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED_PERSON").length, 1);
    f.episode.edit("ep", { operationId: "clear-shared-picture-binding", expectedRevision: duplicate.revision, ops: [{ type: "upsert_director_subject", subject: { ...registeredSubject, pictureBindings: [] } }] });
    const generation = { run: () => { throw new Error("Picture binding preparation must not submit media"); } } as unknown as CanvasGenerationService;
    const runner = new EpisodeProductionRunner(f.episode, f.stores, generation);
    const repaired = runner.prepareTargets("ep", f.episode.get("ep").revision, ["entity:character:CHAR_SHARED_PERSON"], "repair-shared-picture-binding");
    assert.equal(repaired.draft.director!.source.subject_registry.find((subject: any) => subject.id === "SUBJECT_SHARED_PERSON")!.pictureBindings.length, 1);

    ensureProductionCanvas(f.db, "episode", "ep2");
    save(f.episode, "ep2", director());
    const ep2Operation = structuredClone(operation);
    ep2Operation.subject.entityRef.ownerId = "ep2";
    f.episode.edit("ep2", { operationId: "include-shared-person-ep2", expectedRevision: f.episode.get("ep2").revision, ops: [ep2Operation] });
    const ep2Canvas = f.db.getDramaEpisode("ep2")!.canvasId!;
    f.episode.edit("ep", { operationId: "shared-asset-page-edit", expectedRevision: f.episode.get("ep").revision,
        ops: [{ type: "patch_director_source", entity: "character", id: "CHAR_SHARED_PERSON", patch: { name: "资产页修改名", appearance: "资产页修改说明" } }] });
    assert.equal((f.db.getCanvasProject(shared.project.id)!.nodes as any[]).find(node => node.id === "shared-person").title, "资产页修改名");
    assert.equal(f.episode.get("ep2").draft.director!.source.character_registry[0].appearance, "资产页修改说明");
    const currentEpisodeEntity = f.episode.get("ep").draft.director!.source.character_registry[0] as any;
    const currentEpisodeNode = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === ref.id);
    assert.equal(currentEpisodeEntity.name, currentEpisodeNode.title);
    assert.equal(currentEpisodeEntity.name, currentEpisodeNode.metadata.characterName);
    f.db.applyCanvasProjectOperations(projectId, undefined, [{ type: "update_node", id: ref.id, patch: { title: "本集编辑名" }, metadata: { characterDescription: "本集编辑说明" } }]);
    assert.equal((f.db.getCanvasProject(shared.project.id)!.nodes as any[]).find(node => node.id === "shared-person").title, "本集编辑名");
    assert.equal(f.episode.get("ep2").draft.director!.source.character_registry[0].appearance, "本集编辑说明");
    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "update_node", id: "shared-person", patch: { title: "共享人物新名" }, metadata: { characterDescription: "黑色短发" } }]);
    assert.equal(f.episode.get("ep").draft.director!.source.character_registry[0].name, "共享人物新名");
    assert.equal(f.episode.get("ep2").draft.director!.source.character_registry[0].appearance, "黑色短发");
    assert.equal((f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED_PERSON").metadata.characterDescription, "黑色短发");
    assert.equal((f.db.getCanvasProject(ep2Canvas)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED_PERSON").title, "共享人物新名");
    const ep2ReferenceId = (f.db.getCanvasProject(ep2Canvas)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_SHARED_PERSON").id;
    f.db.applyCanvasProjectOperations(ep2Canvas, undefined, [{ type: "delete_node", id: ep2ReferenceId }]);
    assert.equal(f.episode.get("ep2").draft.director!.source.asset_plan.some((item: any) => item.id === "AST_SHARED_PERSON"), false);
    assert.ok((f.db.getCanvasProject(shared.project.id)!.nodes as any[]).some(node => node.id === "shared-person"));

    const removed = f.episode.edit("ep", { operationId: "remove-shared-person", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "remove_shared_director_asset", id: "AST_SHARED_PERSON" }] });
    const repeatedRemoval = f.episode.edit("ep", { operationId: "remove-shared-person-again", expectedRevision: removed.revision, ops: [{ type: "remove_shared_director_asset", id: "AST_SHARED_PERSON" }] });
    assert.equal(repeatedRemoval.draft.director!.source.asset_plan.some((item: any) => item.id === "AST_SHARED_PERSON"), false);
    assert.equal((f.db.getCanvasProject(projectId)!.nodes as any[]).some(node => node.id === ref.id), false);
    assert.ok((f.db.getCanvasProject(shared.project.id)!.nodes as any[]).some(node => node.id === "shared-person"));
    assert.ok(f.db.getAssetRecord("AST_SHARED_PERSON"), "removing a usage does not delete its shared source record");
});

test("switching a Subject directly to an unregistered shared node includes it and binds its live reference atomically", t => {
    const f = fixture(t), shared = ensureProductionCanvas(f.db, "shared-assets", "drama");
    ensureProductionCanvas(f.db, "episode", "ep");
    f.db.applyCanvasProjectOperations(shared.project.id, undefined, [{ type: "add_node", id: "shared-person", nodeType: "character", title: "共享人物", position: { x: 80, y: 90 }, width: 240, height: 320,
        metadata: { productionEntity: { ownerKind: "canvas", ownerId: shared.project.id, kind: "character", entityId: "CANON_PERSON" }, characterImages: [{ storageKey: "image:shared-person" }], characterPrimaryIndex: 0 } }], { runtimeWrite: true });
    const initial = director();
    initial.source.character_registry = [{ id: "LOCAL_PERSON", name: "本地人物" }];
    initial.source.asset_plan = [{ id: "LOCAL_ASSET", kind: "character", entity_id: "LOCAL_PERSON", asset_name: "本地人物", version: "v1", depends_on: [] }];
    initial.source.subject_registry = [{ id: "SUBJECT_LOCAL", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "LOCAL_PERSON" }, pictureBindings: [] }];
    initial.sourceHash = directorHash(initial.source);
    save(f.episode, "ep", initial);
    const current = f.episode.get("ep"), canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    const include: any = { type: "create_manual_director_asset", assetPlan: { id: "SHARED_CANON_PERSON", kind: "character", asset_name: "共享人物", entity_id: "CHAR_CANON_PERSON", version: "v1", description: "", purpose: "剧目共享资产", depends_on: [], status: "planned", canvas_scope: "episode",
        sharedSource: { dramaId: "drama", assetId: "SHARED_CANON_PERSON", sourceProjectId: shared.project.id, sourceNodeId: "shared-person" } },
        assetCard: { id: "SHARED_CANON_PERSON", asset_id: "SHARED_CANON_PERSON", asset_kind: "character", asset_version: "v1", prompt: "", references: [] }, registryKind: "character",
        registryEntity: { id: "CHAR_CANON_PERSON", name: "共享人物", description: "", appearance: "" } };
    const subject = structuredClone(current.draft.director!.source.subject_registry[0]) as any;
    subject.entityRef = { ownerKind: "episode", ownerId: "ep", kind: "character", id: "CHAR_CANON_PERSON" };
    subject.pictureBindings = [];
    const switched = f.episode.edit("ep", { operationId: "include-and-switch-shared-person", expectedRevision: current.revision, ops: [include, { type: "upsert_director_subject", subject }] });
    const updatedSubject = switched.draft.director!.source.subject_registry.find((row: any) => row.id === "SUBJECT_LOCAL") as any;
    const projected = (f.db.getCanvasProject(canvasId)!.nodes as any[]).find(node => node.metadata?.productionEntity?.entityId === "CHAR_CANON_PERSON");
    assert.equal(updatedSubject.entityRef.id, "CHAR_CANON_PERSON");
    assert.equal(updatedSubject.pictureBindings.length, 1);
    assert.deepEqual(updatedSubject.pictureBindings[0].sourceNode, { projectId: canvasId, nodeId: projected.id });
    assert.equal(f.episode.subjectWorkbench("ep", "SUBJECT_LOCAL").subjectWorkbench.pictureBindings[0].assetId, "SHARED_CANON_PERSON");
});

test("scene storyboard replacement replays once and refuses stale revisions without changing other scenes", t => {
    const f = fixture(t), d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    d.sourceHash = directorHash(d.source);
    for (const artifact of d.artifacts) { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; }
    const before = save(f.episode, "ep", d);
    const first = (d.source.shots as any[])[0];
    const request = { operationId: "scene-replacement", expectedRevision: before.revision, ops: [{ type: "replace_director_scene_storyboard", sceneId: "morning",
        shots: [{ ...first, duration_frames: 60, timeline_id: "main" }, { ...first, id: "s1b", story_order: 1, duration_frames: 60, timeline_id: "main" }],
        segments: [{ ...(d.source.segments as any[])[0], shot_ids: ["s1", "s1b"] }], shotInputs: { s1: { keyframePolicy: "none", assetIds: ["ROLE"] }, s1b: { keyframePolicy: "none", assetIds: ["ROLE"] } } }] };
    const saved = f.episode.edit("ep", request);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(f.episode.edit("ep", request).replayed, true);
    assert.equal(f.episode.get("ep").revision, saved.revision);
    assert.deepEqual((saved.draft.director!.source.shots as any[]).find(shot => shot.id === "s2"), (before.draft.director!.source.shots as any[]).find(shot => shot.id === "s2"));
    assert.throws(() => f.episode.edit("ep", { ...request, operationId: "stale-replacement" }), /版本已变化/);
});

test("Clip storyboard edits replace formal Shots and immediately reproject H3 track cells", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep"), d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    d.sourceHash = directorHash(d.source);
    for (const artifact of d.artifacts) { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; }
    const before = save(f.episode, "ep", d);
    const original = (d.source.shots as any[])[0];
    const formalSegment = (d.source.segments as any[])[0];
    const request = { operationId: "clip-track-writeback", expectedRevision: before.revision, ops: [{ type: "replace_director_clip_storyboard", segmentId: "seg1",
        segment: { ...formalSegment, shot_ids: ["s1", "s1b"] },
        shots: [{ ...original, duration_frames: 60, timeline_id: "main" }, { ...original, id: "s1b", story_order: 1, duration_frames: 60, timeline_id: "main" }],
        shotInputs: { s1: { keyframePolicy: "none", assetIds: [] }, s1b: { keyframePolicy: "none", assetIds: [] } } }] };
    const saved = f.episode.edit("ep", request);
    assert.deepEqual((saved.draft.director!.source.shots as any[]).map(shot => shot.id), ["s1", "s1b", "s2"]);
    const storedReceipt = f.db.db.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id=?").get("clip-track-writeback") as { receipt_json: Uint8Array };
    assert.ok(storedReceipt.receipt_json instanceof Uint8Array, "new operation receipts are stored as gzip BLOBs");
    const decodedReceipt = decodeReceipt<any>(storedReceipt.receipt_json);
    assert.equal(decodedReceipt.revision, saved.revision);
    assert.deepEqual(decodedReceipt.draft.director, saved.draft.director);
    const replayed = f.episode.edit("ep", request);
    assert.equal(replayed.replayed, true, "idempotent edit replay must decode the new gzip BLOB");
    const legacyText = JSON.stringify(decodedReceipt);
    f.db.db.prepare("UPDATE episode_production_operations SET receipt_json=? WHERE operation_id=?").run(legacyText, "clip-track-writeback");
    const replayReceipt = f.episode.operationReceipt("ep", "clip-track-writeback");
    assert.equal(replayReceipt?.revision, saved.revision);
    assert.deepEqual(replayReceipt?.draft.director?.source, saved.draft.director?.source);
    const group = saved.draft.clipGroups.find(item => item.id === "seg1")!;
    const canvas = f.db.getCanvasProject(project.id)!;
    const node = (canvas.nodes as any[]).find(item => item.id === group.nodeId);
    const clip = node.metadata.segments.find((item: any) => item.id === group.segmentId);
    assert.deepEqual(clip.storyboardShots.map((shot: any) => shot.id), ["s1", "s1b"]);
    assert.equal(clip.duration, 5);
    assert.throws(() => f.episode.edit("ep", { operationId: "clip-last-shot-delete", expectedRevision: saved.revision, ops: [{ type: "replace_director_clip_storyboard", segmentId: "seg1", segment: formalSegment, shots: [], shotInputs: {} }] }), /shots|至少|Too small/i);
});

test("large preparation, arrangement and synchronization recover lost responses without duplicate effects", async t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    (d.source.script_scenes as any[]).forEach(scene => { scene.text = "完整剧情😀".repeat(25000); });
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

test("complete draft preparation repairs Clip order without publishing or submitting media", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "One scene", beat_ids: ["b1", "b2"] }];
    Object.values(d.shotInputs).forEach(input => { input.assetIds = []; input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    d.sourceHash = directorHash(d.source);
    d.artifacts.forEach(artifact => { artifact.sourceHash = d.sourceHash; artifact.receipt.sourceHash = d.sourceHash; });
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const first = runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "prepare-draft");
    const [a, b] = first.draft.clipGroups;
    f.stores.projects.applyOperations(projectId, undefined, [{ type: "move_h3_segment", nodeId: a.nodeId!, segmentId: b.segmentId!, beforeSegmentId: a.segmentId! }], { runtimeWrite: true });
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1", "segment:seg2"], "repair-draft-order");
    const node = (f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === a.nodeId);
    assert.deepEqual(node.metadata.segments.map((segment: any) => segment.id), [a.segmentId, b.segmentId]);
    assert.equal(f.episode.get("ep").publishedVersion, 0);
    assert.equal(f.stores.tasks.list().length, 0);
});

test("production saves do not create script text nodes; existing collaborative script nodes still sync atomically", t => {
    const f = fixture(t), canvasId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "action", scene_id: "room", scene_name: "Morning", kind: "action", text: "原动作", beat_ids: ["b1"] }, { id: "dialogue", scene_id: "room", kind: "dialogue", text: "原对白", beat_ids: ["b1"] }];
    d.sourceHash = directorHash(d.source); d.artifacts = d.artifacts.map(item => ({ ...item, status: "stale" }));
    save(f.episode, "ep", d);
    assert.equal((f.db.getCanvasProject(canvasId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId).length, 0);
    const scripts = addManualScriptNodes(f, canvasId);
    const project = f.db.getCanvasProject(canvasId)!;
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
    assert.equal((f.db.getCanvasProject(canvasId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId).length, 0);
    const scripts = addManualScriptNodes(f, canvasId);
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
    assert.throws(() => episodeRunner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "wrong-episode-owner"), /共享资产 ROLE 尚未采用/);
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
    assert.deepEqual(selected.published, f.episode.version("ep", selected.publishedVersion)!.snapshot);
    assert.equal(selected.published!.director!.assets.ROLE.storageKey, undefined);
    assert.equal((f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === op.nodeId).metadata.storageKey, "image:old");
    assert.ok(notifications > 0); assert.deepEqual(f.db.getTask("history:ROLE"), originalTask);
    const committedNotifications = notifications;
    assert.equal(f.episode.edit("ep", request).replayed, true); assert.equal(notifications, committedNotifications);
});

test("formal image result selection resolves the exact archive log from canvas_task_status taskId", t => {
    const f = historyFixture(t), op = f.result("asset", "ROLE", "image:task-id-selection");
    const { generationLogId: _generationLogId, ...selection } = op;
    const before = f.episode.get("ep"), task = f.db.getTask("history:ROLE")!;
    const request = { operationId: "select-image-by-task-id", expectedRevision: before.revision, ops: [{ ...selection, taskId: task.id }] };
    assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
    const selected = f.episode.edit("ep", request);
    assert.equal(selected.draft.director!.assets.ROLE.storageKey, "image:task-id-selection");
    assert.equal(selected.draft.director!.assets.ROLE.status, "generated");
    assert.equal(selected.draft.director!.assets.ROLE.selectedResult?.taskId, task.id);
    assert.ok((f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === op.nodeId)?.metadata.images.some((image: any) => image.storageKey === "image:task-id-selection"));
});

test("Subject Prompt v2 continuity edits stale old compile receipts before reprojection", t => {
    const f = fixture(t), d = director();
    const shots = d.source.shots as any[];
    d.source = {
        version: 2,
        prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, scene_registry: [{ id: "room", name: "Room" }],
        character_registry: [{ id: "ROLE", name: "Character" }], subject_registry: [{ id: "SUB_ROLE", kind: "character",
            entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "ROLE" }, pictureBindings: [] }], asset_plan: d.source.asset_plan, asset_cards: [],
        script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "First visit", beat_ids: ["b1"] }, { id: "night", scene_id: "room", scene_name: "Night", text: "Return", beat_ids: ["b2"] }],
        shots: shots.map((shot, index) => ({ id: shot.id, title: shot.title, scene_id: "room", timeline_id: "main", story_order: index,
            duration_frames: 120, visual: shot.visual, camera: { framing: "MS", attention_subject_ids: [], editorial_reason: "Keep the action readable." },
            subject_usages: [], keyframes: [], utterance_refs: [] })),
        segments: [{ id: "seg1", shot_ids: ["s1"], mode: "T2VA" }, { id: "seg2", shot_ids: ["s2"], mode: "T2VA" }], utterances: [],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
    };
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash,
        receipt: { ...item.receipt, sourceHash: d.sourceHash } }));
    const saved = save(f.episode, "ep", d);
    const seeded = structuredClone(saved.draft.director!);
    const ready = seeded.artifacts.find(item => item.targetId === "seg1")!;
    ready.status = "ready";
    ready.sourceHash = seeded.sourceHash;
    ready.receipt.sourceHash = seeded.sourceHash;
    // Saving a fixture artifact through the normal edit keeps this test on the
    // same transactional path as production; set_director_production is the
    // existing full-source fixture operation.
    const reseeded = save(f.episode, "ep", seeded);
    const revision = reseeded.revision;
    const result = f.episode.edit("ep", { operationId: "v2-continuity-stales-compiled", expectedRevision: revision, ops: [{
        type: "edit_director_continuity", changes: [{ collection: "facts", action: "upsert", id: "FACT1", value: {
            id: "FACT1", object_kind: "character", object_id: "ROLE", allowed_values: ["standing"], value_descriptions: { standing: "The character remains standing." },
        } }],
    }] as any });
    assert.equal(result.revision, revision + 1);
    assert.ok(result.draft.director!.artifacts.every(item => item.status !== "ready"));
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

test("canvas snapshot history selects into an unpublished draft and preserves published history", t => {
    for (const withoutPublished of [false, true]) {
        const f = historyFixture(t), op = f.result("segment", "seg2", `video:canvas-${withoutPublished}`);
        const task = f.db.getTask("history:seg2")!;
        f.db.db.prepare("UPDATE tasks SET input_json=? WHERE id=?").run(JSON.stringify({ ...task.input, params: { canvasInputHash: "a".repeat(64), canvasInputDefaults: {}, canvasProductionTarget: { inputBasis: "canvas", projectId: f.projectId, nodeId: op.nodeId, kind: "segment", owner: { kind: "episode", id: "ep" } } } }), task.id);
        const before = f.episode.get("ep");
        const changed = structuredClone(before.draft);
        changed.director!.sourceHash = "b".repeat(64);
        f.db.db.prepare("UPDATE episode_productions SET draft_json=?, published_json=?, published_version=? WHERE episode_id=?").run(JSON.stringify(changed), withoutPublished ? null : JSON.stringify(before.published), withoutPublished ? 0 : before.publishedVersion, "ep");
        const current = f.episode.get("ep"), immutableTask = f.db.getTask(task.id);
        const request = { operationId: "select-canvas-snapshot", expectedRevision: current.revision, ops: [op] };
        assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
        const selected = f.episode.edit("ep", request);
        assert.equal(selected.draft.clipGroups[1].selectedResult?.generationLogId, op.generationLogId);
        assert.equal(selected.draft.clipGroups[1].inputOutdated, true);
        assert.deepEqual(selected.published, current.published);
        assert.equal(selected.publishedVersion, current.publishedVersion);
        assert.deepEqual(selected.draft.director!.source, current.draft.director!.source);
        assert.deepEqual(f.db.getTask(task.id), immutableTask);
        assert.equal(f.episode.edit("ep", request).replayed, true);
    }
});

test("manual legacy history selection works after draft edits without snapshot or publication", t => {
    for (const withoutPublished of [false, true]) {
        const f = historyFixture(t), op = f.result("segment", "seg2", "video:legacy");
        const before = f.episode.get("ep");
        const changed = structuredClone(before.draft); changed.director!.sourceHash = "b".repeat(64);
        f.db.db.prepare("UPDATE episode_productions SET draft_json=?, published_json=?, published_version=? WHERE episode_id=?").run(JSON.stringify(changed), withoutPublished ? null : JSON.stringify(before.published), withoutPublished ? 0 : before.publishedVersion, "ep");
        const current = f.episode.get("ep"), originalTask = f.db.getTask("history:seg2");
        const request = { operationId: "select-legacy-history", expectedRevision: current.revision, ops: [op] };
        assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
        const selected = f.episode.edit("ep", request);
        assert.equal(selected.draft.clipGroups[1].selectedResult?.generationLogId, op.generationLogId);
        assert.equal(selected.draft.clipGroups[1].inputOutdated, true);
        assert.deepEqual(selected.published, current.published);
        assert.equal(selected.publishedVersion, current.publishedVersion);
        assert.deepEqual(selected.draft.director!.source, current.draft.director!.source);
        assert.deepEqual(f.db.getTask("history:seg2"), originalTask);
        assert.equal(f.episode.edit("ep", request).replayed, true);
    }
});

test("canvas keyframe history selects without publication and keeps review pending", t => {
    const f = historyFixture(t), op = f.result("keyframe", "s1", "image:canvas-frame");
    const task = f.db.getTask("history:s1")!;
    f.db.db.prepare("UPDATE tasks SET input_json=? WHERE id=?").run(JSON.stringify({ ...task.input, params: { canvasInputHash: "a".repeat(64), canvasInputDefaults: {}, canvasProductionTarget: { inputBasis: "canvas", projectId: f.projectId, nodeId: op.nodeId, kind: "keyframe", owner: { kind: "episode", id: "ep" } } } }), task.id);
    f.db.db.prepare("UPDATE episode_productions SET published_json=NULL, published_version=0 WHERE episode_id=?").run("ep");
    const current = f.episode.get("ep");
    const selected = f.episode.edit("ep", { operationId: "select-canvas-frame", expectedRevision: current.revision, ops: [op] });
    assert.equal(selected.draft.keyframes.s1.storageKey, op.storageKey);
    assert.equal(selected.draft.keyframeReviews.s1, undefined);
    assert.equal(selected.published, null);
    assert.equal(selected.publishedVersion, 0);
});

function batchHistoryFixture(t: test.TestContext, kind: "asset" | "keyframe" | "segment", withSnapshot = true) {
    const f = historyFixture(t), targetId = kind === "segment" ? "seg2" : kind === "keyframe" ? "s1" : "ROLE";
    const op = f.result(kind, targetId, `media:batch-${kind}`), current = f.episode.get("ep");
    const childId = `history:${targetId}`, child = f.db.getTask(childId)!;
    const parent = f.db.createTask("history-batch-parent", "canvas-h3", { projectId: f.projectId, nodeId: op.nodeId, segmentId: child.segmentId }, {});
    f.db.updateTask(parent.id, { status: "succeeded" });
    f.db.db.prepare("UPDATE tasks SET params_json=? WHERE id=?").run(JSON.stringify({ parentTaskId: parent.id }), childId);
    f.db.db.prepare("DELETE FROM production_task_bindings WHERE task_id=?").run(childId);
    const entry = { kind: kind === "segment" ? "h3" : "image", id: `${kind === "keyframe" ? "frame" : kind}:${targetId}`, taskId: parent.id, projectId: f.projectId, nodeId: op.nodeId, segmentId: child.segmentId, status: "succeeded" };
    f.db.db.prepare(`INSERT INTO episode_production_batches
        (run_id,episode_id,idempotency_key,request_hash,version,source_revision,status,targets_json,plan_json,settings_json,submitted_json,created_at,updated_at,execution_snapshot_json)
        VALUES ('history-batch','ep','history-batch','fixture',?,?,'succeeded','[]','{}','{}',?,?,?,?)`)
        .run(current.publishedVersion, current.revision, JSON.stringify([entry]), current.updatedAt, current.updatedAt, withSnapshot ? JSON.stringify({ sourceHash: current.draft.director!.sourceHash }) : null);
    return { ...f, op, entry, parent, childId };
}

test("batch history selects exact successful child media without a native binding and preserves provenance", t => {
    for (const kind of ["segment", "keyframe", "asset"] as const) for (const withSnapshot of [true, false]) {
        const f = batchHistoryFixture(t, kind, withSnapshot), before = f.episode.get("ep");
        const originalTask = f.db.getTask(f.childId), originalBatch = f.episode.getBatch("ep", "history-batch");
        const changed = structuredClone(before.draft); changed.director!.sourceHash = "b".repeat(64);
        f.db.db.prepare("UPDATE episode_productions SET draft_json=? WHERE episode_id='ep'").run(JSON.stringify(changed));
        const request = { operationId: "select-batch-history", expectedRevision: before.revision, ops: [f.op] };
        const canvasBefore = f.db.getCanvasProject(f.projectId);
        assert.equal(f.episode.preflight("ep", { action: "edit", request }).valid, true);
        assert.deepEqual(f.db.getCanvasProject(f.projectId), canvasBefore);
        const selected = f.episode.edit("ep", request);
        const result = kind === "segment" ? selected.draft.clipGroups[1] : selected.draft.director!.assets[kind === "keyframe" ? "FRAME" : "ROLE"];
        const provenance = result.selectedResult as { taskId: string; sourceHash: string };
        assert.equal(provenance.taskId, f.parent.id);
        assert.equal(provenance.sourceHash, before.draft.director!.sourceHash);
        assert.equal(result.inputOutdated, true);
        assert.deepEqual(selected.published, before.published);
        assert.deepEqual(f.db.getTask(f.childId), originalTask);
        assert.deepEqual(f.episode.getBatch("ep", "history-batch"), originalBatch);
        assert.equal(f.db.db.prepare("SELECT COUNT(*) AS count FROM production_task_bindings").get()!.count, 0);
        assert.equal(f.episode.edit("ep", request).replayed, true);
    }
});

test("batch history rejects wrong owner, task, target, node, Clip and kind without changing the canvas", t => {
    const f = batchHistoryFixture(t, "segment"), before = f.episode.get("ep"), canvasBefore = f.db.getCanvasProject(f.projectId);
    for (const patch of [{ taskId: "other-task" }, { id: "segment:seg1" }, { projectId: "other-project" }, { nodeId: "other-node" }, { segmentId: "other-clip" }, { kind: "image" }]) {
        f.db.db.prepare("UPDATE episode_production_batches SET submitted_json=? WHERE run_id='history-batch'").run(JSON.stringify([{ ...f.entry, ...patch }]));
        assert.throws(() => f.episode.edit("ep", { operationId: crypto.randomUUID(), expectedRevision: before.revision, ops: [f.op] }), /历史任务不属于/);
        assert.deepEqual(f.episode.get("ep"), before); assert.deepEqual(f.db.getCanvasProject(f.projectId), canvasBefore);
    }
    f.db.db.prepare("UPDATE episode_production_batches SET episode_id='ep2', submitted_json=? WHERE run_id='history-batch'").run(JSON.stringify([f.entry]));
    assert.throws(() => f.episode.edit("ep", { operationId: "wrong-batch-owner", expectedRevision: before.revision, ops: [f.op] }), /历史任务不属于/);
});

test("batch history resolves a shared parent by exact Clip and rolls back a mixed-operation failure", t => {
    const f = batchHistoryFixture(t, "segment"), before = f.episode.get("ep"), canvasBefore = f.db.getCanvasProject(f.projectId);
    const entries = [{ ...f.entry, id: "segment:seg1", segmentId: before.draft.clipGroups[0].segmentId }, f.entry];
    f.db.db.prepare("UPDATE episode_production_batches SET submitted_json=? WHERE run_id='history-batch'").run(JSON.stringify(entries));
    const originalBatch = f.episode.getBatch("ep", "history-batch");
    const failed = { operationId: "failed-batch-history", expectedRevision: before.revision, ops: [f.op, { type: "bind_director_asset", assetId: "MISSING", nodeId: "missing" }] };
    assert.throws(() => f.episode.edit("ep", failed), /MISSING/);
    assert.deepEqual(f.episode.get("ep"), before); assert.deepEqual(f.db.getCanvasProject(f.projectId), canvasBefore);
    assert.deepEqual(f.episode.getBatch("ep", "history-batch"), originalBatch);
    assert.equal(f.db.getCanvasOperationReceipt(f.projectId, "failed-batch-history:result:segment:seg2").committed, false);
    const selected = f.episode.edit("ep", { operationId: "shared-parent-history", expectedRevision: before.revision, ops: [f.op] });
    assert.equal(selected.draft.clipGroups[0].selectedResult, undefined);
    assert.equal(selected.draft.clipGroups[1].selectedResult?.generationLogId, f.op.generationLogId);
});

test("archived H3 video results return to their scene Clips with original task provenance and no new task", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
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
    const f = fixture(t); seedUnboundEpisode(f);
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
    const f = fixture(t); seedUnboundEpisode(f);
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
    const f = fixture(t); seedUnboundEpisode(f);
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
    const f = fixture(t); seedUnboundEpisode(f);
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
    const f = fixture(t); seedUnboundEpisode(f);
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
    seedUnboundEpisode(f, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "shared-unbound"), /共享/);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
    assert.equal(f.db.db.prepare("SELECT 1 FROM production_preparations WHERE operation_id=?").get("shared-unbound"), undefined);
    save(f.episode, "ep2", director());
    runner.prepareTargets("ep2", f.episode.get("ep2").revision, ["asset:ROLE"], "owner-bound-operation");
    assert.throws(() => runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "owner-bound-operation"), /operationId/);
    assert.equal(f.db.getDramaEpisode("ep")!.canvasId, null);
});

test("saving a newly created formal scene materializes exactly one H3 node immediately", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    d.source.script_scenes = [
        { id: "occ-a", scene_id: "room", scene_name: "Morning", text: "Morning scene", beat_ids: ["beat-a"] },
        { id: "occ-b", scene_id: "room", scene_name: "Night", text: "Night scene", beat_ids: ["beat-b"] },
    ];
    d.source.shots = [
        { ...(d.source.shots as any[])[0], id: "shot-a", source_scene_id: "occ-a", scene_id: "room", story_beat_ids: ["beat-a"] },
        { ...(d.source.shots as any[])[1], id: "shot-b", source_scene_id: "occ-b", scene_id: "room", story_beat_ids: ["beat-b"] },
    ];
    d.source.segments = [];
    d.shotInputs = {};
    d.assets = {};
    d.artifacts = [];
    d.sourceHash = directorHash(d.source);

    const saved = save(f.episode, "ep", d);
    const nodes = f.db.getCanvasProject(project.id)!.nodes as any[];
    const sceneVideos = nodes.filter(node => node.type === "minimax-h3:video" && node.metadata?.productionSceneId);
    assert.deepEqual(sceneVideos.map(node => node.metadata.productionSceneId).sort(), ["occ-a", "occ-b"]);
    assert.equal(new Set(sceneVideos.map(node => node.id)).size, 2);
    assert.ok(sceneVideos.every(node => Array.isArray(node.metadata.segments) && node.metadata.segments.length === 0));
    assert.equal(saved.revision, 1);
});

test("the director addScene bare block (unique scene_id, no beat_ids) materializes its own H3 node", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    // Mirrors director-panel.tsx addScene: a lone block with its own scene_id and no beats.
    const addedId = "scene-bare";
    const nextSource = { ...d.source, script_scenes: [...(d.source.script_scenes as any[]), { id: addedId, scene_id: addedId, scene_name: "Untitled scene", kind: "action", text: "" }] };
    d.source = nextSource as any;
    d.sourceHash = directorHash(nextSource);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));

    const saved = save(f.episode, "ep", d);
    const nodes = f.db.getCanvasProject(project.id)!.nodes as any[];
    const sceneVideos = nodes.filter(node => node.type === "minimax-h3:video" && node.metadata?.productionSceneId);
    assert.ok(sceneVideos.some(node => node.metadata.productionSceneId === addedId), "new bare scene owns an H3 node");
    const bareNode = sceneVideos.find(node => node.metadata.productionSceneId === addedId)!;
    assert.equal(productionLayoutStableId("production-h3-scene", "ep", addedId), bareNode.id, "stable H3 node id");
    assert.equal(saved.revision, 1);
});

test("preparing an existing empty scene materializes its canonical H3 node", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    (d.source.script_scenes as any[]).push({ id: "dawn", scene_id: "room", scene_name: "Dawn", text: "No shots yet", beat_ids: ["b3"] });
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));
    const saved = save(f.episode, "ep", d);
    const expectedNodeId = productionLayoutStableId("production-h3-scene", "ep", "dawn");
    const expectedGroupId = productionLayoutStableId("production-scene", "ep", "dawn");
    const legacyProject = f.db.getCanvasProject(project.id)!;
    assert.ok((legacyProject.nodes as any[]).some(node => node.id === expectedNodeId), "the scene was created with its H3 node before it became a legacy repair target");
    assert.ok((legacyProject.nodes as any[]).some(node => node.id === expectedGroupId), "the scene was created with its group before it became a legacy repair target");
    f.db.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(
        JSON.stringify({ ...legacyProject, nodes: (legacyProject.nodes as any[]).filter(node => node.id !== expectedNodeId && node.id !== expectedGroupId) }), project.id);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);

    runner.prepareTargets("ep", saved.revision, ["scene:dawn"], "prepare-existing-empty-scene");

    const nodes = f.db.getCanvasProject(project.id)!.nodes as any[];
    const sceneGroups = nodes.filter(node => node.type === "group" && node.metadata?.productionSceneId === "dawn");
    assert.equal(sceneGroups.length, 1);
    assert.equal(sceneGroups[0].id, expectedGroupId);
    const h3 = nodes.filter(node => node.type === "minimax-h3:video" && node.metadata?.productionSceneId === "dawn");
    assert.equal(h3.length, 1);
    assert.equal(h3[0].id, expectedNodeId);
    assert.deepEqual(h3[0].metadata.segments, []);
    assert.equal(h3[0].metadata.productionOwnerId, "ep");
});

test("new scene Clips materialize one H3 segment whose storyboard cells use stable Shot IDs", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    d.shotInputs = { s1: { keyframePolicy: "none", assetIds: [] }, s2: { keyframePolicy: "none", assetIds: [] } };
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));

    const saved = save(f.episode, "ep", d);
    const nodes = (f.db.getCanvasProject(project.id)!.nodes as any[]).filter(node => node.type === "minimax-h3:video");
    assert.equal(nodes.length, 2);
    const clipByScene = new Map(nodes.map(node => [node.metadata.productionSceneId, node.metadata.segments[0]]));
    assert.deepEqual((clipByScene.get("morning").storyboardShots || []).map((shot: any) => shot.id), ["s1"]);
    assert.deepEqual((clipByScene.get("night").storyboardShots || []).map((shot: any) => shot.id), ["s2"]);
    assert.ok(nodes.every(node => node.metadata.segments.length === 1 && node.metadata.segments[0].productionClipProjection));
    assert.equal(saved.draft.clipGroups.every(group => Boolean(group.nodeId && group.segmentId)), true);
});

test("confirmed scene deletion is 30-day restorable with its H3 node and exact source IDs", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    (d.source.shots as any[])[1].utterance_refs = [{ utteranceId: "U1" }];
    (d.source as any).utterances = [{ id: "U1", shot_id: "s1", text: "归档对白" }];
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));
    save(f.episode, "ep", d);
    const beforeProject = f.db.getCanvasProject(project.id)!;
    const beforeNodes = beforeProject.nodes as any[];
    const morningNode = beforeNodes.find(node => node.metadata?.productionSceneId === "morning");
    assert.ok(morningNode);
    const current = f.episode.get("ep");
    assert.throws(() => f.episode.edit("ep", { operationId: "archive-missing-confirm", expectedRevision: current.revision, ops: [{ type: "archive_director_scene", sceneId: "morning", expectedCanvasRevision: Number(beforeProject.revision), confirmed: false } as any] }), /confirmed|true/);

    const removed = f.episode.edit("ep", { operationId: "archive-morning", expectedRevision: current.revision, ops: [{ type: "archive_director_scene", sceneId: "morning", expectedCanvasRevision: Number(beforeProject.revision), confirmed: true }] as any });
    assert.deepEqual((removed.draft.director!.source.shots as any[]).map(shot => shot.id), ["s2"]);
    assert.deepEqual((removed.draft.director!.source.segments as any[]).map(segment => segment.id), ["seg2"]);
    assert.deepEqual(removed.draft.clipGroups.map(group => group.id), ["seg2"]);
    assert.deepEqual((removed.draft.director!.source as any).utterances, []);
    assert.deepEqual(((removed.draft.director!.source.shots as any[])[0]).utterance_refs, []);
    assert.equal((f.db.getCanvasProject(project.id)!.nodes as any[]).some(node => node.id === morningNode.id), false);
    const archive = f.episode.listArchivedScenes("ep")[0];
    assert.equal(archive.sceneId, "morning");
    assert.equal(archive.shotCount, 1);
    assert.equal(archive.clipCount, 1);
    assert.equal(Date.parse(archive.expiresAt) - Date.parse(archive.deletedAt), 30 * 24 * 60 * 60 * 1000);

    const currentCanvas = f.db.getCanvasProject(project.id)!;
    const restored = f.episode.edit("ep", { operationId: "restore-morning", expectedRevision: removed.revision, ops: [{ type: "restore_director_scene", archiveId: archive.archiveId, expectedCanvasRevision: Number(currentCanvas.revision) }] as any });
    assert.deepEqual((restored.draft.director!.source.shots as any[]).map(shot => shot.id).sort(), ["s1", "s2"]);
    assert.deepEqual((restored.draft.director!.source as any).utterances.map((utterance: any) => utterance.id), ["U1"]);
    assert.deepEqual(((restored.draft.director!.source.shots as any[]).find(shot => shot.id === "s2")).utterance_refs, [{ utteranceId: "U1" }]);
    assert.equal(restored.draft.clipGroups.length, 2);
    assert.ok((f.db.getCanvasProject(project.id)!.nodes as any[]).some(node => node.id === morningNode.id));
    assert.equal(f.episode.listArchivedScenes("ep").some(item => item.archiveId === archive.archiveId), false);

    const restoredCanvas = f.db.getCanvasProject(project.id)!;
    const archivedAgain = f.episode.edit("ep", { operationId: "archive-morning-again", expectedRevision: restored.revision,
        ops: [{ type: "archive_director_scene", sceneId: "morning", expectedCanvasRevision: Number(restoredCanvas.revision), confirmed: true }] as any });
    const expired = f.episode.listArchivedScenes("ep")[0];
    f.db.db.prepare("UPDATE production_scene_archives SET expires_at=? WHERE archive_id=?").run(new Date(Date.now() - 1000).toISOString(), expired.archiveId);
    assert.equal(f.episode.listArchivedScenes("ep").some(item => item.archiveId === expired.archiveId), false);
    assert.throws(() => f.episode.edit("ep", { operationId: "restore-expired-morning", expectedRevision: archivedAgain.revision,
        ops: [{ type: "restore_director_scene", archiveId: expired.archiveId, expectedCanvasRevision: Number(f.db.getCanvasProject(project.id)!.revision) }] as any }), /30 天还原期限/);
});

test("deleting a Clip removes its owned Shots as a unit but keeps the scene H3 node", t => {
    const f = fixture(t), { project } = ensureProductionCanvas(f.db, "episode", "ep");
    const d = director();
    (d.source.shots as any[])[0].source_scene_id = "morning";
    (d.source.shots as any[])[1].source_scene_id = "night";
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));
    save(f.episode, "ep", d);
    const beforeProject = f.db.getCanvasProject(project.id)!;
    const morningNode = (beforeProject.nodes as any[]).find(node => node.metadata?.productionSceneId === "morning");
    const current = f.episode.get("ep");
    const result = f.episode.edit("ep", { operationId: "delete-last-shot-by-clip", expectedRevision: current.revision,
        ops: [{ type: "delete_director_clip", segmentId: "seg1", expectedCanvasRevision: Number(beforeProject.revision), confirmed: true }] as any });
    assert.deepEqual((result.draft.director!.source.shots as any[]).map(shot => shot.id), ["s2"]);
    assert.deepEqual(result.draft.clipGroups.map(group => group.id), ["seg2"]);
    const afterNode = (f.db.getCanvasProject(project.id)!.nodes as any[]).find(node => node.id === morningNode.id);
    assert.ok(afterNode, "a surviving scene remains represented by its H3 node");
    assert.ok(!Array.isArray(afterNode.metadata.segments) || afterNode.metadata.segments.length === 0);
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
    assert.equal(nodes.filter(node => node.type === "group" && node.metadata?.productionSceneId === "morning").length, 1);
    assert.equal(nodes.filter(node => node.type === "group" && node.metadata?.productionSceneId === "night").length, 1);
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
    assert.throws(() => validateSharedAssetSource(f.db, episodeCanvas, { ...current.draft.director!.assets.ROLE, sharedSource: { ...current.draft.director!.assets.ROLE.sharedSource!, dramaId: "foreign" } }), /当前剧目/);
    fs.writeFileSync(path.join(f.directory, "role-2.png"), "changed bytes");
    assert.doesNotThrow(() => validateSharedAssetSource(f.db, episodeCanvas, current.draft.director!.assets.ROLE), "draft validation follows the stable shared source; media hashes are checked at the material boundary");
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
    const originalNodeBefore = structuredClone((f.db.getCanvasProject(sourceCanvas)!.nodes as any[]).find(node => node.id === "episode-role"));
    const reviewed = f.episode.edit("ep", { operationId: "review-before-promotion", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "review_director_asset",
        assetId: "ROLE", version: published.publishedVersion, sourceHash: d.sourceHash, nodeId: "episode-role", storageKey, sha256, verdict: "approved", evidence: "Reviewed the original archived character image" }] });
    // 归属已标记剧目共享：审核通过即自动迁移，共享画布与批准版本在审核编辑内直接登记。
    const autoApproved = listApprovedSharedAssets(f.db, "drama").find(asset => asset.assetId === "ROLE")!;
    assert.equal(autoApproved.storageKey, storageKey); assert.equal(autoApproved.sha256, sha256);
    assert.equal(autoApproved.snapshot.metadata.sharedPromotionOrigin.sourceNodeId, "episode-role");
    const sharedCanvasId = autoApproved.sourceProjectId;
    const preview = f.episode.previewSharedAssetPromotion("ep", "ROLE", reviewed.revision);
    assert.equal(preview.storageKey, storageKey); assert.equal(preview.sha256, sha256); assert.equal(preview.approvedId, autoApproved.id);
    assert.equal(preview.sharedCanvasId, sharedCanvasId);
    assert.equal(preview.sourceGenerationTaskId, "original-image-task");
    const promoted = f.episode.promoteExistingSharedAsset("ep", { assetId: "ROLE", expectedRevision: reviewed.revision, expectedSourceCanvasRevision: preview.sourceCanvasRevision,
        expectedSharedCanvasRevision: preview.sharedCanvasRevision, operationId: "promote-role" });
    assert.equal(promoted.replayed, true);
    const sharedProject = f.db.getCanvasProject(sharedCanvasId)!;
    const importedNode = (sharedProject.nodes as any[]).find(node => node.id === promoted.nodeId);
    assert.equal(importedNode.metadata.storageKey, storageKey);
    assert.deepEqual(importedNode.metadata.sharedPromotionOrigin, { episodeId: "ep", sourceCanvasId: sourceCanvas, sourceNodeId: "episode-role", sourceVersion: published.publishedVersion,
        sourceGenerationTaskId: "original-image-task", sourceStorageKey: storageKey, sourceSha256: sha256 });
    assert.throws(() => f.db.applyCanvasProjectOperations(sharedCanvasId, Number(sharedProject.revision), [{ type: "update_node", id: promoted.nodeId, metadata: { sharedPromotionOrigin: {} } }]), /接入来源由 Backend 登记/);
    assert.deepEqual((f.db.getCanvasProject(sourceCanvas)!.nodes as any[]).find(node => node.id === "episode-role"), originalNodeBefore);
    approve(f, sharedCanvasId, 2);
    assert.throws(() => f.episode.previewSharedAssetPromotion("ep", "ROLE", reviewed.revision), /其他媒体版本/);
});

test("generated shared assets become adoptable versions without approval evidence", t => {
    const f = fixture(t), sharedCanvas = ensureProductionCanvas(f.db, "shared-assets", "drama").project.id;
    const filePath = path.join(f.directory, "unreviewed-shared.png"), bytes = Buffer.from("generated shared image");
    fs.writeFileSync(filePath, bytes);
    const storageKey = "image:unreviewed-shared", sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    f.db.upsertMediaFile({ storageKey, filePath, bytes: bytes.length, mimeType: "image/png", width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations(sharedCanvas, Number(f.db.getCanvasProject(sharedCanvas)!.revision), [{ type: "add_node", id: "shared-role", nodeType: "image", title: "Character", position: { x: 0, y: 0 }, metadata: { storageKey } }]);
    const d = director();
    (d.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope = "shared";
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(item => ({ ...item, sourceHash: d.sourceHash, receipt: { ...item.receipt, sourceHash: d.sourceHash } }));
    d.assets.ROLE = { nodeId: "shared-role", version: "v1", status: "planned" };
    save(f.shared, sharedCanvas, d);
    const published = publish(f.shared, sharedCanvas);
    f.shared.bindDirectorAsset(sharedCanvas, published.publishedVersion, "ROLE", storageKey);
    const version = listApprovedSharedAssets(f.db, "drama").find(item => item.assetId === "ROLE")!;
    assert.equal(version.reviewStatus, "unreviewed");
    assert.equal(version.evidence, "");
    assert.equal(version.storageKey, storageKey);
    ensureProductionCanvas(f.db, "episode", "ep"); save(f.episode, "ep", director());
    const adopted = f.episode.adoptSharedAsset("ep", { assetId: "ROLE", approvedId: version.id, expectedRevision: f.episode.get("ep").revision, operationId: "adopt-unreviewed" });
    assert.equal(adopted.draft.director!.assets.ROLE.status, "generated");
    assert.equal(adopted.draft.director!.assets.ROLE.evidence, undefined);
    validateSharedAssetSource(f.db, f.episode.episodeInfo("ep").canvasId!, adopted.draft.director!.assets.ROLE);
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

test("native image controls use the original node and expose an exact task without accepting stale command edits", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    save(f.episode, "ep", director());
    f.episode.edit("ep", { operationId: "native-image-model", expectedRevision: f.episode.get("ep").revision, ops: [{ type: "set_settings", patch: { imageModel: "fixture" } }] });
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    runner.prepareTargets("ep", f.episode.get("ep").revision, ["asset:ROLE"], "prepare-native");
    const published = publish(f.episode, "ep"), nodeId = published.published!.director!.assets.ROLE.nodeId!;
    const observer = new NativeProductionGeneration(f.db, f.stores, f.episode, f.shared, f.events);
    const prepared = observer.prepare({ mode: "image", projectId, nodeId, prompt: published.published!.director!.artifacts.find(artifact => artifact.targetId === "ROLE")!.prompt, model: "fixture" });
    assert.equal(prepared.command.params?.writeBackToTarget, true);
    assert.throws(() => observer.prepare({ ...prepared.command, prompt: "uncompiled edit" }), /正式图像产物/);
    const task = f.stores.tasks.create("native-task", "canvas-image", prepared.command, { canvasBinding: { projectId, nodeId } });
    const unsubscribe = observer.start();
    observer.submitted(task.id, prepared.context);
    assert.equal(f.episode.get("ep").draft.director?.workflow.currentWork?.taskId, task.id);
    assert.equal(f.episode.workflowReadiness("ep").presentation?.taskId, task.id);
    const filePath = path.join(f.directory, "native.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(filePath, image);
    f.db.upsertMediaFile({ storageKey: "image:native", filePath, bytes: image.length, mimeType: "image/png", width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
    f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [{ type: "update_node", id: nodeId, metadata: { storageKey: "image:native" } }], { runtimeWrite: true });
    f.stores.tasks.update(task.id, { status: "succeeded", result: { media: [{ storageKey: "image:native" }] } });
    f.events.publish({ type: "task.updated", entityId: task.id, payload: { status: "succeeded" } });
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.status, "generated");
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.storageKey, "image:native");
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.generationTaskId, task.id);
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.sha256, crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"));
    assert.deepEqual(f.episode.get("ep").published, published.published, "current canvas generation preserves the published snapshot");
    const readiness = () => f.episode.workflowReadiness("ep");
    const targetStatus = () => readiness().targets.find(target => target.id === "asset:ROLE")!.status;
    assert.equal(targetStatus(), "complete");
    assert.equal(readiness().presentation?.status, "complete");
    assert.notEqual(f.episode.workflowReadiness("ep", "published").targets.find(target => target.id === "asset:ROLE")!.status, "complete", "draft media cannot complete the published target");
    assert.equal(f.db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(task.id)?.status, "bound");

    fs.writeFileSync(filePath, "tampered output bytes");
    assert.notEqual(targetStatus(), "complete", "a matching database digest cannot certify changed bytes");
    assert.notEqual(readiness().presentation?.status, "complete");
    fs.writeFileSync(filePath, image);
    assert.equal(targetStatus(), "complete");
    assert.equal(readiness().presentation?.status, "complete");

    const bindMedia = (storageKey: string) => f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [
        { type: "update_node", id: nodeId, metadata: { storageKey } },
    ], { runtimeWrite: true });
    f.db.upsertMediaFile({ storageKey: "image:replacement", filePath, bytes: image.length, mimeType: "image/png", width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
    bindMedia("image:replacement");
    assert.notEqual(targetStatus(), "complete", "another valid archived image is not the original task's active binding");
    assert.notEqual(readiness().presentation?.status, "complete");
    bindMedia("image:native");
    assert.equal(targetStatus(), "complete");
    assert.equal(readiness().presentation?.status, "complete");

    const activeNode = structuredClone((f.db.getCanvasProject(projectId)!.nodes as any[]).find(node => node.id === nodeId));
    f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [{ type: "delete_node", id: nodeId }], { runtimeWrite: true });
    assert.notEqual(targetStatus(), "complete", "archived bytes cannot complete a deleted target node");
    assert.notEqual(readiness().presentation?.status, "complete");
    f.db.applyCanvasProjectOperations(projectId, Number(f.db.getCanvasProject(projectId)!.revision), [{
        type: "add_node", id: nodeId, nodeType: activeNode.type, title: activeNode.title,
        position: activeNode.position, width: activeNode.width, height: activeNode.height, metadata: activeNode.metadata,
    }], { runtimeWrite: true });
    assert.equal(targetStatus(), "complete");
    assert.equal(readiness().presentation?.status, "complete");
    assert.deepEqual(f.episode.get("ep").published, published.published);
    unsubscribe();
});

test("native H3 tracking follows the active Clip while a pending decision keeps presentation priority", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "sequence", scene_id: "room", scene_name: "Sequence", text: "Both shots share this scene", beat_ids: ["b1", "b2"] }];
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

test("each formal scene owns one H3 node and keeps its clips and frames in the same area", t => {
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
        assert.equal(upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, DATABASE_SCHEMA_VERSION);
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_preparations'").get());
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_task_bindings'").get());
        assert.ok(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_layout_plans'").get());
        assert.equal(listApprovedSharedAssets(upgraded, "drama")[0].id, approved.id);
        assert.equal(upgraded.listCanvasFolders().find(folder => folder.id === "drama")?.sharedAssetCanvasId, sharedId);
        assert.ok(fs.readdirSync(f.directory).some(name => name.includes("pre-schema-v23-to-v" + DATABASE_SCHEMA_VERSION)));
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

test("scene preparation does not create projected script text nodes", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    d.source.script_scenes = [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "New script projection", beat_ids: ["b1"] }];
    d.sourceHash = directorHash(d.source);
    d.artifacts = d.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    save(f.episode, "ep", d);
    const runner = new EpisodeProductionRunner(f.episode, f.stores, {} as CanvasGenerationService);
    const prepared = runner.prepareTargets("ep", f.episode.get("ep").revision, ["scene:morning"], "prepare-scene-receipt");
    const projected = (f.db.getCanvasProject(projectId)!.nodes as any[]).filter(node => node.metadata?.productionScriptId);
    assert.equal(projected.length, 0);
    assert.ok([...prepared.layoutReceipt!.created, ...prepared.layoutReceipt!.reused].some(item => item.target === "scene:morning"));
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

function twoReferenceClipFixture(t: test.TestContext) {
    const f = referenceClipFixture(t);
    const extraFile = path.join(f.directory, "approved-2.png"); fs.writeFileSync(extraFile, "approved second identity");
    const extraSha256 = crypto.createHash("sha256").update(fs.readFileSync(extraFile)).digest("hex");
    f.db.upsertMediaFile({ storageKey: "approved-2.png", filePath: extraFile, mimeType: "image/png", bytes: 24, width: 8, height: 8, durationMs: null, createdAt: new Date().toISOString() });
    const project = f.db.getCanvasProject(f.projectId)!;
    f.stores.projects.applyOperations(f.projectId, project.revision, [{ type: "add_node", id: "identity-2", nodeType: "image", metadata: { storageKey: "approved-2.png" } }], { runtimeWrite: true });
    const projectedData = f.episode.get("ep").draft;
    const director = projectedData.director!, artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === "seg1")!;
    (director.source.segments as any[])[0].mode = "Ref2VA";
    director.sourceHash = directorHash(director.source);
    for (const item of director.artifacts) { item.sourceHash = director.sourceHash; item.receipt.sourceHash = director.sourceHash; }
    artifact.prompt = "subject_definitions:\n<Subject 1> Shenyan is from <Picture 1>.\n<Subject 2> Hongxiao is from <Picture 2>.\n\nsummary:\nTwo references.\n\ndetailed_description:\n<Picture 1> Shenyan; <Picture 2> Hongxiao.\n\noverall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A";
    artifact.sha256 = promptHash(artifact.prompt); artifact.receipt.promptHash = artifact.sha256;
    artifact.references.push({ label: "<Picture 2>", nodeId: "identity-2", storageKey: "approved-2.png", sha256: extraSha256, role: "reference" });
    for (const item of director.artifacts) { item.sourceHash = director.sourceHash; item.receipt.sourceHash = director.sourceHash; item.status = "ready"; }
    return { ...f, projectedData };
}
test("the first successful compilation fills a blank legacy Clip Prompt without overwriting a non-empty manual Prompt", t => {
    const f = fixture(t), projectId = ensureProductionCanvas(f.db, "episode", "ep").project.id;
    const d = director();
    Object.values(d.shotInputs).forEach(input => { input.keyframePolicy = "none"; delete input.keyframeAssetId; });
    save(f.episode, "ep", d);
    const current = f.episode.get("ep"), group = current.draft.clipGroups[0];
    const project = f.db.getCanvasProject(projectId)!;
    const blank = { id: group.segmentId!, taskMode: "t2v", prompt: "", duration: 5 };
    const first = productionClipProjection(project, current.draft, group, group.segmentId!, blank);
    assert.equal(first.result.status, "ready", JSON.stringify(first.result));
    assert.equal(first.segment?.prompt, d.artifacts.find(item => item.kind === "h3" && item.targetId === group.id)?.prompt);

    const manual = productionClipProjection(project, current.draft, group, group.segmentId!, { ...blank, prompt: "Manual canvas Prompt stays in use." });
    assert.equal(manual.result.status, "ready", JSON.stringify(manual.result));
    assert.equal(manual.segment?.prompt, "Manual canvas Prompt stays in use.");
    assert.ok(manual.result.diagnostics.some(item => item.code === "MANUAL_INPUT_CONFLICT"));
});
test("an exact compiler Prompt repairs incomplete references without replacing other manual Clip fields", t => {
    const f = referenceClipFixture(t);
    const initial = f.episode.get("ep"), director = initial.draft.director!;
    director.sourceHash = directorHash(director.source);
    for (const artifact of director.artifacts) {
        artifact.sourceHash = director.sourceHash;
        artifact.receipt.sourceHash = director.sourceHash;
        artifact.status = "ready";
    }
    director.artifacts.find(item => item.kind === "h3" && item.targetId === "seg1")!.references[0].role = "environment";
    save(f.episode, "ep", director);
    const current = f.episode.get("ep"), group = current.draft.clipGroups.find(item => item.id === "seg1")!;
    const project = f.db.getCanvasProject(f.projectId)!;
    const baseline = productionClipProjection(project, current.draft, group, group.segmentId!);
    assert.equal(baseline.result.status, "ready", JSON.stringify(baseline.result));
    assert.equal(baseline.segment?.referenceBindings[0].role, "scene", "environment-purpose references use the canvas scene role");
    const manualGroups = { retainedGroup: { subjectId: "SUB-MANUAL", outfitEnabled: true } };
    const incomplete = { ...baseline.segment!, referenceBindings: [], h3CharacterGroups: manualGroups };

    const repaired = productionClipProjection(project, current.draft, group, group.segmentId!, incomplete);
    assert.equal(repaired.result.status, "ready", JSON.stringify(repaired.result));
    assert.equal(repaired.segment?.prompt, baseline.segment?.prompt);
    assert.deepEqual(repaired.segment?.referenceBindings, baseline.segment?.referenceBindings);
    assert.deepEqual(repaired.segment?.h3CharacterGroups, manualGroups, "repairing the missing prompt slot preserves unrelated manual fields");
    assert.ok(!repaired.result.diagnostics.some(item => item.code === "MANUAL_INPUT_CONFLICT" && item.message.includes("referenceBindings")));

    const manuallyRewrittenPrompt = { ...incomplete, prompt: "Manual Prompt remains authored." };
    const preserved = productionClipProjection(project, current.draft, group, group.segmentId!, manuallyRewrittenPrompt);
    assert.equal(preserved.segment?.prompt, manuallyRewrittenPrompt.prompt);
    assert.deepEqual(preserved.segment?.referenceBindings, []);
});

test("fresh compiled Picture tags follow a manually reordered reference list by binding identity", t => {
    const f = twoReferenceClipFixture(t), current = f.projectedData, group = current.clipGroups.find(item => item.id === "seg1")!;
    const project = f.db.getCanvasProject(f.projectId)!;
    const compiled = productionClipProjection(project, current, group, group.segmentId!);
    assert.equal(compiled.result.status, "ready", JSON.stringify(compiled.result));
    const existing = compiled.segment!;
    delete existing.productionClipProjection;
    existing.referenceBindings = [...existing.referenceBindings].reverse();

    const refreshed = productionClipProjection(project, current, group, group.segmentId!, existing, true);
    assert.equal(refreshed.result.status, "ready", JSON.stringify(refreshed.result));
    assert.deepEqual(refreshed.segment?.referenceBindings.map(binding => binding.storageKey), ["approved-2.png", "approved.png"]);
    assert.match(refreshed.segment?.prompt || "", /<Subject 1> Shenyan is from <Picture 2>/);
    assert.match(refreshed.segment?.prompt || "", /<Subject 2> Hongxiao is from <Picture 1>/);
});

test("legacy entity IDs on H3 references resolve by exact source node and explicit Shot binding", t => {
    const f = referenceClipFixture(t), initial = f.episode.get("ep"), director = initial.draft.director!;
    const subjectId = "SUB_ROLE", pictureBindingId = "picture:SUB_ROLE:identity";
    director.source.character_registry = [{ id: "ROLE", name: "Character" }];
    director.source.subject_registry = [{ id: subjectId, kind: "character",
        entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "ROLE" },
        pictureBindings: [{ id: pictureBindingId, assetId: "ROLE", sourceNode: { projectId: f.projectId, nodeId: "identity" },
            selection: { mode: "node_selection" }, provides: ["identity"], retain: [], exclude: [], applicableState: {}, defaultFor: ["identity"] }] }];
    const shot = (director.source.shots as any[]).find(item => item.id === "s1");
    shot.subject_usages = [{ subjectId, presentation: "visible", referencePurpose: ["identity"], continuityFactIds: [],
        pictureBindingMode: "explicit", pictureBindingIds: [pictureBindingId] }];
    const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === "seg1")!;
    artifact.references = [{ ...artifact.references[0], assetId: "ROLE", subjectId: "production-entity-legacy", nodeId: "identity", storageKey: "approved.png" }];
    director.sourceHash = directorHash(director.source);
    for (const item of director.artifacts) {
        item.sourceHash = director.sourceHash;
        item.receipt.sourceHash = director.sourceHash;
        item.status = "ready";
    }
    save(f.episode, "ep", director);
    const current = f.episode.get("ep"), group = current.draft.clipGroups.find(item => item.id === "seg1")!;
    const project = f.db.getCanvasProject(f.projectId)!;
    const projected = productionClipProjection(project, current.draft, group, group.segmentId!);
    assert.equal(projected.result.status, "ready", JSON.stringify(projected.result));
    assert.equal(projected.segment?.referenceBindings.length, 1);
    assert.equal(projected.segment?.referenceBindings[0].subjectId, "production-entity-legacy");
});
test("a changed formal Prompt marks the existing Clip input outdated", t => {
    const f = referenceClipFixture(t);
    const current = f.episode.get("ep"), group = current.draft.clipGroups.find(item => item.id === "seg1")!;
    const project = f.db.getCanvasProject(f.projectId)!;
    const segmentId = "clip-existing-video";
    const director = current.draft.director!;
    director.sourceHash = directorHash(director.source);
    for (const artifact of director.artifacts) {
        artifact.sourceHash = director.sourceHash;
        artifact.receipt.sourceHash = director.sourceHash;
        artifact.status = "ready";
    }
    const baseline = productionClipProjection(project, current.draft, group, segmentId);
    assert.equal(baseline.result.status, "ready", JSON.stringify(baseline.result));
    const existing = { ...baseline.segment!, resultStorageKey: "video:existing", status: "success", inputOutdated: false };

    const unchanged = productionClipProjection(project, current.draft, group, segmentId, existing);
    assert.equal(unchanged.result.status, "ready", JSON.stringify(unchanged.result));
    assert.equal(unchanged.segment?.inputOutdated, false);

    const changed = structuredClone(current.draft), changedGroup = changed.clipGroups.find(item => item.id === group.id)!;
    const artifact = changed.director!.artifacts.find(item => item.targetId === group.id)!;
    const prompt = artifact.prompt.replace("Complete seg1", "Complete seg1 with the refreshed environment binding");
    assert.notEqual(prompt, artifact.prompt);
    artifact.prompt = prompt;
    artifact.sha256 = promptHash(prompt);
    artifact.receipt.promptHash = artifact.sha256;
    const projected = productionClipProjection(project, changed, changedGroup, segmentId, existing);
    assert.equal(projected.result.status, "ready");
    assert.equal(projected.segment?.inputOutdated, true);
    assert.equal(changedGroup.inputOutdated, true);
});
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
    assert.equal(prepared.referenceSync?.[0].status, "ready");
    assert.deepEqual(read().productionClipProjection, projection, "unchanged formal inputs do not rewrite the manual edit baseline");
    assert.equal(read().prompt, "hand rewritten", "recompilation must retain the edited Clip prompt");
});
test("technically verified unreviewed references can be used without being marked approved", t => {
    const f = referenceClipFixture(t);
    const candidate = structuredClone(f.d); candidate.assets.ROLE.status = "generated";
    save(f.episode, "ep", candidate);
    const draft = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "reference-unreviewed");
    assert.equal(draft.referenceSync?.[0].status, "ready");
    const group = draft.draft.clipGroups.find(group => group.id === "seg1")!;
    const read = () => (f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId);
    assert.equal(read().referenceBindings.length, 1);
    assert.equal(f.episode.get("ep").draft.director!.assets.ROLE.status, "generated");
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

test("manual Clip edits remain usable and can be reconciled through the authored source", t => {
    const f = referenceClipFixture(t);
    const prepared = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "conflict-prepare");
    const group = prepared.draft.clipGroups.find(group => group.id === "seg1")!;
    f.stores.projects.applyOperations(f.projectId, Number(f.db.getCanvasProject(f.projectId)!.revision), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: { title: "Reviewed entrance" } }], { operationId: "manual-title" });
    const blocked = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "conflict-read");
    assert.equal(blocked.referenceSync?.[0].status, "ready", JSON.stringify(blocked.referenceSync));
    assert.equal((f.db.getCanvasProject(f.projectId)!.nodes as any[]).find(node => node.id === group.nodeId).metadata.segments.find((clip: any) => clip.id === group.segmentId).title, "Reviewed entrance");
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
    candidate.boundaries[0] = { from: "seg1", to: "seg2", tailFrame: false, motionContext: true, reason: "Keep one uninterrupted camera take across the generation boundary" };
    save(f.episode, "ep", candidate);
    const current = f.episode.get("ep"), project = f.db.getCanvasProject(f.projectId)!;
    const head = buildProductionClip(project, current.draft, current.draft.clipGroups[0], "head");
    const tail = buildProductionClip(project, current.draft, current.draft.clipGroups[1], "tail");
    assert.equal(head.tailFrameContinuation, false); assert.equal(head.motionContextEnabled, true);
    const resolved = resolveH3Runtime({ ...head, h3ParameterPolicy: "defaults" }, {}, { motionContextEnabled: false, tailFrameContinuation: false }, { motionContextEnabled: false, tailFrameContinuation: false });
    assert.equal(resolved.params.motionContextEnabled, true); assert.equal(resolved.params.tailFrameContinuation, false);
    const prepared = f.runner.prepareTargets("ep", current.revision, ["segment:seg1", "segment:seg2"], "enabled-flags");
    const group = prepared.draft.clipGroups[0]; publish(f.episode, "ep");
    const observer = new NativeProductionGeneration(f.db, f.stores, f.episode, f.shared, f.events);
    const manual = observer.prepare({ mode: "video", operation: "h3-run", projectId: f.projectId, nodeId: group.nodeId!, segmentId: group.segmentId!, params: { motionContextEnabled: false } });
    assert.equal(manual.command.params?.motionContextEnabled, false);
    assert.equal(current.draft.director!.boundaries[0].motionContext, true);
    assert.equal(tail.tailFrameContinuation, false); assert.equal(tail.motionContextEnabled, false);
    const conflict = structuredClone(current.draft);
    conflict.director!.boundaries[0].tailFrame = true;
    assert.throws(() => buildProductionClip(project, conflict, conflict.clipGroups[0], "invalid"), /CONTINUITY_MODES_CONFLICT/);
    candidate.boundaries = []; save(f.episode, "ep", candidate);
    const blocked = f.runner.prepareTargets("ep", f.episode.get("ep").revision, ["segment:seg1"], "missing-boundary");
    assert.equal(blocked.referenceSync?.[0].status, "ready");
});

test("saving a formal boundary synchronizes its two outgoing flags onto the scene H3 Clip", t => {
    const f = referenceClipFixture(t), current = f.episode.get("ep"), group = current.draft.clipGroups[0];
    const canvas = f.db.getCanvasProject(f.projectId)!;
    f.stores.projects.applyOperations(f.projectId, Number(canvas.revision), [{
        type: "update_h3_segment", nodeId: group.nodeId!, segmentId: group.segmentId!, patch: { tailFrameContinuation: true, motionContextEnabled: false },
    }], { operationId: "manual-boundary-flags" });

    const beforeBoundaryEdit = f.episode.get("ep");
    f.episode.edit("ep", { operationId: crypto.randomUUID(), expectedRevision: beforeBoundaryEdit.revision, ops: [{ type: "set_director_boundary", boundary: {
        from: "seg1", to: "seg2", tailFrame: false, motionContext: true, reason: "Keep this boundary continuous.",
    } }] });

    const updatedCanvas = f.db.getCanvasProject(f.projectId)!;
    const node = (updatedCanvas.nodes as any[]).find(item => item.id === group.nodeId);
    const segment = node.metadata.segments.find((item: any) => item.id === group.segmentId);
    assert.equal(segment.tailFrameContinuation, false);
    assert.equal(segment.motionContextEnabled, true);
});

test("removing a shared asset still used by Shots is rejected when its Subject is drama-owned", t => {
    // Shared assets adopted from the drama canvas register their Subject against `drama`/`canvas`
    // instead of the episode. Matching the removal guard on the owner kind let those registrations
    // through, so the asset disappeared while the Shots kept an orphan picture binding and the whole
    // production contract became unwritable. The guard must match the stable entity identity.
    const f = fixture(t);
    ensureProductionCanvas(f.db, "episode", "ep");
    const canvasId = f.db.getDramaEpisode("ep")!.canvasId!;
    const d = director(), bindingId = "picture:SUB_ROLE:shared";
    d.source.character_registry = [{ id: "ROLE", name: "Character" }];
    d.source.asset_plan = [...(d.source.asset_plan as any[]), { id: "SHARED_ROLE", kind: "character", entity_id: "ROLE", asset_name: "Character", version: "v1", depends_on: [],
        sharedSource: { dramaId: "drama", assetId: "SHARED_ROLE", sourceProjectId: "shared-canvas", sourceNodeId: "shared-person" } }];
    d.source.subject_registry = [{ id: "SUB_ROLE", kind: "character", entityRef: { ownerKind: "drama", ownerId: "drama", kind: "character", id: "ROLE" },
        pictureBindings: [{ id: bindingId, assetId: "SHARED_ROLE", sourceNode: { projectId: canvasId, nodeId: "identity" },
            selection: { mode: "node_selection" }, provides: ["identity"], retain: [], exclude: [], applicableState: {}, defaultFor: ["identity"] }] }];
    const shot = (d.source.shots as any[]).find(item => item.id === "s1");
    shot.subject_usages = [{ subjectId: "SUB_ROLE", presentation: "visible", pictureBindingMode: "explicit", pictureBindingIds: [bindingId] }];
    d.sourceHash = directorHash(d.source);
    save(f.episode, "ep", d);

    assert.throws(() => f.episode.edit("ep", { operationId: "remove-still-referenced-shared", expectedRevision: f.episode.get("ep").revision,
        ops: [{ type: "remove_shared_director_asset", id: "SHARED_ROLE" }] }), /SUBJECT_STILL_REFERENCED/);
});

test("applying a scoped H3 compilation keeps an unchanged out-of-scope Clip ready", async t => {
    const f = referenceClipFixture(t);
    const seeded = f.episode.get("ep").draft.director!;
    seeded.source.scene_registry = [{ id: "room-1", name: "Room one" }, { id: "room-2", name: "Room two" }];
    (seeded.source.script_scenes as any[])[0].scene_id = "room-1";
    (seeded.source.script_scenes as any[])[1].scene_id = "room-2";
    (seeded.source.shots as any[])[0].scene_id = "room-1";
    (seeded.source.shots as any[])[1].scene_id = "room-2";
    (seeded.source.shots as any[])[0].timeline_id = "timeline-1";
    (seeded.source.shots as any[])[1].timeline_id = "timeline-2";
    (seeded.source.ledger as any).timelines = [{ id: "timeline-1", start_frame: 0 }, { id: "timeline-2", start_frame: 0 }];
    seeded.sourceHash = directorHash(seeded.source);
    for (const artifact of seeded.artifacts) { artifact.sourceHash = seeded.sourceHash; artifact.receipt.sourceHash = seeded.sourceHash; }
    const firstArtifact = seeded.artifacts.find(artifact => artifact.kind === "h3" && artifact.targetId === "seg1")!;
    firstArtifact.prompt = firstArtifact.prompt.replace("<Picture 1> ", "");
    firstArtifact.sha256 = promptHash(firstArtifact.prompt);
    firstArtifact.receipt.promptHash = firstArtifact.sha256;
    firstArtifact.references = [];
    save(f.episode, "ep", seeded);
    const compiler = (input: DirectorProduction) => {
        const targets = new Set(((input.source.segments || []) as Array<Record<string, any>>).map(segment => String(segment.id || "")));
        const artifacts = input.artifacts.filter(artifact => artifact.kind === "h3" && targets.has(artifact.targetId)).map(artifact => {
            const shotText = ((input.source.shots || []) as Array<Record<string, any>>).map(shot => String(shot.visual || "")).join(" ");
            const prompt = `${artifact.prompt}\nAuthored shot input: ${shotText}`;
            const sha256 = promptHash(prompt);
            return { ...artifact, prompt, sha256, sourceHash: input.sourceHash, status: "ready" as const,
                receipt: { ...artifact.receipt, sourceHash: input.sourceHash, promptHash: sha256, engineRuntimeId: input.engine.runtimeId, engine: input.engine, validator: "scoped-clip-projection-fixture" } };
        });
        return { director: { ...input, artifacts }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {} };
    };
    const compilations = new ProductionCompilationService(f.episode, path.join(f.directory, "scoped-clip-compile"), compiler);
    const compileAndApply = async (operationId: string, targetIds: string[]) => {
        const current = f.episode.get("ep");
        const queued = compilations.enqueue("ep", "episode", operationId, current.revision, undefined, { targetIds });
        let job: any = queued;
        for (let attempt = 0; attempt < 40 && ["queued", "running"].includes(job.status); attempt++) {
            await new Promise<void>(resolve => setImmediate(resolve));
            job = compilations.getCompilation("ep", "episode", operationId);
        }
        assert.equal(job.status, "succeeded", JSON.stringify(job.diagnostics));
        return compilations.apply("ep", "episode", job.preparedId);
    };

    const baselineApply = await compileAndApply("scope-clip-initial", ["seg1", "seg2"]);
    assert.equal(baselineApply.referenceSync.find(item => item.targetId === "seg2")?.status, "ready", JSON.stringify(baselineApply.referenceSync));
    const before = f.episode.get("ep");
    const untouchedScopeHash = compilationScopeInput(before.draft.director!, { targetIds: ["seg2"] }).inputHash;
    const edit = f.episode.edit("ep", { operationId: "scope-clip-change-shot-1", expectedRevision: before.revision,
        ops: [{ type: "patch_director_source", entity: "shot", id: "s1", patch: { visual: "Revised entrance, isolated to Clip one." } }] });
    const afterEdit = f.episode.get("ep").draft.director!;
    const untouchedArtifact = afterEdit.artifacts.find(artifact => artifact.targetId === "seg2")!;
    assert.equal(compilationScopeInput(afterEdit, { targetIds: ["seg2"] }).inputHash, untouchedScopeHash);
    assert.equal(currentCompilationArtifact(afterEdit, untouchedArtifact), true, "scope freshness must not depend on an unrelated Shot edit");

    const partialApply = await compileAndApply("scope-clip-refresh-1", ["seg1"]);
    assert.equal(partialApply.referenceSync.find(item => item.targetId === "seg2")?.status, "ready", JSON.stringify(partialApply.referenceSync));
    assert.ok(edit.revision < partialApply.revision);
});
