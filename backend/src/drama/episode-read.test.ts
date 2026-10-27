import assert from "node:assert/strict";
import test from "node:test";
import { episodeCanvasRead } from "./episode-read.js";

const canvas = {
    id: "c", title: "画布", revision: 27,
    nodes: [{ id: "n1" }, { id: "n2" }],
    connections: [{ fromNodeId: "n1", toNodeId: "n2" }],
    updatedAt: "2026-10-20T00:00:00.000Z",
};

test("ref view returns canvas identity and counts without node payloads", () => {
    const read = episodeCanvasRead(canvas, "ref");
    assert.deepEqual(read.canvas, {
        id: "c", title: "画布", revision: 27, nodeCount: 2, connectionCount: 1, updatedAt: "2026-10-20T00:00:00.000Z",
    });
    assert.equal(read.nextAction?.tool, "canvas_get_state");
    assert.equal((read.canvas as any).nodes, undefined);
});

test("full view keeps the complete canvas for explicit callers", () => {
    const read = episodeCanvasRead(canvas, "full");
    assert.equal(read.canvas, canvas);
    assert.equal((read.canvas as any).nodes.length, 2);
    assert.equal(read.nextAction, undefined);
});

test("an unbound episode reports no canvas in either view", () => {
    assert.deepEqual(episodeCanvasRead(null, "ref"), { canvas: null });
    assert.deepEqual(episodeCanvasRead(null, "full"), { canvas: null });
});
