import assert from "node:assert/strict";
import test from "node:test";
import { storyboardArtifactState, storyboardDurationFrames, storyboardPeople, storyboardLegacyState, storyboardReportedState, storyboardScenes, storyboardSceneShotIds } from "./storyboard-display";
test("legacy shots use their own frames, people and states in the new layout without source migration", () => {
    const source = { character_registry: [{ id: "P", name: "栓子" }] }, shot = { start_frame: 4224, end_frame: 4320, characters: ["P"], state_in: { position: "在窗外" } };
    const original = structuredClone(shot);
    assert.equal(storyboardDurationFrames(shot), 96);
    assert.deepEqual(storyboardPeople(source, shot, false), ["栓子"]);
    assert.deepEqual(storyboardLegacyState(shot.state_in), [{ factId: "position", property: "position", description: "在窗外" }]);
    assert.deepEqual(shot, original);
    assert.equal(Object.hasOwn(shot, "subject_usages"), false);
});
test("v2 presentation keeps frame authority and registered Subject names", () => {
    const source = { subject_registry: [{ id: "SUBJECT", entityRef: { kind: "character", id: "P" } }], character_registry: [{ id: "P", name: "翠子" }] };
    assert.equal(storyboardDurationFrames({ duration_frames: 48, start_frame: 0, end_frame: 96 }), 48);
    assert.deepEqual(storyboardPeople(source, { subject_usages: [{ subjectId: "SUBJECT" }] }, true), ["翠子"]);
});


test("the sidebar uses valid ledger trajectories and never presents stale technical snapshots as state", () => {
 const report = { stale: false, trajectories: { S: { start: { F: "blank" }, end: { F: "signed" } } }, facts: [{ id: "F", name: "契约状态" }] };
 assert.deepEqual(storyboardReportedState(report, "S").end, [{ factId: "F", value: "signed", property: "契约状态" }]);
 assert.deepEqual(storyboardReportedState({ ...report, stale: true }, "S").end, []);
});

test("narrative scene filtering separates repeated environments and retains cross-scene Clips", () => {
 const source = { scene_registry: [{ id: "room", name: "同一房间" }], script_scenes: [{ id: "morning", scene_id: "room", title: "早晨", beat_ids: ["b1"] }, { id: "night", scene_id: "room", title: "夜晚", beat_ids: ["b2"] }], shots: [{ id: "A", source_scene_id: "morning" }, { id: "B", source_scene_id: "night" }, { id: "C", scene_id: "room" }, { id: "D", source_scene_id: "morning" }], segments: [{ id: "legacy", shot_ids: ["A", "B"] }] };
 const original = structuredClone(source);
 const directory = storyboardScenes(source);
 assert.equal(directory.scenes.length, 2);
 assert.deepEqual(directory.unassigned, ["C"]);
 assert.deepEqual([...storyboardSceneShotIds(source, "morning")], ["A", "D", "B"]);
 assert.deepEqual([...storyboardSceneShotIds(source, "__unassigned__")], ["C"]);
 assert.equal(storyboardSceneShotIds(source, "").size, 4);
 assert.deepEqual(source, original);
});

test("an empty narrative scene stays empty and leaves other shots and drafts addressable", () => {
 const source = { script_scenes: [{ id: "empty", title: "空场" }, { id: "full", title: "有镜头" }], shots: [{ id: "A", source_scene_id: "full" }], segments: [{ id: "clip", shot_ids: ["A"] }] };
 const original = structuredClone(source);
 assert.equal(storyboardScenes(source).scenes.find(scene => scene.id === "empty")?.shotIds.length, 0);
 assert.equal(storyboardSceneShotIds(source, "empty").size, 0);
 assert.deepEqual([...storyboardSceneShotIds(source, "full")], ["A"]);
 assert.deepEqual(source, original);
});


test("Clip badges use authoritative freshness and do not reject valid scoped or older-runtime receipts", () => {
 const artifact = { id: "A", status: "ready", sourceHash: "older-global-source", sha256: "prompt", receipt: { sourceHash: "older-global-source", engineRuntimeId: "previous-runtime" } };
 assert.equal(storyboardArtifactState(artifact, { id: "A", sha256: "prompt", current: true, status: "ready" }), "ready");
 assert.equal(storyboardArtifactState(artifact, { id: "A", sha256: "prompt", current: false, status: "ready" }), "stale");
 assert.equal(storyboardArtifactState(artifact), "recorded");
 assert.equal(storyboardArtifactState(artifact, { id: "A", sha256: "old-prompt", current: true, status: "ready" }), "recorded");
 assert.equal(storyboardArtifactState({ ...artifact, receipt: undefined }), "pending");
 assert.equal(storyboardArtifactState({ ...artifact, status: "draft" }), "pending");
 assert.equal(storyboardArtifactState(undefined), "pending");
});
