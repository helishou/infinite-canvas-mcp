import assert from "node:assert/strict";
import test from "node:test";
import { storyboardDurationFrames, storyboardPeople, storyboardLegacyState, storyboardReportedState } from "./storyboard-display";
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
