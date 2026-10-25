import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { directorHash, promptHash } from "./director.js";
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

test("current v2 draft remains usable with an older published snapshot, while restoring that snapshot is rejected without mutation", async (t) => {
    const { db, service } = fixture(t);
    await service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    await service.publish("episode", { operationId: "publish", expectedRevision: 1, stage: "script" });
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
    assert.throws(() => service.version("episode", 1), error => {
        assert.ok(error instanceof ProductionValidationError);
        assert.ok(error.diagnostics.some(item => item.code === "UNSUPPORTED_PRODUCTION_FORMAT"));
        return true;
    });
    assert.throws(() => service.restore("episode", 1, "restore-legacy", readable.revision), error => {
        assert.ok(error instanceof ProductionValidationError);
        assert.ok(error.diagnostics.some(item => item.code === "UNSUPPORTED_PRODUCTION_FORMAT"));
        return true;
    });
    assert.equal(service.get("episode").revision, readable.revision);
    assert.equal((service.get("episode").draft.director?.source as any)?.prompt_assembly?.version, 2);
});

test("initializes the first v2 Director draft from the saved demand and projects its full text into the script", async (t) => {
    const { db, service } = fixture(t);
    const demand = "《首集》\n【场景】草庐·柴门前 / 廊下\n【时间】暴雨深夜\n【剧本正文】\n沈砚推开柴门。红绡倒在泥水中。";
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "雨夜恶祟", synopsis: demand, fullPlot: "fallback", canvasId: "canvas" });
    const saved = await service.edit("episode", { operationId: "init-from-demand", expectedRevision: 0, ops: [{ type: "initialize_director_from_demand" }] });
    const director = saved.draft.director!;
    const source = director.source as Record<string, any>;
    assert.equal(saved.revision, 1);
    assert.equal(source.version, 2);
    assert.equal(source.prompt_assembly.version, 2);
    assert.deepEqual(source.character_registry, []);
    assert.equal(source.scene_registry[0].name, "草庐·柴门前 / 廊下");
    assert.equal(source.script_scenes[0].time_of_day, "暴雨深夜");
    assert.equal(saved.draft.scenes[0].timeOfDay, "暴雨深夜");
    assert.equal(source.script_scenes[0].text, demand);
    assert.equal(saved.draft.scenes[0].blocks[0].text, demand);
    assert.deepEqual(source.shots, []);
    assert.equal(director.sourceHash, directorHash(source));
    assert.equal((await service.edit("episode", { operationId: "init-from-demand", expectedRevision: 0, ops: [{ type: "initialize_director_from_demand" }] })).replayed, true);
    await assert.rejects(async () => await service.edit("episode", { operationId: "init-again", expectedRevision: 1, ops: [{ type: "initialize_director_from_demand" }] }), /DIRECTOR_ALREADY_INITIALIZED/);
});

test("initializes explicit shot-marked demand as editable script blocks without inventing production Shots", async (t) => {
    const { db, service } = fixture(t);
    const demand = "【时间】暴雨深夜\n人物与道具说明。\n\n【镜头1】雨水落在石板上。\n\n【镜头9A】闪回白貉倒下。";
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "雨夜恶祟", synopsis: demand, fullPlot: "fallback", canvasId: "canvas" });
    const saved = await service.edit("episode", { operationId: "init-marked-demand", expectedRevision: 0, ops: [{ type: "initialize_director_from_demand" }] });
    const source = saved.draft.director!.source as Record<string, any>;
    assert.equal(source.script_scenes.length, 3, "preamble and two explicit shot sections are independently editable script blocks");
    assert.equal(source.script_scenes.map((block: any) => block.text).join(""), demand, "block concatenation preserves the saved demand byte-for-byte");
    assert.deepEqual(saved.draft.scenes[0].blocks.map(block => block.text), source.script_scenes.map((block: any) => block.text));
    const projected = (db.getCanvasProject("canvas")!.nodes as any[]).filter(node => node.metadata?.productionScriptId);
    assert.equal(projected.length, 0, "formal script saves do not create scene text nodes on the canvas");
    assert.equal(source.shots.length, 0, "shot labels are not silently promoted to timed production Shots");
    const readiness = service.workflowReadiness("episode") as any;
    assert.equal(readiness.stage.explicitShotCues, 2);
    assert.equal(readiness.stage.structuredShots, 0);
    assert.equal(readiness.stage.compileGate, "blocked");
    assert.match(readiness.nextAction, /2 个镜头标记/);
});

test("fills an empty v2 Director shell from the saved demand without replacing its existing brief", async (t) => {
    const { db, service } = fixture(t);
    const demand = "【场景】沈砚草庐·柴门前 / 廊下\n【时间】暴雨深夜\n完整的当前需求正文。";
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "雨夜恶祟", synopsis: demand, fullPlot: "fallback", canvasId: "canvas" });
    const shell = await service.edit("episode", { operationId: "save-empty-shell", expectedRevision: 0, ops: [{ type: "set_director_brief", brief: "1111" }] });
    const saved = await service.edit("episode", { operationId: "seed-empty-shell", expectedRevision: shell.revision, ops: [{ type: "initialize_director_from_demand" }] });
    const director = saved.draft.director!;
    const source = director.source as Record<string, any>;
    assert.equal(saved.revision, 2);
    assert.equal(source.brief, "1111");
    assert.equal(source.script_scenes[0].text, demand);
    assert.equal(saved.draft.scenes[0].blocks[0].text, demand);
    assert.equal(director.sourceHash, directorHash(source));
});

test("does not seed an empty-looking Director shell while scene work is active", async (t) => {
    const { db, service } = fixture(t);
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "雨夜恶祟", synopsis: "需求正文。", fullPlot: "", canvasId: "canvas" });
    const shell = await service.edit("episode", { operationId: "save-shell-with-work", expectedRevision: 0, ops: [{ type: "set_director_brief", brief: "现有 brief" }] });
    const seededDirector = service.get("episode").draft.director!;
    const active = await service.edit("episode", { operationId: "start-scene-work", expectedRevision: shell.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks: { workA: { workId: "workA", sceneId: "scene", inputRevision: shell.revision, sourceHash: seededDirector.sourceHash, inputHash: "a".repeat(64), status: "running", stage: "create", policy: { mode: "manual", shared: "manual", scene: "manual" }, updatedAt: new Date().toISOString() } } } }] }, undefined, true);
    await assert.rejects(async () => await service.edit("episode", { operationId: "seed-during-work", expectedRevision: active.revision, ops: [{ type: "initialize_director_from_demand" }] }), /DIRECTOR_ALREADY_INITIALIZED/);
    assert.equal((service.get("episode").draft.director!.source.script_scenes as any[]).length, 0);
});

test("current Director source version edits continuity when the full v2 envelope is present", async (t) => {
    const { service } = fixture(t);
    const director = {
        schemaVersion: 1 as const,
        engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" },
        source: { version: 2, prompt_assembly: { version: 2 }, subject_registry: [{ id: "SUB_CHAR_1", kind: "character", entityRef: { ownerKind: "episode", ownerId: "episode", kind: "character", id: "CHAR_1" }, pictureBindings: [] }], character_registry: [{ id: "CHAR_1", name: "Character" }], shots: [], segments: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } },
        sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    };
    await service.edit("episode", { operationId: "current-source", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const fact = { id: "FACT_1", object_kind: "character", object_id: "CHAR_1", allowed_values: ["outside"], value_descriptions: { outside: "The character stays outside." } };
    const saved = await service.edit("episode", { operationId: "current-ledger-edit", expectedRevision: 1, ops: [{ type: "edit_director_continuity", changes: [{ collection: "facts", action: "upsert", id: fact.id, value: fact }] }] });
    assert.equal(saved.revision, 2);
    assert.deepEqual((saved.draft.director!.source.ledger as any).facts, [fact]);
});

test("edit, publication, replay, conflict, impact and version restore retain identities", async (t) => {
    const { service } = fixture(t);
    const input = { operationId: "write-scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] };
    const first = await service.edit("episode", input);
    assert.equal(first.revision, 1);
    assert.equal((await service.edit("episode", input)).replayed, true);
    const stale = await service.edit("episode", { operationId: "stale", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] }); // 乐观锁放行：过期 revision 写入仍落地
    assert.equal(stale.revision, 2);
    const script = await service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" });
    assert.equal(script.publishedVersion, 1);
    assert.equal((await service.publish("episode", { operationId: "publish-script", expectedRevision: 1, stage: "script" })).replayed, true);
    const edited = await service.edit("episode", { operationId: "write-shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b") }] });
    assert.deepEqual(edited.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    const preview = await service.previewImpact("episode", "shots");
    assert.deepEqual(preview.affectedShotIds, ["shot-a", "shot-b"]);
    assert.deepEqual(preview.clipGroupIds, []);
    const published = await service.publish("episode", { operationId: "publish-shots", expectedRevision: 3, stage: "shots" });
    assert.deepEqual(published.impact, preview);
    assert.equal(published.published?.clipGroups.length, 0);
    assert.deepEqual(service.versions("episode").map((item) => item.version), [2, 1]);
    assert.equal(service.version("episode", 2).snapshot.shots[0].id, "shot-a");
    assert.match(service.exportMarkdown("episode", "script", 1).markdown, /她发现信封/);
    assert.match(service.exportMarkdown("episode", "shots", 2).markdown, /镜头 ID：shot-a/);
    const reordered = await service.edit("episode", { operationId: "reorder", expectedRevision: 4, ops: [{ type: "reorder_shots", sceneId: "scene-a", ids: ["shot-b", "shot-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual((await service.previewImpact("episode", "shots")).affectedShotIds, ["shot-b", "shot-a"]);
    const restored = service.restore("episode", 2, "restore", 5);
    assert.deepEqual(restored.draft.shots.map((item) => item.id), ["shot-a", "shot-b"]);
    assert.equal(restored.publishedVersion, 2);
});

test("scene reorder keeps shot IDs but changes their production order", async (t) => {
    const { service } = fixture(t);
    const second = { ...scene, id: "scene-b", heading: "门口", blocks: [{ id: "action-b", kind: "action" as const, text: "她推开门。" }] };
    await service.edit("episode", { operationId: "scenes", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }, { type: "upsert_scene", scene: second }] });
    await service.publish("episode", { operationId: "script", expectedRevision: 1, stage: "script" });
    await service.edit("episode", { operationId: "shots", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: shot("shot-a") }, { type: "upsert_shot", shot: shot("shot-b", "scene-b") }] });
    await service.publish("episode", { operationId: "shots-pub", expectedRevision: 3, stage: "shots" });
    const reordered = await service.edit("episode", { operationId: "reorder-scene", expectedRevision: 4, ops: [{ type: "reorder_scenes", ids: ["scene-b", "scene-a"] }] });
    assert.deepEqual(reordered.draft.shots.map((item) => item.id), ["shot-b", "shot-a"]);
    assert.deepEqual((await service.previewImpact("episode", "script")).changedSceneIds, ["scene-b", "scene-a"]);
});

test("dialogue and action blocks can be inserted, edited and reordered by stable ID", async (t) => {
    const { service } = fixture(t);
    await service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
    const inserted = await service.edit("episode", { operationId: "insert-dialogue", expectedRevision: 1, ops: [{ type: "upsert_script_block", sceneId: "scene-a", beforeBlockId: "action-a", block: { id: "dialogue-a", kind: "dialogue", speaker: "她", text: "是谁寄来的？" } }] });
    assert.deepEqual(inserted.draft.scenes[0].blocks.map((item) => item.id), ["dialogue-a", "action-a"]);
    const edited = await service.edit("episode", { operationId: "edit-blocks", expectedRevision: 2, ops: [{ type: "upsert_script_block", sceneId: "scene-a", block: { ...scene.blocks[0], text: "她看见信封上的署名。" } }, { type: "reorder_script_blocks", sceneId: "scene-a", ids: ["action-a", "dialogue-a"] }] });
    assert.equal(edited.draft.scenes[0].blocks[1].speaker, "她");
    assert.equal(edited.draft.scenes[0].blocks[0].text, "她看见信封上的署名。");
    const deleted = await service.edit("episode", { operationId: "delete-block", expectedRevision: 3, ops: [{ type: "delete_script_block", sceneId: "scene-a", id: "dialogue-a" }] });
    assert.deepEqual(deleted.draft.scenes[0].blocks.map((item) => item.id), ["action-a"]);
});

test("saving a shot's dialogue edits its shared text slice and keeps the other shot's part", async (t) => {
    const { service } = fixture(t);
    await service.edit("episode", { operationId: "scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene }] });
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
    await service.edit("episode", { operationId: "director", expectedRevision: 1, ops: [{ type: "set_director_production", director }] });
    const base = () => service.get("episode").revision;
    const snapshot = () => structuredClone(service.get("episode").draft.director!.source as Record<string, any>);

    // 1) Resave SH_A with the shared line byte-for-byte identical (plus its window): must succeed and touch nothing else.
    const before = snapshot();
    const resaved = await service.edit("episode", { operationId: "resave-unchanged", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, voiceover: true, localStartFrame: 0, localEndFrame: 96 }] }] });
    assert.ok(resaved.revision > base() - 1);
    const after = snapshot();
    assert.deepEqual(after.utterances, before.utterances, "shared record must not be rewritten");
    assert.deepEqual(after.shots[0].utterance_refs, before.shots[0].utterance_refs, "text slice must survive the resave");
    assert.deepEqual(after.shots[1].utterance_refs, before.shots[1].utterance_refs, "the other shot's ref must be untouched");

    // Updating only delivery on a shared utterance must persist without changing
    // its canonical text or either Shot's timing/text slice.
    const delivery = "先在反打镜头原地说出前半句；切镜后再开始移动并说完后半句。";
    const deliveryEdit = await service.edit("episode", { operationId: "edit-shared-delivery", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{
        utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, textMode: "partition", textCuts: [5], delivery,
        voiceover: true, localStartFrame: 0, localEndFrame: 96,
    }] }] });
    const deliverySource = deliveryEdit.draft.director!.source as Record<string, any>;
    assert.equal(deliverySource.utterances[0].delivery, delivery, "delivery-only changes must persist on the shared utterance");
    assert.equal(deliverySource.utterances[0].text, sharedLine, "delivery-only changes must preserve authored dialogue");
    assert.deepEqual(deliverySource.shots[0].utterance_refs, before.shots[0].utterance_refs, "delivery-only changes must preserve the first text/timing slice");
    assert.deepEqual(deliverySource.shots[1].utterance_refs, before.shots[1].utterance_refs, "delivery-only changes must preserve the continuation slice");
    const mutableService = service as any, originalEditedCandidate = mutableService.editedCandidate;
    mutableService.editedCandidate = function (...args: any[]) {
        const candidate = originalEditedCandidate.apply(this, args);
        candidate.draft.director.source.utterances[0].delivery = "模拟漏写";
        return candidate;
    };
    try {
        const revision = base();
        await assert.rejects(async () => await service.edit("episode", { operationId: "edit-delivery-rollback", expectedRevision: revision, ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{
            utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: sharedLine, textMode: "partition", textCuts: [5], delivery: "应保存的指导",
            voiceover: true, localStartFrame: 0, localEndFrame: 96,
        }] }] }), (error: any) => error.diagnostics?.some((item: any) => item.code === "WRITE_VERIFICATION_FAILED"));
        assert.equal(service.get("episode").revision, revision, "a failed field verification rolls back the entire edit");
        assert.equal((service.get("episode").draft.director!.source.utterances as any[])[0].delivery, delivery);
    } finally { mutableService.editedCandidate = originalEditedCandidate; }

    // 2) Each Shot edits only its own text slice; the shared canonical utterance stays concatenated without duplication.
    const editedPart = await service.edit("episode", { operationId: "edit-first-part", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: "她抱紧信封", textMode: "segment", delivery, voiceover: true, localStartFrame: 0, localEndFrame: 96 }] }] });
    const editedSource = editedPart.draft.director!.source as Record<string, any>;
    assert.equal(editedSource.utterances[0].text, "她抱紧信封不走。", "the edited slice is stored once with the untouched continuation");
    assert.equal(editedSource.utterances[0].delivery, delivery, "editing a text slice must preserve the submitted delivery guidance");
    assert.deepEqual(editedSource.shots[1].utterance_refs[0], before.shots[1].utterance_refs[0], "the continuation window and text range stay intact");
    // 3) Removing the shared line from one shot stays blocked; other shots still speak it.
    await assert.rejects(async () => await service.edit("episode", { operationId: "remove-shared", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [] }] }), /不能从本镜删除/);
    // 4) Exclusive lines keep working normally while the shared one rides along untouched.
    const extended = await service.edit("episode", { operationId: "add-exclusive", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [{ utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: "她抱紧信封", textMode: "segment", voiceover: true, localStartFrame: 0, localEndFrame: 96 }, { speakerSubjectId: "SUB_P", text: "是留给我的。", voiceover: false, localStartFrame: 70, localEndFrame: 90 }] }] });
    const nextSource = extended.draft.director!.source as Record<string, any>;
    assert.equal(nextSource.utterances.length, 2, "the exclusive line is added without touching the shared record");
    assert.equal(nextSource.utterances.find((line: any) => String(line.id) === "UTT_SH_A_8").text, "她抱紧信封不走。");
    assert.deepEqual(nextSource.shots[1].utterance_refs, before.shots[1].utterance_refs);
    const temporary = await service.edit("episode", { operationId: "add-temporary-speaker", expectedRevision: base(), ops: [{ type: "set_director_shot_utterances", shotId: "SH_A", utterances: [
        { utteranceId: "UTT_SH_A_8", speakerSubjectId: "SUB_P", text: "她抱紧信封", textMode: "segment", voiceover: true, localStartFrame: 0, localEndFrame: 96 },
        { speakerName: "窗外的守卫", text: "站住！", voiceover: true, localStartFrame: 70, localEndFrame: 90 },
    ] }] });
    const temporarySource = temporary.draft.director!.source as Record<string, any>;
    const temporaryLine = temporarySource.utterances.find((line: any) => line.speakerName === "窗外的守卫");
    assert.ok(temporaryLine, "the typed name is saved on the dialogue event");
    assert.equal(temporaryLine.speakerSubjectId, undefined, "a temporary speaker does not create or reference a registered Subject");
});

test("one production edit can register precise refreshes for multiple changed Clips", async (t) => {
    const { service } = fixture(t);
    const camera = { framing: "MS", movement: "static", attention_subject_ids: ["SUB_P"] };
    const usages = [{ subjectId: "SUB_P", presentation: "visible", referencePurpose: ["identity"] }];
    const source: any = { version: 2, prompt_assembly: { version: 2 }, brief: "双 Clip 刷新范围测试", fps_num: 24, fps_den: 1,
        subject_registry: [{ id: "SUB_P", kind: "character", entityRef: { ownerKind: "episode", ownerId: "episode", kind: "character", id: "P" }, pictureBindings: [] }],
        character_registry: [{ id: "P", name: "角色" }], scene_registry: [{ id: "SC1", name: "场景" }], script_scenes: [{ id: "SCENE1", scene_id: "SC1", text: "测试。" }],
        shots: ["SH1", "SH2", "SH3", "SH4"].map((id, index) => ({ id, scene_id: "SC1", timeline_id: "main", story_order: index, duration_frames: 96, visual: "初始画面。", camera, subject_usages: usages, keyframes: [], utterance_refs: [] })),
        segments: [{ id: "CLIP_A", shot_ids: ["SH1"], mode: "T2VA" }, { id: "CLIP_B", shot_ids: ["SH2"], mode: "T2VA" },
            { id: "CLIP_C", shot_ids: ["SH3"], mode: "T2VA" }, { id: "CLIP_D", shot_ids: ["SH4"], mode: "T2VA" }], utterances: [], asset_plan: [], asset_cards: [],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] } };
    const director = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" }, source,
        sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: Object.fromEntries(["SH1", "SH2", "SH3", "SH4"].map(id => [id, { keyframePolicy: "none", assetIds: [] }])), boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} };
    const seeded = await service.edit("episode", { operationId: "seed-multi-clip-refresh", expectedRevision: service.get("episode").revision, ops: [{ type: "set_director_production", director }] });
    const edited = await service.edit("episode", { operationId: "edit-two-clips", expectedRevision: seeded.revision, ops: [
        { type: "patch_director_source", entity: "shot", id: "SH1", patch: { visual: "第一镜更新。", camera: { movement: "push-in" } } },
        { type: "patch_director_source", entity: "shot", id: "SH2", patch: { visual: "第二镜更新。" } },
        { type: "patch_director_source", entity: "shot", id: "SH3", patch: { visual: "第三镜更新。" } },
        { type: "patch_director_source", entity: "shot", id: "SH4", patch: { visual: "第四镜更新。" } },
        { type: "request_director_clip_refresh", segmentId: "CLIP_A" },
        { type: "request_director_clip_refresh", segmentId: "CLIP_B" },
        { type: "request_director_clip_refresh", segmentId: "CLIP_C" },
        { type: "request_director_clip_refresh", segmentId: "CLIP_D" },
    ] });
    assert.deepEqual((edited as any).clipRefreshes.map((item: any) => item.selectedTargets), [["CLIP_A"], ["CLIP_B"], ["CLIP_C"], ["CLIP_D"]]);
    assert.deepEqual((edited as any).clipRefreshes.map((item: any) => item.sourceSaved), [true, true, true, true]);
    assert.deepEqual((edited as any).referenceSync.map((item: any) => item.targetId), ["CLIP_A", "CLIP_B", "CLIP_C", "CLIP_D"], "source projection and compile refresh share the explicit four-target scope");
    assert.deepEqual((edited.draft.director!.source.shots as any[])[0].camera, { framing: "MS", movement: "push-in", attention_subject_ids: ["SUB_P"] });
    const current = service.get("episode");
    const scopedApply = await service.edit("episode", { operationId: "apply-scoped-compiled-fields", expectedRevision: current.revision,
        ops: [{ type: "set_director_production", director: structuredClone(current.draft.director!) }] }, undefined, false, undefined, undefined, new Set(["CLIP_A"]));
    assert.deepEqual((scopedApply as any).referenceSync.map((item: any) => item.targetId), ["CLIP_A"], "applying one scoped compilation does not reproject unrelated Clips");
});

test("Backend recovery resumes prepared translations by their persisted operation identity", (t) => {
    const { db, service } = fixture(t);
    const request = { kind: "episode", id: "episode", expectedRevision: 3, targetIds: ["SEG1", "SEG2"] };
    db.prepareMcpCommand({ operationId: "recover-translation", tool: "production_translate_compiled_prompts", targetId: "episode", projectId: "canvas",
        request, payload: { stage: "translate", resumeRequest: request }, receipt: { translationStatus: "applying" } });
    db.prepareMcpCommand({ operationId: "legacy-translation", tool: "production_translate_compiled_prompts", targetId: "episode", projectId: "canvas",
        request: { ...request, expectedRevision: 2 }, payload: { stage: "translate" }, receipt: { translationStatus: "translating" } });
    let scheduled: any;
    (service as any).scheduleCompiledPromptTranslation = (...args: unknown[]) => { scheduled = args; };

    assert.equal(service.recoverCompiledPromptTranslations(), 1);
    assert.equal(scheduled[0], "episode");
    assert.equal(scheduled[1], "canvas");
    assert.deepEqual(scheduled[2], { expectedRevision: 3, operationId: "recover-translation", targetIds: ["SEG1", "SEG2"] });
    assert.deepEqual(scheduled[3].request, request);
    assert.equal(db.getMcpCommandReceipt("legacy-translation")?.receipt?.translationStatus, "retry_required");
    assert.equal(db.getMcpCommandReceipt("legacy-translation")?.status, "prepared", "recoverable request remains on the original receipt");
});
