import assert from "node:assert/strict";
import test from "node:test";
import { updateLegacyShotReferences } from "./legacy-shot-references.js";

const legacyDirector = () => ({
    schemaVersion: 1,
    engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "1" },
    source: { shots: [{ id: "S1", required_assets: ["OLD"] }] }, sourceHash: "b".repeat(64),
    modules: {}, artifacts: [], assets: { SHARED: { assetId: "SHARED", version: "v1", status: "approved", storageKey: "shared:original" } },
    shotInputs: { S1: { assetIds: ["OLD"], keyframePolicy: "reuse", keyframeAssetId: "FRAME_OLD" } },
    boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
} as any);

test("legacy ordinary references and keyframe can be replaced and unbound independently without deleting shared media identity", () => {
    const original = legacyDirector();
    const replaced = updateLegacyShotReferences(original, "S1", ["REF_B", "REF_C", "REF_B"], "FRAME_NEW")! as any;
    assert.deepEqual(replaced.source.shots[0].required_assets, ["REF_B", "REF_C"]);
    assert.deepEqual(replaced.shotInputs.S1, { assetIds: ["REF_B", "REF_C"], keyframePolicy: "reuse", keyframeAssetId: "FRAME_NEW" });
    const cleared = updateLegacyShotReferences(replaced, "S1", [], null)! as any;
    assert.deepEqual(cleared.source.shots[0].required_assets, []);
    assert.deepEqual(cleared.shotInputs.S1, { assetIds: [], keyframePolicy: "none" });
    assert.equal(cleared.assets.SHARED.storageKey, "shared:original");
    assert.deepEqual(original.source.shots[0].required_assets, ["OLD"]);
    assert.equal(updateLegacyShotReferences(original, "missing", [], null), undefined);
});
