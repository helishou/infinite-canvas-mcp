import assert from "node:assert/strict";
import test from "node:test";
import { hasCanvasPatchChanges } from "./canvas-patch-equality";

test("immutable arrays retain JSON no-op semantics, order, missing fields and explicit null", () => {
    const node = { id: "n", metadata: { text: "原文", absent: undefined } };
    const before = { nodes: [node], title: "title", optional: undefined };
    assert.equal(hasCanvasPatchChanges(before, { nodes: [...before.nodes] }), false);
    assert.equal(hasCanvasPatchChanges(before, { nodes: [{ id: "n", metadata: { text: "原文" } }] }), false);
    assert.equal(hasCanvasPatchChanges(before, { nodes: [{ ...node, metadata: { text: "新文" } }] }), true);
    assert.equal(hasCanvasPatchChanges(before, { nodes: [] }), true);
    assert.equal(hasCanvasPatchChanges(before, { optional: null }), true);
    assert.equal(hasCanvasPatchChanges({ nodes: [node, { id: "b" }] }, { nodes: [{ id: "b" }, node] }), true);
});

test("optimized comparison agrees with previous JSON comparison for canvas-like patches", () => {
    const cases: unknown[] = [undefined, null, false, 0, -0, NaN, "", "文本", [], [undefined], [null], [NaN], [0], ["text"], [{ id: "n", metadata: { a: 1 } }], [{ id: "n", metadata: { a: 2 } }], { a: 1 }, { a: undefined }, {}];
    for (const before of cases) for (const next of cases) assert.equal(hasCanvasPatchChanges({ value: before }, { value: next }), JSON.stringify(before) !== JSON.stringify(next));
});
