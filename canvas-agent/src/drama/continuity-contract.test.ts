import assert from "node:assert/strict";
import test from "node:test";
import { productionOperationSchema } from "./production-contract.js";
import { productionWorkspaceRequest } from "./production-workspace-contract.js";
import { applyDirectorSourcePatch } from "./production-validation.js";

test("continuity reads are owner scoped and cursor-bearing", () => {
    assert.deepEqual(productionWorkspaceRequest("production_get_continuity", { kind: "episode", id: "ep", view: "issues", snapshot: "draft", pageSize: 20 }).path,
        "/drama/episodes/ep/production/continuity?snapshot=draft&view=issues&pageSize=20");
    assert.equal(productionWorkspaceRequest("production_get_continuity", { kind: "scene", id: "scene" }).path, "/drama/scenes/scene/production/continuity?snapshot=draft&view=summary");
});

test("ledger source patch changes the authored source and never accepts projected shot snapshots", () => {
    const director: any = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "v" }, source: { ledger: { contract_version: 2, facts: [] } }, sourceHash: "0".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], unresolved: [] };
    applyDirectorSourcePatch(director, "continuity", undefined, { ledger: { contract_version: 2, facts: [{ id: "F1" }] } });
    assert.equal(director.source.ledger.facts[0].id, "F1");
    assert.notEqual(director.sourceHash, "0".repeat(64));
    assert.ok(director.artifacts.every((artifact: any) => artifact.status === "stale"));
    assert.throws(() => applyDirectorSourcePatch(director, "continuity", undefined, { state_in: {} }), /连续性修改只接受/);
    assert.equal(productionOperationSchema.safeParse({ type: "patch_director_continuity", ledger: { contract_version: 2 } }).success, true);
});
