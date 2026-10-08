import assert from "node:assert/strict";
import test from "node:test";
import { formalClipOrderOperations } from "./clip-order.js";

test("formal ordering repairs appended death/explanation Clips and is idempotent", () => {
    const expected = ["transform", "death", "explain", "ending"];
    assert.equal(formalClipOrderOperations("node", ["transform", "explain", "ending", "death"], expected).length, 1);
    assert.deepEqual(formalClipOrderOperations("node", expected, expected), []);
});
test("foreign Clip slots are retained when formal slots change order", () => {
    const ops = formalClipOrderOperations("node", ["foreign1", "b", "foreign2", "a"], ["a", "b"]);
    assert.equal(ops.length, 2);
    assert.ok(ops.every(op => op.type === "move_h3_segment" && ["a", "b"].includes(op.segmentId)));
});
