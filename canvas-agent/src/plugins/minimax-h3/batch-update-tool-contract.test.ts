import assert from "node:assert/strict";
import test from "node:test";
import { H3_UPDATE_CLIPS_TOOL } from "./batch-update-tool.js";
import { buildH3BatchUpdates } from "./mcp.js";

test("H3 batch updates target stable Clip IDs after reordering and reject array indices", () => {
    const itemSchema = H3_UPDATE_CLIPS_TOOL.inputJsonSchema.properties.updates.items;
    assert.deepEqual(itemSchema.required, ["segmentId"]);
    assert.deepEqual(itemSchema.anyOf, [{ required: ["patch"] }, { required: ["edits"] }]);
    assert.equal(itemSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(itemSchema.properties, "segmentIndex"), false);
    const node = { id: "h3", type: "minimax-h3", title: "H3", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { segments: [
        { id: "clip-b", prompt: "B", mode: "t2v" },
        { id: "clip-a", prompt: "A", mode: "t2v" },
    ] } };
    const project = { id: "project", nodes: [node], connections: [] };
    const before = structuredClone(project);
    const updated = buildH3BatchUpdates(project, node, [{ segmentId: "clip-a", patch: { title: "changed" } }]);
    assert.deepEqual(updated.operations, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip-a", patch: { title: "changed" } }]);
    assert.equal(updated.entries[0].segmentIndex, 1);
    assert.deepEqual(project, before, "preparing updates must not mutate any Clip");
    assert.throws(() => buildH3BatchUpdates(project, node, [{ segmentIndex: 0, patch: { title: "wrong" } }]), /INVALID_CLIP_FIELD/);
    assert.throws(() => buildH3BatchUpdates(project, node, [{ segmentId: "missing", patch: { title: "wrong" } }]), /找不到片段/);
});
