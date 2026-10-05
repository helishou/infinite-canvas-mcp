import assert from "node:assert/strict";
import test from "node:test";
import { productionOperationContract, ref2vaPromptDiagnostics } from "./production-validation.js";
import { productionEditSchema, productionSettingsSchema, type DirectorProduction } from "./production-contract.js";
import { toolInputSchemas } from "../canvas/schemas.js";

test("all published operation examples use the actual edit contract", () => {
    const contract = productionOperationContract();
    assert.equal(contract.operations.length, 26);
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
    assert.ok(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas", expectedRevision: 1 }).success);
    assert.equal(toolInputSchemas.production_compile.safeParse({ kind: "canvas", id: "canvas" }).success, false);
    assert.equal(toolInputSchemas.production_apply_compilation.safeParse({ kind: "episode", id: "episode", preparedId: "../../packet" }).success, false);
});
