import assert from "node:assert/strict";
import test from "node:test";
import { shouldStartCanvasPan } from "./canvas-gesture.js";

test("hand tool pans from node surfaces as well as blank canvas", () => {
    assert.equal(shouldStartCanvasPan(0, "pan", false), true);
});

test("select tool keeps primary background drags for selection while middle mouse still pans", () => {
    assert.equal(shouldStartCanvasPan(0, "select", false), false);
    assert.equal(shouldStartCanvasPan(1, "select", false), true);
});

test("interactive controls are not captured by the hand tool", () => {
    assert.equal(shouldStartCanvasPan(0, "pan", true), false);
    assert.equal(shouldStartCanvasPan(1, "pan", true), true);
});
