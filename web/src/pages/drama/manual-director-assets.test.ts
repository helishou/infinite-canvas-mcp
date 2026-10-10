import assert from "node:assert/strict";
import test from "node:test";
import { createManualDirectorAsset } from "./manual-director-assets";

const base = {
    asset_plan: [{ id: "EXISTING", kind: "prop" }],
    asset_cards: [{ id: "EXISTING", asset_id: "EXISTING", prompt: "keep" }],
    character_registry: [{ id: "OLD_CHARACTER", name: "Existing" }],
    scene_registry: [{ id: "OLD_SCENE", name: "Existing" }],
    subject_registry: [],
    untouched: { marker: true },
};

test("manual prop creation adds plan, prompt card and a v2 asset-backed subject without mutating source", () => {
    const source = structuredClone(base);
    const result = createManualDirectorAsset(source, {
        id: "AST_NEW_PROP",
        subjectId: "SUB_NEW_PROP",
        kind: "prop",
        name: "铜铃",
        description: "旧铜铃",
        prompt: "A worn brass bell",
        purpose: "持有物",
        canvasScope: "episode",
        registerSubject: true,
        ownerKind: "episode",
        ownerId: "EP_1",
    });

    assert.deepEqual(source, base);
    assert.deepEqual(result.assetPlan, {
        id: "AST_NEW_PROP", kind: "prop", asset_name: "铜铃", version: "v1", description: "旧铜铃", purpose: "持有物", depends_on: [], status: "planned", canvas_scope: "episode",
    });
    assert.deepEqual(result.assetCard, {
        id: "AST_NEW_PROP", asset_id: "AST_NEW_PROP", asset_kind: "prop", asset_version: "v1", prompt: "A worn brass bell", references: [],
    });
    assert.deepEqual(result.subject, {
        id: "SUB_NEW_PROP", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "EP_1", kind: "asset", id: "AST_NEW_PROP" }, pictureBindings: [],
    });
    assert.equal(result.source.asset_plan.length, 2);
    assert.equal(result.source.asset_cards.length, 2);
    assert.equal(result.source.subject_registry.length, 1);
    assert.equal(result.source.untouched.marker, true);
});

test("manual character and scene creation register stable entities for the asset and Subject", () => {
    const character = createManualDirectorAsset(base, {
        id: "AST_CHAR", entityId: "CHAR_1", subjectId: "SUB_CHAR", kind: "character", name: "阿青", description: "短发角色", prompt: "Portrait prompt", ownerKind: "canvas", ownerId: "CANVAS_1",
    });
    assert.deepEqual(character.source.character_registry.at(-1), { id: "CHAR_1", name: "阿青", description: "短发角色", appearance: "短发角色" });
    assert.equal(character.assetPlan.entity_id, "CHAR_1");
    assert.deepEqual(character.subject.entityRef, { ownerKind: "canvas", ownerId: "CANVAS_1", kind: "character", id: "CHAR_1" });

    const scene = createManualDirectorAsset(base, {
        id: "AST_SCENE", entityId: "SCENE_1", subjectId: "SUB_SCENE", kind: "scene", name: "旧屋", description: "临河旧屋", prompt: "Old house prompt", ownerKind: "episode", ownerId: "EP_1",
    });
    assert.deepEqual(scene.source.scene_registry.at(-1), { id: "SCENE_1", name: "旧屋", description: "临河旧屋" });
    assert.equal(scene.assetPlan.entity_id, "SCENE_1");
    assert.deepEqual(scene.subject.entityRef, { ownerKind: "episode", ownerId: "EP_1", kind: "scene", id: "SCENE_1" });
});
