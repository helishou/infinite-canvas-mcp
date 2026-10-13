import assert from "node:assert/strict";
import test from "node:test";
import { applyDirectorSourcePatch, productionOperationContract, ref2vaPromptDiagnostics } from "./production-validation.js";
import { diagnosticBlocksAction, dramaProductionPlanSchema, productionEditSchema, productionSettingsSchema, type DirectorProduction, type ProductionDiagnostic } from "./production-contract.js";
import { toolInputSchemas } from "../canvas/schemas.js";

test("all published operation examples use the actual edit contract", () => {
    const contract = productionOperationContract();
    assert.ok(contract.operations.some(operation => operation.type === "adopt_director_fields"));
    for (const item of contract.operations) {
        assert.equal(productionEditSchema.safeParse({ operationId: "example", expectedRevision: 0, ops: [item.example] }).success, true);
    }
    const json = JSON.stringify(contract.jsonSchema);
    assert.ok(json.includes("set_director_brief"));
    assert.ok(json.includes("committed"));
    assert.ok(json.includes("entity"));
    assert.ok(json.includes("restore_archived_scene_results"));
    assert.throws(() => productionOperationContract("invented"), /Unknown/);
});

test("asset deletion requires explicit confirmation in the revision-checked operation contract", () => {
    const operation = productionOperationContract("delete_director_asset").operations[0];
    assert.deepEqual(operation.preconditions?.length, 1);
    assert.equal(productionEditSchema.safeParse({ operationId: "delete-asset", expectedRevision: 1, ops: [{ type: "delete_director_asset", id: "PROP1", confirmed: true }] }).success, true);
    assert.equal(productionEditSchema.safeParse({ operationId: "delete-asset", expectedRevision: 1, ops: [{ type: "delete_director_asset", id: "PROP1", confirmed: false }] }).success, false);
});

test("MCP edit schemas reject formerly opaque invalid operations", () => {
    for (const schema of [toolInputSchemas.production_edit]) {
        for (const op of [{ type: "set_director_brief", brief: {} }, { type: "patch_director_source", patch: {} }]) {
            assert.equal(schema.safeParse({ projectId: "canvas", episodeId: "episode", operationId: "op", expectedRevision: 0, ops: [op] }).success, false);
        }
    }
});

test("asset canvas scope is a formal, validated source field that invalidates old compile receipts", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.asset_plan = [{ asset_id: "ROLE", canvas_scope: "episode" }];
    const priorHash = director.sourceHash;
    applyDirectorSourcePatch(director, "asset", "ROLE", { canvas_scope: "shared" });
    assert.equal((director.source.asset_plan as Array<Record<string, unknown>>)[0].canvas_scope, "shared");
    assert.notEqual(director.sourceHash, priorHash);
    assert.equal(director.artifacts.every(artifact => artifact.status === "stale"), true);
    assert.throws(() => applyDirectorSourcePatch(director, "asset", "ROLE", { canvas_scope: "other" }), /shared 或 episode/);
    director.assets.ROLE = { version: "v1", status: "approved", sharedSource: { dramaId: "drama", assetId: "ROLE", approvedId: "approved-v1", sourceProjectId: "shared", sourceNodeId: "source-role" } };
    assert.throws(() => applyDirectorSourcePatch(director, "asset", "ROLE", { canvas_scope: "episode" }), /必须保留 shared/);
});

test("environment and asset-card patches update compiler source without changing script or asset plans", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.scene_registry = [{ id: "YARD", description: "Child at the coop window", prompt_description: "A child crouches" }, { id: "ROOM", description: "Room" }];
    director.source.asset_cards = [{ id: "YARD", prompt: "Child at the window", seven_steps: [{ step: 1, content: "Child at the window" }, { step: 2, content: "Keep materials" }] }];
    director.source.script_scenes = [{ id: "SC1", text: "The boy stands in the yard" }];
    director.source.asset_plan = [{ asset_id: "YARD", version: "v1" }];
    const beforeHash = director.sourceHash;
    const ops = [
        { type: "patch_director_source", entity: "environment", id: "YARD", patch: { description: "Empty courtyard", prompt_description: "A low coop window" } },
        { type: "patch_director_source", entity: "asset_card", id: "YARD", patch: { prompt: "Empty courtyard", seven_steps: [{ step: 1, content: "Empty courtyard" }, { step: 2, content: "Keep materials" }] } },
    ];
    assert.equal(productionEditSchema.safeParse({ operationId: "repair", expectedRevision: 1, ops }).success, true);
    applyDirectorSourcePatch(director, "environment", "YARD", ops[0].patch);
    applyDirectorSourcePatch(director, "asset_card", "YARD", ops[1].patch);
    assert.equal((director.source.scene_registry as any[])[0].prompt_description, "A low coop window");
    assert.equal((director.source.scene_registry as any[])[1].description, "Room");
    assert.equal((director.source.asset_cards as any[])[0].seven_steps[1].content, "Keep materials");
    assert.deepEqual(director.source.script_scenes, [{ id: "SC1", text: "The boy stands in the yard" }]);
    assert.deepEqual(director.source.asset_plan, [{ asset_id: "YARD", version: "v1" }]);
    assert.notEqual(director.sourceHash, beforeHash);
    assert.throws(() => applyDirectorSourcePatch(director, "environment", "missing", { description: "Missing" }), /不存在/);
    applyDirectorSourcePatch(director, "asset_card", "YARD", { references: [] });
    assert.deepEqual((director.source.asset_cards as any[])[0].references, []);
});

test("video aspect kickoff distinguishes an explicit canvas-inherit choice from an unanswered setting", () => {
    const inherited = productionSettingsSchema.safeParse({ mode: "manual", imageModel: "", h3Model: "", videoAspectRatio: null, videoAspectRatioConfirmed: true });
    assert.equal(inherited.success, true);
    if (inherited.success) {
        assert.equal(inherited.data.videoAspectRatio, null);
        assert.equal(inherited.data.videoAspectRatioConfirmed, true);
    }
    const selected = productionEditSchema.safeParse({ operationId: "ratio", expectedRevision: 0, ops: [{ type: "set_settings", patch: { videoAspectRatio: "16:9", videoAspectRatioConfirmed: true } }] });
    assert.equal(selected.success, true);
    const unanswered = productionSettingsSchema.parse({ mode: "manual", imageModel: "", h3Model: "" });
    assert.equal(unanswered.videoAspectRatioConfirmed, undefined);
});

test("storyboard image mode is an explicit production and drama-plan setting", () => {
    const settings = productionSettingsSchema.safeParse({ mode: "manual", imageModel: "", h3Model: "", storyboardImageMode: "skip" });
    assert.equal(settings.success, true);
    assert.equal(productionSettingsSchema.safeParse({ mode: "manual", imageModel: "", h3Model: "", storyboardImageMode: "sometimes" }).success, false);
    assert.equal(dramaProductionPlanSchema.parse({ storyboardImageMode: "skip" }).storyboardImageMode, "skip");
    assert.equal(productionEditSchema.safeParse({ operationId: "storyboard-mode", expectedRevision: 0, ops: [{ type: "set_settings", patch: { storyboardImageMode: "generate" } }] }).success, true);
});

test("new word policy accepts 2901 and 6500 words without truncation, while the historical policy retains its ceiling", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.segments = [{ id: "segment", mode: "Ref2VA" }];
    for (const words of [2901, 6500, 2199]) {
        const prompt = `detailed_description:\n${"authored ".repeat(words)}\n\noverall_soundscape:\nWind.`;
        director.artifacts = [{ id: "prompt", targetId: "segment", kind: "h3", status: "ready", prompt, sha256: "0".repeat(64), sourceHash: "0".repeat(64), references: [], receipt: { sourceHash: "0".repeat(64), promptHash: "0".repeat(64), engineRuntimeId: director.engine.runtimeId, validator: "fixture" } }];
        assert.equal(ref2vaPromptDiagnostics(director, null).length, words < 2200 ? 1 : 0);
        assert.equal(ref2vaPromptDiagnostics(director, 2900).length, 1);
        assert.equal(director.artifacts[0].prompt, prompt);
    }
});

test("Ref2VA length validation follows matched compiler receipts, including a zero minimum", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.segments = [{ id: "segment", mode: "Ref2VA" }];
    const prompt = `detailed_description:\n${"authored ".repeat(100)}\n\noverall_soundscape:\nWind.`;
    const receipt = { sourceHash: director.sourceHash, promptHash: "0".repeat(64), engineRuntimeId: director.engine.runtimeId,
        validator: "compile_h3/validate_package", diagnostics: { accepted: true, formatPass: "PASSED", detailPolicy: { minimum_words: 0 } } };
    director.artifacts = [{ id: "prompt", targetId: "segment", kind: "h3", status: "ready", prompt,
        sha256: receipt.promptHash, sourceHash: receipt.sourceHash, references: [], receipt }];
    assert.deepEqual(ref2vaPromptDiagnostics(director, null), []);
    assert.equal(ref2vaPromptDiagnostics(director, 90).length, 1);
    receipt.diagnostics.detailPolicy.minimum_words = 200;
    assert.equal(ref2vaPromptDiagnostics(director, null).length, 1);
    receipt.diagnostics.detailPolicy.minimum_words = 0;
    receipt.engineRuntimeId = "unmatched-runtime";
    assert.equal(ref2vaPromptDiagnostics(director, null).length, 1);
    receipt.engineRuntimeId = director.engine.runtimeId;
    receipt.promptHash = "1".repeat(64);
    assert.equal(ref2vaPromptDiagnostics(director, null).length, 1);
    assert.equal(director.artifacts[0].prompt, prompt);
});

test("Ref2VA CRLF validation counts the same words while preserving prompt bytes", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.segments = [{ id: "segment", mode: "Ref2VA" }];
    for (const newline of ["\n", "\r\n", "\r"]) {
        const prompt = `detailed_description:${newline}${"authored ".repeat(2400)}${newline}${newline}overall_soundscape:${newline}Wind.`;
        director.artifacts = [{ id: "prompt", targetId: "segment", kind: "h3", status: "ready", prompt, sha256: "0".repeat(64), sourceHash: "0".repeat(64), references: [], receipt: { sourceHash: "0".repeat(64), promptHash: "0".repeat(64), engineRuntimeId: director.engine.runtimeId, validator: "fixture" } }];
        assert.deepEqual(ref2vaPromptDiagnostics(director, 2900), []);
        assert.equal(director.artifacts[0].prompt, prompt);
    }
});

test("a retained Ref2VA receipt uses its original compiler policy after scoped compilation changes the production engine", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    const engine = structuredClone(director.engine), prompt = "detailed_description:\nA quiet shot.\n\noverall_soundscape:\nWind.";
    director.source.segments = [{ id: "old-segment", mode: "Ref2VA" }];
    director.artifacts = [{ id: "old-prompt", targetId: "old-segment", kind: "h3", status: "ready", prompt, sha256: "0".repeat(64), sourceHash: director.sourceHash, references: [],
        receipt: { sourceHash: director.sourceHash, promptHash: "0".repeat(64), engineRuntimeId: engine.runtimeId, engine, validator: "compile_h3/validate_package",
            diagnostics: { accepted: true, formatPass: "PASSED", detailPolicy: { minimum_words: 0 } } } }];
    director.engine = { commit: "b".repeat(40), patchVersion: "next", runtimeId: "next", version: "next" };
    assert.deepEqual(ref2vaPromptDiagnostics(director, null), []);
    director.artifacts[0].receipt.engineRuntimeId = "forged-runtime";
    assert.equal(ref2vaPromptDiagnostics(director, null).length, 1);
});

test("production compilation tools have explicit owner, revision and frozen handle contracts", () => {
    assert.ok(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas", expectedRevision: 1, operationId: "compile-1" }).success);
    assert.equal(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas" }).success, false);
    assert.equal(toolInputSchemas.production_apply_compilation.safeParse({ kind: "episode", id: "episode", preparedId: "../../packet" }).success, false);
    assert.ok(toolInputSchemas.production_preflight.safeParse({ kind: "episode", id: "episode", action: "compile", request: { expectedRevision: 1 } }).success);
    assert.ok((productionOperationContract().requests.compile as any).required.includes("operationId"));
});

test("diagnostic actions override severity and retain legacy error compatibility", () => {
    const qualityError: ProductionDiagnostic = { code: "QUALITY_ADVICE", path: "segment.prompt", targetId: "SEG1", message: "Improve wording", severity: "error", blockingActions: [] };
    assert.equal(diagnosticBlocksAction(qualityError, "compile"), false);
    assert.equal(diagnosticBlocksAction(qualityError, "generate"), false);

    const missingMedia: ProductionDiagnostic = { code: "REFERENCE_MISSING", path: "segment.references", targetId: "SEG1", message: "Selected image is unavailable", severity: "warning", blockingActions: ["generate"] };
    assert.equal(diagnosticBlocksAction(missingMedia, "compile"), false);
    assert.equal(diagnosticBlocksAction(missingMedia, "generate"), true);

    const legacy: ProductionDiagnostic = { code: "LEGACY_SOURCE_INVALID", path: "director.source", message: "Invalid source", severity: "error" };
    assert.equal(diagnosticBlocksAction(legacy, "compile"), true);
});

test("production spec fields patch document-level settings with strict shapes", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    const ops = [
        { type: "patch_director_source", entity: "spec", patch: { fps_num: 25, fps_den: 1, generation_clip_limit: 10, delivery_scope: "prompt_only", prompt_detail_policy: { profile: "ref2va_v2" } } },
        { type: "patch_director_source", entity: "spec", patch: { production_total_duration: "90/1" } },
    ];
    assert.equal(productionEditSchema.safeParse({ operationId: "spec", expectedRevision: 1, ops }).success, true);
    const priorHash = director.sourceHash;
    applyDirectorSourcePatch(director, "spec", undefined, { fps_num: 25 });
    assert.equal(Number((director.source as Record<string, unknown>).fps_num), 25);
    assert.notEqual(director.sourceHash, priorHash);
    applyDirectorSourcePatch(director, "spec", undefined, { production_total_duration: "90/1" });
    assert.equal(String((director.source as Record<string, unknown>).production_total_duration), "90/1");
    applyDirectorSourcePatch(director, "spec", undefined, { production_total_duration: "" });
    assert.equal(Object.hasOwn(director.source, "production_total_duration"), false);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { fps_num: 0 }), /整数/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { fps_num: "24" }), /整数/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { generation_clip_limit: 0 }), /整数/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { invented: true }), /规格字段/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", "X", { fps_num: 24 }), /ID/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { production_total_duration: "soon" }), /秒数或/);
    assert.throws(() => applyDirectorSourcePatch(director, "spec", undefined, { prompt_detail_policy: { profile: " " } }), /profile/);
});

test("story structure patches synopsis, threads and five-stage arc without losing other keys", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.story = { extra_key: "keep" };
    applyDirectorSourcePatch(director, "story", undefined, { synopsis: "s", A: "a", B: "b", C: "c", five_stage_arc: ["一", "二", "三", "四", "五"] });
    const story = director.source.story as Record<string, any>;
    assert.deepEqual([story.synopsis, story.A, story.B, story.C], ["s", "a", "b", "c"]);
    assert.equal(story.extra_key, "keep");
    assert.equal(story.five_stage_arc.length, 5);
    assert.ok(productionEditSchema.safeParse({ operationId: "story", expectedRevision: 1, ops: [{ type: "patch_director_source", entity: "story", patch: { synopsis: "s" } }] }).success);
    assert.throws(() => applyDirectorSourcePatch(director, "story", undefined, { five_stage_arc: ["一", "二", "三", "四"] }), /五/);
    assert.throws(() => applyDirectorSourcePatch(director, "story", undefined, { A: 7 }), /文字/);
    assert.throws(() => applyDirectorSourcePatch(director, "story", "S1", { synopsis: "x" }), /ID/);
    assert.throws(() => applyDirectorSourcePatch(director, "story", undefined, { beats: [] }), /故事线字段/);
});

test("shot features, combat, performance, segment motion, summary, audio and animation evidence validate at the patch boundary", () => {
    const director = productionOperationContract("set_director_production").operations[0].example.director as DirectorProduction;
    director.source.shots = [{ id: "SH1" }];
    director.source.segments = [{ id: "SEG1", shot_ids: ["SH1"], summary: "before" }];
    applyDirectorSourcePatch(director, "shot", "SH1", { features: { combat: true, colossal: false } });
    assert.deepEqual((director.source.shots as Array<Record<string, any>>)[0].features, { combat: true, colossal: false });
    const combat = { force_source: "foot plants", timing: { axis_lock: "north-south", spatial_direction: "left-to-right", speed_curve: "accelerate", camera_sync: "track impact", phases: [], direction_facts: {}, speed_profile: {}, slow_motion: { enabled: false } } };
    applyDirectorSourcePatch(director, "shot", "SH1", { combat });
    assert.deepEqual((director.source.shots as Array<Record<string, any>>)[0].combat, combat);
    const performance = { beat_id: "B1", dominant_track: "gaze", tracks: { gaze: { start: 0, end: 12, cue: "shifts gaze", visibility: "close-up" } }, acting_design: { objective: "decide" } };
    applyDirectorSourcePatch(director, "shot", "SH1", { performance });
    assert.deepEqual((director.source.shots as Array<Record<string, any>>)[0].performance, performance);
    assert.throws(() => applyDirectorSourcePatch(director, "shot", "SH1", { performance: { tracks: { gaze: { start: 12, end: 0, cue: "bad", visibility: "close" } } } }), /帧无效/);
    assert.throws(() => applyDirectorSourcePatch(director, "shot", "SH1", { features: { combat: "yes" } }), /true 或 false/);
    applyDirectorSourcePatch(director, "shot", "SH1", { features: { combat: false } });
    assert.throws(() => applyDirectorSourcePatch(director, "shot", "SH1", { features: { combat: false }, combat: {} }), /关闭/);
    applyDirectorSourcePatch(director, "shot", "SH1", { features: { combat: true } });
    applyDirectorSourcePatch(director, "segment", "SEG1", { motion_profile: { medium: "live_action", cut_style: "硬切" } });
    assert.equal((director.source.segments as Array<Record<string, any>>)[0].motion_profile.cut_style, "硬切");
    assert.throws(() => applyDirectorSourcePatch(director, "segment", "SEG1", { motion_profile: { fps: 24 } }), /文字说明/);
    applyDirectorSourcePatch(director, "segment", "SEG1", { summary: "" });
    assert.equal(Object.hasOwn((director.source.segments as Array<Record<string, any>>)[0], "summary"), false);
    const binding = { id: "AUD1", label: "<Audio 1>", sourceNode: { projectId: "P", nodeId: "N" }, storageKey: "k", sha256: "a".repeat(64), role: "source_audio", shotIds: ["SH1"], mimeType: "audio/mpeg" };
    applyDirectorSourcePatch(director, "segment", "SEG1", { audio_bindings: [binding] });
    assert.equal((director.source.segments as Array<Record<string, any>>)[0].audio_bindings.length, 1);
    assert.throws(() => applyDirectorSourcePatch(director, "segment", "SEG1", { audio_bindings: [{ ...binding, mimeType: "video/mp4" }] }), /不合格/);
    assert.throws(() => applyDirectorSourcePatch(director, "segment", "SEG1", { audio_bindings: [{ ...binding, shotIds: [] }] }), /不合格/);
    const evidence = [{ term_id: "ANIM-01", term: "anticipation", time_window: "0-12f", observable_fact: "weight shifts before the strike", camera_or_layout: "full-body profile keeps both feet visible", sound_or_qa: "shoe scrape precedes contact" }];
    applyDirectorSourcePatch(director, "segment", "SEG1", { animation_term_ids: ["ANIM-01"], animation_term_evidence: evidence });
    assert.deepEqual((director.source.segments as Array<Record<string, any>>)[0].animation_term_evidence, evidence);
    assert.throws(() => applyDirectorSourcePatch(director, "segment", "SEG1", { animation_term_ids: [""] }), /非空字符串数组/);
    assert.throws(() => applyDirectorSourcePatch(director, "segment", "SEG1", { animation_term_evidence: [{ ...evidence[0], sound_or_qa: "" }] }), /sound_or_qa/);
});
