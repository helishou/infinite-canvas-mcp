import assert from "node:assert/strict";
import test from "node:test";
import { clipInputOperations } from "./clip-inputs.js";

const OWNER = { kind: "episode" as const, id: "EP" };

function layoutFor(...groups: Array<{ id: string; nodeId: string; sceneId: string }>) {
    return {
        schemaVersion: 1, algorithmVersion: "test", canvasId: "CANVAS", owner: OWNER,
        structureHash: "0".repeat(64), geometryHash: "0".repeat(64), planHash: "0".repeat(64),
        regions: [], diagnostics: [],
        units: groups.map(group => ({
            id: `unit-${group.id}`, area: "video" as const, targets: [`segment:${group.id}`], sceneId: group.sceneId,
            bounds: { position: { x: 0, y: 0 }, size: { width: 320, height: 240 } }, status: "materialized" as const,
            members: [{ role: "video" as const, nodeId: group.nodeId, nodeType: "minimax-h3:video", position: { x: 0, y: 0 }, size: { width: 320, height: 240 } }],
        })),
    } as any;
}

const h3Node = (id: string, sceneId: string, segments: Array<Record<string, any>>) => ({
    id, type: "minimax-h3:video",
    metadata: { productionOwnerKind: "episode", productionOwnerId: OWNER.id, productionSceneId: sceneId, segments },
});

/** A projected Clip row without a manual-edit baseline, so only the orphan sweep can decide its fate. */
const projectedClip = (id: string, targetId: string) => ({ id, duration: 4, prompt: "compiled", status: "success", productionClipProjection: { targetId, sourceHash: "h" } });

const twoSceneProduction = {
    director: {
        assets: {}, shotInputs: {}, artifacts: [],
        source: {
            fps_num: 24, fps_den: 1,
            script_scenes: [{ id: "SC-A", scene_id: "ROOM-A", scene_name: "A", text: "" }, { id: "SC-B", scene_id: "ROOM-B", scene_name: "B", text: "" }],
            shots: [{ id: "SH-A", scene_id: "ROOM-A", duration_frames: 96 }, { id: "SH-B", scene_id: "ROOM-B", duration_frames: 96 }],
            segments: [{ id: "CLIP_A", shot_ids: ["SH-A"] }, { id: "CLIP_B", shot_ids: ["SH-B"] }],
        },
    },
    clipGroups: [
        { id: "CLIP_A", shotIds: ["SH-A"], nodeId: "H3-A", segmentId: "clip-a" },
        { id: "CLIP_B", shotIds: ["SH-B"], nodeId: "H3-B", segmentId: "clip-b" },
    ],
    settings: {},
} as any;

const layout = layoutFor({ id: "CLIP_A", nodeId: "H3-A", sceneId: "SC-A" }, { id: "CLIP_B", nodeId: "H3-B", sceneId: "SC-B" });
const onlyClipA = { ...twoSceneProduction, clipGroups: [twoSceneProduction.clipGroups[0]] };
const project = (...nodes: Array<Record<string, any>>) => ({ id: "CANVAS", revision: 10, nodes, connections: [] });
const kinds = (operations: Array<Record<string, any>>, type: string) => operations.filter(operation => operation.type === type);
const deletes = (operations: Array<Record<string, any>>) => kinds(operations, "delete_h3_segment").map(operation => String(operation.segmentId));
const adds = (operations: Array<Record<string, any>>) => kinds(operations, "add_h3_segment").map(operation => `${operation.nodeId}:${operation.segment.id}`);

test("a full projection inserts every current Clip, including rows lost earlier", () => {
    const missing = project(h3Node("H3-A", "SC-A", []), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    assert.deepEqual(adds(clipInputOperations(missing, twoSceneProduction, layout, {}, new Set()).operations), ["H3-A:clip-a"]);

    // An already present row is updated in place rather than duplicated.
    const complete = project(h3Node("H3-A", "SC-A", [projectedClip("clip-a", "CLIP_A")]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    assert.deepEqual(adds(clipInputOperations(complete, twoSceneProduction, layout, {}, new Set()).operations), []);

    // A Clip that left the production timeline is still cleaned up.
    const drifted = project(h3Node("H3-A", "SC-A", [projectedClip("clip-a", "CLIP_A"), projectedClip("clip-gone", "CLIP_GONE")]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    assert.deepEqual(deletes(clipInputOperations(drifted, twoSceneProduction, layout, {}, new Set()).operations), ["clip-gone"]);
});

test("a Shot-local projection neither adds outside its targets nor sweeps other nodes", () => {
    const missing = project(h3Node("H3-A", "SC-A", []), h3Node("H3-B", "SC-B", []));
    const scoped = clipInputOperations(missing, twoSceneProduction, layout, {}, new Set(), new Set(["CLIP_B"]));
    assert.deepEqual(adds(scoped.operations), [], "only the groups this operation created may be added");

    const intact = project(h3Node("H3-A", "SC-A", [projectedClip("clip-a", "CLIP_A")]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    assert.deepEqual(deletes(clipInputOperations(intact, twoSceneProduction, layout, {}, new Set(), new Set(["CLIP_B"])).operations), [], "untouched scene must not lose its Clips");
});

const characterGroup = (outfitId: string) => ({
    "character-group-asset-1": {
        id: "character-group-asset-1", characterName: "红绡", characterNodeId: "character-1", subjectId: "character-1",
        outfits: [{ id: outfitId, url: "/media/image%3Aa", storageKey: "image:a", name: "形象", role: "character_turnaround", enabled: true }],
        voiceEnabled: false, outfitEnabled: true,
    },
});

const authoredFields = { sourceShotId: "SH-A", title: "推门入雨", duration: 4, taskMode: "ref2va", prompt: "compiled", referenceBindings: [],
    tailFrameContinuation: false, motionContextEnabled: false, directorEngine: { runtimeId: "runtime" }, directorSourceHash: "h",
    styleTemplateId: null, storyboardShots: [], aspectRatio: "16:9", modelName: "model" };

/** The Clip's character groups were re-derived after the source character node was replaced. */
const regeneratedGroupClip = (overrides: Record<string, any> = {}) => ({
    id: "clip-stale", ...authoredFields, status: "success",
    h3CharacterGroups: characterGroup("outfit-binding-regenerated"),
    productionClipProjection: { targetId: "CLIP_GONE", sourceHash: "h",
        nextValues: { ...authoredFields, h3CharacterGroups: characterGroup("outfit-binding-original") } },
    ...overrides,
});

test("regenerated character-group identity does not freeze an obsolete Clip as manually edited", () => {
    const clip = (overrides: Record<string, any> = {}) => project(h3Node("H3-A", "SC-A", [regeneratedGroupClip(overrides)]));

    assert.deepEqual(deletes(clipInputOperations(clip(), onlyClipA, layout, {}, new Set()).operations), ["clip-stale"]);
    assert.deepEqual(deletes(clipInputOperations(clip({ title: "人工改过的标题" }), onlyClipA, layout, {}, new Set()).operations), [], "a real edit must keep the Clip");
    assert.deepEqual(deletes(clipInputOperations(clip({ h3CharacterGroups: { "character-group-asset-1": { ...characterGroup("outfit-binding-regenerated")["character-group-asset-1"], outfitEnabled: false } } }), onlyClipA, layout, {}, new Set()).operations), [], "disabling outfits is an authored edit");
});
