import assert from "node:assert/strict";
import test from "node:test";
import { directorModules, directorProductionSchema, directorSourceV2Diagnostics, promptSourceMapSchema } from "./production-contract.js";
import { compilationScopeInput } from "./compilation-scope.js";
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
            { id: "S2", timeline_id: "main", story_order: 1, duration_frames: 48, subject_usages: [
                { subjectId: "EGG", presentation: "visible", pictureBindingIds: ["EGG_IMAGE"], referencePurpose: ["prop"], continuityFactIds: [], stateRequirements: [] },
                { subjectId: "SHUANZI", presentation: "state_context", pictureBindingIds: [], referencePurpose: [], continuityFactIds: ["F_SHUANZI_LOCATION"], stateRequirements: [] },
            ], keyframes: [], utterance_refs: [] },
        ],
        segments: [{ id: "C1", shot_ids: ["S1", "S2"], mode: "Ref2VA" }],
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
test("Subject and keyframe bindings can inherit a smart node's independent reference selection", () => {
    const value = source();
    (value.subject_registry[0].pictureBindings[0].selection as any) = { mode: "node_selection" };
    (value.shots[0].keyframes[0].selection as any) = { mode: "node_selection" };
    assert.deepEqual(directorSourceV2Diagnostics(value), []);
});

test("visible Subject usages resolve one declared purpose default when no binding is explicitly selected", () => {
    const value = source();
    value.shots[0].subject_usages[0].pictureBindingIds = [];
    assert.deepEqual(directorSourceV2Diagnostics(value), []);
});

test("visible Subject usages reject missing or ambiguous purpose defaults", () => {
    const missing = source();
    missing.shots[0].subject_usages[0].pictureBindingIds = [];
    missing.subject_registry[0].pictureBindings[0].defaultFor = [];
    assert.ok(directorSourceV2Diagnostics(missing).some(issue => issue.message.includes("缺少适用于 identity 的默认图片绑定")));
    const ambiguous = source();
    ambiguous.shots[0].subject_usages[0].pictureBindingIds = [];
    ambiguous.subject_registry[0].pictureBindings.push({ ...ambiguous.subject_registry[0].pictureBindings[0], id: "SHUANZI_ID_2", assetId: "AST_SHUANZI_2" });
    assert.ok(directorSourceV2Diagnostics(ambiguous).some(issue => issue.message.includes("默认图片绑定有歧义")));
});

test("Clip compilation scope includes only selected Subject bindings and submitted keyframes", () => {
    const authored = source();
    const production = directorProductionSchema.parse({
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" },
        source: authored, sourceHash: "b".repeat(64),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: Object.fromEntries(["AST_SHUANZI", "AST_EGG", "KF_S1"].map(id => [id, { assetId: id, version: "1", status: "generated" }])),
        shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    });
    const first = compilationScopeInput(production, { targetIds: ["C1"], output: "selected" });
    assert.deepEqual(first.targetIds, ["C1"]);
    assert.deepEqual(Object.keys(first.director.assets).sort(), ["AST_EGG", "AST_SHUANZI"]);
    assert.equal(first.director.source.subject_registry[0].pictureBindings.length, 1);
    assert.equal(first.director.source.shots[0].keyframes[0].requiredForSubmission, false);
    const changed = structuredClone(production);
    changed.source.subject_registry[0].pictureBindings[0].selection = { mode: "selected_result", resultId: "another-history" };
    assert.notEqual(compilationScopeInput(changed, { targetIds: ["C1"], output: "selected" }).inputHash, first.inputHash);
});

test("Subject ledger replay derives different start/end states per Shot without writing snapshots into source", () => {
    const value = source();
    value.ledger.initial = [{ timeline_id: "main", fact_id: "F_SHUANZI_LOCATION", value: "outside" }, { timeline_id: "main", fact_id: "F_EGG_LOCATION", value: "nest" }];
    value.ledger.events = [{ id: "E1", timeline_id: "main", fact_id: "F_SHUANZI_LOCATION", shot_id: "S2", local_frame: 12, before: "outside", after: "threshold" }];
    const authored = JSON.stringify(value), windows = subjectShotWindows(value), states = subjectStateProjection(value);
    assert.deepEqual(windows.get("S1"), { shotId: "S1", timelineId: "main", startFrame: 0, endFrame: 96 });
    assert.equal(states.S2.start.find(value => value.factId === "F_SHUANZI_LOCATION")?.value, "outside");
    assert.equal(states.S2.end.find(value => value.factId === "F_SHUANZI_LOCATION")?.value, "threshold");
    assert.equal(JSON.stringify(value), authored);
});

test("Subject assembly v2 locates unknown image bindings, facts, missing value prose and clip gaps", () => {
    const value = source();
    (value.subject_registry[0].pictureBindings[0] as any).assetId = "MISSING_ASSET";
    value.ledger.facts[0].value_descriptions.outside = "";
    value.ledger.facts[1].object_id = "UNKNOWN_SUBJECT";
    (value.segments[0].shot_ids as string[]).splice(1, 1);
    const diagnostics = directorSourceV2Diagnostics(value);
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

test("Prompt SourceMap uses exact UTF-16 offsets and binds a rendered span to its original field", () => {
    const sourceText = "emoji 😀 and dialogue";
    const mapped = "dialogue";
    const start = sourceText.indexOf(mapped);
    const prefixUnits = sourceText.slice(0, start).length;
    const valid = promptSourceMapSchema.parse({ version: 1, offsetUnit: "utf16", segmentId: "C1", sourceHash: "a".repeat(64), promptHash: "b".repeat(64),
        entries: [{ start: 10, end: 10 + mapped.length, sourceKind: "utterance", sourceId: "U1", field: "text", sourceText: mapped,
            sourceValue: sourceText, sourceStart: prefixUnits, sourceEnd: prefixUnits + mapped.length }] });
    assert.equal(valid.entries.length, 1);
    assert.equal(promptSourceMapSchema.safeParse({ ...valid, entries: [{ ...valid.entries[0], sourceText: "wrong" }] }).success, false);
});
