import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { canonicalProduction, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { productionOperationContract } from "@basketikun/canvas-agent/drama/production-validation";
import { replaceDirectorSceneStoryboard } from "./scene-storyboard.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
const input = (keyframePolicy: "none" | "new" | "reuse" = "none") => ({ keyframePolicy, assetIds: [] });
function fixture() {
    const example = productionOperationContract("set_director_production").operations[0].example;
    assert.equal(example.type, "set_director_production");
    if (example.type !== "set_director_production") throw new Error("Unexpected fixture");
    const d = structuredClone(example.director) as DirectorProduction;
    d.source = {
        version: 2,
        prompt_assembly: { version: 2 },
        fps_num: 24, fps_den: 1,
        script_scenes: [
            { id: "SC1", scene_id: "ROOM", scene_name: "First", text: "First scene", beat_ids: ["B1"] },
            { id: "SC2", scene_id: "ROOM", scene_name: "Second", text: "Second scene", beat_ids: ["B2"] },
        ],
        scene_registry: [{ id: "ROOM", name: "Room" }],
        subject_registry: [], character_registry: [], asset_plan: [], asset_cards: [],
        shots: [
            { id: "A", source_scene_id: "SC1", scene_id: "ROOM", timeline_id: "main", story_order: 0, duration_frames: 12 },
            { id: "B", source_scene_id: "SC2", scene_id: "ROOM", timeline_id: "main", story_order: 1, duration_frames: 12 },
        ],
        segments: [{ id: "S1", shot_ids: ["A"], mode: "T2VA" }, { id: "S2", shot_ids: ["B"], mode: "T2VA" }],
        utterances: [],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] },
    };
    d.shotInputs = { A: input(), B: input() };
    d.boundaries = [{ from: "S1", to: "S2", tailFrame: false, motionContext: false, reason: "Authored cut" }];
    d.sourceHash = hash(d.source);
    return d;
}
const replacement = () => ({
    sceneId: "SC1",
    shots: [
        { id: "A", source_scene_id: "SC1", scene_id: "ROOM", duration_frames: 12 },
        { id: "A2", source_scene_id: "SC1", scene_id: "ROOM", duration_frames: 12 },
    ],
    segments: [{ id: "S1", shot_ids: ["A", "A2"], mode: "T2VA" }],
    shotInputs: { A: input(), A2: input() },
});

test("scene replacement preserves other scenes, existing Clip IDs and derives v2 story order", () => {
    const d = fixture(), before = structuredClone(d);
    replaceDirectorSceneStoryboard(d, replacement());
    assert.deepEqual((d.source.shots as any[]).map(shot => [shot.id, shot.story_order]), [["A", 0], ["A2", 1], ["B", 2]]);
    assert.deepEqual((d.source.shots as any[]).at(-1), { ...(before.source.shots as any[]).at(-1), story_order: 2 });
    assert.deepEqual(d.shotInputs.B, before.shotInputs.B);
    assert.deepEqual((d.source.segments as any[]).map(segment => segment.id), ["S1", "S2"]);
    assert.deepEqual(d.boundaries, before.boundaries);
    assert.notEqual(d.sourceHash, before.sourceHash);
});
test("an empty scene bootstraps formal Shots, Clips and default boundaries", () => {
    const d = fixture();
    d.source.shots = [];
    d.source.segments = [];
    d.shotInputs = {};
    d.boundaries = [];
    d.sourceHash = hash(d.source);
    const before = structuredClone(d);
    replaceDirectorSceneStoryboard(d, {
        sceneId: "SC1",
        shots: [
            { id: "A", source_scene_id: "SC1", scene_id: "ROOM", duration_frames: 12 },
            { id: "A2", source_scene_id: "SC1", scene_id: "ROOM", duration_frames: 12 },
        ],
        segments: [{ id: "S1", shot_ids: ["A"], mode: "T2VA" }, { id: "S2", shot_ids: ["A2"], mode: "T2VA" }],
        shotInputs: { A: input(), A2: input() },
    });
    assert.deepEqual((d.source.shots as any[]).map(shot => [shot.id, shot.story_order]), [["A", 0], ["A2", 1]]);
    assert.deepEqual((d.source.segments as any[]).map(segment => segment.id), ["S1", "S2"]);
    assert.deepEqual(d.boundaries.map(edge => [edge.from, edge.to, edge.tailFrame, edge.motionContext]), [["S1", "S2", true, false]]);
    assert.deepEqual(Object.keys(d.shotInputs).sort(), ["A", "A2"]);
    assert.notEqual(d.sourceHash, before.sourceHash);
});
test("bootstrapping a later scene inserts after the preceding scene and shifts later story order", () => {
    const d = fixture();
    (d.source.shots as any[]).splice(1, 1);
    (d.source.segments as any[]).splice(1, 1);
    delete d.shotInputs.B;
    d.boundaries = [];
    d.sourceHash = hash(d.source);
    replaceDirectorSceneStoryboard(d, {
        sceneId: "SC2",
        shots: [{ id: "B", source_scene_id: "SC2", scene_id: "ROOM", duration_frames: 12 }],
        segments: [{ id: "S2", shot_ids: ["B"], mode: "T2VA" }],
        shotInputs: { B: input() },
    });
    assert.deepEqual((d.source.shots as any[]).map(shot => [shot.id, shot.story_order]), [["A", 0], ["B", 1]]);
    assert.deepEqual((d.source.segments as any[]).map(segment => segment.id), ["S1", "S2"]);
    assert.deepEqual(d.boundaries.map(edge => [edge.from, edge.to]), [["S1", "S2"]]);
});
test("scene storyboard registration refuses invalid ownership, coverage and frame fields atomically", () => {
    const edits: Array<(op: any) => void> = [
        op => op.shots[1].id = "B",
        op => op.shots[1].source_scene_id = "SC2",
        op => op.segments[0].shot_ids.pop(),
        op => op.segments[0].shot_ids.push("MISSING"),
        op => op.segments[0].id = "NEW",
        op => op.shots[0].start_frame = 0,
        op => delete op.shotInputs.A2,
        op => op.shots[1].timeline_id = "other",
    ];
    for (const edit of edits) {
        const d = fixture(), before = structuredClone(d), op = replacement();
        edit(op);
        assert.throws(() => replaceDirectorSceneStoryboard(d, op));
        assert.deepEqual(d, before);
    }
});
test("scene storyboard registration refuses a non-v2 source without touching it", () => {
    const d = fixture();
    (d.source as any).version = 1;
    const before = structuredClone(d);
    assert.throws(() => replaceDirectorSceneStoryboard(d, replacement()), /SUBJECT_SOURCE_VERSION_REQUIRED/);
    assert.deepEqual(d, before);
});
