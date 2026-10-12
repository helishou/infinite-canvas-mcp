import assert from "node:assert/strict";
import test from "node:test";
import { canvasTextTargetExists } from "./canvas-text-suggestions-dialog";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const project = {
    id: "canvas", title: "Canvas", nodes: [
        { id: "text", type: "text", metadata: { content: "Text" } },
        { id: "h3", type: "minimax-h3", metadata: { segments: [{ id: "clip" }] } },
        { id: "composer", type: "text", metadata: { texts: [{ id: "item" }] } },
    ],
} as CanvasProject;

test("rewrite suggestions only enable adoption for existing node, Clip and text-item targets", () => {
    assert.equal(canvasTextTargetExists(project, { nodeId: "text", field: "content" }), true);
    assert.equal(canvasTextTargetExists(project, { nodeId: "h3", segmentId: "clip", field: "prompt" }), true);
    assert.equal(canvasTextTargetExists(project, { nodeId: "composer", textItemId: "item", field: "composerContent" }), true);
    assert.equal(canvasTextTargetExists(project, { nodeId: "deleted", field: "content" }), false);
    assert.equal(canvasTextTargetExists(project, { nodeId: "h3", segmentId: "deleted", field: "prompt" }), false);
    assert.equal(canvasTextTargetExists(project, { nodeId: "composer", textItemId: "deleted", field: "composerContent" }), false);
});

test("missing project and removed global text targets remain non-adoptable", () => {
    assert.equal(canvasTextTargetExists(undefined, { nodeId: "text", field: "content" }), false);
    assert.equal(canvasTextTargetExists(project, { field: "globalPrompt" }), false);
    assert.equal(canvasTextTargetExists(project, { nodeId: "text", field: "globalPrompt" }), false);
    assert.equal(canvasTextTargetExists(project, { field: "content" }), false);
});
