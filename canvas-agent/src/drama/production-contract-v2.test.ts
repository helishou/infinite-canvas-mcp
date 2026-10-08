import assert from "node:assert/strict";
import test from "node:test";
import { directorSourceV2Diagnostics } from "./production-contract.js";
import { subjectShotWindows, subjectStateProjection } from "./subject-assembly.js";

function source() {
    return {
        prompt_assembly: { version: 2 },
        fps_num: 24, fps_den: 1,
        character_registry: [{ id: "SHUANZI", name: "栓子" }],
        subject_registry: [
            { id: "SHUANZI", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "character", id: "SHUANZI" }, pictureBindings: [
                { id: "SHUANZI_ID", assetId: "AST_SHUANZI", sourceNode: { projectId: "CANVAS", nodeId: "IMG_SHUANZI" }, selection: { mode: "latest_success" }, provides: ["identity"], retain: ["face", "hair"], exclude: ["pose", "background"], applicableState: {}, defaultFor: ["identity"] },
            ] },
            { id: "EGG", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "asset", id: "AST_EGG" }, pictureBindings: [
                { id: "EGG_IMAGE", assetId: "AST_EGG", sourceNode: { projectId: "CANVAS", nodeId: "IMG_EGG" }, selection: { mode: "selected_result", resultId: "EGG_1" }, provides: ["shape", "material"], retain: ["shell"], exclude: ["background"], applicableState: {}, defaultFor: ["identity"] },
            ] },
        ],
        asset_plan: [{ id: "AST_SHUANZI", kind: "character" }, { id: "AST_EGG", kind: "prop" }, { id: "KF_S1", kind: "keyframe" }],
        shots: [
            { id: "S1", timeline_id: "main", story_order: 0, duration_frames: 96, subject_usages: [{ subjectId: "SHUANZI", presentation: "visible", pictureBindingIds: ["SHUANZI_ID"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }], keyframes: [{ id: "KF_S1", assetId: "KF_S1", sourceNode: { projectId: "CANVAS", nodeId: "KF_NODE" }, selection: { mode: "latest_success" }, anchor: "opening", subjectIds: ["SHUANZI"], retain: ["composition"], exclude: [], requiredForSubmission: false }], utterance_refs: [] },
            { id: "S2", timeline_id: "main", story_order: 1, duration_frames: 48, subject_usages: [{ subjectId: "EGG", presentation: "visible", pictureBindingIds: ["EGG_IMAGE"], referencePurpose: ["prop"], continuityFactIds: [], stateRequirements: [] }], keyframes: [], utterance_refs: [] },
        ],
        segments: [{ id: "C1", shot_ids: ["S1", "S2"], mode: "Ref2VA", duration_frames: 144 }],
        utterances: [],
        ledger: { contract_version: 2, facts: [
            { id: "F_SHUANZI_LOCATION", object_kind: "character", object_id: "SHUANZI", allowed_values: ["outside", "threshold"], value_descriptions: { outside: "Shuanzi remains outside the coop window.", threshold: "Shuanzi stands near the doorway." } },
            { id: "F_EGG_LOCATION", object_kind: "asset", object_id: "AST_EGG", allowed_values: ["nest", "inside_snake"], value_descriptions: { nest: "The real egg remains in the straw nest.", inside_snake: "The real egg is inside the snake." } },
        ], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
    };
}

test("Subject assembly v2 accepts node-bound pictures, sparse shot keyframes and Subject-owned ledger facts", () => {
    assert.deepEqual(directorSourceV2Diagnostics(source()), []);
});

test("Subject ledger replay derives different start/end states per Shot without writing snapshots into source", () => {
    const value = source();
    value.ledger.initial = [{ timeline_id: "main", fact_id: "F_SHUANZI_LOCATION", value: "outside" }, { timeline_id: "main", fact_id: "F_EGG_LOCATION", value: "nest" }];
    value.ledger.events = [{ id: "E1", timeline_id: "main", fact_id: "F_SHUANZI_LOCATION", shot_id: "S2", local_frame: 12, before: "outside", after: "threshold" }];
    const authored = JSON.stringify(value), windows = subjectShotWindows(value), states = subjectStateProjection(value);
    assert.deepEqual(windows.get("S1"), { shotId: "S1", timelineId: "main", startFrame: 0, endFrame: 96 });
    assert.equal(states.S2.start[0].value, "outside");
    assert.equal(states.S2.end[0].value, "threshold");
    assert.equal(JSON.stringify(value), authored);
});

test("Subject assembly v2 locates unknown image bindings, facts, missing value prose and clip gaps", () => {
    const value = source();
    (value.subject_registry[0].pictureBindings[0] as any).assetId = "MISSING_ASSET";
    value.ledger.facts[0].value_descriptions.outside = "";
    value.ledger.facts[1].object_id = "UNKNOWN_SUBJECT";
    (value.segments[0].shot_ids as string[]).splice(1, 1);
    const diagnostics = directorSourceV2Diagnostics(value);
    assert.ok(diagnostics.some(item => item.path.join(".").includes("pictureBindings") && item.message.includes("MISSING_ASSET")));
    assert.ok(diagnostics.some(item => item.path.join(".").includes("value_descriptions")));
    assert.ok(diagnostics.some(item => item.path.join(".").includes("ledger.facts") && item.message.includes("Subject")));
    assert.ok(diagnostics.some(item => item.message.includes("归属一个 Clip")));
});

test("Subject assembly v2 rejects a spoken event divided across separate Clips", () => {
    const value = source();
    value.utterances = [{ id: "U1", speakerSubjectId: "SHUANZI", text: "回来先问蛋。", start: { shotId: "S1", localFrame: 48 }, end: { shotId: "S2", localFrame: 24 } }];
    value.shots[0].utterance_refs = [{ utteranceId: "U1", role: "speaker", localStartFrame: 48, localEndFrame: 96, textStart: 0, textEnd: 5 }];
    value.shots[1].utterance_refs = [{ utteranceId: "U1", role: "speaker", localStartFrame: 0, localEndFrame: 24, textStart: 5, textEnd: 6 }];
    value.segments = [{ id: "C1", shot_ids: ["S1"], mode: "Ref2VA" }, { id: "C2", shot_ids: ["S2"], mode: "Ref2VA" }];
    assert.ok(directorSourceV2Diagnostics(value).some(item => item.message.includes("完整对白事件必须包含在同一个 Clip")));
});
