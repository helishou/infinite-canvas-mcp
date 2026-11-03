import assert from "node:assert/strict";
import test from "node:test";
import { computeGraphLayout } from "./workflow-graph-view.js";
import { workflowDisplayGraph } from "./workflow-source.js";
import { lastOutputNodeId } from "./output-node-picker.js";

const source = { nodes: [
    { id: 1, type: "Loader", pos: [100, 200], inputs: [] },
    { id: 2, type: "SetNode", pos: [300, 200], widgets_values: ["image"], inputs: [{ name: "value", link: 1 }] },
    { id: 3, type: "GetNode", pos: [500, 400], widgets_values_named: { Constant: "image" }, inputs: [] },
    { id: 4, type: "SaveImage", pos: [700, 400], inputs: [{ name: "images", link: 2 }] },
    { id: 5, type: "SaveImage", mode: 2, pos: [700, 500], inputs: [] },
], links: [[1, 1, 0, 2, 0], [2, 3, 0, 4, 0]], extra: { keep: true } };

test("native source display keeps virtual names and authored layout without mutation", () => {
    const before = JSON.stringify(source);
    const display = workflowDisplayGraph(source);
    assert.equal(display[3]._meta?.title, "GetNode: image");
    assert.deepEqual(display[2].inputs?.value, ["1", 0]);
    const layout = computeGraphLayout(source as any, []);
    assert.equal(layout.nodes.length, 5);
    assert.equal(layout.nodes.find((node) => node.id === "2")?.classType, "SetNode");
    assert.equal(layout.nodes.find((node) => node.id === "3")?.x, 420);
    assert.equal(layout.nodes.find((node) => node.id === "3")?.y, 220);
    assert.equal(layout.edges.length, 2);
    assert.equal(JSON.stringify(source), before);
});

test("native source output picker excludes disabled outputs and virtual nodes", () => {
    assert.equal(lastOutputNodeId(source as any), "4");
});
