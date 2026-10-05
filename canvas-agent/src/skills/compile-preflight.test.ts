import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { preflightCompilationDirector, resolveAchengEngine } from "./acheng.js";
import { canonicalProduction, type DirectorProduction } from "../drama/production-contract.js";

function director(source: Record<string, any>): DirectorProduction {
    const { commit, patchVersion, runtimeId, version } = resolveAchengEngine();
    return { schemaVersion: 1, engine: { commit, patchVersion, runtimeId, version }, source,
        sourceHash: crypto.createHash("sha256").update(canonicalProduction(source)).digest("hex"), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
}
const styleSource = () => JSON.parse(fs.readFileSync(path.join(resolveAchengEngine().path, "templates", "style-anchor-stage.json"), "utf8"));

test("story-only source is diagnosed as not yet compilable without launching a compiler", () => {
    const result = preflightCompilationDirector(director({ brief: "A story still being written", script_scenes: [], asset_cards: [] }));
    assert.equal(result.compileReady, false);
    assert.ok(result.diagnostics.some(item => item.code === "COMPILE_STAGE_NOT_READY"));
});

test("pinned asset validators collect plan fields and style binding defects together", () => {
    const source = styleSource();
    source.asset_plan.push({ id: "ROOM", kind: "scene", version: "v1.0", purpose: "The same rural room used across the film", status: "planned", depends_on: ["STYLE_MOTHER"] });
    source.asset_cards.push({ ...structuredClone(source.asset_cards[0]), id: "ROOM", asset_kind: "scene", references: [] });
    delete source.asset_plan[0].kind; delete source.asset_plan[0].version; delete source.asset_plan[0].purpose;
    const input = director(source), before = structuredClone(input);
    const result = preflightCompilationDirector(input);
    const paths = result.diagnostics.map(item => item.path);
    for (const field of ["kind", "version", "purpose"]) assert.ok(paths.includes(`director.source.asset_plan.0.${field}`), JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code === "STYLE_REFERENCE_MISSING" && item.targetId === "ROOM"));
    assert.equal(result.compileReady, false);
    assert.deepEqual(input, before);
});

test("planned style mother remains compilable without falsely requiring generated media", () => {
    const input = director(styleSource()), before = structuredClone(input);
    const result = preflightCompilationDirector(input);
    assert.equal(result.compileReady, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(input, before);
});

test("compilation can rebuild stale receipts and retain an unfinished video draft", () => {
    const source = styleSource();
    const input = director(source);
    input.artifacts = [{ id: "old", kind: "image", targetId: "STYLE_MOTHER", prompt: "Old prompt to replace", sha256: "0".repeat(64), sourceHash: "1".repeat(64), status: "ready", references: [], receipt: { sourceHash: "1".repeat(64), promptHash: "0".repeat(64), engineRuntimeId: "old", validator: "old" } }];
    assert.equal(preflightCompilationDirector(input).compileReady, true, "previous output receipts must not block recompiling authored source");
    source.fps_num = 24; source.fps_den = 1;
    source.segments = [{ id: "SEG001", mode: "T2VA", mode_lock: "T2VA", mode_selection_reason: "This establishing scene has no image-reference requirement.", generation_clip_duration: 4, start_frame: 0, end_frame: 96, shot_ids: [], summary: "A planned establishing view of the rural house.", references: [] }];
    const draft = preflightCompilationDirector(director(source));
    assert.equal(draft.compileReady, true, JSON.stringify(draft.diagnostics));
    assert.ok(draft.diagnostics.some(item => item.code === "COMPILE_VIDEO_DRAFT" && item.severity === "warning"));
});
