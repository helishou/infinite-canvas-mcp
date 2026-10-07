import test from "node:test";
import assert from "node:assert/strict";
import { assertDirectorWorkScope, directorWorkInput } from "./work-package.js";
import type { DirectorProduction } from "../drama/production-contract.js";
const fixture = (): DirectorProduction => ({ schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" },
    source: { brief: "frozen", script_scenes: [{ id: "A" }, { id: "B" }], shots: [{ id: "SA", source_scene_id: "A" }, { id: "SB", source_scene_id: "B" }], segments: [{ id: "CA", shot_ids: ["SA"] }], asset_plan: [{ id: "shared", canvas_scope: "shared" }, { id: "local", canvas_scope: "episode", shot_ids: ["SA"], depends_on: ["shared"] }], asset_cards: [] },
    sourceHash: "a".repeat(64), modules: {}, assets: { shared: { version: "1", status: "approved", sha256: "b".repeat(64) } }, shotInputs: {}, boundaries: [], artifacts: [], workflow: {}, unresolved: [], executionAuthorized: false });
test("work input ignores runtime metadata and unrelated scenes but tracks shared dependencies", () => {
    const before = fixture(), after = fixture(), scope = { sceneId: "A" };
    const baseline = directorWorkInput(before, scope).inputHash;
    after.workflow.currentWork = { workId: "running", module: "story", action: "author", inputRevision: 4 };
    (after.source.shots as any[])[1].title = "unrelated";
    assert.equal(directorWorkInput(after, scope).inputHash, baseline);
    after.assets.shared.version = "2";
    assert.notEqual(directorWorkInput(after, scope).inputHash, baseline);
});
test("scope checks protect dependency cards and ownership while permitting a union of independent output scopes", () => {
    const before = fixture(), after = fixture();
    (after.source.shots as any[])[0].title = "new A"; (after.source.shots as any[])[1].title = "new B";
    assert.throws(() => assertDirectorWorkScope(before, after, { sceneId: "A" }), /OUTSIDE_SCOPE/);
    assert.doesNotThrow(() => assertDirectorWorkScope(before, after, [{ sceneId: "A" }, { sceneId: "B" }]));
    const moved = fixture(); (moved.source.shots as any[])[0].source_scene_id = "B";
    assert.throws(() => assertDirectorWorkScope(before, moved, { sceneId: "A" }), /OUTSIDE_SCOPE/);
    const referenced = fixture(); (referenced.source.segments as any[])[0].shot_ids = ["SB"];
    assert.throws(() => assertDirectorWorkScope(before, referenced, { sceneId: "A" }), /OUTSIDE_SCOPE/);
    const dependency = fixture(); (dependency.source.asset_plan as any[])[0].name = "changed";
    assert.throws(() => assertDirectorWorkScope(before, dependency, { sceneId: "A" }), /OUTSIDE_SCOPE/);
    const authorization = fixture(); authorization.executionAuthorized = true;
    assert.throws(() => assertDirectorWorkScope(before, authorization), /PROTECTED_FIELDS/);
});
