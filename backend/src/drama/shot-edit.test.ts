import test from "node:test";
import assert from "node:assert/strict";
import { editDirectorShot, removeShotContent, reconcileShotClipBoundaries } from "./shot-edit.js";
import { directorHash } from "./director.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import { applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { EpisodeProductionService } from "./production.js";

function fixture(): DirectorProduction {
    const source = { prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        character_registry: [{ id: "P", name: "栓子" }], subject_registry: [{ id: "SUB", kind: "character", entityRef: { ownerKind: "episode", ownerId: "ep", kind: "character", id: "P" }, pictureBindings: [{ id: "PB", assetId: "A", sourceNode: { projectId: "project", nodeId: "node" }, selection: { mode: "node_selection" }, provides: ["identity"], retain: [], exclude: [], defaultFor: ["identity"], applicableState: {} }] }],
        shots: [{ id: "S1", timeline_id: "T", scene_id: "SC", story_order: 0, title: "问蛋", duration_frames: 48, visual: "孩子发问。", camera: { framing: "CU", attention_subject_ids: ["SUB"], editorial_reason: "看清孩子发问" }, subject_usages: [{ subjectId: "SUB", presentation: "visible" }],
            performance: { source_beat_id: "B", events: [{ phase: "action", start: 0, end: 40, cue: "孩子抬头" }] }, audio: { description: "风声", events: [{ start: 30, end: 38, cue: "脚步" }] }, keyframes: [{ id: "K", assetId: "A", sourceNode: { projectId: "project", nodeId: "node" }, selection: { mode: "node_selection" }, anchor: "at_frame", localFrame: 36, subjectIds: ["SUB"], retain: [], exclude: [], requiredForSubmission: false }], utterance_refs: [{ utteranceId: "U", role: "speaker", localStartFrame: 0, localEndFrame: 48, textStart: 0, textEnd: 5 }] },
            { id: "S2", timeline_id: "T", scene_id: "SC", story_order: 1, title: "等待", duration_frames: 48, visual: "孩子等待回应。", camera: { framing: "CU", attention_subject_ids: ["SUB"], editorial_reason: "看清孩子发问" }, subject_usages: [], keyframes: [], utterance_refs: [] }],
        segments: [{ id: "C", mode: "T2VA", shot_ids: ["S1", "S2"] }], utterances: [{ id: "U", speakerSubjectId: "SUB", text: "回来先问蛋", start: { shotId: "S1", localFrame: 0 }, end: { shotId: "S1", localFrame: 48 } }],
        ledger: { contract_version: 2, facts: [{ id: "F", object_kind: "character", object_id: "P", allowed_values: ["a", "b"], value_descriptions: { a: "窗外等待", b: "走到门口" } }], timelines: [{ id: "T" }], initial: [{ fact_id: "F", timeline_id: "T", value: "a" }], events: [{ id: "E", shot_id: "S1", local_frame: 36, timeline_id: "T", fact_id: "F", before: "a", after: "b" }], requirements: [{ id: "R", kind: "change", shot_id: "S1", fact_id: "F", event_ids: ["E"] }], coverage: [{ id: "CV", shot_ids: ["S1"], event_ids: ["E"] }] } };
    return { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "4.3.9" }, source, sourceHash: directorHash(source), modules: {}, assets: {}, artifacts: [], shotInputs: { S1: { assetIds: [], keyframePolicy: "none" }, S2: { assetIds: [], keyframePolicy: "none" } }, boundaries: [], workflow: {}, unresolved: [] } as DirectorProduction;
}
test("split and merge preserve original dialogue, event frame, keyframe and timed performance/sound", () => {
    const d = fixture();
    editDirectorShot(d, { type: "edit_director_shot", action: "split", shotId: "S1", newShotId: "N", splitFrame: 24, textOffsets: { U: 2 } });
    const source = d.source as any;
    assert.equal(source.utterances[0].text, "回来先问蛋"); assert.deepEqual(source.utterances[0].end, { shotId: "N", localFrame: 24 });
    assert.deepEqual(source.shots.slice(0, 2).map((shot: any) => shot.utterance_refs[0].textEnd - shot.utterance_refs[0].textStart), [2, 3]);
    assert.equal(subjectShotWindows(source).get("N")!.startFrame + source.ledger.events[0].local_frame, 36);
    assert.equal(source.shots[1].keyframes[0].localFrame, 12); assert.equal(source.shots[1].audio.events[0].start, 6);
    assert.match(source.shots[1].performance.events[0].cue, /延续切点前/);
    assert.deepEqual(source.ledger.coverage[0].shot_ids, ["S1", "N"]);
    editDirectorShot(d, { type: "edit_director_shot", action: "merge", shotId: "S1", targetShotId: "N" });
    const merged = (d.source as any).shots[0];
    assert.equal(merged.duration_frames, 48); assert.equal(merged.keyframes[0].localFrame, 36); assert.equal(merged.audio.events[0].start, 30);
    assert.equal(merged.subject_usages.length, 1);
    assert.deepEqual((d.source as any).utterances[0].end, { shotId: "S1", localFrame: 48 }); assert.equal((d.source as any).ledger.events[0].local_frame, 36);
});
test("copy is a new design, and deletion cleans only its own dialogue and ledger records", () => {
    const deleted = fixture();
    editDirectorShot(deleted, { type: "edit_director_shot", action: "delete", shotId: "S1" });
    assert.deepEqual(deleted.source.utterances, []);
    assert.deepEqual((deleted.source.ledger as any).events, []);
    assert.deepEqual((deleted.source.ledger as any).requirements, []);
    assert.deepEqual((deleted.source.ledger as any).coverage, []);
    assert.deepEqual((deleted.source.shots as any[]).map(shot => shot.id), ["S2"]);
    const d = fixture();
    editDirectorShot(d, { type: "edit_director_shot", action: "duplicate", shotId: "S1", newShotId: "COPY" });
    const source = d.source as any; assert.deepEqual(source.shots[1].utterance_refs, []); assert.deepEqual(source.shots[1].keyframes, []); assert.equal(source.ledger.events.length, 1);
    assert.equal(directorHash(JSON.parse(JSON.stringify(d.source))), d.sourceHash);
    editDirectorShot(d, { type: "edit_director_shot", action: "delete", shotId: "COPY" }); assert.deepEqual((d.source as any).segments[0].shot_ids, ["S1", "S2"]);
});
test("deleting a dialogue slice retains surviving text and anchors without dangling references", () => {
    const d = fixture();
    editDirectorShot(d, { type: "edit_director_shot", action: "split", shotId: "S1", newShotId: "N", splitFrame: 24, textOffsets: { U: 2 } });
    editDirectorShot(d, { type: "edit_director_shot", action: "delete", shotId: "S1" });
    const source = d.source as any;
    assert.equal(source.utterances[0].text, "先问蛋");
    assert.deepEqual(source.utterances[0].start, { shotId: "N", localFrame: 0 });
    assert.deepEqual(source.shots[0].utterance_refs[0], { utteranceId: "U", role: "speaker", localStartFrame: 0, localEndFrame: 24, textStart: 0, textEnd: 3 });
    assert.equal(source.ledger.events[0].shot_id, "N");
    assert.deepEqual(source.ledger.coverage[0].shot_ids, ["N"]);
});
test("shortening a merged Shot clips old appearance windows and supports direct retry", () => {
    const d = fixture(), source = d.source as any;
    source.shots[0].duration_frames = 192;
    source.shots[0].subject_usages = [
        { subjectId: "SUB", presentation: "visible", localStartFrame: 0, localEndFrame: 96 },
        { subjectId: "SUB", presentation: "visible", localStartFrame: 96, localEndFrame: 192 },
    ];
    applyDirectorSourcePatch(d, "shot", "S1", { duration_frames: 96 });
    assert.deepEqual(source.shots[0].subject_usages, [{ subjectId: "SUB", presentation: "visible", localStartFrame: 0, localEndFrame: 96 }]);
    applyDirectorSourcePatch(d, "shot", "S1", { duration_frames: 144 });
    assert.equal(source.shots[0].subject_usages[0].localEndFrame, 144);
});
test("invalid explicit dialogue split and camera merge reject without changing any source", () => {
    const d = fixture(), before = structuredClone(d);
    assert.throws(() => editDirectorShot(d, { type: "edit_director_shot", action: "split", shotId: "S1", newShotId: "N", splitFrame: 24, textOffsets: { U: 0 } }), /切字/); assert.deepEqual(d, before);
    (d.source as any).shots[1].camera = { framing: "MS" }; const changed = structuredClone(d);
    assert.throws(() => editDirectorShot(d, { type: "edit_director_shot", action: "merge", shotId: "S1", targetShotId: "S2" }), /摄影/); assert.deepEqual(d, changed);
});
test("duration edits synchronize keyframes, timed actions, sound and ledger while preserving dialogue", () => {
    const d = fixture();
    const source = d.source as any;
    source.shots[0].duration_frames = 96;
    source.shots[0].keyframes[0].localFrame = 80;
    source.shots[0].performance.events[0].end = 90;
    source.shots[0].audio.events[0] = { start: 70, end: 90, cue: "脚步" };
    source.ledger.events[0].local_frame = 80;
    const beforeVoice = structuredClone(source.utterances);
    applyDirectorSourcePatch(d, "shot", "S1", { duration_frames: 48 });
    assert.equal(source.shots[0].keyframes[0].localFrame, 40);
    assert.equal(source.shots[0].performance.events[0].end, 45);
    assert.deepEqual(source.shots[0].audio.events[0], { start: 35, end: 45, cue: "脚步" });
    assert.equal(source.ledger.events[0].local_frame, 40);
    assert.deepEqual(source.utterances, beforeVoice);
    assert.equal(directorHash(source), d.sourceHash);
});
test("automatic split allocation and split/merge event and dependency mappings stay complete", () => {
    const d = fixture(), source = d.source as any;
    source.shots[0].outcome_events = ["E"];
    d.shotInputs.S2 = { assetIds: ["RIGHT"], keyframePolicy: "reuse", keyframeAssetId: "RIGHT" };
    editDirectorShot(d, { type: "edit_director_shot", action: "duplicate", shotId: "S1", newShotId: "COPY" });
    assert.deepEqual((d.source as any).shots[1].outcome_events, []);
    editDirectorShot(d, { type: "edit_director_shot", action: "delete", shotId: "COPY" });
    editDirectorShot(d, { type: "edit_director_shot", action: "split", shotId: "S1", newShotId: "N", splitFrame: 24 });
    const splitSource = d.source as any;
    assert.deepEqual(splitSource.shots[0].outcome_events, []);
    assert.deepEqual(splitSource.shots[1].outcome_events, ["E"]);
    assert.equal(splitSource.utterances[0].text, "回来先问蛋");
    editDirectorShot(d, { type: "edit_director_shot", action: "merge", shotId: "N", targetShotId: "S2", cameraShotId: "N" });
    assert.deepEqual(d.shotInputs.N.assetIds, ["RIGHT"]);
    assert.equal(d.shotInputs.N.keyframeAssetId, "RIGHT");
    assert.deepEqual((d.source as any).shots[1].outcome_events, ["E"]);
});
test("whole-Clip cleanup keeps shared coverage and unrelated ledger facts, then creates a safe new boundary", () => {
    const d = fixture(), source = d.source as any;
    source.ledger.requirements.push({ id: "R2", kind: "change", shot_id: "S2", fact_id: "F", event_ids: ["E"] });
    source.ledger.coverage[0].shot_ids = ["S1", "S2"];
    const initial = structuredClone(source.ledger.initial);
    removeShotContent(source, new Set(["S1"]));
    assert.deepEqual(source.ledger.requirements, []);
    assert.deepEqual(source.ledger.coverage[0].shot_ids, ["S2"]);
    assert.deepEqual(source.ledger.coverage[0].event_ids, []);
    assert.deepEqual(source.ledger.initial, initial);
    source.segments = [{ id: "A", shot_ids: ["S2"] }, { id: "C", shot_ids: [] }];
    d.boundaries = [{ from: "A", to: "B", tailFrame: true, motionContext: false, reason: "原边界" }, { from: "B", to: "C", tailFrame: false, motionContext: true, reason: "原边界" }];
    reconcileShotClipBoundaries(d, ["A", "B", "C"]);
    assert.equal(d.boundaries.length, 1);
    assert.equal(d.boundaries[0].from, "A"); assert.equal(d.boundaries[0].to, "C");
    assert.equal(d.boundaries[0].tailFrame, false); assert.equal(d.boundaries[0].motionContext, false);
});
test("insert and reorder keep Clip and existing Shot IDs stable", () => {
    const d = fixture();
    editDirectorShot(d, { type: "edit_director_shot", action: "insert", shotId: "S2", shot: { id: "N", duration_frames: 24, title: "新镜头", visual: "听者反应", camera: { framing: "CU" }, subject_usages: [], utterance_refs: [], keyframes: [] } });
    editDirectorShot(d, { type: "edit_director_shot", action: "move", shotId: "N", targetShotId: "S2", position: "before" });
    assert.deepEqual((d.source as any).segments[0].shot_ids, ["S1", "N", "S2"]); assert.deepEqual((d.source as any).shots.map((shot: any) => shot.story_order), [0, 1, 2]);
});
test("production transaction replays structural edits once, keeps other episodes and rejects stale revisions", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shot-edit-")), db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); for (const entry of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, entry)); fs.rmdirSync(directory); });
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", isDrama: true, createdAt: new Date().toISOString() });
    for (const id of ["ep", "other"]) db.upsertDramaEpisode({ id, dramaId: "drama", episodeNumber: id === "ep" ? 1 : 2, title: id, synopsis: "" });
    const service = new EpisodeProductionService(db, new BackendEventBus(), directory, false, () => {});
    const other = service.get("other");
    const before = service.edit("ep", { operationId: "seed", expectedRevision: service.get("ep").revision, ops: [{ type: "set_director_production", director: fixture() }] });
    const request = { operationId: "split-once", expectedRevision: before.revision, ops: [{ type: "edit_director_shot" as const, action: "split" as const, shotId: "S1", newShotId: "N", splitFrame: 24, textOffsets: { U: 2 } }] };
    const saved = service.edit("ep", request), replay = service.edit("ep", request);
    assert.equal(replay.revision, saved.revision); assert.equal((service.get("ep").draft.director!.source.shots as any[]).length, 3);
    assert.equal(directorHash(service.get("ep").draft.director!.source), service.get("ep").draft.director!.sourceHash);
    assert.deepEqual(service.get("other"), other);
    assert.throws(() => service.edit("ep", { ...request, operationId: "stale", ops: [{ type: "edit_director_shot", action: "duplicate", shotId: "S1", newShotId: "COPY" }] }), /版本|REVISION/);
    const receipts = service.clipRefreshStore("ep").byEditAll("split-once");
    assert.equal(receipts.length, 1); assert.equal(receipts[0].segmentId, "C");
    let current = saved;
    for (const shotId of ["S1", "N", "S2"]) {
        const deleting = { operationId: `delete-${shotId}`, expectedRevision: current.revision, ops: [{ type: "edit_director_shot" as const, action: "delete" as const, shotId }] };
        current = service.edit("ep", deleting);
        assert.equal(service.edit("ep", deleting).revision, current.revision);
    }
    assert.deepEqual(service.get("ep").draft.director!.source.shots, []);
    assert.deepEqual(service.get("ep").draft.director!.source.segments, []);
    assert.deepEqual(service.get("ep").draft.director!.source.utterances, []);
    assert.deepEqual(service.get("other"), other);
});
