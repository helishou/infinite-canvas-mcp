import assert from "node:assert/strict";
import test from "node:test";
import { shouldStartCanvasNodeDrag } from "./canvas-node-drag";

function targetWith(...selectors: string[]) {
    const matches = new Set(selectors);
    return {
        closest: (selector: string) => {
            if (matches.has(selector) || selector.split(", ").some((part) => matches.has(part))) return {} as Element;
            return null;
        },
    } as Element;
}

test("H3 drags from overview-style handles and non-control toolbar areas", () => {
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-drag-handle]"), true), true);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-drag-handle]", "[data-canvas-node-drag-interactive-handle]", "button"), true), true);
});

test("H3 controls and node affordances keep their own mouse interaction", () => {
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-drag-handle]", "button"), true), false);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("video"), true), false);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-resize-handle]", "[data-canvas-node-drag-handle]"), true), false);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-connection-handle]", "[data-canvas-node-drag-handle]"), true), false);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-panel]", "[data-canvas-node-drag-handle]"), true), false);
});

test("clicking any node panel never starts a node drag", () => {
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-panel]"), true), false);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("[data-canvas-node-panel]"), false), false);
});

test("ordinary nodes retain body dragging while controls stay protected", () => {
    assert.equal(shouldStartCanvasNodeDrag(targetWith(), false), true);
    assert.equal(shouldStartCanvasNodeDrag(targetWith("textarea"), false), false);
});
