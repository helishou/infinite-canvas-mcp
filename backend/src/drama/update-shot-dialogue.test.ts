import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { directorHash, projectDirector, withoutDirectorProjection } from "./director.js";
import { EpisodeProductionService } from "./production.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-shot-dialogue-"));
    const file = path.join(directory, "db.sqlite");
    const db = new BackendDatabase(file);
    const events = new BackendEventBus();
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, events, directory, false, () => {});
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { db, service };
}

function directorWithDialogue() {
    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, style_policy: "waived", style_policy_reason: "test",
        subject_registry: [{ id: "SUB_A", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "CHAR_A" }, pictureBindings: [] }],
        character_registry: [{ id: "CHAR_A", name: "甲" }],
        scene_registry: [{ id: "room", name: "房间" }],
        script_scenes: [{ id: "sc", scene_id: "room", scene_name: "房间", text: "开场" }],
        asset_plan: [],
        shots: [{
            id: "s1", title: "镜一", scene_id: "room", source_scene_id: "sc", timeline_id: "main", story_order: 0,
            duration_frames: 120, visual: "甲站在门口", camera: { framing: "MS", movement: "static" },
            utterance_refs: [{ utteranceId: "U1", role: "speaker", localStartFrame: 10, localEndFrame: 60, textStart: 0, textEnd: 4 }],
        }],
        utterances: [{
            id: "U1", speakerSubjectId: "SUB_A", text: "哪来的？", delivery: "轻", voiceover: false,
            start: { shotId: "s1", localFrame: 10 }, end: { shotId: "s1", localFrame: 60 },
        }],
        segments: [{ id: "seg1", timeline_id: "main", shot_ids: ["s1"], mode: "T2VA" }],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    };
    return {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" },
        source, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [],
        executionAuthorized: false, unresolved: [], workflow: { mediaProductionMode: "per_item" },
    } as any;
}

function seed(t: test.TestContext) {
    const f = fixture(t);
    const draft = emptyEpisodeProduction();
    draft.director = structuredClone(directorWithDialogue());
    projectDirector(draft);
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 1, ?, NULL, 0, ?)")
        .run("ep", JSON.stringify(withoutDirectorProjection(draft)), new Date().toISOString());
    return f;
}
const edit = (service: EpisodeProductionService, revision: number, ops: any[]) =>
    service.edit("ep", { operationId: crypto.randomUUID(), expectedRevision: revision, ops });

test("update_shot_dialogue 改真值 utterance.text + 文字窗口，并走 sourceHash / 取消执行授权 / 重投影", async t => {
    const { service } = seed(t);
    const before = service.get("ep");
    const text = "改过的台词文本，长度明显不同";
    const after = await edit(service, before.revision, [{ type: "update_shot_dialogue", shotId: "s1", utteranceId: "U1", text }]);
    const source = after.draft.director!.source;
    assert.equal(source.utterances[0].text, text);
    assert.equal(source.shots[0].utterance_refs[0].textStart, 0);
    assert.equal(source.shots[0].utterance_refs[0].textEnd, Array.from(text).length);
    assert.notEqual(after.draft.director!.sourceHash, before.draft.director!.sourceHash);
    assert.equal(after.draft.director!.executionAuthorized, false);
    assert.equal(source.utterances[0].start.shotId, "s1"); // 时间窗没有被改写
});

test("说话人改名落到 speakerName 并清掉 speakerSubjectId；原样重放不改 revision 内容", async t => {
    const { service } = seed(t);
    const first = await edit(service, service.get("ep").revision, [
        { type: "update_shot_dialogue", shotId: "s1", utteranceId: "U1", text: "哪来的？", speaker: "临时路人" },
    ]);
    const u = first.draft.director!.source.utterances[0];
    assert.equal(u.speakerName, "临时路人");
    assert.equal(u.speakerSubjectId, undefined);
    const noop = await edit(service, first.revision, [
        { type: "update_shot_dialogue", shotId: "s1", utteranceId: "U1", text: "哪来的？", speaker: "临时路人" },
    ]);
    assert.equal(noop.draft.director!.sourceHash, first.draft.director!.sourceHash);
    // 改成已登记角色名应回绑到 Subject
    const rebound = await edit(service, noop.revision, [
        { type: "update_shot_dialogue", shotId: "s1", utteranceId: "U1", text: "哪来的？", speaker: "甲" },
    ]);
    const reboundU = rebound.draft.director!.source.utterances[0];
    assert.equal(reboundU.speakerSubjectId, "SUB_A");
    assert.equal(reboundU.speakerName, undefined);
});

test("无对白镜头可新建 utterance + ref；不属于该镜头的 utteranceId 被拒绝", async t => {
    const { service } = seed(t);
    const first = service.get("ep");
    first.draft.director!.source.shots[0].utterance_refs = [];
    first.draft.director!.source.utterances = [];
    const created = await edit(service, first.revision, [
        { type: "update_shot_dialogue", shotId: "s1", text: "新台词", speaker: "甲" },
    ]);
    const source = created.draft.director!.source;
    assert.equal(source.utterances.length, 1);
    assert.equal(source.utterances[0].text, "新台词");
    assert.equal(source.utterances[0].speakerSubjectId, "SUB_A");
    assert.equal(source.shots[0].utterance_refs[0].utteranceId, source.utterances[0].id);
    assert.equal(source.shots[0].utterance_refs[0].textEnd, 3);
    await assert.rejects(
        async () => { await edit(service, created.revision, [{ type: "update_shot_dialogue", shotId: "s1", utteranceId: "OTHER", text: "x" }]); },
        /不属于镜头/,
    );
});
