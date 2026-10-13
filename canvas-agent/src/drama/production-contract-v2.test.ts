import assert from "node:assert/strict";
import test from "node:test";
import { defaultRequiredShotKeyframes, directorModules, directorProductionSchema, directorSourceV2Diagnostics, promptSourceMapSchema, resolveSubjectPictureBindingIds } from "./production-contract.js";
import { compilationScopeInput } from "./compilation-scope.js";
import { subjectShotWindows, subjectStateProjection } from "./subject-assembly.js";

function source() {
    return {
        version: 2,
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
test("a newly authored keyframe defaults to required while an explicit optional choice is preserved", () => {
    const candidate = source();
    delete (candidate.shots[0].keyframes[0] as any).requiredForSubmission;
    assert.equal(defaultRequiredShotKeyframes(candidate), true);
    assert.equal((candidate.shots[0].keyframes[0] as any).requiredForSubmission, true);

    const explicitOptional = source();
    (explicitOptional.shots[0].keyframes[0] as any).requiredForSubmission = false;
    assert.equal(defaultRequiredShotKeyframes(explicitOptional), false);
    assert.equal((explicitOptional.shots[0].keyframes[0] as any).requiredForSubmission, false);
});
test("the Director source root version is the sole production format gate", () => {
    for (const version of [undefined, 1, 3]) {
        const candidate = source();
        if (version === undefined) delete (candidate as any).version;
        else (candidate as any).version = version;
        assert.ok(directorSourceV2Diagnostics(candidate).some(issue => issue.message.startsWith("UNSUPPORTED_PRODUCTION_FORMAT:")));
    }
    // 旧版兼容注释（曾静默放行缺少装配标记的草稿，无升级引导）：
    // const noAssemblyMarker = source();
    // delete (noAssemblyMarker as any).prompt_assembly;
    // assert.deepEqual(directorSourceV2Diagnostics(noAssemblyMarker), []);
    const noAssemblyMarker = source();
    delete (noAssemblyMarker as any).prompt_assembly;
    const assemblyIssues = directorSourceV2Diagnostics(noAssemblyMarker);
    assert.equal(assemblyIssues.length, 1);
    assert.equal(assemblyIssues[0].path.join("."), "prompt_assembly.version");
    assert.match(assemblyIssues[0].message, /Prompt Assembly 结构不受支持/);
    const oldLedger = source();
    (oldLedger.ledger as any).contract_version = 1;
    assert.ok(directorSourceV2Diagnostics(oldLedger).some(issue => issue.path.join(".") === "ledger.contract_version"));
    const oldShot = source();
    (oldShot.shots[0] as any).prompt_contract_version = 1;
    assert.ok(directorSourceV2Diagnostics(oldShot).some(issue => issue.path.join(".") === "shots.0.prompt_contract_version"));
    const rejected = directorProductionSchema.safeParse({
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "4.3.9" },
        source: oldLedger, sourceHash: "b".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], unresolved: [],
    });
    assert.equal(rejected.success, false);
    if (!rejected.success) assert.ok(rejected.error.issues.some(issue => issue.path.join(".").includes("ledger.contract_version")));
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

test("missing or ambiguous default images do not block saving a visible Subject usage", () => {
    const missing = source();
    missing.shots[0].subject_usages[0].pictureBindingIds = [];
    missing.subject_registry[0].pictureBindings[0].defaultFor = [];
    assert.deepEqual(directorSourceV2Diagnostics(missing), []);
    const director = {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" },
        source: missing, sourceHash: "b".repeat(64),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: Object.fromEntries(["AST_SHUANZI", "AST_EGG", "KF_S1"].map(id => [id, { assetId: id, version: "v1", status: "planned" }])),
        shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    };
    assert.equal(directorProductionSchema.safeParse(director).success, true);
    const ambiguous = source();
    ambiguous.shots[0].subject_usages[0].pictureBindingIds = [];
    ambiguous.subject_registry[0].pictureBindings.push({ ...ambiguous.subject_registry[0].pictureBindings[0], id: "SHUANZI_ID_2", assetId: "AST_SHUANZI_2" });
    assert.deepEqual(directorSourceV2Diagnostics(ambiguous), []);
});

test("explicit empty picture selection is schema-compatible, excluded from compilation scope, and never falls back", () => {
    const value = source();
    const usage = value.shots[0].subject_usages[0] as any;
    usage.pictureBindingMode = "explicit";
    usage.pictureBindingIds = [];
    assert.deepEqual(directorSourceV2Diagnostics(value), []);
    const production = directorProductionSchema.parse({
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" },
        source: value, sourceHash: "b".repeat(64),
        modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned", evidence: [], unresolved: [] }])),
        artifacts: [], assets: Object.fromEntries(["AST_SHUANZI", "AST_EGG", "KF_S1"].map(id => [id, { assetId: id, version: "v1", status: "planned" }])),
        shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    });
    const savedUsage = production.source.shots[0].subject_usages[0];
    assert.equal(savedUsage.pictureBindingMode, "explicit");
    assert.deepEqual(resolveSubjectPictureBindingIds(production.source.subject_registry[0], savedUsage), { bindingIds: [], issues: [] });
    const scope = compilationScopeInput(production, { targetIds: ["C1"], output: "selected" });
    assert.deepEqual(scope.director.source.shots[0].subject_usages[0].pictureBindingIds, []);
    assert.deepEqual(scope.director.source.subject_registry[0].pictureBindings, []);

    const invalid = structuredClone(value);
    (invalid.shots[0].subject_usages[0] as any).pictureBindingIds = ["UNKNOWN_BINDING"];
    assert.ok(directorSourceV2Diagnostics(invalid).some(item => item.path.join(".").includes("pictureBindingIds")));
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
