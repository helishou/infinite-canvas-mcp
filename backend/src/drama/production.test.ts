import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { directorHash } from "./director.js";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { EpisodeProductionRunner } from "./production-runner.js";
import { createStores } from "../stores/index.js";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

const scene = { id: "scene-a", heading: "内景", location: "客厅", timeOfDay: "夜", blocks: [{ id: "action-a", kind: "action" as const, text: "她发现信封。" }] };
const shot = (id: string, sceneId = "scene-a") => ({ id, sceneId, title: id, duration: 5, visual: "她拿起信封。", camera: "近景", openingState: "站在桌边", endingState: "打开信封", sound: "纸张声", assetNodeIds: [], keyframePolicy: "new" as const });

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "episode-production-"));
    const file = join(dir, "production.sqlite");
    const db = new BackendDatabase(file);
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "第一集", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "首集", synopsis: "梗概", fullPlot: "原有剧情原文", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, dir);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, dir, file, service };
}

test("current v2 draft remains usable with an older published snapshot, while restoring that snapshot is rejected without mutation", (t) => {
    const { db, service } = fixture(t);
    service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    service.publish("episode", { operationId: "publish", expectedRevision: 1, stage: "script" });
    const draft = emptyEpisodeProduction();
    draft.scenes = [scene];
    draft.director = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" }, source: { version: 2, prompt_assembly: { version: 2 }, subject_registry: [], shots: [], segments: [], utterances: [], asset_plan: [], character_registry: [], scene_registry: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } }, sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    const historical = structuredClone(draft);
    const source = historical.director!.source as Record<string, any>;
    delete source.prompt_assembly;
    source.ledger = { contract_version: 1, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] };
    source.character_registry = [];
    source.scene_registry = [];
    source.asset_plan = [];
    source.shots = [];
    source.segments = [];
    db.db.prepare("UPDATE episode_productions SET draft_json=?, published_json=?, published_version=1 WHERE episode_id=?").run(JSON.stringify(draft), JSON.stringify(historical), "episode");
    db.db.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=1").run(JSON.stringify(historical), "episode");

    const readable = service.get("episode");
    assert.equal((readable.draft.director?.source as any)?.prompt_assembly?.version, 2);
    assert.equal((readable.published?.director?.source as Record<string, any>).prompt_assembly, undefined);
    assert.equal((service.version("episode", 1).snapshot.director?.source as any)?.ledger.contract_version, 1);
    assert.throws(() => service.restore("episode", 1, "restore-legacy", readable.revision), error => {
        assert.ok(error instanceof ProductionValidationError);
        assert.ok(error.diagnostics.some(item => item.code === "UNSUPPORTED_PRODUCTION_FORMAT"));
        return true;
    });
    assert.equal(service.get("episode").revision, readable.revision);
    assert.equal((service.get("episode").draft.director?.source as any)?.prompt_assembly?.version, 2);
});

test("the current Director source version edits its v2 continuity component without requiring a second format marker", (t) => {
    const { service } = fixture(t);
    const director = {
        schemaVersion: 1 as const,
        engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" },
        source: { version: 2, shots: [], segments: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } },
        sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    };
    service.edit("episode", { operationId: "current-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const fact = { id: "FACT_1", object_kind: "character", object_id: "CHAR_1", allowed_values: ["outside"], value_descriptions: { outside: "The character stays outside." } };
    const saved = service.edit("episode", { operationId: "current-ledger-edit", expectedRevision: 1, ops: [{ type: "edit_director_continuity", changes: [{ collection: "facts", action: "upsert", id: fact.id, value: fact }] }] });
    assert.equal(saved.revision, 2);
    assert.deepEqual((saved.draft.director!.source.ledger as any).facts, [fact]);
});

test("edit, publication, replay, conflict, impact and version restore retain identities", (t) => {
    const { service } = fixture(t);
    const input = { operationId: "write-scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] };
    const first = service.edit("episode", input);
    assert.equal(first.revision, 1);
    assert.equal(service.edit("episode", input).replayed, true);
    assert.throws(() => service.edit("episode", { operationId: "stale", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] }), ProductionConflictError);
    assert.equal(service.get("episode").revision, 1);
    const script = service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" });
    assert.equal(script.publishedVersion, 1);
    assert.equal(service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" }).replayed, true);
    const edited = service.edit("episode", { operationId: "write-shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b") }] });
    assert.deepEqual(edited.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    const preview = service.previewImpact("episode", "shots");
    assert.deepEqual(preview.affectedShotIds, ["shot-a", "shot-b"]);
    assert.deepEqual(preview.clipGroupIds, []);
    const published = service.publish("episode", { operationId: "publish-shots", expectedRevision: 3, stage: "shots" });
    assert.deepEqual(published.impact, preview);
    assert.equal(published.published?.clipGroups.length, 0);
    assert.deepEqual(service.versions("episode").map((item) => item.version), [2, 1]);
    assert.equal(service.version("episode", 2).snapshot.shots[0].id, "shot-a");
    assert.match(service.exportMarkdown("episode", "script", 1).markdown, /她发现信封/);
    assert.match(service.exportMarkdown("episode", "shots", 2).markdown, /镜头 ID：shot-a/);
    const reordered = service.edit("episode", { operationId: "reorder", expectedRevision: 4, ops: [{ type: "reorder_shots", sceneId: "scene-a", ids: ["shot-b", "shot-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual(service.previewImpact("episode", "shots").affectedShotIds, ["shot-b", "shot-a"]);
    const restored = service.restore("episode", 2, "restore", 5);
    assert.deepEqual(restored.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    assert.equal(restored.publishedVersion, 2);
});

test("scene reorder keeps shot IDs but changes their production order", (t) => {
    const { service } = fixture(t);
    const second = { ...scene, id: "scene-b", heading: "门口", blocks: [{ id: "action-b", kind: "action" as const, text: "她推开门。" }] };
    service.edit("episode", { operationId: "scenes", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }, { type: "upsert_scene", scene: second }] });
    service.publish("episode", { operationId: "script", expectedRevision: 1, stage: "script" });
    service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b", "scene-b") }] });
    service.publish("episode", { operationId: "shots-pub", expectedRevision: 3, stage: "shots" });
    const reordered = service.edit("episode", { operationId: "reorder-scene", expectedRevision: 4, ops: [{ type: "reorder_scenes", ids: ["scene-b", "scene-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual(service.previewImpact("episode", "script").changedSceneIds, ["scene-b", "scene-a"]);
});

test("dialogue and action blocks can be inserted, edited and reordered by stable ID", (t) => {
    const { service } = fixture(t);
    service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    const inserted = service.edit("episode", { operationId: "insert-dialogue", expectedRevision: 1, ops: [{ type: "upsert_script_block", sceneId: "scene-a", beforeBlockId: "action-a", block: { id: "dialogue-a", kind: "dialogue", speaker: "她", text: "是谁寄来的？" } }] });
    assert.deepEqual(inserted.draft.scenes[0].blocks.map((item) => item.id), ["dialogue-a", "action-a"]);
    const edited = service.edit("episode", { operationId: "edit-blocks", expectedRevision: 2, ops: [{ type: "upsert_script_block", sceneId: "scene-a", block: { ...scene.blocks[0], text: "她看见信封上的署名。" } }, { type: "reorder_script_blocks", sceneId: "scene-a", ids: ["action-a", "dialogue-a"] }] });
    assert.equal(edited.draft.scenes[0].blocks[1].speaker, "她");
    assert.equal(edited.draft.scenes[0].blocks[0].text, "她看见信封上的署名。");
    const deleted = service.edit("episode", { operationId: "delete-block", expectedRevision: 3, ops: [{ type: "delete_script_block", sceneId: "scene-a", id: "dialogue-a" }] });
    assert.deepEqual(deleted.draft.scenes[0].blocks.map((item) => item.id), ["action-a"]);
});

test("saving a shot's dialogue lets an untouched shared line pass and still blocks real edits or removals", (t) => {
    const { service } = fixture(t);
    service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    // UTT_SH_A_8 「这只信封搬不走。」(8 chars) is spoken by SUB_P across two shots: SH_A covers frames 0-96 with text 0-5,
    // SH_B continues on frames 0-48 with text 5-8 — a legitimate cross-cut shared utterance.
    const sharedLine = "这只信封搬不走。";
    const shots = [
        { id: "SH_A", scene_id: "scene-a", timeline_id: "main", story_order: 0, duration_frames: 96, visual: "她盯着桌上的信封。", camera: { description: "static close-up" }, subject_usages: [], keyframes: [], utterance_refs: [{ utteranceId: "UTT_SH_A_8", role: "speaker", localStartFrame: 0, localEndFrame: 96, textStart: 0, textEnd: 5 }] },
        { id: "SH_B", scene_id: "scene-a", timeline_id: "main", story_order: 1, duration_frames: 96, visual: "特写：信封口被拆开。", camera: { description: "static insert" }, subject_usages: [], keyframes: [], utterance_refs: [{ utteranceId: "UTT_SH_A_8", role: "speaker", localStartFrame: 0, localEndFrame: 48, textStart: 5, textEnd: 8 }] },
    ];
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, character_registry: [{ id: "P", name: "小夏" }], scene_registry: [], subject_registry: [{ id: "SUB_P", kind: "character", entityRef: { ownerKind: "episode", ownerId: "episode", kind: "character", id: "P" }, pictureBindings: [] }], script_scenes: [{ id: "scene-a", scene_id: "scene-a", text: "她发现信封。" }], shots, segments: [{ id: "CLIP_1", shot_ids: ["SH_A", "SH_B"], mode: "T2VA" }], utterances: [{ id: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, voiceover: true, start: { shotId: "SH_A", localFrame: 0 }, end: { shotId: "SH_B", localFrame: 48 } }], asset_plan: [], ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] } };
    const engine = { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" };
    const director = { schemaVersion: 1, engine, source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    service.edit("episode", { operationId: "director", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const base = () => service.get("episode").revision;
    const snapshot = () => structuredClone(service.get("episode").draft.director!.source as Record<string, any>);

    // 1) Resave SH_A with the shared line byte-for-byte identical (plus its window): must succeed and touch nothing else.
    const before = snapshot();
    const resaved = service.edit("episode", { operationId: "resave-unchanged", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, voiceover: true, localStartFrame: 0, localEndFrame: 96 }] }] });
    assert.ok(resaved.revision > base() - 1);
    const after = snapshot();
    assert.deepEqual(after.utterances, before.utterances, "shared record must not be rewritten");
    assert.deepEqual(after.shots[0].utterance_refs, before.shots[0].utterance_refs, "text slice must survive the resave");
    assert.deepEqual(after.shots[1].utterance_refs, before.shots[1].utterance_refs, "the other shot's ref must be untouched");

    // 2) Changing the shared line's content/timing from this shot stays blocked, with an actionable message.
    assert.throws(() => service.edit("episode", { operationId: "modify-shared", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: "换个说法。", voiceover: true, localStartFrame: 0, localEndFrame: 96 }] }] }), /共用（SH_A、SH_B）/);
    // 3) Removing the shared line from one shot stays blocked; other shots still speak it.
    assert.throws(() => service.edit("episode", { operationId: "remove-shared", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [] }] }), /不能从本镜删除/);
    // 4) Exclusive lines keep working normally while the shared one rides along untouched.
    const extended = service.edit("episode", { operationId: "add-exclusive", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, voiceover: true, localStartFrame: 0, localEndFrame: 96 }, { speakerSubjectId: "SUB_P", text: "是留给我的。", voiceover: false, localStartFrame: 70, localEndFrame: 90 }] }] });
    const nextSource = extended.draft.director!.source as Record<string, any>;
    assert.equal(nextSource.utterances.length, 2, "the exclusive line is added without touching the shared record");
    assert.equal(nextSource.utterances.find((line: any) => String(line.id) === "UTT_SH_A_8").text, sharedLine);
    assert.deepEqual(nextSource.shots[1].utterance_refs, before.shots[1].utterance_refs);
});
