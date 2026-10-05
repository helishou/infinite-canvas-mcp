import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType } from "@/types/canvas";
import { resolveCanvasNodePromptField } from "./canvas-node-prompt-field";

test("image node keeps the same prompt document when its first image is generated", () => {
    assert.equal(resolveCanvasNodePromptField(CanvasNodeType.Image, false), "prompt");
    assert.equal(resolveCanvasNodePromptField(CanvasNodeType.Image, true), "prompt");
});

test("smart config nodes keep using composerContent", () => {
    assert.equal(resolveCanvasNodePromptField(CanvasNodeType.Config, false), "composerContent");
    assert.equal(resolveCanvasNodePromptField(CanvasNodeType.Config, true), "composerContent");
});

test("existing non-image content keeps its composerContent editing draft", () => {
    assert.equal(resolveCanvasNodePromptField(CanvasNodeType.Text, true), "composerContent");
});
