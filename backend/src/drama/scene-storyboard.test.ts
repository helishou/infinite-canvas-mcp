import assert from "node:assert/strict";
import test from "node:test";
import { replaceDirectorSceneStoryboard } from "./scene-storyboard.js";
import { productionOperationContract } from "@basketikun/canvas-agent/drama/production-validation";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

function fixture() {
    const example = productionOperationContract("set_director_production").operations[0].example;
    assert.equal(example.type, "set_director_production");
    if (example.type !== "set_director_production") throw new Error("Unexpected fixture");
    const d = example.director as DirectorProduction;
    d.source.shots = [{ id: "A", source_scene_id: "SC1", start_frame: 0, end_frame: 24 }, { id: "B", source_scene_id: "SC2", start_frame: 24, end_frame: 48 }];
    d.source.segments = [{ id: "S1", shot_ids: ["A"], start_frame: 0, end_frame: 24 }, { id: "S2", shot_ids: ["B"], start_frame: 24, end_frame: 48 }];
    d.shotInputs = { A: { keyframePolicy: "none", assetIds: [] }, B: { keyframePolicy: "none", assetIds: [] } };
    return d;
}
const replacement = () => ({ sceneId: "SC1", shots: [{ id: "A", source_scene_id: "SC1", start_frame: 0, end_frame: 12 }, { id: "A2", source_scene_id: "SC1", start_frame: 12, end_frame: 24 }], segments: [{ id: "S1", shot_ids: ["A", "A2"], start_frame: 0, end_frame: 24 }], shotInputs: { A: { keyframePolicy: "none", assetIds: [] }, A2: { keyframePolicy: "none", assetIds: [] } } });
test("scene replacement preserves other scenes, existing segment IDs and total frames", () => {
    const d = fixture(), before = structuredClone(d); replaceDirectorSceneStoryboard(d, replacement());
    assert.deepEqual((d.source.shots as any[]).at(-1), (before.source.shots as any[]).at(-1));
    assert.deepEqual((d.source.segments as any[]).at(-1), (before.source.segments as any[]).at(-1));
    assert.deepEqual(d.shotInputs.B, before.shotInputs.B);
    assert.notEqual(d.sourceHash, before.sourceHash);
});
test("scene replacement refuses gaps, cross-scene IDs and incomplete coverage atomically", () => {
    for (const edit of [(op: any) => op.shots[1].start_frame++, (op: any) => op.shots[1].id = "B", (op: any) => op.segments[0].shot_ids.pop(), (op: any) => op.segments[0].id = "NEW"]) {
        const d = fixture(), before = structuredClone(d), op = replacement(); edit(op);
        assert.throws(() => replaceDirectorSceneStoryboard(d, op)); assert.deepEqual(d, before);
    }
});
