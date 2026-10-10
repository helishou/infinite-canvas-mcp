import assert from "node:assert/strict";
import test from "node:test";
import { directorHash } from "./director.js";
import { deleteManualDirectorAsset } from "./director-asset-delete.js";

function makeDirector(source: Record<string, any> = {}) {
    const fullSource = { prompt_assembly: { version: 2 }, asset_plan: [], asset_cards: [], subject_registry: [], shots: [], utterances: [], ledger: { facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] }, ...source };
    return {
        source: fullSource,
        sourceHash: directorHash(fullSource),
        assets: {},
        shotInputs: {},
        artifacts: [],
        executionAuthorized: true,
        workflow: { currentWork: { workId: "work-1", sourceHash: directorHash(fullSource) } },
    } as any;
}

function propSource(extra: Record<string, any> = {}) {
    return {
        asset_plan: [{ id: "PROP_A", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: [] }, { id: "PROP_B", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: [] }],
        asset_cards: [{ id: "PROP_A", asset_id: "PROP_A", prompt: "unused prop" }, { id: "PROP_B", asset_id: "PROP_B", prompt: "keep this" }],
        subject_registry: [{ id: "SUB_PROP_A", kind: "prop", entityRef: { ownerKind: "episode", ownerId: "EP_1", kind: "asset", id: "PROP_A" }, pictureBindings: [] }],
        ...extra,
    };
}

test("deleting an unused planned prop removes only its formal rows and invalidates source receipts", () => {
    const director = makeDirector(propSource());
    director.assets.PROP_A = { version: "v1", status: "planned" };
    director.assets.PROP_B = { version: "v1", status: "planned" };
    director.artifacts = [{ id: "ART_1", kind: "h3", targetId: "SEG_1", status: "ready" }];
    const previousHash = director.sourceHash;

    deleteManualDirectorAsset(director, "PROP_A");

    assert.deepEqual(director.source.asset_plan.map((row: any) => row.id), ["PROP_B"]);
    assert.deepEqual(director.source.asset_cards.map((row: any) => row.id), ["PROP_B"]);
    assert.deepEqual(director.source.subject_registry, []);
    assert.deepEqual(Object.keys(director.assets), ["PROP_B"]);
    assert.equal(director.sourceHash, directorHash(director.source));
    assert.notEqual(director.sourceHash, previousHash);
    assert.equal(director.workflow.currentWork.sourceHash, director.sourceHash);
    assert.equal(director.executionAuthorized, false);
    assert.equal(director.artifacts[0].status, "stale");
});

test("asset deletion refuses assets not explicitly created through the manual workflow", () => {
    const source = propSource();
    source.asset_plan[0].created_by = "director";
    const director = makeDirector(source);
    assert.throws(() => deleteManualDirectorAsset(director, "PROP_A"), /ASSET_NOT_MANUAL/);
});

test("asset deletion refuses assets referenced by another planned asset or asset card", () => {
    const dependency = makeDirector(propSource({ asset_plan: [
        { id: "PROP_A", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: [] },
        { id: "PROP_B", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: ["PROP_A"] },
    ] }));
    assert.throws(() => deleteManualDirectorAsset(dependency, "PROP_A"), /ASSET_STILL_REFERENCED.*depends_on/);

    const reference = makeDirector(propSource({ asset_cards: [
        { id: "PROP_A", asset_id: "PROP_A", prompt: "unused prop" },
        { id: "PROP_B", asset_id: "PROP_B", prompt: "uses another prop", references: [{ asset_id: "PROP_A" }] },
    ] }));
    assert.throws(() => deleteManualDirectorAsset(reference, "PROP_A"), /ASSET_STILL_REFERENCED.*asset_cards/);
});

test("asset deletion refuses Shot, continuity and subject references before changing source", () => {
    const shot = makeDirector(propSource({ shots: [{ id: "SHOT_1", required_assets: ["PROP_A"], subject_usages: [] }] }));
    assert.throws(() => deleteManualDirectorAsset(shot, "PROP_A"), /ASSET_STILL_REFERENCED.*shots/);
    assert.equal(shot.source.asset_plan.length, 2);

    const subject = makeDirector(propSource({ shots: [{ id: "SHOT_1", subject_usages: [{ subjectId: "SUB_PROP_A", pictureBindingIds: [] }], camera: {}, keyframes: [] }] }));
    assert.throws(() => deleteManualDirectorAsset(subject, "PROP_A"), /ASSET_STILL_REFERENCED.*subjectId/);

    const continuity = makeDirector(propSource({ ledger: { facts: [{ id: "FACT_1", object_kind: "prop", object_id: "PROP_A", value: "held" }], timelines: [], initial: [], events: [], requirements: [], coverage: [] } }));
    assert.throws(() => deleteManualDirectorAsset(continuity, "PROP_A"), /ASSET_STILL_REFERENCED.*object_id/);
});

test("asset deletion refuses bound, generated, reviewed, or compiled targets", () => {
    for (const state of [
        { nodeId: "node-1", status: "planned" },
        { storageKey: "media:1", status: "generated" },
        { generationTaskId: "task-1", status: "planned" },
        { status: "approved" },
    ]) {
        const director = makeDirector(propSource());
        director.assets.PROP_A = { version: "v1", ...state };
        assert.throws(() => deleteManualDirectorAsset(director, "PROP_A"), /ASSET_HAS_MEDIA_OR_HISTORY/);
    }

    const bound = makeDirector(propSource({ subject_registry: [{ id: "SUB_PROP_A", entityRef: { kind: "asset", id: "PROP_A" }, pictureBindings: [{ id: "BIND_1", assetId: "PROP_A" }] }] }));
    assert.throws(() => deleteManualDirectorAsset(bound, "PROP_A"), /ASSET_IS_BOUND/);

    const compiled = makeDirector(propSource());
    compiled.artifacts = [{ id: "ART_PROP", targetId: "PROP_A", kind: "image", status: "stale" }];
    assert.throws(() => deleteManualDirectorAsset(compiled, "PROP_A"), /ASSET_HAS_MEDIA_OR_HISTORY/);
});

test("character and scene asset deletion refuses live registry references", () => {
    const character = makeDirector({
        asset_plan: [{ id: "ASSET_CHAR", kind: "character", created_by: "manual", entity_id: "CHAR_1", status: "planned", depends_on: [] }],
        asset_cards: [{ id: "ASSET_CHAR", asset_id: "ASSET_CHAR", prompt: "character" }],
        character_registry: [{ id: "CHAR_1", name: "A" }], subject_registry: [{ id: "SUB_CHAR", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP_1", kind: "character", id: "CHAR_1" }, pictureBindings: [] }],
        shots: [{ id: "SHOT_1", subject_usages: [{ subjectId: "SUB_CHAR", pictureBindingIds: [] }] }],
    });
    assert.throws(() => deleteManualDirectorAsset(character, "ASSET_CHAR"), /ASSET_STILL_REFERENCED.*subjectId/);

    const scene = makeDirector({
        asset_plan: [{ id: "ASSET_SCENE", kind: "scene", created_by: "manual", entity_id: "SCENE_1", status: "planned", depends_on: [] }],
        asset_cards: [{ id: "ASSET_SCENE", asset_id: "ASSET_SCENE", prompt: "scene" }], scene_registry: [{ id: "SCENE_1", name: "Room" }],
        script_scenes: [{ id: "OCC_1", scene_id: "SCENE_1" }],
    });
    assert.throws(() => deleteManualDirectorAsset(scene, "ASSET_SCENE"), /ASSET_STILL_REFERENCED.*script_scenes/);
});
