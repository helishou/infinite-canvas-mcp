import assert from "node:assert/strict";
import test from "node:test";
import { claimableProductionClipNodes, clipInputOperations, formalStoryboardTrack, reconcileCharacterGroupOutfitSelection, remapPromptPicturesByBinding } from "./clip-inputs.js";
import { refsForSegment } from "../../../plugins/canvas/minimax-h3/src/services/h3-data.js";

const OWNER = { kind: "episode" as const, id: "EP" };

test("workbench keyframe edits refresh the existing storyboard slot instead of retaining old media", () => {
    const data = { director: { source: { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 },
        fps_num: 24, fps_den: 1, shots: [{ id: "S", duration_frames: 24,
            keyframes: [{ id: "KF-S-WORKBENCH", assetId: "FRAME", requiredForSubmission: true, anchor: "opening", sourceNode: { nodeId: "NEW" } }] }] },
        assets: { FRAME: { storageKey: "image:new", nodeId: "NEW" } } }, shots: [] } as any;
    const existing = { storyboardShots: [{ id: "S", duration: 1, referenceBindingId: "slot" }],
        referenceBindings: [{ id: "slot", assetId: "FRAME", role: "storyboard", mediaType: "image", storageKey: "image:old", sourceNodeId: "OLD" }] };
    const track = formalStoryboardTrack(data, { shotIds: ["S"] } as any, existing)!;
    assert.equal(track.storyboardShots[0].referenceBindingId, "slot");
    assert.equal(track.referenceBindings?.length, 1);
    assert.equal(track.referenceBindings?.[0].storageKey, "image:new");
    assert.equal(track.referenceBindings?.[0].sourceNodeId, "NEW");
    assert.equal(existing.referenceBindings[0].storageKey, "image:old");
    data.director.source.shots[0].keyframes = [];
    const cleared = formalStoryboardTrack(data, { shotIds: ["S"] } as any, existing)!;
    assert.equal(cleared.storyboardShots[0].referenceBindingId, undefined);
    assert.deepEqual(cleared.referenceBindings, []);
});

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

test("formal prompt Picture ordinals rebase by binding identity and reject changed reference sets", () => {
    const binding = (id: string, sourceNodeId: string, storageKey: string) => ({
        id, sourceNodeId, storageKey, mediaType: "image", enabled: true,
    });
    const compiled = [binding("scene", "scene-node", "image:room"), binding("shenyan", "shenyan-node", "image:shenyan")];
    const reordered = [...compiled].reverse();
    const prompt = "<Subject 1> Shenyan <Picture 2>; <Subject 3> room <Picture 1>.";
    assert.equal(remapPromptPicturesByBinding(prompt, compiled, reordered),
        "<Subject 1> Shenyan <Picture 1>; <Subject 3> room <Picture 2>.");
    assert.equal(remapPromptPicturesByBinding(prompt, compiled, compiled.slice(1)), undefined,
        "a deleted reference must not produce a partially rebound Prompt");
    const formalOrder = [binding("shenyan-source", "shenyan-node", "image:shenyan"), binding("hongxiao-source", "hongxiao-node", "image:hongxiao"), binding("scene-source", "scene-node", "image:room")];
    const effectiveH3Order = [
        binding("scene-binding", "scene-node", "image:room"),
        binding("shenyan-group-binding", "shenyan-node", "image:shenyan"),
        binding("hongxiao-group-binding", "hongxiao-node", "image:hongxiao"),
    ];
    assert.equal(remapPromptPicturesByBinding("Shenyan <Picture 1>; Hongxiao <Picture 2>; scene <Picture 3>.", formalOrder, effectiveH3Order),
        "Shenyan <Picture 2>; Hongxiao <Picture 3>; scene <Picture 1>.",
        "the final H3 input order includes standalone references before derived character-group images");
});

test("legacy bindings only match by source node plus media identity when unique", () => {
    const legacy = [{ sourceNodeId: "person", storageKey: "image:portrait", mediaType: "image" }];
    const current = [{ id: "new-id", sourceNodeId: "person", storageKey: "image:portrait", mediaType: "image" }];
    assert.equal(remapPromptPicturesByBinding("<Picture 1>", legacy, current), "<Picture 1>");
    assert.equal(remapPromptPicturesByBinding("<Picture 1>", legacy, [
        ...current, { id: "duplicate", sourceNodeId: "person", storageKey: "image:portrait", mediaType: "image" },
    ]), undefined);
    assert.equal(remapPromptPicturesByBinding("<Picture 1>", legacy, [{ ...current[0], sourceNodeId: "other" }]), undefined);
});

test("formal Subject picture selection disables every unselected derived character outfit", () => {
    const groups = {
        red: { id: "red", characterNodeId: "red-node", subjectId: "SUB-RED", outfitEnabled: true, outfits: [
            { id: "white", name: "white", storageKey: "image:white", enabled: true },
            { id: "nude", name: "nude", storageKey: "image:nude", enabled: true },
        ] },
    };
    const bindings = [{ id: "white-binding", assetId: "white-asset", groupId: "red", outfitId: "white", sourceNodeId: "red-node", storageKey: "image:white", mediaType: "image", enabled: true }];
    const projected = reconcileCharacterGroupOutfitSelection(groups, bindings) as typeof groups;
    assert.deepEqual(projected.red.outfits.map(outfit => [outfit.id, outfit.enabled]), [["white", true], ["nude", false]]);
    assert.equal(projected.red.outfitEnabled, true);
});

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

test("a Clip inserted mid-timeline inherits scene bindings, character groups, and mode from sibling rows", () => {
    const sibling = {
        ...projectedClip("clip-a", "CLIP_A"), taskMode: "ref2va",
        referenceBindings: [
            { id: "scene-binding", role: "scene", usage: "reference", picturePurpose: ["scene"], sourceNodeId: "scene-node", storageKey: "image:room", mediaType: "image", enabled: true },
            { id: "shot-binding", role: "storyboard", usage: "first_last", sourceNodeId: "frame-node", storageKey: "image:frame", mediaType: "image", enabled: true },
        ],
        h3CharacterGroups: { "group-muli": { id: "group-muli", characterNodeId: "entity-muli", subjectId: "SUBJ-MULI", outfitEnabled: true, outfits: [{ id: "o1", name: "ritual", storageKey: "image:ritual", enabled: true }] } },
    };
    const sameNodeLayout = layoutFor({ id: "CLIP_A", nodeId: "H3-A", sceneId: "SC-A" }, { id: "CLIP_B", nodeId: "H3-A", sceneId: "SC-A" });
    const inserted = structuredClone(twoSceneProduction);
    inserted.clipGroups[1] = { id: "CLIP_B", shotIds: ["SH-B"], nodeId: "H3-A", segmentId: "clip-b-new" };
    const canvas = project(h3Node("H3-A", "SC-A", [structuredClone(sibling)]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    const added = clipInputOperations(canvas, inserted, sameNodeLayout, {}, new Set(["CLIP_B"])).operations
        .find(operation => operation.type === "add_h3_segment" && operation.nodeId === "H3-A");
    assert.ok(added, "the inserted Clip must materialize on the shared scene node");
    const segment = (added as any).segment;
    assert.equal(segment.taskMode, "ref2va", "sibling mode is inherited when the source carries no derived mode");
    assert.deepEqual(segment.referenceBindings.map(binding => binding.id), ["scene-binding"], "only role/usage scene bindings are inherited");
    assert.deepEqual(Object.keys(segment.h3CharacterGroups), ["group-muli"], "character groups are inherited from the sibling row");

    // A formal-source derived mode still wins over the inherited sibling mode.
    const derived = structuredClone(inserted);
    derived.director.source.segments[1].mode = "T2VA";
    const derivedAdded = clipInputOperations(project(h3Node("H3-A", "SC-A", [structuredClone(sibling)]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")])),
        derived, sameNodeLayout, {}, new Set(["CLIP_B"])).operations.find(operation => operation.type === "add_h3_segment" && operation.nodeId === "H3-A");
    assert.equal((derivedAdded as any).segment.taskMode, "t2v", "derived source mode overrides the sibling-inherited mode");
});

test("a formal character group inherited from a sibling is scoped by the new Clip's Shot subjects", () => {
    const sibling = {
        ...projectedClip("clip-a", "CLIP_A"), taskMode: "ref2va",
        h3CharacterGroups: { "group-muli": { id: "group-muli", characterNodeId: "entity-muli", subjectId: "Mu Li", outfitEnabled: true, outfits: [{ id: "o1", name: "ritual", storageKey: "image:ritual", enabled: true }] } },
    };
    const sameNodeLayout = layoutFor({ id: "CLIP_A", nodeId: "H3-A", sceneId: "SC-A" }, { id: "CLIP_B", nodeId: "H3-A", sceneId: "SC-A" });
    const production: any = structuredClone(twoSceneProduction);
    production.clipGroups[1] = { id: "CLIP_B", shotIds: ["SH-B"], nodeId: "H3-A", segmentId: "clip-b-new" };
    production.director.source.subject_registry = [{ id: "EP2-SUBJ-MULI", pictureBindings: [{ id: "EP2-PB-MULI", sourceNode: { nodeId: "entity-muli" } }] }];
    const canvas = project(h3Node("H3-A", "SC-A", [sibling]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    const addFor = (data: typeof production) => clipInputOperations(canvas, data, sameNodeLayout, {}, new Set(["CLIP_B"]))
        .operations.find(operation => operation.type === "add_h3_segment" && operation.nodeId === "H3-A") as any;

    const unused = addFor(production);
    assert.deepEqual(unused.segment.h3CharacterGroups, {}, "a display-name subjectId is resolved through the exact character node and omitted when the new Shots do not use it");

    const visible = structuredClone(production);
    visible.director.source.shots.find((shot: any) => shot.id === "SH-B").subject_usages = [{ subjectId: "EP2-SUBJ-MULI", presentation: "visible" }];
    const included = addFor(visible).segment.h3CharacterGroups["group-muli"];
    assert.equal(included.subjectId, "EP2-SUBJ-MULI", "inherited formal groups use the stable Subject ID");
    assert.equal(included.outfitEnabled, true);
});

test("new Subject Clips do not inherit a sibling's unrelated asset-library character images", () => {
    const production = structuredClone(twoSceneProduction);
    Object.assign(production.director.source, { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 }, subject_registry: [] });
    production.clipGroups[1] = { id: "CLIP_B", shotIds: ["SH-B"], nodeId: "H3-A", segmentId: "clip-b-new" };
    const sibling = { ...projectedClip("clip-a", "CLIP_A"), taskMode: "ref2va",
        referenceBindings: [{ id: "scene", assetId: "scene", role: "scene", storageKey: "image:room", mediaType: "image", enabled: true }],
        h3CharacterGroups: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`library-${index}`, {
            id: `library-${index}`, characterNodeId: `library-node-${index}`, subjectId: `old-subject-${index}`,
            outfitEnabled: true, outfits: [{ id: `outfit-${index}`, storageKey: `image:library-${index}`, enabled: true }],
        }])),
    };
    assert.equal(refsForSegment(sibling as any).length, 18, "the H3 reference-list resolver expands the contaminated sibling to 18 images");
    const before = structuredClone(sibling);
    const operations = clipInputOperations(project(h3Node("H3-A", "SC-A", [sibling])), production,
        layoutFor({ id: "CLIP_B", nodeId: "H3-A", sceneId: "SC-A" }), {}, new Set(["CLIP_B"]), new Set(["CLIP_B"]), undefined, undefined, new Set(["CLIP_B"])).operations;
    const added = operations.find(operation => operation.type === "add_h3_segment") as any;
    assert.ok(added);
    assert.deepEqual(added.segment.h3CharacterGroups, {}, "a new Shot without Subject usages must not acquire the sibling's entire library");
    assert.deepEqual(added.segment.referenceBindings.map((binding: any) => binding.id), ["scene"]);
    assert.equal(refsForSegment(added.segment).length, 1, "the rendered Clip inputs stay at the single inherited scene image");
    assert.deepEqual(sibling, before, "planning must not mutate sibling inputs");
});

test("new Subject Clips inherit only outfits selected by the new Shot, including default and explicit-empty selection", () => {
    const production = structuredClone(twoSceneProduction);
    const picture = (id: string) => ({ id, assetId: id, provides: ["identity"], defaultFor: id === "selected" ? ["identity"] : [], sourceNode: { nodeId: "actor" } });
    Object.assign(production.director.source, { version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 },
        subject_registry: [{ id: "SUB-ACTOR", pictureBindings: [picture("selected"), picture("other")] }] });
    production.clipGroups[1] = { id: "CLIP_B", shotIds: ["SH-B"], nodeId: "H3-A", segmentId: "clip-b-new" };
    const sibling = { ...projectedClip("clip-a", "CLIP_A"), h3CharacterGroups: { actor: {
        id: "actor-group", subjectId: "SUB-ACTOR", characterNodeId: "actor", outfitEnabled: true,
        voiceEnabled: true, voice: { url: "/voice.wav" },
        outfits: ["selected", "other"].map(id => ({ id: `outfit-${id}`, pictureBindingId: id, storageKey: `image:${id}`, enabled: true })),
    } } };
    const before = structuredClone(sibling);
    const addFor = (presentation: string, mode: string, ids: string[]) => {
        production.director.source.shots[1].subject_usages = [{ subjectId: "SUB-ACTOR", presentation, pictureBindingMode: mode, pictureBindingIds: ids }];
        return (clipInputOperations(project(h3Node("H3-A", "SC-A", [sibling])), production,
            layoutFor({ id: "CLIP_B", nodeId: "H3-A", sceneId: "SC-A" }), {}, new Set(["CLIP_B"]), new Set(["CLIP_B"]), undefined, undefined, new Set(["CLIP_B"]))
            .operations.find(operation => operation.type === "add_h3_segment") as any).segment.h3CharacterGroups.actor;
    };
    assert.deepEqual(addFor("visible", "default", []).outfits.map((outfit: any) => [outfit.pictureBindingId, outfit.enabled]), [["selected", true], ["other", false]]);
    assert.equal(addFor("visible", "explicit", []).outfitEnabled, false);
    assert.deepEqual(addFor("visible", "explicit", ["other"]).outfits.map((outfit: any) => [outfit.pictureBindingId, outfit.enabled]), [["selected", false], ["other", true]]);
    const offscreen = addFor("offscreen_voice", "default", []);
    assert.equal(offscreen.outfitEnabled, false);
    assert.equal(offscreen.voiceEnabled, true);
    assert.deepEqual(sibling, before);

    // Older groups lack pictureBindingId on outfit rows, but their saved
    // reference snapshots still link the exact selected binding to its slot.
    (sibling as any).referenceBindings = [{ id: "snapshot", pictureBindingId: "selected", sourceNodeId: "actor", outfitId: "outfit-selected", storageKey: "image:selected" }];
    for (const outfit of sibling.h3CharacterGroups.actor.outfits) delete (outfit as any).pictureBindingId;
    assert.deepEqual(addFor("visible", "default", []).outfits.map((outfit: any) => [outfit.id, outfit.enabled]), [["outfit-selected", true], ["outfit-other", false]]);
});

test("a Shot-local projection neither adds outside its targets nor sweeps other nodes", () => {
    const missing = project(h3Node("H3-A", "SC-A", []), h3Node("H3-B", "SC-B", []));
    const scoped = clipInputOperations(missing, twoSceneProduction, layout, {}, new Set(), new Set(["CLIP_B"]));
    assert.deepEqual(adds(scoped.operations), [], "only the groups this operation created may be added");

    const intact = project(h3Node("H3-A", "SC-A", [projectedClip("clip-a", "CLIP_A")]), h3Node("H3-B", "SC-B", [projectedClip("clip-b", "CLIP_B")]));
    assert.deepEqual(deletes(clipInputOperations(intact, twoSceneProduction, layout, {}, new Set(), new Set(["CLIP_B"])).operations), [], "untouched scene must not lose its Clips");
});

test("pending Clip compilation preserves existing inputs and does not report a missing artifact", () => {
    const existing = { ...projectedClip("clip-a", "CLIP_A"), resultStorageKey: "video:previous", prompt: "previous compiled prompt" };
    const current = project(h3Node("H3-A", "SC-A", [existing]));
    const result = clipInputOperations(current, onlyClipA, layout, {}, new Set(), new Set(["CLIP_A"]), undefined, undefined, new Set(["CLIP_A"]));
    assert.deepEqual(result.referenceSync, []);
    assert.deepEqual(result.operations, []);
    assert.equal(existing.prompt, "previous compiled prompt");
    assert.equal(existing.resultStorageKey, "video:previous");
});

test("Clip diagnostics distinguish a missing artifact from a changed compiler", () => {
    const current = project(h3Node("H3-A", "SC-A", [projectedClip("clip-a", "CLIP_A")]));
    const production = { ...onlyClipA, shots: [{ id: "SH-A", duration: 4 }] };
    const missing = clipInputOperations(current, production, layout).referenceSync[0];
    assert.equal(missing.diagnostics[0].code, "COMPILATION_ARTIFACT_MISSING");
    const data = structuredClone(production);
    data.director.engine = { compilerHashes: { h3: "current" } };
    data.director.artifacts = [{ kind: "h3", targetId: "CLIP_A", status: "ready", prompt: "old prompt", sha256: "old",
        receipt: { engine: { compilerHashes: { h3: "old" } } } }];
    const stale = clipInputOperations(current, data, layout).referenceSync[0];
    assert.equal(stale.diagnostics[0].code, "COMPILATION_ARTIFACT_STALE");
    assert.equal(stale.diagnostics[0].staleReason, "compiler_changed");
    assert.match(stale.diagnostics[0].message, /编译器已更新/);
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

test("a Clip row carried by a node copied from another episode still binds and re-claims its owner", () => {
    const foreign = { id: "H3-OLD", type: "minimax-h3:video", metadata: {
        productionOwnerKind: "episode", productionOwnerId: "EP-OTHER", productionSceneId: "SC-A",
        segments: [projectedClip("clip-a", "CLIP_A")],
    } };
    const result = clipInputOperations(project(foreign), onlyClipA, layout);
    assert.deepEqual(kinds(result.operations, "update_node").map(operation => [operation.id, operation.metadata.productionOwnerId]), [["H3-OLD", OWNER.id]],
        "a node carrying only this production's Clips is re-claimed for its real owner");
    assert.equal(result.referenceSync.length, 1, "the Clip must be evaluated instead of being silently skipped");
    assert.equal(result.referenceSync[0].targetId, "CLIP_A");
});

test("claimable Clip nodes resolve a migration copy through the layout assignment", () => {
    const row = (id: string, targetId: string) => ({ id, productionClipProjection: { targetId } });
    const stale = { id: "H3-OLD", type: "minimax-h3:video", metadata: {
        productionOwnerKind: "episode", productionOwnerId: OWNER.id, productionSceneId: "SC-STALE", segments: [row("clip-old", "CLIP_A")],
    } };
    const live = { id: "H3-A", type: "minimax-h3:video", metadata: {
        productionOwnerKind: "episode", productionOwnerId: OWNER.id, productionSceneId: "SC-A", segments: [row("clip-a", "CLIP_A")],
    } };
    const data = { ...onlyClipA, clipGroups: [{ id: "CLIP_A", shotIds: ["SH-A"] }] };
    const claim = claimableProductionClipNodes({ nodes: [stale, live] } as any, data as any, OWNER, new Set(["H3-A"]));
    assert.equal(claim.nodeByTarget.get("CLIP_A"), "H3-A", "the node the layout assigns wins over the migration copy");
    assert.deepEqual(claim.ownershipOperations, [], "an already-owned node must not be rewritten");
    const unassigned = claimableProductionClipNodes({ nodes: [stale, live] } as any, data as any, OWNER);
    assert.equal(unassigned.nodeByTarget.has("CLIP_A"), false, "without a layout assignment the duplicate stays unresolved instead of guessing");
});
