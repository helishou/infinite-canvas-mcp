import assert from "node:assert/strict";
import test from "node:test";
import { productionCanvasNodes } from "./production-canvas-nodes";

test("canvas-only node changes replace the initial read without a production refresh", () => {
    const read = { id: "episode", revision: 3, nodes: [{ id: "old" }] };
    const live = { id: "episode", revision: 4, nodes: [{ id: "new", title: "新图片节点" }] };
    assert.equal(productionCanvasNodes("episode", live, read), live.nodes);
    assert.deepEqual(productionCanvasNodes("episode", { ...live, revision: 5, nodes: [] }, read), []);
});
test("older cache and summary cannot hide nodes from a fresh full read", () => {
    const read = { id: "episode", revision: 8, nodes: [{ id: "fresh" }] };
    assert.equal(productionCanvasNodes("episode", { id: "episode", revision: 7, nodes: [] }, read), read.nodes);
    assert.equal(productionCanvasNodes("episode", { id: "episode", revision: 9, nodes: [], summary: true }, read), read.nodes);
    assert.equal(productionCanvasNodes("episode", { id: "episode", revision: 9, nodes: [], summary: { nodeCount: 10, connectionCount: 2 } }, read), read.nodes);
});
test("node projections remain scoped to the selected canvas", () => {
    const other = { id: "shared", revision: 9, nodes: [{ id: "shared-node" }] };
    assert.deepEqual(productionCanvasNodes("episode", other, other), []);
    assert.equal(productionCanvasNodes("shared", other), other.nodes);
});
