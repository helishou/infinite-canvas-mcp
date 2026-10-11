import assert from "node:assert/strict";
import test from "node:test";
import { collectCanvasSelectionIds } from "./canvas-selection";

test("canvas marquee selection starts with candidates when it is not additive", () => {
    assert.deepEqual(
        collectCanvasSelectionIds(["a", "b"], ["existing"], false),
        new Set(["a", "b"]),
    );
});

test("additive canvas marquee selection preserves the initial selection and adds candidates", () => {
    assert.deepEqual(
        collectCanvasSelectionIds(["b", "c"], ["a", "b"], true),
        new Set(["a", "b", "c"]),
    );
});

test("excluded marquee candidates are omitted without removing initially selected ids", () => {
    assert.deepEqual(
        collectCanvasSelectionIds(["group", "member"], ["group", "other"], true, ["group"]),
        new Set(["group", "other", "member"]),
    );
});
