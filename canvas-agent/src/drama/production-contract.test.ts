import assert from "node:assert/strict";
import test from "node:test";
import { applyDirectorSourcePatch, productionOperationContract, ref2vaPromptDiagnostics } from "./production-validation.js";
import { dramaProductionPlanSchema, productionEditSchema, productionSettingsSchema, type DirectorProduction } from "./production-contract.js";
import { toolInputSchemas } from "../canvas/schemas.js";

test("all published operation examples use the actual edit contract", () => {
    const contract = productionOperationContract();
    assert.equal(contract.operations.length, 28);
    for (const item of contract.operations) {
        assert.equal(productionEditSchema.safeParse({ operationId: "example", expectedRevision: 0, ops: [item.example] }).success, true);
    }
    const json = JSON.stringify(contract.jsonSchema);
    assert.ok(json.includes("set_director_brief"));
    assert.ok(json.includes("committed"));
    assert.ok(json.includes("entity"));
    assert.throws(() => productionOperationContract("invented"), /Unknown/);
});

test("MCP edit schemas reject formerly opaque invalid operations", () => {
    for (const schema of [toolInputSchemas.canvas_edit_production, toolInputSchemas.drama_edit_production]) {
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

test("production compilation tools have explicit owner, revision and frozen handle contracts", () => {
    assert.ok(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas", expectedRevision: 1, operationId: "compile-1" }).success);
    assert.equal(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas" }).success, false);
    assert.equal(toolInputSchemas.production_apply_compilation.safeParse({ kind: "episode", id: "episode", preparedId: "../../packet" }).success, false);
    assert.ok(toolInputSchemas.drama_preflight_production.safeParse({ episodeId: "episode", action: "compile", request: { expectedRevision: 1 } }).success);
    assert.ok((productionOperationContract().requests.compile as any).required.includes("operationId"));
});
