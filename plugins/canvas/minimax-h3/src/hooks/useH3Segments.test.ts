import assert from "node:assert/strict";
import test from "node:test";
import { segmentsFor } from "./useH3Segments";

test("an empty production scene H3 node does not synthesize an unowned default Clip", () => {
    assert.deepEqual(segmentsFor({ productionSceneId: "scene-1", segments: [] }), []);
});

test("ordinary empty H3 nodes keep their existing default Clip behavior", () => {
    assert.deepEqual(segmentsFor({ segments: [] }).map(segment => segment.id), ["segment-1"]);
});
