import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { compilationArtifactFreshness, compilationHash, compilationScopeInput, currentCompilationArtifact, preserveCompilationProvenance, scopedCompilerInput } from "./compilation-scope.js";
import type { DirectorProduction } from "./production-contract.js";
import { directorProductionSchema } from "./production-contract.js";
import { auditAchengContinuity, resolveAchengEngine } from "../skills/acheng.js";

export function scopedDirector(): DirectorProduction {
    const source = { brief: "confirmed", script_scenes: [{ id: "A", scene_id: "ROOM", beat_ids: ["a"] }, { id: "B", scene_id: "ROOM", beat_ids: ["b"] }], shots: [{ id: "SA", source_scene_id: "A", scene_id: "ROOM", visual: "A", required_assets: ["ROLE"] }, { id: "SB", source_scene_id: "B", scene_id: "ROOM", visual: "B", required_assets: ["ROLE"] }], segments: [{ id: "GA", shot_ids: ["SA"] }, { id: "GB", shot_ids: ["SB"] }], asset_plan: [{ id: "ROLE", canvas_scope: "shared" }, { id: "KA", canvas_scope: "episode", shot_ids: ["SA"], depends_on: ["ROLE"] }, { id: "KB", canvas_scope: "episode", shot_ids: ["SB"], depends_on: ["ROLE"] }], asset_cards: [{ id: "KA", references: [{ asset_id: "ROLE" }] }, { id: "KB", references: [{ asset_id: "ROLE" }] }] };
    return { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: compilationHash(source), modules: {}, artifacts: [], assets: { ROLE: { version: "v1", status: "approved", storageKey: "role", sha256: "a".repeat(64) }, KA: { version: "v1", status: "planned" }, KB: { version: "v1", status: "planned" } }, shotInputs: { SA: { assetIds: ["ROLE"], keyframeAssetId: "KA" }, SB: { assetIds: ["ROLE"], keyframeAssetId: "KB" } }, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
}
test("same-environment scene occurrences have isolated compiler inputs and real dependency closures", () => {
    const d = scopedDirector(), a = compilationScopeInput(d, { sceneId: "A" });
    assert.deepEqual((a.director.source.shots as any[]).map(item => item.id), ["SA"]);
    assert.deepEqual(a.targetIds, ["GA", "KA", "ROLE"]);
    const b = structuredClone(d); (b.source.shots as any[])[1].visual = "changed B"; b.sourceHash = compilationHash(b.source);
    assert.equal(compilationScopeInput(b, { sceneId: "A" }).inputHash, a.inputHash);
    b.assets.ROLE.sha256 = "b".repeat(64);
    assert.notEqual(compilationScopeInput(b, { sceneId: "A" }).inputHash, a.inputHash);
});

test("scene compiler scope identifies output Shots separately from retained continuity context", () => {
    const d = scopedDirector();
    const scope = { sceneId: "A" };
    const projection = compilationScopeInput(d, scope);
    const compilerInput = scopedCompilerInput(projection.director, scope);
    assert.deepEqual((compilerInput.source._canvas_compilation_scope as any).outputShotIds, ["SA"]);
});

test("Clip scope skips dormant storyboard frames but retains explicitly requested frames", () => {
    const d = scopedDirector();
    (d.source.asset_plan as any[]).find(item => item.id === "KA").kind = "keyframe";
    d.shotInputs.SA.keyframePolicy = "none";
    const clip = compilationScopeInput(d, { targetIds: ["GA"] });
    assert.deepEqual(clip.targetIds, ["GA", "ROLE"]);
    const explicit = compilationScopeInput(d, { targetIds: ["KA"] });
    assert.ok(explicit.targetIds.includes("KA"));
});

test("V2 frame-only scope retains replay binding declarations and flat-block coverage", () => {
    const d = scopedDirector();
    d.source.version = 2;
    d.source.prompt_assembly = { version: 2 };
    d.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "T" }], initial: [], events: [], requirements: [], coverage: [] };
    d.source.character_registry = [{ id: "P", name: "人物" }];
    d.source.subject_registry = [{ id: "P", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "character", id: "P" }, pictureBindings: [
        { id: "P_ID", assetId: "ROLE", sourceNode: { projectId: "CANVAS", nodeId: "IMAGE" }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["identity"], exclude: ["pose"], applicableState: {}, defaultFor: ["identity"] }
    ] }];
    d.source.shots = (d.source.shots as any[]).map((shot, order) => ({ ...shot, timeline_id: "T", story_order: order, duration_frames: 96,
        subject_usages: [{ subjectId: "P", presentation: "visible", pictureBindingIds: ["P_ID"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }], keyframes: [], utterance_refs: [] }));
    for (const shot of d.source.shots as any[]) delete shot.required_assets;
    (d.source.script_scenes as any[])[0].text = "人物进入。";
    const block = (d.source.script_scenes as any[])[0];
    d.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "T" }], initial: [], events: [], requirements: [], coverage: [
        { id: "COV", source_anchor: { block_id: "A" }, source_digest: compilationHash({ scene_id: "ROOM", block }), evidence_kind: "not_applicable_with_rule", fact_ids: [], event_ids: [], shot_ids: ["SA"], rule: "non_narrative_note" }
    ] };
    d.sourceHash = compilationHash(d.source);
    const before = structuredClone(d);
    const input = compilationScopeInput(d, { targetIds: ["KA"], output: "selected" });
    assert.deepEqual(input.targetIds, ["KA"]);
    assert.deepEqual(input.director.source.segments, []);
    assert.deepEqual((input.director.source.subject_registry as any[])[0].pictureBindings.map(binding => binding.id), ["P_ID"]);
    assert.equal((input.director.source.ledger as any).coverage[0].id, "COV");
    const checked = directorProductionSchema.safeParse(scopedCompilerInput(input.director, { targetIds: ["KA"], output: "selected" }));
    assert.equal(checked.success, true, checked.success ? "" : JSON.stringify(checked.error.issues));
    assert.deepEqual(d, before);
});

test("V2 Clip scope retains a registered dialogue speaker even without a visual Subject usage", () => {
    const d = scopedDirector();
    d.source.version = 2;
    d.source.prompt_assembly = { version: 2 };
    d.source.character_registry = [{ id: "LIN", name: "林澄" }];
    d.source.scene_registry = [{ id: "ROOM", name: "厨房" }];
    d.source.script_scenes = [{ id: "A", scene_id: "ROOM", blocks: [{ id: "B1", kind: "action", text: "林澄走进厨房。" }] }];
    d.source.subject_registry = [{ id: "SUB_LIN", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "character", id: "LIN" }, pictureBindings: [] }];
    d.source.shots = [{ id: "SA", source_scene_id: "A", scene_id: "ROOM", timeline_id: "T", story_order: 0, duration_frames: 96,
        visual: "林澄走进厨房，低声呼唤阿团。", camera: { framing: "MS", attention_subject_ids: ["SUB_LIN"], editorial_reason: "交代林澄发现空碗。" },
        subject_usages: [], keyframes: [], utterance_refs: [{ utteranceId: "U1", role: "speaker", localStartFrame: 12, localEndFrame: 60, textStart: 0, textEnd: 3 }] }];
    d.source.segments = [{ id: "GA", shot_ids: ["SA"], mode: "T2VA", mode_lock: "T2VA", mode_selection_reason: "No media references are selected for this text-to-video Clip." }];
    d.source.utterances = [{ id: "U1", speakerSubjectId: "SUB_LIN", text: "阿团？", start: { shotId: "SA", localFrame: 12 }, end: { shotId: "SA", localFrame: 60 } }];
    d.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "T" }], initial: [], events: [], requirements: [], coverage: [] };
    d.shotInputs = { SA: { keyframePolicy: "none" } };
    d.sourceHash = compilationHash(d.source);

    const scoped = compilationScopeInput(d, { targetIds: ["GA"] });
    assert.deepEqual((scoped.director.source.subject_registry as any[]).map(subject => subject.id), ["SUB_LIN"]);
    const checked = directorProductionSchema.safeParse(scopedCompilerInput(scoped.director, { targetIds: ["GA"], output: "selected" }));
    assert.equal(checked.success, true, checked.success ? "" : JSON.stringify(checked.error.issues));
});

test("a bound shared Subject image remains a media dependency without becoming a standalone asset-prompt target", () => {
    const d = scopedDirector();
    d.source.version = 2;
    d.source.prompt_assembly = { version: 2 };
    d.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "T" }], initial: [], events: [], requirements: [], coverage: [] };
    d.source.character_registry = [{ id: "SHARED_CHARACTER", name: "Shared" }];
    d.source.subject_registry = [{ id: "SUB_SHARED", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "character", id: "SHARED_CHARACTER" }, pictureBindings: [
        { id: "SHARED_IMAGE", assetId: "SHARED_ASSET", sourceNode: { projectId: "EP_CANVAS", nodeId: "SHARED_REF" }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["identity"], exclude: ["pose"], applicableState: {}, defaultFor: ["identity"] },
    ] }];
    d.source.asset_plan = [
        { id: "SHARED_ASSET", kind: "character", entity_id: "SHARED_CHARACTER", version: "v1", purpose: "Shared source", status: "planned", depends_on: [], sharedSource: { sourceProjectId: "SHARED_CANVAS", sourceNodeId: "CHAR_NODE" } },
        { id: "LOCAL_PROP", kind: "prop", version: "v1", purpose: "Local prop", status: "planned", depends_on: [], shot_ids: ["SA"] },
        { id: "CONTEXT_PROP", kind: "prop", version: "v1", purpose: "Context prop", status: "planned", depends_on: [] },
    ];
    d.source.asset_cards = [
        { id: "SHARED_ASSET", asset_kind: "character", prompt: "", references: [], reference_policy: "none" },
        { id: "LOCAL_PROP", asset_kind: "prop", prompt: "A complete local prop prompt", references: [], reference_policy: "none" },
    ];
    d.source.shots = [{ id: "SA", timeline_id: "T", story_order: 0, duration_frames: 96,
        camera: { attention_subject_ids: ["SUB_SHARED", "SUB_LOCAL_PROP"] },
        subject_usages: [{ subjectId: "SUB_SHARED", presentation: "visible", pictureBindingIds: ["SHARED_IMAGE"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] },
            { subjectId: "SUB_LOCAL_PROP", presentation: "visible", pictureBindingIds: [], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }], keyframes: [], utterance_refs: [] }];
    d.source.subject_registry.push({ id: "SUB_LOCAL_PROP", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "asset", id: "LOCAL_PROP" }, pictureBindings: [] } as any);
    d.source.subject_registry.push({ id: "SUB_CONTEXT_PROP", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "asset", id: "CONTEXT_PROP" }, pictureBindings: [] } as any);
    (d.source.shots as any[])[0].camera.attention_subject_ids.push("SUB_CONTEXT_PROP");
    (d.source.shots as any[])[0].subject_usages.push({ subjectId: "SUB_CONTEXT_PROP", presentation: "state_context", pictureBindingIds: [], referencePurpose: [], continuityFactIds: [], stateRequirements: [] });
    d.source.segments = [{ id: "GA", shot_ids: ["SA"], mode: "Ref2VA" }];
    d.sourceHash = compilationHash(d.source);
    d.assets.SHARED_ASSET = { version: "v1", status: "generated", nodeId: "SHARED_REF", storageKey: "image:shared", sha256: "a".repeat(64), sharedSource: { sourceProjectId: "SHARED_CANVAS", sourceNodeId: "CHAR_NODE" } };
    d.assets.LOCAL_PROP = { version: "v1", status: "generated", storageKey: "image:local-prop", sha256: "b".repeat(64) };
    d.assets.CONTEXT_PROP = { version: "v1", status: "generated", storageKey: "image:context-prop", sha256: "c".repeat(64) };
    const before = structuredClone(d);

    const scoped = compilationScopeInput(d, { targetIds: ["GA"] });
    assert.deepEqual(scoped.targetIds, ["GA", "LOCAL_PROP"]);
    assert.deepEqual((scoped.director.source.asset_cards as any[]).map(card => card.id), ["LOCAL_PROP"]);
    const sharedPlan = (scoped.director.source.asset_plan as any[]).find(plan => plan.id === "SHARED_ASSET");
    assert.equal(sharedPlan.status, "generated");
    assert.equal(sharedPlan.sha256, "a".repeat(64));
    assert.equal(sharedPlan.file, "shared-assets/SHARED_ASSET.png");
    assert.equal(scoped.director.assets.SHARED_ASSET.storageKey, "image:shared");
    const propAlias = (scoped.director.source.asset_plan as any[]).find(plan => plan.id === "SUB_LOCAL_PROP");
    assert.equal(propAlias._compiler_subject_alias, true);
    assert.equal(propAlias.status, "generated");
    assert.equal(propAlias.file, "compiler-subject-aliases/SUB_LOCAL_PROP.png");
    assert.equal(propAlias._compiler_source_asset_id, "LOCAL_PROP");
    const contextPlan = (scoped.director.source.asset_plan as any[]).find(plan => plan.id === "CONTEXT_PROP");
    assert.equal(contextPlan.status, "generated");
    assert.equal(contextPlan._compiler_registry_media, true);
    assert.equal(contextPlan.file, "compiler-registry-assets/CONTEXT_PROP.png");
    assert.equal(scoped.director.assets.CONTEXT_PROP.storageKey, "image:context-prop");
    assert.deepEqual(d, before, "compiler projection must not rewrite the authored episode source");
});

test("continuity replay context keeps the prior Shot's picture binding resolvable without making it a Clip reference", () => {
    const d = scopedDirector();
    d.source.version = 2;
    d.source.prompt_assembly = { version: 2 };
    d.source.character_registry = [{ id: "P", name: "人物" }];
    d.source.subject_registry = [{ id: "P", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP", kind: "character", id: "P" }, pictureBindings: [
        { id: "P_ID", assetId: "ROLE", sourceNode: { projectId: "CANVAS", nodeId: "IMAGE" }, selection: { mode: "node_selection" }, provides: ["identity"], retain: ["identity"], exclude: ["pose"], applicableState: {}, defaultFor: ["identity"] }
    ] }];
    d.source.shots = [
        { id: "SA", source_scene_id: "A", scene_id: "ROOM", timeline_id: "T", story_order: 0, duration_frames: 96,
            subject_usages: [{ subjectId: "P", presentation: "visible", pictureBindingIds: ["P_ID"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }], keyframes: [], utterance_refs: [] },
        { id: "SB", source_scene_id: "B", scene_id: "ROOM", timeline_id: "T", story_order: 1, duration_frames: 96,
            subject_usages: [], keyframes: [], utterance_refs: [] },
    ];
    d.source.segments = [
        { id: "GA", shot_ids: ["SA"], mode: "Ref2VA" },
        { id: "GB", shot_ids: ["SB"], mode: "Ref2VA" },
    ];
    d.source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "T" }], initial: [], events: [], requirements: [], coverage: [] };
    d.sourceHash = compilationHash(d.source);

    const scoped = compilationScopeInput(d, { targetIds: ["GB"] });
    assert.deepEqual((scoped.director.source.shots as any[]).map(shot => shot.id), ["SA", "SB"], "prior Shot remains for continuity replay");
    assert.deepEqual((scoped.director.source.shots as any[])[0].subject_usages.map((usage: any) => usage.subjectId), ["P"]);
    // The retained replay Shot still declares P_ID, so the projection must keep the
    // binding resolvable; otherwise the source schema rejects it with
    // "图片绑定 P_ID 不属于 Subject P" and a single-Clip compile is blocked outright.
    assert.deepEqual((scoped.director.source.subject_registry as any[])[0].pictureBindings.map((binding: any) => binding.id), ["P_ID"]);
    const checked = directorProductionSchema.safeParse(scopedCompilerInput(scoped.director, { targetIds: ["GB"] }));
    assert.equal(checked.success, true, checked.success ? "" : JSON.stringify(checked.error.issues));
    d.source.segments = [{ id: "GAB", shot_ids: ["SA", "SB"], mode: "Ref2VA" }];
    d.sourceHash = compilationHash(d.source);
    const sharedClip = compilationScopeInput(d, { targetIds: ["GAB"] });
    assert.deepEqual((sharedClip.director.source.subject_registry as any[])[0].pictureBindings.map((binding: any) => binding.id), ["P_ID"], "a Subject used by any Shot in the output Clip keeps its picture reference");
});

test("scoped ledger retains coverage using the authored source anchor", () => {
    const d = scopedDirector();
    (d.source.script_scenes as any[])[0].blocks = [{ id: "A1", kind: "action", text: "Enter" }];
    (d.source.script_scenes as any[])[1].blocks = [{ id: "B1", kind: "action", text: "Leave" }];
    d.source.ledger = { contract_version: 2, coverage: [{ id: "CA", source_anchor: { block_id: "A1" } }, { id: "CB", source_anchor: { block_id: "B1" } }] };
    const a = compilationScopeInput(d, { sceneId: "A" });
    assert.deepEqual((a.director.source.ledger as any).coverage.map((row: any) => row.id), ["CA"]);
});

test("scoped replay retains genuine foreign asset identities without expanding output or media", () => {
    const director = scopedDirector();
    (director.source.asset_plan as any[]).push({ id: "FOREIGN_PROP", canvas_scope: "episode", shot_ids: ["SB"] });
    director.source.ledger = { contract_version: 2, facts: [{ id: "FOREIGN_STATE", object_kind: "asset", object_id: "FOREIGN_PROP" }] };
    const before = structuredClone(director);
    const scoped = compilationScopeInput(director, { sceneId: "A" });
    assert.ok((scoped.director.source._canvas_continuity_asset_registry as any[]).some(item => item.id === "FOREIGN_PROP"));
    assert.ok(!(scoped.director.source.asset_plan as any[]).some(item => item.id === "FOREIGN_PROP"));
    assert.ok(!scoped.targetIds.includes("FOREIGN_PROP"));
    assert.equal(scoped.director.assets.FOREIGN_PROP, undefined);
    assert.deepEqual(director, before);
});

test("one Clip keeps shared-block coverage, event references and replay context without compiling sibling Clips", () => {
    const d = scopedDirector(), runtime = resolveAchengEngine();
    d.engine = { commit: runtime.commit, patchVersion: runtime.patchVersion, runtimeId: runtime.runtimeId, version: runtime.version };
    const block = { id: "BLOCK", kind: "action", text: "The door opens and then closes." };
    d.source.script_scenes = [{ id: "A", scene_id: "ROOM", blocks: [block] }];
    d.source.character_registry = [{ id: "CHAR", name: "Alex" }];
    d.source.scene_registry = [{ id: "ROOM", name: "Room" }];
    d.source.shots = ["SA", "SB"].map((id, order) => ({ id, source_scene_id: "A", scene_id: "ROOM", timeline_id: "T", story_order: order, start_frame: order * 120, end_frame: (order + 1) * 120, continuity_facts: ["F"], visual: "The door changes state." }));
    d.source.ledger = { contract_version: 2, facts: [{ id: "F", object_kind: "character", object_id: "CHAR", allowed_values: ["closed", "open"] }], timelines: [{ id: "T" }], initial: [{ timeline_id: "T", fact_id: "F", value: "closed" }],
        events: ["SA", "SB"].map((shot_id, order) => ({ id: `E${order}`, shot_id, timeline_id: "T", fact_id: "F", frame: order * 120 + 10, before: order ? "open" : "closed", after: order ? "closed" : "open", reason: "The authored door action changes the state.", source_anchor: { block_id: "BLOCK" } })), requirements: ["SA", "SB"].map((shot_id, order) => ({ id: `R${order}`, shot_id, timeline_id: "T", fact_id: "F", kind: "change", event_ids: [`E${order}`] })),
        coverage: [{ id: "C", timeline_id: "T", source_anchor: { block_id: "BLOCK" }, source_digest: compilationHash({ scene_id: "ROOM", block }), evidence_kind: "explicit_change", fact_ids: ["F"], event_ids: ["E0", "E1"], shot_ids: ["SA", "SB"] }] };
    const before = structuredClone(d);
    const projected = compilationScopeInput(d, { sceneId: "A", targetIds: ["GB"] });
    assert.deepEqual((projected.director.source.segments as any[]).map(segment => segment.id), ["GB"]);
    assert.ok(!projected.targetIds.includes("GA"));
    assert.ok(!projected.targetIds.includes("KA"));
    assert.deepEqual((projected.director.source.ledger as any).events.map((event: any) => event.id), ["E0", "E1"]);
    const normalized = scopedCompilerInput(projected.director, { targetIds: ["GB"] });
    const checked = auditAchengContinuity(normalized, ["GB"]);
    assert.equal(checked.status, "passed", JSON.stringify(checked.diagnostics));
    assert.equal(checked.trajectories.SB.start.F, "open");
    assert.deepEqual(d, before);
    assert.throws(() => compilationScopeInput(d, { targetIds: ["MISSING"] }), /UNKNOWN_TARGET/);
});

test("Subject Prompt v2 scope ignores continuity facts not selected by its output Shots", () => {
    const d = scopedDirector();
    d.source.version = 2;
    d.source.prompt_assembly = { version: 2 };
    d.source.script_scenes = [{ id: "A", scene_id: "ROOM", blocks: [{ id: "BLOCK", kind: "action", text: "Alex crosses the room." }] }];
    d.source.character_registry = [{ id: "CHAR", name: "Alex" }];
    d.source.subject_registry = [{ id: "P", kind: "character", entityRef: { kind: "character", id: "CHAR" }, pictureBindings: [] }];
    d.source.shots = ["SA", "SB"].map((id, order) => ({
        id, source_scene_id: "A", scene_id: "ROOM", timeline_id: "T", story_order: order,
        start_frame: order * 120, end_frame: (order + 1) * 120, visual: `Shot ${order}`,
        subject_usages: [{ subjectId: "P", presentation: "state_context", pictureBindingIds: [], referencePurpose: [],
            continuityFactIds: [id === "SA" ? "G_UNSELECTED" : "F_SELECTED"], stateRequirements: [] }],
        keyframes: [], utterance_refs: [],
    }));
    d.source.ledger = {
        contract_version: 2,
        facts: [
            { id: "F_SELECTED", object_kind: "character", object_id: "CHAR", allowed_values: ["calm", "afraid"] },
            { id: "G_UNSELECTED", object_kind: "character", object_id: "CHAR", allowed_values: ["dry", "wet"] },
        ],
        timelines: [{ id: "T" }],
        initial: [
            { timeline_id: "T", fact_id: "F_SELECTED", value: "calm" },
            { timeline_id: "T", fact_id: "G_UNSELECTED", value: "dry" },
        ],
        events: [
            { id: "EF0", shot_id: "SA", timeline_id: "T", fact_id: "F_SELECTED", frame: 10, before: "calm", after: "afraid", reason: "selected fact changes" },
            { id: "EF1", shot_id: "SB", timeline_id: "T", fact_id: "F_SELECTED", frame: 130, before: "afraid", after: "calm", reason: "selected fact changes back" },
            { id: "EG0", shot_id: "SA", timeline_id: "T", fact_id: "G_UNSELECTED", frame: 20, before: "dry", after: "wet", reason: "unselected fact changes" },
            { id: "EG1", shot_id: "SB", timeline_id: "T", fact_id: "G_UNSELECTED", frame: 140, before: "wet", after: "dry", reason: "unselected fact changes back" },
        ],
        requirements: [
            { id: "RF", shot_id: "SB", timeline_id: "T", fact_id: "F_SELECTED", kind: "change", event_ids: ["EF0", "EF1"] },
            { id: "RG", shot_id: "SB", timeline_id: "T", fact_id: "G_UNSELECTED", kind: "change", event_ids: ["EG0", "EG1"] },
        ],
        coverage: [
            { id: "CF", source_anchor: { block_id: "BLOCK" }, fact_ids: ["F_SELECTED"], event_ids: ["EF0", "EF1"], shot_ids: ["SA", "SB"] },
            { id: "CG", source_anchor: { block_id: "BLOCK" }, fact_ids: ["G_UNSELECTED"], event_ids: ["EG0", "EG1"], shot_ids: ["SA", "SB"] },
        ],
    };
    d.sourceHash = compilationHash(d.source);

    const scope = { targetIds: ["GB"], output: "selected" as const };
    const baseline = compilationScopeInput(d, scope);
    assert.deepEqual((baseline.director.source.ledger as any).facts.map((fact: any) => fact.id), ["F_SELECTED"]);
    assert.deepEqual((baseline.director.source.ledger as any).events.map((event: any) => event.id), ["EF0", "EF1"]);
    assert.deepEqual((baseline.director.source.ledger as any).requirements.map((requirement: any) => requirement.id), ["RF"]);
    assert.deepEqual((baseline.director.source.ledger as any).coverage.map((item: any) => item.id), ["CF"]);

    const changedUnselectedFact = structuredClone(d);
    const unselected = (changedUnselectedFact.source.ledger as any).facts.find((fact: any) => fact.id === "G_UNSELECTED");
    unselected.allowed_values.push("soaked");
    (changedUnselectedFact.source.ledger as any).initial.find((item: any) => item.fact_id === "G_UNSELECTED").value = "soaked";
    (changedUnselectedFact.source.ledger as any).events.find((event: any) => event.id === "EG0").after = "soaked";
    (changedUnselectedFact.source.ledger as any).requirements.find((item: any) => item.id === "RG").kind = "hold";
    changedUnselectedFact.sourceHash = compilationHash(changedUnselectedFact.source);
    assert.equal(compilationScopeInput(changedUnselectedFact, scope).inputHash, baseline.inputHash);

    const changedSelectedFact = structuredClone(d);
    (changedSelectedFact.source.ledger as any).facts.find((fact: any) => fact.id === "F_SELECTED").allowed_values.push("terrified");
    changedSelectedFact.sourceHash = compilationHash(changedSelectedFact.source);
    assert.notEqual(compilationScopeInput(changedSelectedFact, scope).inputHash, baseline.inputHash);
});

test("asset-card references are included in the compiler dependency closure", () => {
    const director = scopedDirector();
    (director.source.asset_plan as any[]).push({ id: "REFERENCE_ONLY", canvas_scope: "shared" });
    (director.source.asset_cards as any[])[0].references.push({ asset_id: "REFERENCE_ONLY" });
    const scope = compilationScopeInput(director, { targetIds: ["KA"] });
    assert.ok(scope.targetIds.includes("REFERENCE_ONLY"));
    assert.ok((scope.director.source.asset_plan as any[]).some(item => item.id === "REFERENCE_ONLY"));
});
test("scope normalization moves reference windows with the authored shot frames", () => {
    const d = scopedDirector();
    (d.source.shots as any[])[0].start_frame = 600;
    (d.source.shots as any[])[0].end_frame = 720;
    (d.source.segments as any[])[0].references = [{ start_frame: 600, end_frame: 720 }];
    const projected = compilationScopeInput(d, { sceneId: "A" }).director;
    const normalized = scopedCompilerInput(projected, { sceneId: "A" });
    assert.deepEqual((normalized.source.segments as any[])[0].references, [{ start_frame: 0, end_frame: 120 }]);
    assert.equal((d.source.shots as any[])[0].start_frame, 600);
});
test("scoped receipts preserve original provenance across unrelated edits, but reject changed inputs", () => {
    const d = scopedDirector(), scope = { targetIds: ["KA"] }, input = compilationScopeInput(d, scope);
    const prompt = "authored", promptHash = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
    const artifact: DirectorProduction["artifacts"][number] = { id: "image-KA", kind: "image", targetId: "KA", prompt, sha256: promptHash, sourceHash: d.sourceHash, status: "ready", references: [], receipt: { sourceHash: d.sourceHash, promptHash, compilationScope: { scope, inputHash: input.inputHash } } };
    const changed = structuredClone(d); (changed.source.shots as any[])[1].visual = "other edit"; changed.sourceHash = compilationHash(changed.source);
    assert.equal(currentCompilationArtifact(changed, artifact), true);
    (changed.source.shots as any[])[0].visual = "my edit"; changed.sourceHash = compilationHash(changed.source);
    assert.equal(currentCompilationArtifact(changed, artifact), false);
    assert.equal(artifact.sourceHash, d.sourceHash);
    assert.throws(() => compilationScopeInput(d, { sceneId: "missing" }), /UNKNOWN_SCENE/);
});

test("engine changes retain legacy scoped receipt validity without accepting changed source or prompt identity", () => {
    const director = scopedDirector(), scope = { targetIds: ["KA"] };
    const prompt = "original", promptHash = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
    const artifact: DirectorProduction["artifacts"][number] = { id: "image-KA", kind: "image", targetId: "KA", prompt, sha256: promptHash, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash, engineRuntimeId: director.engine.runtimeId, compilationScope: { scope, inputHash: compilationScopeInput(director, scope).legacyInputHash } } };
    director.artifacts = [artifact];
    preserveCompilationProvenance(director);
    const originalReceipt = structuredClone(artifact.receipt);
    director.engine = { commit: "b".repeat(40), patchVersion: "new", runtimeId: "new", version: "2" };
    assert.equal(currentCompilationArtifact(director, artifact), true);
    assert.deepEqual(artifact.receipt, originalReceipt);
    (director.source.shots as any[])[0].visual = "changed relevant action";
    director.sourceHash = compilationHash(director.source);
    assert.equal(currentCompilationArtifact(director, artifact), false);
});

test("artifact freshness checks scoped external inputs and prompt bytes even when the full source hash matches", () => {
    const director = scopedDirector();
    const scope = { targetIds: ["GA"] };
    const input = compilationScopeInput(director, scope);
    const prompt = "compiled prompt";
    const sha256 = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
    const artifact = { id: "GA", kind: "h3", targetId: "GA", prompt, sha256, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: sha256, engineRuntimeId: director.engine.runtimeId, engine: director.engine,
            compilationScope: { scope, inputHash: input.inputHash, engine: director.engine } } } as DirectorProduction["artifacts"][number];
    assert.equal(compilationArtifactFreshness(director, artifact).current, true);

    const changedReference = structuredClone(director);
    changedReference.assets.ROLE.sha256 = "b".repeat(64);
    const changed = compilationArtifactFreshness(changedReference, artifact);
    assert.equal(changed.current, false);
    assert.equal(changed.staleReason, "scope_input_changed");

    const changedPrompt = { ...artifact, prompt: "tampered prompt" };
    const promptResult = compilationArtifactFreshness(director, changedPrompt);
    assert.equal(promptResult.current, false);
    assert.equal(promptResult.staleReason, "prompt_hash_mismatch");

    const changedCompiler = structuredClone(director);
    changedCompiler.engine.compilerHash = "c".repeat(64);
    const compilerResult = compilationArtifactFreshness(changedCompiler, artifact);
    assert.equal(compilerResult.current, false);
    assert.equal(compilerResult.staleReason, "compiler_changed");
});

test("an H3 compiler change does not stale image artifacts when their compiler hash is unchanged", () => {
    const director = scopedDirector();
    director.engine.compilerHash = "a".repeat(64);
    director.engine.compilerHashes = { h3: "b".repeat(64), image: "c".repeat(64) };
    const prompt = "approved image prompt";
    const promptHash = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
    const image = { id: "image-KA", kind: "image", targetId: "KA", prompt, sha256: promptHash, sourceHash: director.sourceHash, status: "ready", references: [],
        receipt: { sourceHash: director.sourceHash, promptHash, engine: structuredClone(director.engine) } } as DirectorProduction["artifacts"][number];
    const h3 = { ...image, id: "h3-GA", kind: "h3", targetId: "GA" } as DirectorProduction["artifacts"][number];

    const updated = structuredClone(director);
    updated.engine.compilerHash = "d".repeat(64);
    updated.engine.compilerHashes = { h3: "e".repeat(64), image: "c".repeat(64) };
    assert.equal(compilationArtifactFreshness(updated, image).current, true);
    assert.deepEqual(compilationArtifactFreshness(updated, h3), { current: false, staleReason: "compiler_changed" });
});
