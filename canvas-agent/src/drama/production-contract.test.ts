import assert from "node:assert/strict";
import test from "node:test";
import { applyDirectorSourcePatch, productionOperationContract, ref2vaPromptDiagnostics } from "./production-validation.js";
import { dramaProductionPlanSchema, productionEditSchema, productionSettingsSchema, type DirectorProduction } from "./production-contract.js";
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
    assert.throws(() => applyDirectorSourcePatch(director, "asset_card", "YARD", { references: [] }), /不允许/);
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
