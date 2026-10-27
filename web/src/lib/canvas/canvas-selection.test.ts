import assert from "node:assert/strict";
import test from "node:test";
import { canvasSelectionOverlayBounds, canvasSelectionWorldBounds, collectCanvasSelectionIds } from "./canvas-selection";

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

test("selection world bounds normalize a drag that moves up and left", () => {
    assert.deepEqual(canvasSelectionWorldBounds(15, 30, -5, 4), {
        left: -5,
        top: 4,
        right: 15,
        bottom: 30,
    });
});

test("selection overlay bounds use local pixels and non-negative dimensions", () => {
    assert.deepEqual(canvasSelectionOverlayBounds(120, 90, 35, 140), {
        left: 35,
        top: 90,
        width: 85,
        height: 50,
    });
});
