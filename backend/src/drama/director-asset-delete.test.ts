import assert from "node:assert/strict";
import test from "node:test";
import { directorHash } from "./director.js";
import { deleteDirectorAsset } from "./director-asset-delete.js";

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

    deleteDirectorAsset(director, "PROP_A");

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

test("asset deletion allows an unused director-authored planned asset", () => {
    const source = propSource();
    source.asset_plan[0].created_by = "director";
    const director = makeDirector(source);
    deleteDirectorAsset(director, "PROP_A");
    assert.deepEqual(director.source.asset_plan.map((row: any) => row.id), ["PROP_B"]);
    assert.deepEqual(director.source.asset_cards.map((row: any) => row.id), ["PROP_B"]);
});

test("asset deletion detaches dependencies and asset-card references", () => {
    const dependency = makeDirector(propSource({ asset_plan: [
        { id: "PROP_A", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: [] },
        { id: "PROP_B", kind: "prop", created_by: "manual", version: "v1", status: "planned", depends_on: ["PROP_A"] },
    ] }));
    deleteDirectorAsset(dependency, "PROP_A");
    assert.deepEqual(dependency.source.asset_plan.find((row: any) => row.id === "PROP_B").depends_on, []);

    const reference = makeDirector(propSource({ asset_cards: [
        { id: "PROP_A", asset_id: "PROP_A", prompt: "unused prop" },
        { id: "PROP_B", asset_id: "PROP_B", prompt: "uses another prop", references: [{ asset_id: "PROP_A" }] },
    ] }));
    deleteDirectorAsset(reference, "PROP_A");
    assert.deepEqual(reference.source.asset_cards.find((row: any) => row.id === "PROP_B").references, []);
});

test("asset deletion detaches Shot and Subject links and removes linked continuity records", () => {
    const shot = makeDirector(propSource({ shots: [{ id: "SHOT_1", required_assets: ["PROP_A"], subject_usages: [] }] }));
    deleteDirectorAsset(shot, "PROP_A");
    assert.deepEqual(shot.source.shots[0].required_assets, []);
    assert.equal(shot.source.asset_plan.length, 1);

    const subject = makeDirector(propSource({ shots: [{ id: "SHOT_1", subject_usages: [{ subjectId: "SUB_PROP_A", pictureBindingIds: [] }], camera: {}, keyframes: [] }] }));
    deleteDirectorAsset(subject, "PROP_A");
    assert.deepEqual(subject.source.shots[0].subject_usages, []);

    const continuity = makeDirector(propSource({ ledger: {
        facts: [{ id: "FACT_1", object_kind: "prop", object_id: "PROP_A", value: "held" }], timelines: [{ id: "T" }],
        initial: [{ id: "I", fact_id: "FACT_1", value: "held" }], events: [{ id: "E", fact_id: "FACT_1" }],
        requirements: [{ id: "R", fact_id: "FACT_1", event_ids: ["E"] }], coverage: [{ id: "C", fact_ids: ["FACT_1"], event_ids: ["E"] }],
    } }));
    deleteDirectorAsset(continuity, "PROP_A");
    assert.deepEqual(continuity.source.ledger.facts, []);
    assert.deepEqual(continuity.source.ledger.initial, []);
    assert.deepEqual(continuity.source.ledger.events, []);
    assert.deepEqual(continuity.source.ledger.requirements, []);
    assert.deepEqual(continuity.source.ledger.coverage[0].fact_ids, []);
    assert.deepEqual(continuity.source.ledger.coverage[0].event_ids, []);
});

test("asset deletion removes the draft definition while retaining bound media and compiled history", () => {
    for (const state of [
        { nodeId: "node-1", status: "planned" },
        { storageKey: "media:1", status: "generated" },
        { generationTaskId: "task-1", status: "planned" },
        { status: "approved" },
    ]) {
        const director = makeDirector(propSource());
        director.assets.PROP_A = { version: "v1", ...state };
        deleteDirectorAsset(director, "PROP_A");
        assert.equal(director.source.asset_plan.some((row: any) => row.id === "PROP_A"), false);
        assert.equal(director.assets.PROP_A, undefined);
    }

    const bound = makeDirector(propSource({ subject_registry: [{ id: "SUB_PROP_A", entityRef: { kind: "asset", id: "PROP_A" }, pictureBindings: [{ id: "BIND_1", assetId: "PROP_A" }] }] }));
    deleteDirectorAsset(bound, "PROP_A");
    assert.deepEqual(bound.source.subject_registry, []);

    const compiled = makeDirector(propSource());
    compiled.artifacts = [{ id: "ART_PROP", targetId: "PROP_A", kind: "image", status: "stale" }];
    deleteDirectorAsset(compiled, "PROP_A");
    assert.equal(compiled.artifacts[0].targetId, "PROP_A");
    assert.equal(compiled.artifacts[0].status, "stale");
});

test("character and scene asset deletion preserves scene/character structure while removing the asset card", () => {
    const character = makeDirector({
        asset_plan: [{ id: "ASSET_CHAR", kind: "character", created_by: "manual", entity_id: "CHAR_1", status: "planned", depends_on: [] }],
        asset_cards: [{ id: "ASSET_CHAR", asset_id: "ASSET_CHAR", prompt: "character" }],
        character_registry: [{ id: "CHAR_1", name: "A" }], subject_registry: [{ id: "SUB_CHAR", kind: "character", entityRef: { ownerKind: "episode", ownerId: "EP_1", kind: "character", id: "CHAR_1" }, pictureBindings: [] }],
        shots: [{ id: "SHOT_1", subject_usages: [{ subjectId: "SUB_CHAR", pictureBindingIds: [] }] }],
    });
    deleteDirectorAsset(character, "ASSET_CHAR");
    assert.equal(character.source.asset_plan.some((row: any) => row.id === "ASSET_CHAR"), false);
    assert.equal(character.source.subject_registry.length, 1);
    assert.equal(character.source.shots[0].subject_usages[0].subjectId, "SUB_CHAR");
    assert.equal(character.source.character_registry[0].id, "CHAR_1");

    const scene = makeDirector({
        asset_plan: [{ id: "ASSET_SCENE", kind: "scene", created_by: "manual", entity_id: "SCENE_1", status: "planned", depends_on: [] }],
        asset_cards: [{ id: "ASSET_SCENE", asset_id: "ASSET_SCENE", prompt: "scene" }], scene_registry: [{ id: "SCENE_1", name: "Room" }],
        script_scenes: [{ id: "OCC_1", scene_id: "SCENE_1" }],
    });
    deleteDirectorAsset(scene, "ASSET_SCENE");
    assert.equal(scene.source.script_scenes[0].scene_id, "SCENE_1");
    assert.equal(scene.source.scene_registry[0].id, "SCENE_1");
});
